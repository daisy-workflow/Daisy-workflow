// MUST stay at the top — telemetry.js starts the OpenTelemetry SDK on
// import, and the auto-instrumentations only hook modules loaded AFTER
// sdk.start(). Anything imported above this line wouldn't be traced.
import "./telemetry.js";

import http from "node:http";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import cookieParser from "cookie-parser";
import { config } from "./config.js";
import { log } from "./utils/logger.js";
import { HttpError } from "./utils/errors.js";
import { loadBuiltins, registry } from "./plugins/registry.js";
import { readiness } from "./health/checks.js";
import { limiters } from "./middleware/rateLimit.js";
import authRouter from "./api/auth.js";
import usersRouter from "./api/users.js";
import workspacesRouter from "./api/workspaces.js";
import projectsRouter from "./api/projects.js";
import serviceAccountsRouter from "./api/serviceAccounts.js";
import projectPluginsRouter from "./api/projectPlugins.js";
import customRolesRouter from "./api/customRoles.js";
import resourceGrantsRouter from "./api/resourceGrants.js";
import crossProjectGrantsRouter from "./api/crossProjectGrants.js";
import quotasRouter from "./api/quotas.js";
import jitGrantsRouter from "./api/jitGrants.js";
import auditRouter from "./api/audit.js";
import graphsRouter from "./api/graphs.js";
import executionsRouter from "./api/executions.js";
import pluginsRouter from "./api/plugins.js";
import aiRouter from "./api/ai.js";
import triggersRouter from "./api/triggers.js";
import webhooksRouter from "./api/webhooks.js";
import configsRouter from "./api/configs.js";
import agentsRouter  from "./api/agents.js";
import memoryRouter  from "./api/memory.js";
import { attachWss } from "./ws/broadcast.js";

await loadBuiltins();
await registry.loadAll();

const app = express();
// Cookie-aware CORS: when the frontend lives on a different origin
// (dev: 5173 vs API on 3000) we have to mirror the Origin header back
// + send Access-Control-Allow-Credentials:true, otherwise the browser
// silently drops Set-Cookie on the refresh-cookie response.
app.use(cors({
  origin: (origin, cb) => cb(null, origin || true),  // reflect any origin (dev-friendly; tighten in prod)
  credentials: true,
}));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(morgan("tiny"));

// Trust the first hop's X-Forwarded-* headers so req.ip is the
// real client IP when Daisy sits behind nginx / a load balancer.
// Without this, every request appears to come from the proxy and
// IP-based rate limits become essentially a single shared bucket.
// One hop is the typical edge-proxy depth; bump if you have more
// layers (e.g. Cloudflare → ELB → API = 2).
app.set("trust proxy", parseInt(process.env.TRUST_PROXY_HOPS || "1", 10));

// Global per-IP rate limit, applied before any route resolution so
// even a 404 contributes to the bucket. Health probes are mounted
// BEFORE this so monitoring agents probing once/second don't get
// throttled.
app.get("/health",  (_req, res) => res.json({ ok: true, env: config.env }));
app.get("/healthz", (_req, res) => res.json({ ok: true }));
app.get("/readyz",  async (_req, res) => {
  const { ok, checks } = await readiness();
  res.status(ok ? 200 : 503).json({ ok, checks });
});

app.use(limiters.global);

// (Health probes are mounted just above the global rate-limit
// middleware so monitoring agents probing once/second don't get
// throttled. See the trust-proxy block.)

// Auth lives BEFORE the protected routes — and is itself unprotected
// at the router level (login/refresh are public; /me uses requireUser
// inline).
app.use("/auth", authRouter);
app.use("/users", usersRouter);
app.use("/workspaces", workspacesRouter);
app.use("/projects",         projectsRouter);
app.use("/service-accounts", serviceAccountsRouter);
app.use("/project-plugins",  projectPluginsRouter);
app.use("/custom-roles",     customRolesRouter);
app.use("/resource-grants",  resourceGrantsRouter);
app.use("/cross-project-grants", crossProjectGrantsRouter);
app.use("/quotas",               quotasRouter);
app.use("/jit-grants",           jitGrantsRouter);
app.use("/audit", auditRouter);

app.use("/graphs", graphsRouter);
app.use("/executions", executionsRouter);
app.use("/plugins", pluginsRouter);
app.use("/ai", aiRouter);
app.use("/triggers", triggersRouter);
app.use("/configs",  configsRouter);
app.use("/agents",   agentsRouter);
app.use("/memory",   memoryRouter);
// Public webhook endpoint — bypasses /api proxy in dev because the path is
// absolute (/webhooks/<id>). External services hit it directly.
app.use("/webhooks", webhooksRouter);

app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message, details: err.details });
  }
  log.error("unhandled error", { error: err.message, stack: err.stack });
  res.status(500).json({ error: "INTERNAL", message: err.message });
});

const server = http.createServer(app);
attachWss(server);

server.listen(config.port, () => {
  log.info("api listening", { port: config.port });
});

// In dev, also spin up an in-process worker so a single `npm run dev` boots everything.
if (config.env !== "production") {
  await import("./worker.js");
}
