// Fresh LIVE backup -> firstlight-backup-*.json in the project root (gitignored pattern).
// READ-ONLY against live. Creds: .env (URL + anon key) + env vars (agent login). Nothing hardcoded.
// Usage: node scripts/fl-backup.js
const fs = require('fs');
const path = require('path');

const PROJ = path.join(__dirname, '..');
const env = {};
for (const line of fs.readFileSync(path.join(PROJ, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL_ = env.SUPABASE_URL, KEY = env.SUPABASE_ANON_KEY;
const EMAIL = process.env.SUPABASE_AGENT_EMAIL, PASS = process.env.SUPABASE_AGENT_PASSWORD;
if (!URL_ || !KEY) throw new Error('.env missing SUPABASE_URL / SUPABASE_ANON_KEY');
if (!EMAIL || !PASS) throw new Error('SUPABASE_AGENT_EMAIL / _PASSWORD not in environment');

// table -> stable total-order for paging (matches the app's tiebreaker rule)
const TABLES = {
  quotes: 'ref', quote_lines: 'id', deliverables: 'code', materials: 'id',
  mpl: 'code', staff: 'id', group_templates: 'id', company_settings: 'id', qt_counter: 'id',
  contract_signing: 'id',
};
// May not exist yet on the target DB (schema rolls out sandbox-first) — skip, don't abort.
const OPTIONAL = new Set(['contract_signing']);

async function main() {
  const auth = await fetch(URL_ + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  });
  if (!auth.ok) throw new Error('agent login failed: ' + auth.status + ' ' + (await auth.text()).slice(0, 200));
  const token = (await auth.json()).access_token;
  const H = { apikey: KEY, Authorization: 'Bearer ' + token };

  const tables = {}, counts = {};
  for (const [t, ord] of Object.entries(TABLES)) {
    const rows = [];
    let absent = false;
    for (let off = 0; ; off += 1000) {
      const r = await fetch(`${URL_}/rest/v1/${t}?select=*&order=${ord}&limit=1000&offset=${off}`, { headers: H });
      if (r.status === 404 && OPTIONAL.has(t)) { absent = true; break; }
      if (!r.ok) throw new Error(`${t} fetch failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
      const chunk = await r.json();
      rows.push(...chunk);
      if (chunk.length < 1000) break;
    }
    if (absent) { console.log(`  ${t}: absent on this DB - skipped`); continue; }
    tables[t] = rows;
    counts[t] = rows.length;
    console.log(`  ${t}: ${rows.length} rows`);
  }

  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const file = path.join(PROJ, `firstlight-backup-${stamp}.json`);
  fs.writeFileSync(file, JSON.stringify({
    app: 'firstlight-quote-tool', version: 2, exportedAt: now.toISOString(),
    source: URL_, note: 'scripted backup (scripts/fl-backup.js)',
    counts, tables,
  }));
  console.log('WROTE ' + file);
}

main().catch((e) => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
