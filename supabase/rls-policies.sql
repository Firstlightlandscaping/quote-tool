-- First Light Quote Tool — Row Level Security policies
-- Security model: static site + public publishable key, so access control lives in the
-- database. Only logged-in (authenticated) users can read/write; anon is fully denied.
--
-- Run order: SANDBOX first (prove with the acceptance test), then LIVE — and only after
-- you've confirmed you can log in to the target project. The dashboard bypasses RLS, so a
-- bad policy can always be undone from there (see the disable snippet at the bottom).

-- ── Enable RLS + an authenticated-only "full access" policy on all 7 tables ──────────
-- No policy for the anon role = anon is denied everything (full lockdown).
do $$
declare t text;
begin
  foreach t in array array['quotes','quote_lines','deliverables','materials','mpl','staff','group_templates']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists fl_authenticated_all on public.%I', t);
    execute format('create policy fl_authenticated_all on public.%I
                    for all to authenticated using (true) with check (true)', t);
  end loop;
end $$;

-- ── Quote-number RPC: allow logged-in users, deny anon ───────────────────────────────
-- next_qt_number runs with the caller's rights (or as definer) — either way an authenticated
-- user can use it (they have full table access via the policy above). Confirm it returns a
-- number after enabling. Wrapped so it's a no-op if the function isn't present in this DB
-- (e.g. a sandbox rebuilt from a data-only backup) — quote numbering then falls back to local.
do $$
begin
  grant execute on function public.next_qt_number() to authenticated;
  revoke execute on function public.next_qt_number() from anon, public;
exception
  when undefined_function then
    raise notice 'next_qt_number() not present here — skipping grant; quote numbering falls back to local.';
end $$;

-- ── Verify (optional) ────────────────────────────────────────────────────────────────
-- select tablename, rowsecurity from pg_tables where schemaname='public' order by tablename;
-- select schemaname, tablename, policyname, roles, cmd from pg_policies where schemaname='public';

-- ── ROLLBACK (run in the dashboard SQL editor if RLS ever locks you out) ──────────────
-- do $$
-- declare t text;
-- begin
--   foreach t in array array['quotes','quote_lines','deliverables','materials','mpl','staff','group_templates']
--   loop
--     execute format('alter table public.%I disable row level security', t);
--   end loop;
-- end $$;
