#!/usr/bin/env node
// Push a saved schedule plan to TeamGantt.
//
// Usage:
//   node scripts/push-to-teamgantt.js QT-0038            real push ("QT-0038 Customer")
//   node scripts/push-to-teamgantt.js QT-0038 --test     test push ("ZZZ TEST QT-0038 Customer")
//   node scripts/push-to-teamgantt.js QT-0038 --dry-run  print what would be pushed, write nothing
//   node scripts/push-to-teamgantt.js --delete-project <id> --yes   delete a ZZZ test project
//
// Reads the quote's plan.tg — the push-ready export the APP serialises on every
// "Save plan" (spExportForPush in index.html). This script writes it to TeamGantt
// verbatim and never recomputes rollups/edits/splits; if the data looks wrong in
// TeamGantt, fix the app-side export, re-save the plan, delete and re-push.
//
// Credentials (never hardcoded, never printed):
//   TEAMGANTT_TOKEN                        TeamGantt personal access token
//   SUPABASE_AGENT_EMAIL / _PASSWORD       the read-only agent login
//   SUPABASE_URL / SUPABASE_ANON_KEY       from env, or read from .env in the repo root
//
// TeamGantt facts (all verified against the real account):
//   company 516292 · template project 4502067 ("Firstlight Landscaping Template")
//   GET  /v1/groups?project_ids={id}   GET /v1/tasks?project_ids={id}
//   POST /v1/projects {name, company_id, template}   clones the template's 7 groups
//   The template is NOT empty — placeholder tasks ship with it. Matching placeholders
//   (deadline milestone, a same-named delivery like "GH Brooks") are UPDATED, never
//   duplicated; everything else is left alone for manual planning.

const fs = require('fs');
const path = require('path');

const TG = 'https://api.teamgantt.com/v1';
const COMPANY_ID = 516292;
const TEMPLATE_ID = 4502067;
const DEADLINE_MILESTONE = 'allocated days and deadline'; // template name has a trailing space — compare normalised

