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
quote_ref, line_id, sort_order, code, name, xdesc, notes, qty, unitPrice, matCost, labDays, labRate, labTotal, vat, optional, misc, unit, groupId, groupMember, groupExpanded, miscComponents, is_note

Note: `is_note` (boolean, added June 2026) flags text-only note lines — see Text note lines below. Saved as `is_note`, loaded back to the line object's `note` flag.

### deliverables
code, name, category, unit, matCostPerUnit, xeroDescription, is_archived

### materials
del_code, idx, stockCode, description, qtyPerUnit, unit, pricePerUnit, trueUnitPrice

### mpl
code, description, unit, supplier, supplier_url, pricePerUnit, dateUpdated, updatedBy, category

Note: `supplier_url` (text, added June 2026) holds an optional supplier/product-page URL for materials ordered online. Saved as `supplier_url`, loaded to the JS field `supplierUrl`. Surfaced in the Price Manager Materials editor as a no-print "Link" column — clickable 🔗 (opens in a new tab) + ✎ edit when set, or "+ link" when empty. Edited via editMplUrl() (prompts, auto-prepends https://, which also neutralises javascript: input). Wired through every mpl save path (saveMPLEdits, bulk seed, archiveMPL, restoreMPL, new material) and both load mappings.

### staff
name

### group_templates
id, name, description

## Key Architectural Decisions

### Line Ordering
sort_order column on quote_lines (added June 2026). Lines saved with index position as sort_order, fetched ordered by sort_order, line_id — preserves user-defined order across save/reload.

### Text note lines
A third line type (alongside deliverable and misc) flagged `note:true` — a text-only block with no price, with an OPTIONAL bold heading + body. Added via the "📝 Add text note" button in the lines toolbar (addTextNote()), which opens a dialog (`new-note-dialog`) with an optional Heading input + a Note text textarea; saveNewNote() validates at least one is filled, then pushLine()s a note line (name=heading, xdesc=body, qty/unitPrice/matCost/labour/vat all 0). Nothing lands on the quote until Save. Editing an EXISTING note is done inline on its row. Two text fields: the optional bold heading lives in `name` (printed via `.l-name`, bold) and the body lives in `xdesc` (printed via `.l-xdesc`). Both are independent and each prints only when non-empty — so a note can be plain text (no heading) or headed like a deliverable. The builder row (note branch in renderLines, rendered BEFORE the group/misc/normal branches with an early return) shows a 📝 amber banner + an optional-heading `<input id="note-head-${id}">` bound to upNoteHead + a multi-line body `<textarea id="xdesc-input-${id}">` bound to upXdesc (same id as other lines so openXdescModal/saveXdescModal edit the body unchanged) + ⤢ expand. Live print sync: upNoteHead patches `note-head-print-${id}` (the `.l-name` div) and toggles its display; upXdesc is note-aware (early branch) and patches `note-body-print-${id}` (the `.l-xdesc` div) + toggles display — NOT the deliverable name/xdesc create-remove logic. IMPORTANT: the note row must use the SAME 8-cell structure as a normal deliverable row — 3 no-print control cells + 1 description cell + 4 trailing `<td class="r"></td>` price cells left empty — NOT a `colspan` cell. A colspan cell lays out differently from the 8-cell rows in print (the table has a header/body column-count quirk: thead has 2 no-print th, tbody rows have 3 no-print td), which shifted the note text out of alignment with the description column. With the matching 8-cell structure the note's heading/body align exactly like a deliverable name/description; the 4 empty price cells print blank. The print-only div `xd-print-${id}` holds the `.l-name` heading (hidden when name blank) + `.l-xdesc` body (hidden when xdesc blank), `style="text-align:left"` to override the right-align on `.lt td .print-only`. The optional heading round-trips via the existing `name` column (no extra schema). Notes are EXCLUDED from: recalc subtotal/VAT/Overview (`!l.note` filter; also auto-skipped by Overview's `if(!l.qty)return`), Order List (miscLines/nonMisc filters), TeamGantt tasks (`!l.misc&&!l.note`), and group membership (no checkbox in the row; showAddToGroupDialog candidates filter `!l.note`). Notes ARE INCLUDED in Xero export as description-only lines (downloadXeroCSV emits blank qty/unitAmount/account/tax; copyXero emits text only), with the description combining heading + body as `[name, xdesc].filter(Boolean).join(' — ')` — amt(l)=0 so they don't affect Xero subtotal/VAT. Persisted via `is_note` column (saveQuote `is_note:!!l.note`, loadFromSupabase `note:l.is_note||false`). Backward compatible: old lines have no note flag → falsy → normal priced lines.

