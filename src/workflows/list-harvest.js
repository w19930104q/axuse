/**
 * axuse — resumable virtual-list harvest workflow.
 *
 * Recruitment boards (and most modern feeds) are VIRTUAL lists: the DOM only
 * holds the rows around the viewport, old rows are recycled as you scroll,
 * and a re-render can reset the DOM entirely. Reading one snapshot per page
 * (the open-urls batch flow) silently misses almost every record.
 *
 * This workflow instead drives a bounded scroll loop from the host:
 *   - identity: each row's `data-record-id` is the stable key — records are
 *     de-duplicated by it and kept in FIRST-SEEN order (reposted cards with
 *     the same id never move a record or fork it);
 *   - fields: title, company, location, url per record;
 *   - termination: the list sentinel is reached, OR no new records appear
 *     for `stagnantLimit` consecutive steps, OR `maxRecords` is hit
 *     (`maxSteps` is the hard safety bound) — whichever fires first;
 *   - resume: the cursor (last collected id) + seen set survive as JSON;
 *     a later run with --resume skips everything already collected. Within
 *     a run, a DOM reset (scroll position jumps back, container re-created)
 *     is detected and the scroller is restored to the deepest position, so
 *     collection continues from the cursor instead of starting over;
 *   - honesty: one bad row is a diagnostic line, never a failed run.
 *
 * The module is import-safe anywhere (no browser imports at top level): the
 * pure state machine is unit-tested without a browser; `harvestList` drives
 * any Controller via the `evaluate` command.
 */

export const HARVEST_DEFAULTS = Object.freeze({
  maxRecords: 5000,
  maxSteps: 2000,
  stagnantLimit: 4,
  settleMs: 160,
  scrollFraction: 0.85,
  sentinelSelector: "[data-list-sentinel], [data-sentinel]",
});

const DIAGNOSTIC_CAP = 200;
const FIELD_CAP = 300;

/** Fresh harvest state. `seen` is a Set — everything else JSON-serializes. */
export function createHarvestState() {
  return {
    records: [], // {id,title,company,location,url} in first-seen order
    seen: new Set(),
    cursor: null, // id of the last record collected (the resume point)
    diagnostics: [], // bounded, newest last
    steps: 0,
    stagnant: 0, // consecutive steps with zero new records
    maxScroll: 0, // deepest scroll offset reached (DOM-reset restore point)
    resets: 0, // DOM resets detected and recovered
    addedTotal: 0,
    duplicates: 0,
    badRows: 0,
  };
}

/**
 * The page-side step, built as an expression for the `evaluate` command.
 * One step: recover from a DOM reset if the scroll position jumped back,
 * parse the currently rendered rows, report the sentinel, scroll one
 * viewport down. Returns {rows, diagnostics, sentinel, reset, scrollTop,
 * clientHeight, scrollHeight}.
 */
