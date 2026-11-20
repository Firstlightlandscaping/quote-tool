-- Quote relationships at Send (CRM + Neal, 20/11/26).
--   option_group : quotes that are ALTERNATIVE OPTIONS of one job share this value (the first
--                  option's ref). Null = a standalone quote. The CRM card's Quote Value counts an
--                  option set ONCE, at its highest open option (airtable-sync reads this column).
-- Run on SANDBOX first, then LIVE (before deploying the matching airtable-sync).
alter table quotes add column if not exists option_group text;
-- (is_extra — extra work on a live job — was tried on the sandbox 20/11 and DROPPED the same day:
-- extras are quoted by email and go on the card as a payment row, never as a written quote.)
alter table quotes drop column if exists is_extra;
notify pgrst, 'reload schema';
