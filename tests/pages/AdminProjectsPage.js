// Page Object for /admin?view=projects.
//
// Same page rendered by AdminPage.vue — `?view=projects` selects the
// embedded ProjectsPage component. The page's "New project" button
// opens a dialog with a Name input + Create submit.

export class AdminProjectsPage {
  /** @param {import("@playwright/test").Page} page */
  constructor(page) { this.page = page; }

  async open() {
    await this.page.goto("/admin?view=projects");
    // AdminPage renders ProjectsPage inside its panel without an
    // explicit <h1>/<h2> "Projects" heading — the section is
    // identified by the sidebar item. Wait for the active sidebar
    // item to highlight as a stable "panel is mounted" signal.
    await this.page.locator(".admin-active").first().waitFor({ state: "visible" });
  }

  /** Click the toolbar's "New project" button — kicks open the dialog.
   *  Also matches a bare "+" icon button if that's all the page renders. */
  async openNewProjectDialog() {
    const btn = this.page
      .getByRole("button", { name: /new\s+project|create\s+project|add\s+project|new/i })
      .or(this.page.locator('button:has(i.q-icon:has-text("add"))'))
      .first();
    await btn.waitFor({ state: "visible", timeout: 10_000 });
    await btn.click();
  }

  /** Inside the new-project dialog. */
  async fillProjectName(name) {
    
    await this.page.locator('.project-name-input').waitFor();
await this.page.locator('.project-name-input').fill(name);

    //await this.page.getByLabel(/^name$/i).first().fill(name);
  }

  async confirmCreate() {
    // Either "Create" or "Save" in the dialog footer.
    await this.page.getByRole("button", { name: /^(create|save)$/i }).first().click();
  }

  /** True if a row with the project name is visible in the table. */
  async hasProjectRow(name) {
    return this.page.getByRole("row").filter({ hasText: name }).first().isVisible();
  }
}
