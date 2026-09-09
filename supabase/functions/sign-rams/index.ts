// Edge Function: serve + record operative e-signatures on frozen RAMS documents.
// Sibling of sign-contract (same architecture, same evidence rules) for rams_docs:
//   * table rams_docs, columns doc_html / doc_hash, issued_at (not sent_at)
//   * many signers per document (the whole crew) — allSigned flips status to signed
//   * a SUPERSEDED row (revision replaced it): signed signers keep read access to
//     what they signed; unsigned links are dead — the new revision has new links.
// verify_jwt OFF (config.toml [functions.sign-rams]) — the token is the auth:
// 24 random bytes (48 hex) minted per-operative by ramsDoIssue in index.html.
//
//   GET  ?r=TOKEN  -> validates, records first-view evidence, returns frozen doc
//                     + this signer's state + crew progress (names only, no tokens)
//   POST {token, typedName, signatureImage, agreed} -> records the signature,
//                     flips row to signed when the whole crew has signed.
//
// The stored doc_html is NEVER modified — signatures are DATA in signers, so
// doc_hash stays provable forever. Hash re-verified on every request.
// Secrets/env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected); the CRM push
// additionally needs AIRTABLE_SYNC_TOKEN + AIRTABLE_BASE_ID.
// CRM push (2026-09-05): every signature pushes RAMS Signatures (and RAMS Status → Signed
// when the last one lands) to the Airtable card via ../_shared/rams-crm.ts. Server-side
// by design — the crew sign with the app closed. Best-effort: a CRM failure is logged and
// NEVER fails the signature (the signature is the legal record; the CRM is a mirror).
import { pushRamsCrm } from "../_shared/rams-crm.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const TOKEN_RE = /^[0-9a-f]{48}$/;

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}

function sbHeaders() {
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  return { apikey: KEY, Authorization: "Bearer " + KEY, "Content-Type": "application/json" };
}

async function findByToken(token: string) {
  const URL_ = Deno.env.get("SUPABASE_URL");
  const q = encodeURIComponent(JSON.stringify([{ token }]));
  const res = await fetch(`${URL_}/rest/v1/rams_docs?signers=cs.${q}&limit=1`, { headers: sbHeaders() });
  if (!res.ok) throw new Error("lookup failed: HTTP " + res.status);
  const rows = await res.json();
  return rows.length ? rows[0] : null;
}

