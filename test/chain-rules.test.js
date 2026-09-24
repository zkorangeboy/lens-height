// Model changes: Mitchell as the standard mount, adapters, family, track and
// dolly mounts, apple-box hard and soft rules, orientation, and range
// targets defaulting to moveable. SPEC.md 2, 2.1, 3.1, 3.2, 3.6, 5.1, 5.3.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { solve, enumerateChains, buildChain, checkChain, isFeasible } from "../src/solver.js";
import { describeCurrentRig } from "../src/model.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fixtures: a Mitchell rig with a zero-rise head and camera build, so every
// interval in these tests is just the support + base + adapters.
// ---------------------------------------------------------------------------

const tripod = (over = {}) => ({
  id: "tripod",
  name: "Tripod",
  category: "support",
  kind: "tripod",
  bottomMount: "ground",
  topMount: "mitchell",
  riseRange: { specMin: 10, specMax: 30, practicalMin: 10, practicalMax: 30 },
  levelingLoss: 0,
  adjustability: "adjustable",
  ...over,
});

const dolly = (over = {}) => ({
  id: "dolly",
  name: "Dolly",
  category: "support",
  kind: "dolly",
  bottomMount: ["ground", "dolly-wheels"],
  topMount: "mitchell",
  baseRise: 0,
  boomRange: { specMin: 0, specMax: 30, practicalMin: 0, practicalMax: 30 },
  levelingLoss: 0,
  adjustability: "moveable",
  ...over,
});

const hiHat = (over = {}) => ({
  id: "hihat",
  name: "Hi-Hat",
  category: "support",
  kind: "hi-hat",
  bottomMount: "ground",
  topMount: "mitchell",
  rise: 6,
  adjustability: "fixed",
  ...over,
});

const apple = (id, boxSize, orientation, rise) => ({
  id,
  name: `${boxSize} apple (${orientation})`,
  category: "base",
  kind: "apple-box",
  boxSize,
  orientation,
  bottomMount: "ground",
  topMount: "ground",
  rise,
});

const track = (over = {}) => ({
  id: "track",
  name: "Track",
  category: "base",
  kind: "track",
  bottomMount: "ground",
  topMount: "dolly-wheels",
  rise: 1.5,
  ...over,
});

const riser = (n, over = {}) => ({
  id: `riser${n}`,
  name: `Mitchell riser ${n}"`,
  category: "adapter",
  bottomMount: "mitchell",
  topMount: "mitchell",
  rise: n,
  mountFacing: "up",
  ...over,
});

/** The Mitchell offset (SPEC.md 3.6): upright is a 1" riser; underslung is
 * flat but its top mount faces down. */
const offset = (over = {}) => ({
  id: "offset",
  name: "Mitchell offset",
  category: "adapter",
  bottomMount: "mitchell",
  topMount: "mitchell",
  modes: [
    { name: "upright", rise: 1, mountFacing: "up" },
    { name: "underslung", rise: 0, mountFacing: "down" },
  ],
  ...over,
});

const head = (over = {}) => ({
  id: "hd",
  name: "Head",
  category: "head",
  bottomMount: "mitchell",
  topMount: "flat-38",
  modes: [{ name: "normal", rise: 0, cameraMountFacing: "up" }],
  ...over,
});

/** A head with a normal and an underslung mode, each declaring the mount it
 * needs beneath it. Underslung pairs with the inverted camera (SPEC.md 3.3). */
const twoModeHead = (over = {}) =>
  head({
    id: "hd2",
    name: "Two-mode head",
    modes: [
      { name: "normal", rise: 6, cameraMountFacing: "up", supportMountFacing: "up" },
      { name: "underslung", rise: -4, cameraMountFacing: "down", supportMountFacing: "down" },
    ],
    ...over,
  });

/** A gear fixture: whatever's passed, plus a zero-rise camera build. */
function rigGear(components) {
  const cam = { id: "cam", category: "camera-body", opticalCenterAboveBase: 0 };
  const all = [...components, cam];
  return {
    schemaVersion: 1,
    components: all,
    packages: [{ id: "pkg", name: "pkg", componentIds: all.map((c) => c.id) }],
    builds: [{ id: "bld", componentIds: ["cam"], bottomMount: "flat-38", hasRatedTopHandle: false }],
  };
}

const selection = (over) => ({
  packageId: "pkg",
  buildId: "bld",
  baseItemIds: [],
  adapterIds: [],
  supportId: "tripod",
  headId: "hd",
  modeName: "normal",
  attachName: "base",
  ...over,
});

const chainsFor = (gear, opts = {}) => enumerateChains(gear, { packageId: "pkg", buildId: "bld", ...opts });

// ---------------------------------------------------------------------------
// 1 + 3 + 5: the seed itself
// ---------------------------------------------------------------------------

describe("seed: mounts, adapters, track, apple boxes", () => {
  const seed = JSON.parse(readFileSync(path.join(__dirname, "..", "gear.json"), "utf8"));
  const byCategory = (category) => seed.components.filter((c) => c.category === category);

  test("Mitchell is the standard mount: every head takes it, every support presents it, no bowls left", () => {
    for (const h of byCategory("head")) assert.equal(h.bottomMount, "mitchell", h.id);
    for (const s of byCategory("support")) assert.equal(s.topMount, "mitchell", s.id);
    for (const c of seed.components) {
      for (const mount of [].concat(c.bottomMount, c.topMount)) {
        assert.ok(!String(mount).startsWith("bowl"), `${c.id} still uses ${mount}`);
      }
    }
  });

  test("Mitchell risers: 6, 12, 18, 24 inches, measured, no family requirement", () => {
    const risers = byCategory("adapter").filter((a) => a.id.startsWith("mitchell-riser"));
    assert.deepEqual(risers.map((r) => r.rise).sort((a, b) => a - b), [6, 12, 18, 24]);
    for (const r of risers) {
      assert.equal(r.measured, true, r.id);
      assert.equal(r.requiresFamily, undefined, r.id);
      assert.equal(r.bottomMount, "mitchell");
      assert.equal(r.topMount, "mitchell");
    }
  });

  test("dolly configurations are adapters: low mode, rotating offset, broken neck", () => {
    const configs = byCategory("adapter").filter((a) => a.id.startsWith("dolly-"));
    assert.equal(configs.length, 3);
    assert.ok(configs.some((a) => /low mode/i.test(a.name) && a.rise < 0), "low mode has negative rise");
    assert.ok(configs.some((a) => /rotating offset/i.test(a.name)));
    assert.ok(configs.some((a) => /broken neck/i.test(a.name)));
    const dollySupport = seed.components.find((c) => c.id === "dolly-placeholder");
    for (const a of configs) assert.equal(a.requiresFamily, dollySupport.family);
  });

  test("track tops out at dolly-wheels; the dolly accepts ground or dolly-wheels; the tripod ground only", () => {
    const trackItem = seed.components.find((c) => c.kind === "track");
    assert.equal(trackItem.bottomMount, "ground");
    assert.equal(trackItem.topMount, "dolly-wheels");
    assert.deepEqual(seed.components.find((c) => c.id === "dolly-placeholder").bottomMount, ["ground", "dolly-wheels"]);
    assert.equal(seed.components.find((c) => c.id === "tripod-baby-placeholder").bottomMount, "ground");
  });

  test("only a full apple box appears on a 12in or 20in face", () => {
    for (const box of seed.components.filter((c) => c.kind === "apple-box")) {
      if (box.orientation !== "flat") assert.equal(box.boxSize, "full", box.id);
    }
  });

  test("the seed still solves end to end, and no result puts an apple box under a dolly", () => {
    const result = solve(seed, { target: { type: "fixed", height: 30 }, packageId: "test-package", buildId: "build-placeholder" });
    assert.ok(result.feasible.length > 0);
    const everyChain = result.feasible.flatMap((c) => [c, ...c.alternates]);
    assert.ok(everyChain.some((c) => c.adapters.length > 0), "some solutions use adapters");
    for (const chain of everyChain) {
      const hasApple = chain.baseItems.some((i) => i.kind === "apple-box");
      assert.ok(!(hasApple && chain.support.kind === "dolly"), "the one hard apple-box prohibition");
    }
  });
});

