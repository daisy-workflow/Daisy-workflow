<!--
  SAML SSO configuration — per workspace, workspace-admin only.

  Two ways to fill the form:
    1. Paste the IdP's metadata XML and click "Parse" — we extract
       entityID, SSO URL, SLO URL, and the signing certificate. The
       admin reviews + saves.
    2. Fill the fields manually from the IdP's setup page (Okta /
       Entra / AD FS all walk you through producing the four values).

  The "Server-level setup needed" banner shows when the operator
  hasn't set the SP-keypair env vars — without those, no workspace
  can use SAML and the form is read-only.
-->
<template>
  <div class="page q-pa-md sso-page">
    <div class="page-header q-mb-md">
      <div>
        <div class="text-h6">SSO — SAML 2.0</div>
        <div class="text-caption text-grey-7">
          Configure your workspace's identity provider. Users sign in
          via "Sign in with SAML" on the login screen, type your
          workspace slug, and get redirected to your IdP.
        </div>
      </div>
      <q-space />
      <q-btn icon="refresh" flat dense @click="reload" />
    </div>

    <q-banner v-if="loadError" dense class="bg-red-10 text-red-2 q-mb-md">
      <template v-slot:avatar><q-icon name="error_outline" /></template>
      {{ loadError }}
    </q-banner>

    <q-banner v-if="!spReady" class="bg-warning text-black q-mb-md">
      <template v-slot:avatar><q-icon name="warning" /></template>
      <b>Server-level setup needed.</b> Your operator must set
      <code>SAML_SP_ENTITY_ID</code>, <code>SAML_SP_ACS_URL</code>,
      <code>SAML_SP_PRIVATE_KEY</code> and <code>SAML_SP_CERT</code>
      environment variables before any workspace can use SAML SSO.
    </q-banner>

    <q-card flat bordered class="q-mb-md">
      <q-card-section>
        <div class="row items-center">
          <q-toggle
            v-model="form.enabled"
            color="primary"
            label="Enable SAML SSO for this workspace"
            :disable="!spReady"
          />
          <q-space />
          <q-chip
            v-if="form.enabled"
            dense square size="11px" color="positive" text-color="white"
          >active</q-chip>
        </div>
        <div class="text-caption text-grey-7 q-mt-xs">
          Disabling here hides the SSO button but keeps the config — flip back on later without re-entering anything.
        </div>
      </q-card-section>
    </q-card>

    <!-- Step 1: paste IdP metadata XML to auto-fill ────────────── -->
    <q-card flat bordered class="q-mb-md">
      <q-card-section>
        <div class="text-subtitle2 q-mb-xs">Quick import (optional)</div>
        <div class="text-caption text-grey-7 q-mb-sm">
          Paste your IdP's metadata XML and we'll extract the entity
          ID, SSO URL, and signing certificate. You can also fill the
          fields manually below.
        </div>
        <q-input
          v-model="metadataXml"
          type="textarea" autogrow
          dense outlined
          input-style="font-family: ui-monospace, monospace; font-size: 11.5px; max-height: 200px;"
          placeholder="<EntityDescriptor xmlns=...>"
        />
        <div class="row justify-end q-mt-sm">
          <q-btn
            unelevated color="primary" no-caps icon="auto_fix_high" label="Parse"
            :disable="!metadataXml.trim()"
            :loading="importing"
            @click="onImport"
          />
        </div>
        <div v-if="importWarnings.length" class="q-mt-sm">
          <q-chip
            v-for="w in importWarnings" :key="w"
            dense square size="11px" color="warning" text-color="black"
            class="q-mr-xs"
          >{{ w }}</q-chip>
        </div>
      </q-card-section>
    </q-card>

    <!-- Step 2: review the fields ─────────────────────────────── -->
    <q-card flat bordered class="q-mb-md">
      <q-card-section>
        <div class="text-subtitle2 q-mb-md">Identity provider</div>
        <q-input
          v-model="form.idp_entity_id"
          dense outlined
          label="IdP entity ID *"
          hint="Often a URL like https://idp.example.com/idp/shibboleth or http://www.okta.com/exk..."
          class="q-mb-sm"
        />
        <q-input
          v-model="form.idp_sso_url"
          dense outlined
          label="Single sign-on URL *"
          hint="The IdP endpoint Daisy will POST/redirect to for authentication"
          class="q-mb-sm"
        />
        <q-input
          v-model="form.idp_slo_url"
          dense outlined
          label="Single logout URL"
          hint="Optional. When set, Daisy can initiate IdP-side logout."
          class="q-mb-sm"
        />
        <q-input
          v-model="form.idp_cert"
          type="textarea" autogrow
          dense outlined
          label="Signing certificate (PEM) *"
          hint="x509 cert the IdP uses to sign assertions. -----BEGIN CERTIFICATE----- ..."
          input-style="font-family: ui-monospace, monospace; font-size: 11.5px; max-height: 240px;"
        />
      </q-card-section>

      <q-separator />

      <q-card-section>
        <div class="text-subtitle2 q-mb-md">Attribute mapping</div>
        <p class="text-caption text-grey-7 q-mb-md">
          Different IdPs ship attributes under different names. The
          defaults are the most common; override here if your IdP uses
          something else.
        </p>
        <div class="row q-col-gutter-sm">
          <q-input
            v-model="form.attribute_email"
            dense outlined
            label="Email attribute *"
            class="col-12 col-md-4"
          />
          <q-input
            v-model="form.attribute_name"
            dense outlined
            label="Display name attribute"
            class="col-12 col-md-4"
          />
          <q-input
            v-model="form.attribute_groups"
            dense outlined
            label="Groups attribute (optional)"
            hint="Reserved for future group-based RBAC mapping"
            class="col-12 col-md-4"
          />
        </div>
      </q-card-section>

      <q-separator />

      <q-card-section>
        <div class="text-subtitle2 q-mb-md">Provisioning</div>
        <q-toggle
          v-model="form.auto_provision"
          color="primary"
          label="Auto-create users on first SSO sign-in"
        />
        <q-select
          v-model="form.default_role"
          :options="['admin', 'editor', 'viewer']"
          dense outlined
          label="Default role for new users"
          class="q-mt-sm"
          style="max-width: 280px;"
          :disable="!form.auto_provision"
        />
        <div class="text-caption text-grey-7 q-mt-xs">
          With auto-provision off, unknown SSO users get a clear error
          and must be invited manually first.
        </div>
      </q-card-section>
    </q-card>

    <!-- Step 3: hand the IdP admin our SP metadata ─────────────── -->
    <q-card flat bordered class="q-mb-md">
      <q-card-section>
        <div class="text-subtitle2 q-mb-xs">SP metadata for your IdP</div>
        <div class="text-caption text-grey-7 q-mb-sm">
          Share this URL with your IdP admin so they can configure
          their side automatically. It's the standard SAML SP metadata
          XML scoped to this workspace.
        </div>
        <q-input
          :model-value="metadataUrl"
          readonly dense outlined
          input-style="font-family: ui-monospace, monospace;"
        >
          <template v-slot:append>
            <q-btn flat dense size="sm" icon="content_copy" @click="copyMetadataUrl">
              <q-tooltip>Copy URL</q-tooltip>
            </q-btn>
          </template>
        </q-input>
      </q-card-section>
    </q-card>

    <div class="row justify-end q-mb-md">
      <q-btn
        v-if="config"
        flat no-caps icon="delete" label="Remove config"
        color="negative"
        class="q-mr-sm"
        @click="onRemove"
      />
      <q-btn
        unelevated color="primary" no-caps icon="save" label="Save"
        :disable="!canSave"
        :loading="saving"
        @click="onSave"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useQuasar } from "quasar";
