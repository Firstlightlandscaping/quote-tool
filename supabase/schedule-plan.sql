-- Schedule plan (gantt feature): the Schedule tab's saved plan for a quote —
-- ordered Project Breakdown tasks + dated supplier deliveries — stored as ONE
-- jsonb blob. The push agent reads this to create the TeamGantt project.
-- Run once in the Supabase SQL editor (sandbox first if testing there).

alter table quotes add column if not exists schedule_plan jsonb;

-- PostgREST caches the schema; without this the app can 400 (PGRST204) on save
-- until the cache reloads on its own.
NOTIFY pgrst, 'reload schema';
