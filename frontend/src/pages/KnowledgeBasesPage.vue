<!--
  Knowledge Bases (RAG) — project-scoped vector store admin.

  Layout: single page that flips between "list" and "detail" modes.
    • List mode  — q-table of KBs in the active project.
    • Detail mode — when a KB is selected, the page swaps in a panel
                    with documents (upload / url / paste-text),
                    a test-retrieval search box, and back-to-list.

  All ingest paths go through the backend's POST /kbs/:id/documents/*
  endpoints. The page never holds onto file bytes — it streams the
  multipart up and shows the resulting kb_documents row.
-->
<template>
  <div class="page q-pa-md kb-page">
    <!-- ─── List mode ─────────────────────────────────────────── -->
    <template v-if="!selected">
      <div class="page-header q-mb-md">
        <div>
          <div class="text-h6">Knowledge Bases</div>
          <div class="text-caption text-grey-7">
            Project-scoped RAG. Upload docs, fetch URLs, or ingest text
            from a workflow; query with the <code>rag.retrieve</code> plugin
            or test below.
          </div>
        </div>
        <q-space />
        <q-btn
          color="primary" unelevated no-caps icon="add" label="New KB"
          @click="openCreate"
        />
      </div>

      <q-banner v-if="loadError" dense class="bg-red-10 text-red-2 q-mb-md">
        <template v-slot:avatar><q-icon name="error_outline" /></template>
        {{ loadError }}
      </q-banner>

      <q-table
        :rows="rows"
        :columns="columns"
        row-key="id"
        flat dense bordered
        :loading="loading"
        :pagination="{ rowsPerPage: 50, sortBy: 'title', descending: false }"
      >
        <template v-slot:top-right>
          <q-btn icon="refresh" flat dense size="sm" @click="reload" />
        </template>

        <template v-slot:body-cell-title="props">
          <q-td :props="props">
            <span class="text-primary cursor-pointer" @click="select(props.row)">
              {{ props.row.title }}
            </span>
            <div v-if="props.row.description" class="text-caption text-grey-7">
              {{ props.row.description }}
            </div>
          </q-td>
        </template>

        <template v-slot:body-cell-model="props">
          <q-td :props="props">
            <q-chip dense square size="11px" color="grey-3" text-color="grey-9">
              {{ props.row.embedding_provider }} / {{ props.row.embedding_model }}
            </q-chip>
            <q-chip
              v-if="props.row.kb_backend && props.row.kb_backend !== 'pgvector'"
              dense square size="11px" color="indigo-1" text-color="indigo-10"
              class="q-ml-xs"
              :title="props.row.kb_backend_collection || ''"
            >
              {{ props.row.kb_backend }}
            </q-chip>
          </q-td>
        </template>

        <template v-slot:body-cell-counts="props">
          <q-td :props="props" auto-width>
            <span class="text-grey-7">{{ props.row.document_count }} docs · {{ props.row.chunk_count }} chunks</span>
          </q-td>
        </template>

        <template v-slot:body-cell-actions="props">
          <q-td :props="props" auto-width>
            <q-btn flat dense size="sm" icon="open_in_new" @click="select(props.row)">
              <q-tooltip>Open</q-tooltip>
            </q-btn>
            <q-btn flat dense size="sm" icon="delete" color="negative" @click="onDelete(props.row)">
              <q-tooltip>Delete</q-tooltip>
            </q-btn>
          </q-td>
        </template>

        <template v-slot:no-data>
          <div class="full-width text-center q-pa-md text-grey-7">
            No knowledge bases yet. Click <b>New KB</b> to create one.
          </div>
        </template>
      </q-table>
    </template>

    <!-- ─── Detail mode ───────────────────────────────────────── -->
    <template v-else>
      <div class="page-header q-mb-md">
        <q-btn flat dense icon="arrow_back" no-caps label="All KBs" @click="selected = null" />
        <q-space />
        <div class="column items-end">
          <div class="text-h6">{{ selected.title }}</div>
          <div class="text-caption text-grey-7">
            {{ selected.embedding_provider }} / {{ selected.embedding_model }} · {{ selected.dimension }} dim
            · chunk {{ selected.chunk_size }}/{{ selected.chunk_overlap }}
            <span v-if="selected.kb_backend && selected.kb_backend !== 'pgvector'">
              · backend: <code>{{ selected.kb_backend }}</code>
              <span v-if="selected.kb_backend_collection">
                / <code>{{ selected.kb_backend_collection }}</code>
              </span>
            </span>
          </div>
        </div>
      </div>

      <div class="row q-col-gutter-md">
        <!-- Left: documents -->
        <div class="col-12 col-md-7">
          <q-card flat bordered>
            <q-toolbar class="app-toolbar">
              <q-icon name="description" class="q-mr-sm" />
              <q-toolbar-title>Documents</q-toolbar-title>
              <q-space/>
              <q-btn flat dense icon="refresh" @click="reloadDocs" />
            </q-toolbar>
            <q-separator />
            <q-card-section v-if="docsLoading" class="text-center text-grey-7">
              <q-spinner-dots size="sm" />
            </q-card-section>
            <q-list v-else separator>
              <q-item v-for="d in docs" :key="d.id">
                <q-item-section avatar>
                  <q-icon :name="docIcon(d.source_type)" />
                </q-item-section>
                <q-item-section>
                  <q-item-label>{{ d.title }}</q-item-label>
                  <q-item-label caption>
                    <q-chip dense square size="10px" :color="statusColor(d.status)" text-color="white" class="q-mr-xs">
                      {{ d.status }}
                    </q-chip>
                    {{ d.chunk_count }} chunks · {{ formatBytes(d.byte_size) }} · {{ relativeTime(d.created_at) }}
                  </q-item-label>
                  <q-item-label v-if="d.error" caption class="text-negative">
                    {{ d.error }}
                  </q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-btn flat dense size="sm" icon="delete" color="negative" @click="onDeleteDoc(d)">
                    <q-tooltip>Delete document</q-tooltip>
                  </q-btn>
                </q-item-section>
              </q-item>
              <q-item v-if="!docs.length">
                <q-item-section class="text-grey-7 text-center">
                  No documents yet. Add one below.
                </q-item-section>
              </q-item>
            </q-list>
          </q-card>

          <!-- Add document -->
          <q-card flat bordered class="q-mt-md">
            <q-toolbar class="app-toolbar">
              <q-icon name="add" class="q-mr-sm" />
              <q-toolbar-title>Add a document</q-toolbar-title>
            </q-toolbar>
            <q-separator />
            <q-tabs v-model="addTab" dense  align="left" >
              <q-tab name="upload"  no-caps label="Upload file" icon="upload_file" />
              <q-tab name="url"     no-caps label="Fetch URL"   icon="link" />
              <q-tab name="text"    no-caps label="Paste text"  icon="edit_note" />
            </q-tabs>
            <q-separator />
            <q-card-section>
              <template v-if="addTab === 'upload'">
                <q-file
                  v-model="uploadFile"
                  outlined dense
                  label="Pick a file (txt, md, html, pdf, docx, csv, json)"
                  :accept="UPLOAD_ACCEPT"
                  class="q-mb-sm"
                  :max-file-size="MAX_UPLOAD_BYTES"
                />
                <q-input
                  v-model="uploadTitle"
                  outlined dense label="Title (optional)"
                  class="q-mb-sm"
                />
                <q-btn
                  unelevated color="primary" no-caps icon="cloud_upload"
                  label="Upload + ingest"
                  :disable="!uploadFile" :loading="ingesting"
                  @click="onUpload"
                />
              </template>
              <template v-else-if="addTab === 'url'">
                <q-input
                  v-model="urlForm.url"
                  outlined dense label="URL" hint="https://…"
                  class="q-mb-sm"
                />
                <q-input
                  v-model="urlForm.title"
                  outlined dense label="Title (optional)"
                  class="q-mb-sm"
                />
                <q-btn
                  unelevated color="primary" no-caps icon="cloud_download"
                  label="Fetch + ingest"
                  :disable="!urlForm.url" :loading="ingesting"
                  @click="onUrl"
                />
              </template>
              <template v-else>
                <q-input
                  v-model="textForm.title"
                  outlined dense label="Title"
                  class="q-mb-sm"
                />
                <q-input
                  v-model="textForm.text"
                  outlined type="textarea" autogrow
                  label="Text" :input-style="{ minHeight: '120px' }"
                  class="q-mb-sm"
                />
                <q-btn
                  unelevated color="primary" no-caps icon="save"
                  label="Ingest"
                  :disable="!textForm.text || !textForm.title" :loading="ingesting"
                  @click="onText"
                />
              </template>
            </q-card-section>
          </q-card>
        </div>

        <!-- Right: test retrieval -->
        <div class="col-12 col-md-5">
          <q-card flat bordered>
            <q-toolbar class="app-toolbar">
              <q-icon name="search" class="q-mr-sm" />
              <q-toolbar-title>Test retrieval</q-toolbar-title>
            </q-toolbar>
            <q-separator />
            <q-card-section>
              <q-input
                v-model="queryForm.query"
                outlined dense type="textarea" autogrow
                label="Query"
                class="q-mb-sm"
                @keydown.ctrl.enter.prevent="onQuery"
                @keydown.meta.enter.prevent="onQuery"
              />
              <div class="row q-col-gutter-sm q-mb-sm">
                <div class="col">
                  <q-input
                    v-model.number="queryForm.topK"
                    outlined dense type="number" label="Top K"
                    :min="1" :max="50"
                  />
                </div>
                <div class="col">
                  <q-input
                    v-model.number="queryForm.minScore"
                    outlined dense type="number" label="Min score"
                    step="0.05" :min="0" :max="1"
                  />
                </div>
              </div>
              <q-btn
                unelevated color="primary" no-caps icon="search"
                label="Search" :loading="querying"
                :disable="!queryForm.query"
                @click="onQuery"
              />
              <q-banner v-if="queryError" dense class="bg-red-10 text-red-2 q-mt-sm">
                {{ queryError }}
              </q-banner>
            </q-card-section>
            <q-separator v-if="queryResults.length" />
            <q-list separator v-if="queryResults.length">
              <q-item v-for="(m, i) in queryResults" :key="m.id">
                <q-item-section>
                  <q-item-label caption>
                    #{{ i + 1 }} · score
                    <span :class="scoreClass(m.score)">{{ m.score.toFixed(3) }}</span>
                    · doc <code>{{ m.document_id.slice(0, 8) }}</code> · chunk {{ m.ordinal }}
                  </q-item-label>
                  <q-item-label class="kb-chunk">{{ m.content }}</q-item-label>
                </q-item-section>
              </q-item>
            </q-list>
          </q-card>
        </div>
      </div>
    </template>

    <!-- ─── Create dialog ──────────────────────────────────────── -->
    <q-dialog v-model="createOpen" persistent>
      <q-card style="min-width: 460px; max-width: 92vw;">
        <q-toolbar class="app-toolbar">
          <q-icon name="add" class="q-mr-sm" />
          <q-toolbar-title>New knowledge base</q-toolbar-title>
          <q-btn flat round dense icon="close" v-close-popup />
        </q-toolbar>
        <q-separator />
        <q-card-section>
          <q-input
            v-model="form.title"
            label="Title" outlined dense
            class="q-mb-sm"
          />
          <q-input
            v-model="form.description"
            label="Description (optional)"
            type="textarea" autogrow outlined dense
            class="q-mb-sm"
          />
          <q-select
            v-model="form.embeddingProvider"
            :options="providerOptions"
            label="Embedding provider"
            outlined dense emit-value map-options
            class="q-mb-sm"
            @update:model-value="onProviderChange"
          />
          <q-select
            v-model="form.embeddingModel"
            :options="modelOptions"
            label="Embedding model"
            outlined dense emit-value map-options
            class="q-mb-sm"
          />
          <q-select
            v-model="form.embeddingConfigId"
            :options="configOptions"
            label="Credentials config (optional)"
            outlined dense emit-value map-options clearable
            hint="Picks the api key + base URL. Falls back to env var if blank."
            class="q-mb-sm"
          />

          <q-separator class="q-my-md" />
          <div class="text-caption text-grey-7 q-mb-xs">Vector backend</div>
          <q-select
            v-model="form.kbBackend"
            :options="backendOptions"
            label="Backend"
            outlined dense emit-value map-options
            class="q-mb-sm"
            hint="pgvector reuses your Postgres. Qdrant talks to an external Qdrant server."
          />
          <template v-if="form.kbBackend === 'qdrant'">
            <q-select
              v-model="form.kbBackendConfigId"
              :options="qdrantConfigOptions"
              label="Qdrant connection (vector.qdrant config)"
              outlined dense emit-value map-options
              class="q-mb-sm"
              hint="Pick the config carrying Qdrant's URL + api key. Create one in Configs first if missing."
            />
            <q-input
              v-model="form.kbBackendCollection"
              label="Collection name (optional)"
              outlined dense
              class="q-mb-sm"
              hint="Defaults to `daisy_kb_<id>` so KBs don't collide. The collection is created if it doesn't exist."
            />
          </template>

          <q-separator class="q-my-md" />
          <div class="text-caption text-grey-7 q-mb-xs">Chunking</div>
          <div class="row q-col-gutter-sm">
            <div class="col">
              <q-input
                v-model.number="form.chunkSize"
                label="Chunk size (chars)" type="number"
                outlined dense :min="100" :max="4000"
              />
            </div>
            <div class="col">
              <q-input
                v-model.number="form.chunkOverlap"
                label="Chunk overlap" type="number"
                outlined dense :min="0" :max="1000"
              />
            </div>
          </div>
        </q-card-section>
        <q-card-actions align="right" class="q-pa-md">
          <q-btn flat label="Cancel" no-caps v-close-popup />
          <q-btn
            unelevated color="primary" no-caps label="Create"
            :loading="saving" :disable="!form.title || !form.embeddingProvider || !form.embeddingModel"
            @click="onCreate"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from "vue";
