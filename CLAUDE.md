\# First Light Landscaping — Quote Tool



\## What This Is

A single-page landscaping quote tool built in HTML/JS with a Supabase backend.

Hosted on GitHub Pages at firstlightlandscaping.github.io/quote-tool

Built and maintained using Claude Code.



\## Tech Stack

\- Single HTML file (index.html) — all UI, JS, CSS in one file

\- Supabase (PostgreSQL) — live database for all data

\- GitHub Pages — static hosting

\- No build process, no framework, vanilla JS



\## Credentials

All stored in .env — never hardcode in source files

\- SUPABASE\_URL

\- SUPABASE\_ANON\_KEY

\- ANTHROPIC\_API\_KEY

\- GITHUB\_TOKEN



\## Supabase Schema

Tables: quotes, quote\_lines, deliverables, materials, mpl, staff, group\_templates



\### quotes

ref, customer, date, addr1, city, post, sign, vno, sum, summaryHtml, saved, status



\### quote\_lines

quote\_ref, line\_id, sort\_order, code, name, xdesc, notes, qty, unitPrice, matCost, 

labDays, labRate, labTotal, vat, optional, misc, unit, groupId, groupMember, 

groupExpanded, miscComponents



\### deliverables

code, name, category, unit, matCostPerUnit, xeroDescription, is\_archived



\### materials

del\_code, idx, stockCode, description, qtyPerUnit, unit, pricePerUnit, trueUnitPrice



\### mpl

code, description, unit, supplier, pricePerUnit, dateUpdated, updatedBy, category



\### staff

name



\### group\_templates

id, name, description



\## Key Architectural Decisions



\### Line Ordering

sort\_order column added to quote\_lines in June 2026. Lines are saved with their 

index position as sort\_order and fetched ordered by sort\_order, line\_id. This 

preserves user-defined line order across save/reload.



\### Group Logic

\- Group headers have groupId set and groupMember unset

\- Group members have groupMember set to the parent groupId

\- Group header unitPrice is ALWAYS derived from sum of members — never independent

\- effectiveAmt(l) recalculates group headers live from members to prevent stale totals

\- When loading saved quotes, group header unitPrices are repaired from members immediately

\- Dragging a group header moves the entire group (header + all members) as one block

\- Members cannot be dragged out of groups, nothing can be dragged into a group

\- Per-group ungroup: each group header has a ↩ Ungroup button (removeGroup) that ungroups only that group; Ungroup all (ungroupAll) still clears every group

\- Delete group: the × on a group header calls deleteGroup() — removes the group AND its line items (with confirm). removeGroup() only ungroups, keeping the items as individual lines

\- Add to existing group: + Add line on the header (showAddToGroupDialog) moves selected ungrouped quote lines in; the Add Line Item panel has an "Add to group" select (refreshAddGroupSelect) that routes a new deliverable straight into a group. Both go through moveLinesToGroup(), which keeps members contiguous after the header and re-derives header unitPrice/labTotal



\### Totals Calculation

\- recalc() uses effectiveAmt() not amt() for group headers

\- visibleLines = lines.filter(l => !l.groupMember) — members excluded, counted via header

\- VAT is per-line, applied individually

\- Group amount column shows ex-VAT like all other lines (fixed June 2026)



\### DOM Performance

\- reorderDomRows() moves existing TR elements instead of calling renderLines() when 

&#x20; reordering — prevents 2-minute reload on large quotes

\- updateDelEdit() patches DOM directly instead of calling renderLines() to avoid 

&#x20; re-render loop when editing labour in the inline edit panel

\- lab-tag has id="lab-tag-{id}" and lab-tag-anchor span for DOM patching

\- patchMiscLineDom() does the same live DOM patching for misc lines (unit price input, amt-cell-{id} amount cell, misc-edit-unitprice-{id} panel field, lab tag) so labour edits update live without collapsing the open misc edit panel



\### Saving and Loading

\- saveQuote() writes sort\_order:idx on every line

\- loadQuote() immediately repairs stale group header unitPrices from members before render

\- sqAmt(l, sqLines) used in renderSaved for accurate group totals in saved quotes list



\## Known Bugs Fixed — Do Not Reintroduce



1\. \*\*Group header unitPrice stale on save/load\*\*

&#x20;  Fixed via effectiveAmt() in recalc() and load-time repair in loadQuote()



2\. \*\*Group amount column showing inc-VAT\*\*

&#x20;  Fixed — now shows ex-VAT (groupTotal not groupTotal\*(1+vat/100))



3\. \*\*Line order not persisting after save\*\*

