// The check screen's logic: what may attach (rules.js), the stack view model
// (stack.js), shortfall and target normalizing (solver.js), and the rule that
// the UI layer stays thin. SPEC.md 5.2, 5.8, 5.9, 7.2.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import * as solver from "../src/solver.js";
import { buildChain, enumerateChains, evaluateChain, normalizeTarget, exceedsBaseLayerCap, checkChain } from "../src/solver.js";
import { describeCurrentRig, getPackageComponents, supportInterval, supportSegments } from "../src/model.js";
import { defaultPicks, missingSlot, modeControl, revalidatePicks, slotOptions } from "../src/rules.js";
import { stackLayout } from "../src/stack.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(path.join(root, "gear.json"), "utf8"));
const P = ["test-package", "build-placeholder"];

const picksFor = (over = {}) => ({
  baseItemIds: [],
  baseModes: {},
  supportId: "tripod-baby-placeholder",
  supportMode: null,
  noseId: null,
  noseMode: null,
  adapterIds: [],
  adapterModes: {},
  headId: "head-standard-placeholder",
  modeName: "normal",
  attachName: "base",
  ...over,
});
const opts = (over) => slotOptions(seed, ...P, picksFor(over));
const revalidate = (over) => revalidatePicks(seed, ...P, picksFor(over));
const byId = (list, id) => list.find((o) => o.id === id);

// A small synthetic rig for the stack and shortfall tests, where every number
// is hand-computable.
const rig = ({ support, adapters = [], base = [], head, mode } = {}) => {
  const cam = { id: "cam", category: "camera-body", opticalCenterAboveBase: 4 };
  const theHead = head || {
    id: "hd",
    name: "Head",
    category: "head",
    bottomMount: "mitchell",
    topMount: "flat-38",
    modes: [{ name: "normal", rise: 5, cameraMountFacing: "up", supportMountFacing: "up" }],
  };
  const components = [...base, support, ...adapters, theHead, cam];
  const gear = {
    schemaVersion: 1,
    components,
    packages: [{ id: "pkg", name: "pkg", componentIds: components.map((c) => c.id) }],
    builds: [{ id: "bld", name: "Build", componentIds: ["cam"], bottomMount: "flat-38", hasRatedTopHandle: true, topHandleOffset: -2 }],
  };
  const selection = {
    packageId: "pkg",
    buildId: "bld",
    baseItemIds: base.map((b) => b.id),
    supportId: support.id,
    adapterIds: adapters.map((a) => a.id),
    headId: theHead.id,
    modeName: mode || theHead.modes[0].name,
    attachName: theHead.modes[0].cameraMountFacing === "down" || mode === "underslung" ? "base-inverted" : "base",
  };
  return { gear, chain: buildChain(gear, selection) };
};
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
  baseRise: 6,
  boomRange: { specMin: 0, specMax: 20, practicalMin: 0, practicalMax: 20 },
  levelingLoss: 0,
  adjustability: "moveable",
  ...over,
});

// ---------------------------------------------------------------------------
// What may attach — slotOptions (SPEC.md 5.9)
// ---------------------------------------------------------------------------