// ---------------------------------------------------------------------------
// 2: adapters
// ---------------------------------------------------------------------------

describe("adapters (SPEC.md 3.6)", () => {
  test("a chain may include zero or more; each adds its signed rise to the interval and a piece to the count", () => {
    const gear = rigGear([tripod(), riser(6), riser(12, { rise: -3, name: "negative adapter" }), head()]);
    const chains = chainsFor(gear); // default cap 2: {}, {a}, {b}, {a,b}

    assert.equal(chains.length, 4);
    const byAdapters = (ids) => chains.find((c) => c.adapters.map((a) => a.id).sort().join() === ids.sort().join());
    const none = byAdapters([]);
    const both = byAdapters(["riser6", "riser12"]);
    assert.equal(none.min, 10);
    assert.equal(both.min, 10 + 6 - 3);
    assert.equal(both.max, 30 + 6 - 3);
    assert.equal(byAdapters(["riser12"]).min, 10 - 3, "rise is signed");
    assert.equal(both.pieceCount, none.pieceCount + 2);
  });

  test("adapters are chainable: they're stacked in whichever order their mounts mate", () => {
    // The converter takes a Mitchell and presents a bowl; the head is a bowl head.
    const converter = riser(0, { id: "converter", name: "Mitchell to bowl", topMount: "bowl-100", rise: 2 });
    const gear = rigGear([tripod(), riser(6), converter, head({ bottomMount: "bowl-100" })]);

    // Given in the wrong order, buildChain still finds the one that works.
    const chain = buildChain(gear, selection({ adapterIds: ["converter", "riser6"] }));
    assert.deepEqual(chain.adapters.map((a) => a.id), ["riser6", "converter"]);
    assert.equal(chain.min, 10 + 6 + 2);

    // The converter alone is fine; the riser can't go on top of it (bowl, not mitchell).
    assert.ok(buildChain(gear, selection({ adapterIds: ["converter"] })));
    const enumerated = chainsFor(gear).filter((c) => c.adapters.length === 2);
    assert.equal(enumerated.length, 1);
  });

  test("a head that needs a bowl is rejected without the adapter that provides one", () => {
    const gear = rigGear([tripod(), riser(6), head({ bottomMount: "bowl-100" })]);
    assert.equal(chainsFor(gear).length, 0);
    assert.throws(() => buildChain(gear, selection()), /mount mismatch/i);
  });

  test("mount facing: an adapter whose top mount faces down can't take a normal head", () => {
    const hanging = riser(6, { id: "hanging", name: "Hanging adapter", mountFacing: "down" });
    const gear = rigGear([tripod(), hanging, head()]);
    assert.throws(() => buildChain(gear, selection({ adapterIds: ["hanging"] })), /facing mismatch/i);
    assert.deepEqual(chainsFor(gear).map((c) => c.adapters.length), [0], "only the no-adapter chain survives");
  });

  test("mount facing: a head mode that needs a down-facing mount does mate with a down-facing adapter", () => {
    const hanging = riser(6, { id: "hanging", name: "Hanging adapter", mountFacing: "down" });
    const hangingHead = head({ modes: [{ name: "normal", rise: 0, cameraMountFacing: "up", supportMountFacing: "down" }] });
    const gear = rigGear([tripod(), hanging, hangingHead]);
    const chain = buildChain(gear, selection({ adapterIds: ["hanging"] }));
    assert.equal(chain.adapters.length, 1);
    assert.throws(() => buildChain(gear, selection()), /facing mismatch/i, "and without the adapter, it can't sit on the support");
  });

  test("adapters round-trip through the current-rig selection", () => {
    const gear = rigGear([tripod(), riser(6), head()]);
    const chain = buildChain(gear, selection({ adapterIds: ["riser6"] }));
    assert.deepEqual(describeCurrentRig(chain).adapterIds, ["riser6"]);
    const result = checkChain(gear, {
      target: { type: "fixed", height: 20 },
      packageId: "pkg",
      buildId: "bld",
      currentRig: describeCurrentRig(chain),
    });
    assert.equal(result.chain.adapters.length, 1);
    assert.equal(result.chain.min, 16);
  });
});

// ---------------------------------------------------------------------------
// 2: family
// ---------------------------------------------------------------------------