&#x20;  Fixed via sort\_order column in Supabase (added June 2026, SQL migration done)



4\. \*\*Labour edit not updating totals or showing lab tag\*\*

&#x20;  Fixed — updateDelEdit() now patches DOM directly instead of calling renderLines()

&#x20;  which caused a re-render loop resetting inputs to 0



5\. \*\*Drag reorder causing 2-minute reload\*\*

&#x20;  Fixed — drop handler and mvUp/mvDn now call reorderDomRows() instead of renderLines()



6\. \*\*Deliverable dropdown not alphabetically sorted\*\*

&#x20;  Fixed — quote builder dropdown now sorts by category then code before rendering



7\. \*\*Material search replaced dropdown entirely\*\*

&#x20;  Fixed — search filter input sits above the original dropdown, filters options live,

&#x20;  dropdown remains fully functional as before



8\. \*\*Misc component markup compounding on edit\*\*

&#x20;  editMiscComponent() loaded the charged price into the Supplier cost field and left

&#x20;  the Charged field unset, so each Edit→Update re-applied +10% (e.g. grit sand 100kg

&#x20;  drifted 5.61 → 6.17 → 6.79). Fixed — edit now loads supplierCost into the supplier

&#x20;  field and cost into the charged field, so edits round-trip with no re-markup



9\. \*\*Misc item labour not updating unit price/total live in inline edit\*\*

&#x20;  updateMiscField() recomputed unitPrice for labour but only called recalc() (summary

&#x20;  only) — the line's unit price input, Amount cell and lab tag stayed stale (materials

&#x20;  worked because they call renderLines()). Fixed — updateMiscField() now calls

&#x20;  patchMiscLineDom() to patch the row in place (no re-render, panel stays open),

&#x20;  matching the updateDelEdit() approach used for deliverable lines



10\. \*\*Grouped deliverable labour edit duplicated the lab tag\*\*

&#x20;  Group member rows rendered their lab tag with no id, so updateDelEdit() couldn't

&#x20;  find it and inserted a second tag (old value + new value both shown). Fixed —

&#x20;  member lab tag now has id="lab-tag-{id}" (+ lab-tag-anchor-{id}) so it updates in

&#x20;  place. Also added ids to member qty/unit/amount cells and group header

&#x20;  unit/amount/labmat cells, and extended updateDelEdit() to patch them live so a

&#x20;  grouped deliverable's labour edit updates its own cost and the group total instantly



11\. \*\*Regular deliverable labour edit didn't update the line Amount on the quote\*\*

&#x20;  updateDelEdit() patched the unit price input, lab tag and summary but not the line's

&#x20;  own Amount GBP cell, so the quote line total stayed stale until re-render/save.

&#x20;  Fixed — updateDelEdit() now also patches amt-cell-{id} to qty × unitPrice



\## Features



\### Quote Builder (Tab 1)

\- Add deliverables from searchable dropdown grouped by category

\- Each line has qty, unit price, VAT selector, optional toggle

\- Inline edit panel per line for labour (days x rate) and mat cost override

\- Green lab tag shows labour breakdown, mat tag shows material cost

\- Drag handle (grip icon) on each row for reordering — groups move as whole blocks

\- Arrow buttons (▲▼) for single-step moves

\- Group selected lines into named groups with collapse/expand

\- Ungroup an individual group (↩ Ungroup), delete a group with its items (×), or add existing/new lines into an existing group

\- Group templates for saving/reusing common groups

\- Optional items toggle — shown on quote but excluded from totals

\- Misc items with component breakdown — components can be added from the Master Price List (Option 1: search/filter picker, supplier price + 10% markup, description auto-appended to the client description) or entered manually (Option 2: free-text, supplier price + 10% auto-charged). Both feed the same component list; mat cost is always the sum of components (read-only)

\- Overview bar showing Materials Cost, Labour Total, Materials Profit (markup)

\- Subtotal, VAT, Total GBP summary box



\### Order List (Tab 2)

\- Materials order list based on current quote

\- Quantities scaled by deliverable quantity

\- Print button



\### Price Manager (Tab 3)

\- Deliverables table with search and category filter

\- Edit name, category, unit, mat cost, client description inline

\- Expand button on client description for full-screen modal editor

\- Materials editor per deliverable with search-filtered MPL dropdown

\- Add new deliverable with full form including client description expand button

\- MPL (Master Price List) management

\- New prefix/category creation



\### Saved Quotes (Tab 4)

\- List of all saved quotes with filter, sort, search

\- Summary bar showing total value

