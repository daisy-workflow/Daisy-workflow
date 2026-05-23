// Feature — the executor's per-node retry budget is honoured.
//
// Two flavours:
//   1. retry: N on a deterministically-failing node → execution
//      ends 'failed' with node_states.attempts == N+1 (one initial
//      attempt + N retries). Proves the retry loop ran the right
//      number of times.
//   2. onError: 'continue' on a deterministically-failing node →
//      execution ends 'success' (or 'partial' if engine surfaces the
//      mixed outcome separately). Proves continue is wired up.
//
// We don't have a "fail-N-times-then-succeed" plugin, so we exercise
// "exhausts the budget" rather than "recovers on attempt K". The
// retry COUNT is the assertion either way.

import { test, expect } from "@playwright/test";
import {
  login, createWorkflow, deleteWorkflow,
  executeWorkflow, waitForExecution, getExecution, uniq,
} from "../../helpers/api.js";

test("workflow retries — retry: 2 exhausts to 3 attempts, then fails", async ({}, testInfo) => {
  testInfo.setTimeout(45_000);
  const { token } = await login();

  const wf = await createWorkflow({
    token, name: uniq("retry-exhaust"),
    dsl: {
      name: "retry-exhaust", version: "1.0", data: {},
      nodes: [
        {
          name:       "always-fails",
          action:     "transform",
          inputs:     { expression: "this is not valid feel %%%" },
          outputs:    { value: "x" },
          retry:      2,            // 1 initial + 2 retries = 3 attempts
          retryDelay: "10ms",       // keep the test cheap
          onError:    "terminate",  // default; named for clarity
        },
      ],
      edges: [],
    },
  });

  try {
    const { id: executionId } = await executeWorkflow({ token, id: wf.id });
    const row = await waitForExecution({ token, id: executionId, timeoutMs: 30_000 });

    // Execution ends failed because retry budget exhausted.
    expect(row.status).toBe("failed");

    // node_states surfaces on the execution row as `node_states` (see
    // backend/src/api/executions.js — it folds in the per-node store).
    // Find our node and assert the attempt count.
    const states = Array.isArray(row.node_states) ? row.node_states : [];
    const failed = states.find(s => s.node_name === "always-fails");
    expect(failed, "node_states should contain the always-fails row").toBeTruthy();
    expect(failed.status).toBe("failed");
    // 1 initial attempt + 2 retries = 3 total attempts. The executor
    // increments `attempts` on each attempt, including the first.
    expect(failed.attempts).toBe(3);
  } finally {
    await deleteWorkflow({ token, id: wf.id }).catch(() => {});
  }
});

test("workflow errors — onError: 'continue' lets the run finish", async ({}, testInfo) => {
  testInfo.setTimeout(45_000);
  const { token } = await login();

  // Two nodes: the first always fails but continues; the second is a
  // plain log that should still run. Result: execution does NOT end
  // 'failed' (it's 'success' or 'partial' depending on the engine's
  // mixed-outcome convention).
  const wf = await createWorkflow({
    token, name: uniq("retry-continue"),
    dsl: {
      name: "retry-continue", version: "1.0", data: {},
      nodes: [
        {
          name:    "bad",
          action:  "transform",
          inputs:  { expression: "this is not valid feel %%%" },
          outputs: { value: "x" },
          onError: "continue",
        },
        {
          name:    "good",
          action:  "log",
          inputs:  { message: "after the bad one" },
        },
      ],
      edges: [{ from: "bad", to: "good" }],
    },
  });

  try {
    const { id: executionId } = await executeWorkflow({ token, id: wf.id });
    const row = await waitForExecution({ token, id: executionId, timeoutMs: 30_000 });

    // 'continue' explicitly does not terminate — accept either of the
    // engine's success-flavour statuses.
    expect(["success", "partial"]).toContain(row.status);

    const states = Array.isArray(row.node_states) ? row.node_states : [];
    const bad  = states.find(s => s.node_name === "bad");
    const good = states.find(s => s.node_name === "good");
    expect(bad?.status).toBe("failed");
    // Downstream node should have run — continue propagates execution
    // even though the parent failed.
    expect(good?.status).toBe("success");
  } finally {
    await deleteWorkflow({ token, id: wf.id }).catch(() => {});
  }
});
