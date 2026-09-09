// Shared: push a RAMS record's state to its Airtable CRM card.
// Used by push-rams-crm (app-side transitions: Drafted / Approved / Issued / revision /
// un-issue / add-operative) and by sign-rams (signature events — the crew sign at 7am with
// the app closed, so those pushes MUST be server-side). One implementation, one contract.
//
// CRM CONTRACT (agreed with the CRM chat 22/08 → 05/09/2026, BINDING):
//   * Exactly FOUR fields on the Cards table (ids in AIRTABLE_FIELD_MAP.md — field ids are
//     inert without the base id, which stays a secret):
//       RAMS Status       single select, values EXACTLY Drafted / Approved / Issued / Signed
//       RAMS Signatures   text, app-composed display string, CRM never parses it
//       RAMS Issued Date  date (ISO yyyy-mm-dd), written at Issued — anchors their 7-day chase
//       RAMS Link         URL, the LOGIN-GATED manage-view deep link — NEVER a signing link
//   * PATCH only the fields present in the event, never null the others.
//   * NEVER send typecast:true — a status mismatch must ERROR, never mint an option.
//   * Do NOT touch the legacy "RAMS Sent" / "RAMS Signed" checkboxes (HelloSign era).
//   * Never set the card's List field (CRM automations key off it).
// Secrets: AIRTABLE_SYNC_TOKEN (read+write, base-scoped), AIRTABLE_BASE_ID; optional
// APP_BASE (default the live Pages URL — the link must be the real-world address even
// when pushed from the sandbox, the CRM displays it verbatim).

export const RAMS_CRM = {
  cardsTable: "tblhrLdyfVW8zQchA",
  fields: {
    status: "fldbZFPk9Vs14IEdm",
    signatures: "fldK4iLxCDCLVsjdx",
    issuedDate: "fldBMAlKHRbf4jGkc",
    link: "fldblwkoAqAQkMscf",
    cardName: "fld94ZrpnsYT0Bw9a",   // read-only, for the dry-run's "this will update the card for: …"
  },
};

const STATUS_LABEL: Record<string, string> = { draft: "Drafted", approved: "Approved", issued: "Issued", signed: "Signed" };

export function ramsSignaturesText(row: any): string {
  if (row.status !== "issued" && row.status !== "signed") return "Not yet issued";
  const signers: any[] = row.signers || [];
  const signed = signers.filter(s => s.signed_at);
  const outstanding = signers.filter(s => !s.signed_at).map(s => s.name);
  return `${signed.length} of ${signers.length} signed` + (outstanding.length ? ` — outstanding: ${outstanding.join(", ")}` : "");
}

// The readable payload for one event. null = nothing to push (a superseded row is history;
// the replacement revision's own Drafted push is what moves the card).
export function ramsCrmPayload(row: any): { status: string; signatures: string; issuedDate?: string; link?: string } | null {
  const status = STATUS_LABEL[row.status];
  if (!status) return null;
  const out: any = { status, signatures: ramsSignaturesText(row) };
  if (row.issued_at) {
    const appBase = (Deno.env.get("APP_BASE") || "https://firstlightlandscaping.github.io/quote-tool").replace(/\/$/, "");
    out.issuedDate = String(row.issued_at).slice(0, 10);
    out.link = `${appBase}/?rams=${encodeURIComponent(row.quote_ref)}`;
  }
  return out;
}

function toAirtableFields(p: { status: string; signatures: string; issuedDate?: string; link?: string }) {
  const f = RAMS_CRM.fields;
  const out: Record<string, unknown> = { [f.status]: p.status, [f.signatures]: p.signatures };
  if (p.issuedDate) out[f.issuedDate] = p.issuedDate;
  if (p.link) out[f.link] = p.link;
  return out;
}

function sbHeaders() {
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
}

async function cardIdFor(quoteRef: string): Promise<string | null> {
  const URL_ = Deno.env.get("SUPABASE_URL");
  const r = await fetch(`${URL_}/rest/v1/quotes?ref=eq.${encodeURIComponent(quoteRef)}&select=airtable_card_id`, { headers: sbHeaders() });
  if (!r.ok) throw new Error("quote lookup failed: HTTP " + r.status);
  const rows = await r.json();
  return (rows[0] && rows[0].airtable_card_id) || null;
}

export type PushResult =
  | { ok: true; skipped: string; ref: string }
  | { ok: true; dryRun: true; ref: string; card: { id: string; name: string }; current: Record<string, unknown>; payload: Record<string, unknown>; airtableFields: Record<string, unknown> }
  | { ok: true; ref: string; card: { id: string; name: string }; payload: Record<string, unknown>; airtableFields: Record<string, unknown> }
  | { ok: false; ref: string; error: string };

// cardOverride: the CRM's dedicated test card for verification runs — never used in
// normal operation (the linked card always comes from quotes.airtable_card_id).
export async function pushRamsCrm(row: any, opts: { dryRun?: boolean; cardOverride?: string } = {}): Promise<PushResult> {
  const ref = row.quote_ref;
  const payload = ramsCrmPayload(row);
  if (!payload) return { ok: true, skipped: "superseded row — the replacement revision pushes", ref };
  const token = Deno.env.get("AIRTABLE_SYNC_TOKEN"), base = Deno.env.get("AIRTABLE_BASE_ID");
  if (!token || !base) return { ok: false, ref, error: "CRM push not configured (AIRTABLE_SYNC_TOKEN / AIRTABLE_BASE_ID)" };
  // SANDBOX GUARD: the sandbox holds COPIES of real quotes with their REAL card ids, so a
  // click there would write to a live CRM card. With RAMS_CRM_TEST_CARD set (sandbox only,
  // NEVER on live) every push is redirected to the CRM's dedicated test card instead.
  const forced = Deno.env.get("RAMS_CRM_TEST_CARD") || "";
  const linked = opts.cardOverride ? null : await cardIdFor(ref);
  const cardId = opts.cardOverride || forced || linked;
  if (!cardId) return { ok: true, skipped: "no CRM card linked to " + ref, ref };
  if (forced && !opts.cardOverride) console.log(`RAMS_CRM_TEST_CARD set — ${ref} redirected from ${linked || "(no card)"} to ${forced}`);

  const H = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const recUrl = `https://api.airtable.com/v0/${base}/${RAMS_CRM.cardsTable}/${cardId}`;
  const airtableFields = toAirtableFields(payload);

  // Read first (both modes): confirms the card exists and gives the name-level check.
  const g = await fetch(recUrl + "?returnFieldsByFieldId=true", { headers: H });
  if (!g.ok) return { ok: false, ref, error: `Airtable read HTTP ${g.status}: ${(await g.text()).slice(0, 200)}` };
  const rec = await g.json();
  const cf = rec.fields || {}, f = RAMS_CRM.fields;
  const card: any = { id: cardId, name: String(cf[f.cardName] || "") };
  if (forced && !opts.cardOverride) card.redirectedFrom = linked || null;   // visible in every result
  const current = { status: cf[f.status] ?? null, signatures: cf[f.signatures] ?? null, issuedDate: cf[f.issuedDate] ?? null, link: cf[f.link] ?? null };

  if (opts.dryRun) return { ok: true, dryRun: true, ref, card, current, payload, airtableFields };

  const p = await fetch(recUrl, { method: "PATCH", headers: H, body: JSON.stringify({ fields: airtableFields }) });   // no typecast — by contract
  if (!p.ok) return { ok: false, ref, error: `Airtable write HTTP ${p.status}: ${(await p.text()).slice(0, 200)}` };
  return { ok: true, ref, card, payload, airtableFields };
}
