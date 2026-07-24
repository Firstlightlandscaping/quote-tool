// Wipe & replace the SANDBOX from a backup file. HARD-GUARDED to the sandbox project -
// refuses to run if the target URL is not the sandbox ref, so it can never touch live.
// Also advances note: identity sequences must be bumped after restore (see sb-mgmt-query.ps1);
// the June lesson was that stale sequences make the next auto-id INSERT collide (23505).
// Usage: node scripts/fl-restore-sandbox.js <backup-file.json>
const fs = require('fs');
const path = require('path');

const PROJ = path.join(__dirname, '..');
const SANDBOX_REF = 'erbrflbialsyxbjawopy';
const env = {};
for (const line of fs.readFileSync(path.join(PROJ, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const URL_ = env.SUPABASE_SANDBOX_URL, KEY = env.SUPABASE_SANDBOX_SERVICE_KEY;
if (!URL_ || !KEY) throw new Error('.env missing SUPABASE_SANDBOX_URL / SUPABASE_SANDBOX_SERVICE_KEY');
if (!URL_.includes(SANDBOX_REF)) throw new Error('SAFETY STOP: target is not the sandbox: ' + URL_);

const file = process.argv[2];
if (!file) throw new Error('usage: node scripts/fl-restore-sandbox.js <backup-file.json>');
const backup = JSON.parse(fs.readFileSync(file, 'utf8'));

// parents first (matches the app's RESTORE_ORDER + qt_counter)
const ORDER = ['company_settings', 'deliverables', 'mpl', 'staff', 'group_templates', 'quotes', 'materials', 'quote_lines', 'qt_counter'];
const PK = { quotes: 'ref', deliverables: 'code', mpl: 'code' }; // rest keyed on id

const H = { apikey: KEY, Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' };

async function main() {
  // wipe children first (reverse order)
  for (const t of [...ORDER].reverse()) {
    if (!(t in backup.tables)) { console.log(`  skip wipe ${t} (not in backup)`); continue; }
    const pk = PK[t] || 'id';
    const r = await fetch(`${URL_}/rest/v1/${t}?${pk}=not.is.null`, { method: 'DELETE', headers: H });
    if (!r.ok) throw new Error(`wipe ${t} failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
  }
  console.log('  wiped all tables');

  for (const t of ORDER) {
    const rows = backup.tables[t];
    if (!rows) continue;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const r = await fetch(`${URL_}/rest/v1/${t}`, {
        method: 'POST', headers: { ...H, Prefer: 'return=minimal' }, body: JSON.stringify(chunk),
      });
      if (!r.ok) throw new Error(`insert ${t} @${i} failed: ${r.status} ${(await r.text()).slice(0, 300)}`);
    }
    console.log(`  ${t}: inserted ${rows.length}`);
  }

  console.log('  verify counts:');
  let allOk = true;
  for (const t of ORDER) {
    if (!(t in backup.tables)) continue;
    const r = await fetch(`${URL_}/rest/v1/${t}?select=*&limit=1`, {
      method: 'HEAD', headers: { ...H, Prefer: 'count=exact' },
    });
    const got = parseInt((r.headers.get('content-range') || '/0').split('/')[1], 10);
    const want = backup.tables[t].length;
    const ok = got === want;
    if (!ok) allOk = false;
    console.log(`    ${t}: ${got}/${want} ${ok ? 'OK' : 'MISMATCH'}`);
  }
  console.log(allOk ? 'RESTORE COMPLETE - all counts match' : 'RESTORE FINISHED WITH MISMATCHES');
  if (!allOk) process.exitCode = 1;
}

main().catch((e) => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
