// Knowledge Bases REST API.
//
// Endpoints (all project-scoped):
//
//   GET    /kbs                          — list KBs
//   POST   /kbs                          — create
//   GET    /kbs/:id                      — fetch one
//   PUT    /kbs/:id                      — rename / chunk-size tune
//   DELETE /kbs/:id                      — soft delete
//
//   GET    /kbs/embedders                — provider catalog (public to project members)
//
//   GET    /kbs/:id/documents            — list ingested docs
//   POST   /kbs/:id/documents/upload     — multipart file upload
//   POST   /kbs/:id/documents/url        — fetch a URL + ingest
//   POST   /kbs/:id/documents/text       — paste raw text + ingest
//   DELETE /kbs/:id/documents/:docId     — delete one doc + its chunks
//
//   POST   /kbs/:id/query                — test retrieval; returns top-K matches
//
// Permissions:
//   kb.read  — list / get / query (editors + viewers)
//   kb.write — create / update / delete / ingest (editors + admins)
//
// The router is wired under /kbs in server.js.

import { Router } from "express";
import multer from "multer";
import { randomUUID } from "node:crypto";

import { pool } from "../db/pool.js";
import { ValidationError, NotFoundError } from "../utils/errors.js";
import { requireUser, requireProject } from "../middleware/auth.js";
import { requirePermission } from "../auth/permissions.js";
import { auditLog } from "../audit/log.js";

import { extractFromBuffer, extractFromUrl } from "../rag/extract.js";
import {
  loadKb,
  createAndIngestDocument,
  retrieve,
} from "../rag/ingest.js";
import { listEmbedders, getEmbedder } from "../rag/embedders/index.js";
import { getStore, listBackends } from "../rag/store/index.js";

const router = Router();
router.use(requireUser);

// Project-agnostic catalog. The Create-KB dialog calls it before the
// active project is necessarily set in some flows, so it sits ahead
// of requireProject.
router.get("/embedders", (_req, res) => {
  res.json(listEmbedders());
});

// Vector backend catalog — drives the Backend dropdown on the
// Create-KB dialog. Each entry today is { name }; future versions
// can carry per-backend metadata (description, required config type).
router.get("/backends", (_req, res) => {
  res.json(listBackends());
});

router.use(requireProject);

// In-memory multipart upload. Stores the file body on req.file.buffer
// — the ingest pipeline only persists the *extracted text*, so we
// never keep the original blob on disk.
const MAX_UPLOAD_BYTES =
  Number(process.env.KB_MAX_UPLOAD_BYTES) || 25 * 1024 * 1024;
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: MAX_UPLOAD_BYTES },
});

