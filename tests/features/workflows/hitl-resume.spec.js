// Feature — the `user` plugin pauses execution; the
// /executions/:id/nodes/:node/respond endpoint resumes it. Locks
// the durable-execution contract end-to-end.

import { test, expect } from "@playwright/test";
import {
  login, createWorkflow, deleteWorkflow,
  executeWorkflow, getExecution, waitForExecution,
  respondToWaitingNode, uniq,
} from "../../helpers/api.js";

test("HITL — workflow pauses on `user`, resumes on POST /respond", async ({}, testInfo) => {
  testInfo.setTimeout(60_000);

  const { token } = await login();
  const wf = await createWorkflow({
    token, name: uniq("hitl"),
    dsl: {
      name: "hitl", version: "1.0", data: {},
      nodes: [
        // Pause until a human (or service) responds.
        { name: "approve", action: "user",
          inputs: { prompt: "approve?" },
          outputs: { data: "approval" } },
        // After resume, this echoes the approval into ctx so we
        // can check the response was wired through.
        { name: "after", action: "transform",
          inputs:  { expression: "approval" },
          outputs: { value: "echoed" } },
      ],
      edges: [{ from: "approve", to: "after" }],
    },
  });

  try {
    const { id: executionId } = await executeWorkflow({ token, id: wf.id });

    // Wait for the execution to land on 'waiting'. We don't use
    // waitForExecution here — it short-circuits on `waiting` as a
    // non-terminal state and the helper returns immediately.
    let row;
    for (let i = 0; i < 60; i++) {
      row = await getExecution({ token, id: executionId });
      if (row?.status === "waiting") break;
      await new Promise(r => setTimeout(r, 250));
    }
    expect(row.status).toBe("waiting");

    // Respond — value comes back as ctx.approval on the downstream node.
    await respondToWaitingNode({
      token, executionId, nodeName: "approve",
      data: { approved: true, by: "wave3-test" },
    });

    // Resume to completion.
    const final = await waitForExecution({ token, id: executionId, timeoutMs: 30_000 });
    expect(final.status).toBe("success");
    // The transform echoed `approval` into `echoed`; the dump
    // should contain "wave3-test" somewhere.
    expect(JSON.stringify(final)).toMatch(/wave3-test/);
  } finally {
    await deleteWorkflow({ token, id: wf.id }).catch(() => {});
  }
});
