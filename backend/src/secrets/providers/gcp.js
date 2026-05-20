// Google Cloud KMS provider.
//
// Like Azure, GCP KMS doesn't expose a "GenerateDataKey" primitive —
// the recommended pattern is to generate the DEK locally and wrap it
// via the cryptoKey's `encrypt` operation. Decrypt reverses.
//
// Required env vars:
//
//     GCP_KMS_KEY      projects/<project>/locations/<region>/keyRings/<ring>/cryptoKeys/<key>
//                      (full resource name. NOT the bare key id.)
//
// Optional:
//
//     GCP_KMS_KEY_VERSION   pin to a specific version — by default we
//                           talk to the cryptoKey itself which always
//                           encrypts with the primary version
//     GOOGLE_APPLICATION_CREDENTIALS    path to a service-account JSON
//                                       file when not running on GCP
//
// Auth uses Application Default Credentials — service account on GKE /
// Cloud Run / GCE, or GOOGLE_APPLICATION_CREDENTIALS pointing at a
// key file for local prod testing. Configure that via your deployment;
// Daisy doesn't ship its own GCP auth boilerplate.
//
// Required IAM permissions on the key:
//
//     cloudkms.cryptoKeyVersions.useToEncrypt
//     cloudkms.cryptoKeyVersions.useToDecrypt
//
// The "Cloud KMS CryptoKey Encrypter/Decrypter" role covers both.
//
// Additional context:
//
// GCP supports `additionalAuthenticatedData` (AAD) — same role as
// AWS KMS' EncryptionContext. We pin it to `app=daisy-dag` on every
// call so a leaked wrapped DEK can't be replayed against this same
// key from another app sharing the IAM identity.

import crypto from "node:crypto";
import { log } from "../../utils/logger.js";

// AAD bytes — must match exactly between encrypt + decrypt or KMS rejects.
const APP_AAD = Buffer.from("app=daisy-dag", "utf8");

export async function create() {
  const keyName    = process.env.GCP_KMS_KEY;
  const keyVersion = process.env.GCP_KMS_KEY_VERSION || "";
  if (!keyName) {
    throw new Error(
      "KMS_PROVIDER=gcp requires GCP_KMS_KEY (full resource name: " +
      "projects/<p>/locations/<l>/keyRings/<r>/cryptoKeys/<k>)",
    );
  }

  let sdk;
  try {
    sdk = await import("@google-cloud/kms");
  } catch (e) {
    throw new Error(
      "KMS_PROVIDER=gcp requires @google-cloud/kms. " +
      "Install with `npm install @google-cloud/kms`. Original: " + e.message,
    );
  }
  const { KeyManagementServiceClient } = sdk;
  const client = new KeyManagementServiceClient();

  // Decide which resource we name in encrypt/decrypt: the cryptoKey
  // (uses the primary version automatically) or a specific version.
  // Most setups pin the key, not the version, so rotation is opaque.
  const resourceName = keyVersion
    ? `${keyName}/cryptoKeyVersions/${keyVersion}`
    : keyName;

  // Boot-time sanity check via getCryptoKey — confirms the resource
  // exists and the identity can at least see it. Encrypt/Decrypt
  // perms are checked at first real call.
  try {
    await client.getCryptoKey({ name: keyName });
  } catch (e) {
    throw new Error(
      `GCP KMS key "${keyName}" not reachable: ${e.message}. ` +
      `Check GCP_KMS_KEY (full resource name) + IAM permissions.`,
    );
  }
  log.info("[kms:gcp] client ready", { resourceName });

  return {
    id:    "gcp",
    kekId: resourceName,

    async generateDataKey() {
      const dek = crypto.randomBytes(32);
      const [resp] = await client.encrypt({
        name:                         resourceName,
        plaintext:                    dek,
        additionalAuthenticatedData:  APP_AAD,
      });
      return {
        plaintextDek: dek,
        wrappedDek:   Buffer.from(resp.ciphertext),
        // resp.name is the version that was used — handy for audit /
        // rotation diagnostics. Falls back to the cryptoKey name when
        // the API didn't echo a version.
        kekId:        resp.name || resourceName,
      };
    },

    async decrypt(wrappedDek, _kekId) {
      const [resp] = await client.decrypt({
        name:                         keyName,    // decrypt resolves the version from the blob
        ciphertext:                   Buffer.isBuffer(wrappedDek) ? wrappedDek : Buffer.from(wrappedDek),
        additionalAuthenticatedData:  APP_AAD,
      });
      return Buffer.from(resp.plaintext);
    },

    async shutdown() {
      try { await client.close(); } catch { /* sdk version dependent */ }
    },
  };
}
