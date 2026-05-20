// Scorer registry.
//
// Each scorer module exports:
//
//   META — { name, label, description, fields {} } drives the case
//          editor UI.
//
//   score({ output, expected, config, ctx })
//     → Promise<{ passed: boolean, score: number 0..1, details: object }>
//
//          `expected` is the case's free-form expected blob (varies
//          per scorer); `config` is the per-case scorer config; `ctx`
//          gives the scorer access to ctx.config etc. (used by
//          llm_judge to call another agent).

import * as exact     from "./exact.js";
import * as contains  from "./contains.js";
import * as regex     from "./regex.js";
import * as json      from "./json.js";
import * as llm_judge from "./llm_judge.js";

export const SCORERS = {
  exact,
  contains,
  regex,
  json,
  llm_judge,
};

export function getScorer(name) {
  const s = SCORERS[name];
  if (!s) {
    throw new Error(
      `unknown scorer: "${name}". Available: ${Object.keys(SCORERS).join(", ")}.`,
    );
  }
  return s;
}

export function listScorers() {
  return Object.values(SCORERS).map(s => s.META);
}
