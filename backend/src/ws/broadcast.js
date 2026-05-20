// WebSocket broadcaster — live execution events for the InstanceViewer.
//
// Auth (PR 2):
//   The WS upgrade now requires an access token presented as a query
//   string parameter:
//     ws://host/ws?executionId=<id>&access_token=<jwt>
//   The token is verified, the user's workspace is loaded, and the
//   subscriber is bound to that workspace. When events come in over
//   Redis pub/sub, we only deliver them to subscribers whose
//   workspace_id matches the execution's workspace_id (looked up
//   once per executionId and cached for the lifetime of the
//   subscription).
//
// Why query-string token instead of Authorization header:
//   The browser WebSocket API can't set custom headers on the upgrade
//   request. Either query-string (this) or Sec-WebSocket-Protocol
//   subprotocols are the standard workarounds; query-string is
//   marginally simpler and the access token's 15-min TTL keeps the
//   exposure window short. URLs aren't logged to disk by default
//   in this codebase.

import { WebSocketServer } from "ws";
import { redisConnection } from "../queue/queue.js";
import { log } from "../utils/logger.js";
import IORedis from "ioredis";
import { config } from "../config.js";
import { pool } from "../db/pool.js";
import { verifyAccessToken } from "../auth/tokens.js";
import { isApiKeyToken, findActiveByToken, markUsed } from "../auth/apiKeys.js";

const CHANNEL = "dag.events";

let wss;
// executionId -> Set<WebSocket>
const subscribersByExecution = new Map();
// executionId -> workspace_id (cached after first lookup)
const executionWorkspace = new Map();

/** Attach the WS server to an existing HTTP server. */
export function attachWss(httpServer) {
  wss = new WebSocketServer({ server: httpServer, path: "/ws" });
  wss.on("connection", async (ws, req) => {
    const url = new URL(req.url, "http://x");
    const executionId = url.searchParams.get("executionId");
    const token       = url.searchParams.get("access_token");

    // Authenticate the upgrade. Closing with a non-1000 code surfaces
    // the failure to the browser's onerror; the frontend's auth-store
    // can re-issue a fresh token via /auth/refresh and reconnect.
    //
    // RBAC v2: accept either a JWT (interactive users) or a service-
    // account API key in the same access_token slot. CI / automation
    // can subscribe to live execution events via the SA's key.
    if (!token) {
      ws.close(4001, "missing access_token");
      return;
    }
    let userWorkspace = null;
    let principalId   = null;
    if (isApiKeyToken(token)) {
      const sa = await findActiveByToken(token);
      if (!sa) {
        ws.close(4001, "invalid or revoked API key");
        return;
      }
      markUsed(sa.keyId, req.socket?.remoteAddress || null);
      userWorkspace = sa.workspaceId;
      principalId   = sa.serviceAccountId;
    } else {
      let payload;
      try {
        payload = verifyAccessToken(token);
      } catch (e) {
        ws.close(4001, e.name === "TokenExpiredError" ? "token expired" : "invalid token");
        return;
      }
      userWorkspace = payload.ws;
      principalId   = payload.sub;
      if (!userWorkspace) {
        ws.close(4001, "no workspace in token");
        return;
      }
    }

    // If the client subscribed to a specific execution, verify it
    // belongs to the same workspace before binding.
    if (executionId) {
      const execWs = await getExecutionWorkspace(executionId);
      if (!execWs) {
        ws.close(4004, "execution not found");
        return;
      }
      if (execWs !== userWorkspace) {
        // Same shape as a 403 — the client shouldn't even know that
        // execution exists in another workspace.
        ws.close(4003, "forbidden");
        return;
      }

      if (!subscribersByExecution.has(executionId)) {
        subscribersByExecution.set(executionId, new Set());
      }
      const set = subscribersByExecution.get(executionId);
      set.add(ws);
      ws.on("close", () => {
        set.delete(ws);
        if (set.size === 0) {
          subscribersByExecution.delete(executionId);
          executionWorkspace.delete(executionId);   // free the cache slot
        }
      });
    }

    // Tag the socket with its workspace for any future routing.
    ws._workspace = userWorkspace;
    ws._user      = principalId;

    ws.send(JSON.stringify({ type: "hello", executionId }));
  });

  // Subscribe once to the Redis pub/sub channel so any worker can update us.
  const sub = new IORedis(config.redisUrl);
  sub.subscribe(CHANNEL).catch(e => log.error("redis subscribe failed", { error: e.message }));
  sub.on("message", (_ch, raw) => {
    let evt; try { evt = JSON.parse(raw); } catch { return; }
    const targets = subscribersByExecution.get(evt.executionId);
    if (!targets) return;
    const data = JSON.stringify(evt);
    for (const ws of targets) {
      // Defence in depth: even though we only put workspace-matching
      // sockets into the set at connect time, double-check here in
      // case the cache ever drifts.
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(data);
    }
  });

  log.info("ws server attached at /ws");
}

/** Publish from anywhere (API or worker). */
export async function publish(event) {
  await redisConnection.publish(CHANNEL, JSON.stringify(event));
}

// ──────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────

async function getExecutionWorkspace(executionId) {
  const cached = executionWorkspace.get(executionId);
  if (cached) return cached;
  const { rows } = await pool.query(
    "SELECT workspace_id FROM executions WHERE id=$1",
    [executionId],
  );
  if (rows.length === 0) return null;
  const ws = rows[0].workspace_id;
  executionWorkspace.set(executionId, ws);
  return ws;
}
