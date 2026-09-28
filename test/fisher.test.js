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
      /nose fitting "SLE — 4-way Level Head" doesn't mount to support "Baby sticks"/
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
// How it's drawn (SPEC.md 5.8)
// ---------------------------------------------------------------------------

describe("drawing a Fisher", () => {
  const blockOf = (layout, slot) => layout.blocks.find((b) => b.slot === slot);

  test("the SLE upright is an adjustable block with its range, set before the beam moves", () => {
    const chain = chainOf();
    const headAndCamera = aboveMitchell(chain);
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

  test("the SLE's head stands on its Mitchell, forward of the nose, anywhere in its adjustment", () => {
    const chain = chainOf();
    const headAndCamera = aboveMitchell(chain);
    for (const mitchellAt of [13.875, 15, 16.5, 17.875]) {
      const layout = stackLayout(chain, { type: "fixed", height: mitchellAt + headAndCamera });
      const nose = blockOf(layout, "nose");
      assert.equal(nose.shape.type, "sle");
      assert.equal(blockOf(layout, "head").x, nose.mountX, `Mitchell at ${mitchellAt}`);
      assert.ok(nose.mountX > nose.x, "forward of the nose");
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
      const clamp = blockOf(layout, "nose").shape.clamp;
      assert.ok(Math.abs(clamp.x - (dolly.shape.nose.x + dolly.shape.noseRadius)) < 0.1, "the fitting's clamp on the nose's front face");
      assert.ok(Math.abs(dolly.shape.nose.y - dolly.mount.y - 6 * layout.frame.scale) < 0.1, "the round nose 6″ below the modeled nose height");
    }
    assert.equal(blockOf(low, "support").mountX, blockOf(high, "support").mountX, "the same x, in inches, at any lift");
    assert.ok(blockOf(high, "support").shape.nose.y < blockOf(low, "support").shape.nose.y, "higher on the page");
    assert.equal(blockOf(low, "support").shape.pivot.y, blockOf(low, "support").shape.chassis.y, "the beam pivots on the chassis");
  });

  test("wheels are drawn per wheel mode", () => {
    const wheelsOf = (over) => blockOf(stackLayout(chainOf(over), null), "support").shape.wheels;
    assert.equal(wheelsOf({}), "pneumatic");
    assert.equal(wheelsOf({ baseItemIds: ["round-track"], supportMode: "etw" }), "etw");
    assert.equal(wheelsOf({ baseItemIds: ["round-track"], supportMode: "skateboard" }), "skateboard");
    const track = blockOf(stackLayout(chainOf({ baseItemIds: ["round-track"], supportMode: "etw" }), null), "base");
    assert.deepEqual(track.shape, { type: "track" });
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

  test("without the flag, even a fitting that hangs 15″ is drawn as an SLE off the nose", () => {
    const chain = chainOf({ noseId: "fisher-lhe", noseMode: undefined });
    const unflagged = { ...chain, nose: { ...chain.nose, hangsAsBracket: false } };
    const layout = stackLayout(unflagged, null);
    assert.equal(blockOf(layout, "nose").shape.type, "sle");
    assert.equal(blockOf(layout, "head").x, blockOf(layout, "nose").mountX);
  });

  test("an underslung head hanging from the bottom of an offset plate on the SLE", () => {
    const chain = chainOf({ baseItemIds: ["round-track"], supportMode: "etw", adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" }, modeName: "underslung", attachName: "base-inverted" });
    const layout = stackLayout(chain, { type: "fixed", height: 30 });
    assert.equal(blockOf(layout, "head").x - blockOf(layout, "nose").mountX, 10, "the plate's real length");
    assert.equal(layout.lens.height, 30);
    assert.equal(blockOf(layout, "build").inverted, true);
    assert.equal(blockOf(layout, "support").shape.wheels, "etw");
  });
});

// ---------------------------------------------------------------------------
// The nose fittings, from the brochure (SPEC.md 5.8): off the nose's front
// face, at the brochure's overall lengths from the rear
// ---------------------------------------------------------------------------

describe("nose fittings, from the brochure", () => {
  const blockOf = (layout, slot) => layout.blocks.find((b) => b.slot === slot);
  const FRAME = { frame: { width: 320, height: 520 } };
  const layoutOf = (over, target = null) => stackLayout(chainOf(over), target, FRAME);
  /** Inches from the rear of the dolly to a pixel x. */
  const fromRear = (layout, x) => (x - blockOf(layout, "support").shape.chassis.x) / layout.frame.scale;
  const close = (a, b, eps = 0.1) => Math.abs(a - b) <= eps;
  const right = (box) => box.x + box.width;
  const POSITIONS = {
    normal: {},
    reversed: { noseMode: "reversed" },
    "upside down": { noseMode: "underslung", modeName: "underslung", attachName: "base-inverted" },
    LHE: { noseId: "fisher-lhe", noseMode: undefined },
  };

  test("SLE normal: the Mitchell forward of the nose, the diamond plate's front at 45″", () => {
    const layout = layoutOf({});
    const { diamond, cage, clamp } = blockOf(layout, "nose").shape;
    assert.ok(close(fromRear(layout, right(diamond)), 45), `${fromRear(layout, right(diamond))}″`);
    assert.ok(diamond.y < cage.y && cage.y < clamp.y + clamp.height, "diamond plate on the cage, the cage on the clamp");
    assert.ok(blockOf(layout, "nose").mount.x > clamp.x + clamp.width / 2, "the Mitchell forward of the clamp");
  });

  test("SLE reversed: the head turned back over the nose, the clamp front-most at 40″", () => {
    const layout = layoutOf(POSITIONS.reversed);
    const nose = blockOf(layout, "nose");
    const { clamp, diamond } = nose.shape;
    assert.equal(nose.shape.position, "reversed");
    assert.ok(close(fromRear(layout, right(clamp)), 40), `${fromRear(layout, right(clamp))}″`);
    assert.ok(right(diamond) <= right(clamp), "nothing forward of the clamp");
    assert.ok(nose.mount.x < clamp.x, "the Mitchell back over the nose");
  });

  test("SLE upside down: the same shape inverted, the Mitchell facing down", () => {
    const layout = layoutOf(POSITIONS["upside down"]);
    const nose = blockOf(layout, "nose");
    const { diamond, cage } = nose.shape;
    assert.equal(nose.shape.position, "upside-down");
    assert.ok(diamond.y > cage.y, "the diamond plate at the bottom");
    assert.ok(close(fromRear(layout, right(diamond)), 45), "forward, as in its normal position");
    assert.ok(blockOf(layout, "head").top <= nose.top + 0.001, "the head hangs from it");
  });

  test("LHE: a bent arm forward and down to a flat ring, its front at 51¾″, the Mitchell 3″ off the floor", () => {
    const layout = layoutOf(POSITIONS.LHE);
    const nose = blockOf(layout, "nose");
    const { ring, arm, clamp } = nose.shape;
    assert.equal(nose.shape.type, "lhe");
    assert.ok(close(fromRear(layout, right(ring)), 51.75), `${fromRear(layout, right(ring))}″`);
    assert.ok(fromRear(layout, right(ring)) - 40 > 11, "about 12″ past the chassis's front");
    assert.ok(arm[2].x > arm[1].x && arm[2].y > arm[1].y, "bent forward and down");
    assert.ok(arm[0].y >= clamp.y, "from the clamp");
    const head = blockOf(layout, "head");
    assert.equal(head.bottom, 3);
    assert.ok(Math.abs(ring.y - (head.box.y + head.box.height)) < 0.05, "the head stands on the ring");
  });

  test("off the nose's front face in every position, and nothing from the head up overlaps the beam", () => {
    for (const [name, over] of Object.entries(POSITIONS)) {
      for (const height of [null, { type: "fixed", height: 45 }]) {
        const layout = layoutOf(over, height);
        const dolly = blockOf(layout, "support").shape;
        const nose = blockOf(layout, "nose").shape;
        assert.ok(nose.clamp.x >= dolly.nose.x + dolly.noseRadius - 0.1, `${name}: the clamp on the front face`);
        // The beam, sampled along its length, a band as thick as the beam.
        const samples = Array.from({ length: 60 }, (_, i) => ({
          x: dolly.pivot.x + ((dolly.nose.x - dolly.pivot.x) * i) / 59,
          y: dolly.pivot.y + ((dolly.nose.y - dolly.pivot.y) * i) / 59,
        }));
        for (const b of layout.blocks.filter((x) => ["head", "plate", "build"].includes(x.slot))) {
          const inside = samples.some((p) => p.x > b.box.x && p.x < right(b.box) && p.y + dolly.beam / 2 > b.box.y && p.y - dolly.beam / 2 < b.box.y + b.box.height);
          assert.ok(!inside, `${name}, ${height ? "raised" : "down"}: the ${b.slot} clears the beam`);
        }
      }
    }
  });

  test("horizontal positions are visual: every height is as modeled", () => {
    const layout = layoutOf({});
    assert.equal(blockOf(layout, "nose").top, blockOf(layout, "support").top, "the Mitchell at the SLE's rise over the nose height");
    assert.deepEqual(mitchell(chainOf({})), { min: 13.875, max: 51.25 });
  });
});

// ---------------------------------------------------------------------------
// Nothing below the floor (SPEC.md 5.8)
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

  test("a rig under the floor at every lift reaches nothing, says how far under, and isn't a solve-mode candidate", () => {
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
