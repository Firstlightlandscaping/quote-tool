// Seeds company_settings.rams_library from the approved wording in plan-rams-content.md.
// SANDBOX by default; pass --live for the cutover (asks for explicit LIVE in the arg, no default).
// Idempotent: re-running overwrites the library (bump version manually via --version N if needed).
// Usage: node scripts/rams-seed.js [--live] [--dry-run]
const fs = require('fs');
const path = require('path');

const PROJ = path.join(__dirname, '..');
const env = {};
for (const line of fs.readFileSync(path.join(PROJ, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^([A-Za-z_]+)=(.*)$/);
  if (m) env[m[1]] = m[2].trim();
}
const LIVE = process.argv.includes('--live');
const DRY = process.argv.includes('--dry-run');
const URL_ = LIVE ? env.SUPABASE_URL : env.SUPABASE_SANDBOX_URL;
const KEY = LIVE ? env.SUPABASE_ANON_KEY : env.SUPABASE_SANDBOX_ANON_KEY;
const EMAIL = LIVE ? process.env.SUPABASE_AGENT_EMAIL : env.SANDBOX_AGENT_EMAIL;
const PASS = LIVE ? process.env.SUPABASE_AGENT_PASSWORD : env.SANDBOX_AGENT_PASSWORD;
if (!URL_ || !KEY || !EMAIL || !PASS) throw new Error('missing creds for ' + (LIVE ? 'LIVE' : 'sandbox'));
console.log('TARGET:', LIVE ? '⚠ LIVE' : 'sandbox', URL_);

// ── parse plan-rams-content.md ──────────────────────────────────────────────
let src = fs.readFileSync(path.join(PROJ, 'plan-rams-content.md'), 'utf8');
src = src.replace(/ — NEAL-APPROVED/g, '');
src = src.replace(/\s*\*\(⚠ NEAL:[\s\S]*?\)\*/g, '');   // internal action notes never reach the library

const lines = src.split(/\r?\n/);
const sections = {};
let cur = null, buf = [];
for (const line of lines) {
  const m = line.match(/^#{1,2} (.+)$/);
  if (m) { if (cur) sections[cur] = buf.join('\n').trim(); cur = m[1].trim(); buf = []; }
  else if (cur) buf.push(line);
}
if (cur) sections[cur] = buf.join('\n').trim();

const grab = (prefix) => {
  const k = Object.keys(sections).find(k => k.startsWith(prefix));
  if (!k) throw new Error('missing section ' + prefix);
  return { title: k.replace(/^[A-C]\d+\.\s*/, ''), body: sections[k] };
};

// markdown body -> sanitizer-safe HTML (b/i/br/ul/ol/li only — matches cwSanitizeHtml's whitelist)
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const inline = s => esc(s)
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/\*([^*]+)\*/g, '<i>$1</i>');
function mdToHtml(body) {
  const out = [];
  let list = null; // {type:'ul'|'ol', items:[]}
  const flush = () => { if (list) { out.push(`<${list.type}>` + list.items.map(i => `<li>${i}</li>`).join('') + `</${list.type}>`); list = null; } };
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) { flush(); continue; }
    if (line.startsWith('*Categories:')) continue;   // category note lives in mapping, not the doc text
    let m;
    if ((m = line.match(/^- (.+)$/))) {
      if (!list || list.type !== 'ul') { flush(); list = { type: 'ul', items: [] }; }
      list.items.push(inline(m[1]));
    } else if ((m = line.match(/^\d+\. (.+)$/))) {
      if (!list || list.type !== 'ol') { flush(); list = { type: 'ol', items: [] }; }
      list.items.push(inline(m[1]));
    } else {
      flush();
      out.push(inline(line));
    }
  }
  flush();
  return out.join('<br>').replace(/(<\/(?:ul|ol)>)<br>/g, '$1');
}

// Keyword rules for MISC quote lines (no category, so the mapping can't see them):
// a misc line whose name/description matches a keyword auto-ticks that module in the
// review, with provenance shown — the reviewer prunes false matches. Matched with a
// \b word-boundary prefix ('post' must not fire on "compost"); open-ended suffix so
// 'excavat' catches excavate/excavation.
const MODULE_KEYWORDS = {
  C1: ['excavat', 'dig out', 'dig-out', 'strip', 'clearance', 'grub', 'reduce level'],
  C2: ['waste', 'skip', 'muck away', 'grab', 'tip run'],
  C3: ['concrete', 'footing', 'foundation'],
  C4: ['wall', 'masonry', 'brick', 'blockwork', 'coping', 'pier'],
  C5: ['paving', 'porcelain', 'flag', 'slab', 'patio', 'sandstone', 'limestone', 'yorkstone', 'cobble', 'sett'],
  C6: ['block pav', 'soldier', 'edging', 'kerb'],
  C7: ['gravel', 'aggregate', 'chipping', 'pebble'],
  C8: ['resin', 'rubber mulch'],
  C9: ['fence', 'fencing', 'gate', 'post', 'featherboard', 'closeboard', 'trellis', 'clad'],
  C10: ['deck', 'pergola', 'handrail', 'balustrade', 'arbour'],
  C11: ['sleeper'],
  C12: ['aluminium pergola', 'hygge', 'louvre'],
  C13: ['turf', 'topsoil', 'lawn', 'plant', 'tree', 'hedge', 'shrub', 'bark'],
  C14: ['artificial grass', 'artificial turf', 'astro'],
  C15: ['render', 'k-rend', 'krend'],
  C16: ['drain', 'soakaway', 'aco', 'gully'],
};

