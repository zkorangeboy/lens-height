import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { mergeOverrides } from "../src/model.js";
import { solve, enumerateChains, margin } from "../src/solver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Seed data sanity
// ---------------------------------------------------------------------------

describe("gear.json seed data", () => {
  const seed = JSON.parse(readFileSync(path.join(__dirname, "..", "gear.json"), "utf8"));

  test("parses and matches the documented schema shape", () => {
    assert.equal(seed.schemaVersion, 1);
    assert.ok(Array.isArray(seed.components) && seed.components.length > 0);
    assert.ok(Array.isArray(seed.packages) && seed.packages.length > 0);
    assert.ok(Array.isArray(seed.builds) && seed.builds.length > 0);
  });

  test("every seed component carries a boolean measured flag", () => {
    for (const component of seed.components) {
      assert.equal(typeof component.measured, "boolean", `${component.id}.measured should be true/false, not missing or non-boolean`);
    }
  });

  test("solves against the real seed file end to end", () => {
    const result = solve(seed, {
      target: { type: "fixed", height: 30 },
      packageId: "test-package",
      buildId: "build-placeholder",
    });
    assert.ok(result.feasible.length > 0);
  });
});

describe("mergeOverrides (SPEC.md 4.1)", () => {
  test("deep-merges a field override without mutating the seed, override wins", () => {
    const seed = {
      schemaVersion: 1,
      components: [
        { id: "c1", rise: 6.75, measured: false, riseRange: { practicalMin: 10, practicalMax: 27 } },
      ],
    };
    const overridesDoc = {
      schemaVersion: 1,
      overrides: {
        c1: { rise: 6.5, measured: true, riseRange: { practicalMax: 26.0 } },
      },
    };

    const merged = mergeOverrides(seed, overridesDoc);

    assert.equal(merged.components[0].rise, 6.5);
    assert.equal(merged.components[0].measured, true);
    assert.equal(merged.components[0].riseRange.practicalMax, 26.0);
    assert.equal(merged.components[0].riseRange.practicalMin, 10, "unrelated nested field preserved");
    assert.equal(seed.components[0].rise, 6.75, "seed object left untouched");
  });

  test("appends customComponents, or replaces a seed component of the same id", () => {
    const seed = { schemaVersion: 1, components: [{ id: "c1", rise: 1 }] };
    const overridesDoc = {
      overrides: {},
      customComponents: [
        { id: "c1", rise: 999 },
        { id: "c2", rise: 5 },
      ],
    };

    const merged = mergeOverrides(seed, overridesDoc);
    assert.equal(merged.components.length, 2);
    assert.equal(merged.components.find((c) => c.id === "c1").rise, 999);
    assert.equal(merged.components.find((c) => c.id === "c2").rise, 5);
  });
});

// ---------------------------------------------------------------------------
// Solver — SPEC.md 5, cases enumerated in SPEC.md 8 step 2
// ---------------------------------------------------------------------------

/**
 * A minimal, hand-computable gear fixture. Each test overrides just the
 * pieces it needs via the `pool`/`build` helpers below.
 */
function makeGear({ components, packageComponentIds, build, builds }) {
  return {
    schemaVersion: 1,
    components,
    packages: [{ id: "pkg", name: "pkg", componentIds: packageComponentIds }],
    builds: builds || [build],
  };
}

