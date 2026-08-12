// Edge Function: push a saved schedule plan to TeamGantt.
//
// This is the server-side twin of scripts/push-to-teamgantt.js — same TeamGantt
// logic, but triggered by the app's "Push to TeamGantt" button instead of the CLI,
// so the TeamGantt token lives here as a secret and never ships in the public page.
// The local script stays as the debug fallback; keep the two in step when either changes.
//
// Trigger: POST from the app with the caller's Supabase login (verify_jwt gates it —
// only logged-in staff can call it). Body: { "ref": "QT-0001", "mode": "push" | "test" | "dry-run" }.
//   push     -> creates "QT-0001 Customer"          (real)
//   test     -> creates "ZZZ TEST QT-0001 Customer" (throwaway; delete via the CLI script)
//   dry-run  -> reads the plan, returns what WOULD be pushed, writes nothing to TeamGantt
//
// Reads quotes.schedule_plan.tg — the push-ready export the APP serialises on every
// "Save plan" (spExportForPush in index.html). Writes it to TeamGantt VERBATIM; never
// recomputes rollups/edits/splits. If the data looks wrong in TeamGantt, fix the
// app-side export, re-save the plan, delete the project, re-push.
//
// Secrets/env:
//   TEAMGANTT_TOKEN                              set via `supabase secrets set` (step 3)
//   SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY     auto-injected by the platform
//
// TeamGantt facts (verified against the real account):
//   company 516292 · template project 4502067 ("Firstlight Landscaping Template")
//   POST /v1/projects {name, company_id, template} clones the template's 7 groups.
//   The template ships with placeholder tasks; matching ones (deadline milestone, a
//   same-named delivery like "GH Brooks") are UPDATED not duplicated; the rest left alone.

const TG = "https://api.teamgantt.com/v1";
const COMPANY_ID = 516292;
const TEMPLATE_ID = 4502067;
const DEADLINE_MILESTONE = "allocated days and deadline"; // template name has a trailing space — compare normalised