const core = Array.from({ length: 11 }, (_, i) => { const s = grab(`A${i + 1}.`); return { id: `A${i + 1}`, title: s.title, html: mdToHtml(s.body) }; });
const modifiers = Array.from({ length: 5 }, (_, i) => { const s = grab(`B${i + 1}.`); return { id: `B${i + 1}`, title: s.title, html: mdToHtml(s.body), defaultOn: true }; });
const modules = Array.from({ length: 16 }, (_, i) => { const s = grab(`C${i + 1}.`); return { id: `C${i + 1}`, title: s.title, html: mdToHtml(s.body), keywords: MODULE_KEYWORDS[`C${i + 1}`] || [] }; });
const ppeS = grab('PPE summary');
const docS = grab('Document header and sign-off wording');

// pull the three doc-text blocks out of the header section by their bold labels
const dt = docS.body;
const block = (label) => {
  const re = new RegExp(`\\*\\*${label}[^*]*\\*\\*\\s*\\n"([\\s\\S]*?)"`, '');
  const m = dt.match(re);
  if (!m) throw new Error('docText block not found: ' + label);
  return m[1].replace(/\s*\n\s*/g, ' ').trim();
};

// category -> module mapping (evaluated top-down; first entry whose category matches
// AND (no nameMatch OR the line name matches) contributes its modules)
const mapping = [
  { category: 'WASTE AND EXC', modules: ['C1', 'C2'] },
  { category: 'GROUNDWORKS', modules: ['C1', 'C13'] },
  { category: 'WALLING', modules: ['C3', 'C4'] },
  { category: 'COPINGS', modules: ['C4'] },
  { category: 'PAVING', modules: ['C5'] },
  { category: 'PAVING LS', modules: ['C5'] },
  { category: 'PORCELAIN', modules: ['C5'] },
  { category: 'PAVING COBBLES', modules: ['C5'] },
  { category: 'PORCELAIN CLAD', modules: ['C5'] },
  { category: 'BLOCK PAVING', modules: ['C6'] },
  { category: 'BP Soldier Course', modules: ['C6'] },
  { category: 'EDGING', modules: ['C6'] },
  { category: 'GRAVEL', modules: ['C7'] },
  { category: 'SURFACES', modules: ['C8'] },
  { category: 'FENCING', modules: ['C9'] },
  { category: 'CLAD FENCING', modules: ['C9'] },
  { category: 'POSTS', modules: ['C9'] },
  { category: 'DECKING', modules: ['C10'] },
  { category: 'PERGOLA', modules: ['C10'] },
  { category: 'HAND RAIL', modules: ['C10'] },
  { category: 'TIMBER', modules: ['C10'] },
  { category: 'SLEEPERS', modules: ['C11'] },
  { category: 'ALUMINIUM PERGOLA', modules: ['C12'] },
  { category: 'TURF', modules: ['C14'], nameMatch: 'artificial' },
  { category: 'TURF', modules: ['C13'] },
  { category: 'RENDER', modules: ['C15'] },
  { category: 'DRAINAGE', modules: ['C16'] },
];

// App-managed lists that live INSIDE rams_library but are NOT wording: re-seeding must
// preserve what the app has accumulated (added hospitals/leads), seeding defaults only
// when the target has none. Fetched from the target before the write, below.
// PERSONAL DATA RULE: employee names and mobiles are NEVER written to this public
// repo. The crew list (operatives), site leads (names + mobiles) and any additions
// live ONLY in the DB (rams_library) — added in-app or by gitignored one-off scripts,
// PRESERVED by this seed's carry-over below, and PORTED sandbox→live at cutover.
const OPERATIVES_SEED = [];   // intentionally empty — see rule above
const HOSPITALS_SEED = [
  'Leeds General Infirmary — Great George Street, Leeds LS1 3EX (ED entrance: Jubilee Wing, LS2 9DA)',
  'St James’s University Hospital — Beckett Street, Leeds LS9 7TF',
  'Harrogate District Hospital — Lancaster Park Road, Harrogate HG2 7SX',
  'Pinderfields Hospital — Aberford Road, Wakefield WF1 4DG',
  'Bradford Royal Infirmary — Duckworth Lane, Bradford BD9 6RJ',
];