// ── env / args ────────────────────────────────────────────────────────────────
function loadDotEnv() {
  const p = path.join(__dirname, '..', '.env');
  if (!fs.existsSync(p)) return;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const args = process.argv.slice(2);
const flag = f => args.includes(f);
const ref = args.find(a => !a.startsWith('--'));
const norm = s => (s || '').trim().toLowerCase();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tg(method, p, body) {
  const res = await fetch(TG + p, {
    method,
    headers: { Authorization: 'Bearer ' + process.env.TEAMGANTT_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
  if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return (data && data.data !== undefined) ? data.data : data; // some endpoints wrap in {data}
}

// ── delete mode (guarded: only projects named ZZZ…) ──────────────────────────
async function deleteProject(id) {
  if (!flag('--yes')) throw new Error('Refusing to delete without --yes');
  const proj = await tg('GET', '/projects/' + id);
  const name = (proj && proj.name) || '';
  if (!/^zzz/i.test(name.trim())) {
    throw new Error(`Refusing: project ${id} is "${name}" — this script only deletes ZZZ test projects.`);
  }
  await tg('DELETE', '/projects/' + id);
  console.log(`Deleted test project ${id} ("${name}")`);
}

// ── read the plan from Supabase (agent login, read-only) ─────────────────────
async function fetchPlan(ref) {
  const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_ANON_KEY;
  const auth = await fetch(URL_ + '/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: process.env.SUPABASE_AGENT_EMAIL, password: process.env.SUPABASE_AGENT_PASSWORD })
  });
  if (!auth.ok) throw new Error('Supabase login failed: HTTP ' + auth.status);
  const token = (await auth.json()).access_token;
  const res = await fetch(`${URL_}/rest/v1/quotes?ref=eq.${encodeURIComponent(ref)}&select=ref,customer,schedule_plan`, {
    headers: { apikey: KEY, Authorization: 'Bearer ' + token }
  });
  if (!res.ok) throw new Error('Quote fetch failed: HTTP ' + res.status);
  const rows = await res.json();
  if (!rows.length) throw new Error(`Quote ${ref} not found.`);
  return rows[0];
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  loadDotEnv();

  const delIdx = args.indexOf('--delete-project');
  if (delIdx >= 0) {
    if (!process.env.TEAMGANTT_TOKEN) { console.error('TEAMGANTT_TOKEN not set'); process.exit(1); }
    return deleteProject(args[delIdx + 1]);
  }

  if (!ref || !/^QT-/i.test(ref)) { console.error('Usage: node scripts/push-to-teamgantt.js QT-00xx [--test] [--dry-run]'); process.exit(1); }
  for (const v of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_AGENT_EMAIL', 'SUPABASE_AGENT_PASSWORD']) {
    if (!process.env[v]) { console.error(v + ' not set'); process.exit(1); }
  }

  const quote = await fetchPlan(ref);
  const plan = quote.schedule_plan;
  const t = plan && plan.tg;
  if (!t) {
    throw new Error(`Quote ${ref} has no push-ready export (plan.tg).\n` +
      'Open the quote in the app -> Schedule tab -> Save plan (the save regenerates the export), then re-run.');
  }
  const stale = plan.updatedAt ? ` (plan saved ${plan.updatedAt})` : '';
  console.log(`Plan for ${quote.ref} — ${quote.customer}${stale}`);
  console.log(`  start ${t.startDate || '—'} · deadline ${t.deadline || '—'} · ${t.tasks.length} tasks · ${t.deliveries.length} deliveries`);

  // ── dry run: show the exact mapping, write nothing ──
  if (flag('--dry-run')) {
    console.log('\n— DRY RUN (nothing written) —');
    t.tasks.forEach((k, i) => console.log(`  task ${i + 1}. ${k.name}  ${k.start || '?'} -> ${k.end || '?'}  (${k.days}d, ${k.men} men)`));
    t.deliveries.forEach(d => {
      console.log(`  delivery: ${d.unassigned ? '⚠ ' : ''}${d.name}  ${d.date || 'no date'}  (${d.checklist.length} items${d.links.length ? ', ' + d.links.length + ' links' : ''})`);
      d.checklist.forEach(c => console.log(`      · ${c}`));
      d.links.forEach(l => console.log(`      🔗 ${l.desc}: ${l.url}`));
    });
    return;
  }

  if (!process.env.TEAMGANTT_TOKEN) throw new Error('TEAMGANTT_TOKEN not set');

  // ── 1. create the project from the template ──
  const projName = (flag('--test') ? 'ZZZ TEST ' : '') + `${quote.ref} ${quote.customer || ''}`.trim();
  console.log(`\nCreating project "${projName}" from template ${TEMPLATE_ID}…`);
  const proj = await tg('POST', '/projects', { name: projName, company_id: COMPANY_ID, template: TEMPLATE_ID });
  const pid = proj.id;
  if (!pid) throw new Error('Project created but no id in response');
  console.log(`  project id ${pid}`);
  await sleep(500); // let the template clone settle before reading it back

  // ── 2. find the cloned groups + placeholder tasks ──
  const groups = await tg('GET', '/groups?project_ids=' + pid);
  const findGroup = n => (groups || []).find(g => norm(g.name) === n);
  const pb = findGroup('project breakdown');
  const dl = findGroup('deliveries');
  if (!pb || !dl) throw new Error('Cloned project is missing the Project Breakdown / Deliveries groups — template changed?');
  const existing = await tg('GET', '/tasks?project_ids=' + pid) || [];

  // ── 3. deadline: UPDATE the template's milestone (never duplicate) ──
  if (t.deadline) {
    const ms = existing.find(x => x.type === 'milestone' && norm(x.name).includes(DEADLINE_MILESTONE));
    if (ms) {
      await tg('PATCH', '/tasks/' + ms.id, { start_date: t.deadline, end_date: t.deadline });
      console.log(`  deadline milestone -> ${t.deadline} (updated placeholder ${ms.id})`);
    } else {
      await tg('POST', '/tasks', { project_id: pid, parent_group_id: pb.id, name: 'Allocated days and deadline', type: 'milestone', start_date: t.deadline, end_date: t.deadline });
      console.log(`  deadline milestone -> ${t.deadline} (template placeholder missing; created new)`);
    }
    await sleep(150);
  }

  // ── 4. Project Breakdown tasks (dates only, no dependencies — deliberate) ──
  for (const k of t.tasks) {
    const body = { project_id: pid, parent_group_id: pb.id, name: k.name, type: 'task' };
    if (k.start) { body.start_date = k.start; body.end_date = k.end || k.start; }
    await tg('POST', '/tasks', body);
    console.log(`  + task: ${k.name} ${k.start ? `(${k.start} -> ${k.end})` : '(no dates)'}`);
    await sleep(150);
  }

  // ── 5. Deliveries: reuse a same-named placeholder (e.g. "GH Brooks") else create ──
  // Created delivery tasks inherit the COLOUR of the template's delivery placeholder
  // (red1 = the crew's "not ordered yet"; they turn tasks green once ordered). Without
  // this, created tasks defaulted to TeamGantt blue2 and broke the convention
  // (Neal, 2026-07-16). Presentation constant, so it lives here, not in plan.tg.
  const templateDeliv = existing.find(x => x.parent_group_id === dl.id && x.color);
  const deliveryColor = (templateDeliv && templateDeliv.color) || 'red1';
  let noteWarnings = 0;
  for (const d of t.deliveries) {
    const name = (d.unassigned && !/⚠/.test(d.name) ? '⚠ ' : '') + d.name;
    const placeholder = existing.find(x => x.parent_group_id === dl.id && norm(x.name) === norm(d.name));
    let taskId;
    if (placeholder) {
      taskId = placeholder.id;
      if (d.date) await tg('PATCH', '/tasks/' + taskId, { start_date: d.date, end_date: d.date });
      console.log(`  ~ delivery: ${name} (reused placeholder ${taskId})${d.date ? ' -> ' + d.date : ''}`);
    } else {
      const body = { project_id: pid, parent_group_id: dl.id, name, type: 'task', color: deliveryColor };
      if (d.date) { body.start_date = d.date; body.end_date = d.date; }
      const made = await tg('POST', '/tasks', body);
      taskId = made.id;
      console.log(`  + delivery: ${name} ${d.date ? `(${d.date})` : '(no date)'}`);
    }
    for (const line of d.checklist) {
      await tg('POST', `/tasks/${taskId}/checklist_items`, { name: line, is_complete: false });
      await sleep(100);
    }
    console.log(`      ${d.checklist.length} checklist items`);
    if (d.links.length) {
      // HTML note = CLICKABLE links (proven 2026-07-23: the comments API stores HTML
      // verbatim and the notes editor renders it; markdown stays literal text).
      // Presentation formatting, so it lives here — same rule as the delivery colour.
      const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const note = d.links.map(l => `<p><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.desc || l.url)}</a></p>`).join('');
      try {
        await tg('POST', `/tasks/${taskId}/comments`, { type: 'note', message: note });
        console.log('      note with ' + d.links.length + ' link(s)');
      } catch (e1) {
        try { // field name fallback — the blueprint is ambiguous between message/body
          await tg('POST', `/tasks/${taskId}/comments`, { type: 'note', body: note });
          console.log('      note with ' + d.links.length + ' link(s)');
        } catch (e2) { noteWarnings++; console.log('      ⚠ note failed: ' + e2.message); }
      }
    }
    await sleep(150);
  }

  console.log(`\nDone. Project "${projName}" (id ${pid}) — check it in TeamGantt.`);
  if (noteWarnings) console.log(`⚠ ${noteWarnings} note(s) failed — links may need adding by hand.`);
  if (flag('--test')) console.log(`When finished reviewing: node scripts/push-to-teamgantt.js --delete-project ${pid} --yes`);
}

// process.exitCode (not process.exit) — a hard exit mid-teardown of fetch's keepalive
// sockets crashes libuv on Windows (async.c assertion).
main().catch(e => { console.error('FAILED: ' + e.message); process.exitCode = 1; });
