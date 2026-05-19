// Per-workflow editor-mode preference, persisted in localStorage.
//
// Each workflow remembers whether the user last opened it in the visual
// canvas or in the code editor. The two are full-screen separate views —
// no live sync between them — so the preference is purely a launcher
// hint. Row click on the HomePage flows table reads it; the explicit
// "Open in code / visual" buttons set it.
//
// Scope is per-browser per-workflow. We deliberately do NOT sync this to
// the server: it's a personal habit, not workflow state, and keeping it
// client-only avoids a migration + endpoint. Easy to promote to a
// user_workflow_prefs table later if anyone asks.

const KEY_PREFIX = "daisy.flowMode.";

const VALID = new Set(["visual", "code"]);
const DEFAULT_MODE = "visual";

/**
 * Read the saved mode for a workflow. Returns "visual" when nothing is
 * stored or when the stored value is corrupt — visual is the default
 * because it's the friendlier first impression for new users.
 *
 * @param {string} graphId
 * @returns {"visual"|"code"}
 */
export function getFlowMode(graphId) {
  if (!graphId || graphId === "new") return DEFAULT_MODE;
  try {
    const v = localStorage.getItem(KEY_PREFIX + graphId);
    return VALID.has(v) ? v : DEFAULT_MODE;
  } catch {
    return DEFAULT_MODE;
  }
}

/**
 * Persist the preferred mode for a workflow. Silently ignores invalid
 * input — caller stays simple.
 */
export function setFlowMode(graphId, mode) {
  if (!graphId || graphId === "new") return;
  if (!VALID.has(mode)) return;
  try {
    localStorage.setItem(KEY_PREFIX + graphId, mode);
  } catch {
    /* private mode / quota — preference just won't survive */
  }
}

/** Forget a workflow's stored preference (used when deleting a flow). */
export function clearFlowMode(graphId) {
  if (!graphId) return;
  try { localStorage.removeItem(KEY_PREFIX + graphId); }
  catch { /* ignore */ }
}