export function harvestStepExpression({ sentinelSelector, resumeScrollTop = 0, settleMs = 160, scrollFraction = 0.85 } = {}) {
  const sentinel = JSON.stringify(String(sentinelSelector ?? HARVEST_DEFAULTS.sentinelSelector));
  const resumeTop = Number.isFinite(Number(resumeScrollTop)) ? Math.max(0, Number(resumeScrollTop)) : 0;
  const settle = Number.isFinite(Number(settleMs)) ? Math.max(0, Number(settleMs)) : 0;
  const frac = Number.isFinite(Number(scrollFraction)) && Number(scrollFraction) > 0 && Number(scrollFraction) <= 1
    ? Number(scrollFraction) : HARVEST_DEFAULTS.scrollFraction;
  return `(async function(){
    var SENTINEL = ${sentinel};
    var RESUME_TOP = ${resumeTop};
    var SETTLE = ${settle};
    var FRAC = ${frac};
    var FIELD_CAP = ${FIELD_CAP};
    var sleep = function(ms){ return new Promise(function(ok){ setTimeout(ok, ms); }); };
    function clip(s){ s = String(s == null ? "" : s).replace(/\\s+/g, " ").trim(); return s.length > FIELD_CAP ? s.slice(0, FIELD_CAP) : s; }
    function metrics(sc){
      if (sc.isWindow) return { top: window.scrollY || document.documentElement.scrollTop || 0, height: window.innerHeight, full: Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight) };
      return { top: sc.el.scrollTop, height: sc.el.clientHeight, full: sc.el.scrollHeight };
    }
    function setTop(sc, v){ if (sc.isWindow) window.scrollTo(0, v); else sc.el.scrollTop = v; }
    function findScroller(){
      var cached = window.__axHarvestScroller;
      if (cached && (cached.isWindow || (cached.el && cached.el.isConnected))) return cached;
      var row = document.querySelector("[data-record-id]");
      var el = row ? row.parentElement : null;
      while (el && el !== document.body && el !== document.documentElement) {
        var cs = getComputedStyle(el);
        if (/(auto|scroll|overlay)/.test(cs.overflowY) && el.clientHeight > 40) {
          window.__axHarvestScroller = { el: el, isWindow: false };
          return window.__axHarvestScroller;
        }
        el = el.parentElement;
      }
      window.__axHarvestScroller = { el: document.scrollingElement || document.documentElement, isWindow: true };
      return window.__axHarvestScroller;
    }
    function field(el, name){
      var f = el.querySelector('[data-field="' + name + '"]') || el.querySelector("[data-" + name + "]") || el.querySelector("." + name);
      return f ? clip(f.textContent) : "";
    }
    function parseRow(el){
      var id = el.getAttribute("data-record-id");
      if (!id) return { bad: "missing_record_id" };
      id = clip(id);
      var a = el.querySelector("a[href]");
      var title = field(el, "title") || (a ? clip(a.textContent) : "");
      var url = "";
      try { url = a ? new URL(a.getAttribute("href"), location.href).href : ""; } catch (e) { url = ""; }
      var company = field(el, "company");
      var loc = field(el, "location");
      if (!title && !url && !company && !loc) return { id: id, bad: "empty_row" };
      if (!title && !url) return { id: id, bad: "no_title_or_url" };
      return { id: id, title: title, company: company, location: loc, url: url };
    }

    var sc = findScroller();
    var reset = false;
    var m0 = metrics(sc);
    // DOM reset recovery: the list jumped back above the deepest position we
    // had reached (container re-created, window re-rendered from the top —
    // or a resumed run on a freshly loaded page). Restore the cursor depth.
    // A virtual list re-grows its scrollable height in async batches, so the
    // restore is clamped at first: re-assert it while the content catches up
    // (bounded), then give the window a beat to render.
    if (RESUME_TOP > 0 && m0.top < RESUME_TOP - 100) {
      reset = true;
      for (var w = 0; w < 12; w++) {
        setTop(sc, RESUME_TOP);
        await sleep(100);
        var mg = metrics(sc);
        if (mg.top >= RESUME_TOP - 100) break;
      }
      await sleep(SETTLE + 60);
    }

    var rows = [], diags = [];
    var els = document.querySelectorAll("[data-record-id]");
    for (var i = 0; i < els.length; i++) {
      var parsed;
      try { parsed = parseRow(els[i]); } catch (e) { parsed = { bad: "parse_exception", detail: String(e && e.message || e).slice(0, 120) }; }
      if (parsed.bad) diags.push({ id: parsed.id || null, reason: parsed.bad, detail: parsed.detail || null });
      else rows.push(parsed);
    }

    var sentinel = false;
    var sentinelEl = null;
    try { sentinelEl = document.querySelector(SENTINEL); } catch (e) { sentinelEl = null; }
    if (sentinelEl) {
      var mNow = metrics(sc);
      var sRect = sc.isWindow ? { bottom: window.innerHeight } : sc.el.getBoundingClientRect();
      var r = sentinelEl.getBoundingClientRect();
      // Reached = rendered (non-zero box) and within one viewport of the
      // current scroll window — a sentinel merely mounted far below the
      // viewport of a non-virtualized page still counts, since the loop
      // scrolls until it is near.
      sentinel = (r.height > 0 || r.width > 0) && r.top <= sRect.bottom + mNow.height;
    }

    var m1 = metrics(sc);
    setTop(sc, m1.top + Math.max(80, m1.height * FRAC));
    if (SETTLE) await sleep(SETTLE);
    var m2 = metrics(sc);
    return {
      rows: rows,
      diagnostics: diags,
      sentinel: sentinel,
      reset: reset,
      scrollTop: m2.top,
      clientHeight: m2.height,
      scrollHeight: m2.full
    };
  })()`;
}