import { useQuasar } from "quasar";
import { KnowledgeBases, Configs } from "../api/client.js";

const $q = useQuasar();

const UPLOAD_ACCEPT  = ".txt,.md,.markdown,.html,.htm,.csv,.json,.pdf,.docx";
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

// ─── list state ─────────────────────────────
const rows      = ref([]);
const loading   = ref(false);
const loadError = ref("");
const selected  = ref(null);

const columns = [
  { name: "title",  label: "Title", field: "title", align: "left", sortable: true },
  { name: "model",  label: "Embedder", field: "embedding_provider", align: "left" },
  { name: "counts", label: "Contents", field: "document_count", align: "left" },
  { name: "actions", label: "",   field: "id", align: "right" },
];

async function reload() {
  loading.value = true; loadError.value = "";
  try {
    rows.value = await KnowledgeBases.list();
  } catch (e) {
    loadError.value = e?.response?.data?.message || e.message;
  } finally {
    loading.value = false;
  }
}

// ─── create dialog ──────────────────────────
const createOpen = ref(false);
const saving     = ref(false);
const embedders  = ref([]);
const backends   = ref([]);
const configs    = ref([]);

const form = ref({
  title: "", description: "",
  embeddingProvider: "openai", embeddingModel: "text-embedding-3-small",
  embeddingConfigId: null,
  // Backend selection. Defaults to pgvector for parity with the
  // original Phase B behaviour — anyone who only wants Postgres
  // doesn't see Qdrant prompts unless they switch.
  kbBackend: "pgvector",
  kbBackendConfigId: null,
  kbBackendCollection: "",
  chunkSize: 800, chunkOverlap: 100,
});

