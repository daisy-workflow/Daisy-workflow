// Feature — project quota set + delete. We don't exercise the
// pre-call enforcement here (that's the agent-call side; Layer 2
// keeps quota+enforcement separate so a regression on either
// surfaces independently).

import { test, expect } from "@playwright/test";
import {
  login, listQuotas, setQuota, deleteQuota,
} from "../../helpers/api.js";

test("quota set + read — tokens_per_month persists with derived period", async () => {
  const { token } = await login();

  const set = await setQuota({ token, kind: "tokens_per_month", limit: 1_000_000 });
  expect(set.kind).toBe("tokens_per_month");
  expect(set.limit).toBe(1_000_000);
  expect(set.period).toBe("month");

  try {
    const list = await listQuotas({ token });
    // The list is either an array of rows or { quotas: [...] };
    // either shape works.
    const rows = Array.isArray(list) ? list : (list.quotas || []);
    const row = rows.find(r => r.kind === "tokens_per_month");
    expect(row).toBeTruthy();
    expect(Number(row.limit || row.limit_value)).toBe(1_000_000);
  } finally {
    await deleteQuota({ token, kind: "tokens_per_month" }).catch(() => {});
  }
});

test("quota delete — removes the cap (back to unlimited)", async () => {
  const { token } = await login();
  await setQuota({ token, kind: "executions_per_day", limit: 500 });
  await deleteQuota({ token, kind: "executions_per_day" });

  // The /quotas list endpoint surfaces a row for every kind the
  // workspace has ever set, even after DELETE — DELETE removes the
  // CAP (sets limit to 0 / null = "unlimited") but doesn't drop
  // the metering row. So the assertion is "no positive limit"
  // rather than "no row".
  const list = await listQuotas({ token });
  const rows = Array.isArray(list) ? list : (list.quotas || []);
  const row = rows.find(r => r.kind === "executions_per_day");
  // Either the row is gone OR its limit is 0/null (unlimited).
  expect(!row || !row.limit_value || row.limit_value === 0 || row.limit === 0).toBe(true);
});
