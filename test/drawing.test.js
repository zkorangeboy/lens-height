// The drawing-first check screen: the verdict line (SPEC.md 5.6), the
// drawing's columns, margins, and label lane (5.8), and editing the rig in
// place (5.9, 7.2).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildChain, enumerateChains, evaluateChain } from "../src/solver.js";
import { addOptions, applyEdit, defaultPicks, insertOptions, modeControl, revalidatePicks, slotOptions, swapOptions } from "../src/rules.js";
import { stackLayout } from "../src/stack.js";
import { checkVerdict, TIGHT_MARGIN } from "../src/verdict.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(path.join(root, "gear.json"), "utf8"));
const P = ["test-package", "build-placeholder"];

const picksFor = (over = {}) => ({
  baseItemIds: [],
  baseModes: {},
  supportId: "tripod-baby-placeholder",
  adapterIds: [],
  adapterModes: {},
  headId: "head-standard-placeholder",
  modeName: "normal",
  attachName: "base",
  ...over,
});
const chainOf = (picks) => buildChain(seed, { packageId: P[0], buildId: P[1], ...picks });
const UNDERSLUNG = picksFor({
  adapterIds: ["mitchell-offset"],
  adapterModes: { "mitchell-offset": "underslung" },
  modeName: "underslung",
  attachName: "base-inverted",
});
const LAMBDA = picksFor({ headId: "head-lambda-placeholder", modeName: "underslung", attachName: "base" });
const available = (options) => options.filter((o) => o.available).map((o) => o.label);
const gap = (picks, slot, index) => insertOptions(seed, ...P, picks).find((g) => g.slot === slot && g.index === index);

// ---------------------------------------------------------------------------
// The verdict (SPEC.md 5.6)
// ---------------------------------------------------------------------------

describe("checkVerdict: one line, the tightest margin in plain words", () => {
  const chain = chainOf(picksFor()); // reach 23.5..38.5
  const verdict = (target) => checkVerdict(chain, target, evaluateChain(chain, target));

  test("feasible names the tightest margin and which side it's on", () => {
    const v = verdict({ type: "fixed", height: 30 });
    assert.equal(v.state, "feasible");
    assert.equal(v.text, "Reaches 30″ · 6.5″ to spare at bottom");
    assert.deepEqual(v.tightest, { side: "bottom", amount: 6.5 });
    assert.equal(verdict({ type: "fixed", height: 33 }).text, "Reaches 33″ · 5.5″ to spare at top");
  });

  test(`a margin under ${TIGHT_MARGIN}″ is feasible but tight, and says "only"`, () => {
    const v = verdict({ type: "fixed", height: 38 });
    assert.equal(v.state, "tight");
    assert.equal(v.text, "Reaches 38″ · only 0.5″ to spare at top");
    assert.equal(verdict({ type: "fixed", height: 37.5 }).state, "feasible", "exactly 1″ is not tight");
  });

  test("inside the tolerance but past the end says so", () => {
    const v = verdict({ type: "fixed", height: 38.75 });
    assert.equal(v.state, "tight");
    assert.equal(v.text, "Reaches 38.75″ · 0.25″ past the top, within tolerance");
  });

  test("infeasible gives the shortfall: too short, too tall, or not enough moveable travel", () => {
    assert.deepEqual(verdict({ type: "fixed", height: 42 }), { state: "infeasible", text: "3.5″ too short", tightest: null });
    assert.equal(verdict({ type: "fixed", height: 20 }).text, "3.5″ too tall");
    assert.equal(verdict({ type: "range", low: 25, high: 30 }).text, "Needs 5″ more moveable travel", "a tripod can't move live");
  });

  test("a moveable range weighs the travel left over, too", () => {
    const dolly = chainOf(picksFor({ supportId: "dolly-placeholder" })); // reach 18.5..47.5, 29″ of boom
    const v = checkVerdict(dolly, { type: "range", low: 20, high: 32 }, evaluateChain(dolly, { type: "range", low: 20, high: 32 }));
    assert.equal(v.text, "Covers 20–32″ · 1.5″ to spare at bottom");
    const wide = { type: "range", low: 19, high: 47.5 }; // 28.5″ of a 29″ boom
    const w = checkVerdict(dolly, wide, evaluateChain(dolly, wide));
    assert.equal(w.state, "tight");
    assert.equal(w.text, "Covers 19–47.5″ · only 0″ to spare at top");
    const middle = { type: "range", low: 19.5, high: 47 };
    assert.equal(checkVerdict(dolly, middle, evaluateChain(dolly, middle)).text, "Covers 19.5–47″ · only 0.5″ to spare at top");

    // Legs plus a short boom: plenty of reach, but the move barely fits the boom.
    const legsAndBoom = { min: 0, max: 50, moveableInterval: { min: 0, max: 10.5 } };
    const move = { type: "range", low: 20, high: 30 };
    const v2 = checkVerdict(legsAndBoom, move, evaluateChain(legsAndBoom, move));
    assert.deepEqual(v2.tightest, { side: "travel", amount: 0.5 });
    assert.equal(v2.text, "Covers 20–30″ · only 0.5″ of moveable travel to spare");
    const adjustable = { ...move, rangeType: "adjustable" };
    assert.notEqual(checkVerdict(legsAndBoom, adjustable, evaluateChain(legsAndBoom, adjustable)).tightest.side, "travel", "travel only counts for a moveable range");
  });

  test("no target yet: the reach, and a prompt", () => {
    assert.deepEqual(checkVerdict(chain, null, null), { state: "waiting", text: "Reaches 23.5–38.5″ · enter a target", tightest: null });
  });
});