describe("slotOptions: only what can legally attach to what's below", () => {
  test("supports must accept the top of the base stack, and a dolly can't sit on apple boxes", () => {
    const onTrack = opts({ baseItemIds: ["square-track"], supportId: null, adapterIds: [], headId: null, modeName: null, attachName: null });
    assert.equal(byId(onTrack.support, "fisher-11").available, true);
    for (const id of ["tripod-baby-placeholder", "hihat-placeholder", "lohat-placeholder"]) {
      assert.equal(byId(onTrack.support, id).available, false, id);
    }
    assert.match(byId(onTrack.support, "tripod-baby-placeholder").reason, /floor, not on square track/i);

    const onApple = opts({ baseItemIds: ["apple-half"], supportId: null, headId: null, modeName: null, attachName: null });
    assert.equal(byId(onApple.support, "fisher-11").available, false);
    assert.match(byId(onApple.support, "fisher-11").reason, /apple boxes can't go under a dolly/i);
    assert.equal(byId(onApple.support, "tripod-baby-placeholder").available, true, "a tripod on apple boxes is legal");
  });

  test("nose fittings only on a Fisher beam nose; risers and offsets anywhere", () => {
    const onTripod = opts();
    const onDolly = opts({ supportId: "fisher-11", noseId: "fisher-sle" });
    for (const id of ["fisher-sle", "fisher-lhe"]) {
      assert.equal(byId(onTripod.nose, id).available, false, `${id} on the tripod`);
      assert.equal(byId(onDolly.nose, id).available, true, `${id} on the dolly`);
    }
    assert.match(byId(onTripod.nose, "fisher-lhe").reason, /mounts on a Fisher beam nose, and Baby Tripod tops out in a Mitchell mount/i);
    for (const riser of ["mitchell-riser-6", "mitchell-riser-24", "mitchell-riser-3", "mitchell-offset-10", "mitchell-offset-24", "rotating-offset"]) {
      assert.equal(byId(onTripod.adapters, riser).available, true, `${riser} works anywhere`);
      assert.equal(byId(onDolly.adapters, riser).available, true);
    }
  });

  test("an underslung head mode isn't offered on a tripod, but is with an offset in underslung mode", () => {
    const standard = (o) => byId(o.head, "head-standard-placeholder");
    const modes = (o) => Object.fromEntries(standard(o).modes.map((m) => [m.name, m]));

    const plain = modes(opts());
    assert.equal(plain.normal.available, true);
    assert.equal(plain.underslung.available, false);
    assert.match(plain.underslung.reason, /needs a down-facing mount beneath the head, but the top of Baby Tripod/i);

    const hung = opts({ adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" }, modeName: "underslung", attachName: "base-inverted" });
    assert.equal(modes(hung).underslung.available, true);
    assert.equal(modes(hung).normal.available, false);
    // The lambda head sits on an up-facing mount, so an underslung offset takes it off the list.
    assert.equal(byId(hung.head, "head-lambda-placeholder").available, false);
  });

  test("camera attach points follow the head mode: upright for normal, inverted or handle for underslung", () => {
    const names = (o) => o.attach.filter((a) => a.available).map((a) => a.name);
    assert.deepEqual(names(opts()), ["base"]);
    const hung = opts({ adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" }, modeName: "underslung", attachName: "base-inverted" });
    assert.deepEqual(names(hung).sort(), ["base-inverted", "top-handle"]);
  });

  test("a component that is already picked stays available", () => {
    const o = opts({ baseItemIds: ["apple-half"], adapterIds: ["mitchell-riser-6"] });
    assert.equal(byId(o.base, "apple-half").available, true);
    assert.equal(byId(o.adapters, "mitchell-riser-6").available, true);
    assert.equal(byId(o.support, "tripod-baby-placeholder").available, true);
  });

  test("track: only one fits, and a second is refused with a reason", () => {
    const second = { ...seed.components.find((c) => c.kind === "track"), id: "track-2", name: "Second Track" };
    const gear = { ...seed, components: [...seed.components, second], packages: [{ ...seed.packages[0], componentIds: [...seed.packages[0].componentIds, "track-2"] }] };
    const o = slotOptions(gear, ...P, picksFor({ baseItemIds: ["square-track"], supportId: "fisher-11", noseId: "fisher-sle" }));
    assert.equal(byId(o.base, "square-track").available, true, "the picked one stays");
    assert.equal(byId(o.base, "track-2").available, false);
    assert.match(byId(o.base, "track-2").reason, /needs the floor to sit on, but the base layer below already ends in square track/i);
  });

  test("an apple-box face that isn't allowed is never offered", () => {
    const badBox = { id: "half12", name: "Half apple, 12in", category: "base", kind: "apple-box", boxSize: "half", orientation: "12in", bottomMount: "ground", topMount: "ground", rise: 12 };
    const gear = { ...seed, components: [...seed.components, badBox], packages: [{ ...seed.packages[0], componentIds: [...seed.packages[0].componentIds, "half12"] }] };
    const o = slotOptions(gear, ...P, picksFor());
    assert.equal(byId(o.base, "half12").available, false);
    assert.match(byId(o.base, "half12").reason, /half apple can't stand on its 12" face — only a full apple can/i);
    const full = byId(o.base, "apple-full");
    assert.deepEqual(full.modes.filter((m) => m.available).map((m) => m.name), ["flat", "12in", "20in"], "a full apple may use any face");
  });

  test("with no support chosen, everything above says so instead of guessing", () => {
    const o = opts({ supportId: null, adapterIds: [], headId: null, modeName: null, attachName: null });
    assert.match(byId(o.adapters, "mitchell-riser-6").reason, /choose a support first/i);
    assert.match(byId(o.head, "head-standard-placeholder").reason, /choose a support first/i);
  });

  test("every reason is plain language: no field names or nulls leak through", () => {
    const scenarios = [
      opts(),
      opts({ baseItemIds: ["square-track"], supportId: null, headId: null, modeName: null, attachName: null }),
      opts({ baseItemIds: ["apple-half"], supportId: null, headId: null, modeName: null, attachName: null }),
      opts({ adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" }, modeName: "underslung", attachName: "base-inverted" }),
    ];
    for (const o of scenarios) {
      const reasons = [
        ...o.base, ...o.support, ...o.adapters, ...o.head, ...o.attach,
        ...o.adapters.flatMap((a) => a.modes), ...o.head.flatMap((h) => h.modes),
      ].map((e) => e.reason).filter(Boolean);
      assert.ok(reasons.length > 0);
      for (const reason of reasons) {
        assert.ok(reason.length > 10);
        assert.doesNotMatch(reason, /bottomMount|topMount|mountFacing|MountFacing|requiresFamily|undefined|null|\[object/);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// When a pick changes — revalidatePicks (SPEC.md 5.9)
// ---------------------------------------------------------------------------

describe("revalidatePicks: clear what stopped fitting, and say why", () => {
  test("a legal rig comes back unchanged with no notes", () => {
    const start = picksFor({ adapterIds: ["mitchell-riser-6"], baseItemIds: ["apple-half"] });
    const { picks, notes } = revalidatePicks(seed, ...P, start);
    assert.deepEqual(picks, start);
    assert.deepEqual(notes, []);
  });

  test("ticking an apple box under a dolly clears the dolly, in plain words, and keeps what's above", () => {
    const { picks, notes } = revalidate({ supportId: "fisher-11", noseId: "fisher-sle", baseItemIds: ["apple-half"], adapterIds: ["mitchell-riser-6"] });
    assert.equal(picks.supportId, null);
    assert.deepEqual(notes, ["Cleared Fisher 11 Dolly. It is a dolly, and apple boxes can't go under a dolly — use track."]);
    assert.deepEqual(picks.adapterIds, ["mitchell-riser-6"], "picks above the empty slot are kept");
    assert.equal(picks.headId, "head-standard-placeholder");
  });

  test("changing the support to one that takes no nose fitting clears the nose fitting, and keeps the adapters", () => {
    const { picks, notes } = revalidate({ noseId: "fisher-sle", adapterIds: ["mitchell-riser-6"] });
    assert.equal(picks.noseId, null);
    assert.deepEqual(picks.adapterIds, ["mitchell-riser-6"]);
    assert.deepEqual(notes, ["Cleared SLE — 4-way Level Head. It mounts on a Fisher beam nose, and Baby Tripod tops out in a Mitchell mount — it takes no nose fitting."]);
  });

  test("a Fisher with no nose fitting is incomplete, not illegal: what's above is kept", () => {
    const { picks, notes } = revalidate({ supportId: "fisher-11", adapterIds: ["mitchell-riser-6"] });
    assert.deepEqual(notes, []);
    assert.equal(picks.supportId, "fisher-11");
    assert.equal(picks.noseId, null);
    assert.deepEqual(picks.adapterIds, ["mitchell-riser-6"]);
    assert.equal(missingSlot(seed, ...P, picks), "nose");
    assert.equal(missingSlot(seed, ...P, { ...picks, noseId: "fisher-lhe" }), null);
    assert.throws(() => buildChain(seed, { packageId: P[0], buildId: P[1], ...picks }), /Missing nose fitting/);
  });

  test("a wheel set that can't ride what's beneath switches to one that can, with a note", () => {
    const { picks, notes } = revalidate({ supportId: "fisher-11", supportMode: "etw", noseId: "fisher-sle" });
    assert.equal(picks.supportMode, "pneumatic");
    assert.match(notes[0], /^Switched Fisher 11 Dolly to Pneumatic tires\. On ETW round track wheels, it sits on round track, not on the floor\.$/);
    const onRound = revalidate({ supportId: "fisher-11", supportMode: "pneumatic", noseId: "fisher-sle", baseItemIds: ["round-track"] });
    assert.equal(onRound.picks.supportMode, "etw", "the first wheel set that rides round track");
  });

  test("track under a tripod clears the tripod", () => {
    const { picks, notes } = revalidate({ baseItemIds: ["square-track"] });
    assert.equal(picks.supportId, null);
    assert.match(notes[0], /^Cleared Baby Tripod\. It sits on the floor, not on square track\.$/);
  });

  test("refilling the empty support revalidates what was kept above it", () => {
    const cleared = revalidate({ supportId: "fisher-11", noseId: "fisher-sle", baseItemIds: ["apple-half"], adapterIds: ["mitchell-riser-6"] }).picks;
    assert.equal(cleared.supportId, null);
    assert.equal(cleared.noseId, "fisher-sle", "kept while there's no support to judge it by");
    const { picks, notes } = revalidatePicks(seed, ...P, { ...cleared, supportId: "tripod-baby-placeholder" });
    assert.equal(picks.noseId, null, "the nose fitting is cleared now that a tripod is chosen");
    assert.deepEqual(picks.adapterIds, ["mitchell-riser-6"]);
    assert.match(notes[0], /SLE/);
  });

  test("flipping the offset underslung switches the head and the camera, with a note each", () => {
    const { picks, notes } = revalidate({ adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" } });
    assert.equal(picks.modeName, "underslung");
    assert.equal(picks.attachName, "base-inverted");
    assert.equal(notes.length, 2);
    assert.match(notes[0], /^Switched the head to underslung mode\. Normal mode needs an up-facing mount beneath the head, but the top of Mitchell Offset, 10″ \(Bottom of the plate\) faces down\.$/);
    assert.match(notes[1], /^Switched the camera mount to "Inverted — flip image"\./);
    assert.doesNotThrow(() => buildChain(seed, { packageId: P[0], buildId: P[1], ...picks }));
  });

  test("taking the offset away from an underslung rig turns the head and camera back", () => {
    const { picks, notes } = revalidate({ modeName: "underslung", attachName: "base-inverted" });
    assert.equal(picks.modeName, "normal");
    assert.equal(picks.attachName, "base");
    assert.equal(notes.length, 2);
    assert.match(notes[0], /Switched the head to normal mode\. Underslung mode needs a down-facing mount beneath the head/);
  });

  test("a head with no legal mode is cleared", () => {
    // The lambda head only has an up-facing underslung mode; an underslung offset makes it illegal.
    const { picks, notes } = revalidate({ headId: "head-lambda-placeholder", modeName: "underslung", attachName: "base", adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" } });
    assert.equal(picks.headId, null);
    assert.match(notes[0], /^Cleared Lambda Head\. /);
  });

  test("ids the package doesn't have are dropped quietly", () => {
    const { picks, notes } = revalidate({ baseItemIds: ["nope"], adapterIds: ["also-nope"] });
    assert.deepEqual(picks.baseItemIds, []);
    assert.deepEqual(picks.adapterIds, []);
    assert.deepEqual(notes, []);
  });

  test("a leftover attach point that no longer fits switches to one that does", () => {
    const { picks } = revalidate({ attachName: "top-handle" });
    assert.equal(picks.attachName, "base");
  });

  test("notes open with what happened and never repeat the component's name as a subject", () => {
    for (const over of [
      { supportId: "fisher-11", noseId: "fisher-sle", baseItemIds: ["apple-half"] },
      { noseId: "fisher-lhe" },
      { baseItemIds: ["square-track"] },
    ]) {
      for (const note of revalidate(over).notes) assert.match(note, /^(Cleared|Removed|Switched) .+\. It /);
    }
  });
});

// ---------------------------------------------------------------------------
// Toggle, text, or dropdown — modeControl (SPEC.md 5.9)
// ---------------------------------------------------------------------------

describe("modeControl", () => {
  const entry = (name, over = {}) => ({ name, label: name, flipped: /underslung|inverted/.test(name), available: true, reason: null, ...over });

  test("two legal states, one of them underslung, is a toggle", () => {
    const control = modeControl([entry("normal"), entry("underslung")]);
    assert.equal(control.type, "toggle");
    assert.equal(control.on.name, "underslung");
    assert.equal(control.off.name, "normal");
  });

  test("a mode that exists but isn't legal right now is not offered; the reason comes back as a hint", () => {
    const control = modeControl([entry("normal"), entry("underslung", { available: false, reason: "needs a down-facing mount" })]);
    assert.equal(control.type, "static");
    assert.equal(control.entry.name, "normal");
    assert.equal(control.hint, "needs a down-facing mount");
  });

  test("one legal mode is plain text; none is nothing", () => {
    assert.equal(modeControl([entry("underslung")]).type, "static");
    assert.equal(modeControl([entry("normal", { available: false, reason: "x" })]).type, "none");
  });

  test("three legal modes, or two with no flipped one, fall back to a dropdown", () => {
    assert.equal(modeControl([entry("a"), entry("b"), entry("c")]).type, "dropdown");
    assert.equal(modeControl([entry("a"), entry("b")]).type, "dropdown");
  });

  test("on the seed: a tripod head gets no toggle, the offset does, and so does the camera when hung", () => {
    const tripodOpts = opts();
    assert.equal(modeControl(byId(tripodOpts.head, "head-standard-placeholder").modes).type, "static");
    assert.match(modeControl(byId(tripodOpts.head, "head-standard-placeholder").modes).hint, /underslung mode needs a down-facing mount/i);
    assert.equal(modeControl(tripodOpts.attach).type, "static", "an upright head only has the upright mount");

    const offsetControl = modeControl(byId(tripodOpts.adapters, "mitchell-offset-10").modes);
    assert.equal(offsetControl.type, "toggle");
    assert.equal(offsetControl.on.name, "bottom", "the plate's bottom side is the flipped state: it faces down");
    assert.equal(offsetControl.off.name, "top");

    const hung = opts({ adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" }, modeName: "underslung", attachName: "base-inverted" });
    const camera = modeControl(hung.attach);
    assert.equal(camera.type, "toggle");
    assert.equal(camera.on.name, "base-inverted");
    assert.equal(camera.off.name, "top-handle");
    // With the plate's bottom side taking the normal mode away, the head has nothing to toggle.
    assert.equal(modeControl(byId(hung.head, "head-standard-placeholder").modes).type, "static");
  });

  test("components with no underslung mode never get a toggle", () => {
    assert.equal(modeControl(byId(opts().adapters, "mitchell-riser-6").modes).type, "static");
  });
});

// ---------------------------------------------------------------------------
// The engine agrees with the solver
// ---------------------------------------------------------------------------

describe("slot rules agree with the solver's own validation", () => {
  test("defaultPicks is a complete rig the solver accepts", () => {
    const picks = defaultPicks(seed, ...P);
    for (const key of ["supportId", "headId", "modeName", "attachName"]) assert.ok(picks[key], key);
    assert.doesNotThrow(() => buildChain(seed, { packageId: P[0], buildId: P[1], ...picks }));
  });

  test("every chain the solver enumerates survives revalidation untouched", () => {
    let count = 0;
    for (const chain of enumerateChains(seed, { packageId: P[0], buildId: P[1], maxBaseLayerItems: 2, maxAdapters: 2 })) {
      const picks = describeCurrentRig(chain);
      const { picks: after, notes } = revalidatePicks(seed, ...P, picks);
      assert.deepEqual(notes, [], JSON.stringify(picks));
      assert.deepEqual(after, picks);
      count++;
    }
    assert.ok(count > 1000, "and there were plenty");
  });

  test("random picks: whatever revalidation leaves complete, the solver builds", () => {
    // A small seeded generator, so a failure reproduces.
    let state = 20260924;
    const random = () => {
      state = (state * 1664525 + 1013904223) % 4294967296;
      return state / 4294967296;
    };
    const pick = (list) => list[Math.floor(random() * list.length)];
    const some = (list, max) => list.filter(() => random() < 0.3).slice(0, max);
    const pool = getPackageComponents(seed, P[0]);
    const ids = (category) => pool.filter((c) => c.category === category).map((c) => c.id);
    const heads = pool.filter((c) => c.category === "head");

    let complete = 0;
    for (let i = 0; i < 3000; i++) {
      const adapterIds = some(ids("adapter"), 3);
      const adapterModes = {};
      for (const id of adapterIds) {
        const adapter = pool.find((c) => c.id === id);
        if (adapter.modes) adapterModes[id] = pick(adapter.modes).name;
      }
      const head = pick(heads);
      const supportId = pick(ids("support"));
      const support = pool.find((c) => c.id === supportId);
      const noseId = random() < 0.8 ? pick(ids("nose")) : null;
      const nose = pool.find((c) => c.id === noseId) || null;
      const { picks } = revalidatePicks(seed, ...P, {
        baseItemIds: some(ids("base"), 3),
        supportId: support.id,
        supportMode: support.modes ? pick(support.modes).name : null,
        noseId: nose ? nose.id : null,
        noseMode: nose && nose.modes ? pick(nose.modes).name : null,
        adapterIds,
        adapterModes,
        headId: head.id,
        modeName: pick(head.modes).name,
        attachName: pick(["base", "base-inverted", "top-handle"]),
      });
      if (missingSlot(seed, ...P, picks)) continue;
      assert.doesNotThrow(() => buildChain(seed, { packageId: P[0], buildId: P[1], ...picks }), JSON.stringify(picks));
      complete++;
    }
    assert.ok(complete > 500);
  });

  test("a rejected support option would really be refused by the solver", () => {
    for (const base of [["square-track"], ["apple-half"], []]) {
      const picks = picksFor({ baseItemIds: base, supportId: null, headId: null, modeName: null, attachName: null });
      for (const option of slotOptions(seed, ...P, picks).support) {
        if (option.available) continue;
        assert.throws(
          () =>
            buildChain(seed, {
              packageId: P[0], buildId: P[1], baseItemIds: base, supportId: option.id, adapterIds: [],
              headId: "head-standard-placeholder", modeName: "normal", attachName: "base",
            }),
          undefined,
          `${option.id} on ${base.join("+") || "the floor"}`
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Stack layout (SPEC.md 5.8)
// ---------------------------------------------------------------------------

describe("stackLayout", () => {
  const fixed = (height) => ({ type: "fixed", height });
  const range = (low, high) => ({ type: "range", low, high });
  const totalRise = (layout) => layout.blocks.reduce((sum, b) => sum + b.rise, 0);

  test("blocks run bottom to top, and their rises add up to where the lens sits", () => {
    const plate = { id: "plate", name: "Plate", category: "base", bottomMount: "ground", topMount: "ground", rise: 2 };
    const riser = { id: "riser", name: "Riser", category: "adapter", bottomMount: "mitchell", topMount: "mitchell", rise: 6, mountFacing: "up" };
    const { chain } = rig({ support: tripod(), base: [plate], adapters: [riser] });
    // 2 + tripod 10..30 + 6 + head 5 + camera 4  -> reach 27..47
    const layout = stackLayout(chain, fixed(35));
    assert.deepEqual(layout.blocks.map((b) => b.slot), ["base", "support", "adapter", "head", "build"]);
    assert.equal(layout.lens.height, 35);
    assert.ok(Math.abs(totalRise(layout) - 35) < 1e-9);
    assert.deepEqual(layout.blocks.map((b) => b.rise), [2, 18, 6, 5, 4]); // tripod extended 8" past its 10"
  });

  test("the floor is the bottom of the drawing and blocks are contiguous", () => {
    const { chain } = rig({ support: tripod() });
    const layout = stackLayout(chain, fixed(25));
    assert.equal(layout.floor.height, 0);
    assert.equal(layout.floor.pct, 0);
    assert.equal(layout.blocks[0].bottomPct, 0);
    for (let i = 1; i < layout.blocks.length; i++) {
      const below = layout.blocks[i - 1];
      assert.ok(Math.abs(layout.blocks[i].bottomPct - (below.bottomPct + below.heightPct)) < 0.05, `block ${i} starts where the one below ends`);
    }
    for (const b of layout.blocks) assert.ok(b.bottomPct >= 0 && b.bottomPct + b.heightPct <= 100.01);
  });

  test("a tripod is drawn as a fixed base plus an adjustable extension, up to the target", () => {
    const { chain } = rig({ support: tripod() }); // 10..30 + 5 + 4 -> reach 19..39
    const layout = stackLayout(chain, fixed(29));
    const support = layout.blocks.find((b) => b.slot === "support");
    assert.equal(support.kind, "adjustable");
    assert.deepEqual(support.parts.map((p) => [p.kind, p.rise]), [["adjustable", 20]]); // riseRange base 10 + 10 of extension
    assert.deepEqual(support.range, { min: 10, max: 30 });
    assert.equal(layout.moveable, null, "nothing on a tripod moves live");
  });

  test("a dolly: fixed base plus a moveable extension, and the boom's sweep is marked", () => {
    const { chain } = rig({ support: dolly() }); // base 6, boom 0..20, + 5 + 4 -> reach 15..35
    const layout = stackLayout(chain, fixed(25));
    const support = layout.blocks.find((b) => b.slot === "support");
    assert.equal(support.kind, "moveable");
    assert.deepEqual(support.parts.map((p) => [p.kind, p.rise]), [["fixed", 6], ["moveable", 10]]);
    // Rigged at 25 with the boom 10" out, it can sweep 10" down and 10" up.
    assert.deepEqual([layout.moveable.min, layout.moveable.max], [15, 35]);
  });

  test("legs position the rig first, the boom takes only what's left", () => {
    const boomOnLegs = dolly({
      id: "boom-on-legs",
      legRange: { practicalMin: 0, practicalMax: 30 },
      baseRise: 0,
      boomRange: { specMin: 0, specMax: 10, practicalMin: 0, practicalMax: 10 },
    });
    const { chain } = rig({ support: boomOnLegs }); // legs 0..30 + boom 0..10, + 9 -> reach 9..49
    const parts = (target) => stackLayout(chain, target).blocks.find((b) => b.slot === "support").parts;

    // 20" of extension: the legs absorb it all; the boom stays retracted.
    assert.deepEqual(parts(fixed(29)).map((p) => [p.kind, p.rise]), [["adjustable", 20], ["moveable", 0]]);
    // 36" of extension: the legs give their 30, the boom the other 6.
    assert.deepEqual(parts(fixed(45)).map((p) => [p.kind, p.rise]), [["adjustable", 30], ["moveable", 6]]);
    // At the first setup the boom can sweep its full 10" up from where it rests.
    assert.deepEqual([stackLayout(chain, fixed(29)).moveable.min, stackLayout(chain, fixed(29)).moveable.max], [29, 39]);
  });

  test("a range target rigs the lens at its low end and marks the whole move", () => {
    const { chain } = rig({ support: dolly() });
    const layout = stackLayout(chain, range(20, 32));
    assert.equal(layout.lens.height, 20);
    assert.equal(layout.target.isRange, true);
    assert.deepEqual([layout.target.low, layout.target.high], [20, 32]);
    assert.ok(layout.target.heightPct > 0);
    const fixedLayout = stackLayout(chain, fixed(20));
    assert.equal(fixedLayout.target.isRange, false);
    assert.equal(fixedLayout.target.heightPct, 0, "a fixed target is a line");
  });

  test("a target the chain can't reach is drawn where it is, with the lens at the nearest end", () => {
    const { chain } = rig({ support: tripod() }); // reach 19..39
    const above = stackLayout(chain, fixed(50));
    assert.equal(above.lens.height, 39);
    assert.ok(above.target.bottomPct > above.lens.pct, "the target line sits above the rig");
    const below = stackLayout(chain, fixed(10));
    assert.equal(below.lens.height, 19);
    assert.ok(below.target.bottomPct < below.lens.pct);
  });

  test("no target: fully retracted, nothing marked", () => {
    const { chain } = rig({ support: tripod() });
    const layout = stackLayout(chain, null);
    assert.equal(layout.target, null);
    assert.equal(layout.lens.height, chain.min);
  });

  test("reach spans the lens heights the chain can reach", () => {
    const { chain } = rig({ support: tripod() });
    const layout = stackLayout(chain, fixed(25));
    assert.deepEqual([layout.reach.min, layout.reach.max], [chain.min, chain.max]);
    assert.ok(layout.reach.heightPct > 0);
  });

  test("an underslung head hangs below where the piece under it ended, and a zero rise has no height", () => {
    const hanging = {
      id: "hang", name: "Hanging head", category: "head", bottomMount: "mitchell", topMount: "flat-38",
      modes: [{ name: "underslung", rise: -4, cameraMountFacing: "down", supportMountFacing: "down" }],
    };
    const offset = {
      id: "off", name: "Offset", category: "adapter", bottomMount: "mitchell", topMount: "mitchell",
      modes: [{ name: "underslung", rise: 0, mountFacing: "down" }],
    };
    const { chain } = rig({ support: tripod(), adapters: [{ ...offset, modes: undefined, rise: 0, mountFacing: "down" }], head: hanging, mode: "underslung" });
    const layout = stackLayout(chain, fixed(chain.min));
    const head = layout.blocks.find((b) => b.slot === "head");
    const adapter = layout.blocks.find((b) => b.slot === "adapter");
    const support = layout.blocks.find((b) => b.slot === "support");
    assert.equal(head.direction, "down");
    assert.equal(adapter.direction, "flat");
    assert.equal(adapter.heightPct, 0);
    assert.ok(head.bottomPct < support.bottomPct + support.heightPct, "it dips back down into the support's top");
  });

  test("blocks carry the component and its name, so a renderer needs nothing else", () => {
    const { chain } = rig({ support: tripod() });
    const layout = stackLayout(chain, fixed(25));
    for (const b of layout.blocks) {
      assert.ok(b.name && b.component && ["fixed", "adjustable", "moveable"].includes(b.kind));
      assert.equal(typeof b.rise, "number");
    }
    assert.equal(layout.blocks.find((b) => b.slot === "head").mode, "normal");
    assert.equal(layout.blocks.find((b) => b.slot === "build").attach, "base");
  });

  test("on the seed, the layout's positions add up for a spread of rigs", () => {
    for (const chain of enumerateChains(seed, { packageId: P[0], buildId: P[1], maxBaseLayerItems: 1, maxAdapters: 1 }).filter((_, i) => i % 5 === 0)) {
      for (const target of [null, fixed(30), fixed(90), fixed(2), range(25, 40)]) {
        const layout = stackLayout(chain, target);
        assert.ok(Math.abs(totalRise(layout) - layout.lens.height) < 1e-9);
        assert.ok(layout.lens.height >= chain.min - 1e-9 && layout.lens.height <= chain.max + 1e-9);
        for (const b of layout.blocks) assert.ok(b.bottomPct >= -0.01 && b.bottomPct + b.heightPct <= 100.01, `${b.slot} ${b.bottomPct}+${b.heightPct}`);
      }
    }
  });

  test("supportSegments add up to supportInterval for every seed support", () => {
    for (const support of seed.components.filter((c) => c.category === "support")) {
      const segments = supportSegments(support);
      const { min, max } = supportInterval(support);
      assert.equal(segments.reduce((n, s) => n + s.base, 0), min, support.id);
      assert.equal(segments.reduce((n, s) => n + s.base + s.extent, 0), max, support.id);
    }
  });
});

// ---------------------------------------------------------------------------
// Shortfall, normalizeTarget, the cap (SPEC.md 5.1, 5.2)
// ---------------------------------------------------------------------------

describe("shortfall", () => {
  const { chain } = rig({ support: tripod() }); // reach 19..39
  const evalFor = (target, c = chain) => evaluateChain(c, target);

  test("null when feasible", () => {
    assert.equal(evalFor({ type: "fixed", height: 30 }).shortfall, null);
  });

  test("short: how far above the reach the target is", () => {
    const e = evalFor({ type: "fixed", height: 44 });
    assert.deepEqual(e.shortfall, { direction: "short", amount: 5 });
    assert.equal(e.shortfall.amount, -e.marginAbove, "straight from the margin, not recomputed");
  });

  test("tall: how far below the reach the target is", () => {
    assert.deepEqual(evalFor({ type: "fixed", height: 12 }).shortfall, { direction: "tall", amount: 7 });
  });

  test("a range that runs past the top is short by its high end", () => {
    assert.deepEqual(evalFor({ type: "range", low: 30, high: 45, rangeType: "adjustable" }).shortfall, { direction: "short", amount: 6 });
  });

  test("span: in reach, but wider than the moveable travel", () => {
    const { chain: onTripod } = rig({ support: tripod() });
    const tripodShort = evaluateChain(onTripod, { type: "range", low: 22, high: 32 }); // a tripod can't move live
    assert.deepEqual(tripodShort.shortfall, { direction: "span", amount: 10, needed: 10, available: 0 });

    const { chain: onDolly } = rig({ support: dolly() }); // boom 20" wide, reach 15..35
    const inReach = evaluateChain(onDolly, { type: "range", low: 16, high: 34 }); // 18" move fits the 20" boom
    assert.equal(inReach.shortfall, null);
    const narrowBoom = rig({ support: dolly({ boomRange: { practicalMin: 0, practicalMax: 8 } }) }).chain; // 8" boom, reach 15..23
    const tooWide = evaluateChain(narrowBoom, { type: "range", low: 16, high: 24, rangeType: "moveable" });
    assert.equal(tooWide.shortfall.direction, "short", "past the top comes first");
    const fits = rig({ support: dolly({ baseRise: 0, legRange: { practicalMin: 0, practicalMax: 30 }, boomRange: { practicalMin: 0, practicalMax: 6 } }) }).chain;
    const spanOnly = evaluateChain(fits, { type: "range", low: 15, high: 25 }); // inside 9..45, but the boom moves 6"
    assert.deepEqual(spanOnly.shortfall, { direction: "span", amount: 4, needed: 10, available: 6 });
  });
});

describe("normalizeTarget and the stacking cap", () => {
  test("form strings become targets; blanks and junk become null", () => {
    assert.deepEqual(normalizeTarget({ type: "fixed", height: "32.5" }), { type: "fixed", height: 32.5 });
    assert.equal(normalizeTarget({ type: "fixed", height: "" }), null);
    assert.equal(normalizeTarget({ type: "fixed", height: "abc" }), null);
    assert.deepEqual(normalizeTarget({ type: "range", low: "25", high: "40" }), { type: "range", low: 25, high: 40 });
    assert.equal(normalizeTarget({ type: "range", low: "25", high: "" }), null);
  });

  test("a range typed high-to-low is read low-to-high, so the UI never compares heights", () => {
    assert.deepEqual(normalizeTarget({ type: "range", low: "40", high: "25" }), { type: "range", low: 25, high: 40 });
  });

  test("a range is not given a rangeType: it defaults to moveable", () => {
    assert.equal(normalizeTarget({ type: "range", low: 1, high: 2 }).rangeType, undefined);
  });

  test("exceedsBaseLayerCap flags a base layer past the cap and no other", () => {
    assert.equal(exceedsBaseLayerCap({ baseItems: [1, 2] }), false);
    assert.equal(exceedsBaseLayerCap({ baseItems: [1, 2, 3] }), true);
    assert.equal(exceedsBaseLayerCap({ baseItems: [1, 2, 3] }, 3), false);
  });
});

describe("check mode, end to end on the seed", () => {
  test("an infeasible rig returns a shortfall and fixes, the best few first", () => {
    const picks = defaultPicks(seed, ...P);
    const result = checkChain(seed, { target: { type: "fixed", height: 60 }, packageId: P[0], buildId: P[1], chain: picks });
    assert.equal(result.evaluation.feasible, false);
    assert.equal(result.evaluation.shortfall.direction, "short");
    assert.ok(result.delta.candidates.length >= 3, "enough to show three and expand the rest");
    const counts = result.delta.candidates.map((c) => c.changes.length);
    assert.deepEqual(counts, [...counts].sort((a, b) => a - b), "fewest changes first");
  });
});

// ---------------------------------------------------------------------------
// The UI stays thin (SPEC.md 7.2)
// ---------------------------------------------------------------------------

describe("the UI layer", () => {
  const html = readFileSync(path.join(root, "index.html"), "utf8");
  const app = readFileSync(path.join(root, "app.js"), "utf8");

  test("solve mode is hidden from the UI: no toggle, no solve screen, no submit button, nothing calls it", () => {
    assert.doesNotMatch(html, /mode-solve|mode-check|mode-toggle|Find config|Check rig|type="submit"|run-button/);
    assert.doesNotMatch(app, /\bsolve\s*\(|import\s*\{[^}]*\bsolve\b|mode-solve|state\.mode/);
  });

  test("...but frozen, not removed: solve mode is still exported and cli.js is still there", () => {
    assert.equal(typeof solver.solve, "function");
    assert.equal(typeof solver.run, "function");
    assert.ok(readFileSync(path.join(root, "cli.js"), "utf8").includes("solve("));
  });

  test("the UI asks rules.js and stack.js instead of knowing the rules", () => {
    assert.match(app, /from "\.\/src\/rules\.js"/);
    assert.match(app, /from "\.\/src\/stack\.js"/);
    for (const token of [
      "acceptsMount", "requiresFamily", "supportMountFacing", "mountFacing", "cameraMountFacing",
      "bottomMount", "topMount", "boxSize", "orientation", "apple-box", "dolly-wheels", "orderStack", "supportInterval",
    ]) {
      assert.ok(!app.includes(token), `app.js must not know about ${token}`);
    }
    assert.ok(!/\.kind\s*===/.test(app), "no branching on component kinds");
  });

  test("no height math in app.js: no arithmetic on a height, margin, rise, or position", () => {
    const code = app
      .replace(/\/\/.*$/gm, "") // comments
      .replace(/`[^`]*`/gs, (t) => t.replace(/\$\{[^}]*\}/g, "$$")) // template text, keep only that the placeholders exist
      .replace(/"[^"\n]*"|'[^'\n]*'/g, '""');
    const heights = "min|max|rise|height|low|high|marginBelow|marginAbove|amount|needed|available|bottomPct|heightPct|pct|lens";
    const arithmetic = new RegExp(`\\b(${heights})\\b\\s*[-+*/]\\s*[\\w(.]|[\\w).]\\s*[-+*/]\\s*\\b(${heights})\\b`);
    assert.doesNotMatch(code, arithmetic);
    assert.doesNotMatch(app.replace(/\/\/.*$/gm, ""), /\b(min|max|rise|height|low|high|marginBelow|marginAbove|amount)\b\s*(>=|<=|>|<)\s*[\w(]/, "no comparing heights");
    assert.doesNotMatch(app, /Math\.(min|max|abs|round|floor|ceil)\(/, "no Math on anything");
  });

  test("the picks come from slotOptions, and every change goes through revalidatePicks", () => {
    assert.match(app, /slotOptions\(/);
    assert.match(app, /revalidatePicks\(/);
    assert.match(app, /modeControl\(/);
  });

  test("edits in the drawing come from rules.js; the verdict and drawing from src/", () => {
    for (const fn of ["addOptions(", "swapOptions(", "applyEdit(", "checkVerdict(", "stackLayout("]) {
      assert.ok(app.includes(fn), `app.js calls ${fn}`);
    }
  });

  test("delta search is frozen and hidden: no fixes, and nothing calls it", () => {
    assert.doesNotMatch(app, /checkChain|deltaSearch|\.delta\b|fixes|fixHtml/i);
    assert.equal(typeof solver.checkChain, "function", "still exported");
  });

  test("the drawing is the editor: no summary card, no checkbox lists or dropdown sections", () => {
    assert.doesNotMatch(html, /id="picks"|id="result-body"|id="stack-card"|type="checkbox"|<select/);
    assert.doesNotMatch(app, /type="checkbox"|data-slot=|stack-rows|legend|result-feasible|marginRow/);
  });

  test("information appears once: no '(placeholder)' names; 'flip image' only on the camera label", () => {
    for (const c of [...seed.components, ...seed.packages, ...seed.builds]) {
      assert.doesNotMatch(c.name, /placeholder/i, c.id);
    }
    assert.equal(app.split("Camera inverted — flip image").length - 1, 1, "written once, in the camera's label");
    assert.doesNotMatch(app, /[Ee]stimated|measured|class="dot"/, "no measured/estimated marking at all");
  });

  test("simplified: one Add button, no '+' at junctions, no margin tags, no 'why not' lists", () => {
    const css = readFileSync(path.join(root, "styles.css"), "utf8");
    assert.equal((html.match(/data-add=""/g) || []).length, 1, "one Add button");
    assert.doesNotMatch(app, /data-gap|lane-add|insertOptions/, "no per-junction +");
    assert.doesNotMatch(app, /margins\.|above<\/span>|below<\/span>/, "no margin tags");
    assert.doesNotMatch(app + css, /why-not|Why not/i);
    assert.doesNotMatch(css, /text-overflow:\s*ellipsis/, "labels wrap instead of truncating");
    assert.doesNotMatch(css, /dashed/, "the target is the only strong line; nothing dashed");
  });

  test("the drawing is outlines from src/outlines.js; adding places an item by tapping a marker, not a list", () => {
    for (const fn of ["pieceSvg(", "hitLayer(", "markerSvg(", "leaderSvg("]) assert.ok(app.includes(fn), fn);
    assert.match(app, /data-place=/, "markers insert on tap");
    assert.match(app, /data-place-item=/, "an item with several points goes to the markers");
    assert.doesNotMatch(app, /Where\?|at\.where, null\)/, "no text list of positions");
    assert.doesNotMatch(app, /col-\$|\.column\b|connector/, "no columns");
  });

  test("moveable / adjustable / fixed, consistently", () => {
    for (const phrase of ["Set between setups", "Moves during the take", "live travel", "move live counts"]) {
      assert.ok(!app.includes(phrase) && !html.includes(phrase), phrase);
    }
    assert.match(app, /\["moveable", "adjustable", "fixed"\]/);
  });
});
