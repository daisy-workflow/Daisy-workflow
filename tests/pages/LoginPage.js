// Page Object for /login. Quasar's q-input renders the label as a
// real <label> wrapping the input, so getByLabel finds the field
// reliably even when no data-test attribute is set.

export class LoginPage {
  /** @param {import("@playwright/test").Page} page */
  constructor(page) { this.page = page; }

  async goto() {
    await this.page.goto("/login");
    // The hero brand mark is visible the moment the SPA hydrates;
    // it's a quick, stable signal that the page is interactive.
    await this.page.getByText("Daisy AI Orchestrator").first().waitFor();
  }

  async fillCredentials(email, password) {
    await this.page.getByLabel("Email").fill(email);
    await this.page.getByLabel("Password").fill(password);
  }

  async submit() {
    // Quasar renders the submit as a real <button type="submit">.
    // q-form's @submit.prevent catches it.
    await this.page.locator('form button[type="submit"]').first().click();
  }

  async loginAs(email, password) {
    await this.goto();
    await this.fillCredentials(email, password);
    await this.submit();

    // The form-submit promise resolves as soon as the network request
    // returns. The frontend then runs `ensureActiveProject()` to
    // auto-pick a project and stash its id in localStorage under
    // `daisy.activeProjectId`. Subsequent project-scoped page mounts
    // (FlowDesigner, AgentDesigner, KB pages) depend on that value.
    // Without this wait, navigating immediately to /flowDesigner/:id
    // races the project resolution and the page's first /graphs/:id
    // call 403s — the Designer never mounts.
    await this.page.waitForURL((url) => !/\/login(\?|$)/.test(url.toString()),
      { timeout: 15_000 });
    await this.page.waitForFunction(
      () => localStorage.getItem("daisy.activeProjectId") != null,
      null,
      { timeout: 15_000 },
    );
  }
}
