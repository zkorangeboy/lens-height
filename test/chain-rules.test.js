// Model changes: Mitchell as the standard mount, adapters, family, track and
// dolly mounts, apple-box hard and soft rules, orientation, and range
// targets defaulting to moveable. SPEC.md 2, 2.1, 3.1, 3.2, 3.6, 5.1, 5.3.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { enumerateChains, buildChain, isFeasible } from "../src/solver.js";
import { describeCurrentRig } from "../src/model.js";
import { acceptsMount } from "../src/rules.js";

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

  test("Mitchell is the standard mount: every head takes it, every support or nose fitting presents it, no bowls left", () => {
    // Heads take the male side of a Mitchell; supports and nose fittings present the female side (SPEC.md 2).
    for (const h of byCategory("head")) assert.equal(h.bottomMount, "mitchell-male", h.id);
    for (const s of byCategory("support")) {
      assert.ok(["mitchell-female", "fisher-nose"].includes(s.topMount), s.id);
    }
    for (const n of byCategory("nose")) assert.equal(n.topMount, "mitchell-female", n.id);
    for (const c of seed.components) {
      for (const mount of [].concat(c.bottomMount, c.topMount)) {
        assert.ok(!String(mount).startsWith("bowl"), `${c.id} still uses ${mount}`);
      }
    }
  });

  test("generic Mitchell risers: 3, 6, 12, 18, 24 inches, no family requirement", () => {
    const risers = byCategory("adapter").filter((a) => a.id.startsWith("mitchell-riser"));
    assert.deepEqual(
      Object.fromEntries(risers.map((r) => [r.id, r.rise])),
      { "mitchell-riser-3": 3, "mitchell-riser-6": 6, "mitchell-riser-12": 12, "mitchell-riser-18": 18, "mitchell-riser-24": 24 }
    );
    for (const r of risers) {
      assert.equal(r.requiresFamily, undefined, r.id);
      assert.equal(r.bottomMount, "mitchell-male");
      assert.equal(r.topMount, "mitchell-female");
    }
  });

  test("the placeholder dolly and its configurations are gone, and so are the brand-specific risers and offsets", () => {
    for (const id of [
      "dolly-placeholder", "dolly-low-mode-placeholder", "dolly-rotating-offset-placeholder", "dolly-broken-neck-placeholder",
      "mitchell-offset", "track-wedges-placeholder",
      "fisher-r3", "fisher-r6", "fisher-r12", "fisher-rj6", "fisher-rj12", "fisher-rj18", "fisher-u", "fisher-th", "fisher-ro",
    ]) {
      assert.ok(!seed.components.some((c) => c.id === id), id);
    }
    const mounts = new Set(seed.components.flatMap((c) => [].concat(c.bottomMount, c.topMount, ...(c.modes || []).map((m) => m.bottomMount || []))));
    assert.ok(!mounts.has("dolly-wheels"));
  });

  test("round track is the only track, +2″; sticks stand on the floor or rolling spreaders only", () => {
    const track = seed.components.filter((c) => c.kind === "track");
    assert.deepEqual(track.map((t) => [t.id, t.bottomMount, t.topMount, t.rise]), [["round-track", "ground", "round-track", 2]]);
    for (const id of ["baby-sticks", "standard-sticks"]) {
      assert.deepEqual(seed.components.find((c) => c.id === id).bottomMount, ["ground", "spreader"], id);
    }
  });

  test("only a full apple box appears on a 12in or 20in face", () => {
    for (const box of seed.components.filter((c) => c.kind === "apple-box")) {
      if (box.orientation !== "flat") assert.equal(box.boxSize, "full", box.id);
    }
  });

  test("the seed still enumerates chains end to end, and no chain puts an apple box under a dolly", () => {
    const chains = enumerateChains(seed, { packageId: "test-package", buildId: "a-cam" });
    assert.ok(chains.length > 0);
    assert.ok(chains.some((c) => c.adapters.length > 0), "some chains use adapters");
    for (const chain of chains) {
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

  test("no exceptions: an underslung mode needs a down-facing mount and an upright one an up-facing mount, whatever the data says", () => {
    const hanging = riser(6, { id: "hanging", name: "Hanging adapter", mountFacing: "down" });
    // Data that tries to opt out: an underslung mode claiming an up-facing mount, an upright one claiming down.
    const optOut = head({ modes: [{ name: "underslung", rise: -4, cameraMountFacing: "up", supportMountFacing: "up" }] });
    const gear = rigGear([tripod(), hanging, optOut]);
    assert.throws(() => buildChain(gear, selection({ modeName: "underslung" })), /underslung mode needs a down-facing mount/i);
    assert.equal(buildChain(gear, selection({ modeName: "underslung", adapterIds: ["hanging"] })).adapters.length, 1);
    const upright = head({ modes: [{ name: "upright", rise: 4, cameraMountFacing: "up", supportMountFacing: "down" }] });
    const gear2 = rigGear([tripod(), hanging, upright]);
    assert.throws(() => buildChain(gear2, selection({ modeName: "upright", adapterIds: ["hanging"] })), /upright mode needs an up-facing mount/i);
    assert.equal(buildChain(gear2, selection({ modeName: "upright" })).adapters.length, 0);
  });

  test("mount facing: a head mode that needs a down-facing mount does mate with a down-facing adapter", () => {
    const hanging = riser(6, { id: "hanging", name: "Hanging adapter", mountFacing: "down" });
    const hangingHead = head({ modes: [{ name: "underslung", rise: 0, cameraMountFacing: "up", supportMountFacing: "down" }] });
    const gear = rigGear([tripod(), hanging, hangingHead]);
    const chain = buildChain(gear, selection({ adapterIds: ["hanging"], modeName: "underslung" }));
    assert.equal(chain.adapters.length, 1);
    assert.throws(() => buildChain(gear, selection({ modeName: "underslung" })), /facing mismatch/i, "and without the adapter, it can't sit on the support");
  });

  test("adapters round-trip through picks (describeCurrentRig)", () => {
    const gear = rigGear([tripod(), riser(6), head()]);
    const chain = buildChain(gear, selection({ adapterIds: ["riser6"] }));
    const picks = describeCurrentRig(chain);
    assert.deepEqual(picks.adapterIds, ["riser6"]);
    const rebuilt = buildChain(gear, { packageId: "pkg", buildId: "bld", ...picks });
    assert.equal(rebuilt.adapters.length, 1);
    assert.equal(rebuilt.min, 16);
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
    assert.equal(chainsFor(gear).filter((c) => c.adapters.length > 0).length, 0, "never produced");
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
    assert.equal(chainsFor(gear).filter((c) => c.baseItems.length > 0).length, 0, "never produced");
  });

  test("an apple box under a track-mounted dolly is rejected too", () => {
    const gear = rigGear([dolly(), track(), apple("full", "full", "flat", 8), head()]);
    assert.throws(
      () => buildChain(gear, selection({ supportId: "dolly", baseItemIds: ["full", "track"] })),
      /apple box rule/i
    );
  });

  test("a tripod on apple boxes is legal — buildChain accepts it and enumerateChains includes it", () => {
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

  test("the dolly chain is absent; hi-hat and tripod chains are present", () => {
    const gear = rigGear([tripod(), dolly(), hiHat(), apple("half", "half", "flat", 4), head()]);
    const all = chainsFor(gear);
    assert.ok(!all.some((c) => c.support.id === "dolly" && c.baseItems.length > 0), "hard rule: absent");
    assert.ok(all.some((c) => c.support.id === "hihat" && c.baseItems.length > 0), "present");
    assert.ok(all.some((c) => c.support.id === "tripod" && c.baseItems.length > 0), "present");
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

  test("enumerateChains never returns an invalid-face apple box", () => {
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

  test("enumeration tries each mode, keeping only the ones the rest of the chain can sit on", () => {
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

  test("the mode survives the picks round trip", () => {
    const gear = rigGear([tripod(), offset(), twoModeHead()]);
    const chain = buildChain(gear, selection({ headId: "hd2", modeName: "underslung", attachName: "base-inverted", adapterIds: ["offset"], adapterModes: { offset: "underslung" } }));
    const rig = describeCurrentRig(chain);
    assert.deepEqual(rig.adapterModes, { offset: "underslung" });
    const again = buildChain(gear, { packageId: "pkg", buildId: "bld", ...rig });
    assert.equal(again.adapters[0].mode, "underslung");
    assert.equal(again.min, chain.min);
  });

  test("seed: the 10″ and 24″ Mitchell offsets mount from the top (+1, up) or the bottom (0, down) of the plate; the rotating offset is +4", () => {
    const seed = JSON.parse(readFileSync(path.join(__dirname, "..", "gear.json"), "utf8"));
    for (const id of ["mitchell-offset-10", "mitchell-offset-24"]) {
      const o = seed.components.find((c) => c.id === id);
      assert.equal(o.category, "adapter");
      assert.equal(o.requiresFamily, undefined);
      assert.deepEqual(o.modes.map((m) => [m.name, m.rise, m.mountFacing]), [["top", 1, "up"], ["bottom", 0, "down"]]);
    }
    assert.deepEqual(["mitchell-offset-10", "mitchell-offset-24"].map((id) => seed.components.find((c) => c.id === id).name), ['10" Offset', '24" Offset']);
    const ro = seed.components.find((c) => c.id === "rotating-offset");
    assert.deepEqual([ro.name, ro.rise, ro.mountFacing, ro.modes], ["Rotating Offset", 4, "up", undefined]);
  });

  test("seed: every riser and offset follows the mount, but never attaches to a Euro or QR interface (SPEC.md 3.6)", () => {
    const seed = JSON.parse(readFileSync(path.join(__dirname, "..", "gear.json"), "utf8"));
    const ids = ["mitchell-riser-3", "mitchell-riser-6", "mitchell-riser-12", "mitchell-riser-18", "mitchell-riser-24", "mitchell-offset-10", "mitchell-offset-24"];
    for (const id of ids) {
      const c = seed.components.find((cmp) => cmp.id === id);
      assert.equal(c.followsMount, true, `${id} follows the mount`);
      assert.equal(c.bottomMount, "mitchell-male");
      assert.equal(acceptsMount(c, "euro-receiver"), false, `${id} doesn't mount to a Euro receiver`);
      assert.equal(acceptsMount(c, "qr-receiver"), false, `${id} doesn't mount to a QR receiver`);
    }
    const ro = seed.components.find((c) => c.id === "rotating-offset");
    assert.equal(ro.followsMount, undefined, "the rotating offset keeps a fixed, up-facing mount");
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
    assert.equal(underslungChains.length, 0, "never produced");
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
    const standard = heads.find((h) => h.id === "oconnor-2575d");
    assert.equal(standard.modes.find((m) => m.name === "normal").supportMountFacing, "up");
    assert.equal(standard.modes.find((m) => m.name === "underslung").supportMountFacing, "down");
  });

  test("seed: the real standard head can't be underslung on the real tripod, and can from the bottom of a U plate", () => {
    const seed = JSON.parse(readFileSync(path.join(__dirname, "..", "gear.json"), "utf8"));
    const sel = { packageId: "test-package", buildId: "a-cam", supportId: "baby-sticks", headId: "oconnor-2575d", modeName: "underslung", plateIds: ["euro-plate"], attachName: "base-inverted" };
    assert.throws(() => buildChain(seed, sel), /facing mismatch/i);
    const chain = buildChain(seed, { ...sel, adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" } });
    assert.equal(chain.adapters[0].mode, "bottom");
    assert.throws(() => buildChain(seed, { ...sel, adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "top" } }), /facing mismatch/i);
  });
});

