// Feature — /audit endpoint filter combinations.
//
// audit-record.spec.js proves a workflow-emitted row LANDS on /audit.
// This file proves the filter machinery on top of it works: querying
// by action, resourceType, outcome, or any combination returns the
// rows that match and excludes the rest.
//
// Setup: seed three audit rows from a single workflow run via the
// audit.record plugin, each tagged with a distinct
// (action, resourceType, outcome) combo. Then sweep the filters and
// assert which rows come back.
//
// Each filter assertion uses the test-unique action prefix to scope
// the query so we don't accidentally hit unrelated rows the worker
// emitted during this run (e.g. audit.login at boot).

import { test, expect } from "@playwright/test";
import {
  login, createWorkflow, deleteWorkflow,
  executeWorkflow, waitForExecution,
  listAudit, uniq,
} from "../../helpers/api.js";

test("audit filters — action / resourceType / outcome each scope correctly", async ({}, testInfo) => {
  testInfo.setTimeout(60_000);
  const { token } = await login();

  const tag = uniq("filt");
  const A = `smoke.${tag}.alpha`;
  const B = `smoke.${tag}.beta`;
  const C = `smoke.${tag}.gamma`;

  // Three audit.record nodes in one workflow → three rows in one go.
  // Distinct (action, resourceType, outcome) per node so we can probe
  // each filter dimension independently.
  const wf = await createWorkflow({
    token, name: uniq("audit-filters-wf"),
    dsl: {
      name: "audit-filters-wf", version: "1.0", data: {},
      nodes: [
        { name: "n1", action: "audit.record",
          inputs: {
            action:   A,
            resource: { type: "alpha-thing", id: "x1", name: "alpha" },
            outcome:  "success",
          } },
        { name: "n2", action: "audit.record",
          inputs: {
            action:   B,
            resource: { type: "beta-thing", id: "x2", name: "beta" },
            outcome:  "failed",
          } },
        { name: "n3", action: "audit.record",
          inputs: {
            action:   C,
            resource: { type: "alpha-thing", id: "x3", name: "gamma" },
            outcome:  "success",
          } },
      ],
      edges: [],
    },
  });

  try {
    const { id: executionId } = await executeWorkflow({ token, id: wf.id });
    const row = await waitForExecution({ token, id: executionId, timeoutMs: 30_000 });
    expect(row.status).toBe("success");

    // Polling helper — the listAudit fetch may briefly see fewer rows
    // than expected if the worker's audit INSERTs haven't been visible
    // to the API connection yet. Wait for the expected COUNT.
    async function poll(args, expectedCount) {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const resp = await listAudit({ token, ...args, limit: 50 });
        const rows = Array.isArray(resp) ? resp : (resp?.rows || []);
        if (rows.length === expectedCount) return rows;
        await new Promise(r => setTimeout(r, 200));
      }
      // Fall through — return whatever we got so the assert message
      // shows the actual count.
      const finalResp = await listAudit({ token, ...args, limit: 50 });
      return Array.isArray(finalResp) ? finalResp : (finalResp?.rows || []);
    }

    // ── action filter — exact match, 1 row each ────────────────────
    const byA = await poll({ action: A }, 1);
    expect(byA.length).toBe(1);
    expect(byA[0].action).toBe(A);

    const byB = await poll({ action: B }, 1);
    expect(byB.length).toBe(1);
    expect(byB[0].action).toBe(B);

    // ── resourceType filter — alpha-thing matches n1 + n3 ─────────
    // Scope to our test's actions so unrelated workspace rows don't pollute.
    // The endpoint AND-combines filters, so action + resourceType
    // would over-constrain. Instead, fetch by resourceType and filter
    // client-side to our tag prefix.
    const alphaResp = await listAudit({ token, resourceType: "alpha-thing", limit: 100 });
    const alphaRows = (alphaResp?.rows || alphaResp || []).filter(r => r.action?.startsWith(`smoke.${tag}.`));
    expect(alphaRows.length).toBe(2);
    expect(alphaRows.map(r => r.action).sort()).toEqual([A, C].sort());

    // ── outcome filter — failed matches only n2 (within our tag) ──
    const failedResp = await listAudit({ token, outcome: "failed", limit: 100 });
    const failedRows = (failedResp?.rows || failedResp || []).filter(r => r.action?.startsWith(`smoke.${tag}.`));
    expect(failedRows.length).toBe(1);
    expect(failedRows[0].action).toBe(B);

    // ── compound: action + outcome — succeeds only when both match ─
    // Asking for action=A&outcome=failed should return zero (A was success).
    const noneResp = await listAudit({ token, action: A, outcome: "failed", limit: 50 });
    const noneRows = noneResp?.rows || noneResp || [];
    expect(noneRows.length).toBe(0);

    // And action=A&outcome=success should return the one row.
    const oneResp = await listAudit({ token, action: A, outcome: "success", limit: 50 });
    const oneRows = oneResp?.rows || oneResp || [];
    expect(oneRows.length).toBe(1);
    expect(oneRows[0].action).toBe(A);
  } finally {
    await deleteWorkflow({ token, id: wf.id }).catch(() => {});
  }
});
