// Edge Function: the Phase 3 QUOTE PUSH — one event of a quote / design contract → its
// Airtable CRM card, Quotes row and Payments rows. Called by the app's manual-confirm
// "Push to CRM" panel (staff session — verify_jwt ON): the panel first calls dryRun to
// show the plan, then calls again without dryRun to execute THE SAME plan.
//
//   POST { ref: "QT-0097" | "DC-0003", event, dryRun?: true, cardOverride?: "rec…" }
//     event ∈ sent · superseded · accepted · declined · contract_generated · contract_signed
//
// Contract = C:\Dev\FirstLight\Airtable CRM\AIRTABLE_FIELD_MAP.md (never copied into this
// repo; field ids are inert without the base id, which is a secret). Rules honoured here:
//   * every push idempotent — Quotes rows upserted on Ref, Payments matched by name
//   * field IDS as keys, NEVER typecast, exact List strings (spaces around >)
//   * "CONTRACT SENT or beyond" is an EXPLICIT 12-list set, never option order: values are
//     written there but the card NEVER moves
//   * Superseded: prior status comes from the AIRTABLE Quotes row (the CRM's last-pushed
//     state is the durable memory): no row → never pushed → no write at all; Sent or
//     Accepted → Amendments unless another row on the card is Accepted (options flow) or
//     the card is beyond the guard. No financial write on supersede.
//   * Accepted: Date Sent backfilled from the card's Quote Sent Date when the row has none;
//     card → QUOTE ACCEPTED only if no other row on the card is still Sent
//   * Declined: row only; the stage is never touched (archiving is a human tick)
//   * Quote Value: Σ Accepted rows if any are Accepted, else Σ Sent rows ("follows the
//     accepted quote"); recomputed on sent / accepted / declined, never on supersede
//   * Quoted By omitted (and logged) unless it matches an option exactly
//   * Payments on (re)generation: create missing; update Amount on a name match ONLY if
//     Invoice Sent and Completed are both unticked; never touch invoiced/completed rows,
//     never delete, list dropped milestones — never guess at money. Trigger Date untouched.
//   * DC- contract_generated: Quotes row + Payments only (no Job Number / Project Value)
//   * contract_signed routes by prefix: QT- → Contract Signed, DC- → Design Contract Signed
//   * NEVER writes the four RAMS fields or the legacy RAMS checkboxes
//
// Secrets: AIRTABLE_SYNC_TOKEN (read+write, base-scoped), AIRTABLE_BASE_ID. Sandbox-only
// test redirects (MUST NOT exist on live): AIRTABLE_TEST_CARD (every card write goes to the
// CRM's nominated test card) and AIRTABLE_TEST_REF_PREFIX (Quotes-row Ref gets this prefix,
// e.g. "ZZZ-", so sandbox test rows never collide with the real refs at go-live).

