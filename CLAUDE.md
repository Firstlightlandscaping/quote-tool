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

### Totals Calculation
- recalc() uses effectiveAmt() not amt() for group headers
- visibleLines = lines.filter(l => !l.groupMember)
- VAT applied per-line
- Group amount column shows ex-VAT like other lines
- Overview bar (Materials Cost / Labour Total / Materials Profit): recalc() skips group headers (members counted individually) AND skips qty=0 lines (`if(!l.qty)return`) — a qty=0 line contributes £0 to the Subtotal (amt=qty×unitPrice), so its stale matCost/labTotal must not leak into the Overview. Note: Overview is a true-cost view; it only equals the Subtotal when every line's unitPrice = matCost + labTotal/qty. Manual unit-price overrides (esp. on misc items) legitimately make Overview ≠ Subtotal.

### DOM Performance
- reorderDomRows() moves existing TR elements instead of renderLines() on reorder (avoids 2-min reload)
- updateDelEdit() patches DOM directly for deliverable labour edits (unit price, lab-tag-{id}/lab-tag-anchor, amt-cell-{id}, plus member/group-header cells for grouped lines) — avoids re-render loop, keeps edit panel open
- patchMiscLineDom() does equivalent live patching for misc lines (unit price input, amt-cell-{id}, misc-edit-unitprice-{id}, lab tag, and mat tag via mat-tag-{id}/mat-tag-anchor-{id})

### Saving and Loading
- saveQuote() writes sort_order:idx on every line
- loadQuote() repairs stale group header unitPrices from members before render
- sqAmt(l, sqLines) used in renderSaved for accurate group totals in saved quotes list

## Features

### Quote Builder (Tab 1)
- Searchable deliverable dropdown grouped by category, alphabetically sorted
- Per-line: qty, unit price, VAT selector, optional toggle
- Inline edit panel for labour (days × rate) and mat cost override; lab tag (green) and mat tag show breakdowns
- Drag handle + arrow buttons for reordering; groups move as blocks
- Group/ungroup/delete groups, group templates, add lines to existing groups
- Misc items: component breakdown from MPL picker (search/filter, supplier price +10% markup, auto-appends description) or manual free-text (also +10%, auto-appends); mat cost = read-only sum of components. The misc builder's mat-cost field (mc-mat) is readonly/auto-from-components — there is NO free-text material cost for new misc items. Legacy misc lines created before that change can have an orphaned matCost>0 with no components; the misc edit panel surfaces an editable "Material cost (£)" field ONLY for that legacy case (no components AND matCost>0) so old values can be cleared/corrected — it does NOT appear for new misc items (matCost=0), preventing new free-text material costs. Editing it (updateMiscField 'matCost') does not change the unit price.
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