### Group Logic
- Group headers: groupId set, groupMember unset. Members: groupMember = parent groupId
- Group header unitPrice ALWAYS derived from sum of members (never independent) — effectiveAmt(l) recalculates live
- On load, group header unitPrices repaired from members immediately
- Dragging a group header moves the whole block; members can't be dragged out, nothing dragged in
- Per-group ↩ Ungroup (removeGroup) vs Ungroup all (ungroupAll)
- × on group header = deleteGroup() (removes group + items, with confirm); removeGroup() only ungroups
- moveLinesToGroup() handles adding lines to existing groups (via header's + Add line, or "Add to group" select in Add Line Item panel) — keeps members contiguous, re-derives header totals
- Group header client description has a ↗-style ⤢ expand button on the builder row (next to the inline xdesc input), opening the same full-screen openXdescModal used by misc/deliverable rows. For this to sync live, the group header row's inline input carries `id="xdesc-input-${l.id}"` and its print-only div carries `id="xd-print-${l.id}"` (keyed off the header line's id, which is what openXdescModal/saveXdescModal/upXdesc use) — so saveXdescModal patches the inline input and upXdesc patches the print/PDF view without a re-render. Both the Edit-group modal's Client description textarea (`ge-desc`) AND the create-group modal's one (`gd-desc`) have a ⤢ Expand button, but those modals aren't tied to a line, so they use a GENERIC helper: openTextareaXdescModal(textareaId, title) / saveTextareaXdescModal() copy text to/from any textarea by id (the id is stored on the expand panel's `data-target-ta`). The expand panel's z-index is 10000 so it sits above the host modal (group-edit-dialog / group-dialog are 9999); on Save it writes back to the target textarea and the host modal's own Save (saveGroupHeaderEdit / confirmGroup) persists it. Both textareas are `rows="7"` with `resize:vertical` so most descriptions are editable inline without the expand modal. ge-desc content is HTML-escaped on render (matching the generic modal) to avoid a `</textarea>` in the description breaking the field; gd-desc starts empty so needs no escaping.
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
- patchMiscLineDom() does equivalent live patching for misc lines (read-only row unit-price input row-unitprice-{id}, amt-cell-{id}, read-only panel field misc-edit-unitprice-{id}, lab tag, and mat tag via mat-tag-{id}/mat-tag-anchor-{id}). It ALSO syncs the client description (xdesc) — the inline row input xdesc-input-{id} and the print-only div xd-print-{id} (mirrors upXdesc's print-div handling) — because the misc edit panel's Client description textarea routes through updateMiscField → patchMiscLineDom, NOT upXdesc (which only fires from the inline input / expand modal); without this, editing the description in the panel set l.xdesc but the builder row and print/PDF kept showing the old text. The reverse direction is also handled: saveXdescModal() (expand-modal save) patches upXdesc (print div) + the inline input xdesc-input-{id} AND the misc edit panel's Client description textarea misc-edit-xdesc-{id} if that panel is open — so all three views (panel textarea, expand modal, print/PDF) stay in sync however the description is edited. For misc lines inside a group it ALSO patches the member display cells (member-qty/unit/amt-{id}) and the group-header cells (group-unit/amt/labmat-{gid}) and re-syncs header.unitPrice — mirroring updateDelEdit's grouped-member handling — so editing a grouped misc item updates group totals live without a re-render
- Print-only qty/unit-price spans (qty-print-{id}, unitprice-print-{id}) are baked into each row at renderLines() time and shown only in the print/PDF view (the editable inputs are no-print). Any live DOM patch that changes qty/unitPrice WITHOUT a full re-render must also patch these spans, or print shows stale values while the builder shows the new ones. Three paths sync them: patchMiscLineDom() (misc), the non-misc branch of upQty() (deliverable row-qty edits), and updateDelEdit() (deliverable edit-panel changes — qty/mat/labour). All recompute unitPrice and must patch the spans.

### Saving and Loading
- saveQuote() writes sort_order:idx on every line
- saveQuote() calls syncH() right after assigning a freshly-generated ref (the `if(!currentRef)` block) so the new quote number renders into the `qh-ref` header span (visible in the builder AND print/PDF) immediately — without it the number stayed `—` until the quote was reloaded from Saved Quotes (loadQuote already syncs). Only the auto-assign path needs it; an existing ref is already synced from load/prior save.
- loadQuote() reconciles misc unit prices (recomputes to components + labour, flags count in load toast), then repairs stale group header unitPrices from members, before render
- sqAmt(l, sqLines) used in renderSaved for accurate group totals in saved quotes list

## Features

### Quote Builder (Tab 1)
- Searchable deliverable dropdown grouped by category, alphabetically sorted
- Add Line Item panel: the Mat. cost field label shows the selected deliverable's unit as `(per <unit>)` — e.g. `(per m²)`, `(per 2.5 lin m)` — pulled from `selDel.unit` in updateAddMatDisplay() (`add-mat-unit-lbl` span). It's an internal pricing-basis hint so the builder knows what one unit covers without opening the Price Manager. Always visible: stays shown at qty ≥ 2 (next to the `n × £x = £y` breakdown) and while the mat-cost override is active; falls back to `(per unit)` when the deliverable has no unit set, and blanks only when no deliverable is selected. Internal only — the deliverable `unit` is NOT printed on the client quote (it also surfaces in the PM Unit column and the Order List qty line). No schema change; reuses the existing `unit` field.
- Per-line: qty, unit price, VAT selector, optional toggle
- Inline edit panel for labour (days × rate) and mat cost override; lab tag (green) and mat tag show breakdowns
- Drag handle + arrow buttons for reordering; groups move as blocks
- Group/ungroup/delete groups, group templates, add lines to existing groups
- Misc items: component breakdown from MPL picker (search/filter, supplier price +10% markup, auto-appends description) or manual free-text (also +10%, auto-appends); mat cost = read-only sum of components. The misc builder's mat-cost field (mc-mat) is readonly/auto-from-components — there is NO free-text material cost for new misc items. Legacy misc lines created before that change can have an orphaned matCost>0 with no components; the misc edit panel surfaces an editable "Material cost (£)" field ONLY for that legacy case (no components AND matCost>0) so old values can be cleared/corrected — it does NOT appear for new misc items (matCost=0), preventing new free-text material costs.
- Misc component provenance & editing: components carry a `fromMpl:true` (+`mplCode`) flag when added via the price-list picker (Option 1) — addMplMaterialToMisc and aclmAddMaterial both set it; manual components (Option 2) have no flag. In the Edit Component modal (showLineCompDialog, edit path only), `costLocked = isEdit && c.fromMpl` makes the Supplier cost field readonly (with a 🔒 price list hint), so a price-list component's cost can't silently drift from the MPL — change it in the Price Manager. The Charged (£) +10% field (`lcd-charged`) is now ALWAYS readonly and auto-derived (supplier cost × 1.10) regardless of provenance — there is no longer a `lcdUpdateCost()` reverse-edit path; the user only edits Supplier cost (for manual components), whose `oninput="lcdUpdateCharged()"` keeps Charged in sync. This prevents markup drift from hand-typed charged prices. So for manual components only the Supplier cost is editable; for price-list components both are locked. The Charged field always uses the green read-only style (`background:#F0FDF4;color:#15803D;font-weight:600;opacity:.7;cursor:default`). (`lcdUpdateCost` is now dead but harmless.) saveLineComp preserves fromMpl/mplCode on edit by spreading the existing component first. Legacy price-list components added before this flag existed have no fromMpl, so they remain editable. The SAME Edit Component modal is used for components on the unsaved "Add Misc Item" builder panel: showLineCompDialog/saveLineComp accept a `'builder'` sentinel for lineId (instead of a numeric line id) that targets the global `miscComponents` array rather than a saved line's, refreshing the builder via renderMiscComponents()+updateMiscTotal() instead of renderLines()+recalc(). editMiscComponent(idx) (the builder's per-component Edit button) just calls showLineCompDialog('builder', idx) — it no longer populates the inline Option 2 form, so price-list components in the builder get the same locked-supplier-cost treatment as saved ones. (The inline Option 2 form / saveMiscComponent is now add-only; its `editingCompIdx >= 0` edit branch is dead but harmless.) On that inline Option 2 form the Charged (£) +10% field (`mcc-charged`) is also readonly/auto-derived (supplier cost × 1.10 via `mcc-cost`'s `oninput="updateMccCharged()"`), same green read-only style — so all three manual-entry paths (`mcc-charged` builder form, `aclc-charged` Add Component modal, `lcd-charged` Edit Component modal) lock Charged and only accept Supplier cost. (`updateMccCost` is now dead but harmless.) On SAVED lines, saveLineComp's edit path (compIdx>=0) must NOT call renderLines() — that re-render collapses the open "Edit misc item" panel back to the quote builder, which is disruptive when editing components in sequence. Instead it patches the components list in place: it sets l.miscComponents[compIdx], recomputes matCost + unitPrice, removes the modal, then rewrites only `line-comps-edit-${id}`.innerHTML via the shared miscEditComponentsHtml(l) helper (extracted from miscEditPanelRow so both render the identical component-list markup), calls patchMiscLineDom(l) to sync the row unit price/amount/mat tag/group totals, and recalc(). The panel stays open until the user clicks "Done". Falls back to renderLines() only if the panel isn't in the DOM (edge case). The legacy add path (compIdx<0, unused for saved lines now) still renderLines()es.
- Adding components to an existing misc item: the "+ Add" button (addComponentToLine) opens a combined modal with BOTH Option 1 (price-list picker, aclm-* ids/handlers) and Option 2 (manual form, aclc-* ids/handlers) side by side, matching the initial creation UI — not the old manual-only dialog. Each option adds immediately via pushComponentToLine (recomputes matCost from components + unitPrice via miscUnitPrice) and the modal stays open for multiple adds; "Done" closes it. The Option 2 manual Charged (£) +10% field (`aclc-charged`) is readonly and auto-derived (supplier cost × 1.10, via `aclc-cost`'s `oninput="aclcUpdateCharged()"`) — same green read-only style as the locked price-list charged field — so the user only enters Supplier cost and markup can't drift. (`aclcUpdateCost` is now dead but harmless.) showLineCompDialog is now used ONLY for editing an existing component (compIdx>=0). Note: adding here does NOT append to the line's client description (xdesc), matching the prior +Add behaviour (creation-time Option 1/2 do append).
- Misc qty is a DIVISOR, not a multiplier: a misc item's Total (= components total `matCost` + labour `labDays×labRate`) is FIXED and independent of qty. Qty only controls how that Total is broken down for display — displayed unit price = Total ÷ qty, and the charged Amount stays equal to Total for any qty (e.g. Total £1,400 at qty 4 shows "4 × £350.00" but Amount = £1,400). This replaced the old multiplier model where Amount = qty×unitPrice inflated the total as qty rose. `amt(l)` is unchanged (`qty×unitPrice`) — it collapses to Total because unitPrice is now Total÷qty.
- Misc unit price is AUTO-DERIVED, never typed: unitPrice = (matCost + labDays×labRate) / qty, computed by miscUnitPrice(l) (qty=0 → 0, avoiding divide-by-zero and matching the £0 zero-qty behaviour). Both the row unit-price input and the edit-panel "Unit price (£)" field are readonly (labelled "auto"); deliverable lines keep their editable unit-price input. updateMiscField AND upQty recompute unitPrice on every edit (qty, labDays, labRate, or the legacy matCost field); upQty routes misc through miscUnitPrice + patchMiscLineDom so the row unit price/amount update live. removeLineComponent/saveLineComponent/addMisc all set unitPrice via the same formula; loadQuote reconciles any stored drift on open (so old saved misc lines with qty≠1 self-correct: Total drops to components+labour on reopen).
- Misc materials are NOT scaled by qty: `lineMat(l)` returns matCost for misc (the fixed components total) but matCost×qty for deliverables (whose matCost is per-unit). Used everywhere materials cost is shown/summed — the Mat: tag (row + patchMiscLineDom), the Overview Materials Cost, group-header gMat/groupMat (so grouped misc members count correctly), and the Order List misc header. Deliverable-only paths (updateDelEdit row tag, !gl.misc group-member tag, Order List nonMisc loop) keep matCost×qty.
- Overview bar: Materials Cost, Labour Total, Materials Profit
- Subtotal, VAT, Total GBP

### Order List (Tab 2)
Materials order list from current quote, scaled by deliverable qty, with print button

### Price Manager (Tab 3)
Deliverables table (search/category filter, inline edit, full-screen client description editor), materials editor with MPL search and per-material supplier link (URL), add new deliverable, MPL management, new prefix/category creation. A second "+ New Material" button sits beside "+ New Deliverable" in the Deliverables header (top of the tab) as a no-scroll shortcut — both it and the one in the Materials section call showAddMatForm() (which focuses nm-desc, so the page scrolls down to the form).

A **Data Backup** card sits at the BOTTOM of the tab (deliberately out of the way). Its `⬇ Download Backup` button calls backupAllData() — a READ-ONLY export of all 7 tables (quotes, quote_lines, deliverables, materials, mpl, staff, group_templates) into one timestamped `firstlight-backup-YYYYMMDD-HHMMSS.json` (downloaded to the user's machine). fetchAllRows() pages in 1000-row chunks so large tables can't silently truncate (no table exceeds 1000 yet; materials is closest at ~964). The file records `app`/`version`/`exportedAt`/`source` (which DB it came from) + per-table `counts` + `tables`. `firstlight-backup-*.json` is gitignored so backups (full of customer + pricing data) never land in the public repo. This is Phase 1 of the Backup/Restore security item.

A **Data Restore** card sits directly below the backup card (also bottom of Price Manager) — Phase 2, BUILT and proven on the sandbox. A file picker (restoreFilePicked) parses a `firstlight-backup-*.json` into `_restoreBackup`; restoreDryRun() reports per-table counts and writes nothing; restoreRun() writes rows back in 500-row chunks in RESTORE_ORDER (parents first: deliverables, mpl, staff, group_templates, quotes, materials, quote_lines). Two modes: **Merge** (upsert via `?on_conflict=<pk>` + merge-duplicates — RESTORE_CONFLICT: quotes.ref, deliverables.code, mpl.code, the rest on `id`) and **Wipe & replace** (DELETE all per table via `?<pk>=not.is.null`, then plain insert) which is gated behind a typed `WIPE` confirm AND auto-downloads a safety backup first. A no-print **"Connected to:"** line (updateRestoreTarget) shows the current `SUPABASE_URL` and turns RED **⚠ LIVE** when it equals `_DEFAULT_URL`, so you can't restore into live unawares. **CAVEAT (important):** Merge upserts on the PK, so for `id`-keyed tables (esp. materials) it DUPLICATES when the target already holds the same data under different ids. That happens because loadFromSupabase, on finding an EMPTY deliverables table, calls initSupabase() to auto-seed the 253 hardcoded `DELIVERABLES` + their 847 materials — so a freshly-connected "empty" DB isn't actually empty. **Use Wipe & replace for disaster recovery**; Merge is only clean when keys line up. 6-point round-trip proof (backup live → restore sandbox → counts match → relationships intact → app renders → wipe+restore) PASSED 2026-06-20.

### Saved Quotes (Tab 4)
List with filter/sort/search, summary bar, open/duplicate/delete, status management

## Print / PDF
Print CSS hides editing controls. Branded header, client letter format, quote table, groups as single header row, totals box, disclaimer footer.
- Client descriptions (.l-xdesc) use `white-space:pre-line` so newlines typed in the edit panel / expand modal render as line breaks in the print/PDF view (HTML would otherwise collapse them to spaces). One CSS rule covers misc lines, deliverable lines, and group headers — all print descriptions share the .l-xdesc class. The editable-row wrappers also carry .l-xdesc but contain an `<input>`/`<button>` (no text nodes), so pre-line is a no-op there.

## Integrations
- Xero: CSV export + clipboard copy
- TeamGantt: CSV export for scheduling

## Security Status (as of June 2026) — NOT YET DONE
- [~] RLS policies — fix SQL (supabase/rls-policies.sql) RUN + PROVEN on SANDBOX 2026-06-22 (anon read→`[]`, anon write→401). NOT yet on LIVE.
- [ ] GitHub repo made private
- [x] Backup AND restore buttons added — BOTH done & proven. Backup: Data Backup card → backupAllData() (all 7 tables → firstlight-backup-*.json, 1000-row paging, gitignored, verified vs live). Restore: Data Restore card → restoreRun() (Merge/upsert or Wipe&replace, dry-run, auto-backup-before-wipe, red ⚠ LIVE guard). 6-point sandbox round-trip proof PASSED 2026-06-20. See Price Manager (Tab 3) above for the merge-vs-wipe caveat.
- [~] Supabase Auth + login gate (app side) — BUILT + FULLY PROVEN ON SANDBOX 2026-06-23 (email+password; gates the whole app; sb() sends the user token; session persistence + auto-refresh; Log out). In-app round-trip (driven via browser): login → all data loads (253 dels/311 mpl/13 quotes) → authenticated write accepted while anon write stays 401 → reload stays logged in → logout clears session + gate. Only the LIVE cutover remains. Supersedes the old "password gate" idea — a real auth gate, not cosmetic.
- [ ] Supabase credentials removed from index.html
- [ ] Supabase key rotated

### Security remediation — agreed order (as of 2026-06-20)
1. **Backup (Phase 1)** — DONE.
2. **Sandbox** (2nd throwaway Supabase project) — IN PROGRESS.
3. **Restore (Phase 2)** — build + prove on the sandbox before ever trusting it against live.
4. **RLS + Supabase Auth** — app code BUILT & locally verified; RLS RUN + anon-lockdown PROVEN on sandbox (2026-06-22). NEXT: create sandbox user → in-app login test → live cutover. See "Step 4 — working state" below.
5. **Rotate the anon key** — only AFTER RLS is locked (rotating before is pointless; the new key is just as public).
6. **Make the GitHub repo private.**

**Key architectural truth (don't forget):** this is a static site + Supabase, so the anon key ALWAYS ships to the browser — it's public by design. Security comes from **RLS + Auth, not from hiding the key**. A client-side password gate is cosmetic (it doesn't stop a direct API call with the anon key), and "remove creds from index.html" can't make the key secret — both items mostly dissolve once RLS+Auth are done. Restore protects against **data loss**; an RLS **lockout** is recovered separately via Supabase dashboard owner access (which bypasses RLS).

### Step 4 (RLS + Auth) — working state (2026-06-23)
**App code DONE + FULLY PROVEN ON SANDBOX (login round-trip incl. authed read/write, persistence, logout). Only the LIVE cutover remains.** Decisions: email+password (accounts created in the Supabase dashboard, no public signup); anon = full lockdown.

**Built in index.html (all client-side, no build step):**
- `SESSION` (persisted in localStorage `fl_session`) + auth helpers: `authSignIn` (POST `/auth/v1/token?grant_type=password`), `authRefresh` (`grant_type=refresh_token`), `ensureFreshToken` (refresh if <60s to expiry), `authSignOut` (POST `/auth/v1/logout` + clear), `setSession`/`clearSession`.
- `sb()` now sends the logged-in user's access token as `Bearer` (the `apikey` header stays the publishable key); on a 401 with a session it does ONE silent refresh + retry, else shows the gate. Every caller (load, save, backup, restore) inherits this — no other call sites changed.
- `#login-gate` full-screen overlay (branded email+password card) with a red **⚠ LIVE** target indicator (`updateLoginTarget`, mirrors `updateRestoreTarget`). Boot path gates the app: valid session → load as before; else show gate and load NO data. Logged-in email + Log out button in the conn bar (`auth-status` / `updateAuthStatus`). Switching DBs (`saveSetup`) and disconnect (`clearLocalCache`) call `clearSession()` so a token can't leak across databases. The Setup panel floats ABOVE the gate (`showSetup` sets fixed + z-index 20001) and the gate carries a "⚙ Connect to a different database" link, so you can switch DB even while locked out.
- Local verification (npx serve, default LIVE url, no session): no JS errors; gate shows; LIVE flagged red; **no network to live pre-login** (loadFromSupabase is gated); empty-field validation + the setSession→updateAuthStatus→hideLoginGate→clearSession cycle all pass.

**RLS APPLIED + PROVEN on the SANDBOX (2026-06-22):** ran `supabase/rls-policies.sql` (RLS on + `authenticated`-only `for all using(true) with check(true)` on all 7 tables; no anon policy = denied; the next_qt_number grant/revoke is wrapped to no-op if absent — it IS absent on the sandbox, NOTICE shown, harmless). `rowsecurity=true` confirmed on all 7 tables. Proof via raw anon REST call (sandbox anon key only, no login): BEFORE → quotes returned real customers; AFTER → quotes `[]` + deliverables `[]` (HTTP 200, zero rows), INSERT → HTTP 401 `42501 new row violates row-level security policy`. File has a dashboard rollback (disable-RLS) snippet.

**SANDBOX FULLY PROVEN (2026-06-23)** — in-app round-trip driven via the preview browser with a sandbox user (info@…): login OK; reads loaded all data (253 dels/311 mpl/13 quotes; all 7 tables read ok); authenticated write accepted by RLS (no-op PATCH on CP006) vs anon write 401; session persists across reload; logout clears session + returns the gate. Sandbox quirks seen (NOT bugs): `next_qt_number` absent → local numbering fallback; the `id`-keyed tables' identity sequences weren't advanced after restore, so an auto-id INSERT collides (23505) — to test inserts on sandbox, pass explicit ids or wipe+reseed. Found + fixed one real bug: `authSignOut` now also calls `updateAuthStatus()` (the conn-bar email/Log out label wasn't clearing on logout).

**RESUME HERE = LIVE CUTOVER (the only step left):**
1. Fresh **live backup** (Data Backup button).
2. Create **live users** (Authentication → Users → Add user, **tick Auto Confirm**) — one each for Neal + partner (separate accounts, both full access — RLS policy is `to authenticated`, no per-user roles); turn **OFF** public signup. Forgot-password = delete + recreate (no in-app reset by design).
3. Deploy: `git push origin main` (Pages ~60s). RLS still off on live so the app keeps working — but the gate is now live, so **live users must exist first (step 2)**.
4. **Verify you can log in on LIVE** before touching RLS.
5. Run `supabase/rls-policies.sql` on **live** (the `next_qt_number` grant should apply here — it exists on live, unlike the sandbox).
6. Re-probe: raw anon GET → `[]`, anon write → 401.
7. Then step 5 (rotate anon key) + step 6 (private repo).

**Committed locally on `main` as `3faadaf`, NOT pushed** (2026-06-22). One follow-up fix is UNCOMMITTED on top (2026-06-23): `authSignOut` now calls `updateAuthStatus()`. ⚠ Do NOT push to main until live users exist — pushing deploys the login gate to live and would lock the live app out (data still safe; gate loads no data, and there's no live user to log in with). The `git push origin main` IS the live-cutover deploy step — do it deliberately, only after creating live users. Full plan: plan file `curious-cooking-owl.md`.

### Backup / Restore + Sandbox — working state (2026-06-20)
**Done:** Phase 1 backup button shipped (commit 9008c90, local — see Data Backup card above). Verified backup `firstlight-backup-20260620-204536.json` matches live EXACTLY — counts: quotes 13, quote_lines 188, deliverables 253, materials 964, mpl 311, staff 2, group_templates 10 (internal check + live row-count cross-check both PASS). Live schema reconstructed FROM that backup (the PostgREST OpenAPI root `/rest/v1/` needs the service_role key, which we deliberately don't use/hold — only `SUPABASE_ANON_KEY` is in `.env`).

**Switching the LOCAL tool between live and sandbox needs NO code change** — the app already reads `SUPABASE_URL`/`SUPABASE_KEY` from localStorage overrides `fl_supabase_url` / `fl_supabase_key` (index.html ~740), set via connectSupabase() (~1059) / cleared via the disconnect path (~1174). Point local at the sandbox by setting those; never let live get pointed at the sandbox or vice-versa.

**Sandbox — BUILT & PROVEN (2026-06-20):** 2nd Supabase project, ref `erbrflbialsyxbjawopy` (`https://erbrflbialsyxbjawopy.supabase.co`), org upgraded to Pro to get past the 2-free-project limit. Schema generated from the verified backup (the OpenAPI/`/rest/v1/` introspection needs service_role, so the CREATE TABLE SQL was reconstructed from the backup's actual columns/types) and run in the sandbox SQL editor. Schema decisions: **RLS OFF, NO foreign keys** (deliberate — keeps the restore test clean; RLS added later as its own step). `id` columns are `bigint generated by default as identity primary key` (auto-generate but still accept the backup's id values). Single-column PKs: quotes.ref, deliverables.code, mpl.code; the rest keyed on `id`. **Pointing local at a DB:** showSetup() opens the Setup Panel (URL+key fields) → saveSetup() writes `fl_supabase_url`/`fl_supabase_key` + reloads; the conn link only shows when disconnected, so call showSetup() from the console when already connected. **Revert local to live:** `localStorage.removeItem('fl_supabase_url'); localStorage.removeItem('fl_supabase_key'); location.reload();` (falls back to `_DEFAULT_URL` = live). The sandbox anon key is the legacy `eyJ…` JWT, NOT the new `sb_publishable_…` key — the app's sb() sends the key as both `apikey` and `Bearer`, which expects the legacy JWT.

**Restore (Phase 2) — DONE & PROVEN (2026-06-20):** built as the Data Restore card (see Price Manager (Tab 3) above for full details + the merge-vs-wipe caveat). All 6 acceptance points PASSED on the sandbox: (1) backup from live, (2) restore into sandbox, (3) row counts match EXACTLY (13/188/253/964/311/2/10), (4) relationships intact (QT-0001→5 lines, CP006→4 materials), (5) app rendered the restored quotes, (6) wipe & restore again → clean. Key gotcha proven live: a Merge restore into a freshly-connected sandbox gave materials 1811 (= 847 auto-seeded by initSupabase + 964 restored) — Wipe & replace fixed it to exactly 964. Restore has NOT been run against live (no need yet); it's a tested safety net for the RLS work. **Next:** RLS + Supabase Auth — write/test policies on the sandbox first, then live.

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
