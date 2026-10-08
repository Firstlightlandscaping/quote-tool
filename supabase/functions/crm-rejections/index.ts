// Edge Function: which of these CRM cards carry a Quote Rejection Reason?
//
// READ-ONLY by construction: uses AIRTABLE_PICKER_TOKEN (data.records:read only) — a bug
// here cannot write to the CRM. verify_jwt (default on) = logged-in staff; designers are
// refused (they never see quotes).
//
// Why (CRM, 08/10/26): the CRM records "why we lost it" as Quote Rejection Reason on the
// card. The app reads it when Saved Quotes opens: a SENT quote on such a card is marked
// Declined (the normal Declined push — which never writes the reason, so the human-picked
// value is never overwritten); an ACCEPTED quote is only listed for a person.
//
// POST { cards: ["rec…", …] }  →  { reasons: { "rec…": "Price too high", … } }
// Only cards WITH a reason are returned. Card ids are validated, de-duplicated and looked up
// in chunks with RECORD_ID() (field-id based, so a renamed field can't break us).
//
// Sandbox: when AIRTABLE_TEST_CARD is set (sandbox only — never on live), the sandbox's
// quotes carry copies of REAL card ids, so only the test card itself is looked up; every
// other id is ignored. To test, link a sandbox Sent quote to the test card.

import { isDesigner, loginCheck } from "../_shared/caller.ts";

const CARDS_TABLE = "tblhrLdyfVW8zQchA";
const F_REASON = "fldwAtrXoQ6KcHmNb"; // Cards.Quote Rejection Reason

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Single select → string; multi select / lookup → joined; text → trimmed.
function reasonText(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map(reasonText).filter(Boolean).join(", ");
  if (typeof v === "object") return reasonText((v as { name?: unknown }).name);
  return String(v).trim();
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "POST only" });
  const denied = await loginCheck(req);   // a real login — verify_jwt alone let the public key in
  if (denied) return json(401, { error: denied });
  if (isDesigner(req)) return json(403, { error: "Not available to designer logins" });
  try {
    const token = Deno.env.get("AIRTABLE_PICKER_TOKEN");
    const base = Deno.env.get("AIRTABLE_BASE_ID");
    if (!token || !base) throw new Error("AIRTABLE_PICKER_TOKEN / AIRTABLE_BASE_ID secret not set");
    const body = await req.json().catch(() => ({}));
    let ids = [...new Set((Array.isArray(body.cards) ? body.cards : []).map(String))]
      .filter(id => /^rec[A-Za-z0-9]{14}$/.test(id));
    const testCard = Deno.env.get("AIRTABLE_TEST_CARD") || "";
    if (testCard) ids = ids.filter(id => id === testCard);

    const reasons: Record<string, string> = {};
    for (let i = 0; i < ids.length; i += 40) {
      const chunk = ids.slice(i, i + 40);
      const formula = "OR(" + chunk.map(id => `RECORD_ID()='${id}'`).join(",") + ")";
      let offset = "";
      do {
        const qs = new URLSearchParams({ filterByFormula: formula, returnFieldsByFieldId: "true" });
        qs.append("fields[]", F_REASON);
        if (offset) qs.set("offset", offset);
        const res = await fetch(`https://api.airtable.com/v0/${base}/${CARDS_TABLE}?${qs}`, {
          headers: { Authorization: "Bearer " + token },
        });
        const data = await res.json();
        if (!res.ok) throw new Error(`Airtable HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
        for (const r of data.records || []) {
          const t = reasonText((r.fields || {})[F_REASON]);
          if (t) reasons[r.id] = t;
        }
        offset = data.offset || "";
      } while (offset);
    }
    return json(200, { reasons, checked: ids.length });
  } catch (e) {
    return json(500, { error: String((e as Error).message || e) });
  }
});
