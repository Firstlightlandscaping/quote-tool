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