// ─────────────────────────────────────────────────────────────
// KB CRUD
// ─────────────────────────────────────────────────────────────
router.get(
  "/",
  requirePermission("kb.read"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, title, description,
                embedding_provider, embedding_model, embedding_config_id,
                dimension, chunk_size, chunk_overlap,
                kb_backend, kb_backend_config_id, kb_backend_collection,
                document_count, chunk_count,
                created_at, updated_at
           FROM knowledge_bases
          WHERE workspace_id = $1
            AND project_id   = $2
            AND deleted_at IS NULL
          ORDER BY title`,
        [req.user.workspaceId, req.user.projectId],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

router.post(
  "/",
  requirePermission("kb.write"),
  async (req, res, next) => {
    try {
      const {
        title, description,
        embeddingProvider, embeddingModel, embeddingConfigId,
        chunkSize, chunkOverlap,
        // Backend selection. Defaults preserve the original Phase B
        // behaviour: pgvector with no external config.
        kbBackend, kbBackendConfigId, kbBackendCollection,
      } = req.body || {};

      if (!title || typeof title !== "string" || !title.trim()) {
        throw new ValidationError("title is required");
      }
      if (!embeddingProvider || !embeddingModel) {
        throw new ValidationError("embeddingProvider + embeddingModel are required");
      }
      // Validate the provider exists in the embedder registry. The
      // model is free-form so users can pick versions we haven't
      // hard-coded — the embedder will surface a clean HTTP 400 if
      // the model name is wrong.
      try { getEmbedder(embeddingProvider); }
      catch (e) { throw new ValidationError(e.message); }

      const backend = (kbBackend || "pgvector").trim();
      if (!["pgvector", "qdrant"].includes(backend)) {
        throw new ValidationError(`unknown kb backend "${backend}"`);
      }
      // External backends require a configs row carrying the
      // connection details (url + api key). pgvector uses the local
      // Postgres pool — no extra config needed.
      if (backend !== "pgvector" && !kbBackendConfigId) {
        throw new ValidationError(`kb_backend_config_id is required for backend "${backend}"`);
      }

      const id = randomUUID();
      // Collection name defaults to a stable derivation of the KB id
      // so multiple KBs sharing a Qdrant cluster never collide.
      const collection = backend === "pgvector"
        ? null
        : (kbBackendCollection?.trim() || `daisy_kb_${id.replace(/-/g, "").slice(0, 16)}`);

      await pool.query(
        `INSERT INTO knowledge_bases
           (id, workspace_id, project_id, title, description,
            embedding_provider, embedding_model, embedding_config_id,
            dimension, chunk_size, chunk_overlap,
            kb_backend, kb_backend_config_id, kb_backend_collection,
            created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1536,$9,$10,$11,$12,$13,$14)`,
        [
          id,
          req.user.workspaceId,
          req.user.projectId,
          title.trim(),
          description || null,
          embeddingProvider,
          embeddingModel,
          embeddingConfigId || null,
          clampInt(chunkSize, 100, 4000, 800),
          clampInt(chunkOverlap, 0, 1000, 100),
          backend,
          kbBackendConfigId || null,
          collection,
          req.user.id || null,
        ],
      );

      // Eagerly initialise the external backend so the user sees
      // connection failures immediately instead of at first ingest.
      // For pgvector this is a no-op. For Qdrant: GET collection,
      // create if 404.
      if (backend !== "pgvector") {
        try {
          const kb = await loadKb(id);
          const store = await getStore(kb);
          await store.ensureBackend();
        } catch (e) {
          // Roll the KB row back so the user can re-submit with
          // fixed connection details instead of having a "broken"
          // row littering their list.
          await pool.query(`DELETE FROM knowledge_bases WHERE id = $1`, [id]);
          throw new ValidationError(
            `${backend} backend setup failed: ${e.message}`,
          );
        }
      }

      await auditLog({
        req, action: "kb.create",
        resource: { type: "kb", id },
        projectId: req.user.projectId,
        metadata: { title, embeddingProvider, embeddingModel, backend, collection },
      });
      res.status(201).json({ id, kb_backend: backend, kb_backend_collection: collection });
    } catch (e) { next(e); }
  },
);

router.get(
  "/:id",
  requirePermission("kb.read"),
  async (req, res, next) => {
    try {
      const kb = await loadAndAuth(req);
      res.json(kb);
    } catch (e) { next(e); }
  },
);

router.put(
  "/:id",
  requirePermission("kb.write"),
  async (req, res, next) => {
    try {
      const { title, description, chunkSize, chunkOverlap } = req.body || {};
      const updates = [];
      const values = [req.params.id, req.user.workspaceId, req.user.projectId];

      if (title !== undefined) {
        if (!String(title).trim()) throw new ValidationError("title cannot be blank");
        values.push(String(title).trim()); updates.push(`title = $${values.length}`);
      }
      if (description !== undefined) {
        values.push(description || null); updates.push(`description = $${values.length}`);
      }
      if (chunkSize !== undefined) {
        values.push(clampInt(chunkSize, 100, 4000, 800));
        updates.push(`chunk_size = $${values.length}`);
      }
      if (chunkOverlap !== undefined) {
        values.push(clampInt(chunkOverlap, 0, 1000, 100));
        updates.push(`chunk_overlap = $${values.length}`);
      }

      if (!updates.length) return res.json({ ok: true });
      updates.push("updated_at = NOW()");

      const r = await pool.query(
        `UPDATE knowledge_bases SET ${updates.join(", ")}
          WHERE id = $1 AND workspace_id = $2 AND project_id = $3
            AND deleted_at IS NULL`,
        values,
      );
      if (!r.rowCount) throw new NotFoundError("kb");

      await auditLog({
        req, action: "kb.update",
        resource: { type: "kb", id: req.params.id },
        projectId: req.user.projectId,
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  },
);

router.delete(
  "/:id",
  requirePermission("kb.write"),
  async (req, res, next) => {
    try {
      const r = await pool.query(
        `UPDATE knowledge_bases SET deleted_at = NOW()
          WHERE id = $1 AND workspace_id = $2 AND project_id = $3
            AND deleted_at IS NULL`,
        [req.params.id, req.user.workspaceId, req.user.projectId],
      );
      if (!r.rowCount) throw new NotFoundError("kb");
      await auditLog({
        req, action: "kb.delete",
        resource: { type: "kb", id: req.params.id },
        projectId: req.user.projectId,
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  },
);

// ─────────────────────────────────────────────────────────────
// Documents
// ─────────────────────────────────────────────────────────────
router.get(
  "/:id/documents",
  requirePermission("kb.read"),
  async (req, res, next) => {
    try {
      await loadAndAuth(req);
      const { rows } = await pool.query(
        `SELECT id, title, source_type, source_uri, content_type, byte_size,
                content_hash, chunk_count, status, error, created_at, updated_at
           FROM kb_documents
          WHERE kb_id = $1
          ORDER BY created_at DESC`,
        [req.params.id],
      );
      res.json(rows);
    } catch (e) { next(e); }
  },
);

router.post(
  "/:id/documents/upload",
  requirePermission("kb.write"),
  // Multer's err handler is wired into the next() chain by express.
  upload.single("file"),
  async (req, res, next) => {
    try {
      const kb = await loadAndAuth(req);
      if (!req.file) throw new ValidationError("file is required (multipart field 'file')");

      const { text, contentType } = await extractFromBuffer(
        req.file.buffer,
        req.file.originalname,
        req.file.mimetype,
      );
      const docInfo = await createAndIngestDocument({
        kb,
        title:       req.body?.title || req.file.originalname || "untitled",
        sourceType:  "upload",
        sourceUri:   null,
        contentType,
        byteSize:    req.file.size,
        text,
        createdBy:   req.user.id || null,
      });

      await auditLog({
        req, action: "kb.document.upload",
        resource: { type: "kb", id: kb.id },
        projectId: req.user.projectId,
        metadata: { documentId: docInfo.id, chunks: docInfo.chunkCount },
      });
      res.status(201).json(docInfo);
    } catch (e) { next(e); }
  },
);

router.post(
  "/:id/documents/url",
  requirePermission("kb.write"),
  async (req, res, next) => {
    try {
      const kb = await loadAndAuth(req);
      const url = String(req.body?.url || "").trim();
      if (!/^https?:\/\//i.test(url)) {
        throw new ValidationError("url must start with http:// or https://");
      }
      // Phase F: HIPAA blocks ad-hoc URL fetches because they can
      // exfiltrate PHI to whatever endpoint the caller chose.
      // Operators on HIPAA must extract docs out-of-band and upload them.
      {
        const { loadWorkspaceCompliance, assertFeature }
          = await import("../compliance/enforce.js");
        const ws = await loadWorkspaceCompliance(req.user.workspaceId);
        try { assertFeature(ws, "url.fetch"); }
        catch (e) {
          if (e.code === "COMPLIANCE_BLOCKED") throw new ValidationError(e.message);
          throw e;
        }
      }
      const { text, contentType } = await extractFromUrl(url);
      const docInfo = await createAndIngestDocument({
        kb,
        title:       req.body?.title || url,
        sourceType:  "url",
        sourceUri:   url,
        contentType,
        byteSize:    Buffer.byteLength(text || "", "utf8"),
        text,
        createdBy:   req.user.id || null,
      });
      await auditLog({
        req, action: "kb.document.fetch",
        resource: { type: "kb", id: kb.id },
        projectId: req.user.projectId,
        metadata: { url, documentId: docInfo.id },
      });
      res.status(201).json(docInfo);
    } catch (e) { next(e); }
  },
);

router.post(
  "/:id/documents/text",
  requirePermission("kb.write"),
  async (req, res, next) => {
    try {
      const kb = await loadAndAuth(req);
      const text  = String(req.body?.text || "");
      const title = String(req.body?.title || "").trim() || `inline ${new Date().toISOString()}`;
      if (!text.trim()) throw new ValidationError("text is required");
      const docInfo = await createAndIngestDocument({
        kb,
        title,
        sourceType:  "text",
        sourceUri:   null,
        contentType: "text/plain",
        byteSize:    Buffer.byteLength(text, "utf8"),
        text,
        createdBy:   req.user.id || null,
      });
      await auditLog({
        req, action: "kb.document.text",
        resource: { type: "kb", id: kb.id },
        projectId: req.user.projectId,
        metadata: { documentId: docInfo.id, chars: text.length },
      });
      res.status(201).json(docInfo);
    } catch (e) { next(e); }
  },
);

router.delete(
  "/:id/documents/:documentId",
  requirePermission("kb.write"),
  async (req, res, next) => {
    try {
      const kb = await loadAndAuth(req);
      // External backends (Qdrant) hold the chunk vectors out-of-DB,
      // so we have to call their deleteDocumentChunks before the SQL
      // DELETE. pgvector relies on FK cascade — calling its
      // deleteDocumentChunks here is a redundant but harmless second
      // pass. Doing it BEFORE the row delete means we know which KB
      // (and therefore which backend) the document belongs to.
      try {
        const store = await getStore(kb);
        await store.deleteDocumentChunks(req.params.documentId);
      } catch (e) {
        // Surface as a 500 — the alternative (orphaning Qdrant points
        // while removing the SQL row) leaves the KB inconsistent.
        throw new Error(`store delete failed: ${e.message}`);
      }
      const r = await pool.query(
        `DELETE FROM kb_documents WHERE id = $1 AND kb_id = $2`,
        [req.params.documentId, kb.id],
      );
      if (!r.rowCount) throw new NotFoundError("document");
      await pool.query(
        `UPDATE knowledge_bases
            SET document_count = (
                  SELECT COUNT(*) FROM kb_documents
                   WHERE kb_id = $1 AND status = 'ready'
                ),
                chunk_count = (
                  SELECT COALESCE(SUM(chunk_count),0) FROM kb_documents
                   WHERE kb_id = $1 AND status = 'ready'
                ),
                updated_at = NOW()
          WHERE id = $1`,
        [kb.id],
      );
      await auditLog({
        req, action: "kb.document.delete",
        resource: { type: "kb", id: kb.id },
        projectId: req.user.projectId,
        metadata: { documentId: req.params.documentId },
      });
      res.json({ ok: true });
    } catch (e) { next(e); }
  },
);

// ─────────────────────────────────────────────────────────────
// Test retrieval — used by the KB detail page's "try it" panel.
// Counts as kb.read (no mutation), but does spend embedding tokens
// against the project's monthly quota.
// ─────────────────────────────────────────────────────────────
router.post(
  "/:id/query",
  requirePermission("kb.read"),
  async (req, res, next) => {
    try {
      const kb = await loadAndAuth(req);
      const query = String(req.body?.query || "").trim();
      if (!query) throw new ValidationError("query is required");
      const topK = clampInt(req.body?.topK, 1, 50, 5);
      const minScore = Number(req.body?.minScore) || 0;
      const r = await retrieve({ kbId: kb.id, query, topK, minScore });
      res.json({ matches: r.matches, usage: r.usage });
    } catch (e) { next(e); }
  },
);

// ─── helpers ───────────────────────────────────────────────────

/**
 * Load the KB row and verify it lives in the active workspace+project.
 * Throws NotFoundError otherwise — we deliberately don't distinguish
 * "not yours" from "doesn't exist" to avoid leaking IDs across
 * projects.
 */
async function loadAndAuth(req) {
  const kb = await loadKb(req.params.id);
  if (!kb
   || kb.workspace_id !== req.user.workspaceId
   || kb.project_id   !== req.user.projectId) {
    throw new NotFoundError("kb");
  }
  return kb;
}

function clampInt(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

export default router;
