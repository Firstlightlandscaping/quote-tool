# First Light Landscaping — Quote Tool

## What This Is
Single-page landscaping quote tool, HTML/JS with Supabase backend. Hosted on GitHub Pages at firstlightlandscaping.github.io/quote-tool. Maintained via Claude Code.

## Tech Stack
- Single HTML file (index.html) — all UI, JS, CSS in one file
- Supabase (PostgreSQL) — live database
- GitHub Pages — static hosting, no build process, vanilla JS

## Credentials
All in .env (gitignored), never hardcoded:
SUPABASE_URL, SUPABASE_ANON_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN

## Supabase Schema
Tables: quotes, quote_lines, deliverables, materials, mpl, staff, group_templates

### quotes
ref, customer, date, addr1, city, post, sign, vno, sum, summaryHtml, saved, status

### quote_lines
quote_ref, line_id, sort_order, code, name, xdesc, notes, qty, unitPrice, matCost, labDays, labRate, labTotal, vat, optional, misc, unit, groupId, groupMember, groupExpanded, miscComponents

### deliverables
code, name, category, unit, matCostPerUnit, xeroDescription, is_archived

### materials
del_code, idx, stockCode, description, qtyPerUnit, unit, pricePerUnit, trueUnitPrice

### mpl
code, description, unit, supplier, pricePerUnit, dateUpdated, updatedBy, category

### staff
name

### group_templates
id, name, description

## Key Architectural Decisions

### Line Ordering
sort_order column on quote_lines (added June 2026). Lines saved with index position as sort_order, fetched ordered by sort_order, line_id — preserves user-defined order across save/reload.

