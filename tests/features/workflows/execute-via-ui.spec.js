// Feature — clicking Run in the FlowDesigner kicks off a real
// execution. We don't poll the UI's Live panel (Layer 3 concern);
// instead we poll the API for the execution row + assert it
// reached `success`. The UI's role here is just to send the POST.

import { test, expect } from "@playwright/test";
import {
  login, createWorkflow, deleteWorkflow,
  ONE_TRANSFORM_DSL, uniq, TEST_ADMIN,
} from "../../helpers/api.js";
import { LoginPage }    from "../../pages/LoginPage.js";
import { FlowDesigner } from "../../pages/FlowDesigner.js";

test("UI Run button — clicking Run fires an execution that succeeds", async ({ page }, testInfo) => {
  testInfo.setTimeout(60_000);
  const { token } = await login();

  // Seed: one workflow with one transform node.
  const wf = await createWorkflow({
    token,
    name: uniq("ui-run"),
    dsl:  ONE_TRANSFORM_DSL,
  });

  try {
    // Open the designer first, THEN start watching for the execute
    // POST + click Run. Setting up the waitForResponse before the
    // page is open caused us to time out on the initial
    // navigation's auth/refresh POST instead.
    await new LoginPage(page).loginAs(TEST_ADMIN.email, TEST_ADMIN.password);
    const designer = new FlowDesigner(page);
    await designer.open(wf.id);

    // Wait until the Run button is rendered (FlowDesigner mounted +
    // the workflow loaded from the API).
    await designer.runButton().waitFor({ state: "visible" });

    // The toolbar Run button OPENS a RunDialog (a modal for input +
    // tags). It does NOT immediately POST. The actual POST is
    // fired by the dialog's "Run" submit button. So:
    //   1. Click toolbar Run  → dialog opens
    //   2. Find the dialog's  Run button via the `.run-button` class
    //      that RunDialog.vue puts on its submit q-btn. The class is
    //      unique to that component, so it never collides with the
    //      toolbar Run. (data-testid was an option but Quasar's q-btn
    //      doesn't reliably forward arbitrary attrs to the underlying
    //      <button>, and we already had a unique class.)
    //   3. REGISTER waitForResponse BEFORE the click. Playwright's
    //      waitForResponse only catches responses arriving after the
    //      promise is created; if we set it up after the click, the
    //      POST has already gone out and we time out.
    //   4. Click the dialog Run → POST fires → promise resolves.
    await designer.run();                                  // opens RunDialog (or the Unsaved-changes guard first)

    // When a workflow is created via the API and then opened in the
    // visual editor, the editor's serializer round-trips through the
    // visual layer (positions, whitespace), which produces a DSL
    // string that doesn't match what was saved server-side. That
    // flips the `dirty` flag in FlowDesigner.vue, so clicking Run
    // opens an "Unsaved changes" confirm dialog FIRST (Save & run /
    // Cancel). Click "Save & run" to save + proceed to the RunDialog.
    // If the guard didn't appear (flow was already clean), this is a
    // no-op (the locator's short waitFor times out, we swallow + move
    // on to the real RunDialog).
    const saveAndRun = page.getByRole("button", { name: /Save & run/i });
    try {
      await saveAndRun.waitFor({ state: "visible", timeout: 2_000 });
      await saveAndRun.click();
    } catch { /* no unsaved guard — RunDialog opened directly */ }

    const dialogRun = page.locator(".run-button");
    await dialogRun.waitFor({ state: "visible", timeout: 10_000 });

    // Register the response listener BEFORE the click that triggers it.
    const execPromise = page.waitForResponse(
      r => r.url().includes(`/graphs/${wf.id}/execute`) && r.request().method() === "POST",
      { timeout: 10_000 },
    );
    await dialogRun.click();                               // fires POST

    // Response status is 202 (Accepted, queued) per the API; some
    // older revisions returned 200. Accept either as success.
    const execResponse = await execPromise;
    expect([200, 202]).toContain(execResponse.status());
    const body = await execResponse.json();
    const executionId = body.executionId || body.id;
    expect(executionId).toBeTruthy();

    // Now poll the execution endpoint via the API helper. The UI's
    // Live panel will be updating in parallel; we let that be.
    const { waitForExecution } = await import("../../helpers/api.js");
    const row = await waitForExecution({ token, id: executionId, timeoutMs: 25_000 });
    expect(row.status).toBe("success");
  } finally {
    await deleteWorkflow({ token, id: wf.id }).catch(() => {});
  }
});
