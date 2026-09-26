// The J.L. Fisher Model 11 (docs/fisher-11.md): the brochure checks, wheel
// modes and track, nose fittings, and how they're drawn. SPEC.md 3.1, 3.2,
// 3.7, 5.2, 5.8.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildChain, enumerateChains } from "../src/solver.js";
import { riseRangeOf, supportInterval } from "../src/model.js";
import { missingSlot, modeControl, revalidatePicks, slotOptions, supportVariants } from "../src/rules.js";
import { stackLayout } from "../src/stack.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(path.join(root, "gear.json"), "utf8"));
const P = ["test-package", "build-placeholder"];
const byId = (id) => seed.components.find((c) => c.id === id);

const fisher = (over = {}) => ({
  packageId: P[0],
  buildId: P[1],
  baseItemIds: [],
  supportId: "fisher-11",
  supportMode: "pneumatic",
  noseId: "fisher-sle",
  noseMode: "upright",
  adapterIds: [],
  headId: "head-standard-placeholder",
  modeName: "normal",
  attachName: "base",
  ...over,
});
const chainOf = (over) => buildChain(seed, fisher(over));

/** The Mitchell's height above the floor: the brochure's figure, which is
 * the chain's interval without the head and camera on top. */
const mitchell = (chain) => ({
  min: chain.min - chain.mode.rise - chain.attach.rise,
  max: chain.max - chain.mode.rise - chain.attach.rise,
});

// ---------------------------------------------------------------------------
// Brochure checks (docs/fisher-11.md section 2): pneumatic tires, on the floor
// ---------------------------------------------------------------------------

describe("Fisher 11 brochure checks", () => {
  const BEAM = 33.375;

  test("SLE upright: 13.875″ beam down at the bottom of its adjustment, 51.25″ beam up at the top", () => {
    assert.deepEqual(mitchell(chainOf()), { min: 13.875, max: 51.25 });
  });

  test("SLE upright at the top of its adjustment: 17.875″ beam down; at the bottom: 47.25″ beam up", () => {
    const beam = supportInterval(supportVariants(byId("fisher-11"))[0]);
    const sle = riseRangeOf(chainOf().nose);
    assert.deepEqual(beam, { min: 17.875, max: 17.875 + BEAM });
    assert.equal(beam.min + sle.max, 17.875, "beam down, SLE at the top");
    assert.equal(beam.max + sle.min, 47.25, "beam up, SLE at the bottom");
  });

  test("SLE reversed equals the top of the upright range: 17.875″ beam down, 51.25″ beam up", () => {
    assert.deepEqual(mitchell(chainOf({ noseMode: "reversed" })), { min: 17.875, max: 51.25 });
  });

  test("LHE: 3″ beam down, 36.375″ beam up", () => {
    assert.deepEqual(mitchell(chainOf({ noseId: "fisher-lhe", noseMode: undefined })), { min: 3, max: 36.375 });
  });

  test("beam travel is 33.375″ in every configuration", () => {
    for (const nose of [{ noseMode: "upright" }, { noseMode: "reversed" }, { noseId: "fisher-lhe", noseMode: undefined }]) {
      const chain = chainOf(nose);
      assert.equal(chain.moveableInterval.max - chain.moveableInterval.min, BEAM, JSON.stringify(nose));
    }
  });

  test("the SLE's 4″ is adjustable: it widens the reach, not the live move", () => {
    const chain = chainOf();
    assert.equal(chain.max - chain.min, BEAM + 4);
    assert.equal(chain.adjustability, "moveable");
    assert.equal(chainOf({ noseMode: "reversed" }).max - chainOf({ noseMode: "reversed" }).min, BEAM);
  });
});

// ---------------------------------------------------------------------------
// Wheel modes and track (docs/fisher-11.md section 3)
// ---------------------------------------------------------------------------

