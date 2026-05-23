// Page Object for /agentDesigner/:id.
//
// Smoke layer didn't touch this surface — Layer 2 does. The form
// uses Quasar inputs with `label="..."` props, so getByLabel keeps
// working without data-test annotations on the components.

export class AgentDesigner {
  /** @param {import("@playwright/test").Page} page */
  constructor(page) { this.page = page; }

  async open(agentId) {
    await this.page.goto(`/agentDesigner/${agentId}`);
    // Wait for the title input to hydrate — proves the agent row
    // arrived from the API and the form populated.
    await this.page.getByLabel(/title/i).first().waitFor({ state: "visible" });
  }

  /** Fill the title input. Quasar wraps inputs in <label> so
   *  getByLabel finds the actual <input>. */
  async setTitle(title) {
    const input = this.page.getByLabel(/title/i).first();
    await input.click({ clickCount: 3 });
    await input.fill(title);
  }

  async setPrompt(text) {
    // AgentDesigner.vue label is dynamic:
    //   - "System prompt"        when no template is bound (default)
    //   - "Fallback prompt (...)" when a prompt_template_id is set
    // Match either by starts-with — Quasar's <q-input :label>
    // becomes the input's accessible name.
   /* const input = this.page
      .getByLabel(/^system prompt$|^fallback prompt/i)
      .first();*/
      const input = this.page.locator(".markdown-editor textarea").first();
    await input.click({ clickCount: 3 });
    await input.fill(text);
  }

  /** Save — the toolbar's primary action button. */
  async save() {
    this.page.locator(".save-button").first().click();
    //await this.page.getByRole("button", { name: /^save$/i }).first().click();
  }

  /** The Quasar notify banner appears for a few seconds after save.
   *  We assert on the success notify so the test knows persistence
   *  came back from the API. */
  async expectSaveToast() {
    await this.page.locator(".q-notification").filter({ hasText: /saved|updated|success/i }).first().waitFor({ state: "visible" });
  }
}
