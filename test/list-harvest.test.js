/**
 * list-harvest workflow tests.
 *
 * The state machine (dedupe/order/cursor/diagnostics/stop conditions/resume)
 * is pure and runs anywhere. The end-to-end harvest against the fixture
 * jobs board is gated on a findable browser, like every live-CDP test.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HARVEST_DEFAULTS,
  createHarvestState,
  harvestStepExpression,
  mergeHarvestBatch,
  harvestStopReason,
  normalizeHarvestLimits,
  resumeHarvestState,
  serializeHarvest,
  harvestList,
} from "../src/workflows/list-harvest.js";
import { locateBrowser } from "../src/core/cdp.js";

const hasBrowser = !!locateBrowser();

const row = (id, extra = {}) => ({
  id,
  title: `Frontend Engineer ${id}`,
  company: "Acme Corp",
  location: "Berlin",
  url: `https://jobs.example/posting?id=${id}`,
  ...extra,
});

/* ---------------------------------------------------- pure state machine */

test("harvest merge dedupes by data-record-id and keeps first-seen order", () => {
  const state = createHarvestState();
  const first = mergeHarvestBatch(state, { rows: [row("job-0001"), row("job-0002"), row("job-0003")], diagnostics: [] });
  assert.equal(first.added, 3);
  // Overlapping window: job-0002 again (changed title — a repost) plus a new one.
  const second = mergeHarvestBatch(state, {
    rows: [row("job-0002", { title: "REPOSTED — must not win" }), row("job-0004")],
    diagnostics: [],
  });
  assert.equal(second.added, 1);
  assert.equal(second.duplicates, 1);
  assert.deepEqual(state.records.map((r) => r.id), ["job-0001", "job-0002", "job-0003", "job-0004"]);
  assert.equal(state.records[1].title, "Frontend Engineer job-0002", "first sighting wins");
  assert.equal(state.cursor, "job-0004", "cursor tracks the last collected record");
  assert.equal(state.duplicates, 1);
});

test("harvest merge: a bad row is a diagnostic, never a failure or a record", () => {
  const state = createHarvestState();
  const res = mergeHarvestBatch(state, {
    rows: [row("job-0001"), { id: "  " }, row("job-0002")],
    diagnostics: [{ id: "job-0042", reason: "empty_row", detail: null }],
  });
  assert.equal(res.added, 2);
  assert.equal(res.bad, 1);
  assert.deepEqual(state.records.map((r) => r.id), ["job-0001", "job-0002"]);
  assert.equal(state.badRows, 2, "bad-row sightings are counted as events");
  assert.equal(state.diagnostics.length, 2, "same row + same fault dedupes to one diagnostic");
  assert.deepEqual(
    state.diagnostics.map((d) => d.reason).sort(),
    ["empty_row", "missing_record_id"],
  );
  assert.equal(state.diagnostics[0].step, 0, "diagnostics carry the step they happened on");
  // Re-rendered in the next window: same row, same fault → occurrences, not noise.
  mergeHarvestBatch(state, { rows: [], diagnostics: [{ id: "job-0042", reason: "empty_row", detail: null }] });
  assert.equal(state.diagnostics.length, 2);
  assert.equal(state.diagnostics.find((d) => d.id === "job-0042").occurrences, 2);
});

test("harvest stop conditions: sentinel, max_records, stalled — any one ends it", () => {
  const limits = normalizeHarvestLimits({ maxRecords: 3, stagnantLimit: 2 });

  const s1 = createHarvestState();
  mergeHarvestBatch(s1, { rows: [row("a")], diagnostics: [] });
  assert.equal(harvestStopReason(s1, { sentinel: true }, limits), "sentinel");

  const s2 = createHarvestState();
  mergeHarvestBatch(s2, { rows: [row("a"), row("b"), row("c"), row("d")], diagnostics: [] });
  assert.equal(harvestStopReason(s2, { sentinel: false }, limits), "max_records");

  const s3 = createHarvestState();
  mergeHarvestBatch(s3, { rows: [row("a")], diagnostics: [] });
  assert.equal(harvestStopReason(s3, { sentinel: false }, limits), null);
  mergeHarvestBatch(s3, { rows: [], diagnostics: [] }); // nothing new, once
  assert.equal(harvestStopReason(s3, { sentinel: false }, limits), null);
  mergeHarvestBatch(s3, { rows: [], diagnostics: [] }); // nothing new, twice
  assert.equal(harvestStopReason(s3, { sentinel: false }, limits), "stalled");

  // A productive step resets the stagnation counter.
  const s4 = createHarvestState();
  mergeHarvestBatch(s4, { rows: [], diagnostics: [] });
  mergeHarvestBatch(s4, { rows: [row("a")], diagnostics: [] });
  assert.equal(s4.stagnant, 0);
});

