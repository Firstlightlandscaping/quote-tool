-- Airtable CRM Phase 3 (the quote push) — pending markers. Run on SANDBOX first, LIVE at cutover.
-- A record is "pending push" when status_changed_at (quotes) / contract_meta changes are newer
-- than last_pushed_at, or last_pushed_at is null and the record is CRM-relevant. Written by the
-- airtable-sync edge function after a successful push; read by the app's Push-to-CRM panel.
alter table public.quotes           add column if not exists last_pushed_at   timestamptz;
alter table public.quotes           add column if not exists last_push_event  text;
alter table public.design_contracts add column if not exists last_pushed_at   timestamptz;
alter table public.design_contracts add column if not exists last_push_event  text;
-- Per-event record {sent: iso, accepted: iso, contract_generated: iso, ...} — the app's
-- "push pending" badge compares each event's source timestamp against its own last push,
-- because one quote can have several pushes outstanding (accepted, then contract, then signed).
alter table public.quotes           add column if not exists crm_pushed       jsonb not null default '{}'::jsonb;
alter table public.design_contracts add column if not exists crm_pushed       jsonb not null default '{}'::jsonb;

-- PostgREST caches the schema — without this the first PATCH 400s with PGRST204 (see CLAUDE.md gotcha).
notify pgrst, 'reload schema';
