-- HITL (human-in-the-loop) introduced a new terminal state for the
-- executions row: `waiting`. When a node returns the WAITING_MARKER
-- sentinel the executor returns status='waiting'; the worker then
-- writes that back to executions.status so the InstanceViewer can
-- offer Resume / Cancel.
--
-- The original CHECK constraint from 001_init.sql predates HITL and
-- only allowed ('queued','running','success','failed','partial',
-- 'cancelled'). The UPDATE was silently failing with
--   new row for relation "executions" violates check constraint
--   "executions_status_check"
-- which left the execution stuck at 'running' (the rescue path in
-- worker.js then re-rewrote it to 'failed' on the next catch).
--
-- Reapply the same allow-list with 'waiting' added. Constraint name
-- ("executions_status_check") matches the Postgres auto-generated
-- name from the inline CHECK in 001_init.sql, which is what
-- pg_constraint actually contains.

ALTER TABLE executions
  DROP CONSTRAINT IF EXISTS executions_status_check;

ALTER TABLE executions
  ADD CONSTRAINT executions_status_check
  CHECK (status IN ('queued','running','success','failed','partial','cancelled','waiting'));