const providerOptions = computed(() =>
  embedders.value.map(e => ({ label: e.name, value: e.name }))
);
const modelOptions = computed(() => {
  const e = embedders.value.find(x => x.name === form.value.embeddingProvider);
  return (e?.models || []).map(m => ({ label: `${m.id} (${m.nativeDim}d)`, value: m.id }));
});
const backendOptions = computed(() =>
  backends.value.map(b => ({ label: b.name, value: b.name }))
);
// We accept any ai.provider config — the user picks the row whose
// apiKey matches the chosen embedding provider. Mismatches are
// rejected by the embedder at first call rather than enforced in the UI
// because some users proxy multiple providers through one endpoint.
const configOptions = computed(() =>
  configs.value
    .filter(c => c.type === "ai.provider")
    .map(c => ({ label: c.name, value: c.id }))
);
// Vector backend configs are typed per-backend (vector.qdrant for
// Qdrant). Filtering by type guarantees the user can't accidentally
// pick an `ai.provider` row for a Qdrant connection.
const qdrantConfigOptions = computed(() =>
  configs.value
    .filter(c => c.type === "vector.qdrant")
    .map(c => ({ label: c.name, value: c.id }))
);

function onProviderChange(p) {
  const e = embedders.value.find(x => x.name === p);
  form.value.embeddingModel = e?.models?.[0]?.id || "";
}

