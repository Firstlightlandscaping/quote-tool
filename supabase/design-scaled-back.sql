-- Scaled-back design contracts (2026-09-30, Neal): the SAME package (e.g. "The Standard
-- Package" — no new package name, nothing new for the CRM to match), offered at a lower fee
-- with a scaled-back service. A tick on the design contract dialog prints:
--   * the package's scaled-back description (design_packages.description_scaled), and
--   * the scaled-back design terms (company_settings.design_terms_scaled — same shape as
--     design_terms, edited in the Contracts tab's terms editor).
-- Both are frozen into the contract's snapshot as usual. Run once, sandbox first, then live.

alter table company_settings add column if not exists design_terms_scaled jsonb;
alter table design_packages   add column if not exists description_scaled text;

-- PostgREST caches the schema; without this the app can 400 (PGRST204) until it reloads.
NOTIFY pgrst, 'reload schema';
