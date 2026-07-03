-- Discount lines: a quote-level discount stored as a quote_lines row flagged
-- is_discount (qty 1, negative unit_price, own VAT — so every totals path nets
-- it in automatically). Same pattern as the is_note column.
-- Run this once in the Supabase SQL editor (sandbox first, then live).

alter table quote_lines add column if not exists is_discount boolean default false;

-- PostgREST caches the schema; without this the app can 400 (PGRST204) on save
-- until the cache reloads on its own.
NOTIFY pgrst, 'reload schema';
