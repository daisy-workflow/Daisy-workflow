-- audit_logs.resource_id was originally UUID (see 016_audit_logs.sql)
-- because the only writers at the time were engine handlers logging
-- "user.create / graph.update / config.delete" against rows whose ids
-- are UUIDs. That assumption broke as soon as the audit.record plugin
-- shipped: workflow-emitted audit rows reference external-system IDs
-- (order numbers, ticket slugs, business keys) that are NOT UUIDs.
--
-- The auditLog helper has a try/catch that swallows write failures
-- (audit isn't allowed to break a real action), so these rows were
-- silently dropped — the plugin returned recorded:true, the workflow
-- succeeded, but the row never landed. The /audit endpoint then
-- returned zero rows for the test's unique action name, failing the
-- audit-record spec.
--
-- Relax to TEXT. Engine-side callers still pass UUID strings; the
-- column type just stops rejecting non-UUID strings from the plugin.
-- No existing data conversion needed — UUIDs cast cleanly to text.

ALTER TABLE audit_logs
  ALTER COLUMN resource_id TYPE TEXT USING resource_id::text;