describe("family (SPEC.md 2.1)", () => {
  const fisherAdapter = riser(3, { id: "fisher-adapter", name: "Fisher low mode", rise: -3, requiresFamily: "fisher" });

  test("a family-specific adapter is rejected on a support of a different family, even with compatible mounts", () => {
    const chapmanDolly = dolly({ family: "chapman" });
    const gear = rigGear([chapmanDolly, fisherAdapter, head()]);

    // The mounts are fine: mitchell on mitchell on mitchell.
    assert.equal(fisherAdapter.bottomMount, chapmanDolly.topMount);
    assert.equal(fisherAdapter.topMount, head().bottomMount);

    assert.throws(
      () => buildChain(gear, selection({ supportId: "dolly", adapterIds: ["fisher-adapter"] })),
      /family mismatch.*requires family "fisher".*"chapman"/i
    );
    assert.equal(chainsFor(gear).filter((c) => c.adapters.length > 0).length, 0, "solve never returns it");
  });

  test("the same adapter is accepted on a support of the matching family", () => {
    const gear = rigGear([dolly({ family: "fisher" }), fisherAdapter, head()]);
    const chain = buildChain(gear, selection({ supportId: "dolly", adapterIds: ["fisher-adapter"] }));
    assert.equal(chain.adapters[0].id, "fisher-adapter");
    assert.equal(chainsFor(gear).filter((c) => c.adapters.length > 0).length, 1);
  });

  test("a support with no family fails any requiresFamily", () => {
    const gear = rigGear([dolly(), fisherAdapter, head()]);
    assert.throws(() => buildChain(gear, selection({ supportId: "dolly", adapterIds: ["fisher-adapter"] })), /no family/i);
  });

  test("an adapter with no requiresFamily (a Mitchell riser) works on any support the mounts allow", () => {
    const gear = rigGear([dolly({ family: "chapman" }), tripod(), riser(6), head()]);
    assert.ok(buildChain(gear, selection({ supportId: "dolly", adapterIds: ["riser6"] })));
    assert.ok(buildChain(gear, selection({ supportId: "tripod", adapterIds: ["riser6"] })));
  });

  test("family is checked separately from mounts: it names the rule, not a mount problem", () => {
    const gear = rigGear([dolly({ family: "chapman" }), fisherAdapter, head()]);
    try {
      buildChain(gear, selection({ supportId: "dolly", adapterIds: ["fisher-adapter"] }));
      assert.fail("should have thrown");
    } catch (err) {
      assert.match(err.message, /family/i);
      assert.doesNotMatch(err.message, /mount mismatch/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 3: track and dolly mounts
// ---------------------------------------------------------------------------

describe("track and dolly mounts (SPEC.md 2, 3.1, 3.2)", () => {
  test("a dolly can sit on track", () => {
    const gear = rigGear([dolly(), track(), head()]);
    const chain = buildChain(gear, selection({ supportId: "dolly", baseItemIds: ["track"] }));
    assert.equal(chain.baseItems[0].id, "track");
    assert.equal(chain.min, 1.5, "track's rise counts");
  });

  test("a dolly can also sit straight on the ground", () => {
    const gear = rigGear([dolly(), track(), head()]);
    assert.ok(buildChain(gear, selection({ supportId: "dolly" })));
  });

  test("a tripod can't sit on track", () => {
    const gear = rigGear([tripod(), track(), head()]);
    assert.throws(() => buildChain(gear, selection({ baseItemIds: ["track"] })), /mount mismatch.*dolly-wheels/i);
    assert.equal(chainsFor(gear).filter((c) => c.baseItems.length > 0).length, 0);
  });

  test("a hi-hat can't sit on track either", () => {
    const gear = rigGear([hiHat(), track(), head()]);
    assert.throws(() => buildChain(gear, selection({ supportId: "hihat", baseItemIds: ["track"] })), /mount mismatch/i);
  });

  test("track goes on top of the stack, and only one fits", () => {
    const plate = { id: "plate", name: "Plate", category: "base", bottomMount: "ground", topMount: "ground", rise: 1 };
    const gear = rigGear([dolly(), track(), track({ id: "track2" }), plate, head()]);
    const stacked = buildChain(gear, selection({ supportId: "dolly", baseItemIds: ["track", "plate"] }));
    assert.deepEqual(stacked.baseItems.map((i) => i.id), ["plate", "track"], "the plate goes under the track");
    assert.throws(() => buildChain(gear, selection({ supportId: "dolly", baseItemIds: ["track", "track2"] })), /can't be stacked/i);
  });
});

// ---------------------------------------------------------------------------
// 4: apple boxes, hard and soft
// ---------------------------------------------------------------------------

describe("apple boxes: the hard rule is dolly-only (SPEC.md 2.1)", () => {
  test("a dolly-plus-apple-box chain is rejected", () => {
    const gear = rigGear([dolly(), apple("half", "half", "flat", 4), head()]);
    assert.throws(() => buildChain(gear, selection({ supportId: "dolly", baseItemIds: ["half"] })), /apple box rule.*dolly/i);
    assert.equal(chainsFor(gear).filter((c) => c.baseItems.length > 0).length, 0, "solve never returns one");
  });

  test("an apple box under a track-mounted dolly is rejected too", () => {
    const gear = rigGear([dolly(), track(), apple("full", "full", "flat", 8), head()]);
    assert.throws(
      () => buildChain(gear, selection({ supportId: "dolly", baseItemIds: ["full", "track"] })),
      /apple box rule/i
    );
  });

  test("a tripod on apple boxes is legal — buildChain accepts it and solve enumerates it", () => {
    const gear = rigGear([tripod(), apple("half", "half", "flat", 4), head()]);
    const chain = buildChain(gear, selection({ baseItemIds: ["half"] }));
    assert.equal(chain.min, 14);
    assert.ok(chainsFor(gear).some((c) => c.baseItems.length > 0));
  });

  test("a hi-hat or low hat may sit on apple boxes", () => {
    const gear = rigGear([hiHat(), hiHat({ id: "lohat", name: "Low Hat", kind: "lo-hat", rise: 3 }), apple("half", "half", "flat", 4), head()]);
    assert.equal(buildChain(gear, selection({ supportId: "hihat", baseItemIds: ["half"] })).min, 10);
    assert.equal(buildChain(gear, selection({ supportId: "lohat", baseItemIds: ["half"] })).min, 7);
  });

  test("the rule is about apple boxes: other base-layer gear may still go under a dolly or a tripod", () => {
    const plate = { id: "plate", name: "Plate", category: "base", bottomMount: "ground", topMount: "ground", rise: 2 };
    const gear = rigGear([tripod(), dolly(), plate, head()]);
    assert.equal(buildChain(gear, selection({ baseItemIds: ["plate"] })).min, 12);
    assert.equal(buildChain(gear, selection({ supportId: "dolly", baseItemIds: ["plate"] })).min, 2);
  });

  test("the fallback prefers gear that isn't an apple box, uses one under a tripod only when nothing else closes the gap, and never under a dolly", () => {
    // A 12" shortfall on a 10-30 tripod: three 4" items, one more than the
    // normal 2-item cap reaches, so the solver falls back to suggesting them.
    const plate = (id) => ({ id, name: id, category: "base", bottomMount: "ground", topMount: "ground", rise: 4 });
    const half = (id) => apple(id, "half", "flat", 4);
    const target = { type: "fixed", height: 42 };
    const suggest = (components) => solve(rigGear(components), { target, packageId: "pkg", buildId: "bld" }).fallback.suggestion;

    const both = suggest([tripod(), half("a1"), plate("p1"), plate("p2"), plate("p3"), head()]);
    assert.deepEqual(both.items.map((i) => i.id).sort(), ["p1", "p2", "p3"], "three plates, not the apple box that's also on the shelf");

    const onlyApples = suggest([tripod(), half("a1"), half("a2"), half("a3"), head()]);
    assert.equal(onlyApples.closesGap, true, "legal under a tripod, so suggested when it's all there is");
    assert.equal(onlyApples.items.length, 3);

    const underDolly = suggest([dolly(), half("a1"), half("a2"), half("a3"), head()]);
    assert.equal(underDolly.closesGap, false);
    assert.equal(underDolly.maxAdditionalRise, 0, "apple boxes under a dolly aren't available");
  });

  test("delta search may add an apple box under a tripod but ranks it below an equal fix without one; under a dolly, never", () => {
    const plate = { id: "plate", name: "Plate", category: "base", bottomMount: "ground", topMount: "ground", rise: 4 };
    const gear = rigGear([tripod(), dolly(), hiHat(), apple("half", "half", "flat", 4), plate, head()]);
    const target = { type: "fixed", height: 34 }; // tripod tops out at 30

    const onTripod = checkChain(gear, { target, packageId: "pkg", buildId: "bld", chain: selection() });
    const oneChange = onTripod.delta.candidates.filter((c) => c.changes.length === 1 && c.changes[0].kind === "add");
    assert.deepEqual(oneChange.map((c) => c.changes[0].component.id), ["plate", "half"], "same margin; the apple-box fix sorts last");

    const onDolly = checkChain(gear, { target: { type: "fixed", height: 34 }, packageId: "pkg", buildId: "bld", chain: selection({ supportId: "dolly" }) });
    const dollyCandidates = onDolly.delta.candidates.filter((c) => c.chain.support.id === "dolly");
    assert.ok(dollyCandidates.length > 0, "the dolly has fixes");
    assert.ok(dollyCandidates.every((c) => c.chain.baseItems.every((i) => i.kind !== "apple-box")), "none of them uses an apple box");

    const underHiHat = checkChain(gear, { target: { type: "fixed", height: 10 }, packageId: "pkg", buildId: "bld", chain: selection({ supportId: "hihat" }) });
    assert.ok(underHiHat.delta.candidates.some((c) => c.changes[0].component?.id === "half" && c.chain.support.id === "hihat"));
  });
});

describe("apple boxes: the soft penalties (SPEC.md 2.1, 5.3)", () => {
  const plate = { id: "plate", name: "Plate", category: "base", bottomMount: "ground", topMount: "ground", rise: 4 };

  test("the light general penalty: an apple-box chain sorts below an equivalent chain without one — and is still allowed", () => {
    // Same 4" of rise either way, same margin, same adjustability, same piece
    // count. The apple box is listed first in the pool, so input order can't
    // explain the result.
    const gear = rigGear([hiHat(), apple("half", "half", "flat", 4), plate, head()]);

    // Opt out of pruning: the plate chain dominates the apple-box one (same margins and pieces, no penalty),
    // so by default the apple-box chain is dropped. This test is about how the two rank.
    const result = solve(gear, { target: { type: "fixed", height: 10 }, packageId: "pkg", buildId: "bld", collapse: false, dropDominated: false });

    const withApple = result.feasible.find((c) => c.baseItems.some((i) => i.id === "half"));
    const withPlate = result.feasible.find((c) => c.baseItems.some((i) => i.id === "plate"));
    assert.ok(withApple, "the hard rule allows it under a hi-hat, so it's a real result");
    assert.ok(withPlate);
    assert.equal(withApple.pieceCount, withPlate.pieceCount, "piece count can't be what separates them");
    assert.equal(withApple.evaluation.marginBelow, withPlate.evaluation.marginBelow);
    assert.ok(result.feasible.indexOf(withPlate) < result.feasible.indexOf(withApple));
  });

  test("the heavy penalty: a tripod on apple boxes sorts below a hi-hat on apple boxes even with far more margin — which in turn sorts below a no-apple chain with more margin", () => {
    const wideTripod = tripod({ id: "tripod2", name: "Wide tripod", riseRange: { specMin: 0, specMax: 60, practicalMin: 0, practicalMax: 60 } });
    const bigHiHat = hiHat({ id: "hihat16", name: "Tall hi-hat", rise: 16 });
    const gear = rigGear([tripod(), wideTripod, bigHiHat, apple("half", "half", "flat", 4), head()]);
    const target = { type: "fixed", height: 20 };
    const result = solve(gear, { target, packageId: "pkg", buildId: "bld", collapse: false, dropDominated: false });

    const find = (supportId, apples) =>
      result.feasible.find((c) => c.support.id === supportId && c.adapters.length === 0 && c.baseItems.length === (apples ? 1 : 0));
    const plainTripod = find("tripod", false); // [10,30]: margin 10, no apple box
    const hiHatOnApple = find("hihat16", true); // 16 + 4 = exactly 20: margin 0, light penalty
    const tripodOnApple = find("tripod2", true); // [4,64]: margin 16, heavy penalty

    assert.ok(plainTripod && hiHatOnApple && tripodOnApple);
    const margin = (c) => Math.min(c.evaluation.marginBelow, c.evaluation.marginAbove);
    assert.ok(margin(tripodOnApple) > margin(plainTripod) && margin(plainTripod) > margin(hiHatOnApple), "the margins run the other way");

    const order = (c) => result.feasible.indexOf(c);
    assert.ok(order(plainTripod) < order(hiHatOnApple), "light penalty: margin still decides it, and margin favors the plain tripod");
    assert.ok(order(hiHatOnApple) < order(tripodOnApple), "heavy penalty: outweighs the tripod's 16\" of margin");
  });

  test("a tripod on apple boxes sorts below every chain that doesn't put one there, whatever its margin", () => {
    const wideTripod = tripod({ id: "tripod2", name: "Wide tripod", riseRange: { specMin: 0, specMax: 60, practicalMin: 0, practicalMax: 60 } });
    const gear = rigGear([tripod(), wideTripod, apple("half", "half", "flat", 4), head()]);
    const result = solve(gear, { target: { type: "fixed", height: 20 }, packageId: "pkg", buildId: "bld", collapse: false });
    const isHeavy = (c) => c.support.kind === "tripod" && c.baseItems.some((i) => i.kind === "apple-box");
    const firstHeavy = result.feasible.findIndex(isHeavy);
    assert.ok(firstHeavy > 0);
    assert.ok(result.feasible.slice(firstHeavy).every(isHeavy), "once one appears, only more of them follow");
  });

  test("hard and soft are separate: the dolly chain is absent; hi-hat and tripod chains are present, just ranked lower", () => {
    const gear = rigGear([tripod(), dolly(), hiHat(), apple("half", "half", "flat", 4), head()]);
    const all = chainsFor(gear);
    assert.ok(!all.some((c) => c.support.id === "dolly" && c.baseItems.length > 0), "hard rule: absent");
    assert.ok(all.some((c) => c.support.id === "hihat" && c.baseItems.length > 0), "soft: present");
    assert.ok(all.some((c) => c.support.id === "tripod" && c.baseItems.length > 0), "soft (heavy): present");
  });
});

// ---------------------------------------------------------------------------
// 5: apple-box orientation
// ---------------------------------------------------------------------------

describe("apple-box orientation (SPEC.md 3.1)", () => {
  test("a half apple on its 12in face is rejected", () => {
    const gear = rigGear([hiHat(), apple("half12", "half", "12in", 12), head()]);
    assert.throws(
      () => buildChain(gear, selection({ supportId: "hihat", baseItemIds: ["half12"] })),
      /half apple can't be used on its 12" face/i
    );
  });

  test("quarter and pancake apples are flat-only too, on either face", () => {
    for (const [boxSize, orientation, rise] of [["quarter", "12in", 12], ["quarter", "20in", 20], ["pancake", "12in", 12], ["pancake", "20in", 20], ["half", "20in", 20]]) {
      const id = `${boxSize}${orientation}`;
      const gear = rigGear([hiHat(), apple(id, boxSize, orientation, rise), head()]);
      assert.throws(() => buildChain(gear, selection({ supportId: "hihat", baseItemIds: [id] })), /apple box rule/i, id);
    }
  });

  test("a full apple may stand on its 12in or 20in face", () => {
    const gear = rigGear([hiHat(), apple("full12", "full", "12in", 12), apple("full20", "full", "20in", 20), head()]);
    assert.equal(buildChain(gear, selection({ supportId: "hihat", baseItemIds: ["full12"] })).min, 18);
    assert.equal(buildChain(gear, selection({ supportId: "hihat", baseItemIds: ["full20"] })).min, 26);
  });

  test("every apple box may lie flat", () => {
    const gear = rigGear([
      hiHat(),
      apple("f", "full", "flat", 8),
      apple("h", "half", "flat", 4),
      apple("q", "quarter", "flat", 2),
      apple("p", "pancake", "flat", 1),
      head(),
    ]);
    for (const id of ["f", "h", "q", "p"]) {
      assert.ok(buildChain(gear, selection({ supportId: "hihat", baseItemIds: [id] })), id);
    }
  });

  test("solve never returns an invalid-face apple box", () => {
    const gear = rigGear([hiHat(), apple("half12", "half", "12in", 12), apple("half", "half", "flat", 4), head()]);
    const withBoxes = chainsFor(gear, { maxBaseLayerItems: 1 }).filter((c) => c.baseItems.length > 0);
    assert.deepEqual(withBoxes.map((c) => c.baseItems[0].id), ["half"]);
  });
});

// ---------------------------------------------------------------------------
// 6: range targets are always moveable
// ---------------------------------------------------------------------------

describe("range targets default to moveable (SPEC.md 5.1)", () => {
  const gear = rigGear([tripod(), dolly(), head()]);
  const range = { type: "range", low: 12, high: 25 }; // no rangeType supplied

  test("rangeType isn't required, and a range target means a live move", () => {
    const onTripod = buildChain(gear, selection());
    const onDolly = buildChain(gear, selection({ supportId: "dolly" }));
    assert.equal(isFeasible(onTripod, range, 0.5), false, "tripod legs can't move live, however wide");
    assert.equal(isFeasible(onDolly, range, 0.5), true);
  });

  test("solve mode, given no rangeType, returns only chains that can move live", () => {
    const result = solve(gear, { target: range, packageId: "pkg", buildId: "bld" });
    assert.ok(result.feasible.length > 0);
    assert.ok(result.feasible.every((c) => c.support.id === "dolly"));
  });

  test("rangeType stays in the data model: an explicit 'adjustable' is still honored", () => {
    const onTripod = buildChain(gear, selection());
    assert.equal(isFeasible(onTripod, { ...range, rangeType: "adjustable" }, 0.5), true);
    assert.equal(isFeasible(onTripod, { ...range, rangeType: "moveable" }, 0.5), false);
  });

  test("a fixed target is unaffected", () => {
    const onTripod = buildChain(gear, selection());
    assert.equal(isFeasible(onTripod, { type: "fixed", height: 20 }, 0.5), true);
  });
});

// ---------------------------------------------------------------------------
// Multi-mode adapters (SPEC.md 3.6)
// ---------------------------------------------------------------------------

describe("multi-mode adapters", () => {
  test("each mode has its own signed rise and top-mount facing", () => {
    const gear = rigGear([tripod(), offset(), head()]);

    const upright = buildChain(gear, selection({ adapterIds: ["offset"] })); // no mode named: the first
    assert.equal(upright.adapters[0].mode, "upright");
    assert.equal(upright.adapters[0].rise, 1);
    assert.equal(upright.adapters[0].mountFacing, "up");
    assert.equal(upright.min, 11);

    const twoMode = rigGear([tripod(), offset(), twoModeHead()]);
    const underslung = buildChain(twoMode, selection({ headId: "hd2", modeName: "underslung", attachName: "base-inverted", adapterIds: ["offset"], adapterModes: { offset: "underslung" } }));
    assert.equal(underslung.adapters[0].mode, "underslung");
    assert.equal(underslung.adapters[0].rise, 0);
    assert.equal(underslung.adapters[0].mountFacing, "down");
  });

  test("naming a mode the adapter doesn't have is an error", () => {
    const gear = rigGear([tripod(), offset(), head()]);
    assert.throws(() => buildChain(gear, selection({ adapterIds: ["offset"], adapterModes: { offset: "sideways" } })), /no mode "sideways"/i);
  });

  test("solve tries each mode, keeping only the ones the rest of the chain can sit on", () => {
    // A normal-only head needs an up-facing mount, so only the upright offset fits.
    const normalOnly = chainsFor(rigGear([tripod(), offset(), head()])).filter((c) => c.adapters.length > 0);
    assert.deepEqual(normalOnly.map((c) => c.adapters[0].mode), ["upright"]);

    // A head with both modes: normal takes the upright offset; underslung takes the underslung one.
    const both = chainsFor(rigGear([tripod(), offset(), twoModeHead()])).filter((c) => c.adapters.length > 0);
    const pairs = both.map((c) => `${c.mode.name}+${c.adapters[0].mode}`).sort();
    assert.deepEqual(pairs, ["normal+upright", "underslung+underslung"]);
  });

  test("one physical adapter is used once, in one mode — never both at the same time", () => {
    const gear = rigGear([tripod(), offset(), riser(6), twoModeHead()]);
    for (const chain of chainsFor(gear)) {
      const ids = chain.adapters.map((a) => a.id);
      assert.equal(new Set(ids).size, ids.length);
    }
    assert.throws(() => buildChain(gear, selection({ adapterIds: ["offset", "offset"] })), /twice/i);
  });

  test("the mode survives the current-rig round trip", () => {
    const gear = rigGear([tripod(), offset(), twoModeHead()]);
    const chain = buildChain(gear, selection({ headId: "hd2", modeName: "underslung", attachName: "base-inverted", adapterIds: ["offset"], adapterModes: { offset: "underslung" } }));
    const rig = describeCurrentRig(chain);
    assert.deepEqual(rig.adapterModes, { offset: "underslung" });
    const again = buildChain(gear, { packageId: "pkg", buildId: "bld", ...rig });
    assert.equal(again.adapters[0].mode, "underslung");
    assert.equal(again.min, chain.min);
  });

  test("seed: the Mitchell offset is measured, with upright (+1, up) and underslung (0, down) modes", () => {
    const seed = JSON.parse(readFileSync(path.join(__dirname, "..", "gear.json"), "utf8"));
    const o = seed.components.find((c) => c.id === "mitchell-offset");
    assert.equal(o.category, "adapter");
    assert.equal(o.measured, true);
    assert.equal(o.requiresFamily, undefined);
    assert.deepEqual(o.modes, [
      { name: "upright", rise: 1, mountFacing: "up" },
      { name: "underslung", rise: 0, mountFacing: "down" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Head support-side facing (SPEC.md 2, 3.3)
// ---------------------------------------------------------------------------

describe("head support-side facing", () => {
  const under = (over = {}) =>
    selection({ headId: "hd2", modeName: "underslung", attachName: "base-inverted", ...over });

  test("an underslung head mode is rejected directly on a tripod", () => {
    const gear = rigGear([tripod(), twoModeHead()]);
    assert.throws(
      () => buildChain(gear, under()),
      /facing mismatch.*underslung mode needs a down-facing mount beneath it.*"Tripod".*facing up/i
    );
    const underslungChains = chainsFor(gear).filter((c) => c.mode.name === "underslung");
    assert.equal(underslungChains.length, 0, "solve never returns one");
  });

  test("...and accepted with an offset in underslung mode between them", () => {
    const gear = rigGear([tripod(), offset(), twoModeHead()]);
    const chain = buildChain(gear, under({ adapterIds: ["offset"], adapterModes: { offset: "underslung" } }));
    assert.equal(chain.mode.name, "underslung");
    assert.deepEqual(chain.adapters.map((a) => a.mode), ["underslung"]);
    // tripod 10-30, offset 0, head -4, inverted camera 0
    assert.equal(chain.min, 6);
    assert.equal(chain.max, 26);
    assert.ok(chainsFor(gear).some((c) => c.mode.name === "underslung" && c.adapters[0]?.mode === "underslung"));
  });

  test("the offset in upright mode doesn't help: its top faces up", () => {
    const gear = rigGear([tripod(), offset(), twoModeHead()]);
    assert.throws(
      () => buildChain(gear, under({ adapterIds: ["offset"], adapterModes: { offset: "upright" } })),
      /facing mismatch.*upright mode.*facing up/i
    );
  });

  test("neither does a riser, or any number of them: every riser top faces up", () => {
    const gear = rigGear([tripod(), riser(6), riser(12), twoModeHead()]);
    assert.throws(() => buildChain(gear, under({ adapterIds: ["riser6", "riser12"] })), /facing mismatch/i);
    assert.equal(chainsFor(gear).filter((c) => c.mode.name === "underslung").length, 0);
  });

  test("a hi-hat top faces up too", () => {
    const gear = rigGear([hiHat(), twoModeHead()]);
    assert.throws(() => buildChain(gear, under({ supportId: "hihat" })), /facing mismatch/i);
  });

  test("the reverse is rejected as well: a normal head mode can't sit on a down-facing top", () => {
    const gear = rigGear([tripod(), offset(), twoModeHead()]);
    assert.throws(
      () => buildChain(gear, selection({ headId: "hd2", adapterIds: ["offset"], adapterModes: { offset: "underslung" } })),
      /normal mode needs an up-facing mount beneath it.*underslung mode.*facing down/i
    );
  });

  test("a normal head mode sits on a tripod, a riser, or an upright offset", () => {
    const gear = rigGear([tripod(), riser(6), offset(), twoModeHead()]);
    assert.ok(buildChain(gear, selection({ headId: "hd2" })));
    assert.ok(buildChain(gear, selection({ headId: "hd2", adapterIds: ["riser6"] })));
    assert.ok(buildChain(gear, selection({ headId: "hd2", adapterIds: ["offset"], adapterModes: { offset: "upright" } })));
  });

  test("a head mode that declares nothing needs an up-facing mount, like a normal mode", () => {
    const gear = rigGear([tripod(), offset(), head()]); // head()'s mode has no supportMountFacing
    assert.ok(buildChain(gear, selection()));
    assert.throws(() => buildChain(gear, selection({ adapterIds: ["offset"], adapterModes: { offset: "underslung" } })), /facing mismatch/i);
  });

  test("seed: every head mode declares supportMountFacing; the standard head's underslung mode needs a down-facing mount", () => {
    const seed = JSON.parse(readFileSync(path.join(__dirname, "..", "gear.json"), "utf8"));
    const heads = seed.components.filter((c) => c.category === "head");
    for (const h of heads) for (const m of h.modes) assert.ok(["up", "down"].includes(m.supportMountFacing), `${h.id}/${m.name}`);
    const standard = heads.find((h) => h.id === "head-standard-placeholder");
    assert.equal(standard.modes.find((m) => m.name === "normal").supportMountFacing, "up");
    assert.equal(standard.modes.find((m) => m.name === "underslung").supportMountFacing, "down");
  });

  test("seed: the real standard head can't be underslung on the real tripod, and can with the real offset", () => {
    const seed = JSON.parse(readFileSync(path.join(__dirname, "..", "gear.json"), "utf8"));
    const sel = { packageId: "test-package", buildId: "build-placeholder", supportId: "tripod-baby-placeholder", headId: "head-standard-placeholder", modeName: "underslung", attachName: "base-inverted" };
    assert.throws(() => buildChain(seed, sel), /facing mismatch/i);
    const chain = buildChain(seed, { ...sel, adapterIds: ["mitchell-offset"], adapterModes: { "mitchell-offset": "underslung" } });
    assert.equal(chain.adapters[0].mode, "underslung");
  });
});

// ---------------------------------------------------------------------------
// Delta search proposes adapters (SPEC.md 5.7)
// ---------------------------------------------------------------------------

describe("delta search with adapters", () => {
  const target34 = { type: "fixed", height: 34 }; // a plain 10-30 tripod is 4" short
  const check = (gear, target, over = {}) =>
    checkChain(gear, { target, packageId: "pkg", buildId: "bld", chain: selection(), ...over });

  test("adding a Mitchell riser is a candidate fix for a shortfall, and the more centered riser ranks first", () => {
    const gear = rigGear([tripod(), riser(6), riser(12), head()]);
    const { delta } = check(gear, target34);
    const singles = delta.candidates.filter((c) => c.changes.length === 1);
    assert.deepEqual(singles.map((c) => c.changes[0].component.id), ["riser12", "riser6"], "12\" leaves 8\" of margin, 6\" only 2\"");
    assert.equal(singles[0].changes[0].kind, "add-adapter");
    assert.equal(singles[0].chain.min, 22);
    // Fewest changes dominates: the two-riser fix comes after both single ones.
    assert.equal(delta.candidates.findIndex((c) => c.changes.length === 2), singles.length);
  });

  test("swapping a riser for another is a candidate", () => {
    const gear = rigGear([tripod(), riser(6), riser(12), head()]);
    const { delta } = check(gear, { type: "fixed", height: 40 }, { chain: selection({ adapterIds: ["riser6"] }) }); // 6" riser: 16-36
    const swap = delta.candidates.find((c) => c.changes[0].kind === "swap-adapter");
    assert.ok(swap, "the swap is proposed");
    assert.equal(swap.changes.length, 1);
    assert.equal(swap.changes[0].from.id, "riser6");
    assert.equal(swap.changes[0].to.id, "riser12");
    assert.deepEqual(swap.chain.adapters.map((a) => a.id), ["riser12"]);
  });

  test("an added adapter is tried in each mode, and only a mode the rest of the chain can take is proposed", () => {
    const gear = rigGear([hiHat(), offset(), head()]); // hi-hat 6": upright offset makes 7, the normal head can't take underslung
    const { delta } = check(gear, { type: "fixed", height: 7 }, { chain: selection({ supportId: "hihat" }) });
    const offsets = delta.candidates.filter((c) => c.changes.some((ch) => ch.kind === "add-adapter"));
    assert.equal(offsets.length, 1);
    assert.equal(offsets[0].changes[0].mode, "upright");
    assert.equal(offsets[0].chain.min, 7);
  });

  test("an adapter mode swap that would leave the head nothing to hang from is not offered", () => {
    // The underslung head hangs from the offset's down-facing top. Flipping the offset to
    // upright would face it up, so that swap must not be a candidate.
    const gear = rigGear([tripod(), offset(), twoModeHead()]);
    const start = selection({ headId: "hd2", modeName: "underslung", attachName: "base-inverted", adapterIds: ["offset"], adapterModes: { offset: "underslung" } });
    const { delta } = check(gear, { type: "fixed", height: 100 }, { chain: start });
    assert.equal(delta.candidates.filter((c) => c.changes.some((ch) => ch.kind === "swap-adapter")).length, 0, "upright would leave the underslung head with nothing to hang from");
  });

  test("family is respected: an adapter of the wrong family is never proposed", () => {
    const fisher = riser(6, { id: "fisher6", name: "Fisher 6", requiresFamily: "fisher" });
    const gear = rigGear([tripod(), fisher, head()]);
    const { delta } = check(gear, target34);
    assert.equal(delta.candidates.length, 0);
    assert.match(delta.message, /no addition or swap/i);
  });

  test("only the best 10 come back, with the full count alongside", () => {
    const risers = [4, 5, 6, 7, 8, 9, 10, 12].map((n) => riser(n));
    const gear = rigGear([tripod(), ...risers, head()]);
    const { delta } = check(gear, { type: "fixed", height: 33 });
    assert.equal(delta.candidates.length, 10);
    assert.ok(delta.total > 10);
    assert.ok(delta.candidates.every((c) => c.changes.length <= 3), "at most 3 changes");
    assert.equal(delta.candidates[0].changes.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Dropping dominated chains (SPEC.md 5.3 step 4)
// ---------------------------------------------------------------------------

describe("dropping dominated chains", () => {
  const at = (height) => ({ type: "fixed", height });
  // Flat lists, so what was dropped is visible.
  const flat = (gear, height, over = {}) =>
    solve(gear, { target: at(height), packageId: "pkg", buildId: "bld", collapse: false, ...over }).feasible;
  const riserIds = (c) => c.adapters.map((a) => a.id).sort().join("+") || "none";
  const margins = (c) => `${c.evaluation.marginBelow}/${c.evaluation.marginAbove}`;

  test("a riser that doesn't improve either margin is dropped; one that centers the target survives", () => {
    // Tripod 10-30, target 29: bare it sits 19 from the bottom and 1 from the top.
    // A 6" riser (16-36) centers it at 13 / 7 and survives. A 0" spacer changes
    // neither margin and only adds a piece, so the bare tripod dominates it.
    const gear = rigGear([tripod(), riser(6), riser(0, { id: "spacer", name: '0" spacer' }), head()]);
    const kept = flat(gear, 29);
    assert.deepEqual(kept.map(riserIds).sort(), ["none", "riser6"]);
    assert.equal(margins(kept.find((c) => riserIds(c) === "riser6")), "13/7", "the riser centers it");

    const all = flat(gear, 29, { dropDominated: false });
    assert.ok(all.some((c) => riserIds(c) === "spacer"), "it was a real, feasible chain before pruning");
  });

  test("6\" + 12\" is dominated by a single 18\": same margins, more pieces", () => {
    const gear = rigGear([tripod(), riser(6), riser(12), riser(18), head()]);
    const kept = flat(gear, 30).map(riserIds);
    assert.ok(kept.includes("riser18"));
    assert.ok(!kept.includes("riser12+riser6"));
    assert.ok(flat(gear, 30, { dropDominated: false }).map(riserIds).includes("riser12+riser6"));
  });

  test("moving the target toward one end of the range trades one margin for the other, so neither riser chain dominates", () => {
    // Target 20 is dead center of 10-30 (10 / 10). A 6" riser gives 4 / 16: worse below, better above.
    const gear = rigGear([tripod(), riser(6), head()]);
    const kept = flat(gear, 20);
    assert.deepEqual(kept.map(riserIds).sort(), ["none", "riser6"]);
    assert.equal(margins(kept.find((c) => riserIds(c) === "none")), "10/10");
    assert.equal(margins(kept.find((c) => riserIds(c) === "riser6")), "4/16");
  });

  test("a chain with a wider range beats a narrower one on both margins — across supports", () => {
    const wide = tripod({ id: "wide", name: "Wide tripod", riseRange: { specMin: 0, specMax: 60, practicalMin: 0, practicalMax: 60 } });
    const gear = rigGear([tripod(), wide, head()]);
    assert.deepEqual(flat(gear, 20).map((c) => c.support.id), ["wide"]);
    assert.equal(flat(gear, 20, { dropDominated: false }).length, 2);
  });

  test("adjustability counts: a moveable chain drops an otherwise identical adjustable one, never the reverse", () => {
    const boom = tripod({ id: "boom", name: "Boom", adjustability: "moveable" });
    const gear = rigGear([tripod(), boom, head()]);
    assert.deepEqual(flat(gear, 20).map((c) => c.support.id), ["boom"]);
  });

  test("a ranking penalty counts: a chain without one drops an otherwise identical chain that has it", () => {
    const plate = { id: "plate", name: "Plate", category: "base", bottomMount: "ground", topMount: "ground", rise: 4 };
    // Light apple-box penalty, on a hi-hat where the hard rules allow it.
    const onHat = rigGear([hiHat(), apple("half", "half", "flat", 4), plate, head()]);
    assert.deepEqual(flat(onHat, 10).map((c) => c.baseItems.map((i) => i.id).join()), ["plate"]);
    // Heavy penalty, a tripod on apple boxes.
    const onTripod = rigGear([tripod(), apple("half", "half", "flat", 4), plate, head()]);
    const kept = flat(onTripod, 20);
    assert.ok(kept.some((c) => c.baseItems.some((i) => i.id === "plate")));
    const alone = (id) => (c) => c.baseItems.length === 1 && c.baseItems[0].id === id;
    assert.ok(kept.some(alone("plate")));
    assert.ok(!kept.some(alone("half")), "the lone apple-box chain is dominated by the equal plate chain");
    // Plate and apple together rise 8", a different position: incomparable, so it stays.
    assert.ok(kept.some((c) => c.baseItems.length === 2));
  });

  test("chains that tie on every dimension both stay", () => {
    const gear = rigGear([tripod(), tripod({ id: "tripod2", name: "Tripod 2" }), head()]);
    assert.equal(flat(gear, 20).length, 2);
  });

  test("dominated chains are gone, not demoted to alternates", () => {
    const gear = rigGear([tripod(), riser(6), riser(12), riser(18), head()]);
    const { feasible } = solve(gear, { target: at(30), packageId: "pkg", buildId: "bld" });
    const everyChain = feasible.flatMap((c) => [c, ...c.alternates]).map(riserIds);
    assert.ok(!everyChain.includes("riser12+riser6"));
  });

  test("dropDominated: false keeps everything", () => {
    const gear = rigGear([tripod(), riser(6), riser(12), riser(18), head()]);
    assert.equal(flat(gear, 30, { dropDominated: false }).length, 5);
    assert.equal(flat(gear, 30).length, 4);
  });
});

// ---------------------------------------------------------------------------
// Collapsing equivalent chains (SPEC.md 5.3 step 5)
// ---------------------------------------------------------------------------

describe("collapsing equivalent chains", () => {
  const solveFor = (gear, over = {}) =>
    solve(gear, { target: { type: "fixed", height: 30 }, packageId: "pkg", buildId: "bld", ...over });
  const adapterIds = (c) => c.adapters.map((a) => a.id).sort();

  test("the key is support, head, head mode, and attach point: every adapter choice on the same four is one result", () => {
    const gear = rigGear([tripod(), riser(6), riser(12), riser(18), head()]);
    const { feasible } = solveFor(gear);
    // none, 6, 12, 18 survive dominance (6 + 12 is dropped); all four share one key.
    assert.equal(feasible.length, 1);
    assert.equal(feasible[0].count, 4);
    assert.equal(feasible[0].alternates.length, 3);
  });

  test("the representative is the best-ranked member, not the simplest", () => {
    const gear = rigGear([tripod(), riser(6), riser(12), riser(18), head()]);
    const [result] = solveFor(gear).feasible;
    // Target 30: none 0 margin, 6" -> 6, 12" -> 8, 18" -> 2. The 12" riser is best,
    // even though the bare tripod (no adapters) is the simplest.
    assert.deepEqual(adapterIds(result), ["riser12"]);
    assert.ok(result.alternates.some((c) => c.adapters.length === 0 && c.pieceCount < result.pieceCount), "and the simpler chain is an alternate");
  });

  test("alternates stay in rank order", () => {
    const gear = rigGear([tripod(), riser(6), riser(12), riser(18), head()]);
    const [result] = solveFor(gear).feasible;
    const minMargin = (c) => Math.min(c.evaluation.marginBelow, c.evaluation.marginAbove);
    const ranks = [result, ...result.alternates].map(minMargin);
    assert.deepEqual(ranks, [8, 6, 2, 0]);
  });

  test("a different support, head mode, or attach point is a different result", () => {
    const twoAttach = head({
      modes: [
        { name: "a", rise: 0, cameraMountFacing: "up", supportMountFacing: "up" },
        { name: "b", rise: 0, cameraMountFacing: "down", supportMountFacing: "up" },
      ],
    });
    const gear = rigGear([tripod(), tripod({ id: "tripod2", name: "Tripod 2" }), twoAttach]);
    const keys = solveFor(gear).feasible.map((c) => `${c.support.id}|${c.mode.name}|${c.attach.name}`).sort();
    assert.deepEqual(keys, ["tripod2|a|base", "tripod2|b|base-inverted", "tripod|a|base", "tripod|b|base-inverted"]);
  });

  test("base-layer choices aren't part of the key: a chain with and without one share a result", () => {
    const plate = { id: "plate", name: "Plate", category: "base", bottomMount: "ground", topMount: "ground", rise: 6 };
    const gear = rigGear([tripod(), plate, head()]);
    // Bare 10-30 sits (20 / 0); on the plate 16-36 it sits (14 / 6): incomparable, so both survive.
    assert.equal(solveFor(gear, { collapse: false }).feasible.length, 2);
    const { feasible } = solveFor(gear);
    assert.equal(feasible.length, 1);
    assert.equal(feasible[0].baseItems[0].id, "plate", "the plate chain has the better margin, so it represents the group");
    assert.equal(feasible[0].alternates[0].baseItems.length, 0);
  });

  test("results carry a count and alternates even when nothing collapsed", () => {
    const gear = rigGear([tripod(), head()]);
    for (const c of solveFor(gear).feasible) {
      assert.equal(c.count, 1);
      assert.deepEqual(c.alternates, []);
    }
  });

  test("collapse: false returns every chain flat, one per result", () => {
    const gear = rigGear([tripod(), riser(6), riser(12), riser(18), head()]);
    const flat = solveFor(gear, { collapse: false });
    assert.equal(flat.feasible.length, 4);
    assert.ok(flat.feasible.every((c) => c.count === 1 && c.alternates.length === 0));
  });

  test("results are ordered by their representative's rank", () => {
    const wide = tripod({ id: "wide", name: "Wide", adjustability: "moveable", riseRange: { specMin: 0, specMax: 80, practicalMin: 0, practicalMax: 80 } });
    const twoAttach = head({
      modes: [
        { name: "a", rise: 0, cameraMountFacing: "up", supportMountFacing: "up" },
        { name: "b", rise: 8, cameraMountFacing: "down", supportMountFacing: "up" },
      ],
    });
    const gear = rigGear([wide, twoAttach]);
    const margins = solveFor(gear).feasible.map((c) => Math.min(c.evaluation.marginBelow, c.evaluation.marginAbove));
    assert.deepEqual(margins, [...margins].sort((x, y) => y - x));
  });

  test("nothing is lost, and the seed's typical queries come in under 20 top-level results", () => {
    const seed = JSON.parse(readFileSync(path.join(__dirname, "..", "gear.json"), "utf8"));
    for (const target of [{ type: "fixed", height: 30 }, { type: "range", low: 25, high: 40 }]) {
      const q = { target, packageId: "test-package", buildId: "build-placeholder" };
      const pruned = solve(seed, { ...q, collapse: false });
      const collapsed = solve(seed, q);
      assert.equal(collapsed.feasible.reduce((sum, c) => sum + c.count, 0), pruned.feasible.length, "counts add up to what dominance left");
      for (const c of collapsed.feasible) assert.equal(c.alternates.length, c.count - 1);
      assert.ok(collapsed.feasible.length < 20, `${JSON.stringify(target)} gave ${collapsed.feasible.length}`);
    }
  });
});