test("harvest state serializes and resumes from the cursor", () => {
  const state = createHarvestState();
  mergeHarvestBatch(state, { rows: [row("job-0001"), row("job-0002")], diagnostics: [] });
  mergeHarvestBatch(state, { rows: [row("job-0003")], diagnostics: [{ id: "job-x", reason: "empty_row" }] });
  state.maxScroll = 1536;

  const doc = serializeHarvest(state, { source: "https://jobs.example/board", stopReason: "stalled" });
  const roundTripped = JSON.parse(JSON.stringify(doc)); // what --resume reads
  assert.equal(roundTripped.cursor, "job-0003");
  assert.equal(roundTripped.stats.bad_rows, 1);

  const resumed = resumeHarvestState(roundTripped);
  assert.deepEqual(resumed.records.map((r) => r.id), ["job-0001", "job-0002", "job-0003"]);
  assert.equal(resumed.cursor, "job-0003");
  assert.equal(resumed.maxScroll, 1536);

  // The resumed run skips everything already collected and appends in order.
  const res = mergeHarvestBatch(resumed, {
    rows: [row("job-0001"), row("job-0003"), row("job-0004")],
    diagnostics: [],
  });
  assert.equal(res.added, 1);
  assert.equal(res.duplicates, 2);
  assert.deepEqual(resumed.records.map((r) => r.id), ["job-0001", "job-0002", "job-0003", "job-0004"]);
  assert.equal(resumed.cursor, "job-0004");
});

test("harvest step expression carries the configured sentinel and resume depth", () => {
  const expr = harvestStepExpression({ sentinelSelector: "[data-list-sentinel]", resumeScrollTop: 2400, settleMs: 10 });
  assert.match(expr, /data-list-sentinel/);
  assert.match(expr, /RESUME_TOP = 2400/);
  assert.match(expr, /data-record-id/);
  // Import-safety / size sanity: one step must fit the evaluate budget easily.
  assert.ok(expr.length < 16000);
});

test("harvest limits normalize junk to honest defaults", () => {
  const limits = normalizeHarvestLimits({ maxRecords: "nope", maxSteps: -4, stagnantLimit: undefined, sentinelSelector: "  " });
  assert.equal(limits.maxRecords, HARVEST_DEFAULTS.maxRecords);
  assert.equal(limits.maxSteps, HARVEST_DEFAULTS.maxSteps);
  assert.equal(limits.stagnantLimit, HARVEST_DEFAULTS.stagnantLimit);
  assert.equal(limits.sentinelSelector, HARVEST_DEFAULTS.sentinelSelector);
  const custom = normalizeHarvestLimits({ maxRecords: 50, sentinelSelector: "#end" });
  assert.equal(custom.maxRecords, 50);
  assert.equal(custom.sentinelSelector, "#end");
});

/* ------------------------------------------- live harvest (gated: browser) */

async function harvestFixture(t, pathAndQuery, limits = {}) {
  const { startFixtureServer } = await import("./fixtures/server.js");
  const { Controller } = await import("../src/core/controller.js");
  const server = await startFixtureServer();
  const controller = new Controller();
  t.after(async () => {
    await Promise.race([controller.dispose(), new Promise((ok) => setTimeout(ok, 5000))]);
    await server.close();
  });
  const opened = await controller.execute("open", {
    url: `${server.url}${pathAndQuery}`,
    headless: true,
    settle_ms: 300,
  });
  const { state, stopReason } = await harvestList(controller, {
    tabId: opened.tab_id,
    settleMs: 60,
    ...limits,
  });
  // The tab and browser this test created are closed before it returns.
  await controller.execute("close", { tab_id: opened.tab_id });
  return { state, stopReason };
}

test("harvest collects the whole virtual list to the sentinel", { skip: !hasBrowser }, async (t) => {
  const { state, stopReason } = await harvestFixture(t, "/jobs/board");
  assert.equal(stopReason, "sentinel");
  // 120 rendered cards − 1 repost (job-0010 again at #26) − 1 broken card (#42).
  assert.equal(state.records.length, 118);
  // Re-extractions from overlapping windows dominate this counter; the
  // planted repost contributes exactly one of them.
  assert.ok(state.duplicates >= 1);
  assert.ok(state.badRows >= 1);
  assert.deepEqual(state.diagnostics.map((d) => d.id), ["job-0042"]);
  assert.equal(state.diagnostics[0].reason, "empty_row");
  // First-seen order is the board's own order, deduped.
  const ids = state.records.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.ok(!ids.includes("job-0042"), "the broken card is not a record");
  const ten = state.records.find((r) => r.id === "job-0010");
  assert.equal(ten.title, "Frontend Engineer 10", "the repost did not overwrite the first sighting");
  assert.equal(ten.company, "Acme Corp 1");
  assert.ok(ten.url.endsWith("/jobs/posting?id=job-0010"));
  assert.equal(state.records.at(-1).id, "job-0120");
  assert.equal(state.cursor, "job-0120");
});

test("harvest resumes from its cursor after a DOM reset", { skip: !hasBrowser }, async (t) => {
  const { state, stopReason } = await harvestFixture(t, "/jobs/board?reset_after=60");
  assert.equal(stopReason, "sentinel");
  assert.ok(state.resets >= 1, "the DOM reset was detected");
  assert.equal(state.records.length, 118, "a reset mid-list loses no records");
  const ids = state.records.map((r) => r.id);
  assert.deepEqual(ids, [...new Set(ids)], "no duplicates after the reset");
});

test("harvest stops on max_records", { skip: !hasBrowser }, async (t) => {
  const { state, stopReason } = await harvestFixture(t, "/jobs/board", { maxRecords: 50 });
  assert.equal(stopReason, "max_records");
  assert.ok(state.records.length >= 50 && state.records.length < 70);
});

test("harvest stops when the list stalls without a sentinel", { skip: !hasBrowser }, async (t) => {
  const { state, stopReason } = await harvestFixture(t, "/jobs/board?stall_at=36", { stagnantLimit: 3 });
  assert.equal(stopReason, "stalled");
  // 36 rendered cards − the repost at #26; the broken card (#42) never renders.
  assert.equal(state.records.length, 35);
  assert.equal(state.badRows, 0);
});