\- Open, duplicate, delete quotes

\- Status management (draft, sent, approved etc)



\## Print / PDF

\- Print CSS hides all editing controls, drag handles, checkboxes

\- Branded header with logo, company details, contact info

\- Client letter format with greeting and sign-off

\- Quote table with description, quantity, unit price, VAT, amount

\- Groups show as single header row in print

\- Totals box with subtotal, VAT, Total GBP

\- Disclaimer footer



\## Xero Integration

\- Download for Xero — CSV export of quote lines

\- Copy for Xero — copies to clipboard



\## TeamGantt Integration

\- Export to TeamGantt — CSV export for project scheduling



\## Security Status (as of June 2026)

\- \[ ] RLS policies audited

\- \[ ] GitHub repo made private

\- \[ ] Backup and restore button added

\- \[ ] Password gate added

\- \[ ] Supabase Auth implemented

\- \[ ] Supabase credentials removed from index.html

\- \[ ] Supabase key rotated



\## Deployment

\- Push to main branch on GitHub

\- GitHub Pages auto-deploys within 60 seconds

\- No build step required

\- Test locally with: npx serve .



\## File Structure firstlight-quote-tool/

index.html        — entire application

CLAUDE.md         — this file

.env              — credentials (gitignored)

.gitignore        — ignores .env and node\_modules

README.md         — basic repo description 

\## How to Start a Session

1\. Open PowerShell

2\. cd C:\\Projects\\firstlight-quote-tool

3\. Type: claude

4\. Claude Code reads this file automatically

5\. Describe what you want in plain English

6\. Review changes locally with: npx serve .

7\. Approve and push: git add . \&\& git commit -m "description" \&\& git push origin main



\## Session History Summary



\### June 2026 — Initial Migration to Claude Code

\- Moved from Claude Chat to Claude Code terminal workflow

\- Set up .env, .gitignore, CLAUDE.md

\- All credentials moved out of index.html into .env



\### Bug Fixes Session (June 2026)

\- Fixed group total calculation (stale unitPrice on group headers)

\- Fixed group amount column VAT display inconsistency  

\- Fixed line order persistence (sort\_order column)

\- Fixed labour edit DOM re-render loop

\- Fixed drag reorder performance (reorderDomRows)

\- Fixed deliverable dropdown sort order

\- Fixed material search (restored dropdown with filter above)

\- Added drag and drop reordering with group-aware block movement

\- Added expand button for client description in Price Manager

\- Added search filter for material picker in deliverable editor



\### Group Editing Session (June 2026)

\- Added per-group ↩ Ungroup button (removeGroup) — ungroups one group without affecting others; Ungroup all retained

\- Repurposed the group header × to deleteGroup() — deletes the group AND its line items (with confirm)

\- Added + Add line on group headers (showAddToGroupDialog) to move existing ungrouped lines into a group

\- Added "Add to group" select in the Add Line Item panel to add a new deliverable straight into a group

\- New shared helper moveLinesToGroup() keeps members contiguous after the header and re-derives header totals



\### Misc Item Material Picker Session (June 2026)

\- Added a Master Price List picker to the misc item builder (Option 1) — search/filter, select material, qty, supplier price + 10% markup; description auto-appends as a new line to the client description (appendMiscXdesc, never overwrites)

\- Restored the manual/free-text component form (Option 2) side by side with the picker; both always visible and feed the same component list

\- Made the misc Mat. cost field read-only — always the sum of components (materials + manual)

\- Manual component descriptions now also append to the client description on add

\- Fixed misc component markup compounding on edit (see Known Bugs Fixed #8)



\### Misc Labour Live-Update Fix (June 2026)

\- Fixed misc item labour edits not updating unit price/total live in the inline panel (see Known Bugs Fixed #9)

\- Added patchMiscLineDom() — live DOM patching for misc lines, matching updateDelEdit() for deliverable lines



\### Grouped Deliverable Labour Edit Fix (June 2026)

\- Fixed duplicated lab tag when editing labour on a grouped deliverable (see Known Bugs Fixed #10)

\- Group member rows now have ids (lab-tag, member-qty/unit/amt) and group header cells have ids (group-unit/amt/labmat); updateDelEdit() patches them so a member's labour edit updates its cost and the group total live



\### Regular Deliverable Line Amount Fix (June 2026)

\- Fixed regular (ungrouped) deliverable labour edit not updating the line's Amount GBP cell on the quote (see Known Bugs Fixed #11)

\- updateDelEdit() now patches amt-cell-{id} live alongside the unit price, lab tag and summary total

