// Edge Function: the CRM's "Send to Xero" — a sales invoice in Xero from a CRM Payments row,
// and "ensure-contact" (the client added to Xero from the card). CRM spec, 12/10/26.
//
// CALLED BY an Airtable automation (no user, no browser): verify_jwt = false (config.toml);
// the auth is the header  x-crm-key  = secret CRM_XERO_KEY (constant-time compare) → 401
// otherwise. No CORS.
//
//   POST { action: "ensure-contact", cardId }
//   POST { action: "invoice", kind: "deposit"|"interim"|"completion", taskId, paymentId, cardId }
//   → always { ok, message (plain English for the office), invoiceNumber?, invoiceId?, contactId? }
//   HTTP 200 for a handled refusal (ok:false); 4xx/5xx only for auth / unexpected errors.
//
// XERO: a Custom Connection (client_credentials). Token from identity.xero.com, 30 min, cached
// in memory. No xero-tenant-id header. Base https://api.xero.com/api.xro/2.0/.
//
// RULES (all from the spec — the comments at each step say which):
//   * guards refuse plainly and create nothing: row missing · Paid by = Cash · Completed or
//     Date Paid set · Xero Invoice ID already set ("Already in Xero (INV-n)") · Amount ≤ 0
//   * nothing half-done: if the Xero create fails, nothing is written to Airtable
//   * one LineItem, LineAmountTypes Inclusive, UnitAmount = Amount (VAT-inclusive £) so the
//     invoice Total = the row's Amount to the penny; TaxType OUTPUT2; AccountCode 205 for a
//     design invoice (DC- contract, or the task's Action Type "Design Invoice"), else 200
//   * deposit / interim → AUTHORISED; completion → DRAFT; create is idempotent (Idempotency-Key
//     = paymentId, so a double press cannot make two invoices)
//   * interim is emailed BY XERO; completion is NOT numbered on the row (the office emails the
//     PDF from Gmail and types the number/date — that closes the task); Invoice Sent is never
//     ticked here (the CRM rule does that)
//   * never typecast, field ids as keys; attachments APPEND (uploadAttachment), never replace
//
// Secrets: XERO_CLIENT_ID, XERO_CLIENT_SECRET, CRM_XERO_KEY, AIRTABLE_SYNC_TOKEN, AIRTABLE_BASE_ID.
// Sandbox-only redirect AIRTABLE_TEST_CARD (as airtable-sync): every card id becomes the test
// card. Never log a secret or a token.

const T = { payments: "tblqY86XB3Y2DGoVX", actions: "tblxGtNzsFFIPSAEP", cards: "tblhrLdyfVW8zQchA" };
const P = {
  name: "fldoGJkWMYyZuHQeu", amount: "fldQwX5mVfQcTUTD8", terms: "fldE0l2zKsDNyXBil", paidBy: "fld06BjSlQK83XeCb",
  contractRef: "fldj2NVaoeUmifsVG", invoiceNumber: "fldB61sGUQVKzh9rx", invoiceDate: "fld2FpjSWZ52vUKOJ",
  invoiceSent: "fldiHkoBIlajLleVc", completed: "fldU9fUOIbmSXe4Gl", datePaid: "fldvzx8CPyuJjeZAq",
  xeroInvoiceId: "fldhTxyixoPpottBE", xeroStatus: "fldrqbe1OLonOtNZ0", xeroLastResult: "fldBtyU3SB1I0ZVmg", card: "fldiJjezHUzJ9Aael",
};
const ACT = { type: "fldBNxTSOqWBHx9SP" };
const CARD = {
  name: "fld94ZrpnsYT0Bw9a", email: "fldgRoUnwm3YHtng9", xeroContactId: "fldwpk248raqwQ5sF", documents: "fldZCN98PNMG7TuGE",
  // Address and Postcode have no field id in the spec — read by NAME (returnFieldsByFieldId
  // off for the card read, see cardGet) — a rename of either would blank the Xero address.
  addressName: "Address", postcodeName: "Postcode",
};
const XERO = "https://api.xero.com/api.xro/2.0/";
const XERO_STATUS = { unpaid: "Unpaid", draft: "Draft" };   // exact single-select strings (never typecast)

