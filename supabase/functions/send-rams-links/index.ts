// Edge Function: email each operative their private RAMS signing link.
// Called by the APP (staff session — verify_jwt stays ON, the push-teamgantt pattern)
// after issue / re-issue / add-operative. Reads everything from the DB itself and
// builds the links server-side, so tokens never transit the browser request.
//
//   POST { id: <rams_docs id>, mode?: 'issue' | 'chase', signers?: number[], dryRun?: true }
//     -> mode 'issue' (default): for every signer with an email, not yet signed, not yet
//        emailed for their CURRENT token: sends their link via Resend and stamps
//        email_sent_at on the signer. Signers without an email are reported (office
//        copies the link by hand).
//     -> mode 'chase' (2026-09-05, the CRM-agreed human-click chase): sends the CHASE
//        wording to every unsigned signer with an email — including ones already
//        emailed (that's the point) — and stamps chased_at (+ chase_count). `signers`
//        = optional list of signer indices to chase just those. A signer never emailed
//        before also gets email_sent_at stamped (a chase is a send). Never unattended:
//        the app calls this only from a person's click.
//     -> dryRun: returns exactly what WOULD send (recipient, subject, body) without
//        sending or stamping — used for testing and for previewing wording.
//
// Secrets: RESEND_API_KEY (unset -> clean "not configured" error; links still work by
// copy), optional RAMS_FROM (default sitedocs@firstlightlandscaping.co.uk),
// optional SIGN_BASE (default the live Pages URL).
// Auto-injected: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.

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

