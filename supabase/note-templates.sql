-- Note templates: saved text-note templates for the quote builder.
-- Stored as a jsonb array on company_settings (same pattern as contract_terms):
--   [{ "id": 1719900000000, "heading": "…", "body": "…" }, …]
-- No new table, so the existing company_settings RLS policy already covers it.
-- Run this once in the Supabase SQL editor (sandbox first, then live).

alter table company_settings add column if not exists note_templates jsonb;

-- PostgREST caches the schema; without this the app can 400 (PGRST204) on save
-- until the cache reloads on its own.
NOTIFY pgrst, 'reload schema';