/**
 * Merge one page-side batch into the state. Identity is `data-record-id`:
 * first sighting wins (a reposted card never overwrites), order is first-seen
 * order. Returns {added, duplicates, bad}.
 */
export function mergeHarvestBatch(state, batch) {
  const rows = Array.isArray(batch?.rows) ? batch.rows : [];
  let added = 0;
  let duplicates = 0;
  for (const row of rows) {
    const id = String(row?.id ?? "").trim();
    if (!id) {
      state.badRows += 1;
      pushDiagnostic(state, { step: state.steps, id: null, reason: "missing_record_id", detail: null });
      continue;
    }
    if (state.seen.has(id)) {
      duplicates += 1;
      state.duplicates += 1;
      continue;
    }
    state.seen.add(id);
    state.records.push({
      id,
      title: String(row.title ?? ""),
      company: String(row.company ?? ""),
      location: String(row.location ?? ""),
      url: String(row.url ?? ""),
    });
    state.cursor = id;
    added += 1;
  }
  const bad = Array.isArray(batch?.diagnostics) ? batch.diagnostics.length : 0;
  state.badRows += bad;
  for (const d of (batch?.diagnostics ?? [])) {
    pushDiagnostic(state, { step: state.steps, id: d?.id ?? null, reason: String(d?.reason ?? "bad_row"), detail: d?.detail ?? null });
  }
  state.addedTotal += added;
  state.stagnant = added === 0 ? state.stagnant + 1 : 0;
  return { added, duplicates, bad };
}

function pushDiagnostic(state, entry) {
  // A virtual list re-renders the same broken card in every window that
  // overlaps it — the same row at the same fault is ONE diagnostic with an
  // occurrence count, not a log line per render.
  state._diagIndex ??= new Map();
  const key = `${entry.id ?? ""}::${entry.reason}`;
  const existing = state._diagIndex.get(key);
  if (existing) {
    existing.occurrences += 1;
    return;
  }
  const record = { ...entry, occurrences: 1 };
  state._diagIndex.set(key, record);
  state.diagnostics.push(record);
  if (state.diagnostics.length > DIAGNOSTIC_CAP) {
    const dropped = state.diagnostics.splice(0, state.diagnostics.length - DIAGNOSTIC_CAP);
    for (const d of dropped) state._diagIndex.delete(`${d.id ?? ""}::${d.reason}`);
  }
}

/**
 * The stop condition, checked after every merge. Any one ends the run:
 * the sentinel was reached, the record cap was hit, or the list has given
 * us nothing new for `stagnantLimit` straight steps (end of an unmarked
 * list, or a loader that stalled).
 */
export function harvestStopReason(state, batch, limits) {
  if (batch?.sentinel) return "sentinel";
  if (state.records.length >= limits.maxRecords) return "max_records";
  if (state.stagnant >= limits.stagnantLimit) return "stalled";
  return null;
}