const esc = (s: unknown) => String(s == null ? "" : s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const firstName = (n: string) => (String(n || "").trim().split(/\s+/)[0]) || "there";

// ── Wording (2026-09-05): lives in the editable library — company_settings
// .rams_library.emailTemplates = { issue: {subject, body}, chase: {subject, body} },
// edited in-app from the RAMS overview panel ("✉ Email wording"). These DEFAULTS are the
// fallback when the library has none (or a template is blank) and MUST stay identical to
// RAMS_EMAIL_DEFAULTS in index.html (the editor's "reset to default" shows the same text).
// Merge fields: {name} first name · {job} customer (or quote ref) · {link} the private
// signing link · {expiry} link expiry date · {office} office number.
// Body is PLAIN TEXT: blank line = new paragraph. A paragraph that is ONLY {link} renders
// as the green button in the HTML version (and the bare URL in the text version).
const OFFICE = "0113 2580428";
const EMAIL_DEFAULTS = {
  issue: {
    subject: "Site documents to sign — {job} job",
    body:
      "Hi {name},\n\n" +
      "The Risk Assessment & Method Statement for the {job} job is ready for you. Read it through before you start work on site, then sign at the bottom of the page.\n\n" +
      "Your private link:\n{link}\n\n" +
      "Not sure about anything in it, or think something's missing or wrong? Raise it before you start — call the office on {office}.\n\n" +
      "First Light Landscaping",
  },
  chase: {
    subject: "Reminder: site documents still to sign — {job} job",
    body:
      "Hi {name},\n\n" +
      "A quick reminder — the Risk Assessment & Method Statement for the {job} job still needs your signature. Please read it through and sign at the bottom of the page before you start work on site.\n\n" +
      "Your private link (valid until {expiry}):\n{link}\n\n" +
      "Not sure about anything in it, or think something's missing or wrong? Raise it before you start — call the office on {office}.\n\n" +
      "First Light Landscaping",
  },
};
const dateGB = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
};
// A saved template wins only when both parts are non-blank strings AND the body still
// carries {link} — without the link the crew can't sign, so a broken edit falls back.
function pickTemplate(lib: any, mode: "issue" | "chase") {
  const t = lib && lib.emailTemplates && lib.emailTemplates[mode];
  if (t && typeof t.subject === "string" && t.subject.trim() && typeof t.body === "string" && t.body.includes("{link}")) {
    return { subject: t.subject, body: t.body, source: "library" };
  }
  return { ...EMAIL_DEFAULTS[mode], source: "default" };
}
function renderEmail(tpl: { subject: string; body: string }, signer: any, row: any, link: string) {
  const fields: Record<string, string> = {
    name: firstName(signer.name),
    job: row.customer || row.quote_ref || "",
    link,
    expiry: row.expires_at ? dateGB(row.expires_at) : "",
    office: OFFICE,
  };
  const merge = (s: string, f: (v: string, k: string) => string) =>
    s.replace(/\{(name|job|link|expiry|office)\}/g, (_m, k) => f(fields[k] ?? "", k));
  const subject = merge(tpl.subject, v => v).replace(/\s+/g, " ").trim();
  const text = merge(tpl.body, v => v);
  const paras = tpl.body.replace(/\r\n/g, "\n").split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const btn = `<a href="${esc(link)}" style="background:#2F5233;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;display:inline-block">Read &amp; sign your copy</a>`;
  const html =
    `<div style="font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;font-size:15px;color:#1e293b;line-height:1.55;max-width:560px">` +
    paras.map(p => {
      if (p === "{link}") return `<p style="margin:22px 0">${btn}</p>`;
      // Escape the template text FIRST, then drop merged values in (escaped) so a client
      // name with an ampersand or a typed "<" can't become markup.
      const inner = merge(esc(p), (v, k) => k === "link" ? `<a href="${esc(v)}">${esc(v)}</a>` : esc(v)).replace(/\n/g, "<br>");
      return `<p>${inner}</p>`;
    }).join("") +
    `<p style="font-size:12px;color:#94a3b8">This private link was created for you by First Light Landscaping. If anything looks unfamiliar, call the office.</p>` +
    `</div>`;
  return { subject, text, html };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "Method not allowed." });
  try {
    let body: any;
    try { body = await req.json(); } catch (_e) { return json(400, { error: "Bad request." }); }
    const id = Number(body.id);
    if (!id) return json(400, { error: "Missing id." });
    const dryRun = body.dryRun === true;
    const chase = body.mode === "chase";
    const only: number[] | null = Array.isArray(body.signers) ? body.signers.map(Number).filter((n: number) => Number.isInteger(n) && n >= 0) : null;

    const URL_ = Deno.env.get("SUPABASE_URL");
    const res = await fetch(`${URL_}/rest/v1/rams_docs?id=eq.${id}`, { headers: sbHeaders() });
    if (!res.ok) return json(500, { error: "Lookup failed." });
    const rows = await res.json();
    const row = rows[0];
    if (!row) return json(404, { error: "RAMS record not found." });
    if (row.status !== "issued") return json(400, { error: "This RAMS is " + row.status + " — links are only emailed for an issued document." });

    const base = (Deno.env.get("SIGN_BASE") || "https://firstlightlandscaping.github.io/quote-tool").replace(/\/$/, "");
    const from = Deno.env.get("RAMS_FROM") || "First Light Landscaping <sitedocs@firstlightlandscaping.co.uk>";
    const apiKey = Deno.env.get("RESEND_API_KEY");

    const expired = row.expires_at && new Date(row.expires_at) < new Date();
    if (chase && expired) return json(400, { error: "These links expired " + dateGB(row.expires_at) + " — re-issue instead of chasing." });

    const toSend: any[] = [], noEmail: string[] = [], already: string[] = [];
    (row.signers || []).forEach((s: any, i: number) => {
      if (s.signed_at) return;
      if (only && !only.includes(i)) return;
      if (!s.email) { noEmail.push(s.name); return; }
      if (!chase && s.email_sent_at) { already.push(s.name); return; }   // re-issue resets this with the token
      toSend.push({ i, s });
    });

    // Wording from the library (falls back to the built-in defaults if absent/blank).
    let lib: any = null;
    try {
      const lr = await fetch(`${URL_}/rest/v1/company_settings?id=eq.1&select=rams_library`, { headers: sbHeaders() });
      if (lr.ok) lib = ((await lr.json())[0] || {}).rams_library || null;
    } catch (_e) { /* defaults */ }
    const tpl = pickTemplate(lib, chase ? "chase" : "issue");
    const compose = (s: any, r: any, link: string) => renderEmail(tpl, s, r, link);
    const preview = toSend.map(({ s }) => {
      const link = base + "/sign.html?r=" + s.token;
      const e = compose(s, row, link);
      return { name: s.name, to: s.email, subject: e.subject, text: e.text };
    });

    if (dryRun) return json(200, { ok: true, dryRun: true, mode: chase ? "chase" : "issue", wording: tpl.source, wouldSend: preview, noEmail, alreadySent: already });
    if (!apiKey) return json(400, { error: "Email is not configured yet (RESEND_API_KEY not set) — copy the links by hand for now.", noEmail });

    const sent: string[] = [], failed: string[] = [];
    const signers = [...row.signers];
    for (const { i, s } of toSend) {
      const link = base + "/sign.html?r=" + s.token;
      const e = compose(s, row, link);
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [s.email], reply_to: "info@firstlightlandscaping.co.uk", subject: e.subject, text: e.text, html: e.html }),
      });
      if (r.ok) {
        sent.push(s.name);
        const now = new Date().toISOString();
        signers[i] = chase
          ? { ...s, email_sent_at: s.email_sent_at || now, chased_at: now, chase_count: (Number(s.chase_count) || 0) + 1 }
          : { ...s, email_sent_at: now };
      }
      else { failed.push(s.name + " (HTTP " + r.status + ")"); }
    }
    if (sent.length) {
      await fetch(`${URL_}/rest/v1/rams_docs?id=eq.${id}`, {
        method: "PATCH", headers: { ...sbHeaders(), Prefer: "return=minimal" },
        body: JSON.stringify({ signers }),
      });
    }
    return json(200, { ok: true, mode: chase ? "chase" : "issue", sent, failed, noEmail, alreadySent: already });
  } catch (e) {
    console.error("send-rams-links error:", (e as Error).message);
    return json(500, { error: "Something went wrong sending the emails." });
  }
});
