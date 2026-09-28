-- Optional extras (2026-09-28): a priced line that sits OUTSIDE the quote total until it
-- is switched on. The existing `optional` boolean now means "excluded from the total"
-- (it was only a cosmetic badge before — no live or sandbox row had it set). This adds
-- the second state: option_hidden = true prints nothing at all (internal pricing only);
-- false (or null, for old rows) prints the line under the totals as an "Optional extra"
-- with its price. Same pattern as the is_note / is_discount columns.
-- Run once in the Supabase SQL editor (sandbox first, then live).

alter table quote_lines add column if not exists option_hidden boolean default false;

-- PostgREST caches the schema; without this the app can 400 (PGRST204) on save
-- until the cache reloads on its own.
NOTIFY pgrst, 'reload schema';
