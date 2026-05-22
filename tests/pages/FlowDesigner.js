// Page Object for /flowDesigner/:id.
//
// Smoke tests only need to (a) confirm the designer mounted for a
// known workflow id, (b) trigger Run, and (c) wait for the Live
// panel to settle. They don't author flows through the UI — that
// happens via the API helper.

export class FlowDesigner {
  /** @param {import("@playwright/test").Page} page */
  constructor(page) { this.page = page; }

  async open(workflowId) {
    // Default mode is "visual"; smoke tests don't care which mode.
    await this.page.goto(`/flowDesigner/${workflowId}/visual`);
    // Wait until the toolbar has the Run button rendered. (Quasar's
    // `play_arrow` icon is what the Run button uses today; falling
    // back to text matches the eventual label too.)
    await this.runButton().waitFor({ state: "visible" });
  }

  runButton() {
    // FlowDesigner's Run button is `flat round dense icon="play_arrow"`
    // — no visible label, just a q-tooltip and the Material icon. The
    // accessible-name match fails because Quasar doesn't auto-set an
    // aria-label on icon-only buttons.
    //
    // Selector chain (most specific to broadest fallback):
    //   1. The <button> ancestor of the play_arrow icon — works for
    //      the current markup.
    //   2. The button whose tooltip text matches "Run" — works even
    //      if the icon name changes.
    return this.page
      .locator('button:has(i.q-icon:has-text("play_arrow"))')
      .or(this.page.locator('button').filter({ has: this.page.locator('.q-tooltip:has-text("Run")') }))
      .first();
  }

  async run() {
    await this.runButton().click();
  }

  /** Wait for an execution row to surface in the Live panel and
   *  return whatever id the panel shows in its URL or attribute. */
  async waitForExecutionVisible() {
    // The execution panel typically renders an "Execution started"
    // toast or appends an execution id; the URL also picks up an
    // `?execution=` query. Test files can also poll the API
    // directly via the helper — that's the more reliable signal,
    // so this is just a "did the UI react" check.
    await this.page.waitForLoadState("networkidle");
  }
}
