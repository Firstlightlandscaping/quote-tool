// Edge Function: read the Airtable "Quote tool picker" view for the client picker.
//
// READ-ONLY by construction: uses AIRTABLE_PICKER_TOKEN, a token scoped to
// data.records:read only — a bug in this path cannot write to the CRM.
// verify_jwt (default on) gates it to logged-in staff; the token and base id live
// as function secrets and never ship in the public page.
//
// Trigger: POST from the app (empty body). Returns:
//   { cards: [{ id, name, phone, email, address, postcodeDistrict }] }
//
// The view's FILTER decides who is quotable (Active + the quote/design lists) —
// deliberately maintained in Airtable, not here, so changing who appears needs no
// code change. Field ids are inert without the base id + token, so they stay in
// source (Neal's ruling, 30/07/26); the base id is a secret so re-pointing at a
// different base is config-only.
//
// Secrets/env:
//   AIRTABLE_PICKER_TOKEN   read-only token (set on sandbox + live, 30/07/26)
//   AIRTABLE_BASE_ID        the CRM base id
//
// Airtable gotchas honoured: requests ONLY the five picker fields; responses keyed
// by field ID (returnFieldsByFieldId) so renames can't break us; pages followed via
// offset (100 records/page).

const CARDS_TABLE = "tblhrLdyfVW8zQchA";
const PICKER_VIEW = "viwYQkKb9VgRwlLuN"; // "Quote tool picker"
const F = {
  name: "fld94ZrpnsYT0Bw9a",     // Card Name
  phone: "fldwWiMltA24BbqI6",    // Phone Number
  email: "fldgRoUnwm3YHtng9",    // Email Address
  address: "fldfV5j0YprRWx4w2",  // Address
  district: "fldcf82l9M7jhj33q", // Postcode District (outward code only — display hint,
                                 // NEVER written to quotes.post; see the address split app-side)
};

const CORS = {
  "Access-Control-Allow-Origin": "*", // the JWT gate is the real protection, not CORS
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
  try {
    const token = Deno.env.get("AIRTABLE_PICKER_TOKEN");
    const base = Deno.env.get("AIRTABLE_BASE_ID");
    if (!token || !base) throw new Error("AIRTABLE_PICKER_TOKEN / AIRTABLE_BASE_ID secret not set");

    const cards: unknown[] = [];
    let offset = "";
    do {
      const qs = new URLSearchParams({ view: PICKER_VIEW, returnFieldsByFieldId: "true" });
      Object.values(F).forEach((id) => qs.append("fields[]", id));
      if (offset) qs.set("offset", offset);
      const res = await fetch(`https://api.airtable.com/v0/${base}/${CARDS_TABLE}?${qs}`, {
        headers: { Authorization: "Bearer " + token },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`Airtable HTTP ${res.status}: ${JSON.stringify(data).slice(0, 200)}`);
      for (const r of data.records || []) {
        const f = r.fields || {};
        cards.push({
          id: r.id,
          name: f[F.name] || "",
          phone: f[F.phone] || "",
          email: f[F.email] || "",
          address: f[F.address] || "",
          postcodeDistrict: f[F.district] || "",
        });
      }
      offset = data.offset || "";
    } while (offset);

    return new Response(JSON.stringify({ cards }), {
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), {
      status: 500, headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
