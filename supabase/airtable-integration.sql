-- Airtable CRM integration — Phase 2 plumbing (2026-07-30)
-- Adds the link columns the Airtable sync needs. Additive only, safe to re-run.
--
-- airtable_card_id : Airtable Cards record id this quote/contract belongs to
-- client_email     : email captured from the card at pick time (re-heals links after
--                    the go-live import renumbers every card)
-- status_changed_at: stamped ONLY when quotes.status genuinely changes (not on every
--                    save) — feeds Airtable "Date Sent" etc.
-- supersedes_ref   : the ref this quote REPLACES, captured at duplicate time — the app
--                    previously recorded only that a quote WAS superseded, never by which.
--
-- ⚠ RUN ORDER MATTERS: run this on a database BEFORE deploying an index.html that
-- writes these columns (saveQuote sends them — absent columns = every save 400s).
-- Sandbox: run now. Live: run at the Phase 2 cutover, immediately before the push.

alter table quotes add column if not exists airtable_card_id text;
alter table quotes add column if not exists client_email text;
alter table quotes add column if not exists status_changed_at timestamptz;
alter table quotes add column if not exists supersedes_ref text;

alter table design_contracts add column if not exists airtable_card_id text;
alter table design_contracts add column if not exists client_email text;

-- PostgREST caches the schema — without this the new columns 400 (PGRST204) until reload
notify pgrst, 'reload schema';
