-- Airtable CRM Phase 3 (the quote push) — pending markers. Run on SANDBOX first, LIVE at cutover.
-- A record is "pending push" when status_changed_at (quotes) / contract_meta changes are newer
-- than last_pushed_at, or last_pushed_at is null and the record is CRM-relevant. Written by the
-- airtable-sync edge function after a successful push; read by the app's Push-to-CRM panel.
alter table public.quotes           add column if not exists last_pushed_at   timestamptz;
alter table public.quotes           add column if not exists last_push_event  text;
alter table public.design_contracts add column if not exists last_pushed_at   timestamptz;
alter table public.design_contracts add column if not exists last_push_event  text;

-- PostgREST caches the schema — without this the first PATCH 400s with PGRST204 (see CLAUDE.md gotcha).
notify pgrst, 'reload schema';
