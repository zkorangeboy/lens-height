import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { mergeOverrides } from "../src/model.js";
import { enumerateChains, buildChain, evaluateChain, isFeasible } from "../src/solver.js";

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

  test("no measured/estimated flag anywhere: all gear values are treated as correct", () => {
    for (const item of [...seed.components, ...seed.builds]) {
      assert.equal(item.measured, undefined, item.id);
    }
  });
});

describe("mergeOverrides (SPEC.md 4.1)", () => {
  test("deep-merges a field override without mutating the seed, override wins", () => {
    const seed = {
      schemaVersion: 1,
      components: [
        { id: "c1", rise: 6.75, name: "C1", riseRange: { practicalMin: 10, practicalMax: 27 } },
      ],
    };
    const overridesDoc = {
      schemaVersion: 1,
      overrides: {
        c1: { rise: 6.5, name: "C1 (taped)", riseRange: { practicalMax: 26.0 } },
      },
    };

    const merged = mergeOverrides(seed, overridesDoc);

    assert.equal(merged.components[0].rise, 6.5);
    assert.equal(merged.components[0].name, "C1 (taped)");
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
// Chain construction and height evaluation — SPEC.md 5
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

describe("chain construction and height evaluation", () => {
  test("fixed target: feasible chain with correct interval and margin", () => {
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
    const chain = buildChain(gear, { packageId: "pkg", buildId: "b1", supportId: "s1", headId: "h1", modeName: "normal", attachName: "base" });

    assert.equal(chain.min, 20);
    assert.equal(chain.max, 39);
    assert.equal(chain.attach.name, "base");
    assert.equal(evaluateChain(chain, { type: "fixed", height: 25 }).feasible, true);
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
    const chain = buildChain(gear, { packageId: "pkg", buildId: "b1", supportId: "s1", headId: "h1", modeName: "normal", attachName: "base" });

    const fits = evaluateChain(chain, { type: "range", low: 22, high: 35, rangeType: "adjustable" });
    assert.equal(fits.feasible, true);

    const overhangs = evaluateChain(chain, { type: "range", low: 15, high: 35, rangeType: "adjustable" }); // low is outside [20,39] beyond tolerance
    assert.equal(overhangs.feasible, false);
    assert.equal(overhangs.shortfall.direction, "tall");
  });

  test("underslung head: negative rise, both camera attach options (base-inverted and top-handle)", () => {
    const support = {
      id: "s2",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      mountFacing: "down", // stands in for an offset plate's bottom side: underslung needs a down-facing mount
      riseRange: { specMin: 10, specMax: 30, practicalMin: 10, practicalMax: 30 },
      levelingLoss: 1,
    };
    const head = {
      id: "h2",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "underslung", rise: -4, cameraMountFacing: "down", supportMountFacing: "down" }],
    };
    const cam = { id: "cam2", category: "camera-body", opticalCenterAboveBase: 6 };
    const build = { id: "b2", componentIds: ["cam2"], bottomMount: "flat-38", hasRatedTopHandle: true, topHandleOffset: -2 };
    const gear = makeGear({
      components: [support, head, cam],
      packageComponentIds: ["s2", "h2", "cam2"],
      build,
    });
    // support eff range [10,29]. base-inverted -> interval [0,19].
    // top-handle -> interval [6,23]. Target 10 sits in both.

    const baseInverted = buildChain(gear, { packageId: "pkg", buildId: "b2", supportId: "s2", headId: "h2", modeName: "underslung", attachName: "base-inverted" });
    const topHandle = buildChain(gear, { packageId: "pkg", buildId: "b2", supportId: "s2", headId: "h2", modeName: "underslung", attachName: "top-handle" });

    assert.equal(baseInverted.min, 0);
    assert.equal(baseInverted.max, 19);
    assert.equal(topHandle.min, 6);
    assert.equal(topHandle.max, 23);
    for (const chain of [baseInverted, topHandle]) {
      assert.equal(chain.mode.name, "underslung");
      assert.equal(chain.mode.cameraMountFacing, "down");
      assert.equal(evaluateChain(chain, { type: "fixed", height: 10 }).feasible, true);
    }
  });

  test("lambda underslung: negative head rise, a down-facing mount, and a plain base (upright camera)", () => {
    const support = (mountFacing) => ({
      id: "s3",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-150",
      mountFacing,
      riseRange: { specMin: 5, specMax: 25, practicalMin: 5, practicalMax: 25 },
      levelingLoss: 0,
    });
    const head = {
      id: "h3",
      category: "head",
      bottomMount: "bowl-150",
      topMount: "flat-38",
      modes: [{ name: "underslung", rise: -3, cameraMountFacing: "up", supportMountFacing: "down" }],
    };
    const cam = { id: "cam3", category: "camera-body", opticalCenterAboveBase: 8 };
    const build = { id: "b3", componentIds: ["cam3"], bottomMount: "flat-38", hasRatedTopHandle: false };
    const gearWith = (facing) =>
      makeGear({ components: [support(facing), head, cam], packageComponentIds: ["s3", "h3", "cam3"], build });
    const chainsOn = (facing) => enumerateChains(gearWith(facing), { packageId: "pkg", buildId: "b3", maxBaseLayerItems: 2 });

    assert.equal(chainsOn("up").length, 0, "underslung never hangs from an up-facing mount");
    // Hung from a down-facing mount, the platform faces up: only the plain
    // "base" attach point (facing down) mates, so the camera is upright.
    const chains = chainsOn("down");
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
    const chain = buildChain(gear, { packageId: "pkg", buildId: "b4", supportId: "s4", headId: "h4", modeName: "normal", attachName: "base" });

    assert.equal(chain.min, 19);
    assert.equal(chain.max, 57);
    assert.equal(evaluateChain(chain, { type: "range", low: 25, high: 50 }).feasible, true);
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
    const chain = buildChain(gear, { packageId: "pkg", buildId: "b7", supportId: "s7", headId: "h7", modeName: "normal", attachName: "base" });

    assert.equal(isFeasible(chain, { type: "fixed", height: 9.5 }, 0.5), true, "min - tolerance should be feasible (inclusive)");
    assert.equal(isFeasible(chain, { type: "fixed", height: 9.49 }, 0.5), false, "just past min - tolerance should be infeasible");
    assert.equal(isFeasible(chain, { type: "fixed", height: 30.5 }, 0.5), true, "max + tolerance should be feasible (inclusive)");
    assert.equal(isFeasible(chain, { type: "fixed", height: 30.51 }, 0.5), false, "just past max + tolerance should be infeasible");

    // Tolerance is user-adjustable (SPEC.md 5.1), not hardcoded: the same
    // target that just missed above becomes reachable with a wider one.
    assert.equal(isFeasible(chain, { type: "fixed", height: 30.51 }, 1), true, "a wider tolerance should reclaim the same target");
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
    const chain = buildChain(gear, { packageId: "pkg", buildId: "b8", supportId: "s8", headId: "h8", modeName: "normal", attachName: "base" });

    assert.equal(
      isFeasible(chain, { type: "range", low: 9.5, high: 30.5, rangeType: "adjustable" }, 0.5),
      true,
      "low = min - tol and high = max + tol should both be feasible (inclusive)"
    );
    assert.equal(
      isFeasible(chain, { type: "range", low: 9.49, high: 25, rangeType: "adjustable" }, 0.5),
      false,
      "low just past min - tolerance should be infeasible"
    );
    assert.equal(
      isFeasible(chain, { type: "range", low: 15, high: 30.51, rangeType: "adjustable" }, 0.5),
      false,
      "high just past max + tolerance should be infeasible"
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

// ---------------------------------------------------------------------------
// Adjustability — SPEC.md 3.5 / 5.2
// ---------------------------------------------------------------------------

describe("adjustability", () => {
  test("range target: rangeType 'moveable' rejects a chain whose only range-bearing component is 'adjustable', even though the numeric range fits", () => {
    const support = {
      id: "sAdjOnly",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-100",
      riseRange: { specMin: 10, specMax: 30, practicalMin: 10, practicalMax: 30 },
      levelingLoss: 0,
      adjustability: "adjustable",
    };
    const head = {
      id: "hAdjOnly",
      category: "head",
      bottomMount: "bowl-100",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 0, cameraMountFacing: "up" }],
    };
    const cam = { id: "camAdjOnly", category: "camera-body", opticalCenterAboveBase: 0 };
    const build = { id: "bAdjOnly", componentIds: ["camAdjOnly"], bottomMount: "flat-38", hasRatedTopHandle: false };
    const gear = makeGear({
      components: [support, head, cam],
      packageComponentIds: ["sAdjOnly", "hAdjOnly", "camAdjOnly"],
      build,
    });

    const chain = buildChain(gear, {
      packageId: "pkg",
      buildId: "bAdjOnly",
      baseItemIds: [],
      supportId: "sAdjOnly",
      headId: "hAdjOnly",
      modeName: "normal",
      attachName: "base",
    });
    assert.equal(chain.adjustability, "adjustable");

    // [15, 25] fits comfortably inside the chain's [10, 30] interval, so a
    // rangeType: "adjustable" target (the default) is feasible...
    const asAdjustable = evaluateChain(chain, { type: "range", low: 15, high: 25, rangeType: "adjustable" }, 0.5);
    assert.equal(asAdjustable.feasible, true);

    // ...but a rangeType: "moveable" target is not: this support can only
    // be repositioned between setups, not moved live during the take, so
    // no amount of numeric range makes it satisfy a live move.
    const asMoveable = evaluateChain(chain, { type: "range", low: 15, high: 25, rangeType: "moveable" }, 0.5);
    assert.equal(asMoveable.feasible, false);
  });

  test("range target: a short boom on long adjustable legs is rejected for a moveable span wider than the boom alone", () => {
    const support = {
      id: "sBoomOnLegs",
      category: "support",
      bottomMount: "ground",
      topMount: "bowl-150",
      // Long adjustable legs (50") under a short moveable boom (10").
      legRange: { specMin: 0, specMax: 50, practicalMin: 0, practicalMax: 50 },
      boomRange: { specMin: 0, specMax: 10, practicalMin: 0, practicalMax: 10 },
      levelingLoss: 0,
      adjustability: "moveable", // most capable type present, per SPEC.md 3.5
    };
    const head = {
      id: "hBoomOnLegs",
      category: "head",
      bottomMount: "bowl-150",
      topMount: "flat-38",
      modes: [{ name: "normal", rise: 0, cameraMountFacing: "up" }],
    };
    const cam = { id: "camBoomOnLegs", category: "camera-body", opticalCenterAboveBase: 0 };
    const build = { id: "bBoomOnLegs", componentIds: ["camBoomOnLegs"], bottomMount: "flat-38", hasRatedTopHandle: false };
    const gear = makeGear({
      components: [support, head, cam],
      packageComponentIds: ["sBoomOnLegs", "hBoomOnLegs", "camBoomOnLegs"],
      build,
    });

    const chain = buildChain(gear, {
      packageId: "pkg",
      buildId: "bBoomOnLegs",
      baseItemIds: [],
      supportId: "sBoomOnLegs",
      headId: "hBoomOnLegs",
      modeName: "normal",
      attachName: "base",
    });

    // Total interval: legs (0-50) + boom (0-10) = [0, 60]. Moveable
    // interval: boom alone = [0, 10], width 10 — legs are adjustable, not
    // moveable, so they don't count toward it even though the chain's
    // overall adjustability label is "moveable".
    assert.equal(chain.min, 0);
    assert.equal(chain.max, 60);
    assert.equal(chain.adjustability, "moveable");
    assert.equal(chain.moveableInterval.max - chain.moveableInterval.min, 10);

    // A 25" live move fits comfortably inside the total interval [0, 60]
    // ...
    const wideSpan = { type: "range", low: 5, high: 30, rangeType: "moveable" };
    assert.ok(wideSpan.low >= chain.min && wideSpan.high <= chain.max, "sanity: the span does fit the total interval");
    // ...but the boom alone can only move live across 10", so a moveable
    // target this wide must be rejected even though the total interval
    // covers it.
    assert.equal(isFeasible(chain, wideSpan, 0.5), false);

    // A span that fits within the boom's own 10" width, by contrast, is
    // feasible: the legs can position it anywhere in the total range.
    const narrowSpan = { type: "range", low: 20, high: 28, rangeType: "moveable" };
    assert.equal(isFeasible(chain, narrowSpan, 0.5), true);
  });
});
