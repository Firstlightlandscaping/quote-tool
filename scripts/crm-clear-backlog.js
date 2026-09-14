// CRM Phase 3 cutover helper: acknowledge every CURRENTLY-PENDING push event WITHOUT
// writing to Airtable (Neal's 2026-09-08 ruling: Trello is the truth until the CRM import,
// so day-one badges must clear, not push). Stamps quotes/design_contracts.crm_pushed the way
// the app's crmPendingEvents() computes pending. READ-ONLY unless --write is given.
//
//   node scripts/crm-clear-backlog.js                 -> sandbox, dry run (lists what would clear)
//   node scripts/crm-clear-backlog.js --write         -> sandbox, stamps
//   node scripts/crm-clear-backlog.js --live          -> LIVE, dry run
//   node scripts/crm-clear-backlog.js --live --write  -> LIVE, stamps (the cutover step)
// Creds: .env (URL + anon key; SANDBOX_* for the sandbox) + SUPABASE_AGENT_* env vars for live.
const fs = require('fs');
const path = require('path');
const PROJ = path.join(__dirname, '..');
const env = {};
for (const line of fs.readFileSync(path.join(PROJ, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const LIVE = process.argv.includes('--live'), WRITE = process.argv.includes('--write');
const URL_ = LIVE ? env.SUPABASE_URL : env.SUPABASE_SANDBOX_URL;
const KEY = LIVE ? env.SUPABASE_ANON_KEY : env.SUPABASE_SANDBOX_ANON_KEY;
const EMAIL = LIVE ? process.env.SUPABASE_AGENT_EMAIL : env.SANDBOX_AGENT_EMAIL;
const PASS = LIVE ? process.env.SUPABASE_AGENT_PASSWORD : env.SANDBOX_AGENT_PASSWORD;
if (!URL_ || !KEY || !EMAIL || !PASS) throw new Error('credentials missing for ' + (LIVE ? 'LIVE' : 'sandbox'));
if (!LIVE && !URL_.includes('erbrflbialsyxbjawopy')) throw new Error('SAFETY STOP: sandbox URL is not the sandbox');

const STATUS_EVENT = { Sent: 'sent', Accepted: 'accepted', Declined: 'declined', Superseded: 'superseded', Merged: 'merged' };
const newer = (src, stamp) => src && (!stamp || new Date(src) > new Date(stamp));

async function main() {
  const auth = await fetch(URL_ + '/auth/v1/token?grant_type=password', {
    method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!auth.ok) throw new Error('login failed ' + auth.status);
  const token = (await auth.json()).access_token;
  const H = { apikey: KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  const get = async (p) => { const r = await fetch(URL_ + '/rest/v1/' + p, { headers: H }); if (!r.ok) throw new Error(p + ' HTTP ' + r.status); return r.json(); };
  // Before crm-push.sql has run (live pre-cutover) the crm_pushed column is absent — a
  // dry run still works by treating every record as never pushed; --write needs the column.
  const getMaybe = async (p) => { try { return await get(p); } catch (e) { if (!/HTTP 400/.test(e.message)) throw e; noCol = true; return get(p.replace(',crm_pushed', '')); } };
  let noCol = false;
  const quotes = await getMaybe('quotes?select=ref,status,status_changed_at,airtable_card_id,contract_meta,crm_pushed&limit=1000');
  const dcs = await getMaybe('design_contracts?select=ref,airtable_card_id,contract_meta,crm_pushed&limit=1000');
  if (noCol) { console.log('NOTE: crm_pushed column absent on this DB (run supabase/crm-push.sql first) — dry run only'); if (WRITE) throw new Error('cannot --write before crm-push.sql has run'); }
  const sigs = await get('contract_signing?select=quote_ref,status,sent_at,signed_at&order=id&limit=1000');
  const sigMap = {}; sigs.forEach(s => { sigMap[s.quote_ref] = s; });   // ascending id → latest wins

  const pendingFor = (rec) => {   // mirrors index.html crmPendingEvents()
    const p = rec.crm_pushed || {}, out = [];
    if (!rec.isDesign) {
      const ev = STATUS_EVENT[rec.status];
      if (ev && newer(rec.status_changed_at, p[ev])) out.push(ev);
      if (rec.status !== 'Accepted') return out;
    }
    const cm = rec.contract_meta;
    if (cm && cm.generatedAt && newer(cm.generatedAt, p.contract_generated)) out.push('contract_generated');
    const sig = sigMap[rec.ref];
    if (sig && sig.status !== 'revoked' && newer(sig.sent_at, p.contract_sent)) out.push('contract_sent');
    if (sig && sig.status === 'signed' && newer(sig.signed_at, p.contract_signed)) out.push('contract_signed');
    return out;
  };
  const targets = [];
  quotes.forEach(q => { const ev = pendingFor({ ...q, isDesign: false }); if (ev.length) targets.push({ table: 'quotes', ref: q.ref, events: ev, prev: q.crm_pushed || {}, linked: !!q.airtable_card_id }); });
  dcs.forEach(d => { const ev = pendingFor({ ...d, isDesign: true }); if (ev.length) targets.push({ table: 'design_contracts', ref: d.ref, events: ev, prev: d.crm_pushed || {}, linked: !!d.airtable_card_id }); });

  console.log((LIVE ? 'LIVE' : 'SANDBOX') + ' — ' + targets.length + ' record(s) with pending events' + (WRITE ? ' — STAMPING' : ' — dry run'));
  targets.forEach(t => console.log('  ' + t.ref.padEnd(8) + (t.linked ? 'linked  ' : 'UNLINKED') + '  ' + t.events.join(', ')));
  if (!WRITE) { console.log('nothing written (add --write)'); return; }
  const now = new Date().toISOString();
  let n = 0;
  for (const t of targets) {
    const crm_pushed = { ...t.prev }; t.events.forEach(e => { crm_pushed[e] = now; crm_pushed['~' + e] = 'cleared'; });   // ~event = never sent (app hides it from Recently pushed)
    const r = await fetch(URL_ + '/rest/v1/' + t.table + '?ref=eq.' + encodeURIComponent(t.ref), {
      method: 'PATCH', headers: { ...H, Prefer: 'return=representation' },
      body: JSON.stringify({ crm_pushed, last_pushed_at: now, last_push_event: 'cleared:' + t.events.join('+') }),
    });
    const rows = r.ok ? await r.json() : [];
    if (!r.ok || rows.length !== 1) throw new Error('PATCH ' + t.ref + ' failed: HTTP ' + r.status + ' rows=' + rows.length);
    n++;
  }
  console.log('stamped ' + n + ' record(s); no Airtable write was made');
}
main().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
