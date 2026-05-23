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

    // Wait for the execution to land on 'waiting'. The worker
    // starts in 'queued', moves to 'running' once it pulls the
    // job, then the `user` plugin returns the WAITING sentinel
    // which the executor translates to 'waiting' on the row.
    // Cold worker can take ~5-10s to reach 'running' so we poll
    // up to 30s (vs. the previous 15s).
    let row;
    for (let i = 0; i < 120; i++) {
      row = await getExecution({ token, id: executionId });
      if (row?.status === "waiting") break;
      // Early-exit if the worker landed at a terminal non-success
      // state — we'd otherwise burn 30s for nothing, and the error
      // field on the row tells us what blew up in the worker.
      if (row?.status === "failed" || row?.status === "partial") break;
      await new Promise(r => setTimeout(r, 250));
    }
    if (row?.status !== "waiting") {
      // Surface the worker's error message in the assertion so the
      // next debug cycle has something concrete to chase. Otherwise
      // Playwright reports just "Expected: waiting / Received: ...".
      //console.log("row",row);
      throw new Error(
        `HITL: expected status='waiting' but got '${row?.status}'.` +
        (row?.error ? ` Worker error: ${row.error}` : "") +
        ` Full row: ${JSON.stringify(row).slice(0, 600)}`,
      );
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
