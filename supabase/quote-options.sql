-- Quote relationships at Send (CRM + Neal, 20/11/26).
--   option_group : quotes that are ALTERNATIVE OPTIONS of one job share this value (the first
--                  option's ref). Null = a standalone quote. The CRM card's Quote Value counts an
--                  option set ONCE, at its highest open option (airtable-sync reads this column).
--   is_extra     : EXTRA WORK on a live job — the quote sits on the job's card but never moves
--                  it, never writes Quote Sent Date / Quote By, and never gets a contract
--                  (its payment goes in through the CRM's Add a payment form).
-- Run on SANDBOX first, then LIVE (before deploying the matching airtable-sync).
alter table quotes add column if not exists option_group text;
alter table quotes add column if not exists is_extra boolean not null default false;
notify pgrst, 'reload schema';