import { auth } from "../stores/auth.js";
import { SamlConfig, Workspaces } from "../api/client.js";

const router = useRouter();
const $q = useQuasar();

const loading       = ref(false);
const saving        = ref(false);
const importing     = ref(false);
const loadError     = ref("");
const spReady       = ref(false);
const config        = ref(null);            // server-side row, or null
const metadataXml   = ref("");
const importWarnings = ref([]);
const workspaceSlug = ref("");

const form = reactive({
  enabled:           false,
  idp_entity_id:     "",
  idp_sso_url:       "",
  idp_slo_url:       "",
  idp_cert:          "",
  attribute_email:   "email",
  attribute_name:    "displayName",
  attribute_groups:  "",
  auto_provision:    true,
  default_role:      "editor",
});

const canSave = computed(() =>
  spReady.value
  && form.idp_entity_id?.trim()
  && form.idp_sso_url?.trim()
  && /^https?:\/\//i.test(form.idp_sso_url || "")
  && form.idp_cert?.includes("BEGIN CERTIFICATE"),
);

const metadataUrl = computed(() => {
  if (!workspaceSlug.value) return "";
  return `${location.origin}/api/auth/saml/metadata?workspace=${encodeURIComponent(workspaceSlug.value)}`;
});

async function reload() {
  loading.value = true;
  loadError.value = "";
  try {
    const data = await SamlConfig.get();
    spReady.value = !!data.spReady;
    if (data.config) {
      config.value = data.config;
      Object.assign(form, data.config);
      // Normalise nullable fields onto the form's defaults.
      form.idp_slo_url      = data.config.idp_slo_url      || "";
      form.attribute_groups = data.config.attribute_groups || "";
    }
    // Pull the workspace's slug for the metadata URL.
    const w = await Workspaces.get(auth.user.workspaceId);
    workspaceSlug.value = w.slug;
  } catch (e) {
    if (e?.response?.status === 404) {
      // No config yet — first-time setup. Not an error.
      spReady.value = e?.response?.data?.spReady ?? false;
    } else {
      loadError.value = e?.response?.data?.message || e.message || "load failed";
    }
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  if (auth.user?.role !== "admin" && !auth.isWorkspaceAdmin) {
    router.replace({ name: "home" });
    return;
  }
  await reload();
});