// ---------------------------------------------------------------------------
// Columns, heights, margins (SPEC.md 5.8)
// ---------------------------------------------------------------------------

describe("stackLayout: columns that read like the physical rig", () => {
  test("an upright rig is one column, every block with its bottom and top height", () => {
    const layout = stackLayout(chainOf(picksFor({ adapterIds: ["mitchell-riser-6"] })), { type: "fixed", height: 40 });
    assert.equal(layout.columns, 1);
    assert.deepEqual(layout.connectors, []);
    for (const b of layout.blocks) {
      assert.equal(b.column, 0);
      assert.ok(b.top >= b.bottom);
      assert.ok(b.topPct >= b.bottomPct);
    }
    const riser = layout.blocks.find((b) => b.slot === "adapter");
    const support = layout.blocks.find((b) => b.slot === "support");
    assert.equal(riser.bottom, support.top, "the riser starts where the support ends");
    assert.equal(riser.top, riser.bottom + 6);
  });

  test("underslung: the head and camera move to a second column and hang down, joined at the offset", () => {
    const layout = stackLayout(chainOf(UNDERSLUNG), { type: "fixed", height: 12 });
    const at = (slot) => layout.blocks.find((b) => b.slot === slot);
    assert.equal(layout.columns, 2);
    assert.equal(at("support").column, 0);
    assert.equal(at("adapter").column, 0, "a zero-rise offset doesn't reverse anything");
    assert.equal(at("head").column, 1);
    assert.equal(at("build").column, 1);
    assert.equal(at("head").direction, "down");
    assert.equal(at("head").top, at("support").top, "the head hangs from the top of the support");
    assert.equal(at("build").top, at("head").bottom, "the camera hangs from the head");
    assert.deepEqual(layout.connectors.map((c) => [c.fromColumn, c.toColumn, c.height]), [[0, 1, at("support").top]]);
    assert.equal(layout.lens.column, 1);
    assert.equal(layout.lens.height, at("build").bottom, "the lens is at the bottom of the hanging camera");
  });

  test("the lambda cradles its camera: underslung, the camera stays in the head's column", () => {
    const layout = stackLayout(chainOf(LAMBDA), { type: "fixed", height: 22 });
    assert.deepEqual(layout.blocks.map((b) => [b.slot, b.column]), [["support", 0], ["head", 1], ["build", 1]]);
    assert.equal(layout.columns, 2);
    assert.equal(layout.connectors.length, 1, "one join, at the top of the support");
    const [, head, camera] = layout.blocks;
    assert.equal(camera.cradled, true);
    assert.equal(head.rise, -13);
    assert.equal(camera.bottom, head.bottom, "the camera sits on the bracket at the bottom of the head");
  });

  test("the lambda overslung is one upright column", () => {
    const layout = stackLayout(chainOf({ ...LAMBDA, modeName: "overslung" }), null);
    assert.equal(layout.columns, 1);
    assert.equal(layout.blocks[1].rise, 13);
    assert.equal(layout.blocks[2].cradled, true);
  });

  test("without the flag, a camera rising out of a dropped head would get its own column", () => {
    const chain = chainOf(LAMBDA);
    const uncradled = { ...chain, head: { ...chain.head, cradlesCamera: false } };
    assert.equal(stackLayout(uncradled, null).columns, 3);
  });

  test("the scale fits the content: the reach rail is clipped, not the drawing stretched", () => {
    const chain = chainOf(picksFor({ supportId: "dolly-placeholder" })); // reach 18.5..47.5
    const layout = stackLayout(chain, { type: "fixed", height: 20 });
    // Content: floor to the lens at 20 (and the pieces under it).
    assert.equal(layout.lens.height, 20);
    assert.ok(layout.lens.pct > 90 && layout.lens.pct < 100, "the lens is near the top, not squashed under the reach");
    assert.deepEqual([layout.reach.min, layout.reach.max], [18.5, 47.5], "the rail is labeled with the real reach");
    assert.equal(layout.reach.topPct, 100);
    assert.equal(layout.reach.continuesAbove, true);
    assert.equal(layout.reach.continuesBelow, false);
    assert.equal(layout.moveable.continuesAbove, true);
    assert.equal(layout.margins, undefined, "no margin tags; the verdict states the margin");

    const tall = stackLayout(chain, { type: "fixed", height: 60 });
    assert.equal(tall.reach.continuesAbove, false, "a target above the reach stretches the drawing, so the rail fits");
    assert.ok(tall.target.bottomPct < 100);
  });

  test("insertion points: base 0 is the floor, adapter 0 is the top of the support", () => {
    const layout = stackLayout(chainOf(picksFor({ baseItemIds: ["apple-half"], adapterIds: ["mitchell-riser-6"] })), null);
    const g = (slot, index) => layout.gaps.find((x) => x.slot === slot && x.index === index);
    const [box, support, riser] = layout.blocks;
    assert.equal(g("base", 0).height, 0);
    assert.equal(g("base", 1).height, box.top);
    assert.equal(g("adapter", 0).height, support.top);
    assert.equal(g("adapter", 1).height, riser.top);
    assert.equal(g("adapter", 1).on, riser.name);
    assert.equal(layout.gaps.length, 4);
  });

  test("estimated pieces are marked, so the UI shows the dot and the one footer line", () => {
    const layout = stackLayout(chainOf(picksFor({ adapterIds: ["mitchell-riser-6"] })), null);
    assert.equal(layout.blocks.find((b) => b.slot === "adapter").estimated, false, "risers are measured");
    assert.equal(layout.blocks.find((b) => b.slot === "support").estimated, true);
    assert.equal(layout.estimated, true);
  });
});

