// Azure Key Vault — Keys provider.
//
// Azure Key Vault doesn't expose a "GenerateDataKey" primitive the
// way AWS KMS does. We generate the DEK locally (crypto.randomBytes,
// FIPS-acceptable when Node is built against an approved OpenSSL) and
// wrap it via the vault key's WRAP_KEY operation. Decrypt does the
// reverse via UNWRAP_KEY.
//
// Required env vars:
//
//     AZURE_KEYVAULT_URI         https://my-vault.vault.azure.net
//     AZURE_KEYVAULT_KEY_NAME    daisy-kek
//
// Optional:
//
//     AZURE_KEYVAULT_KEY_VERSION   (pin to a specific version; default
//                                   is "latest")
//     AZURE_KEYVAULT_WRAP_ALG      RSA-OAEP-256 (default) | RSA-OAEP |
//                                   A128KW | A256KW (last two need an
//                                   HSM-backed AES key)
//
// Auth uses DefaultAzureCredential — picks up service-principal env
// vars (AZURE_TENANT_ID + AZURE_CLIENT_ID + AZURE_CLIENT_SECRET),
// managed identity, az-cli login, or whichever chain step matches.
// You don't configure that explicitly here; align with your hosting
// platform's identity story.
//
// Required RBAC on the key:
//
//     Microsoft.KeyVault/vaults/keys/wrap/action
//     Microsoft.KeyVault/vaults/keys/unwrap/action
//     Microsoft.KeyVault/vaults/keys/read       (boot-time check)
//
// The simplest role that covers all three: "Key Vault Crypto User".

import crypto from "node:crypto";
import { log } from "../../utils/logger.js";

export async function create() {
  const vaultUri = (process.env.AZURE_KEYVAULT_URI || "").replace(/\/$/, "");
  const keyName  = process.env.AZURE_KEYVAULT_KEY_NAME;
  const keyVer   = process.env.AZURE_KEYVAULT_KEY_VERSION || ""; // empty = latest
  const wrapAlg  = process.env.AZURE_KEYVAULT_WRAP_ALG || "RSA-OAEP-256";

  if (!vaultUri) throw new Error("KMS_PROVIDER=azure requires AZURE_KEYVAULT_URI");
  if (!keyName)  throw new Error("KMS_PROVIDER=azure requires AZURE_KEYVAULT_KEY_NAME");

  // Lazy-import the Azure SDKs so dev / local installs don't pull them.
  let identitySdk, keysSdk;
  try {
    identitySdk = await import("@azure/identity");
    keysSdk     = await import("@azure/keyvault-keys");
  } catch (e) {
    throw new Error(
      "KMS_PROVIDER=azure requires @azure/identity + @azure/keyvault-keys. " +
      "Install with `npm install @azure/identity @azure/keyvault-keys`. Original: " + e.message,
    );
  }
  const { DefaultAzureCredential } = identitySdk;
  const { KeyClient, CryptographyClient } = keysSdk;

  const credential = new DefaultAzureCredential();
  const keyClient  = new KeyClient(vaultUri, credential);

  // Resolve the key to a concrete kid (URL with version) so subsequent
  // crypto operations bind to a specific version. Latest at boot time;
  // a manual rotation in Azure shows up on the next service restart.
  let kid;
  try {
    const k = keyVer
      ? await keyClient.getKey(keyName, { version: keyVer })
      : await keyClient.getKey(keyName);
    kid = k.id;
  } catch (e) {
    throw new Error(
      `Azure Key Vault key "${keyName}" not reachable: ${e.message}. ` +
      `Check AZURE_KEYVAULT_URI, identity, and key-vault RBAC.`,
    );
  }

  const crypto4 = new CryptographyClient(kid, credential);
  log.info("[kms:azure] client ready", { vaultUri, kid, wrapAlg });

  return {
    id:    "azure",
    kekId: kid,

    async generateDataKey() {
      // 256-bit AES DEK — same size + algorithm as the other providers.
      const dek = crypto.randomBytes(32);
      const wrapped = await crypto4.wrapKey(wrapAlg, dek);
      return {
        plaintextDek: dek,
        wrappedDek:   Buffer.from(wrapped.result),
        kekId:        kid,
      };
    },

    async decrypt(wrappedDek, _kekId) {
      const ciphertext = Buffer.isBuffer(wrappedDek) ? wrappedDek : Buffer.from(wrappedDek);
      const unwrapped = await crypto4.unwrapKey(wrapAlg, ciphertext);
      return Buffer.from(unwrapped.result);
    },

    async shutdown() {
      // The Azure SDK clients hold no long-lived sockets we need to
      // close manually — credential token caches live in-process and
      // GC-collect on shutdown.
    },
  };
}