describe("solver", () => {
  test("fixed target: feasible chain with correct interval and margin ranking", () => {
    const support = {
      id: "s1",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 10, specMax: 30, practicalMin: 10, practicalMax: 30 },
      levelingLoss: 1,
    };
    const head = {
      id: "h1",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 5, cameraMountFacing: "up" }],
    };
    const cam = { id: "cam1", category: "camera-body", opticalCenterAboveBase: 5 };
    const build = { id: "b1", componentIds: ["cam1"], bottomMount: "flat-38", hasRatedTopHandle: false };
    const gear = makeGear({
      components: [support, head, cam],
      packageComponentIds: ["s1", "h1", "cam1"],
      build,
    });

    // interval = [practicalMin(10) + headRise(5) + buildRise(5), (practicalMax(30)-levelingLoss(1)) + 5 + 5]
    //          = [20, 39]
    const result = solve(gear, {
      target: { type: "fixed", height: 25 },
      packageId: "pkg",
      buildId: "b1",
    });

    assert.equal(result.fallback, null);
    assert.equal(result.feasible.length, 1);
    const chain = result.feasible[0];
    assert.equal(chain.min, 20);
    assert.equal(chain.max, 39);
    assert.equal(chain.attach.name, "base");
  });

  test("range target: feasible only when the whole [low, high] fits inside the interval", () => {
    const support = {
      id: "s1",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 10, specMax: 30, practicalMin: 10, practicalMax: 30 },
      levelingLoss: 1,
    };
    const head = {
      id: "h1",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 5, cameraMountFacing: "up" }],
    };
    const cam = { id: "cam1", category: "camera-body", opticalCenterAboveBase: 5 };
    const build = { id: "b1", componentIds: ["cam1"], bottomMount: "flat-38", hasRatedTopHandle: false };
    const gear = makeGear({
      components: [support, head, cam],
      packageComponentIds: ["s1", "h1", "cam1"],
      build,
    });
    // interval = [20, 39], as above.

    const fits = solve(gear, {
      target: { type: "range", low: 22, high: 35 },
      packageId: "pkg",
      buildId: "b1",
    });
    assert.equal(fits.feasible.length, 1);

    const overhangs = solve(gear, {
      target: { type: "range", low: 15, high: 35 }, // low is outside [20,39] beyond tolerance
      packageId: "pkg",
      buildId: "b1",
    });
    assert.equal(overhangs.feasible.length, 0);
    assert.equal(overhangs.fallback.direction, "tall");
  });

  test("underslung head: negative rise, both camera attach options (base-inverted and top-handle)", () => {
    const support = {
      id: "s2",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 10, specMax: 30, practicalMin: 10, practicalMax: 30 },
      levelingLoss: 1,
    };
    const head = {
      id: "h2",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "underslung", rise: -4, cameraMountFacing: "down" }],
    };
    const cam = { id: "cam2", category: "camera-body", opticalCenterAboveBase: 6 };
    const build = { id: "b2", componentIds: ["cam2"], bottomMount: "flat-38", hasRatedTopHandle: true, topHandleOffset: -2 };
    const gear = makeGear({
      components: [support, head, cam],
      packageComponentIds: ["s2", "h2", "cam2"],
      build,
    });
    // support eff range [10,29]. base-inverted rise = -6 -> interval [0,19].
    // top-handle rise = -2 -> interval [4,23]. Target 10 sits in both.

    const result = solve(gear, {
      target: { type: "fixed", height: 10 },
      packageId: "pkg",
      buildId: "b2",
    });

    assert.equal(result.feasible.length, 2);
    const attachNames = result.feasible.map((c) => c.attach.name).sort();
    assert.deepEqual(attachNames, ["base-inverted", "top-handle"]);
    for (const chain of result.feasible) {
      assert.equal(chain.mode.name, "underslung");
      assert.equal(chain.mode.cameraMountFacing, "down");
    }
  });

  test("lambda underslung: negative head rise but up-facing mount mates with plain base (upright camera)", () => {
    const support = {
      id: "s3",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-150",
      riseRange: { specMin: 5, specMax: 25, practicalMin: 5, practicalMax: 25 },
      levelingLoss: 0,
    };
    const head = {
      id: "h3",
      category: "head",
      bottomMount: "bowl-150",
      topMount: "flat-38",
      modes: [{ name: "underslung", rise: -3, cameraMountFacing: "up" }],
    };
    const cam = { id: "cam3", category: "camera-body", opticalCenterAboveBase: 8 };
    const build = { id: "b3", componentIds: ["cam3"], bottomMount: "flat-38", hasRatedTopHandle: false };
    const gear = makeGear({
      components: [support, head, cam],
      packageComponentIds: ["s3", "h3", "cam3"],
      build,
    });

    const chains = enumerateChains(gear, { packageId: "pkg", buildId: "b3", maxBaseLayerItems: 2 });

    // Only the plain "base" attach point (facing down) mates with this
    // up-facing underslung mount; base-inverted (facing up) is excluded.
    assert.equal(chains.length, 1);
    assert.equal(chains[0].attach.name, "base");
    assert.equal(chains[0].attach.inverted, false);
    assert.equal(chains[0].min, 5 - 3 + 8); // 10
    assert.equal(chains[0].max, 25 - 3 + 8); // 30
  });

  test("dolly boom: baseRise + boomRange answers a wide range query with a single rig", () => {
    const dolly = {
      id: "s4",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-150",
      baseRise: 6,
      boomRange: { specMin: 0, specMax: 40, practicalMin: 0, practicalMax: 38 },
      // Dollies are leveled independently of the boom (bubble + wedges under
      // the wheels, not the boom itself), so unlike a tripod they don't lose
      // usable boom range to leveling. See SPEC.md 3.2 / gear.json.
      levelingLoss: 0,
    };
    const head = {
      id: "h4",
      category: "head",
      bottomMount: "bowl-150",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 5, cameraMountFacing: "up" }],
    };
    const cam = { id: "cam4", category: "camera-body", opticalCenterAboveBase: 8 };
    const build = { id: "b4", componentIds: ["cam4"], bottomMount: "flat-38", hasRatedTopHandle: false };
    const gear = makeGear({
      components: [dolly, head, cam],
      packageComponentIds: ["s4", "h4", "cam4"],
      build,
    });
    // Support interval = baseRise + boomRange, minus levelingLoss from the
    // top (here 0): [6 + 0, 6 + 38] = [6, 44].
    // Chain total adds the fixed head rise (5) and build rise (8) to both
    // ends: [6 + 5 + 8, 44 + 5 + 8] = [19, 57].

    const result = solve(gear, {
      target: { type: "range", low: 25, high: 50 },
      packageId: "pkg",
      buildId: "b4",
    });

    assert.equal(result.feasible.length, 1);
    assert.equal(result.feasible[0].support.id, "s4");
    assert.equal(result.feasible[0].min, 19);
    assert.equal(result.feasible[0].max, 57);
  });

  test("base-layer stacking: capped at 2 items by default, configurable higher", () => {
    const boxA = { id: "a", category: "base", bottomMount: "ground", topMount: "ground", rise: 2, stability: "normal" };
    const boxB = { id: "b", category: "base", bottomMount: "ground", topMount: "ground", rise: 4, stability: "normal" };
    const boxC = { id: "c", category: "base", bottomMount: "ground", topMount: "ground", rise: 8, stability: "normal" };
    const support = {
      id: "s5",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 10, specMax: 30, practicalMin: 10, practicalMax: 30 },
      levelingLoss: 0,
    };
    const head = {
      id: "h5",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 5, cameraMountFacing: "up" }],
    };
    const cam = { id: "cam5", category: "camera-body", opticalCenterAboveBase: 5 };
    const build = { id: "b5", componentIds: ["cam5"], bottomMount: "flat-38", hasRatedTopHandle: false };
    const gear = makeGear({
      components: [boxA, boxB, boxC, support, head, cam],
      packageComponentIds: ["a", "b", "c", "s5", "h5", "cam5"],
      build,
    });

    const defaultChains = enumerateChains(gear, { packageId: "pkg", buildId: "b5" });
    // C(3,0)+C(3,1)+C(3,2) = 1+3+3 = 7 base combos, x1 support x1 mode x1 attach
    assert.equal(defaultChains.length, 7);
    assert.equal(Math.max(...defaultChains.map((c) => c.baseItems.length)), 2);

    const uncappedChains = enumerateChains(gear, { packageId: "pkg", buildId: "b5", maxBaseLayerItems: 3 });
    // + C(3,3) = 1 more combo = 8 total; taller stacks remain legal when configured
    assert.equal(uncappedChains.length, 8);
    assert.equal(Math.max(...uncappedChains.map((c) => c.baseItems.length)), 3);

    // A 2-item stack (b+c = 12) actually changes the interval.
    const stacked = defaultChains.find((c) => c.baseItems.length === 2 && c.baseItems.map((i) => i.id).sort().join() === "b,c");
    assert.equal(stacked.min, 12 + 10 + 5 + 5);
    assert.equal(stacked.max, 12 + 30 + 5 + 5);
  });

  test("infeasible with suggestion: names the base-layer combo that closes the gap", () => {
    const support = {
      id: "s6",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 10, specMax: 19, practicalMin: 10, practicalMax: 19 },
      levelingLoss: 1,
    };
    const head = {
      id: "h6",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 5, cameraMountFacing: "up" }],
    };
    const cam = { id: "cam6", category: "camera-body", opticalCenterAboveBase: 5 };
    const build = { id: "b6", componentIds: ["cam6"], bottomMount: "flat-38", hasRatedTopHandle: false };
    const boxX = { id: "x", category: "base", bottomMount: "ground", topMount: "ground", rise: 3, stability: "normal" };
    const boxY = { id: "y", category: "base", bottomMount: "ground", topMount: "ground", rise: 5, stability: "normal" };
    const boxZ = { id: "z", category: "base", bottomMount: "ground", topMount: "ground", rise: 9, stability: "normal" };
    const gear = makeGear({
      components: [support, head, cam, boxX, boxY, boxZ],
      packageComponentIds: ["s6", "h6", "cam6", "x", "y", "z"],
      build,
    });
    // core interval (0 base items) = [20, 28]. Best 2-item stack under the
    // default cap is y+z=14 -> [34,42], still short of 45.

    const closable = solve(gear, {
      target: { type: "fixed", height: 45 },
      packageId: "pkg",
      buildId: "b6",
    });

    assert.equal(closable.feasible.length, 0);
    assert.ok(closable.fallback);
    assert.equal(closable.fallback.direction, "short");
    assert.equal(closable.fallback.nearestChain.max, 28); // nearest = core (0-item) chain
    assert.equal(closable.fallback.gap, 17); // 45 - 28
    assert.equal(closable.fallback.suggestion.closesGap, true);
    assert.deepEqual(closable.fallback.suggestion.items.map((i) => i.id).sort(), ["x", "y", "z"]);
    assert.equal(closable.fallback.suggestion.addedRise, 17);
    assert.match(closable.fallback.message, /short/i);

    const unclosable = solve(gear, {
      target: { type: "fixed", height: 50 },
      packageId: "pkg",
      buildId: "b6",
    });
    assert.equal(unclosable.feasible.length, 0);
    assert.equal(unclosable.fallback.suggestion.closesGap, false);
    assert.equal(unclosable.fallback.suggestion.maxAdditionalRise, 17); // 3+5+9
    assert.equal(unclosable.fallback.suggestion.stillShortBy, 5); // gap(22) - 17
  });

  test("fixed target: tolerance boundary is inclusive at both ends", () => {
    const support = {
      id: "s7",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 10, specMax: 30, practicalMin: 10, practicalMax: 30 },
      levelingLoss: 0,
    };
    const head = {
      id: "h7",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 0, cameraMountFacing: "up" }],
    };
    const cam = { id: "cam7", category: "camera-body", opticalCenterAboveBase: 0 };
    const build = { id: "b7", componentIds: ["cam7"], bottomMount: "flat-38", hasRatedTopHandle: false };
    const gear = makeGear({
      components: [support, head, cam],
      packageComponentIds: ["s7", "h7", "cam7"],
      build,
    });
    // interval = [10, 30], default tolerance = 0.5, so [min - tol, max + tol] = [9.5, 30.5]

    const atMinBoundary = solve(gear, { target: { type: "fixed", height: 9.5 }, packageId: "pkg", buildId: "b7" });
    assert.equal(atMinBoundary.feasible.length, 1, "min - tolerance should be feasible (inclusive)");

    const justBelowMinBoundary = solve(gear, { target: { type: "fixed", height: 9.49 }, packageId: "pkg", buildId: "b7" });
    assert.equal(justBelowMinBoundary.feasible.length, 0, "just past min - tolerance should be infeasible");

    const atMaxBoundary = solve(gear, { target: { type: "fixed", height: 30.5 }, packageId: "pkg", buildId: "b7" });
    assert.equal(atMaxBoundary.feasible.length, 1, "max + tolerance should be feasible (inclusive)");

    const justAboveMaxBoundary = solve(gear, { target: { type: "fixed", height: 30.51 }, packageId: "pkg", buildId: "b7" });
    assert.equal(justAboveMaxBoundary.feasible.length, 0, "just past max + tolerance should be infeasible");

    // Tolerance is user-adjustable (SPEC.md 5.1), not hardcoded: the same
    // target that just missed above becomes reachable with a wider one.
    const widerTolerance = solve(gear, {
      target: { type: "fixed", height: 30.51 },
      packageId: "pkg",
      buildId: "b7",
      tolerance: 1,
    });
    assert.equal(widerTolerance.feasible.length, 1, "a wider tolerance should reclaim the same target");
  });

  test("range target: tolerance boundary applies to both endpoints", () => {
    const support = {
      id: "s8",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 10, specMax: 30, practicalMin: 10, practicalMax: 30 },
      levelingLoss: 0,
    };
    const head = {
      id: "h8",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 0, cameraMountFacing: "up" }],
    };
    const cam = { id: "cam8", category: "camera-body", opticalCenterAboveBase: 0 };
    const build = { id: "b8", componentIds: ["cam8"], bottomMount: "flat-38", hasRatedTopHandle: false };
    const gear = makeGear({
      components: [support, head, cam],
      packageComponentIds: ["s8", "h8", "cam8"],
      build,
    });
    // interval = [10, 30], default tolerance = 0.5

    const atBothBoundaries = solve(gear, {
      target: { type: "range", low: 9.5, high: 30.5 },
      packageId: "pkg",
      buildId: "b8",
    });
    assert.equal(atBothBoundaries.feasible.length, 1, "low = min - tol and high = max + tol should both be feasible (inclusive)");

    const lowJustOutside = solve(gear, {
      target: { type: "range", low: 9.49, high: 25 },
      packageId: "pkg",
      buildId: "b8",
    });
    assert.equal(lowJustOutside.feasible.length, 0, "low just past min - tolerance should be infeasible");

    const highJustOutside = solve(gear, {
      target: { type: "range", low: 15, high: 30.51 },
      packageId: "pkg",
      buildId: "b8",
    });
    assert.equal(highJustOutside.feasible.length, 0, "high just past max + tolerance should be infeasible");
  });

  test("ranking: sorts by margin first — the config sitting most mid-range wins", () => {
    const narrowSupport = {
      id: "sNarrow",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 10, specMax: 20, practicalMin: 10, practicalMax: 20 },
      levelingLoss: 0,
    };
    const wideSupport = {
      id: "sWide",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 0, specMax: 40, practicalMin: 0, practicalMax: 40 },
      levelingLoss: 0,
    };
    const head = {
      id: "hOrd1",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 0, cameraMountFacing: "up" }],
    };
    const cam = { id: "camOrd1", category: "camera-body", opticalCenterAboveBase: 0 };
    const build = { id: "bOrd1", componentIds: ["camOrd1"], bottomMount: "flat-38", hasRatedTopHandle: false };
    const gear = makeGear({
      components: [narrowSupport, wideSupport, head, cam],
      packageComponentIds: ["sNarrow", "sWide", "hOrd1", "camOrd1"],
      build,
    });

    // narrow: [10,20], margin at 15 = below 5, above 5 -> min = 5
    // wide:   [0,40],  margin at 15 = below 15, above 25 -> min = 15
    const result = solve(gear, { target: { type: "fixed", height: 15 }, packageId: "pkg", buildId: "bOrd1" });

    assert.equal(result.feasible.length, 2);
    assert.equal(result.feasible[0].support.id, "sWide", "more margin should sort first");
    assert.equal(result.feasible[1].support.id, "sNarrow");
  });

  test("ranking: ties on margin, then sorts by fewest pieces of gear", () => {
    const support = {
      id: "sOrd2",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 0, specMax: 100, practicalMin: 0, practicalMax: 100 },
      levelingLoss: 0,
    };
    const head = {
      id: "hOrd2",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 0, cameraMountFacing: "up" }],
    };
    const cam = { id: "camOrd2", category: "camera-body", opticalCenterAboveBase: 0 };
    const build = { id: "bOrd2", componentIds: ["camOrd2"], bottomMount: "flat-38", hasRatedTopHandle: false };
    // A zero-rise filler: adding it to a chain shifts min/max by nothing,
    // so it exists purely to create a margin tie against a chain with
    // one fewer piece of gear, isolating the piece-count tiebreak.
    const filler = { id: "filler", category: "base", bottomMount: "ground", topMount: "ground", rise: 0, stability: "normal" };
    const gear = makeGear({
      components: [support, head, cam, filler],
      packageComponentIds: ["sOrd2", "hOrd2", "camOrd2", "filler"],
      build,
    });

    const target = { type: "fixed", height: 50 };
    const result = solve(gear, { target, packageId: "pkg", buildId: "bOrd2" });

    const noFiller = result.feasible.find((c) => c.baseItems.length === 0);
    const withFiller = result.feasible.find((c) => c.baseItems.length === 1);
    assert.ok(noFiller && withFiller);
    const noFillerMargin = margin(noFiller, target);
    const withFillerMargin = margin(withFiller, target);
    assert.equal(noFillerMargin.below, withFillerMargin.below, "the filler must not change marginBelow");
    assert.equal(noFillerMargin.above, withFillerMargin.above, "the filler must not change marginAbove");
    assert.ok(
      result.feasible.indexOf(noFiller) < result.feasible.indexOf(withFiller),
      "fewer pieces of gear should rank first once margin ties"
    );
  });

  test("ranking: ties on margin and piece count, ranks a match to the current rig next", () => {
    const support = {
      id: "sOrd3",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 0, specMax: 100, practicalMin: 0, practicalMax: 100 },
      levelingLoss: 0,
    };
    const headA = {
      id: "hOrd3a",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 0, cameraMountFacing: "up" }],
    };
    const headB = {
      id: "hOrd3b",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 0, cameraMountFacing: "up" }],
    };
    const cam = { id: "camOrd3", category: "camera-body", opticalCenterAboveBase: 0 };
    const build = { id: "bOrd3", componentIds: ["camOrd3"], bottomMount: "flat-38", hasRatedTopHandle: false };
    const gear = makeGear({
      components: [support, headA, headB, cam],
      packageComponentIds: ["sOrd3", "hOrd3a", "hOrd3b", "camOrd3"],
      build,
    });

    // headA and headB are identical (same rise, same facing), so their
    // chains tie on both margin and piece count; only the current-rig
    // match (SPEC.md 5.2 step 4.3 / 5.4) can separate them.
    const result = solve(gear, {
      target: { type: "fixed", height: 50 },
      packageId: "pkg",
      buildId: "bOrd3",
      currentRig: { supportId: "sOrd3", headId: "hOrd3b" },
    });

    assert.equal(result.feasible.length, 2);
    assert.equal(result.feasible[0].head.id, "hOrd3b", "the chain matching the already-built rig should sort first on a full tie");
  });

  test("ranking: ties on margin, piece count, and current rig, ranks the more stable chain next", () => {
    const support = {
      id: "sOrd4",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 0, specMax: 100, practicalMin: 0, practicalMax: 100 },
      levelingLoss: 0,
    };
    const head = {
      id: "hOrd4",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 0, cameraMountFacing: "up" }],
    };
    const cam = { id: "camOrd4", category: "camera-body", opticalCenterAboveBase: 0 };
    const build = { id: "bOrd4", componentIds: ["camOrd4"], bottomMount: "flat-38", hasRatedTopHandle: false };
    // Same rise, different stability flags: the two single-box chains land
    // on an identical interval, so only the stability penalty (SPEC.md 5.2
    // step 4.4) can separate them.
    const normalBox = { id: "normalBox", category: "base", bottomMount: "ground", topMount: "ground", rise: 4, stability: "normal" };
    const lowBox = { id: "lowBox", category: "base", bottomMount: "ground", topMount: "ground", rise: 4, stability: "low" };
    const gear = makeGear({
      components: [support, head, cam, normalBox, lowBox],
      packageComponentIds: ["sOrd4", "hOrd4", "camOrd4", "normalBox", "lowBox"],
      build,
    });

    const result = solve(gear, { target: { type: "fixed", height: 50 }, packageId: "pkg", buildId: "bOrd4" });

    const normalChain = result.feasible.find((c) => c.baseItems.length === 1 && c.baseItems[0].id === "normalBox");
    const lowChain = result.feasible.find((c) => c.baseItems.length === 1 && c.baseItems[0].id === "lowBox");
    assert.ok(normalChain && lowChain);
    assert.equal(normalChain.min, lowChain.min);
    assert.equal(normalChain.max, lowChain.max);
    assert.ok(
      result.feasible.indexOf(normalChain) < result.feasible.indexOf(lowChain),
      "a normal-stability box should outrank an otherwise-identical low-stability one"
    );
  });

  test("mount-type mismatches are pruned, not summed (SPEC.md 5.2 step 1)", () => {
    const support = {
      id: "sMount",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 10, specMax: 20, practicalMin: 10, practicalMax: 20 },
      levelingLoss: 0,
    };
    const matchingHead = {
      id: "hMatch",
      category: "head",
      bottomMount: "bowl-100", // matches the support's topMount
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 5, cameraMountFacing: "up" }],
    };
    const mismatchedHead = {
      id: "hMismatch",
      category: "head",
      bottomMount: "bowl-150", // does NOT match the support's topMount (bowl-100)
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 5, cameraMountFacing: "up" }],
    };
    const cam = { id: "camMount", category: "camera-body", opticalCenterAboveBase: 5 };
    const matchingBuild = { id: "bMatch", componentIds: ["camMount"], bottomMount: "flat-38", hasRatedTopHandle: false };
    // Does NOT match either head's topMount (flat-38).
    const mismatchedBuild = { id: "bMismatch", componentIds: ["camMount"], bottomMount: "dovetail", hasRatedTopHandle: false };

    const gear = makeGear({
      components: [support, matchingHead, mismatchedHead, cam],
      packageComponentIds: ["sMount", "hMatch", "hMismatch", "camMount"],
      builds: [matchingBuild, mismatchedBuild],
    });

    // support -> head mismatch: only the mount-compatible head produces a chain.
    const withMatchingBuild = enumerateChains(gear, { packageId: "pkg", buildId: "bMatch", maxBaseLayerItems: 0 });
    assert.equal(withMatchingBuild.length, 1);
    assert.equal(withMatchingBuild[0].head.id, "hMatch");

    // head -> build mismatch: no head's topMount matches this build's
    // bottomMount, so no chain is generated, even though the
    // support -> head leg above was fine.
    const withMismatchedBuild = enumerateChains(gear, { packageId: "pkg", buildId: "bMismatch", maxBaseLayerItems: 0 });
    assert.equal(withMismatchedBuild.length, 0);
  });
});