### Group Logic
- Group headers: groupId set, groupMember unset. Members: groupMember = parent groupId
- Group header unitPrice ALWAYS derived from sum of members (never independent) — effectiveAmt(l) recalculates live
- On load, group header unitPrices repaired from members immediately
- Dragging a group header moves the whole block; members can't be dragged out, nothing dragged in
- Per-group ↩ Ungroup (removeGroup) vs Ungroup all (ungroupAll)
- × on group header = deleteGroup() (removes group + items, with confirm); removeGroup() only ungroups
- moveLinesToGroup() handles adding lines to existing groups (via header's + Add line, or "Add to group" select in Add Line Item panel) — keeps members contiguous, re-derives header totals
- Edit panel for group members is type-aware: deliverable members get the reduced inline labour editor (lab-edit-row, updateDelEdit), but MISC members get the FULL "Edit misc item" panel (Description, Client desc, Qty, auto Unit price, Labour, Components) — same as ungrouped misc. The misc panel `<tr>` is built by the shared helper miscEditPanelRow(l) (keyed off l.id so toggleMiscEdit/updateMiscField/patchMiscLineDom work identically grouped or not); renderLines uses it for both the ungrouped misc path and the misc branch of the group-member loop, and the member's ✏️ button calls toggleMiscEdit for misc / toggleLabEdit otherwise. Editing a grouped misc item's VAT via this panel sets that member's vat individually (the header VAT dropdown still mirrors member[0]); VAT is applied per-line in recalc so totals stay correct.

### Totals Calculation
- recalc() uses effectiveAmt() not amt() for group headers
- visibleLines = lines.filter(l => !l.groupMember)
- VAT applied per-line
- Group amount column shows ex-VAT like other lines
- Overview bar (Materials Cost / Labour Total / Materials Profit): recalc() skips group headers (members counted individually) AND skips qty=0 lines (`if(!l.qty)return`) — a qty=0 line contributes £0 to the Subtotal (amt=qty×unitPrice), so its stale matCost/labTotal must not leak into the Overview. Note: Overview is a true-cost view; it only equals the Subtotal when every line's unitPrice = matCost + labTotal/qty. Misc lines always satisfy this (unit price is auto-derived — see Misc items). Manual unit-price overrides on deliverable lines (the row/edit-panel unit-price input is still free-text for non-misc) legitimately make Overview ≠ Subtotal.

### DOM Performance
- reorderDomRows() moves existing TR elements instead of renderLines() on reorder (avoids 2-min reload)
- updateDelEdit() patches DOM directly for deliverable labour edits (unit price, lab-tag-{id}/lab-tag-anchor, amt-cell-{id}, plus member/group-header cells for grouped lines) — avoids re-render loop, keeps edit panel open
- patchMiscLineDom() does equivalent live patching for misc lines (read-only row unit-price input row-unitprice-{id}, amt-cell-{id}, read-only panel field misc-edit-unitprice-{id}, lab tag, and mat tag via mat-tag-{id}/mat-tag-anchor-{id}). For misc lines inside a group it ALSO patches the member display cells (member-qty/unit/amt-{id}) and the group-header cells (group-unit/amt/labmat-{gid}) and re-syncs header.unitPrice — mirroring updateDelEdit's grouped-member handling — so editing a grouped misc item updates group totals live without a re-render
- Print-only qty/unit-price spans (qty-print-{id}, unitprice-print-{id}) are baked into each row at renderLines() time and shown only in the print/PDF view (the editable inputs are no-print). Any live DOM patch that changes qty/unitPrice WITHOUT a full re-render must also patch these spans, or print shows stale values while the builder shows the new ones. Three paths sync them: patchMiscLineDom() (misc), the non-misc branch of upQty() (deliverable row-qty edits), and updateDelEdit() (deliverable edit-panel changes — qty/mat/labour). All recompute unitPrice and must patch the spans.

### Saving and Loading
- saveQuote() writes sort_order:idx on every line
- loadQuote() reconciles misc unit prices (recomputes to components + labour, flags count in load toast), then repairs stale group header unitPrices from members, before render
- sqAmt(l, sqLines) used in renderSaved for accurate group totals in saved quotes list

## Features

### Quote Builder (Tab 1)
- Searchable deliverable dropdown grouped by category, alphabetically sorted
- Per-line: qty, unit price, VAT selector, optional toggle
- Inline edit panel for labour (days × rate) and mat cost override; lab tag (green) and mat tag show breakdowns
- Drag handle + arrow buttons for reordering; groups move as blocks
- Group/ungroup/delete groups, group templates, add lines to existing groups
- Misc items: component breakdown from MPL picker (search/filter, supplier price +10% markup, auto-appends description) or manual free-text (also +10%, auto-appends); mat cost = read-only sum of components. The misc builder's mat-cost field (mc-mat) is readonly/auto-from-components — there is NO free-text material cost for new misc items. Legacy misc lines created before that change can have an orphaned matCost>0 with no components; the misc edit panel surfaces an editable "Material cost (£)" field ONLY for that legacy case (no components AND matCost>0) so old values can be cleared/corrected — it does NOT appear for new misc items (matCost=0), preventing new free-text material costs.
- Misc component provenance & editing: components carry a `fromMpl:true` (+`mplCode`) flag when added via the price-list picker (Option 1) — addMplMaterialToMisc and aclmAddMaterial both set it; manual components (Option 2) have no flag. In the Edit Component modal (showLineCompDialog, edit path only), `costLocked = isEdit && c.fromMpl` makes the Supplier cost field readonly AND the derived Charged field readonly (with a 🔒 price list hint), so a price-list component's cost can't silently drift from the MPL — change it in the Price Manager. Manual components stay fully editable. saveLineComp preserves fromMpl/mplCode on edit by spreading the existing component first. Legacy price-list components added before this flag existed have no fromMpl, so they remain editable.
- Adding components to an existing misc item: the "+ Add" button (addComponentToLine) opens a combined modal with BOTH Option 1 (price-list picker, aclm-* ids/handlers) and Option 2 (manual form, aclc-* ids/handlers) side by side, matching the initial creation UI — not the old manual-only dialog. Each option adds immediately via pushComponentToLine (recomputes matCost from components + unitPrice via miscUnitPrice) and the modal stays open for multiple adds; "Done" closes it. showLineCompDialog is now used ONLY for editing an existing component (compIdx>=0). Note: adding here does NOT append to the line's client description (xdesc), matching the prior +Add behaviour (creation-time Option 1/2 do append).
- Misc qty is a DIVISOR, not a multiplier: a misc item's Total (= components total `matCost` + labour `labDays×labRate`) is FIXED and independent of qty. Qty only controls how that Total is broken down for display — displayed unit price = Total ÷ qty, and the charged Amount stays equal to Total for any qty (e.g. Total £1,400 at qty 4 shows "4 × £350.00" but Amount = £1,400). This replaced the old multiplier model where Amount = qty×unitPrice inflated the total as qty rose. `amt(l)` is unchanged (`qty×unitPrice`) — it collapses to Total because unitPrice is now Total÷qty.
- Misc unit price is AUTO-DERIVED, never typed: unitPrice = (matCost + labDays×labRate) / qty, computed by miscUnitPrice(l) (qty=0 → 0, avoiding divide-by-zero and matching the £0 zero-qty behaviour). Both the row unit-price input and the edit-panel "Unit price (£)" field are readonly (labelled "auto"); deliverable lines keep their editable unit-price input. updateMiscField AND upQty recompute unitPrice on every edit (qty, labDays, labRate, or the legacy matCost field); upQty routes misc through miscUnitPrice + patchMiscLineDom so the row unit price/amount update live. removeLineComponent/saveLineComponent/addMisc all set unitPrice via the same formula; loadQuote reconciles any stored drift on open (so old saved misc lines with qty≠1 self-correct: Total drops to components+labour on reopen).
- Misc materials are NOT scaled by qty: `lineMat(l)` returns matCost for misc (the fixed components total) but matCost×qty for deliverables (whose matCost is per-unit). Used everywhere materials cost is shown/summed — the Mat: tag (row + patchMiscLineDom), the Overview Materials Cost, group-header gMat/groupMat (so grouped misc members count correctly), and the Order List misc header. Deliverable-only paths (updateDelEdit row tag, !gl.misc group-member tag, Order List nonMisc loop) keep matCost×qty.
- Overview bar: Materials Cost, Labour Total, Materials Profit
- Subtotal, VAT, Total GBP

### Order List (Tab 2)
Materials order list from current quote, scaled by deliverable qty, with print button

### Price Manager (Tab 3)
Deliverables table (search/category filter, inline edit, full-screen client description editor), materials editor with MPL search, add new deliverable, MPL management, new prefix/category creation

### Saved Quotes (Tab 4)
List with filter/sort/search, summary bar, open/duplicate/delete, status management

## Print / PDF
Print CSS hides editing controls. Branded header, client letter format, quote table, groups as single header row, totals box, disclaimer footer.

## Integrations
- Xero: CSV export + clipboard copy
- TeamGantt: CSV export for scheduling

## Security Status (as of June 2026) — NOT YET DONE
- [ ] RLS policies audited (audit done: all 7 tables open to anon read/write/delete — needs fixing)
- [ ] GitHub repo made private
- [ ] Backup and restore button added
- [ ] Password gate added
- [ ] Supabase Auth implemented
- [ ] Supabase credentials removed from index.html
- [ ] Supabase key rotated

## Deployment
- Push to main → GitHub Pages auto-deploys (~60s), no build step
- Test locally: npx serve .

## File Structure
firstlight-quote-tool/
  index.html  — entire application
  CLAUDE.md   — this file
  .env        — credentials (gitignored)
  .gitignore
  README.md

## How to Start a Session
1. Open PowerShell
2. cd C:\Projects\firstlight-quote-tool
3. Type: claude
4. Claude Code reads this file automatically
5. Describe what you want
6. Review locally: npx serve .
7. git add . && git commit -m "description" && git push origin main
