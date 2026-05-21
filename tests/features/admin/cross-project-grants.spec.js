// Feature — grant + revoke workflow.fire across two projects.

import { test, expect } from "@playwright/test";
import {
  login, createProject, deleteProject,
  grantCrossProject, revokeCrossProject, listCrossProjectGrants,
  uniq,
} from "../../helpers/api.js";

test("cross-project grant — POST + DELETE round-trip", async () => {
  const { token } = await login();
  const caller = await createProject({ token, name: uniq("caller") });
  const callee = await createProject({ token, name: uniq("callee") });

  try {
    const grant = await grantCrossProject({
      token,
      callerProjectId: caller.id,
      calleeProjectId: callee.id,
    });
    expect(grant.callerProjectId).toBe(caller.id);
    expect(grant.calleeProjectId).toBe(callee.id);

    const before = await listCrossProjectGrants({ token });
    expect(before.some(g =>
      g.caller_project_id === caller.id && g.callee_project_id === callee.id,
    )).toBe(true);

    await revokeCrossProject({
      token, callerProjectId: caller.id, calleeProjectId: callee.id,
    });
    const after = await listCrossProjectGrants({ token });
    expect(after.some(g =>
      g.caller_project_id === caller.id && g.callee_project_id === callee.id,
    )).toBe(false);
  } finally {
    await deleteProject({ token, id: caller.id }).catch(() => {});
    await deleteProject({ token, id: callee.id }).catch(() => {});
  }
});
