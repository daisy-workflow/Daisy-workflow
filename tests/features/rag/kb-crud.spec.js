// Feature — Knowledge Base CRUD via the API. The UI surface
// (KnowledgeBasesPage) is a Layer 3 visual concern; here we lock
// the contract.

import { test, expect } from "@playwright/test";
import { login, createKb, listKbs, deleteKb, uniq } from "../../helpers/api.js";

test("KB CRUD — create + list + delete", async () => {
  const { token } = await login();
  const title = uniq("kb");

  // Note: this test uses pgvector + the text-embedding-3-small
  // provider. The migration 026 must have run, and the worker has
  // to expose the OpenAI provider in the embedder registry. The
  // ingest spec (next file) actually exercises the embedder; this
  // one only touches the metadata table.
  const kb = await createKb({ token, title });
  // POST /kbs returns { id } only; verify the title via the list.
  expect(kb.id).toBeTruthy();

  const list = await listKbs({ token });
  const row = (Array.isArray(list) ? list : (list?.knowledgeBases || list?.kbs || []))
                .find(k => k.id === kb.id);
  expect(row).toBeTruthy();
  expect(row.title).toBe(title);

  await deleteKb({ token, id: kb.id });

  const after = await listKbs({ token });
  const stillThere = (Array.isArray(after) ? after : (after?.knowledgeBases || after?.kbs || []))
                       .some(k => k.id === kb.id && !k.deleted_at);
  expect(stillThere).toBe(false);
});
