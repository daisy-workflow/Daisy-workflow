// Shared helpers for the object.store.* action plugins.
//
// Lives outside src/plugins/builtin/ so the plugin auto-loader doesn't
// register it as an action. All five object.store.* plugins import
// from here.
//
// Provider dispatch:
//   The config row has `provider: 's3' | 'gcs' | 'azure'`. We lazily
//   import the matching SDK on first use — so a worker that only ever
//   uses S3 doesn't pay the cost of pulling in @google-cloud/storage
//   and @azure/storage-blob just to boot. Each provider exposes the
//   same five operations (get / put / list / del / signedUrl), so the
//   plugin files themselves stay thin and provider-agnostic.
//
// SDK packages (declared as OPTIONAL in package.json):
//   • @aws-sdk/client-s3
//   • @aws-sdk/s3-request-presigner
//   • @google-cloud/storage
//   • @azure/storage-blob
//
// If a provider's SDK isn't installed, the plugin throws a clear
// "npm install <pkg>" error at runtime — same model used elsewhere
// in the codebase (Bedrock pulls @aws-sdk/client-bedrock-runtime only
// when actually invoked).

import { Buffer } from "node:buffer";
import { Readable } from "node:stream";

// In-process cache of constructed clients keyed by config-name +
// per-call bucket override. SDK clients are stateful (TLS pool,
// credentials cache) so reusing them across invocations is much
// cheaper than re-constructing per call.
const _clientCache = new Map();

/**
 * Resolve the stored `object.store` config from ctx and return a
 * provider-agnostic client + the bucket we'll operate on.
 *
 *   const { client, provider, bucket } = await getClient(ctx, name, bucketOverride);
 *
 * Throws friendly errors when the config is missing, the wrong type,
 * or the SDK isn't installed.
 */
export async function getClient(ctx, configName, bucketOverride) {
  if (!configName || typeof configName !== "string") {
    throw new Error(
      "object.store: `config` is required (name of a stored object.store configuration)",
    );
  }
  const cfg = ctx?.config?.[configName];
  if (!cfg || typeof cfg !== "object") {
    throw new Error(
      `object.store: config "${configName}" not found. Create a configuration ` +
      `of type object.store on the Home page → Configurations.`,
    );
  }
  const provider = cfg.provider || "s3";
  const bucket = bucketOverride || cfg.bucket;
  if (!bucket) {
    throw new Error(
      `object.store: config "${configName}" has no bucket set and no ` +
      `bucket override was provided in the node input.`,
    );
  }

  const cacheKey = `${configName}::${provider}::${cfg.bucket || ""}::${cfg.region || ""}::${cfg.endpoint || ""}::${cfg.azureAccount || ""}`;
  let client = _clientCache.get(cacheKey);
  if (!client) {
    if (provider === "s3")    client = await buildS3Client(cfg);
    else if (provider === "gcs")   client = await buildGcsClient(cfg);
    else if (provider === "azure") client = await buildAzureClient(cfg);
    else throw new Error(`object.store: unknown provider "${provider}"`);
    _clientCache.set(cacheKey, client);
  }
  return { client, provider, bucket };
}