const T = { cards: "tblhrLdyfVW8zQchA", quotes: "tblwyYldJOSmtIVFl", payments: "tblqY86XB3Y2DGoVX" };
const CARD = {
  name: "fld94ZrpnsYT0Bw9a", list: "fldqEdoSsR6whYUXd", quoteValue: "fld6I3tOHbq8DNG69",
  quoteSentDate: "fldUxILTHcPALSZax", projectValue: "fldlBfNkxOUZS7mvV", jobNumber: "fldTN5Sto5WIP9x8I",
  contractSigned: "fldKqw7Qgx0ae2Ala", designContractSigned: "fldl15deSE4g5eLPc",
  quotesLink: "fld1NVqi5tSRBZMLV",        // reverse link → Quotes rows on this card
};
const Q = {
  ref: "fldYOmdI0Sf59IVIv", type: "fldC007UYNlt2v7uR", card: "fldUAOSbWy1LP9jjK", value: "fldAt1fIqtuED67u1",
  scope: "flddiZWb1tAoiUqYe", status: "fldM3ovzmOliPJC63", dateSent: "fldsLDEQLn5OAOu5l", quotedBy: "flddo51TtLkOmGE2J",
  signingStatus: "fldz8wvktIqMF2Mb5", signed: "fldZYmQH5s4YiggpB", contractGenerated: "fldru1tIQZ8q02iGi",
  supersedes: "fldXmzVIJwGnmtDHC",
};
const P = {
  name: "fldoGJkWMYyZuHQeu", card: "fldiJjezHUzJ9Aael", amount: "fldQwX5mVfQcTUTD8", trigger: "fldZsRzUQgyR8Sjjf",
  triggerList: "fld4HqE9lpB6tBmPP", terms: "fldE0l2zKsDNyXBil", triggerDate: "fldKH5OaJWm6OBV59",
  invoiceSent: "fldiHkoBIlajLleVc", completed: "fldU9fUOIbmSXe4Gl",
};
// "CONTRACT SENT or beyond" — the explicit set (CRM, 05/09/26). Option order is NOT workflow order.
const BEYOND = new Set([
  "CONTRACT SENT", "JOBS > Main Jobs Scheduled", "JOBS > Small Jobs to Schedule", "JOBS > Snags to Schedule",
  "JOBS > Planning (post-handover)", "JOBS > In Progress", "JOBS > On Hold", "JOBS > Waiting Planting",
  "COMPLETION PAYMENT DUE > No Feedback", "COMPLETION PAYMENT DUE > Request Feedback", "COMPLETION > Job Report", "COMPLETE",
]);
const LIST = { quoteSent: "QUOTE SENT", accepted: "QUOTE ACCEPTED", amendments: "QUOTES > Amendments" };
const QUOTED_BY = new Set(["Neal Baker", "Liam Pickering"]);
const TYPE = { qt: "Quote (QT)", dc: "Design Contract (DC)" };
const EVENTS = new Set(["sent", "superseded", "accepted", "declined", "contract_generated", "contract_signed"]);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const round2 = (n: number) => Math.round(n * 100) / 100;
const dateOnly = (iso: unknown) => (iso ? String(iso).slice(0, 10) : null);
const stripHtml = (h: unknown) => String(h || "").replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/\n{3,}/g, "\n\n").trim();

// ── Supabase (service role) ─────────────────────────────────────────────────────
function sbHeaders() {
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
}
async function sbGet(path: string) {
  const r = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${path}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`DB read failed (${path.split("?")[0]}): HTTP ${r.status}`);
  return await r.json();
}
// Mirrors sqTotals() in index.html: group headers re-derived from members, per-line VAT.
function quoteValueInc(lines: any[]): number {
  const amt = (l: any) => l.group_id && !l.group_member
    ? lines.filter(x => x.group_member === l.group_id).reduce((s, x) => s + (x.qty || 0) * (x.unit_price || 0), 0)
    : (l.qty || 0) * (l.unit_price || 0);
  return round2(lines.filter(l => !l.group_member).reduce((s, l) => s + amt(l) * (1 + (l.vat || 0) / 100), 0));
}

// The record the push is about, normalised across the two ref series.
async function loadRecord(ref: string) {
  const isDesign = ref.startsWith("DC-");
  if (isDesign) {
    const row = (await sbGet(`design_contracts?ref=eq.${encodeURIComponent(ref)}&select=ref,customer,airtable_card_id,contract_meta,last_pushed_at`))[0];
    if (!row) return null;
    const cm = row.contract_meta || {};
    return { ref, isDesign, customer: row.customer || "", cardId: row.airtable_card_id || null, cm,
             valueInc: round2(Number(cm.total) || 0), status: cm.status || "Generated", scope: null, dateSent: null, quotedBy: null, supersedesRef: null };
  }
  const q = (await sbGet(`quotes?ref=eq.${encodeURIComponent(ref)}&select=ref,customer,status,status_changed_at,date,sign,summary_html,sum,airtable_card_id,supersedes_ref,contract_meta,last_pushed_at`))[0];
  if (!q) return null;
  const lines = await sbGet(`quote_lines?quote_ref=eq.${encodeURIComponent(ref)}&select=qty,unit_price,vat,group_id,group_member,is_note,is_discount&limit=1000`);
  return { ref, isDesign, customer: q.customer || "", cardId: q.airtable_card_id || null, cm: q.contract_meta || null,
           valueInc: quoteValueInc(lines), status: q.status || "Draft",
           scope: stripHtml(q.summary_html || q.sum || "") || null,
           dateSent: dateOnly(q.status_changed_at) || dateOnly(q.date), quotedBy: q.sign || null, supersedesRef: q.supersedes_ref || null };
}