const vArg = process.argv.indexOf('--version');
const library = {
  version: vArg > -1 ? Number(process.argv[vArg + 1]) : 1,
  updatedAt: new Date().toISOString(),
  updatedBy: EMAIL,
  core, modifiers, modules, mapping,
  ppe: { title: 'PPE summary', html: mdToHtml(ppeS.body) },
  docText: {
    opening: block('Opening statement'),
    declaration: block('Sign-off declaration'),
    revisionRule: block('Revision rule'),
    workingHours: 'Mon–Fri 8am–4pm',
  },
};

console.log(`parsed: core ${core.length}, modifiers ${modifiers.length}, modules ${modules.length}, mapping ${mapping.length}; json ${JSON.stringify(library).length} chars`);
if (DRY) { console.log('dry run — nothing written'); process.exitCode = 0; }
else {
  (async () => {
    const auth = await fetch(URL_ + '/auth/v1/token?grant_type=password', {
      method: 'POST', headers: { apikey: KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: EMAIL, password: PASS }),
    });
    if (!auth.ok) throw new Error('login failed ' + auth.status);
    const token = (await auth.json()).access_token;
    // preserve app-managed lists across re-seeds (consultant tweaks must never wipe them)
    const prevR = await fetch(URL_ + '/rest/v1/company_settings?id=eq.1&select=rams_library', {
      headers: { apikey: KEY, Authorization: 'Bearer ' + token },
    });
    const prev = prevR.ok ? ((await prevR.json())[0] || {}).rams_library : null;
    library.hospitals = (prev && Array.isArray(prev.hospitals) && prev.hospitals.length) ? prev.hospitals : HOSPITALS_SEED;
    library.leads = (prev && Array.isArray(prev.leads)) ? prev.leads : [];
    library.operatives = (prev && Array.isArray(prev.operatives) && prev.operatives.length) ? prev.operatives : OPERATIVES_SEED;
    // App-SAVED site conditions (defaultOn:false, created via the review dialog's
    // save-as-condition flow) live only in the DB — carry them across re-seeds.
    const savedConds = (prev && Array.isArray(prev.modifiers)) ? prev.modifiers.filter(m => m && m.defaultOn === false) : [];
    library.modifiers = [...library.modifiers, ...savedConds];
    if (savedConds.length) console.log('saved conditions preserved:', savedConds.length);
    // App-saved WORK MODULES (ids CX…, created via save-as-module) — same carry-over.
    const savedMods = (prev && Array.isArray(prev.modules)) ? prev.modules.filter(m => m && !/^C\d+$/.test(m.id)) : [];
    library.modules = [...library.modules, ...savedMods];
    if (savedMods.length) console.log('saved modules preserved:', savedMods.length);
    // App-managed maps (2026-09-05): crew email addresses (personal data — DB only) and the
    // crew email wording (edited in-app, "✉ Email wording" in the RAMS panel). Both were
    // silently WIPED by a re-seed before this — carry them across.
    if (prev && prev.operativeEmails && typeof prev.operativeEmails === 'object') library.operativeEmails = prev.operativeEmails;
    if (prev && prev.emailTemplates && typeof prev.emailTemplates === 'object') library.emailTemplates = prev.emailTemplates;
    console.log('crew emails preserved:', Object.keys(library.operativeEmails || {}).length, '| email wording:', library.emailTemplates ? 'custom preserved' : 'defaults');
    console.log('lists: hospitals', library.hospitals.length, (prev && prev.hospitals && prev.hospitals.length ? '(preserved)' : '(seeded)'), '| leads', library.leads.length, '| operatives', library.operatives.length, (prev && prev.operatives && prev.operatives.length ? '(preserved)' : '(seeded)'));
    const r = await fetch(URL_ + '/rest/v1/company_settings?id=eq.1', {
      method: 'PATCH',
      headers: { apikey: KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ rams_library: library }),
    });
    if (!r.ok) throw new Error('PATCH failed ' + r.status + ' ' + (await r.text()).slice(0, 300));
    const rows = await r.json();
    if (rows.length !== 1) throw new Error('PATCH affected ' + rows.length + ' rows');
    const got = rows[0].rams_library;
    console.log('SEEDED version', got.version, '| core', got.core.length, '| modifiers', got.modifiers.length, '| modules', got.modules.length);
  })().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
}
