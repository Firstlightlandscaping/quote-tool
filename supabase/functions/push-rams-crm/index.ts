// Edge Function: push a RAMS record's state to its Airtable CRM card — the APP-SIDE half
// of the event-driven RAMS push (status transitions). Signature events push from
// sign-rams directly; both share ../_shared/rams-crm.ts so the contract lives once.
// Called by the app (staff session — verify_jwt ON, the push-teamgantt pattern) right
// after: draft saved, approved, issued, revision created, un-issued, operative added.
//
//   POST { id: <rams_docs id> }            -> push that row
//   POST { ref: "QT-0097" }                -> push the LATEST row for that quote
//   + dryRun: true                         -> read the card + compute the write, write NOTHING
//   + testCard: "rec…"                     -> dryRun/write against the CRM's dedicated test
//                                             card instead of the linked one (verification only)
//
// Secrets: AIRTABLE_SYNC_TOKEN, AIRTABLE_BASE_ID (both set 30/07/26), optional APP_BASE.
import { pushRamsCrm } from "../_shared/rams-crm.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, apikey",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function sbHeaders() {
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Method not allowed." });
  try {
    let body: any;
    try { body = await req.json(); } catch (_e) { return json(400, { error: "Bad request." }); }
    const URL_ = Deno.env.get("SUPABASE_URL");
    let q: string;
    if (body.id) q = `id=eq.${Number(body.id)}`;
    else if (typeof body.ref === "string" && /^QT-\d+$/.test(body.ref.trim().toUpperCase())) q = `quote_ref=eq.${encodeURIComponent(body.ref.trim().toUpperCase())}&order=id.desc&limit=1`;
    else return json(400, { error: "Missing id or ref." });
    const r = await fetch(`${URL_}/rest/v1/rams_docs?${q}&select=id,quote_ref,status,revision,issued_at,signed_at,signers`, { headers: sbHeaders() });
    if (!r.ok) return json(500, { error: "Lookup failed." });
    const row = (await r.json())[0];
    if (!row) return json(404, { error: "RAMS record not found." });
    const testCard = typeof body.testCard === "string" && /^rec[A-Za-z0-9]{14}$/.test(body.testCard) ? body.testCard : undefined;
    const result = await pushRamsCrm(row, { dryRun: body.dryRun === true, cardOverride: testCard });
    if (!result.ok) console.error("push-rams-crm:", result.error);
    return json(result.ok ? 200 : 502, { rowId: row.id, revision: row.revision, ...result });
  } catch (e) {
    console.error("push-rams-crm error:", (e as Error).message);
    return json(500, { error: "Something went wrong pushing to the CRM." });
  }
});