describe("stackLayout: the label lane", () => {
  const overlaps = (lane) => {
    const sorted = [...lane].sort((a, b) => a.pct - b.pct);
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].pct - sorted[i - 1].pct < (sorted[i].size + sorted[i - 1].size) / 2 - 0.02) return true;
    }
    return false;
  };

  test("one label per block, sized from the measured pixel heights (labels wrap, so they vary)", () => {
    const chain = chainOf(UNDERSLUNG);
    const layout = stackLayout(chain, null, { lane: { plotPx: 500, labelPx: [40, 40, 60, 75] } });
    assert.equal(layout.lane.length, layout.blocks.length);
    const sizeOf = (slot) => layout.lane.find((e) => layout.blocks[e.block].slot === slot).size;
    assert.equal(sizeOf("support"), 8);
    assert.equal(sizeOf("build"), 15, "75px of 500");
    assert.equal(stackLayout(chain, null).lane[0].size, 7, "a default when nothing was measured");
  });

  test("labels never overlap and stay inside the drawing, across a spread of rigs", () => {
    const rigs = [
      picksFor(),
      UNDERSLUNG,
      LAMBDA,
      { ...LAMBDA, modeName: "overslung" },
      picksFor({ baseItemIds: ["apple-quarter", "apple-half"], adapterIds: ["mitchell-riser-6", "mitchell-offset"] }),
      picksFor({ supportId: "lohat-placeholder", adapterIds: ["mitchell-riser-6", "mitchell-riser-12"] }),
    ];
    for (const picks of rigs) {
      const chain = chainOf(picks);
      for (const target of [null, { type: "fixed", height: 20 }, { type: "fixed", height: 70 }]) {
        const labelPx = chain.baseItems.concat(chain.adapters).map(() => 38).concat([38, 52, 64]);
        const layout = stackLayout(chain, target, { lane: { plotPx: 520, labelPx } });
        assert.ok(!overlaps(layout.lane), JSON.stringify(picks));
        for (const e of layout.lane) {
          assert.ok(e.pct >= e.size / 2 - 0.02 && e.pct <= 100 - e.size / 2 + 0.02, `${e.pct} inside`);
          assert.equal(e.leader.heightPct, Math.round(Math.abs(e.pct - e.anchorPct) * 100) / 100);
        }
      }
    }
  });

  test("with room to spare, a label sits right at its piece", () => {
    const layout = stackLayout(chainOf(picksFor()), { type: "fixed", height: 38 });
    const support = layout.lane.find((e) => layout.blocks[e.block].slot === "support");
    assert.equal(support.pct, support.anchorPct);
    assert.equal(support.leader.heightPct, 0);
  });
});