async function patchRow(id: number, body: Record<string, unknown>) {
  const URL_ = Deno.env.get("SUPABASE_URL");
  const res = await fetch(`${URL_}/rest/v1/rams_docs?id=eq.${id}`, {
    method: "PATCH",
    headers: { ...sbHeaders(), Prefer: "return=minimal" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error("update failed: HTTP " + res.status);
}

function evidence(req: Request) {
  return {
    ip: (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || null,
    user_agent: (req.headers.get("user-agent") || "").slice(0, 300) || null,
  };
}

const isExpired = (row: any) => row.expires_at && new Date(row.expires_at) < new Date();

async function handleGet(req: Request, token: string): Promise<Response> {
  const row = await findByToken(token);
  if (!row) return json(404, { error: "This signing link is not valid." });
  const idx = row.signers.findIndex((s: any) => s.token === token);
  const signer = row.signers[idx];
  const signedForMe = !!signer.signed_at || row.status === "signed";

  if (row.status === "superseded" && !signedForMe) {
    return json(410, { error: "This document has been replaced by a newer version. Please use the new link — ask the office if you don't have it." });
  }
  if (!signedForMe && isExpired(row)) return json(410, { error: "This link has expired. Please ask the office for a new one." });
  if (!row.doc_html) return json(404, { error: "This signing link is not valid." });

  if ((await sha256Hex(row.doc_html)) !== row.doc_hash) {
    return json(500, { error: "Document integrity check failed. Please contact the office." });
  }

  // First-view evidence (set once; a signed signer's record is never touched).
  if (!signer.viewed_at && !signer.signed_at) {
    const signers = row.signers.map((s: any, i: number) =>
      i === idx ? { ...s, viewed_at: new Date().toISOString(), ...evidence(req) } : s);
    await patchRow(row.id, { signers });
    row.signers = signers;
  }

  return json(200, {
    ok: true,
    kind: "rams",
    quoteRef: row.quote_ref,
    customer: row.customer,
    revision: row.revision,
    signerName: signer.name,
    alreadySigned: !!signer.signed_at,
    allSigned: row.status === "signed",
    superseded: row.status === "superseded",
    signedAt: signer.signed_at || null,
    coSigners: row.signers.filter((_: any, i: number) => i !== idx).map((s: any) => ({ name: s.name, signed: !!s.signed_at })),
    expiresAt: row.expires_at,
    issuedAt: row.issued_at,
    // Timestamps only — IP/user-agent stay server-side.
    signatures: row.signers.map((s: any) => ({
      name: s.name, signed: !!s.signed_at, signedAt: s.signed_at || null,
      viewedAt: s.viewed_at || null,
      typedName: s.typed_name || null, nameAdopted: !!s.name_adopted,
      image: s.signed_at ? (s.signature_image || null) : null,
    })),
    docHtml: row.doc_html,
  });
}

async function handlePost(req: Request): Promise<Response> {
  let body: any;
  try { body = await req.json(); } catch (_e) { return json(400, { error: "Bad request." }); }
  const token = String(body.token || "");
  if (!TOKEN_RE.test(token)) return json(404, { error: "This signing link is not valid." });

  const row = await findByToken(token);
  if (!row) return json(404, { error: "This signing link is not valid." });
  const idx = row.signers.findIndex((s: any) => s.token === token);
  const signer = row.signers[idx];

  if (row.status === "superseded") return json(410, { error: "This document has been replaced by a newer version — sign the new one instead." });
  if (signer.signed_at) return json(409, { error: "You have already signed this document." });
  if (isExpired(row)) return json(410, { error: "This link has expired. Please ask the office for a new one." });

  const typedName = String(body.typedName || "").trim();
  const img = String(body.signatureImage || "");
  if (body.agreed !== true) return json(400, { error: "Please tick to confirm you have read and understood the document." });
  if (!typedName || typedName.length > 120) return json(400, { error: "Please print your full name." });
  if (!img.startsWith("data:image/png;base64,") || img.length > 500_000) return json(400, { error: "Please draw your signature." });

  if ((await sha256Hex(row.doc_html)) !== row.doc_hash) {
    return json(500, { error: "Document integrity check failed. Please contact the office." });
  }

  const now = new Date().toISOString();
  const signers = row.signers.map((s: any, i: number) =>
    i === idx
      ? { ...s, viewed_at: s.viewed_at || now, signed_at: now, typed_name: typedName,
          name_adopted: body.nameAdopted === true,
          signature_image: img, ...evidence(req) }
      : s);
  const allSigned = signers.every((s: any) => s.signed_at);
  const patch: Record<string, unknown> = { signers };
  if (allSigned) { patch.status = "signed"; patch.signed_at = now; }
  await patchRow(row.id, patch);

  // CRM mirror — after the signature is safely recorded, never before, never fatal.
  try {
    const res = await pushRamsCrm({ ...row, ...patch, status: allSigned ? "signed" : row.status });
    if (!res.ok) console.error("sign-rams CRM push failed:", res.error);
  } catch (e) { console.error("sign-rams CRM push threw:", (e as Error).message); }

  return json(200, { ok: true, allSigned, signedAt: now });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method === "GET") {
      const token = new URL(req.url).searchParams.get("r") || "";
      if (!TOKEN_RE.test(token)) return json(404, { error: "This signing link is not valid." });
      return await handleGet(req, token);
    }
    if (req.method === "POST") return await handlePost(req);
    return json(405, { error: "Method not allowed." });
  } catch (e) {
    console.error("sign-rams error:", (e as Error).message);
    return json(500, { error: "Something went wrong. Please try again or contact the office." });
  }
});