// ────────────────────────────────────────────────────────────────────
// S3 (AWS S3, MinIO, Cloudflare R2, DigitalOcean Spaces, Wasabi …)
// ────────────────────────────────────────────────────────────────────
async function buildS3Client(cfg) {
  let S3, presigner;
  try {
    S3        = await import("@aws-sdk/client-s3");
    presigner = await import("@aws-sdk/s3-request-presigner");
  } catch (e) {
    throw new Error(
      "object.store(s3): missing SDK. Run `npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner` in the backend.",
    );
  }
  const opts = {
    region: cfg.region || "us-east-1",
  };
  if (cfg.endpoint)       opts.endpoint       = cfg.endpoint;
  if (cfg.forcePathStyle) opts.forcePathStyle = true;
  if (cfg.accessKeyId && cfg.secretAccessKey) {
    opts.credentials = {
      accessKeyId:     cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    };
  }
  const s3 = new S3.S3Client(opts);
  return {
    kind: "s3",
    async get(bucket, key) {
      const r = await s3.send(new S3.GetObjectCommand({ Bucket: bucket, Key: key }));
      const buf = await streamToBuffer(r.Body);
      return {
        body:        buf,
        contentType: r.ContentType || null,
        size:        r.ContentLength ?? buf.length,
        etag:        stripQuotes(r.ETag),
        lastModified: r.LastModified || null,
      };
    },
    async put(bucket, key, body, contentType) {
      const r = await s3.send(new S3.PutObjectCommand({
        Bucket: bucket, Key: key, Body: body,
        ContentType: contentType || undefined,
      }));
      return { etag: stripQuotes(r.ETag), size: body.length };
    },
    async putStream(bucket, key, stream, contentType, contentLength) {
      // Two paths:
      //   • Known length (typical when piping a fetch response with
      //     Content-Length — what OpenAI's TTS endpoint always sends
      //     and what every in-tree caller exercises today) → single
      //     PutObject with explicit length. Cheapest, S3 streams the
      //     body straight to the bucket.
      //   • Unknown length → @aws-sdk/lib-storage Upload, which does
      //     a multipart upload under the hood. Not a hard dependency
      //     because no in-tree code path needs it; deployments that
      //     genuinely stream unbounded data to S3 must `npm install
      //     @aws-sdk/lib-storage` separately.
      if (contentLength != null && Number.isFinite(contentLength)) {
        const r = await s3.send(new S3.PutObjectCommand({
          Bucket: bucket, Key: key,
          Body: stream,
          ContentType:   contentType || undefined,
          ContentLength: contentLength,
        }));
        return { etag: stripQuotes(r.ETag), size: contentLength };
      }
      let LibStorage;
      try { LibStorage = await import("@aws-sdk/lib-storage"); }
      catch {
        throw new Error(
          "object.store(s3): unknown-length streaming requires the optional " +
          "@aws-sdk/lib-storage package. Install it with `npm install " +
          "@aws-sdk/lib-storage` in the backend, OR pass an explicit " +
          "contentLength so the cheaper single-PutObject path is used " +
          "(OpenAI TTS always provides Content-Length, for example).",
        );
      }
      const upload = new LibStorage.Upload({
        client: s3,
        params: { Bucket: bucket, Key: key, Body: stream, ContentType: contentType || undefined },
      });
      const r = await upload.done();
      return { etag: stripQuotes(r.ETag), size: null };
    },
    async list(bucket, prefix, maxKeys) {
      const r = await s3.send(new S3.ListObjectsV2Command({
        Bucket: bucket, Prefix: prefix || undefined, MaxKeys: maxKeys,
      }));
      const items = (r.Contents || []).map(o => ({
        key:          o.Key,
        size:         o.Size,
        etag:         stripQuotes(o.ETag),
        lastModified: o.LastModified || null,
      }));
      return { items, truncated: !!r.IsTruncated };
    },
    async del(bucket, key) {
      await s3.send(new S3.DeleteObjectCommand({ Bucket: bucket, Key: key }));
      return { deleted: true };
    },
    async signedUrl(bucket, key, op, expiresInSec) {
      const Command = op === "put" ? S3.PutObjectCommand : S3.GetObjectCommand;
      const cmd = new Command({ Bucket: bucket, Key: key });
      const url = await presigner.getSignedUrl(s3, cmd, { expiresIn: expiresInSec });
      return { url };
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Google Cloud Storage
// ────────────────────────────────────────────────────────────────────
async function buildGcsClient(cfg) {
  let GCS;
  try { GCS = await import("@google-cloud/storage"); }
  catch (e) {
    throw new Error(
      "object.store(gcs): missing SDK. Run `npm install @google-cloud/storage` in the backend.",
    );
  }
  const opts = {};
  if (cfg.gcsCredentialsJson) {
    let parsed;
    try { parsed = JSON.parse(cfg.gcsCredentialsJson); }
    catch (e) {
      throw new Error(`object.store(gcs): gcsCredentialsJson is not valid JSON — ${e.message}`);
    }
    opts.credentials = parsed;
    opts.projectId   = parsed.project_id;
  }
  const storage = new GCS.Storage(opts);
  return {
    kind: "gcs",
    async get(bucket, key) {
      const file = storage.bucket(bucket).file(key);
      const [buf]     = await file.download();
      const [meta]    = await file.getMetadata();
      return {
        body:         buf,
        contentType:  meta.contentType || null,
        size:         Number(meta.size) || buf.length,
        etag:         meta.etag || null,
        lastModified: meta.updated ? new Date(meta.updated) : null,
      };
    },
    async put(bucket, key, body, contentType) {
      const file = storage.bucket(bucket).file(key);
      await file.save(body, { contentType: contentType || undefined });
      const [meta] = await file.getMetadata();
      return { etag: meta.etag || null, size: body.length };
    },
    async putStream(bucket, key, stream, contentType, contentLength) {
      // GCS's createWriteStream handles resumable uploads natively
      // — known + unknown length both work without lib-storage's
      // multipart dance.
      const file = storage.bucket(bucket).file(key);
      const writeStream = file.createWriteStream({
        contentType: contentType || undefined,
        // Resumable on by default; flip off for small known-length
        // uploads to save the resumable session round-trip.
        resumable: contentLength == null || contentLength > 5 * 1024 * 1024,
      });
      const inputAsNode = toNodeReadable(stream);
      await new Promise((resolve, reject) => {
        inputAsNode.on("error", reject);
        writeStream.on("error", reject);
        writeStream.on("finish", resolve);
        inputAsNode.pipe(writeStream);
      });
      const [meta] = await file.getMetadata();
      return { etag: meta.etag || null, size: Number(meta.size) || contentLength || null };
    },
    async list(bucket, prefix, maxKeys) {
      const [files, , metadata] = await storage.bucket(bucket).getFiles({
        prefix:      prefix || undefined,
        maxResults:  maxKeys,
        autoPaginate: false,
      });
      const items = files.map(f => ({
        key:          f.name,
        size:         Number(f.metadata?.size) || 0,
        etag:         f.metadata?.etag || null,
        lastModified: f.metadata?.updated ? new Date(f.metadata.updated) : null,
      }));
      return { items, truncated: !!metadata?.nextPageToken };
    },
    async del(bucket, key) {
      await storage.bucket(bucket).file(key).delete();
      return { deleted: true };
    },
    async signedUrl(bucket, key, op, expiresInSec) {
      const [url] = await storage.bucket(bucket).file(key).getSignedUrl({
        action:  op === "put" ? "write" : "read",
        expires: Date.now() + expiresInSec * 1000,
        version: "v4",
      });
      return { url };
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Azure Blob Storage
// ────────────────────────────────────────────────────────────────────
async function buildAzureClient(cfg) {
  let AzureBlob;
  try { AzureBlob = await import("@azure/storage-blob"); }
  catch (e) {
    throw new Error(
      "object.store(azure): missing SDK. Run `npm install @azure/storage-blob` in the backend.",
    );
  }
  if (!cfg.azureAccount) {
    throw new Error("object.store(azure): config is missing `azureAccount`");
  }
  const accountUrl = `https://${cfg.azureAccount}.blob.core.windows.net`;
  let svc, credentialForSas;
  if (cfg.azureKey) {
    credentialForSas = new AzureBlob.StorageSharedKeyCredential(cfg.azureAccount, cfg.azureKey);
    svc = new AzureBlob.BlobServiceClient(accountUrl, credentialForSas);
  } else if (cfg.azureSas) {
    // SAS string can be either with or without a leading '?' — normalise.
    const sas = cfg.azureSas.startsWith("?") ? cfg.azureSas : `?${cfg.azureSas}`;
    svc = new AzureBlob.BlobServiceClient(`${accountUrl}${sas}`);
    // signed-URL op below isn't supported when the connection itself
    // already authenticates via SAS — there's no shared key to sign with.
    credentialForSas = null;
  } else {
    throw new Error("object.store(azure): set either `azureKey` or `azureSas` on the config");
  }
  return {
    kind: "azure",
    async get(container, key) {
      const blob = svc.getContainerClient(container).getBlobClient(key);
      const r    = await blob.download();
      const buf  = await streamToBuffer(r.readableStreamBody);
      const props = await blob.getProperties();
      return {
        body:         buf,
        contentType:  props.contentType || null,
        size:         Number(props.contentLength) || buf.length,
        etag:         stripQuotes(props.etag),
        lastModified: props.lastModified || null,
      };
    },
    async put(container, key, body, contentType) {
      const blob = svc.getContainerClient(container).getBlockBlobClient(key);
      const r = await blob.uploadData(body, {
        blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
      });
      return { etag: stripQuotes(r.etag), size: body.length };
    },
    async putStream(container, key, stream, contentType, contentLength) {
      const blob = svc.getContainerClient(container).getBlockBlobClient(key);
      const opts = {
        blobHTTPHeaders: contentType ? { blobContentType: contentType } : undefined,
      };
      // uploadStream chunks the input into 4 MB blocks and uploads up
      // to 5 in parallel — works for known + unknown length. The Azure
      // SDK needs a Node Readable; convert if we got a Web stream.
      const nodeStream = toNodeReadable(stream);
      const r = await blob.uploadStream(
        nodeStream,
        4 * 1024 * 1024,   // buffer size per block
        5,                 // concurrency
        opts,
      );
      // The SDK doesn't return ContentLength on the response; trust
      // the caller's contentLength or report null.
      return { etag: stripQuotes(r.etag), size: contentLength ?? null };
    },
    async list(container, prefix, maxKeys) {
      const cc = svc.getContainerClient(container);
      const items = [];
      let truncated = false;
      const iter = cc.listBlobsFlat({ prefix: prefix || undefined }).byPage({ maxPageSize: maxKeys });
      const page = await iter.next();
      if (!page.done) {
        for (const b of page.value.segment.blobItems) {
          items.push({
            key:          b.name,
            size:         Number(b.properties?.contentLength) || 0,
            etag:         stripQuotes(b.properties?.etag),
            lastModified: b.properties?.lastModified || null,
          });
        }
        truncated = !!page.value.continuationToken;
      }
      return { items, truncated };
    },
    async del(container, key) {
      await svc.getContainerClient(container).getBlobClient(key).delete();
      return { deleted: true };
    },
    async signedUrl(container, key, op, expiresInSec) {
      // Service SAS for a single blob — only supported when we hold the
      // shared key (we can't re-sign over an existing account SAS).
      if (!credentialForSas) {
        throw new Error(
          "object.store(azure): signed_url requires `azureKey` on the config (cannot " +
          "re-sign when authenticating via SAS). Re-create the config with a shared key.",
        );
      }
      const expiresOn = new Date(Date.now() + expiresInSec * 1000);
      const sas = AzureBlob.generateBlobSASQueryParameters(
        {
          containerName: container,
          blobName:      key,
          permissions:   AzureBlob.BlobSASPermissions.parse(op === "put" ? "w" : "r"),
          expiresOn,
          protocol:      AzureBlob.SASProtocol.Https,
        },
        credentialForSas,
      ).toString();
      const url = `${accountUrl}/${container}/${encodeURIComponent(key)}?${sas}`;
      return { url };
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/**
 * Coerce a stream into a Node Readable. We get three flavours from
 * the wild:
 *   • Node Readable (the obvious case — pass through)
 *   • Web ReadableStream (Node fetch response bodies, Bun, etc.)
 *   • Buffer/Uint8Array (Edge case — wrap in a one-shot Readable)
 *
 * GCS + Azure's upload-stream APIs only accept Node Readables.
 */
function toNodeReadable(s) {
  if (!s) throw new Error("object.store: upload stream is missing");
  // Node Readable: has .pipe and .on('data')
  if (typeof s.pipe === "function" && typeof s.on === "function") return s;
  // Web ReadableStream: has .getReader
  if (typeof s.getReader === "function") return Readable.fromWeb(s);
  // Buffer / Uint8Array / Blob with arrayBuffer()
  if (Buffer.isBuffer(s) || s instanceof Uint8Array) return Readable.from([Buffer.from(s)]);
  throw new Error(`object.store: unsupported stream type ${s?.constructor?.name || typeof s}`);
}

/** Read a Node stream / async iterable into a Buffer. SDKs return body
 *  streams for downloads — every consumer here wants the bytes. */
export async function streamToBuffer(stream) {
  if (!stream) return Buffer.alloc(0);
  if (Buffer.isBuffer(stream)) return stream;
  if (typeof stream.getReader === "function") {
    // Web ReadableStream (AWS SDK v3 returns these on some platforms).
    const reader = stream.getReader();
    const parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
    }
    return Buffer.concat(parts);
  }
  // Node Readable.
  const parts = [];
  for await (const chunk of stream) {
    parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(parts);
}

/** S3 / Azure return ETags wrapped in quotes — strip them so callers
 *  don't have to. */
function stripQuotes(s) {
  if (typeof s !== "string") return s ?? null;
  return s.replace(/^"+|"+$/g, "");
}

/**
 * Normalise a plugin-input `content` blob (string or already-Buffer)
 * + an `encoding` flag (utf8 / base64) into the Buffer we hand the SDK.
 */
export function inputToBuffer(content, encoding = "utf8") {
  if (content == null) {
    throw new Error("object.store.write: `content` is required");
  }
  if (Buffer.isBuffer(content)) return content;
  if (encoding === "base64") {
    return Buffer.from(String(content), "base64");
  }
  return Buffer.from(String(content), "utf8");
}

/**
 * Render a Buffer for the plugin's output:
 *   • encoding === 'utf8'   → utf-8 string (default)
 *   • encoding === 'base64' → base64 string (for binary content)
 *   • encoding === 'binary' → alias for base64 (clearer at the call site
 *                             when piping into excel.parse etc.)
 */
export function bufferToOutput(buf, encoding = "utf8") {
  if (encoding === "base64" || encoding === "binary") {
    return buf.toString("base64");
  }
  return buf.toString("utf8");
}
