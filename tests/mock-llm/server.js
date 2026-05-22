// Standalone mock LLM HTTP server for the Playwright test stack.
//
// Why it's not just embedded in the Playwright process anymore:
//   The earlier in-process variant relied on the worker container
//   reaching `host.docker.internal:9123`. That works on Docker Desktop
//   most of the time, but the routing has been unreliable in practice
//   (macOS firewall variants, IPv6 quirks, the Docker Desktop VM's
//   gateway changing across restarts). Pinning the mock to its own
//   Docker container removes every host-network variable: the worker
//   reaches it via `mock-llm:9123` over the compose-managed bridge,
//   which is the same Docker DNS path that `postgres-test` and
//   `redis-test` already ride on and never fails.
//
// Same response shapes as before — OpenAI Chat Completions for
// `/v1/chat/completions`, Anthropic Messages for `/v1/messages`.

import { createServer } from "node:http";

const PORT = parseInt(process.env.MOCK_LLM_PORT || "9123", 10);

// The exact text every "assistant" message returns. Matches Wave 1
// test assertions that grep for `/mocked/`.
const MOCKED_ASSISTANT_TEXT = '{"result":"mocked","confidence":0.9}';

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const url = req.url || "";
    let parsedBody = {};
    try { parsedBody = JSON.parse(body || "{}"); } catch { /* leave {} */ }
    // OpenAI signals streaming with `stream: true`; Anthropic with `stream: true`
    // OR with the SSE Accept header. Either way we emit SSE-framed chunks.
    const streaming = parsedBody.stream === true
                   || (req.headers.accept || "").includes("text/event-stream");
    console.error(`[mock-llm] ${req.method} ${url} (from ${req.socket?.remoteAddress}, streaming=${streaming})`);

    if (url.includes("/chat/completions")) {
      return streaming
        ? respondOpenAiSse(res)
        : respondJson(res, openaiPayload());
    }
    if (url.includes("/messages")) {
      return streaming
        ? respondAnthropicSse(res)
        : respondJson(res, anthropicPayload());
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: `mock-llm: unknown path ${url}` } }));
  });
});

function respondJson(res, payload) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

function openaiPayload() {
  return {
    id:      "chatcmpl-mock",
    model:   "gpt-4o-mini",
    choices: [{
      index: 0,
      message: { role: "assistant", content: MOCKED_ASSISTANT_TEXT },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  };
}

function anthropicPayload() {
  return {
    id:           "msg_mock",
    model:        "claude-mock",
    content:      [{ type: "text", text: MOCKED_ASSISTANT_TEXT }],
    stop_reason:  "end_turn",
    usage:        { input_tokens: 12, output_tokens: 8 },
  };
}

/** Emit OpenAI Chat Completions SSE — a few delta chunks then [DONE]. */
function respondOpenAiSse(res) {
  res.writeHead(200, {
    "content-type":  "text/event-stream",
    "cache-control": "no-cache",
    "connection":    "keep-alive",
  });
  // Split the mocked text into 3 chunks so the streaming hook code
  // path is genuinely exercised (one-chunk SSE wouldn't catch
  // accumulation bugs).
  const chunks = chunk3(MOCKED_ASSISTANT_TEXT);
  for (const piece of chunks) {
    const evt = {
      id:      "chatcmpl-mock",
      model:   "gpt-4o-mini",
      choices: [{ index: 0, delta: { content: piece }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }
  // Final chunk under stream_options.include_usage carries usage totals.
  res.write(`data: ${JSON.stringify({
    id: "chatcmpl-mock", model: "gpt-4o-mini",
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage:   { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
  })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

/** Emit Anthropic Messages SSE — content_block_delta + message_delta + message_stop. */
function respondAnthropicSse(res) {
  res.writeHead(200, {
    "content-type":  "text/event-stream",
    "cache-control": "no-cache",
    "connection":    "keep-alive",
  });
  res.write(`event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: { id: "msg_mock", model: "claude-mock", role: "assistant",
               content: [], stop_reason: null,
               usage: { input_tokens: 12, output_tokens: 0 } },
  })}\n\n`);
  res.write(`event: content_block_start\ndata: ${JSON.stringify({
    type: "content_block_start", index: 0,
    content_block: { type: "text", text: "" },
  })}\n\n`);
  for (const piece of chunk3(MOCKED_ASSISTANT_TEXT)) {
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({
      type: "content_block_delta", index: 0,
      delta: { type: "text_delta", text: piece },
    })}\n\n`);
  }
  res.write(`event: content_block_stop\ndata: ${JSON.stringify({
    type: "content_block_stop", index: 0,
  })}\n\n`);
  res.write(`event: message_delta\ndata: ${JSON.stringify({
    type: "message_delta",
    delta: { stop_reason: "end_turn" },
    usage: { output_tokens: 8 },
  })}\n\n`);
  res.write(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`);
  res.end();
}

function chunk3(s) {
  const n = Math.max(1, Math.ceil(s.length / 3));
  return [s.slice(0, n), s.slice(n, 2 * n), s.slice(2 * n)].filter(Boolean);
}

server.listen(PORT, "0.0.0.0", () => {
  console.error(`[mock-llm] listening on 0.0.0.0:${PORT}`);
});

// Graceful shutdown so `docker compose down` doesn't have to SIGKILL.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.error(`[mock-llm] received ${sig}, closing`);
    server.close(() => process.exit(0));
  });
}
