-- Retire the "Garden Design Service — Premium Package" (code GD03) — CRM request, 12/10/26.
--
-- Archived, NOT deleted: design_contracts snapshot each line's name/description/fee at
-- creation, so old contracts that used GD03 still render exactly as signed. The flag only
-- removes it from the package picker when making a NEW design contract (the app filters
-- `!p.is_archived` — the same path as the Contracts tab's Archive button, dpArchive()).
-- Nothing else in the package list changes. Re-runnable. Undo: set is_archived = false.
--
-- Run on SANDBOX first (done 12/10/26), then LIVE after Neal's OK.
-- NB design-contracts.sql still SEEDS GD03 for a fresh database — run this after it there.

update public.design_packages
   set is_archived = true
 where code = 'GD03';

-- Check:
-- select code, name, is_archived from public.design_packages order by sort_order, id;
