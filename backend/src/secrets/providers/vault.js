// HashiCorp Vault — Transit-engine provider.
//
// Vault's Transit engine is the secrets-as-a-service alternative to a
// cloud KMS. Customers running their own Vault cluster (or HCP Vault)
// use this when they want KEK custody on-prem.
//
// Required env vars:
//
//     VAULT_ADDR              https://vault.example.com:8200
//     VAULT_TOKEN             hvs....
//                             (use Vault Agent / AppRole / Kubernetes
//                              auth and write the resulting token to
//                              this env var via your deployment system —
//                              Daisy doesn't do auth-flow handshakes)
//     VAULT_TRANSIT_KEY       daisy-kek    (the named key in transit)
//
// Optional:
//
//     VAULT_TRANSIT_MOUNT     transit      (default mount point)
//     VAULT_NAMESPACE         myorg        (Enterprise + HCP only)
//     VAULT_CACERT            /etc/.../ca.pem  (TLS CA path)
//
// Transit gives us a first-class `datakey/plaintext` operation, so —
// unlike Azure / GCP — we don't have to generate the DEK locally and
// wrap it; Vault does both in one round-trip.
//
// Direct HTTP via fetch keeps the dep tree small (no node-vault SDK).
// Vault's API is stable + boring; we use POST /v1/<mount>/{datakey,
// decrypt}/<key>.

import { log } from "../../utils/logger.js";
import crypto from "node:crypto";
import https from "node:https";
import fs from "node:fs";

export async function create() {
  const addr = (process.env.VAULT_ADDR || "").replace(/\/$/, "");
  const token = process.env.VAULT_TOKEN;
  const key   = process.env.VAULT_TRANSIT_KEY;
  const mount = process.env.VAULT_TRANSIT_MOUNT || "transit";
  const ns    = process.env.VAULT_NAMESPACE || "";
  const caPath = process.env.VAULT_CACERT;

  if (!addr)  throw new Error("KMS_PROVIDER=vault requires VAULT_ADDR (https://host:8200)");
  if (!token) throw new Error("KMS_PROVIDER=vault requires VAULT_TOKEN");
  if (!key)   throw new Error("KMS_PROVIDER=vault requires VAULT_TRANSIT_KEY");

  // Custom TLS agent when a CA bundle path is supplied. Operators
  // doing self-signed Vault deployments need this; everyone else
  // gets Node's default cert store.
  let httpsAgent;
  if (caPath) {
    try {
      const ca = fs.readFileSync(caPath);
      httpsAgent = new https.Agent({ ca });
    } catch (e) {
      throw new Error(`VAULT_CACERT path unreadable: ${e.message}`);
    }
  }

  // Boot-time sanity check — read the key's metadata. Catches typos in
  // mount / key + missing perms before the first real workflow runs.
  await vaultFetch(`${addr}/v1/${mount}/keys/${encodeURIComponent(key)}`, {
    method: "GET",
    token, namespace: ns, agent: httpsAgent,
  }).catch((e) => {
    throw new Error(
      `Vault transit key check failed for "${mount}/${key}": ${e.message}. ` +
      `Verify the mount is enabled, the key exists, and the token has read perms.`,
    );
  });
  log.info("[kms:vault] client ready", { addr, mount, key, ns: ns || "(default)" });

  return {
    id:    "vault",
    kekId: `${mount}/${key}`,

    async generateDataKey() {
      // Vault returns BOTH plaintext (base64) and ciphertext (vault: format)
      // in one call. Best-of-the-bunch for envelope encryption — saves
      // a round-trip vs the wrap-locally pattern Azure / GCP need.
      const body = await vaultFetch(
        `${addr}/v1/${mount}/datakey/plaintext/${encodeURIComponent(key)}`,
        { method: "POST", token, namespace: ns, agent: httpsAgent,
          body: { bits: 256 } },
      );
      const plaintextB64 = body?.data?.plaintext;
      const ciphertext   = body?.data?.ciphertext;
      if (!plaintextB64 || !ciphertext) {
        throw new Error("vault datakey/plaintext: missing plaintext or ciphertext in response");
      }
      return {
        plaintextDek: Buffer.from(plaintextB64, "base64"),
        // Vault's wrapped form is the "vault:v1:..." string — store the
        // utf8 bytes so the same decrypt() call below can hand them
        // back as-is. Smaller than a binary blob would be anyway.
        wrappedDek:   Buffer.from(ciphertext, "utf8"),
        kekId:        `${mount}/${key}`,
      };
    },

    async decrypt(wrappedDek, _kekId) {
      const ciphertext = Buffer.isBuffer(wrappedDek)
        ? wrappedDek.toString("utf8")
        : String(wrappedDek);
      const body = await vaultFetch(
        `${addr}/v1/${mount}/decrypt/${encodeURIComponent(key)}`,
        { method: "POST", token, namespace: ns, agent: httpsAgent,
          body: { ciphertext } },
      );
      const plaintextB64 = body?.data?.plaintext;
      if (!plaintextB64) throw new Error("vault decrypt: missing plaintext in response");
      return Buffer.from(plaintextB64, "base64");
    },

    async shutdown() {
      // Nothing to clean up — fetch + agent are stateless from our side.
    },
  };
}

// Single small wrapper around fetch with Vault-flavoured headers + error
// translation. Returns the parsed JSON body on success.
async function vaultFetch(url, { method = "GET", token, namespace, body, agent } = {}) {
  const headers = { "X-Vault-Token": token };
  if (namespace) headers["X-Vault-Namespace"] = namespace;
  if (body)      headers["Content-Type"] = "application/json";

  // `agent` is consumed by node's undici via the dispatcher hook; we
  // only set it when a custom CA was supplied. Without it, fetch uses
  // the system default.
  const init = { method, headers, body: body ? JSON.stringify(body) : undefined };
  if (agent) init.dispatcher = await buildDispatcher(agent);

  const res = await fetch(url, init);
  if (!res.ok) {
    let detail;
    try { detail = (await res.json())?.errors?.join("; "); } catch { /* */ }
    throw new Error(`Vault ${method} ${url} failed: ${res.status} ${detail || res.statusText}`);
  }
  // Some endpoints (like the boot key-read) can return 204; tolerate it.
  if (res.status === 204) return null;
  try { return await res.json(); } catch { return null; }
}

// Build an undici dispatcher backed by the supplied https.Agent. Lazy +
// optional — only used when VAULT_CACERT is set.
async function buildDispatcher(agent) {
  try {
    const { Agent } = await import("undici");
    return new Agent({
      connect: { ca: agent.options.ca, rejectUnauthorized: true },
    });
  } catch {
    return undefined;     // fallback to default if undici isn't available
  }
}
