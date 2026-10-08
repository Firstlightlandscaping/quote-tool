// Who is calling? (2026-10-02 — designer logins, supabase/designer-access.sql)
//
// Every staff-only function runs with verify_jwt ON, so by the time a request reaches our
// code the gateway has ALREADY checked the token's signature and expiry — reading its claims
// here is therefore safe (we only decode; we never trust an unverified token). A designer's
// token carries app_metadata.fl_role = "designer"; app_metadata is admin-only, so a user can't
// give themselves (or remove) the role.
//
// Designers make their own DESIGN contracts and nothing else, so:
//   - push-teamgantt, push-rams-crm, send-rams-links refuse them outright (they read quotes /
//     RAMS with the service role, which bypasses the database rules — this check is the rule);
//   - airtable-sync serves them for DC- refs only;
//   - airtable-picker (CRM card list) is open to them — they link contracts to cards.
export function callerRole(req: Request): string {
  const auth = req.headers.get("Authorization") || req.headers.get("authorization") || "";
  const tok = auth.replace(/^Bearer\s+/i, "");
  const part = tok.split(".")[1];
  if (!part) return "";
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    const role = payload && payload.app_metadata && payload.app_metadata.fl_role;
    return typeof role === "string" ? role : "";
  } catch (_e) {
    return "";
  }
}

export function isDesigner(req: Request): boolean {
  return callerRole(req) === "designer";
}

// ⚠ THE LOGIN CHECK (2026-10-08). verify_jwt turned out NOT to be a login gate: the page's
// PUBLIC publishable key (sb_publishable_…, readable by anyone from the live page) passed it,
// so the staff functions ran for callers with no login at all — airtable-picker handed back
// the CRM card list. So every staff function now asks Supabase Auth itself: the bearer must
// be a real, unexpired USER session ("/auth/v1/user" answers only for one). The CRM's
// read-only database login is refused too — it reads tables, it never pushes.
// Returns null when the caller may proceed, else the reason (send it as a 401).
const CRM_READER_EMAIL = "crm-reader@firstlightlandscaping.co.uk";   // keep in step with crm-reader-policy.sql
export async function loginCheck(req: Request): Promise<string | null> {
  const auth = req.headers.get("Authorization") || req.headers.get("authorization") || "";
  const tok = auth.replace(/^Bearer\s+/i, "").trim();
  // Server-to-server: sign-contract fires contract_signed into airtable-sync with the
  // project's own service-role key (the client signs with no login). Only our functions hold it.
  const svc = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (svc && tok === svc) return null;
  if (!tok) return "Log in to the quote tool first.";
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return "Server is missing its Supabase settings.";
  try {
    const r = await fetch(url + "/auth/v1/user", { headers: { apikey: key, Authorization: "Bearer " + tok } });
    if (!r.ok) {
      // Not a user session. A service-role key in another form than the injected one (legacy
      // JWT vs new secret key) is still ours: only a genuine service key may list users.
      const adm = await fetch(url + "/auth/v1/admin/users?per_page=1", { headers: { apikey: tok, Authorization: "Bearer " + tok } });
      if (adm.ok) return null;
      return tok.split(".").length === 3 ? "Login expired — refresh and log in again." : "Log in to the quote tool first.";
    }
    const u = await r.json();
    if (!u || !u.id) return "Log in to the quote tool first.";
    if (String(u.email || "").toLowerCase() === CRM_READER_EMAIL) return "Not available to the CRM reader login.";
    return null;
  } catch (_e) {
    return "Couldn't check the login — try again.";
  }
}