// ---------------------------------------------------------------------------
// Editing in place (SPEC.md 5.9)
// ---------------------------------------------------------------------------

describe("insertOptions: only what legally fits at that exact point", () => {
  test("on a tripod: apple boxes at the floor; risers and either offset mode on the support", () => {
    assert.deepEqual(available(gap(picksFor(), "base", 0).options), [
      "Quarter Apple Box", "Half Apple Box", "Full Apple Box (Flat, 8″)", "Full Apple Box (12″ face)", "Full Apple Box (20″ face)",
    ]);
    assert.deepEqual(available(gap(picksFor(), "adapter", 0).options), [
      'Mitchell Riser 6"', 'Mitchell Riser 12"', 'Mitchell Riser 18"', 'Mitchell Riser 24"', "Mitchell Offset (upright)", "Mitchell Offset (underslung)",
    ]);
    const track = gap(picksFor(), "base", 0).options.find((o) => o.id === "track-wedges-placeholder");
    assert.equal(track.available, false);
    assert.match(track.reason, /Baby Tripod sits on the floor, not on dolly track/);
  });

  test("on a dolly: only track at the floor, and the dolly's own configurations are offered", () => {
    const dolly = picksFor({ supportId: "dolly-placeholder" });
    assert.deepEqual(available(gap(dolly, "base", 0).options), ["Track + Wedges"]);
    const apple = gap(dolly, "base", 0).options.find((o) => o.id === "apple-half");
    assert.match(apple.reason, /apple boxes can't go under a dolly/);
    assert.ok(available(gap(dolly, "adapter", 0).options).includes("Dolly Low Mode"));
    assert.ok(!available(gap(picksFor(), "adapter", 0).options).includes("Dolly Low Mode"));
  });

  test("nothing stacks on top of track, and nothing is offered on an underslung offset", () => {
    const onTrack = picksFor({ supportId: "dolly-placeholder", baseItemIds: ["track-wedges-placeholder"] });
    assert.deepEqual(available(gap(onTrack, "base", 1).options), []);
    assert.match(gap(onTrack, "base", 1).options.find((o) => o.id === "apple-half").reason, /needs the floor beneath it, but Track \+ Wedges ends in dolly track/);
    assert.deepEqual(available(gap(UNDERSLUNG, "adapter", 1).options), []);
    assert.match(
      gap(UNDERSLUNG, "adapter", 1).options.find((o) => o.id === "mitchell-riser-6").reason,
      /needs an up-facing mount beneath it, but the top of Mitchell Offset \(underslung\) faces down/
    );
  });

  test("position matters: a riser fits under the underslung offset, not over it", () => {
    assert.ok(available(gap(UNDERSLUNG, "adapter", 0).options).includes('Mitchell Riser 6"'));
    assert.ok(!available(gap(UNDERSLUNG, "adapter", 1).options).includes('Mitchell Riser 6"'));
  });

  test("an addition that would switch the head's mode is fine; one that leaves the head nothing is not", () => {
    // The standard head switches to underslung (and the camera inverts) when the offset goes underslung.
    const hung = gap(picksFor(), "adapter", 0).options.find((o) => o.label === "Mitchell Offset (underslung)");
    assert.equal(hung.available, true);
    // The lambda head's one mode needs an up-facing mount: an underslung offset would clear it.
    const onLambda = gap(LAMBDA, "adapter", 0).options.find((o) => o.label === "Mitchell Offset (underslung)");
    assert.equal(onLambda.available, false);
    assert.match(onLambda.reason, /Lambda Head/);
  });

  test("something already in the rig isn't offered again", () => {
    const withBox = picksFor({ baseItemIds: ["apple-half"] });
    const again = gap(withBox, "base", 1).options.find((o) => o.id === "apple-half");
    assert.equal(again.available, false);
    assert.match(again.reason, /already in the rig/);
  });

  test("options carry a plain rise and label, and reasons never leak field names", () => {
    for (const picks of [picksFor(), UNDERSLUNG, LAMBDA, picksFor({ supportId: "dolly-placeholder" })]) {
      for (const g of insertOptions(seed, ...P, picks)) {
        for (const o of g.options) {
          assert.equal(typeof o.rise, "number");
          assert.ok(o.label);
          if (o.reason) assert.doesNotMatch(o.reason, /bottomMount|topMount|mountFacing|requiresFamily|undefined|null|\[object/);
        }
      }
    }
  });
});

describe("swapOptions", () => {
  test("a support swaps for any other that sits on the base layer", () => {
    assert.deepEqual(available(swapOptions(seed, ...P, picksFor(), "support")), ["Studio Dolly", "Hi-Hat", "Low Hat"]);
    const onApple = swapOptions(seed, ...P, picksFor({ baseItemIds: ["apple-half"] }), "support");
    assert.deepEqual(available(onApple), ["Hi-Hat", "Low Hat"], "not the dolly on an apple box");
    assert.ok(onApple.every((o) => o.rise === null), "a support has a range, not one rise");
  });

  test("a head swaps for another with a legal mode", () => {
    assert.deepEqual(available(swapOptions(seed, ...P, picksFor(), "head")), ["Lambda Head"]);
    assert.deepEqual(available(swapOptions(seed, ...P, UNDERSLUNG, "head")), [], "the lambda needs an up-facing mount");
  });

  test("an adapter swaps in its place: the underslung offset for a riser", () => {
    const options = swapOptions(seed, ...P, UNDERSLUNG, "adapter", 0);
    assert.deepEqual(available(options), ['Mitchell Riser 6"', 'Mitchell Riser 12"', 'Mitchell Riser 18"', 'Mitchell Riser 24"']);
    assert.ok(!options.some((o) => o.id === "mitchell-offset"), "the piece itself isn't a swap");
  });

  test("a base item swaps in its place", () => {
    const options = swapOptions(seed, ...P, picksFor({ baseItemIds: ["apple-half"] }), "base", 0);
    assert.ok(available(options).includes("Full Apple Box (Flat, 8″)"));
    assert.ok(!available(options).includes("Track + Wedges"), "a tripod can't stand on track");
  });
});

describe("applyEdit, then revalidatePicks", () => {
  const next = (picks, change) => revalidatePicks(seed, ...P, applyEdit(picks, change));

  test("insert at a position, and the picks keep that order", () => {
    const { picks } = next(picksFor({ adapterIds: ["mitchell-riser-12"] }), { op: "insert", slot: "adapter", index: 0, id: "mitchell-riser-6" });
    assert.deepEqual(picks.adapterIds, ["mitchell-riser-6", "mitchell-riser-12"]);
    const top = next(picksFor({ adapterIds: ["mitchell-riser-12"] }), { op: "insert", slot: "adapter", index: 1, id: "mitchell-riser-6" }).picks;
    assert.deepEqual(top.adapterIds, ["mitchell-riser-12", "mitchell-riser-6"]);
  });

  test("inserting the offset underslung takes the head and camera with it, with notes", () => {
    const { picks, notes } = next(picksFor(), { op: "insert", slot: "adapter", index: 0, id: "mitchell-offset", mode: "underslung" });
    assert.deepEqual(picks, UNDERSLUNG);
    assert.equal(notes.length, 2);
  });

  test("remove, and what depended on it switches back", () => {
    const { picks, notes } = next(UNDERSLUNG, { op: "remove", slot: "adapter", index: 0 });
    assert.deepEqual(picks, picksFor());
    assert.match(notes[0], /Switched the head to normal mode/);
  });

  test("swap a base item, a support, a head", () => {
    assert.deepEqual(next(picksFor({ baseItemIds: ["apple-half"] }), { op: "swap", slot: "base", index: 0, id: "apple-full" }).picks.baseItemIds, ["apple-full"]);
    const onDolly = next(picksFor(), { op: "swap", slot: "support", id: "dolly-placeholder" }).picks;
    assert.equal(onDolly.supportId, "dolly-placeholder");
    const lambda = next(picksFor(), { op: "swap", slot: "head", id: "head-lambda-placeholder" }).picks;
    assert.deepEqual([lambda.headId, lambda.modeName, lambda.attachName], ["head-lambda-placeholder", "underslung", "base"]);
  });

  test("swapping the dolly for a tripod drops the dolly-only adapters, with a note", () => {
    const start = picksFor({ supportId: "dolly-placeholder", adapterIds: ["dolly-low-mode-placeholder"] });
    const { picks, notes } = next(start, { op: "swap", slot: "support", id: "tripod-baby-placeholder" });
    assert.deepEqual(picks.adapterIds, []);
    assert.match(notes[0], /^Removed Dolly Low Mode\. It only fits a fisher-family support/);
  });

  test("mode edits: an adapter's mode, the head's, the camera's mount", () => {
    const flipped = next(picksFor({ adapterIds: ["mitchell-offset"], adapterModes: { "mitchell-offset": "upright" } }), {
      op: "mode", slot: "adapter", index: 0, mode: "underslung",
    }).picks;
    assert.equal(flipped.modeName, "underslung");
    assert.equal(next(UNDERSLUNG, { op: "mode", slot: "build", mode: "top-handle" }).picks.attachName, "top-handle");
  });

  test("revalidatePicks returns picks in stack order", () => {
    const { picks } = revalidatePicks(seed, ...P, picksFor({
      adapterIds: ["mitchell-offset", "mitchell-riser-6"],
      adapterModes: { "mitchell-offset": "underslung" },
      modeName: "underslung",
      attachName: "base-inverted",
    }));
    assert.deepEqual(picks.adapterIds, ["mitchell-riser-6", "mitchell-offset"], "the riser goes under the hanging offset");
    assert.deepEqual(chainOf(picks).adapters.map((a) => a.id), picks.adapterIds, "picks and chain agree on the order");
  });

  test("every offered insert and swap, applied, builds — with the piece where it was put", () => {
    const starts = [
      defaultPicks(seed, ...P),
      UNDERSLUNG,
      LAMBDA,
      picksFor({ supportId: "dolly-placeholder", baseItemIds: ["track-wedges-placeholder"] }),
      picksFor({ baseItemIds: ["apple-half"], adapterIds: ["mitchell-riser-6", "mitchell-offset"], adapterModes: { "mitchell-offset": "upright" } }),
    ];
    let tried = 0;
    for (const start of starts) {
      for (const g of insertOptions(seed, ...P, start)) {
        for (const o of g.options.filter((x) => x.available)) {
          const { picks } = next(start, { op: "insert", slot: g.slot, index: g.index, id: o.id, mode: o.mode });
          const ids = g.slot === "base" ? picks.baseItemIds : picks.adapterIds;
          assert.equal(ids[g.index], o.id, `${o.label} at ${g.slot} ${g.index}`);
          assert.doesNotThrow(() => chainOf(picks));
          tried++;
        }
      }
      const pieces = [
        ...start.baseItemIds.map((_, index) => ["base", index]),
        ...start.adapterIds.map((_, index) => ["adapter", index]),
        ["support", 0],
        ["head", 0],
      ];
      for (const [slot, index] of pieces) {
        for (const o of swapOptions(seed, ...P, start, slot, index).filter((x) => x.available)) {
          const { picks } = next(start, { op: "swap", slot, index, id: o.id, mode: o.mode });
          if (picks.supportId && picks.headId) assert.doesNotThrow(() => chainOf(picks), `${slot} → ${o.label}`);
          tried++;
        }
      }
    }
    assert.ok(tried > 60, `tried ${tried}`);
  });
});

// ---------------------------------------------------------------------------
// One Add button (SPEC.md 5.9, 7.2)
// ---------------------------------------------------------------------------

describe("addOptions: everything that can be added, with where it fits", () => {
  const add = (picks) => Object.fromEntries(addOptions(seed, ...P, picks).map((o) => [o.id, o]));

  test("one entry per component; one legal position means no question to ask", () => {
    const options = add(picksFor());
    assert.deepEqual(options["apple-half"].positions.map((p) => p.where), ["on the floor"]);
    assert.deepEqual(options["mitchell-riser-6"].positions.map((p) => p.where), ["on Baby Tripod"]);
    assert.equal(Object.values(options).filter((o) => o.id === "apple-full").length, 1, "the full apple once, not once per face");
    assert.equal(options["apple-full"].positions[0].mode, "flat", "added in its first mode that fits");
    assert.ok(!options["track-wedges-placeholder"], "a tripod can't stand on track, so track isn't offered");
    assert.ok(!options["dolly-low-mode-placeholder"], "dolly-only adapters aren't offered on a tripod");
  });

  test("several legal positions are listed in plain words", () => {
    const options = add(picksFor({ baseItemIds: ["apple-half"], adapterIds: ["mitchell-riser-12"] }));
    assert.deepEqual(options["apple-quarter"].positions.map((p) => p.where), ["on the floor", "on Half Apple Box"]);
    assert.deepEqual(options["mitchell-riser-6"].positions.map((p) => p.where), ["on Baby Tripod", "under Standard Fluid Head"]);
    assert.ok(!options["apple-half"], "already in the rig");
  });

  test("a position is only offered where the item really fits: nothing goes on an underslung offset", () => {
    const riser = add(UNDERSLUNG)["mitchell-riser-6"];
    assert.deepEqual(riser.positions.map((p) => [p.slot, p.index, p.where]), [["adapter", 0, "on Baby Tripod"]]);
  });

  test("on a dolly: track is the only base item", () => {
    const options = add(picksFor({ supportId: "dolly-placeholder" }));
    assert.deepEqual(Object.values(options).filter((o) => o.component.category === "base").map((o) => o.id), ["track-wedges-placeholder"]);
    assert.deepEqual(options["dolly-low-mode-placeholder"].positions.map((p) => p.where), ["on Studio Dolly"]);
  });

  test("every offered position, applied, puts the item there and builds", () => {
    for (const start of [picksFor(), UNDERSLUNG, LAMBDA, picksFor({ baseItemIds: ["apple-half"], adapterIds: ["mitchell-riser-12"] })]) {
      for (const option of addOptions(seed, ...P, start)) {
        for (const at of option.positions) {
          const { picks } = revalidatePicks(seed, ...P, applyEdit(start, { op: "insert", slot: at.slot, index: at.index, id: option.id, mode: at.mode }));
          const ids = at.slot === "base" ? picks.baseItemIds : picks.adapterIds;
          assert.equal(ids[at.index], option.id, `${option.label} ${at.where}`);
          assert.doesNotThrow(() => chainOf(picks));
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Gear model: full apple faces as modes, the lambda (SPEC.md 3.1, 3.3)
// ---------------------------------------------------------------------------

describe("apple boxes: one item per size, a full apple's face is a mode", () => {
  const boxes = seed.components.filter((c) => c.kind === "apple-box");

  test("one component per box size; only the full apple has modes", () => {
    assert.equal(new Set(boxes.map((b) => b.boxSize)).size, boxes.length);
    for (const box of boxes) {
      if (box.boxSize === "full") {
        assert.deepEqual(box.modes.map((m) => [m.name, m.rise, m.orientation]), [["flat", 8, "flat"], ["12in", 12, "12in"], ["20in", 20, "20in"]]);
      } else {
        assert.equal(box.modes, undefined, box.id);
        assert.equal(box.orientation, "flat");
      }
    }
  });

  test("the face is chosen in the full apple's sheet, as a three-way control", () => {
    const entry = slotOptions(seed, ...P, picksFor({ baseItemIds: ["apple-full"] })).base.find((o) => o.id === "apple-full");
    const control = modeControl(entry.modes);
    assert.equal(control.type, "dropdown", "three states: drawn as a segmented choice");
    assert.deepEqual(control.entries.map((e) => e.label), ["Flat, 8″", "12″ face", "20″ face"]);
    const half = slotOptions(seed, ...P, picksFor({ baseItemIds: ["apple-half"] })).base.find((o) => o.id === "apple-half");
    assert.equal(modeControl(half.modes).type, "static", "a half apple is flat-only: nothing to choose");
  });

  test("turning a full apple on its face changes the rise, and survives revalidation", () => {
    const flat = chainOf(picksFor({ baseItemIds: ["apple-full"] }));
    const { picks, notes } = revalidatePicks(seed, ...P, applyEdit(picksFor({ baseItemIds: ["apple-full"] }), { op: "mode", slot: "base", index: 0, mode: "20in" }));
    assert.deepEqual(notes, []);
    assert.deepEqual(picks.baseModes, { "apple-full": "20in" });
    const onEnd = chainOf(picks);
    assert.equal(onEnd.min - flat.min, 12);
    assert.equal(onEnd.baseItems[0].stability, "low");
  });

  test("a face that doesn't exist falls back to the first, with a note", () => {
    const { picks, notes } = revalidatePicks(seed, ...P, picksFor({ baseItemIds: ["apple-full"], baseModes: { "apple-full": "sideways" } }));
    assert.deepEqual(picks.baseModes, { "apple-full": "flat" });
    assert.equal(notes.length, 1);
  });

  test("the solver tries every face, but never two faces of one box", () => {
    const chains = enumerateChains(seed, { packageId: P[0], buildId: P[1], maxBaseLayerItems: 2, maxAdapters: 0 });
    const faces = new Set(chains.flatMap((c) => c.baseItems.filter((b) => b.id === "apple-full").map((b) => b.mode)));
    assert.deepEqual([...faces].sort(), ["12in", "20in", "flat"]);
    for (const chain of chains) {
      const ids = chain.baseItems.map((b) => b.id);
      assert.equal(new Set(ids).size, ids.length);
    }
  });
});

describe("the lambda head: underslung and overslung, cradling the camera", () => {
  const lambda = seed.components.find((c) => c.id === "head-lambda-placeholder");

  test("two ~13″ modes, both with an up-facing camera mount, still estimated", () => {
    assert.deepEqual(lambda.modes.map((m) => [m.name, m.rise, m.cameraMountFacing, m.supportMountFacing]), [
      ["underslung", -13, "up", "up"],
      ["overslung", 13, "up", "up"],
    ]);
    assert.equal(lambda.measured, false);
    assert.equal(lambda.cradlesCamera, true);
  });

  test("its modes are a toggle, and the camera stays upright either way", () => {
    const entry = slotOptions(seed, ...P, LAMBDA).head.find((o) => o.id === lambda.id);
    const control = modeControl(entry.modes);
    assert.equal(control.type, "toggle");
    assert.deepEqual([control.on.name, control.off.name], ["underslung", "overslung"]);
    const { picks, notes } = revalidatePicks(seed, ...P, applyEdit(LAMBDA, { op: "mode", slot: "head", mode: "overslung" }));
    assert.deepEqual(notes, []);
    assert.equal(picks.attachName, "base");
    assert.equal(chainOf(picks).max - chainOf(LAMBDA).max, 26);
  });
});