const CORS = {
  "Access-Control-Allow-Origin": "*", // the JWT gate is the real protection, not CORS
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const norm = (s: string) => (s || "").trim().toLowerCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
// Labour-note rounding: UP to the nearest half (Neal's pick), with a small tolerance
// so float noise never bumps a clean figure (27.0000001 stays 27, not 27.5).
const upHalf = (x: number) => Math.ceil(x * 2 - 0.001) / 2;
const halfFmt = (v: number) => (v * 2) % 2 ? v.toFixed(1) : String(v);

async function tg(method: string, p: string, body?: unknown) {
  const res = await fetch(TG + p, {
    method,
    headers: {
      Authorization: "Bearer " + Deno.env.get("TEAMGANTT_TOKEN"),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch (_e) { /* non-JSON */ }
  if (!res.ok) throw new Error(`${method} ${p} -> HTTP ${res.status}: ${text.slice(0, 300)}`);
  return (data && data.data !== undefined) ? data.data : data; // some endpoints wrap in {data}
}

// Read the quote's plan using the service role key (auto-injected). The caller is already
// proven to be a logged-in staff member by verify_jwt, so service-role read is fine here.
async function fetchPlan(ref: string) {
  const URL_ = Deno.env.get("SUPABASE_URL");
  const KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const res = await fetch(
    `${URL_}/rest/v1/quotes?ref=eq.${encodeURIComponent(ref)}&select=ref,customer,schedule_plan`,
    { headers: { apikey: KEY!, Authorization: "Bearer " + KEY } },
  );
  if (!res.ok) throw new Error("Quote fetch failed: HTTP " + res.status);
  const rows = await res.json();
  if (!rows.length) throw new Error(`Quote ${ref} not found.`);
  return rows[0];
}

async function handle(req: Request): Promise<Response> {
  const log: string[] = [];
  const say = (m: string) => log.push(m);
  const json = (status: number, extra: Record<string, unknown>) =>
    new Response(JSON.stringify({ log, ...extra }), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });

  let body: any = {};
  try { body = await req.json(); } catch (_e) { /* empty body */ }
  const ref: string = (body.ref || "").trim();
  const mode: string = body.mode || "push";

  if (!/^QT-/i.test(ref)) return json(400, { ok: false, error: "Missing or invalid quote ref (expected QT-…)." });
  if (!["push", "test", "dry-run"].includes(mode)) return json(400, { ok: false, error: "mode must be push, test or dry-run." });

  const quote = await fetchPlan(ref);
  const plan = quote.schedule_plan;
  const t = plan && plan.tg;
  if (!t) {
    return json(422, {
      ok: false,
      error: `Quote ${ref} has no saved push data. Open it in the app → Schedule → Save plan, then try again.`,
    });
  }

  const stale = plan.updatedAt ? ` (plan saved ${plan.updatedAt})` : "";
  say(`Plan for ${quote.ref} — ${quote.customer}${stale}`);
  say(`  start ${t.startDate || "—"} · deadline ${t.deadline || "—"} · ${t.tasks.length} tasks · ${t.deliveries.length} deliveries`);

  // ── dry run: show the exact mapping, write nothing ──
  if (mode === "dry-run") {
    say("— DRY RUN (nothing written) —");
    if (t.customerInfo && (t.customerInfo.addr1 || t.customerInfo.city || t.customerInfo.post))
      say("  customer info note: " + [t.customerInfo.name, t.customerInfo.addr1, t.customerInfo.city, t.customerInfo.post].filter(Boolean).join(", "));
    if (t.labour && t.labour.manDays > 0) {
      const team = Math.max(1, t.labour.teamSize || 1);
      say(`  labour note: ${halfFmt(upHalf(t.labour.manDays))} man-days ≈ ${halfFmt(upHalf(t.labour.manDays / team))} days, team of ${team}`);
    }
    if ((t.actions || []).length) {
      say("  things to action (" + t.actions.length + "):");
      t.actions.forEach((a: string) => say("      ☐ " + a));
    }
    t.tasks.forEach((k: any, i: number) => say(k.reminder
      ? `  reminder ${i + 1}. ${k.name}  ${k.start || "⚠ no date — will be skipped"}`
      : `  task ${i + 1}. ${k.name}  ${k.start || "?"} -> ${k.end || "?"}  (${k.days}d, ${k.men} men)`));
    t.deliveries.forEach((d: any) => {
      say(`  delivery: ${d.unassigned ? "⚠ " : ""}${d.name}  ${d.date || "no date"}  (${d.checklist.length} items${d.links.length ? ", " + d.links.length + " links" : ""})`);
      d.checklist.forEach((c: string) => say(`      · ${c}`));
      d.links.forEach((l: any) => say(`      🔗 ${l.desc}: ${l.url}`));
    });
    return json(200, { ok: true, dryRun: true });
  }

  if (!Deno.env.get("TEAMGANTT_TOKEN")) return json(500, { ok: false, error: "TEAMGANTT_TOKEN secret is not set on the function." });

  // ── 1. create the project from the template ──
  const projName = (mode === "test" ? "ZZZ TEST " : "") + `${quote.ref} ${quote.customer || ""}`.trim();
  say(`Creating project "${projName}" from template ${TEMPLATE_ID}…`);
  const proj = await tg("POST", "/projects", { name: projName, company_id: COMPANY_ID, template: TEMPLATE_ID });
  const pid = proj.id;
  if (!pid) throw new Error("Project created but no id in response");
  say(`  project id ${pid}`);
  await sleep(500); // let the template clone settle before reading it back

  // ── 2. find the cloned groups + placeholder tasks ──
  const groups = await tg("GET", "/groups?project_ids=" + pid);
  const findGroup = (n: string) => (groups || []).find((g: any) => norm(g.name) === n);
  const pb = findGroup("project breakdown");
  const dl = findGroup("deliveries");
  if (!pb || !dl) throw new Error("Cloned project is missing the Project Breakdown / Deliveries groups — template changed?");
  const existing = (await tg("GET", "/tasks?project_ids=" + pid)) || [];

  // ── 3. deadline: UPDATE the template's milestone (never duplicate) ──
  if (t.deadline) {
    const ms = existing.find((x: any) => x.type === "milestone" && norm(x.name).includes(DEADLINE_MILESTONE));
    if (ms) {
      await tg("PATCH", "/tasks/" + ms.id, { start_date: t.deadline, end_date: t.deadline });
      say(`  deadline milestone -> ${t.deadline} (updated placeholder ${ms.id})`);
    } else {
      await tg("POST", "/tasks", { project_id: pid, parent_group_id: pb.id, name: "Allocated days and deadline", type: "milestone", start_date: t.deadline, end_date: t.deadline });
      say(`  deadline milestone -> ${t.deadline} (template placeholder missing; created new)`);
    }
    await sleep(150);
  }

  // ── 3a. Quoted labour: two-line note on the deadline milestone (2026-08-11, Neal —
  // the crew see the man-days the quote pays for; deliberately NO £ figure and NO
  // £/man-day rate, either would give the labour value away). Rounding up to the
  // nearest half + the wording are presentation, so they live here (same rule as the
  // delivery colour). Old plan.tg without labour skips silently; a missing milestone
  // warns + skips. Keep in step with scripts/push-to-teamgantt.js.
  const lb = t.labour;
  if (lb && lb.manDays > 0) {
    const msTask = existing.find((x: any) => x.type === "milestone" && norm(x.name).includes(DEADLINE_MILESTONE));
    if (msTask) {
      const team = Math.max(1, lb.teamSize || 1);
      const md = upHalf(lb.manDays), days = upHalf(lb.manDays / team);
      const note = `<p><strong>Quoted labour: ${halfFmt(md)} man-day${md !== 1 ? "s" : ""} on site</strong></p>`
                 + `<p>≈ ${halfFmt(days)} working day${days !== 1 ? "s" : ""} as a team of ${team}</p>`;
      try {
        await tg("POST", `/tasks/${msTask.id}/comments`, { type: "note", message: note });
        say(`  labour note -> ${halfFmt(md)} man-days ≈ ${halfFmt(days)} days, team of ${team}`);
      } catch (_e1) {
        try { // field-name fallback — the blueprint is ambiguous between message/body
          await tg("POST", `/tasks/${msTask.id}/comments`, { type: "note", body: note });
          say("  labour note (body fallback)");
        } catch (e2) { say("  ⚠ labour note failed: " + (e2 as Error).message); }
      }
      await sleep(150);
    } else say('  ⚠ "Allocated days and deadline" milestone not found — labour note skipped');
  }

  // ── 3b. Customer information: address as a note on the template's placeholder
  // task (2026-08-06, Neal — the crew expect the client's address there; phone
  // isn't in the app, so address only). Old plan.tg without customerInfo skips
  // silently; a missing placeholder skips with a warning — never created, nothing
  // else changes. Keep in step with scripts/push-to-teamgantt.js.
  const ci = t.customerInfo;
  if (ci && (ci.addr1 || ci.city || ci.post)) {
    const ciTask = existing.find((x: any) => norm(x.name) === "customer information");
    if (ciTask) {
      const esc = (s: unknown) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const note = [ci.name, ci.addr1, ci.city, ci.post].filter(Boolean).map((v: string) => "<p>" + esc(v) + "</p>").join("");
      try {
        await tg("POST", `/tasks/${ciTask.id}/comments`, { type: "note", message: note });
        say("  customer information note -> " + [ci.addr1, ci.city, ci.post].filter(Boolean).join(", "));
      } catch (_e1) {
        try { // field-name fallback — the blueprint is ambiguous between message/body
          await tg("POST", `/tasks/${ciTask.id}/comments`, { type: "note", body: note });
          say("  customer information note (body fallback)");
        } catch (e2) { say("  ⚠ customer information note failed: " + (e2 as Error).message); }
      }
      await sleep(150);
    } else say('  ⚠ "Customer information" placeholder not found — address note skipped');
  }

  // ── 3c. Things to action: planning-time to-dos → CHECKLIST items on the template's
  // "Things to action" placeholder, so TeamGantt shows the outstanding count and the
  // crew tick them off (Neal, 2026-08-11). Old plan.tg without the field skips
  // silently; placeholder missing skips with a warning — never created. Keep in step
  // with scripts/push-to-teamgantt.js.
  const acts: string[] = t.actions || [];
  if (acts.length) {
    const atTask = existing.find((x: any) => norm(x.name) === "things to action");
    if (atTask) {
      for (const line of acts) {
        await tg("POST", `/tasks/${atTask.id}/checklist_items`, { name: line, is_complete: false });
        await sleep(100);
      }
      say("  things to action: " + acts.length + " checklist item(s)");
    } else say('  ⚠ "Things to action" placeholder not found — actions skipped');
  }

  // ── 4. Project Breakdown tasks (dates only, no dependencies — deliberate) ──
  // 📌 Reminders (2026-08-12, Neal): one-day tasks in GREY so they read differently
  // from work bars (colour = presentation, so it lives here — the delivery-red rule).
  // A reminder without a date can't land on a chart: warn + skip, never guess.
  for (const k of t.tasks) {
    if (k.reminder && !k.start) { say(`  ⚠ reminder "${k.name}" has no date — skipped`); continue; }
    const tb: any = { project_id: pid, parent_group_id: pb.id, name: k.name, type: "task" };
    if (k.reminder) tb.color = "grey1";
    if (k.start) { tb.start_date = k.start; tb.end_date = k.end || k.start; }
    await tg("POST", "/tasks", tb);
    say(k.reminder
      ? `  + reminder: ${k.name} (${k.start})`
      : `  + task: ${k.name} ${k.start ? `(${k.start} -> ${k.end})` : "(no dates)"}`);
    await sleep(150);
  }

  // ── 5. Deliveries: reuse a same-named placeholder (e.g. "GH Brooks") else create ──
  // Created delivery tasks inherit the COLOUR of the template's delivery placeholder
  // (red1 = the crew's "not ordered yet"; they turn tasks green once ordered).
  const templateDeliv = existing.find((x: any) => x.parent_group_id === dl.id && x.color);
  const deliveryColor = (templateDeliv && templateDeliv.color) || "red1";
  let noteWarnings = 0;
  for (const d of t.deliveries) {
    const name = (d.unassigned && !/⚠/.test(d.name) ? "⚠ " : "") + d.name;
    const placeholder = existing.find((x: any) => x.parent_group_id === dl.id && norm(x.name) === norm(d.name));
    let taskId;
    if (placeholder) {
      taskId = placeholder.id;
      if (d.date) await tg("PATCH", "/tasks/" + taskId, { start_date: d.date, end_date: d.date });
      say(`  ~ delivery: ${name} (reused placeholder ${taskId})${d.date ? " -> " + d.date : ""}`);
    } else {
      const db: any = { project_id: pid, parent_group_id: dl.id, name, type: "task", color: deliveryColor };
      if (d.date) { db.start_date = d.date; db.end_date = d.date; }
      const made = await tg("POST", "/tasks", db);
      taskId = made.id;
      say(`  + delivery: ${name} ${d.date ? `(${d.date})` : "(no date)"}`);
    }
    for (const line of d.checklist) {
      await tg("POST", `/tasks/${taskId}/checklist_items`, { name: line, is_complete: false });
      await sleep(100);
    }
    say(`      ${d.checklist.length} checklist items`);
    if (d.links.length) {
      // HTML note = CLICKABLE links (proven 2026-07-23: the comments API stores HTML
      // verbatim and the notes editor renders it; markdown stays literal text).
      // Presentation formatting, so it lives here — same rule as the delivery colour.
      const esc = (s: unknown) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
      const note = d.links.map((l: any) => `<p><a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.desc || l.url)}</a></p>`).join("");
      try {
        await tg("POST", `/tasks/${taskId}/comments`, { type: "note", message: note });
        say("      note with " + d.links.length + " link(s)");
      } catch (_e1) {
        try { // field-name fallback — the blueprint is ambiguous between message/body
          await tg("POST", `/tasks/${taskId}/comments`, { type: "note", body: note });
          say("      note with " + d.links.length + " link(s)");
        } catch (e2) { noteWarnings++; say("      ⚠ note failed: " + (e2 as Error).message); }
      }
    }
    await sleep(150);
  }

  say(`Done. Project "${projName}" (id ${pid}) — check it in TeamGantt.`);
  if (noteWarnings) say(`⚠ ${noteWarnings} note(s) failed — links may need adding by hand.`);
  return json(200, { ok: true, projectId: pid, projectName: projName, warnings: noteWarnings, test: mode === "test" });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ ok: false, error: "Use POST." }), { status: 405, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  try {
    return await handle(req);
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e as Error).message }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }
});
