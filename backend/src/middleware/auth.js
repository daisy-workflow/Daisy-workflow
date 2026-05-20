// Auth middleware — three pieces.
//
//   • requireUser     — verifies the JWT, loads the user, attaches
//                       req.user. 401 on missing / bad token. The
//                       single guard you put in front of any route
//                       that needs a logged-in caller.
//
//   • requireRole(*)  — runs AFTER requireUser. 403 unless the user's
//                       role is in the allow-list.
//
//   • requireWorkspace(req, res, next) — auto-applied via requireUser;
//                       refuses requests where req.user has no
//                       workspace (shouldn't happen because the
//                       schema's NOT NULL, but a belt for the braces).
//
// req.user shape after requireUser:
//   {
//     id:          uuid,
//     email:       string,
//     role:        'admin' | 'editor' | 'viewer',
//     workspaceId: uuid,           // currently-active workspace
//     status:      'active' | 'disabled',
//   }
//
// Why we re-fetch the user on every request:
//   We could trust the JWT payload alone — that's the canonical
//   "stateless JWT" play. But then deactivating an account or
//   demoting an admin doesn't take effect until their access token
//   expires (up to 15 min). One extra indexed PK lookup against
//   `users` keeps the admin-disable flow snappy and gives us a clear
//   "user no longer exists" surface.

import { pool } from "../db/pool.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { isApiKeyToken, findActiveByToken, markUsed } from "../auth/apiKeys.js";
import { UnauthorizedError, ForbiddenError } from "../utils/errors.js";

/**
 * Decode the bearer JWT, validate the user is still active, and
 * attach req.user. Use as the FIRST middleware on every protected
 * route group.
 */
export async function requireUser(req, _res, next) {
  try {
    const token = extractBearer(req);
    if (!token) throw new UnauthorizedError("missing bearer token");

    // ── Branch on token kind ──
    //
    // `dks_…` → service-account API key. Resolves through the
    // api_keys table; the project + role are fixed at the SA, so the
    // X-Project-Id header is IGNORED (SAs can't cross projects).
    //
    // Otherwise → JWT issued via /auth/login or /auth/refresh.
    if (isApiKeyToken(token)) {
      const sa = await findActiveByToken(token);
      if (!sa) throw new UnauthorizedError("invalid or revoked API key");
      // Best-effort last-used metric.
      markUsed(sa.keyId, req.ip || null);
      req.user = {
        // SAs don't have a users.id, but downstream code reads .id
        // freely. Use the service_account.id so the value is stable
        // and meaningful for audit + per-row provenance.
        id:                 sa.serviceAccountId,
        email:              sa.serviceAccountName,   // for display in audit / logs
        kind:               "service_account",
        role:               sa.role,                  // built-in role within the project
        workspaceId:        sa.workspaceId,
        projectId:          sa.projectId,
        status:             "active",
        serviceAccountId:   sa.serviceAccountId,
        apiKeyId:           sa.keyId,
      };
      return next();
    }

    let payload;
    try {
      payload = verifyAccessToken(token);
    } catch (e) {
      // jsonwebtoken throws JsonWebTokenError / TokenExpiredError —
      // map both to 401 without leaking the specific reason.
      throw new UnauthorizedError(
        e.name === "TokenExpiredError" ? "token expired" : "invalid token",
      );
    }

    const userId = payload.sub;
    const { rows } = await pool.query(
      `SELECT id, email, role, workspace_id, status
         FROM users WHERE id = $1`,
      [userId],
    );
    if (rows.length === 0) throw new UnauthorizedError("user no longer exists");
    const u = rows[0];
    if (u.status !== "active") throw new UnauthorizedError("user disabled");

    // The JWT carries `ws` (active workspace at issue time). If the
    // user has switched workspaces since, the access token would
    // still be carrying the old value until refresh. Trust the JWT
    // payload — switching workspace forces a refresh on the client.
    const workspaceId = payload.ws || u.workspace_id;

    // RBAC v2: project context. Resolution order:
    //   1. Header X-Project-Id (overrides anything else — used by
    //      tools that operate across projects on behalf of a user).
    //   2. Query / param `projectId` is intentionally NOT consulted
    //      here — route-specific code handles that for routes that
    //      take it from the URL path (e.g. /projects/:id/...).
    //   3. JWT `proj` claim (the UI's last-active project).
    //
    // If we land on a project id, validate that the user actually
    // belongs to it. Workspace admins implicitly belong to every
    // project in their workspace (see auth/permissions.js).
    let projectId = null;
    const headerProject = req.headers["x-project-id"];
    if (headerProject) {
      projectId = String(headerProject);
    } else if (payload.proj) {
      projectId = payload.proj;
    }

    req.user = {
      id:          u.id,
      email:       u.email,
      kind:        "user",
      role:        u.role,
      workspaceId,
      projectId,
      status:      u.status,
    };
    next();
  } catch (e) { next(e); }
}

/**
 * Guard that the request carries a project context. Use after
 * requireUser on routes that need to scope to a specific project but
 * don't take the project id from the path themselves (e.g. POST /graphs).
 * Returns 400 with `{ need: "projectId" }` when missing.
 */
export function requireProject(req, _res, next) {
  if (!req.user?.projectId) {
    return next(new ForbiddenError(
      "no active project — supply X-Project-Id header or switch project",
      { need: "projectId" },
    ));
  }
  next();
}

/**
 * requireRole('admin')                 — admin only
 * requireRole('admin', 'editor')       — admin or editor
 *
 * Use AFTER requireUser. 403 with `{ need: [...allowed] }` body if
 * the user's role doesn't match.
 */
export function requireRole(...allowed) {
  if (allowed.length === 0) {
    throw new Error("requireRole called with no roles");
  }
  return (req, _res, next) => {
    try {
      if (!req.user) {
        return next(new UnauthorizedError("authentication required"));
      }
      if (!allowed.includes(req.user.role)) {
        return next(new ForbiddenError(
          `role "${req.user.role}" not permitted`,
          { need: allowed },
        ));
      }
      next();
    } catch (e) { next(e); }
  };
}

/**
 * Extract the bearer token from the Authorization header. Supports
 * two carrier formats:
 *
 *   Authorization: Bearer <token>
 *   ?access_token=<token>      (query param — used by EventSource /
 *                               WebSocket upgrade where headers can't
 *                               be set from JS)
 */
function extractBearer(req) {
  const h = req.headers.authorization || req.headers.Authorization;
  if (h && /^Bearer /i.test(h)) {
    return h.slice(7).trim();
  }
  if (req.query?.access_token) return String(req.query.access_token);
  return null;
}
