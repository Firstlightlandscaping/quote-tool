// Edge Function: serve + record e-signatures on frozen contracts (signing build Phase 4).
//
// THE ONLY PUBLIC SURFACE of the e-signature feature. verify_jwt is OFF for this
// function (config.toml [functions.sign-contract]) — the client signing at home has
// no login. The auth is the TOKEN: 24 random bytes (48 hex chars, 192 bits) minted
// per-signer by the app's send flow (sigDoSend in index.html) and known only to
// whoever received the signing link. Everything is scoped to the one contract_signing
// row that token appears in; there is no listing, no query surface, no other access.
//
//   GET  ?t=TOKEN
//     -> validates the token + row state, records first-view evidence (viewed_at,
//        ip, user agent; row status sent→viewed), returns the frozen contract HTML
//        + this signer's state + co-signer names (NEVER their tokens).
//   POST {token, typedName, signatureImage, agreed}
//     -> validates + records the signature (signed_at, typed name, drawn PNG, ip,
//        ua), flips the row to signed when EVERY signer has signed. A signed
//        token stops accepting POST (burned) but keeps read access — the client
//        can always view their signed copy, even after link expiry.
//
// Evidence rules: the stored contract_html is NEVER modified — signatures live as
// DATA in the signers array, so contract_hash stays provable forever. Both handlers
// re-verify the hash on every request as a tamper tripwire.
//
// Secrets/env: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY (auto-injected). Nothing else.

const CORS = {
  "Access-Control-Allow-Origin": "*", // token is the gate; sign.html is same-origin on Pages, localhost while testing
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
  const res = await fetch(`${URL_}/rest/v1/contract_signing?signers=cs.${q}&limit=1`, { headers: sbHeaders() });
  if (!res.ok) throw new Error("lookup failed: HTTP " + res.status);
  const rows = await res.json();
  return rows.length ? rows[0] : null;
}

async function patchRow(id: number, body: Record<string, unknown>) {
  const URL_ = Deno.env.get("SUPABASE_URL");
  const res = await fetch(`${URL_}/rest/v1/contract_signing?id=eq.${id}`, {
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

  if (row.status === "revoked") return json(410, { error: "This signing link has been withdrawn. Please contact First Light Landscaping for a new one." });
  if (!signedForMe && isExpired(row)) return json(410, { error: "This signing link has expired. Please contact First Light Landscaping for a new one." });

  // Tamper tripwire: the stored document must still match its send-time fingerprint.
  if ((await sha256Hex(row.contract_html)) !== row.contract_hash) {
    return json(500, { error: "Document integrity check failed. Please contact First Light Landscaping." });
  }

  // First-view evidence (only ever set once; a signed signer's record is never touched).
  if (!signer.viewed_at && !signer.signed_at) {
    const signers = row.signers.map((s: any, i: number) =>
      i === idx ? { ...s, viewed_at: new Date().toISOString(), ...evidence(req) } : s);
    const patch: Record<string, unknown> = { signers };
    if (row.status === "sent") patch.status = "viewed";
    await patchRow(row.id, patch);
  }

  return json(200, {
    ok: true,
    quoteRef: row.quote_ref,
    customer: row.customer,
    signerName: signer.name,
    alreadySigned: !!signer.signed_at,
    allSigned: row.status === "signed",
    signedAt: signer.signed_at || null,
    coSigners: row.signers.filter((_: any, i: number) => i !== idx).map((s: any) => ({ name: s.name, signed: !!s.signed_at })),
    expiresAt: row.expires_at,
    // signature data so the viewer can render the completed signature cells + audit block
    signatures: row.signers.map((s: any) => ({
      name: s.name, signed: !!s.signed_at, signedAt: s.signed_at || null,
      typedName: s.typed_name || null, image: s.signed_at ? (s.signature_image || null) : null,
    })),
    contractHtml: row.contract_html,
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

  if (row.status === "revoked") return json(410, { error: "This signing link has been withdrawn." });
  if (signer.signed_at) return json(409, { error: "You have already signed this contract." });
  if (isExpired(row)) return json(410, { error: "This signing link has expired. Please contact First Light Landscaping for a new one." });

  const typedName = String(body.typedName || "").trim();
  const img = String(body.signatureImage || "");
  if (body.agreed !== true) return json(400, { error: "Please tick to confirm you agree to the contract terms." });
  if (!typedName || typedName.length > 120) return json(400, { error: "Please type your full name." });
  if (!img.startsWith("data:image/png;base64,") || img.length > 500_000) return json(400, { error: "Please draw your signature." });

  if ((await sha256Hex(row.contract_html)) !== row.contract_hash) {
    return json(500, { error: "Document integrity check failed. Please contact First Light Landscaping." });
  }

  const now = new Date().toISOString();
  const signers = row.signers.map((s: any, i: number) =>
    i === idx
      ? { ...s, viewed_at: s.viewed_at || now, signed_at: now, typed_name: typedName, signature_image: img, ...evidence(req) }
      : s);
  const allSigned = signers.every((s: any) => s.signed_at);
  const patch: Record<string, unknown> = { signers };
  if (allSigned) { patch.status = "signed"; patch.signed_at = now; }
  else if (row.status === "sent") patch.status = "viewed";
  await patchRow(row.id, patch);

  return json(200, { ok: true, allSigned, signedAt: now });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method === "GET") {
      const token = new URL(req.url).searchParams.get("t") || "";
      if (!TOKEN_RE.test(token)) return json(404, { error: "This signing link is not valid." });
      return await handleGet(req, token);
    }
    if (req.method === "POST") return await handlePost(req);
    return json(405, { error: "Method not allowed." });
  } catch (e) {
    console.error("sign-contract error:", (e as Error).message);
    return json(500, { error: "Something went wrong. Please try again or contact First Light Landscaping." });
  }
});