// ── Airtable ────────────────────────────────────────────────────────────────────
function at() {
  const token = Deno.env.get("AIRTABLE_SYNC_TOKEN"), base = Deno.env.get("AIRTABLE_BASE_ID");
  if (!token || !base) throw new Error("CRM push not configured (AIRTABLE_SYNC_TOKEN / AIRTABLE_BASE_ID)");
  const H = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const url = (table: string, tail = "") => `https://api.airtable.com/v0/${base}/${table}${tail}`;
  return {
    async get(table: string, id: string) {
      const r = await fetch(url(table, `/${id}?returnFieldsByFieldId=true`), { headers: H });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Airtable read ${table}/${id}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
      return await r.json();
    },
    async list(table: string, params: Record<string, string>) {
      const out: any[] = []; let offset = "";
      do {
        const qs = new URLSearchParams({ ...params, returnFieldsByFieldId: "true" });
        if (offset) qs.set("offset", offset);
        const r = await fetch(url(table, `?${qs}`), { headers: H });
        if (!r.ok) throw new Error(`Airtable list ${table}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
        const d = await r.json(); out.push(...(d.records || [])); offset = d.offset || "";
      } while (offset);
      return out;
    },
    async patch(table: string, id: string, fields: Record<string, unknown>) {   // never typecast — by contract
      const r = await fetch(url(table, `/${id}`), { method: "PATCH", headers: H, body: JSON.stringify({ fields }) });
      if (!r.ok) throw new Error(`Airtable write ${table}/${id}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    },
    async create(table: string, fields: Record<string, unknown>) {
      const r = await fetch(url(table), { method: "POST", headers: H, body: JSON.stringify({ fields }) });
      if (!r.ok) throw new Error(`Airtable create ${table}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    },
  };
}

// Airtable single-select/text values may come back as strings; linked records as id arrays.
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => (typeof v === "number" ? v : Number(v) || 0);

// ── The plan ────────────────────────────────────────────────────────────────────
type Write = { table: string; op: "patch" | "create"; id?: string; label: string; fields: Record<string, unknown> };
type Plan = {
  ref: string; event: string; card: { id: string; name: string; list: string | null; beyond: boolean; redirectedFrom?: string | null };
  quotesRow: { id: string | null; status: string | null; found: boolean; ref: string };
  siblings: { ref: string; status: string | null; value: number }[];
  writes: Write[]; notes: string[]; warnings: string[]; skipped?: string;
};

async function buildPlan(ref: string, event: string, cardOverride?: string): Promise<Plan | { skipped: string; ref: string; event: string } | { orphan: true; ref: string; event: string; warning: string }> {
  const rec = await loadRecord(ref);
  if (!rec) throw new Error("Record not found: " + ref);
  const forcedCard = Deno.env.get("AIRTABLE_TEST_CARD") || "";
  const refPrefix = Deno.env.get("AIRTABLE_TEST_REF_PREFIX") || "";
  const cardId = cardOverride || forcedCard || rec.cardId;
  if (!cardId) return { orphan: true, ref, event, warning: "No CRM card linked to " + ref + " — pick the client first (📇), then push." };
  const A = at();
  const card = await A.get(T.cards, cardId);
  if (!card) throw new Error("Card " + cardId + " not found in the CRM");
  const cf = card.fields || {};
  const list = str(cf[CARD.list]);
  const beyond = !!list && BEYOND.has(list);
  const plan: Plan = {
    ref, event,
    card: { id: cardId, name: str(cf[CARD.name]) || "", list, beyond, ...(forcedCard && !cardOverride ? { redirectedFrom: rec.cardId } : {}) },
    quotesRow: { id: null, status: null, found: false, ref: refPrefix + ref },
    siblings: [], writes: [], notes: [], warnings: [],
  };
  // Quotes rows on this card (the CRM's durable memory) + this ref's own row (by Ref, which
  // may live on a different card if the link was changed — still the upsert target).
  const linkedIds: string[] = Array.isArray(cf[CARD.quotesLink]) ? cf[CARD.quotesLink] : [];
  const rows: any[] = [];
  for (const id of linkedIds) { const r = await A.get(T.quotes, id); if (r) rows.push(r); }
  const wantRef = refPrefix + ref;
  let own = rows.find(r => str((r.fields || {})[Q.ref]) === wantRef) || null;
  if (!own) {
    const byRef = await A.list(T.quotes, { filterByFormula: `{Ref}=${JSON.stringify(wantRef)}`, maxRecords: "1" });
    own = byRef[0] || null;
    if (own) rows.push(own);
  }
  plan.quotesRow = { id: own ? own.id : null, status: own ? str(own.fields[Q.status]) : null, found: !!own, ref: wantRef };
  plan.siblings = rows.filter(r => r !== own).map(r => ({ ref: str(r.fields[Q.ref]) || "", status: str(r.fields[Q.status]), value: num(r.fields[Q.value]) }));

  const rowFieldsFull = (status: string) => {
    const f: Record<string, unknown> = {
      [Q.ref]: wantRef, [Q.type]: rec.isDesign ? TYPE.dc : TYPE.qt, [Q.card]: [cardId], [Q.value]: rec.valueInc, [Q.status]: status,
    };
    if (rec.scope) f[Q.scope] = rec.scope;
    if (!rec.isDesign && rec.dateSent) f[Q.dateSent] = rec.dateSent;
    if (rec.quotedBy) {
      if (QUOTED_BY.has(rec.quotedBy)) f[Q.quotedBy] = rec.quotedBy;
      else plan.notes.push(`Quoted By "${rec.quotedBy}" is not an Airtable option — omitted`);
    }
    return f;
  };
  const upsertRow = (fields: Record<string, unknown>, label: string) => {
    if (own) plan.writes.push({ table: T.quotes, op: "patch", id: own.id, label, fields: { ...fields } });
    else plan.writes.push({ table: T.quotes, op: "create", label, fields: { ...rowFieldsFull(String(fields[Q.status] || rec.status)), ...fields } });
  };
  // Aggregates AFTER this event, from the Airtable rows + this row's new state.
  const statusAfter = (newStatus: string | null) => {
    const all = plan.siblings.map(s => ({ status: s.status, value: s.value, dateSent: null as string | null }));
    if (newStatus) all.push({ status: newStatus, value: rec.valueInc, dateSent: rec.dateSent });
    else if (own) all.push({ status: str(own.fields[Q.status]), value: num(own.fields[Q.value]), dateSent: null });
    return all;
  };
  const quoteValueFrom = (all: { status: string | null; value: number }[]) => {
    const acc = all.filter(a => a.status === "Accepted");
    const pool = acc.length ? acc : all.filter(a => a.status === "Sent");
    return round2(pool.reduce((s, a) => s + a.value, 0));
  };
  const cardPatch: Record<string, unknown> = {};
  const move = (to: string, why: string) => {
    if (beyond) { plan.notes.push(`Card is at "${list}" (CONTRACT SENT or beyond) — values written, stage NOT moved (${why})`); return; }
    if (list === to) { plan.notes.push(`Card already at "${to}"`); return; }
    cardPatch[CARD.list] = to;
    plan.notes.push(`Card "${list || "(no list)"}" → "${to}" (${why})`);
  };
  const otherAccepted = plan.siblings.some(s => s.status === "Accepted");
  const otherSent = plan.siblings.some(s => s.status === "Sent");

  switch (event) {
    case "sent": {
      if (rec.isDesign) throw new Error("A design contract is not marked Sent through this event");
      const f = rowFieldsFull("Sent");
      if (rec.supersedesRef) {
        const prev = await A.list(T.quotes, { filterByFormula: `{Ref}=${JSON.stringify(refPrefix + rec.supersedesRef)}`, maxRecords: "1" });
        if (prev[0]) f[Q.supersedes] = [prev[0].id]; else plan.notes.push(`Supersedes ${rec.supersedesRef}, but that quote has no CRM row — link not written`);
      }
      upsertRow(f, "Quotes row → Sent");
      const all = statusAfter("Sent");
      cardPatch[CARD.quoteValue] = quoteValueFrom(all);
      cardPatch[CARD.quoteSentDate] = rec.dateSent;
      move(LIST.quoteSent, "quote sent");
      break;
    }
    case "superseded": {
      if (!own) return { skipped: `${ref} was never pushed to the CRM (no Quotes row) — an unsent option, nothing to do`, ref, event };
      const prior = str(own.fields[Q.status]);
      upsertRow({ [Q.status]: "Superseded" }, `Quotes row ${prior} → Superseded`);
      if (prior === "Sent" || prior === "Accepted") {
        if (otherAccepted) plan.notes.push("Another quote on this card is Accepted — the job is won, card not moved");
        else move(LIST.amendments, prior === "Sent" ? "sent quote superseded — revision owed" : "accepted quote superseded — post-acceptance amendment");
      } else plan.notes.push(`Prior status ${prior} — card not moved`);
      plan.notes.push("No financial write on supersede (figure stays until a replacement is sent)");
      break;
    }
    case "accepted": {
      if (rec.isDesign) throw new Error("A design contract is not marked Accepted through this event");
      const f: Record<string, unknown> = { [Q.status]: "Accepted" };
      if (own && !own.fields[Q.dateSent]) {
        const backfill = str(cf[CARD.quoteSentDate]);
        if (backfill) { f[Q.dateSent] = backfill; plan.notes.push(`Date Sent backfilled from the card's Quote Sent Date (${backfill}) — accepted without ever being marked Sent`); }
      }
      if (!own) {
        const backfill = str(cf[CARD.quoteSentDate]);
        if (backfill) { f[Q.dateSent] = backfill; plan.notes.push(`New row for a quote the CRM never saw — Date Sent backfilled from the card (${backfill})`); }
      }
      upsertRow(f, "Quotes row → Accepted");
      cardPatch[CARD.quoteValue] = quoteValueFrom(statusAfter("Accepted"));
      if (otherSent) plan.notes.push("Another quote on this card is still Sent — card stays put, chase continues");
      else move(LIST.accepted, "quote accepted");
      break;
    }
    case "declined": {
      if (rec.isDesign) throw new Error("A design contract is not marked Declined through this event");
      upsertRow({ [Q.status]: "Declined" }, "Quotes row → Declined");
      cardPatch[CARD.quoteValue] = quoteValueFrom(statusAfter("Declined"));
      plan.notes.push("Stage left alone — archiving is a human tick (Quote Rejected - Approved to Archive)");
      break;
    }
    case "contract_generated": {
      const cm = rec.cm;
      if (!cm || !cm.generatedAt) throw new Error("No contract has been generated for " + ref);
      const f: Record<string, unknown> = { [Q.contractGenerated]: dateOnly(cm.generatedAt) };
      if (rec.isDesign) { f[Q.status] = rec.status; f[Q.value] = rec.valueInc; }
      upsertRow(f, "Quotes row → Contract Generated" + (rec.isDesign ? ` (design, ${rec.status})` : ""));
      if (!rec.isDesign) {
        cardPatch[CARD.jobNumber] = ref;
        cardPatch[CARD.projectValue] = round2(Number(cm.total) || rec.valueInc);
      } else plan.notes.push("Design contract — Job Number / Project Value are build-contract facts, not written");
      // Payments: existing rows on this card, matched by milestone name.
      const existing = await A.list(T.payments, { filterByFormula: `FIND(${JSON.stringify(cardId)}, ARRAYJOIN({Card}))` }).catch(() => [] as any[]);
      const byName = new Map<string, any>();
      existing.forEach(p => byName.set(String(p.fields[P.name] || "").trim().toLowerCase(), p));
      const sched: any[] = Array.isArray(cm.scheduleStructured) ? cm.scheduleStructured : [];
      if (!sched.length) plan.warnings.push("Contract has no structured payment schedule — no Payments written");
      const seen = new Set<string>();
      for (const e of sched) {
        const key = String(e.label || "").trim().toLowerCase();
        if (!key) continue;
        seen.add(key);
        const trigger = e.triggerList ? "On Card Move" : e.trigger === "weekly" ? "On Date" : e.trigger === "onCompletion" ? "On Completion" : "Manual";
        const fields: Record<string, unknown> = {
          [P.name]: e.label, [P.card]: [cardId], [P.amount]: round2(Number(e.amount) || 0), [P.trigger]: trigger, [P.terms]: e.terms || "Standard",
        };
        if (e.triggerList) fields[P.triggerList] = e.triggerList;
        const ex = byName.get(key);
        if (!ex) { plan.writes.push({ table: T.payments, op: "create", label: `Payment "${e.label}" £${fields[P.amount]} (${trigger})`, fields }); continue; }
        const locked = !!ex.fields[P.invoiceSent] || !!ex.fields[P.completed];
        const curAmt = num(ex.fields[P.amount]);
        if (locked) { plan.warnings.push(`"${e.label}": already ${ex.fields[P.completed] ? "completed" : "invoiced"} at £${curAmt} — not changed (schedule says £${fields[P.amount]})`); continue; }
        if (curAmt !== fields[P.amount]) plan.writes.push({ table: T.payments, op: "patch", id: ex.id, label: `Payment "${e.label}" £${curAmt} → £${fields[P.amount]}`, fields: { [P.amount]: fields[P.amount] } });
        else plan.notes.push(`Payment "${e.label}" unchanged at £${curAmt}`);
      }
      existing.forEach(p => {
        const key = String(p.fields[P.name] || "").trim().toLowerCase();
        if (key && !seen.has(key)) plan.warnings.push(`Existing payment "${p.fields[P.name]}" £${num(p.fields[P.amount])} is not in this schedule — left in place (hand-added or dropped; a person decides)`);
      });
      break;
    }
    case "contract_signed": {
      const sig = (await sbGet(`contract_signing?quote_ref=eq.${encodeURIComponent(ref)}&select=status,signed_at,sent_at&order=id.desc&limit=1`))[0];
      if (!sig) throw new Error("No signing record for " + ref);
      const f: Record<string, unknown> = { [Q.signingStatus]: sig.status };
      if (sig.signed_at) f[Q.signed] = dateOnly(sig.signed_at);
      upsertRow(f, `Quotes row → signing ${sig.status}`);
      if (sig.status === "signed") {
        cardPatch[rec.isDesign ? CARD.designContractSigned : CARD.contractSigned] = true;
        plan.notes.push(rec.isDesign ? "DC- ref → Design Contract Signed ticked (signal, never a mover)" : "QT- ref → Contract Signed ticked (signal, never a mover)");
      } else plan.notes.push(`Signing status ${sig.status} — checkbox untouched`);
      break;
    }
  }
  // Card write = only what changed.
  const changed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(cardPatch)) {
    const cur = cf[k];
    const same = (typeof v === "number" && typeof cur === "number") ? Math.abs(v - cur) < 0.005 : (typeof v === "boolean" ? !!cur === v : str(cur) === str(v));
    if (!same) changed[k] = v;
  }
  if (Object.keys(changed).length) plan.writes.unshift({ table: T.cards, op: "patch", id: cardId, label: "Card", fields: changed });
  else plan.notes.push("Card fields already up to date");
  return plan;
}

async function execute(plan: Plan) {
  const A = at();
  const done: string[] = [];
  let createdRowId: string | null = null;
  for (const w of plan.writes) {
    if (w.op === "patch") { await A.patch(w.table, w.id!, w.fields); done.push(w.label); }
    else {
      const r = await A.create(w.table, w.fields);
      if (w.table === T.quotes) createdRowId = r.id;
      done.push(w.label + (w.table === T.quotes ? ` (new row ${r.id})` : ""));
    }
  }
  return { done, createdRowId };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Method not allowed." });
  try {
    let body: any;
    try { body = await req.json(); } catch (_e) { return json(400, { error: "Bad request." }); }
    const ref = String(body.ref || "").trim().toUpperCase();
    const event = String(body.event || "");
    if (!/^(QT|DC)-\d+$/.test(ref)) return json(400, { error: "Bad ref." });
    if (!EVENTS.has(event)) return json(400, { error: "Bad event." });
    const cardOverride = typeof body.cardOverride === "string" && /^rec[A-Za-z0-9]{14}$/.test(body.cardOverride) ? body.cardOverride : undefined;
    const plan = await buildPlan(ref, event, cardOverride);
    if ("orphan" in plan) return json(200, { ok: true, orphan: true, ref, event, warning: plan.warning });
    if ("skipped" in plan && !("writes" in plan)) return json(200, { ok: true, skipped: (plan as any).skipped, ref, event });
    const p = plan as Plan;
    if (body.dryRun === true) return json(200, { ok: true, dryRun: true, ...p });
    const result = await execute(p);
    // Pending marker on our side (Phase 3 schema: supabase/crm-push.sql).
    try {
      const table = ref.startsWith("DC-") ? "design_contracts" : "quotes";
      await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/${table}?ref=eq.${encodeURIComponent(ref)}`, {
        method: "PATCH", headers: { ...sbHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify({ last_pushed_at: new Date().toISOString(), last_push_event: event }),
      });
    } catch (e) { p.warnings.push("Pushed, but last_pushed_at not recorded: " + (e as Error).message); }
    return json(200, { ok: true, ...p, executed: result.done, createdRowId: result.createdRowId });
  } catch (e) {
    console.error("airtable-sync error:", (e as Error).message);
    return json(502, { ok: false, error: (e as Error).message });
  }
});