async function openCreate() {
  createOpen.value = true;
  try {
    [embedders.value, backends.value, configs.value] = await Promise.all([
      KnowledgeBases.embedders(),
      KnowledgeBases.backends(),
      Configs.list(),
    ]);
  } catch (e) {
    $q.notify({ type: "negative", message: `load: ${e.message}` });
  }
}

async function onCreate() {
  // Pre-flight: Qdrant needs a config attached. Catching it here
  // gives a friendlier message than the backend's ValidationError.
  if (form.value.kbBackend !== "pgvector" && !form.value.kbBackendConfigId) {
    $q.notify({
      type: "warning",
      message: `Pick a ${form.value.kbBackend} connection config — or create one under Configs first.`,
    });
    return;
  }
  saving.value = true;
  try {
    await KnowledgeBases.create(form.value);
    createOpen.value = false;
    form.value = {
      title: "", description: "",
      embeddingProvider: "openai", embeddingModel: "text-embedding-3-small",
      embeddingConfigId: null,
      kbBackend: "pgvector", kbBackendConfigId: null, kbBackendCollection: "",
      chunkSize: 800, chunkOverlap: 100,
    };
    await reload();
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally {
    saving.value = false;
  }
}

async function onDelete(row) {
  $q.dialog({
    title: "Delete knowledge base?",
    message: `“${row.title}” will be hidden. Stored chunks are kept until the purge sweeper runs.`,
    ok: { label: "Delete", color: "negative", noCaps: true },
    cancel: { label: "Cancel", flat: true, noCaps: true },
    persistent: true,
  }).onOk(async () => {
    try {
      await KnowledgeBases.remove(row.id);
      await reload();
    } catch (e) {
      $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
    }
  });
}

// ─── detail mode ────────────────────────────
const docs        = ref([]);
const docsLoading = ref(false);

async function select(kb) {
  selected.value = kb;
  await reloadDocs();
}

async function reloadDocs() {
  if (!selected.value) return;
  docsLoading.value = true;
  try {
    docs.value = await KnowledgeBases.documents(selected.value.id);
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally {
    docsLoading.value = false;
  }
}

// Add-document forms
const addTab      = ref("upload");
const ingesting   = ref(false);
const uploadFile  = ref(null);
const uploadTitle = ref("");
const urlForm     = ref({ url: "", title: "" });
const textForm    = ref({ title: "", text: "" });

async function onUpload() {
  if (!uploadFile.value) return;
  ingesting.value = true;
  try {
    await KnowledgeBases.uploadDocument(selected.value.id, uploadFile.value, uploadTitle.value);
    uploadFile.value = null; uploadTitle.value = "";
    await Promise.all([reloadDocs(), refreshSelectedKb()]);
    $q.notify({ type: "positive", message: "Document ingested" });
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally { ingesting.value = false; }
}

async function onUrl() {
  ingesting.value = true;
  try {
    await KnowledgeBases.fetchUrl(selected.value.id, urlForm.value);
    urlForm.value = { url: "", title: "" };
    await Promise.all([reloadDocs(), refreshSelectedKb()]);
    $q.notify({ type: "positive", message: "URL ingested" });
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally { ingesting.value = false; }
}

async function onText() {
  ingesting.value = true;
  try {
    await KnowledgeBases.addText(selected.value.id, textForm.value);
    textForm.value = { title: "", text: "" };
    await Promise.all([reloadDocs(), refreshSelectedKb()]);
    $q.notify({ type: "positive", message: "Text ingested" });
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  } finally { ingesting.value = false; }
}

async function onDeleteDoc(d) {
  try {
    await KnowledgeBases.deleteDocument(selected.value.id, d.id);
    await Promise.all([reloadDocs(), refreshSelectedKb()]);
  } catch (e) {
    $q.notify({ type: "negative", message: e?.response?.data?.message || e.message });
  }
}

// Refresh the in-memory `selected` row's counters after an ingest so
// the header chunk-count stays current without a full list reload.
async function refreshSelectedKb() {
  try {
    const fresh = await KnowledgeBases.get(selected.value.id);
    if (selected.value) {
      selected.value.document_count = fresh.document_count;
      selected.value.chunk_count    = fresh.chunk_count;
    }
  } catch { /* non-fatal */ }
}

// Test query
const queryForm    = ref({ query: "", topK: 5, minScore: 0 });
const queryResults = ref([]);
const querying     = ref(false);
const queryError   = ref("");

async function onQuery() {
  if (!queryForm.value.query) return;
  querying.value = true; queryError.value = ""; queryResults.value = [];
  try {
    const r = await KnowledgeBases.query(selected.value.id, queryForm.value);
    queryResults.value = r.matches || [];
    if (!queryResults.value.length) {
      queryError.value = "No matches above the minimum score.";
    }
  } catch (e) {
    queryError.value = e?.response?.data?.message || e.message;
  } finally { querying.value = false; }
}

// ─── small UI helpers ───────────────────────
function statusColor(s) {
  return { ready: "positive", failed: "negative", processing: "info", pending: "grey-6" }[s] || "grey-6";
}
function docIcon(t) {
  return { upload: "upload_file", url: "link", plugin: "extension", text: "edit_note" }[t] || "description";
}
function scoreClass(s) {
  if (s >= 0.7) return "text-positive text-weight-medium";
  if (s >= 0.4) return "text-orange-9";
  return "text-grey-7";
}
function formatBytes(b) {
  if (b == null) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b/1024).toFixed(1)} KB`;
  return `${(b/1024/1024).toFixed(1)} MB`;
}
function relativeTime(ts) {
  if (!ts) return "";
  const sec = (Date.now() - new Date(ts).getTime()) / 1000;
  if (sec < 60)   return `${sec | 0}s ago`;
  if (sec < 3600) return `${(sec/60)|0}m ago`;
  if (sec < 86400) return `${(sec/3600)|0}h ago`;
  return `${(sec/86400)|0}d ago`;
}

onMounted(reload);
</script>

<style scoped>
.kb-page .page-header { display: flex; align-items: center; }
.kb-chunk {
  white-space: pre-wrap;
  font-size: 12px;
  line-height: 1.45;
  max-height: 280px;
  overflow: auto;
  background: #fafafa;
  border-radius: 4px;
  padding: 8px;
  margin-top: 4px;
}
.app-toolbar { min-height: 36px; }
</style>