describe("Fisher wheel modes and track", () => {
  const floorMin = chainOf().min;

  test("ETW and skateboard wheels are rejected on the floor and on square track", () => {
    for (const supportMode of ["etw", "skateboard"]) {
      assert.throws(() => chainOf({ supportMode }), /doesn't sit on "ground"/, `${supportMode} on the floor`);
      assert.throws(() => chainOf({ supportMode, baseItemIds: ["square-track"] }), /doesn't sit on "square-track"/, `${supportMode} on square track`);
      assert.doesNotThrow(() => chainOf({ supportMode, baseItemIds: ["round-track"] }), `${supportMode} on round track`);
    }
  });

  test("pneumatic tires ride the floor or square track, never round track", () => {
    assert.doesNotThrow(() => chainOf());
    assert.doesNotThrow(() => chainOf({ baseItemIds: ["square-track"] }));
    assert.throws(() => chainOf({ baseItemIds: ["round-track"] }), /doesn't sit on "round-track"/);
  });

  test("totals against the floor: square + pneumatic +2″, round + ETW +1.5″, round + skateboard +4″", () => {
    assert.equal(chainOf({ baseItemIds: ["square-track"] }).min - floorMin, 2);
    assert.equal(chainOf({ baseItemIds: ["round-track"], supportMode: "etw" }).min - floorMin, 1.5);
    assert.equal(chainOf({ baseItemIds: ["round-track"], supportMode: "skateboard" }).min - floorMin, 4);
  });

  test("the rules offer only the wheel sets that ride what's beneath", () => {
    const wheels = (baseItemIds) => {
      const entry = slotOptions(seed, ...P, { ...fisher({ baseItemIds }) }).support.find((o) => o.id === "fisher-11");
      return entry.modes.filter((m) => m.available).map((m) => m.name);
    };
    assert.deepEqual(wheels([]), ["pneumatic"]);
    assert.deepEqual(wheels(["square-track"]), ["pneumatic"]);
    assert.deepEqual(wheels(["round-track"]), ["etw", "skateboard"]);
    const control = modeControl(slotOptions(seed, ...P, fisher({ baseItemIds: ["round-track"], supportMode: "etw" })).support.find((o) => o.id === "fisher-11").modes);
    assert.equal(control.type, "dropdown", "two wheel sets, neither flipped: a segmented choice");
  });

  test("a tripod can't stand on either track", () => {
    const tripod = { supportId: "tripod-baby-placeholder", supportMode: undefined, noseId: null, noseMode: undefined };
    for (const track of ["square-track", "round-track"]) {
      assert.throws(() => chainOf({ ...tripod, baseItemIds: [track] }), /doesn't sit on/);
    }
  });

  test("the solver tries every wheel set, each only where it can ride", () => {
    const chains = enumerateChains(seed, { packageId: P[0], buildId: P[1], maxBaseLayerItems: 1, maxAdapters: 0 }).filter(
      (c) => c.support.id === "fisher-11"
    );
    const seen = new Set(chains.map((c) => `${c.support.mode}@${c.baseItems.map((b) => b.id).join("+") || "floor"}`));
    assert.deepEqual([...seen].sort(), ["etw@round-track", "pneumatic@floor", "pneumatic@square-track", "skateboard@round-track"]);
  });
});

// ---------------------------------------------------------------------------
// Nose fittings (SPEC.md 3.7)
// ---------------------------------------------------------------------------

describe("nose fittings", () => {
  test("exactly one on a Fisher: without one it's incomplete, like a missing head", () => {
    assert.throws(() => chainOf({ noseId: null }), /Missing nose fitting/);
    const picks = revalidatePicks(seed, ...P, fisher({ noseId: null })).picks;
    assert.equal(missingSlot(seed, ...P, picks), "nose");
  });

  test("none anywhere else: a nose fitting on a tripod is a mount mismatch", () => {
    assert.throws(
      () => chainOf({ supportId: "tripod-baby-placeholder", supportMode: undefined }),
      /nose fitting "SLE — 4-way Level Head" doesn't mount to support "Baby Tripod"/
    );
  });

  test("every Fisher chain the solver finds has exactly one nose fitting; no other chain has one", () => {
    for (const chain of enumerateChains(seed, { packageId: P[0], buildId: P[1], maxBaseLayerItems: 1, maxAdapters: 1 })) {
      assert.equal(Boolean(chain.nose), chain.support.id === "fisher-11");
    }
  });

  test("nose fittings require the fisher family", () => {
    for (const id of ["fisher-sle", "fisher-lhe"]) {
      const nose = byId(id);
      assert.deepEqual([nose.category, nose.bottomMount, nose.topMount, nose.requiresFamily], ["nose", "fisher-nose", "mitchell", "fisher"]);
    }
    const alien = { ...byId("fisher-11"), id: "other-dolly", family: "chapman" };
    const gear = { ...seed, components: [...seed.components, alien], packages: [{ ...seed.packages[0], componentIds: [...seed.packages[0].componentIds, "other-dolly"] }] };
    assert.throws(() => buildChain(gear, fisher({ supportId: "other-dolly" })), /Family mismatch/);
  });

  test("the SLE's modes are a three-way choice; underslung presents a down-facing Mitchell", () => {
    const entry = slotOptions(seed, ...P, fisher()).nose.find((o) => o.id === "fisher-sle");
    assert.equal(modeControl(entry.modes).type, "dropdown");
    assert.deepEqual(entry.modes.map((m) => m.label), ["Upright", "Reversed", "Underslung"]);
    // Underslung: an underslung head hangs straight from it, no offset needed.
    const hung = chainOf({ noseMode: "underslung", modeName: "underslung", attachName: "base-inverted" });
    assert.deepEqual(riseRangeOf(hung.nose), { min: -8, max: -4 });
    assert.throws(() => chainOf({ noseMode: "underslung" }), /Facing mismatch/, "a normal head can't sit on a down-facing Mitchell");
  });

  test("an underslung rig hangs from the bottom of a U plate on the SLE", () => {
    const chain = chainOf({ adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" }, modeName: "underslung", attachName: "base-inverted" });
    assert.equal(chain.adapters[0].mountFacing, "down");
    assert.equal(chain.attach.inverted, true);
    assert.throws(() => chainOf({ adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "top" }, modeName: "underslung", attachName: "base-inverted" }), /Facing mismatch/);
  });
});

// ---------------------------------------------------------------------------
// How it's drawn (SPEC.md 5.8)
// ---------------------------------------------------------------------------

describe("drawing a Fisher", () => {
  const blockOf = (layout, slot) => layout.blocks.find((b) => b.slot === slot);

  test("the SLE upright is an adjustable block with its range, set before the beam moves", () => {
    const chain = chainOf();
    const headAndCamera = chain.mode.rise + chain.attach.rise;
    // Mitchell at 17.875: the SLE takes it all (to its top), the beam stays down.
    const layout = stackLayout(chain, { type: "fixed", height: 17.875 + headAndCamera });
    const nose = blockOf(layout, "nose");
    assert.equal(nose.kind, "adjustable");
    assert.deepEqual(nose.range, { min: -4, max: 0 });
    assert.equal(nose.rise, 0);
    assert.deepEqual(blockOf(layout, "support").parts.map((p) => [p.kind, p.rise]), [["fixed", 17.875], ["moveable", 0]]);
    // Higher: the SLE is already at its top, so the beam takes the rest.
    const up = stackLayout(chain, { type: "fixed", height: 40 + headAndCamera });
    assert.deepEqual(blockOf(up, "support").parts.map((p) => [p.kind, p.rise]), [["fixed", 17.875], ["moveable", 22.125]]);
    // Lower: the SLE drops below the nose.
    assert.equal(blockOf(stackLayout(chain, { type: "fixed", height: 15 + headAndCamera }), "nose").rise, -2.875);
  });

  test("a fixed nose fitting is a fixed block, with no range", () => {
    const nose = blockOf(stackLayout(chainOf({ noseMode: "reversed" }), null), "nose");
    assert.equal(nose.kind, "fixed");
    assert.equal(nose.range, undefined);
  });

  test("the wheel set shifts the support block and is named on it", () => {
    const layout = stackLayout(chainOf({ baseItemIds: ["round-track"], supportMode: "etw" }), null);
    const support = blockOf(layout, "support");
    assert.equal(support.bottom, 2, "on the track");
    assert.equal(support.rise, 17.375, "17.875 less half an inch for ETW wheels");
    assert.equal(support.modeLabel, "ETW round track wheels");
  });

  test("only the LHE declares hangsAsBracket; the SLE doesn't", () => {
    assert.equal(byId("fisher-lhe").hangsAsBracket, true);
    assert.equal(byId("fisher-sle").hangsAsBracket, undefined);
  });

  test("the SLE sits on the nose: the head is right above it, anywhere in its adjustment", () => {
    const chain = chainOf();
    const headAndCamera = chain.mode.rise + chain.attach.rise;
    for (const mitchellAt of [13.875, 15, 16.5, 17.875]) {
      const layout = stackLayout(chain, { type: "fixed", height: mitchellAt + headAndCamera });
      const nose = blockOf(layout, "nose");
      assert.equal(nose.shape.type, "sle");
      assert.equal(blockOf(layout, "head").x, nose.x, `Mitchell at ${mitchellAt}`);
      assert.equal(nose.bracket, false);
    }
  });

  test("the nose stays at one horizontal position as the beam lifts it", () => {
    const chain = chainOf();
    const low = stackLayout(chain, { type: "fixed", height: 30 }, { frame: { width: 200, height: 520 } });
    const high = stackLayout(chain, { type: "fixed", height: 60 }, { frame: { width: 200, height: 520 } });
    for (const layout of [low, high]) {
      const dolly = blockOf(layout, "support");
      assert.equal(dolly.shape.type, "dolly");
      assert.equal(dolly.mountX, blockOf(layout, "nose").x, "the nose is where the chain continues");
      assert.equal(dolly.shape.nose.x, blockOf(layout, "nose").mount.x, "drawn at the fitting");
      assert.equal(dolly.shape.nose.y, dolly.box.y, "the nose is at the top of the support");
    }
    // In inches before any squeeze to fit, the nose is at the same place at any lift.
    const unsqueezed = (layout) => blockOf(layout, "support").mountX / layout.frame.squeeze;
    assert.ok(Math.abs(unsqueezed(low) - unsqueezed(high)) < 0.2, "the same x at any lift");
    assert.ok(blockOf(high, "support").shape.nose.y < blockOf(low, "support").shape.nose.y, "higher on the page");
    assert.equal(blockOf(low, "support").shape.pivot.y, blockOf(low, "support").shape.chassis.y, "the beam pivots on the chassis");
  });

  test("wheels are drawn per wheel mode", () => {
    const wheelsOf = (over) => blockOf(stackLayout(chainOf(over), null), "support").shape.wheels;
    assert.equal(wheelsOf({}), "pneumatic");
    assert.equal(wheelsOf({ baseItemIds: ["round-track"], supportMode: "etw" }), "etw");
    assert.equal(wheelsOf({ baseItemIds: ["round-track"], supportMode: "skateboard" }), "skateboard");
    const track = blockOf(stackLayout(chainOf({ baseItemIds: ["round-track"], supportMode: "etw" }), null), "base");
    assert.deepEqual(track.shape, { type: "track", profile: "round" });
  });

  test("a moveable range target: the beam at the bottom and top of the move", () => {
    const chain = chainOf();
    const move = { type: "range", low: 30, high: 45 };
    const layout = stackLayout(chain, move, { frame: { width: 200, height: 520 } });
    const dolly = blockOf(layout, "support");
    const [bottom, top] = dolly.shape.ghosts;
    assert.equal(dolly.shape.ghosts.length, 2);
    assert.deepEqual(bottom, dolly.shape.nose, "rigged at the low end: the move starts where the beam is");
    assert.equal(top.x, bottom.x, "the nose rises straight up");
    assert.ok(Math.abs(bottom.y - top.y - 15 * layout.frame.scale) < 0.2, "15″ higher: the whole move");
    assert.deepEqual(blockOf(stackLayout(chain, { type: "fixed", height: 30 }), "support").shape.ghosts, [], "none for a fixed height");
  });

  test("the LHE is an L-bracket: its foot sets the Mitchell forward of the nose", () => {
    const layout = stackLayout(chainOf({ noseId: "fisher-lhe", noseMode: undefined }), null);
    const nose = blockOf(layout, "nose");
    assert.equal(nose.shape.type, "lhe");
    assert.equal(nose.bracket, true);
    assert.ok(nose.mountX > nose.x, "the foot is forward of the nose");
    assert.equal(blockOf(layout, "head").x, nose.mountX, "the head stands on the foot");
    assert.equal(blockOf(layout, "head").bottom, 3, "the head sits on the LHE's Mitchell, 3″ off the floor");
    const head = blockOf(layout, "head");
    assert.ok(Math.abs(nose.shape.foot.y - (head.box.y + head.box.height)) < 0.05, "the foot is at the Mitchell height");
  });

  test("without the flag, even a fitting that hangs 15″ is drawn as a block on the nose", () => {
    const chain = chainOf({ noseId: "fisher-lhe", noseMode: undefined });
    const unflagged = { ...chain, nose: { ...chain.nose, hangsAsBracket: false } };
    const layout = stackLayout(unflagged, null);
    assert.equal(blockOf(layout, "nose").shape.type, "sle");
    assert.equal(blockOf(layout, "head").x, blockOf(layout, "nose").x);
  });

  test("an underslung head hanging from the bottom of an offset plate on the SLE", () => {
    const chain = chainOf({ baseItemIds: ["round-track"], supportMode: "etw", adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" }, modeName: "underslung", attachName: "base-inverted" });
    const layout = stackLayout(chain, { type: "fixed", height: 30 });
    assert.equal(blockOf(layout, "head").x - blockOf(layout, "nose").x, 10, "the plate's real length");
    assert.equal(layout.lens.height, 30);
    assert.equal(blockOf(layout, "build").inverted, true);
    assert.equal(blockOf(layout, "support").shape.wheels, "etw");
  });
});
