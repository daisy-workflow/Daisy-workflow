<!--
  Login page.

  Shape:
    • Email + password fields with Quasar's QInput.
    • Optional "Sign in with SSO" button that appears only when
      /auth/config reports oidcEnabled=true. The SSO button kicks
      off a redirect to /auth/oidc/login, which the backend handles
      in PR 4 (OIDC plug-in). Until that lands the button is hidden.
    • On success: redirect to ?next=… if present, else home.

  Errors are surfaced inline below the form rather than as toasts,
  because login feedback is intrinsic to the screen — the user
  shouldn't have to glance away from the field they were just typing
  into to see that they got the password wrong.
-->

<template>
  <div class="login-page q-pa-md">
    <q-card class="login-card q-mx-auto" flat bordered>
      <q-card-section class="text-center">
        <div class="text-h5">Sign in</div>
        <div class="text-caption text-grey-7 q-mt-xs">
          Daisy Workflow engine
        </div>
      </q-card-section>

      <q-card-section>
        <q-form @submit.prevent="onSubmit" class="q-gutter-md">
          <q-input
            v-model="email"
            label="Email"
            type="email"
            autofocus
            :disable="submitting"
            :rules="[(v) => !!v || 'Email is required']"
            outlined
          />
          <q-input
            v-model="password"
            label="Password"
            :type="showPassword ? 'text' : 'password'"
            :disable="submitting"
            :rules="[(v) => !!v || 'Password is required']"
            outlined
          >
            <template #append>
              <q-icon
                :name="showPassword ? 'visibility_off' : 'visibility'"
                class="cursor-pointer"
                @click="showPassword = !showPassword"
              />
            </template>
          </q-input>

          <q-banner v-if="errorMessage" class="bg-red-1 text-red-9" rounded>
            {{ errorMessage }}
          </q-banner>

          <div class="q-pd-md">
   <q-btn
            type="submit"
            color="primary"
            class="full-width"
            :loading="submitting"
            label="Sign in"
            unelevated
          />
          </div>
       

          <div v-if="oidcEnabled || samlEnabled" class="row items-center q-my-sm">
            <q-separator class="col" />
            <span class="q-px-sm text-caption text-grey-7">or</span>
            <q-separator class="col" />
          </div>
          <q-btn
            v-if="oidcEnabled"
            outline
            class="full-width"
            :label="oidcLabel"
            icon="login"
            @click="onOidcClick"
          />

          <!-- SAML SSO. Per-workspace — the user types their workspace
               slug, we redirect to /auth/saml/login?workspace=<slug>.
               Slug is persisted in localStorage so returning users
               don't have to retype. -->
          <template v-if="samlEnabled">
            <q-input
              v-model="samlWorkspaceSlug"
              dense outlined
              label="Workspace"
              hint="The slug of your workspace (e.g. acme)."
              class="q-mt-sm"
            />
            <q-btn
              outline
              class="full-width q-mt-sm"
              :label="samlLabel"
              icon="business"
              :disable="!samlWorkspaceSlug?.trim()"
              @click="onSamlClick"
            />
          </template>
        </q-form>
      </q-card-section>
    </q-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { auth, loadAuthConfig } from "../stores/auth.js";

const route   = useRoute();
const router  = useRouter();

const email     = ref("");
const password  = ref("");
const showPassword = ref(false);
const submitting   = ref(false);
const errorMessage = ref("");

const oidcEnabled = ref(false);
const oidcLabel   = ref("Sign in with SSO");
const samlEnabled = ref(false);
const samlLabel   = ref("Sign in with SAML");
// Persist the last-used workspace slug so returning SAML users skip
// retyping it. localStorage is per-browser; people switching between
// workspaces from the same browser just edit the field.
const samlWorkspaceSlug = ref(localStorage.getItem("daisy.samlWorkspace") || "");

onMounted(async () => {
  // If the user just came back from the OIDC dance, the backend has
  // already set the refresh cookie. We force a refresh probe here to
  // pull a brand-new access token into memory and bounce home.
  if (route.query.oidc === "done" || route.query.saml === "done") {
    const user = await auth.tryRefresh();
    if (user) {
      const next = typeof route.query.next === "string" && route.query.next.startsWith("/")
        ? route.query.next
        : "/";
      router.replace(next);
      return;
    }
    // Refresh failed — fall through and show the sign-in form so the
    // user can retry. This shouldn't happen in practice (callback just
    // set the cookie a moment ago), but guard anyway.
    errorMessage.value = "SSO sign-in didn't complete cleanly. Try again.";
  }

  // If the user is already signed in (browser tab restore, refresh
  // cookie still good), bounce them straight to where they came from.
  if (auth.isAuthenticated) {
    router.replace(typeof route.query.next === "string" ? route.query.next : "/");
    return;
  }
  const cfg = await loadAuthConfig();
  oidcEnabled.value = !!cfg.oidcEnabled;
  oidcLabel.value   = cfg.oidcLabel || "Sign in with SSO";
  samlEnabled.value = !!cfg.samlEnabled;
  samlLabel.value   = cfg.samlLabel || "Sign in with SAML";
});

async function onSubmit() {
  errorMessage.value = "";
  submitting.value   = true;
  try {
    await auth.login(email.value.trim(), password.value);
    const next = typeof route.query.next === "string" && route.query.next.startsWith("/")
      ? route.query.next
      : "/";
    router.replace(next);
  } catch (e) {
    // The backend always returns a uniform 401 / "invalid credentials"
    // for both wrong-email and wrong-password (anti-enumeration), so
    // we don't need to distinguish the two on the client either.
    const status = e?.response?.status;
    if (status === 401) {
      errorMessage.value = "Invalid email or password.";
    } else if (status === 503) {
      errorMessage.value = "Server is unavailable. Try again in a moment.";
    } else {
      errorMessage.value = e?.response?.data?.message || e.message || "Sign-in failed.";
    }
  } finally {
    submitting.value = false;
  }
}

function onOidcClick() {
  // PR 4 wires the actual OIDC redirect endpoint. For now we just
  // navigate — if the backend doesn't implement it yet the user gets
  // a 404 with a clear-enough URL to file a bug.
  const next = typeof route.query.next === "string" && route.query.next.startsWith("/")
    ? route.query.next
    : "/";
  window.location.href = `/api/auth/oidc/login?next=${encodeURIComponent(next)}`;
}

function onSamlClick() {
  const slug = samlWorkspaceSlug.value.trim().toLowerCase();
  if (!slug) return;
  // Persist for next time so a returning user doesn't retype.
  try { localStorage.setItem("daisy.samlWorkspace", slug); } catch { /* private mode */ }
  const next = typeof route.query.next === "string" && route.query.next.startsWith("/")
    ? route.query.next
    : "/";
  const qs = new URLSearchParams({ workspace: slug, next });
  window.location.href = `/api/auth/saml/login?${qs.toString()}`;
}
</script>

<style scoped>
.login-page {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  
}
.login-card {
  width: 100%;
  max-width: 420px;
}
</style>