export function normalizeHarvestLimits(overrides = {}) {
  const num = (v, dflt, min = 1) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min ? Math.floor(n) : dflt;
  };
  return {
    maxRecords: num(overrides.maxRecords, HARVEST_DEFAULTS.maxRecords),
    maxSteps: num(overrides.maxSteps, HARVEST_DEFAULTS.maxSteps),
    stagnantLimit: num(overrides.stagnantLimit, HARVEST_DEFAULTS.stagnantLimit),
    settleMs: num(overrides.settleMs, HARVEST_DEFAULTS.settleMs, 0),
    scrollFraction: HARVEST_DEFAULTS.scrollFraction,
    sentinelSelector: typeof overrides.sentinelSelector === "string" && overrides.sentinelSelector.trim()
      ? overrides.sentinelSelector.trim()
      : HARVEST_DEFAULTS.sentinelSelector,
  };
}

/**
 * Rebuild a state from a previous run's JSON (the CLI's own output file is
 * the checkpoint: records carry their ids, so the seen set is derivable).
 */
export function resumeHarvestState(saved) {
  const state = createHarvestState();
  const records = Array.isArray(saved?.records) ? saved.records : [];
  for (const r of records) {
    const id = String(r?.id ?? "").trim();
    if (!id || state.seen.has(id)) continue;
    state.seen.add(id);
    state.records.push({
      id,
      title: String(r.title ?? ""),
      company: String(r.company ?? ""),
      location: String(r.location ?? ""),
      url: String(r.url ?? ""),
    });
    state.cursor = id;
  }
  if (typeof saved?.cursor === "string" && saved.cursor && state.seen.has(saved.cursor)) {
    state.cursor = saved.cursor;
  }
  for (const d of (Array.isArray(saved?.diagnostics) ? saved.diagnostics : [])) {
    pushDiagnostic(state, { step: d?.step ?? 0, id: d?.id ?? null, reason: String(d?.reason ?? "bad_row"), detail: d?.detail ?? null });
  }
  state.maxScroll = Number.isFinite(Number(saved?.stats?.max_scroll)) ? Number(saved.stats.max_scroll) : 0;
  return state;
}

/** The JSON document a run hands back — also the resume checkpoint. */
export function serializeHarvest(state, { source, stopReason } = {}) {
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    source: source ?? null,
    stop_reason: stopReason ?? null,
    count: state.records.length,
    cursor: state.cursor,
    records: state.records,
    diagnostics: state.diagnostics,
    stats: {
      steps: state.steps,
      added_total: state.addedTotal,
      duplicates_skipped: state.duplicates,
      bad_rows: state.badRows,
      dom_resets: state.resets,
      max_scroll: Math.round(state.maxScroll),
    },
  };
}

/**
 * Drive the harvest loop on an already-open tab. The controller stays the
 * caller's — this function neither opens nor closes tabs/browsers.
 *
 * @returns {Promise<{state, stopReason}>}
 */
export async function harvestList(controller, { tabId, resume = null, ...limitOverrides } = {}) {
  const limits = normalizeHarvestLimits(limitOverrides);
  const state = resume ? resumeHarvestState(resume) : createHarvestState();
  let stopReason = null;
  while (state.steps < limits.maxSteps) {
    const expression = harvestStepExpression({
      sentinelSelector: limits.sentinelSelector,
      resumeScrollTop: state.maxScroll,
      settleMs: limits.settleMs,
      scrollFraction: limits.scrollFraction,
    });
    const res = await controller.execute("evaluate", {
      expression,
      ...(tabId ? { tab_id: tabId } : {}),
    });
    let batch;
    try {
      batch = JSON.parse(res.value);
    } catch (e) {
      throw new Error(`harvest-list: the page step did not return JSON (${e.message})`);
    }
    state.steps += 1;
    mergeHarvestBatch(state, batch);
    if (batch.reset) {
      state.resets += 1;
      // A reset step re-reads already-seen rows at the restored depth — that
      // is recovery progress, never evidence the list has stalled.
      state.stagnant = 0;
    }
    if (Number.isFinite(batch.scrollTop)) state.maxScroll = Math.max(state.maxScroll, batch.scrollTop);
    stopReason = harvestStopReason(state, batch, limits);
    if (stopReason) break;
  }
  if (!stopReason) stopReason = "step_cap";
  return { state, stopReason, limits };
}
