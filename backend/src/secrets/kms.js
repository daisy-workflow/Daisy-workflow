// KMS provider dispatch.
//
// The configs feature uses envelope encryption: each row gets its own
// fresh Data Encryption Key (DEK) that AES-encrypts the row's secret
// fields, and that DEK is itself wrapped (encrypted) by a Key
// Encryption Key (KEK). The KEK lives wherever the chosen provider
// keeps it — for "local" that's a key derived from CONFIG_SECRET; for
// "aws" it's an AWS KMS key whose material never leaves the HSM.
//
// Pluggable selection via env:
//
//     KMS_PROVIDER=local          (default, no extra deps, dev-friendly)
//     KMS_PROVIDER=aws            requires @aws-sdk/client-kms;
//                                 reads KMS_KEY_ID + AWS_REGION
//     KMS_PROVIDER=vault          HashiCorp Vault Transit. No SDK dep —
//                                 talks HTTP. Reads VAULT_ADDR,
//                                 VAULT_TOKEN, VAULT_TRANSIT_KEY,
//                                 optional VAULT_TRANSIT_MOUNT,
//                                 VAULT_NAMESPACE, VAULT_CACERT.
//     KMS_PROVIDER=azure          Azure Key Vault. Requires
//                                 @azure/identity + @azure/keyvault-keys.
//                                 Reads AZURE_KEYVAULT_URI,
//                                 AZURE_KEYVAULT_KEY_NAME, optional
//                                 AZURE_KEYVAULT_KEY_VERSION,
//                                 AZURE_KEYVAULT_WRAP_ALG.
//     KMS_PROVIDER=gcp            GCP KMS. Requires @google-cloud/kms.
//                                 Reads GCP_KMS_KEY (full resource
//                                 name), optional GCP_KMS_KEY_VERSION.
//
// The provider contract is intentionally tiny — three methods, all
// async, all exchanging Buffers. Every provider implements the same
// shape; new ones drop in by adding a case to the switch below.
//
//     generateDataKey()
//       → { plaintextDek: Buffer, wrappedDek: Buffer, kekId: string }
//
//     decrypt(wrappedDek: Buffer, kekId?: string)
//       → Buffer (plaintext DEK)
//
//     id (string)              — provider name, for logs/metrics
//
// Notes:
//   • Plaintext DEKs ALWAYS leave callers' hands as Buffers so the
//     caller can `dek.fill(0)` once it's done. Strings can't be
//     deterministically zeroed in V8.
//   • `decrypt` may receive `kekId` for providers that need it (e.g.
//     local-mode rotation between two CONFIG_SECRETs). Most providers
//     ignore it because the wrapped blob already encodes the key.
//   • All KMS calls go through `audit()` so every Decrypt /
//     GenerateDataKey is captured in the structured log alongside the
//     active OTel trace_id (logger does that automatically). That is
//     the audit trail the design depends on.

import { log } from "../utils/logger.js";

let _provider = null;
let _initPromise = null;

export async function getProvider() {
  if (_provider) return _provider;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const name = (process.env.KMS_PROVIDER || "local").toLowerCase();
    let mod;
    try {
      switch (name) {
        case "local":
          mod = await import("./providers/local.js");
          break;
        case "aws":
          mod = await import("./providers/aws.js");
          break;
        case "vault":
          mod = await import("./providers/vault.js");
          break;
        case "azure":
          mod = await import("./providers/azure.js");
          break;
        case "gcp":
          mod = await import("./providers/gcp.js");
          break;
        default:
          throw new Error(
            `Unknown KMS_PROVIDER: "${name}". ` +
            `Supported: local, aws, vault, azure, gcp.`,
          );
      }
      _provider = await mod.create();
      log.info("kms provider ready", { provider: _provider.id, kek: _provider.kekId || null });
      return _provider;
    } catch (e) {
      _initPromise = null;
      throw e;
    }
  })();
  return _initPromise;
}

/** Generate a fresh DEK and the corresponding wrapped DEK for storage. */
export async function generateDataKey() {
  const p = await getProvider();
  const result = await p.generateDataKey();
  audit("GenerateDataKey", { provider: p.id, kek: result.kekId });
  return result;
}

/** Unwrap a stored wrapped DEK to recover the plaintext DEK. */
export async function decryptDataKey(wrappedDek, kekId) {
  const p = await getProvider();
  const plaintext = await p.decrypt(wrappedDek, kekId);
  audit("Decrypt", { provider: p.id, kek: kekId || p.kekId || null });
  return plaintext;
}

/** Hint for tests/teardown. Real providers might hold AWS clients. */
export async function shutdown() {
  if (_provider?.shutdown) await _provider.shutdown();
  _provider = null;
  _initPromise = null;
}

// Structured audit line for every KMS op. The active OTel span's
// trace_id is automatically attached by the logger, which means the
// "who decrypted this" question can be answered by joining log records
// against the trace tree in Tempo / Grafana.
function audit(op, meta) {
  log.info("kms op", { op, ...meta });
}
