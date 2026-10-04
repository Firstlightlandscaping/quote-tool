-- Designer logins (2026-10-02, Neal): designers make their own DESIGN contracts in the app,
-- and see nothing else — no quotes, no Price Manager, no schedules, no RAMS, no settings.
--
-- HOW A LOGIN BECOMES A DESIGNER: its auth "app_metadata" carries  {"fl_role": "designer"}.
-- app_metadata is ADMIN-ONLY (a user can't change their own), unlike user_metadata — never
-- key a permission on user_metadata. Set it from the SQL editor (sandbox first, then live):
--   update auth.users
--      set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb) || '{"fl_role":"designer"}'
--    where email = 'designer@example.com';
-- The role travels inside the login token, so the designer must LOG OUT AND BACK IN after
-- it's set (an existing session keeps its old token until it refreshes).
-- To remove: ... set raw_app_meta_data = raw_app_meta_data - 'fl_role' where email = '...';
--
-- WHAT THIS SCRIPT DOES (re-runnable; sandbox first, then live):
--   1. fl_is_designer() — true when the caller's token says designer.
--   2. Rewrites the staff all-access policy (fl_authenticated_all) on every table so it no
--      longer applies to designers — KEEPING the CRM reader carve-out from
--      crm-reader-policy.sql (both exclusions in one policy; re-running either script alone
--      would drop the other's exclusion, so after this script exists, run THIS one).
--   3. Designer policies — exactly what the Design tab needs, nothing more:
--        design_contracts  read + create + edit + delete  (delete allowed 2026-10-04, Neal —
--                          the app's delete guard still applies: a signed contract's signing
--                          record is kept, a live link is revoked first)
--        design_packages   read only
--        dc_counter        read + update          (next_dc_number() runs as the caller)
--        contract_signing  read + create + edit, DC- refs ONLY (never a quote's signing row)
--      Every other table: no designer policy = nothing visible, nothing writable.
--   4. fl_design_settings() — the ONE narrow door to company_settings. That row also holds
--      the build terms, note templates and the RAMS lists (crew names + emails), and RLS can
--      only allow or refuse a whole ROW, so designers get no policy on it; this function hands
--      back only what a design contract prints or needs: design terms (+ scaled-back), bank
--      details (printed on every contract) and the company signature (the countersignature
--      on a contract sent for e-signature).
--
-- Edge functions enforce the same split (supabase/functions/_shared/caller.ts): designers are
-- refused by push-teamgantt, push-rams-crm and send-rams-links, and airtable-sync accepts DC-
-- refs only from them. airtable-picker (the CRM card list) stays open — designers link
-- contracts to cards.

-- 1 ── who is calling ────────────────────────────────────────────────────────────────────
create or replace function public.fl_is_designer() returns boolean
language sql stable
as $$ select coalesce(auth.jwt() -> 'app_metadata' ->> 'fl_role', '') = 'designer' $$;
revoke execute on function public.fl_is_designer() from public, anon;
grant execute on function public.fl_is_designer() to authenticated;

-- 2 + 3 ── policies ──────────────────────────────────────────────────────────────────────
do $$
declare
  reader_email text := 'crm-reader@firstlightlandscaping.co.uk';   -- keep in step with crm-reader-policy.sql
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
    execute format('drop policy if exists fl_authenticated_all on public.%I', t);
    execute format($p$create policy fl_authenticated_all on public.%I
                    for all to authenticated
                    using ((auth.jwt() ->> 'email') is distinct from %L and not (select public.fl_is_designer()))
                    with check ((auth.jwt() ->> 'email') is distinct from %L and not (select public.fl_is_designer()))$p$,
                   t, reader_email, reader_email);
    -- clear any designer policies from an earlier run before re-creating them below
    execute format('drop policy if exists fl_designer_select on public.%I', t);
    execute format('drop policy if exists fl_designer_insert on public.%I', t);
    execute format('drop policy if exists fl_designer_update on public.%I', t);
    execute format('drop policy if exists fl_designer_delete on public.%I', t);
  end loop;
end $$;

-- design_contracts: read, create, edit (contract_meta, CRM link, push stamps), delete.
create policy fl_designer_select on public.design_contracts for select to authenticated
  using ((select public.fl_is_designer()));
create policy fl_designer_insert on public.design_contracts for insert to authenticated
  with check ((select public.fl_is_designer()));
create policy fl_designer_update on public.design_contracts for update to authenticated
  using ((select public.fl_is_designer())) with check ((select public.fl_is_designer()));
create policy fl_designer_delete on public.design_contracts for delete to authenticated
  using ((select public.fl_is_designer()));

-- design_packages: read only (editing packages stays with staff).
create policy fl_designer_select on public.design_packages for select to authenticated
  using ((select public.fl_is_designer()));

-- dc_counter: next_dc_number() is SECURITY INVOKER — it updates this row as the caller.
create policy fl_designer_select on public.dc_counter for select to authenticated
  using ((select public.fl_is_designer()));
create policy fl_designer_update on public.dc_counter for update to authenticated
  using ((select public.fl_is_designer())) with check ((select public.fl_is_designer()));

-- contract_signing: design contracts' rows only — send, check status, revoke.
create policy fl_designer_select on public.contract_signing for select to authenticated
  using ((select public.fl_is_designer()) and quote_ref like 'DC-%');
create policy fl_designer_insert on public.contract_signing for insert to authenticated
  with check ((select public.fl_is_designer()) and quote_ref like 'DC-%');
create policy fl_designer_update on public.contract_signing for update to authenticated
  using ((select public.fl_is_designer()) and quote_ref like 'DC-%')
  with check ((select public.fl_is_designer()) and quote_ref like 'DC-%');

-- 4 ── the narrow settings door ──────────────────────────────────────────────────────────
-- SECURITY DEFINER = runs with the owner's rights (past RLS), so it must return ONLY the
-- listed fields. Staff can call it too (harmless — they can read the whole row anyway).
create or replace function public.fl_design_settings() returns jsonb
language sql stable security definer set search_path = public
as $$
  select jsonb_build_object(
    'design_terms',        cs.design_terms,
    'design_terms_scaled', cs.design_terms_scaled,
    'bank_name',           cs.bank_name,
    'account_number',      cs.account_number,
    'sort_code',           cs.sort_code,
    'company_signature',   cs.company_signature)
  from public.company_settings cs order by cs.id limit 1
$$;
revoke execute on function public.fl_design_settings() from public, anon;
grant execute on function public.fl_design_settings() to authenticated;

NOTIFY pgrst, 'reload schema';

-- Check:  select tablename, policyname, cmd from pg_policies where schemaname = 'public' order by 1, 2;