async function onImport() {
  importing.value = true;
  importWarnings.value = [];
  try {
    const parsed = await SamlConfig.importMetadata(metadataXml.value);
    if (parsed.idp_entity_id) form.idp_entity_id = parsed.idp_entity_id;
    if (parsed.idp_sso_url)   form.idp_sso_url   = parsed.idp_sso_url;
    if (parsed.idp_slo_url)   form.idp_slo_url   = parsed.idp_slo_url;
    if (parsed.idp_cert)      form.idp_cert      = parsed.idp_cert;
    importWarnings.value = parsed.warnings || [];
    $q.notify({
      type: "positive",
      message: "Metadata parsed — review the fields and Save.",
      timeout: 1500, position: "bottom",
    });
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  } finally {
    importing.value = false;
  }
}

async function onSave() {
  saving.value = true;
  try {
    await SamlConfig.put({
      enabled:           form.enabled,
      idp_entity_id:     form.idp_entity_id?.trim(),
      idp_sso_url:       form.idp_sso_url?.trim(),
      idp_slo_url:       form.idp_slo_url?.trim() || null,
      idp_cert:          form.idp_cert,
      attribute_email:   form.attribute_email?.trim() || "email",
      attribute_name:    form.attribute_name?.trim() || "displayName",
      attribute_groups:  form.attribute_groups?.trim() || null,
      auto_provision:    form.auto_provision,
      default_role:      form.default_role,
    });
    $q.notify({ type: "positive", message: "Saved", timeout: 1200, position: "bottom" });
    await reload();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
  } finally {
    saving.value = false;
  }
}

async function onRemove() {
  $q.dialog({
    title: "Remove SAML config?",
    message: "All fields will be cleared and SSO will stop working for this workspace. Users will need to use local sign-in or another SSO method.",
    persistent: true,
    ok:     { label: "Remove", color: "negative", unelevated: true, "no-caps": true },
    cancel: { label: "Cancel", flat: true, "no-caps": true },
  }).onOk(async () => {
    try {
      await SamlConfig.remove();
      Object.assign(form, {
        enabled: false, idp_entity_id: "", idp_sso_url: "",
        idp_slo_url: "", idp_cert: "",
        attribute_email: "email", attribute_name: "displayName",
        attribute_groups: "", auto_provision: true, default_role: "editor",
      });
      config.value = null;
      $q.notify({ type: "positive", message: "Removed", timeout: 1200, position: "bottom" });
    } catch (e) {
      $q.notify({ type: "negative", message: e?.response?.data?.message || e.message, position: "bottom" });
    }
  });
}

async function copyMetadataUrl() {
  try {
    await navigator.clipboard.writeText(metadataUrl.value);
    $q.notify({ type: "positive", message: "Copied", timeout: 1200, position: "bottom" });
  } catch (e) {
    $q.notify({ type: "negative", message: `Copy failed: ${e.message}`, position: "bottom" });
  }
}
</script>

<style scoped>
.page-header {
  display: flex;
  align-items: flex-end;
  gap: 12px;
}
</style>
