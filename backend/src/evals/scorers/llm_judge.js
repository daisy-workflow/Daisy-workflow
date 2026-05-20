// LLM-as-judge scorer.
//
// Calls a configured "judge" agent to grade the output against a
// rubric. The judge is just another agent row — typically a small,
// cheap model with a strict JSON-only system prompt.
//
// Config shape:
//   {
//     agent:     "<judge agent title>",       // required
//     rubric:    "<criteria the judge applies>",
//     threshold: 0.7                          // pass-threshold (0..1)
//   }
//
// The judge is invoked with a system prompt scaffold telling it to
// return ONLY a JSON object of shape { score: 0..1, reasoning: "..." }.
// We parse the response; failure to parse counts as score=0 with
// the parse error in details.

import { loadAgent, callProvider } from "../../plugins/agent/util.js";

export const META = {
  name: "llm_judge",
  label: "LLM-as-judge",
  description:
    "Send the agent's output + the expected answer to a judge agent. " +
    "The judge returns a 0-1 score and reasoning; pass when score >= threshold.",
  fields: {
    agent:     { label: "Judge agent (title)", kind: "string", required: true },
    rubric:    { label: "Rubric / criteria",   kind: "textarea", required: true },
    threshold: { label: "Pass threshold (0-1)", kind: "number", min: 0, max: 1, step: 0.05, default: 0.7 },
    maxTokens: { label: "Judge max output tokens", kind: "number", min: 64, max: 4000, default: 512 },
  },
};

const JUDGE_SYSTEM_FALLBACK = [
  "You are an evaluation judge. You will receive the candidate output of",
  "another LLM, the reference / expected answer (if any), and a rubric.",
  "Score how well the candidate satisfies the rubric on a 0..1 scale where:",
  "  0.0 = wrong / unsafe / off-topic",
  "  0.5 = partially correct",
  "  1.0 = fully correct and complete",
  "Respond with ONLY a JSON object: {\"score\": <0..1>, \"reasoning\": \"<one short sentence>\"}",
  "No prose outside the JSON object.",
].join("\n");

export async function score({ output, expected, config = {}, ctx = {} }) {
  const judgeTitle = config.agent;
  const rubric     = config.rubric || expected?.rubric;
  const threshold  = clamp01(config.threshold ?? 0.7);

  if (!judgeTitle) {
    return { passed: false, score: 0, details: { error: "config.agent (judge agent title) is required" } };
  }
  if (!rubric) {
    return { passed: false, score: 0, details: { error: "rubric is required" } };
  }

  // Load the judge agent. ctx must carry an MQTT-style `config` map of
  // all stored configs so loadAgent can resolve the judge's api key.
  // The eval runner pre-loads project configs into ctx before invoking.
  let judge;
  try {
    judge = await loadAgent(ctx, judgeTitle);
  } catch (e) {
    return { passed: false, score: 0, details: { error: `judge agent unavailable: ${e.message}` } };
  }

  // Build the judge's user message. We hand it the candidate + the
  // reference + the rubric in fenced blocks so the model treats them
  // as data, not instructions — light defense-in-depth against
  // prompt injection from the candidate.
  const userText = [
    "## Candidate output",
    "```", String(output ?? ""), "```",
    "",
    "## Reference answer (may be empty)",
    "```", String(expected?.reference ?? ""), "```",
    "",
    "## Rubric",
    rubric,
  ].join("\n");

  let out;
  try {
    out = await callProvider({
      cfg:       judge.cfg,
      // The judge agent's own prompt wins when present; otherwise we
      // fall back to a strict JSON-only scaffold.
      system:    judge.agent.prompt?.trim()
                   ? judge.agent.prompt
                   : JUDGE_SYSTEM_FALLBACK,
      messages:  [{ role: "user", content: userText }],
      maxTokens: config.maxTokens || 512,
    });
  } catch (e) {
    return { passed: false, score: 0, details: { error: `judge call failed: ${e.message}` } };
  }

  // Parse the judge's reply. Accept either a raw JSON object or a
  // ```json fenced``` block — some chat models love their fences.
  const parsed = tryParseScore(out.text);
  if (!parsed) {
    return {
      passed: false,
      score:  0,
      details: { error: "judge response did not parse as JSON", raw: out.text?.slice(0, 500) },
    };
  }
  const s      = clamp01(parsed.score);
  const passed = s >= threshold;
  return {
    passed,
    score:   s,
    details: {
      threshold,
      reasoning: parsed.reasoning || "",
      // Surface judge tokens so runners can roll them up under the
      // eval run's totals.
      judgeUsage: out.usage || null,
    },
  };
}

function clamp01(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

function tryParseScore(text) {
  if (!text) return null;
  // Strip ```json fences.
  const stripped = text.replace(/```(?:json)?\s*/gi, "").replace(/```\s*$/g, "").trim();
  // Try the whole string, then walk forward looking for the first
  // {...} substring that parses — handles chatty preambles.
  try { return JSON.parse(stripped); } catch { /* keep going */ }
  const m = stripped.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* still bad */ } }
  return null;
}
