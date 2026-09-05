-- CRM nightly catch-up reader — a READ-ONLY Supabase login for the Airtable CRM (2026-09-05).
--
-- WHY THIS FILE EXISTS: rls-policies.sql grants EVERY authenticated user full read+write on
-- every table (policy fl_authenticated_all: for all ... using(true) with check(true)). So a
-- plain "extra user" is NOT read-only — it could write anything. This script carves the CRM
-- reader out of the all-access policy and gives it SELECT only, on the tables the nightly
-- diff needs. Everything is keyed on the reader's EMAIL claim in the JWT.
--
-- STEPS (Neal, in this order, SANDBOX first then LIVE):
--   1. Supabase dashboard → Authentication → Users → Add user → email as below, strong
--      password, "Auto Confirm User" ticked. (Account creation is Neal's, never Claude's.)
--   2. Run this script in the SQL editor. Re-runnable.
--   3. Prove it: log in as the reader via REST and (a) GET quotes → rows, (b) PATCH a quote →
--      0 rows affected with Prefer: return=representation (a bare 204 is NOT proof — see the
--      qt_counter lesson in CLAUDE.md), (c) GET company_settings → [] (not in the read list).
--   4. Hand the CRM chat the email + password out of band (their environment, never this repo).
--
-- To change the reader's email or table list, edit the two constants and re-run.

do $$
declare
  reader_email text := 'crm-reader@firstlightlandscaping.co.uk';   -- <<< the reader login
  -- Tables the nightly diff may READ. Deliberately NOT company_settings (bank details,
  -- contract terms, crew emails in rams_library) or deliverables/materials/mpl (pricing).
  read_tables text[] := array['quotes', 'quote_lines', 'design_contracts', 'contract_signing', 'rams_docs'];
  -- Every table that carries fl_authenticated_all (mirror rls-policies.sql + later additions).
  all_tables text[] := array['quotes', 'quote_lines', 'deliverables', 'materials', 'mpl', 'staff',
                             'group_templates', 'company_settings', 'qt_counter',
                             'contract_signing', 'design_packages', 'design_contracts', 'dc_counter', 'rams_docs'];
  t text;
begin
  foreach t in array all_tables loop
    if to_regclass('public.' || t) is null then
      raise notice 'skip % (absent on this DB)', t;
      continue;
    end if;
    -- 1. The staff all-access policy no longer applies to the reader.
    execute format('drop policy if exists fl_authenticated_all on public.%I', t);
    execute format($p$create policy fl_authenticated_all on public.%I
                    for all to authenticated
                    using ((auth.jwt() ->> 'email') is distinct from %L)
                    with check ((auth.jwt() ->> 'email') is distinct from %L)$p$, t, reader_email, reader_email);
    -- 2. The reader gets SELECT only, and only on the read list.
    execute format('drop policy if exists fl_crm_reader_select on public.%I', t);
    if t = any(read_tables) then
      execute format($p$create policy fl_crm_reader_select on public.%I
                      for select to authenticated
                      using ((auth.jwt() ->> 'email') = %L)$p$, t, reader_email);
    end if;
  end loop;
end $$;

-- Sanity view of the result:
-- select tablename, policyname, cmd from pg_policies where schemaname = 'public' order by 1, 2;
