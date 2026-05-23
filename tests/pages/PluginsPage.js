// Page Object for /plugins.

export class PluginsPage {
  /** @param {import("@playwright/test").Page} page */
  constructor(page) { this.page = page; }

  async goto() {
    await this.page.goto("/plugins");
    // PluginsPage uses Quasar table rows + a sidebar — no top-level
    // heading. Use the toolbar title text as a "mounted" signal.
    await this.page.locator(".text-h6").first().waitFor({ state: "visible" });
    // Then wait for the API call to come back — the table is empty
    // until the plugin list resolves.
    await this.page.waitForResponse(r => r.url().endsWith("/plugins"), { timeout: 10_000 })
      .catch(() => { /* page may load from cache */ });
  }

  /** Count rows in the installed-plugins table. The table is a
   *  q-table; row count is the number of <tr> with role="row"
   *  minus the header row. */
  async rowCount() {
    const rows = this.page.locator("tbody tr");
    return rows.count();
  }

  /** Returns true if a plugin with the given name appears in the
   *  installed table. */
  async hasPlugin(name) {
    return this.page.getByText(name, { exact: true }).first().isVisible();
  }
}