type Reply = { ok: boolean; message: string; invoiceNumber?: string; invoiceId?: string; contactId?: string };
const json = (status: number, body: Reply) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const refuse = (message: string): Response => json(200, { ok: false, message });
const str = (v: unknown) => (v == null ? "" : String(v));
const londonDate = (d = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

// ── auth: constant-time compare of SHA-256 digests (no early exit, equal lengths) ──────────
async function keyOk(req: Request): Promise<boolean> {
  const want = Deno.env.get("CRM_XERO_KEY") || "";
  if (!want) return false;
  const given = req.headers.get("x-crm-key") || "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(given)), crypto.subtle.digest("SHA-256", enc.encode(want))]);
  const x = new Uint8Array(a), y = new Uint8Array(b);
  let diff = given.length === 0 ? 1 : 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

// ── Airtable ────────────────────────────────────────────────────────────────────────────
function at() {
  const token = Deno.env.get("AIRTABLE_SYNC_TOKEN"), base = Deno.env.get("AIRTABLE_BASE_ID");
  if (!token || !base) throw new Error("CRM not configured (AIRTABLE_SYNC_TOKEN / AIRTABLE_BASE_ID)");
  const H = { Authorization: "Bearer " + token, "Content-Type": "application/json" };
  const url = (table: string, tail = "") => `https://api.airtable.com/v0/${base}/${table}${tail}`;
  return {
    async get(table: string, id: string, byName = false) {
      const r = await fetch(url(table, `/${id}${byName ? "" : "?returnFieldsByFieldId=true"}`), { headers: H });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`Airtable read ${table}: HTTP ${r.status} ${(await r.text()).slice(0, 160)}`);
      return await r.json();
    },
    async patch(table: string, id: string, fields: Record<string, unknown>) {   // never typecast
      const r = await fetch(url(table, `/${id}`), { method: "PATCH", headers: H, body: JSON.stringify({ fields }) });
      if (!r.ok) throw new Error(`Airtable write ${table}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return await r.json();
    },
    async upload(recordId: string, fieldId: string, filename: string, contentType: string, base64: string) {   // APPENDS
      const r = await fetch(`https://content.airtable.com/v0/${base}/${recordId}/${fieldId}/uploadAttachment`, {
        method: "POST", headers: H, body: JSON.stringify({ contentType, file: base64, filename }),
      });
      if (!r.ok) throw new Error(`Airtable upload: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    },
  };
}
// The card, read by NAME so Address / Postcode (no ids in the spec) can be read, with the
// id-keyed fields looked up through the same record (Airtable returns names here).
async function cardGet(A: ReturnType<typeof at>, cardId: string) {
  const byId = await A.get(T.cards, cardId);
  if (!byId) return null;
  const byName = await A.get(T.cards, cardId, true);
  const nf = (byName && byName.fields) || {};
  return { id: byId.id, f: byId.fields || {}, address: str(nf[CARD.addressName]), postcode: str(nf[CARD.postcodeName]) };
}

// ── Xero ────────────────────────────────────────────────────────────────────────────────
let tokenCache = { token: "", exp: 0 };
let brandingCache = "";
async function xeroToken(): Promise<string> {
  if (tokenCache.token && Date.now() < tokenCache.exp - 60_000) return tokenCache.token;
  const id = Deno.env.get("XERO_CLIENT_ID"), secret = Deno.env.get("XERO_CLIENT_SECRET");
  if (!id || !secret) throw new Error("Xero not configured (XERO_CLIENT_ID / XERO_CLIENT_SECRET)");
  const r = await fetch("https://identity.xero.com/connect/token", {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(id + ":" + secret), "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=client_credentials",
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.access_token) throw new Error("Xero login failed (" + (d.error_description || d.error || "HTTP " + r.status) + ")");
  tokenCache = { token: d.access_token, exp: Date.now() + (Number(d.expires_in) || 1800) * 1000 };
  return tokenCache.token;
}
// Xero's validation messages in plain words, for the office.
function xeroErrorText(status: number, text: string): string {
  try {
    const d = JSON.parse(text);
    const msgs: string[] = [];
    for (const el of d.Elements || []) for (const v of el.ValidationErrors || []) if (v.Message) msgs.push(v.Message);
    if (msgs.length) return msgs.join(" ");
    if (d.Message) return String(d.Message);
    if (d.Detail) return String(d.Detail);
    if (d.Title) return String(d.Title);
  } catch (_e) { /* not JSON */ }
  return status === 401 ? "Xero refused the connection (check the Custom Connection)" : "Xero HTTP " + status;
}
async function xero(path: string, init: RequestInit = {}, accept = "application/json") {
  const token = await xeroToken();
  const headers: Record<string, string> = { Authorization: "Bearer " + token, Accept: accept, ...(init.headers as Record<string, string> || {}) };
  if (init.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const r = await fetch(XERO + path, { ...init, headers });
  return r;
}
async function xeroJson(path: string, init: RequestInit = {}) {
  const r = await xero(path, init);
  const text = await r.text();
  if (!r.ok) throw new XeroError(xeroErrorText(r.status, text), r.status);
  return text ? JSON.parse(text) : {};
}
class XeroError extends Error { status: number; constructor(m: string, s: number) { super(m); this.status = s; } }
async function brandingTheme(): Promise<string | null> {
  if (brandingCache) return brandingCache;
  const d = await xeroJson("BrandingThemes");
  const t = (d.BrandingThemes || []).find((b: any) => String(b.Name || "").trim().toLowerCase() === "invoice");
  brandingCache = t ? String(t.BrandingThemeID) : "";
  return brandingCache || null;
}
function b64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ── ensure-contact ───────────────────────────────────────────────────────────────────────
// The client's name as Xero should carry it: the card name with a leading job ref stripped
// ("QT-0109 Mrs Katherine Gaunt" → "Mrs Katherine Gaunt", "FL3319/FL3321 Christina Head" →
// "Christina Head"); repeated so "QT-0094 FL3321 Name" sheds both.
function clientName(cardName: string): string {
  let n = cardName.trim();
  for (;;) {
    const m = n.match(/^(?:(?:QT|DC)[-\s]?\d+|FL\d+)(?:[\s\/:-]+|$)/i);
    if (!m) break;
    n = n.slice(m[0].length).trim();
  }
  return n;
}
type ContactResult = { ok: true; contactId: string; name: string; email: string } | { ok: false; message: string };
async function ensureContact(A: ReturnType<typeof at>, cardId: string): Promise<ContactResult> {
  const card = await cardGet(A, cardId);
  if (!card) return { ok: false, message: "Card not found in the CRM." };
  const email = str(card.f[CARD.email]).trim();
  const name = clientName(str(card.f[CARD.name])) || str(card.f[CARD.name]).trim() || "Client";
  // 1. a stored contact that still exists in Xero wins
  const stored = str(card.f[CARD.xeroContactId]).trim();
  if (stored) {
    const r = await xero("Contacts/" + encodeURIComponent(stored));
    if (r.ok) {
      const d = await r.json().catch(() => ({}));
      const c = (d.Contacts || [])[0];
      if (c && c.ContactID) return { ok: true, contactId: String(c.ContactID), name: String(c.Name || name), email: String(c.EmailAddress || email) };
    } else if (r.status !== 404) throw new XeroError(xeroErrorText(r.status, await r.text()), r.status);
    // 404 → the stored id is stale; fall through to the email search
  }
  // 2. no email → nothing to match or create by
  if (!email) return { ok: false, message: "No email address on the card - add one first." };
  // 3. ACTIVE contacts with exactly this email (Xero's search is case-insensitive; we compare
  //    the address exactly, ignoring case, on our side)
  const found = await xeroJson("Contacts?searchTerm=" + encodeURIComponent(email));
  const matches = (found.Contacts || []).filter((c: any) =>
    String(c.EmailAddress || "").trim().toLowerCase() === email.toLowerCase() && String(c.ContactStatus || "ACTIVE") === "ACTIVE");
  let contactId: string, contactName = name;
  if (matches.length > 1) {
    return { ok: false, message: `${matches.length} Xero contacts share this email: ${matches.map((c: any) => c.Name).join(", ")} - pick the right one in Xero (merge or fix the email) then press again.` };
  } else if (matches.length === 1) {
    contactId = String(matches[0].ContactID); contactName = String(matches[0].Name || name);
  } else {
    const lines = card.address.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const body = { Contacts: [{
      Name: name, FirstName: name.split(/\s+/)[0], EmailAddress: email,
      Addresses: [{ AddressType: "POBOX", AddressLine1: lines[0] || "", AddressLine2: lines[1] || "", AddressLine3: lines.slice(2).join(", "),
                    PostalCode: card.postcode.trim(), Country: "United Kingdom" }],
    }] };
    const made = await xeroJson("Contacts", { method: "POST", body: JSON.stringify(body) });
    const c = (made.Contacts || [])[0];
    if (!c || !c.ContactID) throw new Error("Xero did not return the new contact");
    contactId = String(c.ContactID);
  }
  // 4. remember it on the card
  if (stored !== contactId) await A.patch(T.cards, cardId, { [CARD.xeroContactId]: contactId });
  return { ok: true, contactId, name: contactName, email };
}

// ── invoice ──────────────────────────────────────────────────────────────────────────────
// "Start of works: £8802.56 INV 2/10" → "Start of works"; nothing left → "Payment".
function lineDescription(milestone: string): string {
  const d = milestone.replace(/:?\s*£[\s\S]*$/, "").trim();
  return d || "Payment";
}
const invNumberDigits = (n: string) => n.replace(/^\s*INV-?/i, "").replace(/\D/g, "");

async function invoice(A: ReturnType<typeof at>, body: any, cardId: string): Promise<Response> {
  const kind = String(body.kind || "");
  if (!["deposit", "interim", "completion"].includes(kind)) return json(400, { ok: false, message: "kind must be deposit, interim or completion." });
  const paymentId = String(body.paymentId || "");
  if (!/^rec[A-Za-z0-9]{14}$/.test(paymentId)) return json(400, { ok: false, message: "paymentId missing." });
  const row = await A.get(T.payments, paymentId);
  if (!row) return refuse("Payment row not found.");
  const f = row.fields || {};
  // guards — plain refusals, nothing created
  const rowCards: string[] = Array.isArray(f[P.card]) ? f[P.card] : [];
  if (!rowCards.includes(cardId)) return refuse("That payment row isn't on this card.");
  if (/^cash$/i.test(str(f[P.paidBy]).trim())) return refuse("This payment is marked Cash - no invoice is raised for it.");
  if (f[P.completed]) return refuse("This payment is already marked Completed.");
  if (str(f[P.datePaid]).trim()) return refuse("This payment already has a Date Paid.");
  const existingId = str(f[P.xeroInvoiceId]).trim();
  if (existingId) {
    const n = invNumberDigits(str(f[P.invoiceNumber]));
    return refuse("Already in Xero (" + (n ? "INV-" + n : "draft") + ").");
  }
  const amount = Math.round(Number(f[P.amount]) * 100) / 100;
  if (!(amount > 0)) return refuse("The Amount on this payment is £0 - nothing to invoice.");

  const contact = await ensureContact(A, cardId);
  if (!contact.ok) return refuse(contact.message);

  const contractRef = str(f[P.contractRef]).trim();
  const line = lineDescription(str(f[P.name]));
  const reference = contractRef ? `${line} - ${contractRef}` : line;
  // design invoice → 205: a DC- contract, or the task is a "Design Invoice" action
  let design = /^DC-/i.test(contractRef);
  const taskId = String(body.taskId || "");
  if (!design && /^rec[A-Za-z0-9]{14}$/.test(taskId)) {
    const task = await A.get(T.actions, taskId);
    if (task && str((task.fields || {})[ACT.type]).trim() === "Design Invoice") design = true;
  }
  const accountCode = design ? "205" : "200";
  const theme = await brandingTheme();
  const today = londonDate();
  const due = kind === "deposit" ? today : londonDate(new Date(Date.now() + 2 * 86400_000));
  const status = kind === "completion" ? "DRAFT" : "AUTHORISED";

  const payload = { Invoices: [{
    Type: "ACCREC", Contact: { ContactID: contact.contactId }, Date: today, DueDate: due, Status: status,
    LineAmountTypes: "Inclusive", Reference: reference, ...(theme ? { BrandingThemeID: theme } : {}),
    LineItems: [{ Description: line, Quantity: 1, UnitAmount: amount, AccountCode: accountCode, TaxType: "OUTPUT2" }],
  }] };
  let inv: any;
  try {
    const made = await xeroJson("Invoices", { method: "POST", headers: { "Idempotency-Key": paymentId }, body: JSON.stringify(payload) });
    inv = (made.Invoices || [])[0];
    if (!inv || !inv.InvoiceID) throw new Error("Xero did not return the invoice");
  } catch (e) {
    return refuse("Xero would not create the invoice: " + (e as Error).message);   // nothing written to Airtable
  }
  const invoiceId = String(inv.InvoiceID), invoiceNumber = String(inv.InvoiceNumber || ""), digits = invNumberDigits(invoiceNumber);
  const invLabel = invoiceNumber || "(no number yet)";
  const emailTo = contact.email;
  const messages = {
    deposit: `Deposit invoice ${invLabel} created and approved in Xero (not emailed - the contract asks for the money).`,
    interim: `Invoice ${invLabel} created, approved and emailed by Xero to ${emailTo}.`,
    completion: `Draft ${invLabel} created in Xero; PDF saved to the card's Documents. Approve it in Xero, email it from Gmail with the PDF, then type the number and date on the row.`,
  } as Record<string, string>;

  // write-back: ONE patch. Completion gets ids only (number/date typed by the office later).
  const patch: Record<string, unknown> = { [P.xeroInvoiceId]: invoiceId, [P.xeroStatus]: kind === "completion" ? XERO_STATUS.draft : XERO_STATUS.unpaid, [P.xeroLastResult]: messages[kind] };
  if (kind !== "completion") { patch[P.invoiceNumber] = digits; patch[P.invoiceDate] = today; }
  await A.patch(T.payments, paymentId, patch);

  if (kind === "interim") {
    const r = await xero("Invoices/" + invoiceId + "/Email", { method: "POST", body: "{}" });
    if (r.status !== 204 && !r.ok) {
      const why = xeroErrorText(r.status, await r.text());
      const msg = `Invoice ${invLabel} created and approved in Xero but Xero refused to email it: ${why}. Email it from Xero by hand.`;
      await A.patch(T.payments, paymentId, { [P.xeroLastResult]: msg }).catch(() => {});
      return json(200, { ok: false, message: msg, invoiceNumber, invoiceId, contactId: contact.contactId });
    }
  }
  if (kind === "completion") {
    try {
      const r = await xero("Invoices/" + invoiceId, {}, "application/pdf");
      if (!r.ok) throw new Error(xeroErrorText(r.status, await r.text()));
      const pdf = b64(new Uint8Array(await r.arrayBuffer()));
      await A.upload(cardId, CARD.documents, `${invoiceNumber || "INV-draft"} draft.pdf`, "application/pdf", pdf);
    } catch (e) {
      const msg = `Draft ${invLabel} created in Xero but the PDF could not be saved to the card: ${(e as Error).message}. Download it from Xero by hand.`;
      await A.patch(T.payments, paymentId, { [P.xeroLastResult]: msg }).catch(() => {});
      return json(200, { ok: false, message: msg, invoiceNumber, invoiceId, contactId: contact.contactId });
    }
  }
  return json(200, { ok: true, message: messages[kind], invoiceNumber, invoiceId, contactId: contact.contactId });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json(405, { ok: false, message: "POST only." });
  if (!(await keyOk(req))) return json(401, { ok: false, message: "Not authorised." });
  try {
    let body: any;
    try { body = await req.json(); } catch (_e) { return json(400, { ok: false, message: "Bad request." }); }
    const action = String(body.action || "");
    const requested = String(body.cardId || "");
    if (!/^rec[A-Za-z0-9]{14}$/.test(requested)) return json(400, { ok: false, message: "cardId missing." });
    // sandbox redirect (as airtable-sync): every card write lands on the CRM's test card
    const cardId = Deno.env.get("AIRTABLE_TEST_CARD") || requested;
    const A = at();
    if (action === "ensure-contact") {
      const c = await ensureContact(A, cardId);
      return c.ok ? json(200, { ok: true, message: `${c.name} is in Xero.`, contactId: c.contactId }) : refuse(c.message);
    }
    if (action === "invoice") return await invoice(A, body, cardId);
    return json(400, { ok: false, message: "action must be ensure-contact or invoice." });
  } catch (e) {
    const m = (e as Error).message || String(e);
    console.error("xero-invoice error:", m);
    return json(e instanceof XeroError ? 502 : 500, { ok: false, message: "Something went wrong: " + m });
  }
});
