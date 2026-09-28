// The J.L. Fisher Model 11 (docs/fisher-11.md): the brochure checks, wheel
// modes and track, nose fittings, and how they're drawn. SPEC.md 3.1, 3.2,
// 3.7, 5.2, 5.8.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildChain, enumerateChains, evaluateChain } from "../src/solver.js";
import { checkVerdict } from "../src/verdict.js";
import { inches } from "../src/format.js";
import { riseRangeOf, supportInterval } from "../src/model.js";
import { missingSlot, modeControl, revalidatePicks, slotOptions, supportVariants } from "../src/rules.js";
import { stackLayout } from "../src/stack.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(path.join(root, "gear.json"), "utf8"));
const P = ["test-package", "a-cam"];
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
  headId: "oconnor-2575d",
  // The A-cam block's QR plate needs a Euro plate on the 2575D's Euro receiver.
  plateIds: ["euro-plate"],
  blockIds: null,
  modeName: "normal",
  attachName: "base",
  ...over,
});
const chainOf = (over) => buildChain(seed, fisher(over));

/** The Mitchell's height above the floor: the brochure's figure, which is
 * the chain's interval without the head, plates, and camera block on top. */
const aboveMitchell = (chain) => chain.mode.rise + chain.plates.reduce((sum, p) => sum + p.rise, 0) + chain.attach.rise;
const mitchell = (chain) => ({
  min: chain.min - aboveMitchell(chain),
  max: chain.max - aboveMitchell(chain),
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

  test("ETW and skateboard wheels are rejected on the floor", () => {
    for (const supportMode of ["etw", "skateboard"]) {
      assert.throws(() => chainOf({ supportMode }), /doesn't sit on "ground"/, `${supportMode} on the floor`);
      assert.doesNotThrow(() => chainOf({ supportMode, baseItemIds: ["round-track"] }), `${supportMode} on round track`);
    }
  });

  test("pneumatic tires sit on the floor only, never on round track; there is no square track", () => {
    assert.doesNotThrow(() => chainOf());
    assert.ok(!seed.components.some((c) => c.id === "square-track" || c.topMount === "square-track"), "square track is gone");
    const fisher11 = seed.components.find((c) => c.id === "fisher-11");
    assert.equal(fisher11.modes.find((m) => m.name === "pneumatic").bottomMount, "ground");
    assert.throws(() => chainOf({ baseItemIds: ["round-track"] }), /doesn't sit on "round-track"/);
  });

  test("totals against the floor: round + ETW +1.5″, round + skateboard +4″", () => {
    assert.equal(chainOf({ baseItemIds: ["round-track"], supportMode: "etw" }).min - floorMin, 1.5);
    assert.equal(chainOf({ baseItemIds: ["round-track"], supportMode: "skateboard" }).min - floorMin, 4);
  });

  test("the rules offer only the wheel sets that ride what's beneath", () => {
    const wheels = (baseItemIds) => {
      const entry = slotOptions(seed, ...P, { ...fisher({ baseItemIds }) }).support.find((o) => o.id === "fisher-11");
      return entry.modes.filter((m) => m.available).map((m) => m.name);
    };
    assert.deepEqual(wheels([]), ["pneumatic"]);
    assert.deepEqual(wheels(["round-track"]), ["etw", "skateboard"]);
    const control = modeControl(slotOptions(seed, ...P, fisher({ baseItemIds: ["round-track"], supportMode: "etw" })).support.find((o) => o.id === "fisher-11").modes);
    assert.equal(control.type, "dropdown", "two wheel sets, neither flipped: a segmented choice");
  });

  test("a tripod can't stand on track", () => {
    const tripod = { supportId: "baby-sticks", supportMode: undefined, noseId: null, noseMode: undefined };
    for (const track of ["round-track"]) {
      assert.throws(() => chainOf({ ...tripod, baseItemIds: [track] }), /doesn't sit on/);
    }
  });

  test("the solver tries every wheel set, each only where it can ride", () => {
    const chains = enumerateChains(seed, { packageId: P[0], buildId: P[1], maxBaseLayerItems: 1, maxAdapters: 0 }).filter(
      (c) => c.support.id === "fisher-11"
    );
    const seen = new Set(chains.map((c) => `${c.support.mode}@${c.baseItems.map((b) => b.id).join("+") || "floor"}`));
    assert.deepEqual([...seen].sort(), ["etw@round-track", "pneumatic@floor", "skateboard@round-track"]);
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
      () => chainOf({ supportId: "baby-sticks", supportMode: undefined }),
      /nose fitting "Standard Level Head" doesn't mount to support "Baby sticks"/
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
      assert.deepEqual([nose.category, nose.bottomMount, nose.topMount, nose.requiresFamily], ["nose", "fisher-nose", "mitchell-female", "fisher"]);
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
// Nothing below the floor (SPEC.md 5.2)
// ---------------------------------------------------------------------------

describe("nothing below the floor", () => {
  // The SLE upside down, the 2575 underslung from it, the A-cam inverted under a Euro plate.
  const HANGING = { noseMode: "underslung", modeName: "underslung", attachName: "base-inverted" };
  const lowestAt = (chain, height) => stackLayout(chain, { type: "fixed", height }).lowest;

  test("the upside-down SLE with an underslung 2575 and the inverted A-cam can't reach below the floor at the bottom of the lift", () => {
    const chain = chainOf(HANGING);
    // Fully retracted, the lens would be at −3⅜″ and the camera's body 5⅞″ under the floor.
    assert.equal(chain.retracted, 17.875 - 8 - 8.5 - 0.75 - 4);
    assert.equal(chain.min, 2.5, "the lowest lens height with the camera's body on the floor: half its 5″");
    assert.equal(lowestAt(chain, chain.min), 0, "at the bottom of its reach, the lowest piece just touches the floor");
    for (const h of [chain.min, 10, 20, chain.max]) assert.ok(lowestAt(chain, h) >= 0, `nothing under the floor at ${h}″`);
  });

  test("the limited range is what the rail, the verdict, and the check use", () => {
    const chain = chainOf(HANGING);
    const layout = stackLayout(chain, null);
    assert.equal(layout.reach.min, 2.5);
    assert.equal(checkVerdict(chain, null, null).text, `Reaches 2½–${inches(chain.max).replace("″", "")}″ · enter a target`);
    assert.equal(evaluateChain(chain, { type: "fixed", height: 1 }).feasible, false, "no lower than the floor allows");
    assert.equal(checkVerdict(chain, { type: "fixed", height: 1 }, evaluateChain(chain, { type: "fixed", height: 1 })).text, "1½″ too tall");
    // The beam's travel is cut to match: the move can't start below the limit.
    assert.equal(chain.moveableInterval.min, 2.5);
    assert.ok(chain.moveableInterval.max - chain.moveableInterval.min < 33.375);
  });

  test("a rig that clears the floor anyway is untouched", () => {
    const chain = chainOf({});
    assert.equal(chain.min, chain.retracted);
    assert.deepEqual(mitchell(chain), { min: 13.875, max: 51.25 });
  });

  test("a rig under the floor at every lift reaches nothing, says how far under, and is dropped from enumeration", () => {
    const lohat = buildChain(seed, {
      packageId: P[0], buildId: P[1], baseItemIds: [], supportId: "lohat-placeholder", headId: "oconnor-2575d",
      adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" }, modeName: "underslung",
      plateIds: ["euro-plate"], attachName: "base-inverted",
    });
    assert.ok(lohat.belowFloor > 0);
    const target = { type: "fixed", height: lohat.max };
    assert.equal(evaluateChain(lohat, target).feasible, false);
    assert.match(checkVerdict(lohat, target, evaluateChain(lohat, target)).text, /below the floor$/);
    const chains = enumerateChains(seed, { packageId: P[0], buildId: P[1], maxBaseLayerItems: 0, maxAdapters: 1 });
    assert.ok(chains.every((c) => !c.belowFloor));
  });
});
