// The camera side (SPEC.md 2, 3.4): typed interfaces, the A-cam camera
// block, plates, inversion, and the camera on the floor.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildChain, enumerateChains } from "../src/solver.js";
import {
  addOptions,
  applyEdit,
  blockOptions,
  defaultPicks,
  cameraRemedies,
  mates,
  missingSlot,
  revalidatePicks,
  slotOptions,
  supportRemoval,
} from "../src/rules.js";
import { stackLayout } from "../src/stack.js";
import { checkVerdict } from "../src/verdict.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(path.join(root, "gear.json"), "utf8"));
const P = ["test-package", "a-cam"];
const byId = (id) => seed.components.find((c) => c.id === id);
const picksFor = (over = {}) => ({
  baseItemIds: [],
  baseModes: [],
  supportId: "baby-sticks",
  supportMode: null,
  noseId: null,
  noseMode: null,
  adapterIds: [],
  adapterModes: {},
  headId: "oconnor-2575d",
  modeName: "normal",
  plateIds: [],
  blockIds: null,
  attachName: "base",
  ...over,
});
const chainOf = (picks) => buildChain(seed, { packageId: P[0], buildId: P[1], ...picks });
const ON_FLOOR = { supportId: null, headId: null, modeName: null };
const A_CAM = ["qr-plate", "arri-dovetail", "base-plate", "camera"];
const lensAboveHead = (chain) => chain.min - (chain.support ? 20 : 0) - chain.mode.rise;

describe("typed interfaces", () => {
  test("male mates female of the same type, either way up; nothing else", () => {
    for (const [male, female] of [["mitchell-male", "mitchell-female"], ["euro-dovetail", "euro-receiver"], ["qr-plate", "qr-receiver"], ["bolt-38", "holes-38"]]) {
      assert.ok(mates(female, male), `${male} in ${female}`);
      assert.ok(mates(male, female), `${female} on ${male}`);
      assert.ok(!mates(male, male) && !mates(female, female), `${male} to ${male}`);
    }
    assert.ok(!mates("euro-receiver", "qr-plate"), "a QR plate doesn't go in a Euro receiver");
    assert.ok(mates("ground", "ground") && mates("round-track", "round-track"), "untyped mounts mate with themselves");
  });

  test("the pieces: 2575D, Lambda 50, Euro plate, QR plate, Arri dovetail, base plate, camera", () => {
    const facts = (id) => {
      const c = byId(id);
      return [c.bottomMount, c.topMount, c.rise ?? c.opticalCenterAboveBase, c.shortName];
    };
    assert.deepEqual(facts("oconnor-2575d").slice(0, 2), ["mitchell-male", "euro-receiver"]);
    assert.equal(byId("oconnor-2575d").modes.find((m) => m.name === "normal").rise, 8.5, "excludes the Euro plate");
    assert.equal(byId("lambda-50").topMount, "qr-receiver", "a QR receiver built into its platform");
    assert.deepEqual(byId("lambda-50").modes.map((m) => [m.name, m.riseRange]), [["upright", { min: 10, max: 18 }], ["underslung", { min: -18, max: -10 }]]);
    assert.deepEqual(facts("euro-plate"), ["euro-dovetail", "qr-receiver", 0.75, "Euro plate"]);
    assert.deepEqual(facts("qr-plate"), ["qr-plate", "bolt-38", 0, "QR"]);
    assert.deepEqual(facts("arri-dovetail"), ["holes-38", "bolt-38", 1, "Arri dovetail"]);
    assert.deepEqual(facts("base-plate"), ["holes-38", "bolt-38", 0.5, "Base plate"]);
    assert.deepEqual([byId("camera").bottomMount, byId("camera").opticalCenterAboveBase, byId("camera").bodyHeight], ["holes-38", 2.5, 5]);
  });

  test("the A-cam block: camera, base plate, Arri dovetail, QR plate — bottom up, as stored", () => {
    const block = seed.builds.find((b) => b.id === "a-cam");
    assert.equal(block.name, "A-cam");
    assert.deepEqual(block.componentIds, A_CAM);
    assert.equal(block.bottomMount, undefined, "its bottom is its QR plate's");
  });
});

describe("the camera block on a head", () => {
  test("a 2575 on sticks with a Euro plate and the A-cam block puts the lens 4¾″ above the head's top", () => {
    const chain = chainOf(picksFor({ plateIds: ["euro-plate"] }));
    assert.equal(lensAboveHead(chain), 4.75);
    const layout = stackLayout(chain, null);
    const head = layout.blocks.find((b) => b.slot === "head");
    assert.equal(layout.lens.height - head.top, 4.75);
  });

  test("the A-cam block goes directly on the lambda", () => {
    const chain = chainOf(picksFor({ headId: "lambda-50", modeName: "upright" }));
    assert.equal(chain.plates.length, 0);
    assert.equal(chain.min - 20 - 10, 4, "QR plate 0 + dovetail 1 + base plate ½ + camera 2½");
  });

  test("the block is rejected directly on the 2575 without a Euro plate", () => {
    assert.throws(() => chainOf(picksFor()), /A-cam's QR Plate needs a QR receiver beneath it, but O'Connor 2575D ends in a Euro receiver/);
    assert.equal(missingSlot(seed, ...P, picksFor()), "attach", "the rig is incomplete, not silently summed");
    const attach = slotOptions(seed, ...P, picksFor()).attach;
    assert.ok(attach.every((a) => !a.available));
    assert.deepEqual(
      cameraRemedies(seed, ...P, picksFor()).map((f) => f.label),
      ["Euro Plate on O'Connor 2575D", "Euro Plate on the bottom of A-cam"],
      "and offers the two fixes"
    );
    for (const fix of cameraRemedies(seed, ...P, picksFor())) {
      assert.equal(missingSlot(seed, ...P, applyEdit(picksFor(), fix.edit)), null, fix.label);
    }
  });

  test("a Euro plate added to the block works the same as one on the head, and comes off on the lambda", () => {
    const inBlock = chainOf(picksFor({ blockIds: ["euro-plate", ...A_CAM] }));
    assert.equal(lensAboveHead(inBlock), 4.75);
    const { picks, notes } = revalidatePicks(seed, ...P, picksFor({ headId: "lambda-50", modeName: "upright", blockIds: ["euro-plate", ...A_CAM] }));
    assert.equal(picks.blockIds, null, "back to the block as defined");
    assert.match(notes[0], /^Removed Euro Plate from A-cam\. .*Lambda 50 ends in a QR receiver/);
    const onHead = revalidatePicks(seed, ...P, picksFor({ headId: "lambda-50", modeName: "upright", plateIds: ["euro-plate"] }));
    assert.deepEqual(onHead.picks.plateIds, []);
    assert.match(onHead.notes[0], /^Removed Euro Plate\. It needs a Euro receiver beneath it, but Lambda 50 ends in a QR receiver\.$/);
  });

  test("the default rig is complete: the Euro plate goes on the 2575", () => {
    const picks = defaultPicks(seed, ...P);
    assert.deepEqual([picks.supportId, picks.headId, picks.plateIds, picks.blockIds], ["baby-sticks", "oconnor-2575d", ["euro-plate"], null]);
    assert.equal(missingSlot(seed, ...P, picks), null);
  });
});

describe("inversion", () => {
  test("a 2575 underslung from an offset's bottom side: the Euro plate and the whole block hang inverted", () => {
    const picks = picksFor({
      adapterIds: ["mitchell-offset-10"],
      adapterModes: { "mitchell-offset-10": "bottom" },
      modeName: "underslung",
      plateIds: ["euro-plate"],
      attachName: "base-inverted",
    });
    const chain = chainOf(picks);
    assert.deepEqual(chain.plates.map((p) => [p.id, p.rise]), [["euro-plate", -0.75]]);
    assert.equal(chain.attach.rise, -4, "the same pieces, rises negated");
    assert.equal(chain.attach.inverted, true);
    // Offset bottom at the top of the sticks, then down: 2575 −8½, plate −¾, block −4.
    assert.equal(chain.min, 20 + 0 - 8.5 - 0.75 - 4);
    const layout = stackLayout(chain, null);
    const block = layout.blocks.at(-1);
    assert.deepEqual(block.tag.lines, ["A-cam", "Camera inverted — flip image"]);
    assert.ok(block.shape.pieces.every((p) => p.box.y + p.box.height <= block.shape.body.y + 0.05), "its plates above the upside-down body");
  });

  test("the top-handle hang is unchanged: the camera upright, its optical center 3″ below the mount", () => {
    const picks = picksFor({
      adapterIds: ["mitchell-offset-10"],
      adapterModes: { "mitchell-offset-10": "bottom" },
      modeName: "underslung",
      plateIds: ["euro-plate"],
      attachName: "top-handle",
    });
    const chain = chainOf(picks);
    assert.equal(chain.attach.rise, -3);
    assert.equal(chain.attach.inverted, false);
    const toggle = slotOptions(seed, ...P, picks).attach.filter((a) => a.available).map((a) => a.name);
    assert.deepEqual(toggle, ["base-inverted", "top-handle"]);
  });
});

describe("the camera on the floor", () => {
  test("the block on the floor by its QR plate: no support, no head", () => {
    const picks = picksFor(ON_FLOOR);
    const chain = chainOf(picks);
    assert.equal(chain.support, null);
    assert.equal(chain.head, null);
    assert.equal(chain.min, 4);
    assert.equal(chain.max, 4);
    assert.equal(missingSlot(seed, ...P, picks), null, "a complete rig");
    assert.equal(checkVerdict(chain, null, null).text, "Reaches 4″ · enter a target");
    const { picks: kept, notes } = revalidatePicks(seed, ...P, picks);
    assert.deepEqual(notes, []);
    assert.equal(kept.attachName, "base");
  });

  test("on two apple boxes with a Euro plate added to the block", () => {
    const picks = picksFor({ ...ON_FLOOR, baseItemIds: ["apple-full", "apple-full"], blockIds: ["euro-plate", ...A_CAM] });
    assert.equal(chainOf(picks).min, 8 + 8 + 0.75 + 4);
    assert.equal(missingSlot(seed, ...P, picks), null);
  });

  test("stripped to the camera and base plate, on the floor", () => {
    const picks = picksFor({ ...ON_FLOOR, blockIds: ["base-plate", "camera"] });
    assert.equal(chainOf(picks).min, 0.5 + 2.5);
    assert.equal(missingSlot(seed, ...P, picks), null);
  });

  test("not on track or spreaders, and not with only a support or only a head", () => {
    assert.throws(() => chainOf(picksFor({ ...ON_FLOOR, baseItemIds: ["round-track"] })), /A-cam's QR Plate needs a QR receiver/);
    assert.equal(missingSlot(seed, ...P, picksFor({ ...ON_FLOOR, baseItemIds: ["rolling-spreaders"] })), "support");
    assert.throws(() => chainOf(picksFor({ supportId: null, plateIds: ["euro-plate"] })), /Incomplete: a head needs a support/);
    assert.throws(() => chainOf(picksFor({ headId: null, modeName: null })), /Incomplete: a support needs a head/);
    assert.equal(missingSlot(seed, ...P, picksFor({ headId: null, modeName: null })), "head");
  });

  test("the drawing: the block sits on the floor, with its plate insertion points there", () => {
    const layout = stackLayout(chainOf(picksFor({ ...ON_FLOOR, baseItemIds: ["apple-half"] })), null);
    assert.deepEqual(layout.blocks.map((b) => b.slot), ["base", "build"]);
    const [box, block] = layout.blocks;
    assert.equal(block.bottom, box.top);
    assert.equal(layout.lens.height, 4 + 4);
    assert.deepEqual(layout.gaps.map((g) => [g.slot, g.index]), [["base", 0], ["base", 1], ["plate", 0]]);
    assert.equal(layout.gaps.find((g) => g.slot === "plate").height, 4, "a plate goes on the apple box");
  });
});

describe("editing the camera side", () => {
  const rig = picksFor({ plateIds: ["euro-plate"] });

  test("the block's sheet lists its pieces and rises, top to bottom", () => {
    const block = blockOptions(seed, ...P, rig);
    assert.equal(block.name, "A-cam");
    assert.deepEqual(block.pieces.map((p) => [p.name, p.rise]), [["Camera", 2.5], ["Base Plate", 0.5], ["Arri Dovetail", 1], ["QR Plate", 0]]);
  });

  test("on a head, stripping is only offered while the block still fits; on the floor, all the way down", () => {
    assert.equal(blockOptions(seed, ...P, rig).strip, null, "without its QR plate the block fits nothing on the Euro plate");
    assert.deepEqual(blockOptions(seed, ...P, rig).add, [], "the Euro plate is already on the head");
    let picks = picksFor(ON_FLOOR);
    for (const expected of [["arri-dovetail", "base-plate", "camera"], ["base-plate", "camera"], ["camera"]]) {
      const { strip } = blockOptions(seed, ...P, picks);
      assert.deepEqual(strip.edit, { op: "block", ids: expected });
      picks = revalidatePicks(seed, ...P, applyEdit(picks, strip.edit)).picks;
    }
    assert.equal(blockOptions(seed, ...P, picks).strip, null, "the camera always stays");
    const { restore } = blockOptions(seed, ...P, picks);
    assert.equal(restore.label, "Put Base Plate back");
    assert.deepEqual(restore.edit.ids, ["base-plate", "camera"]);
  });

  test("a Euro plate can be added to the block's bottom where it still fits", () => {
    const onFloor = blockOptions(seed, ...P, picksFor(ON_FLOOR));
    assert.deepEqual(onFloor.add.map((a) => [a.label, a.edit.ids]), [["Add Euro Plate to the bottom", ["euro-plate", ...A_CAM]]]);
    // And stripped off again: the block is back as defined.
    const withPlate = picksFor({ ...ON_FLOOR, blockIds: ["euro-plate", ...A_CAM] });
    assert.deepEqual(blockOptions(seed, ...P, withPlate).strip, { label: "Remove Euro Plate", edit: { op: "block", ids: A_CAM } });
    const onLambda = blockOptions(seed, ...P, picksFor({ headId: "lambda-50", modeName: "upright" }));
    assert.deepEqual(onLambda.add, [], "the lambda's QR receiver takes no Euro plate");
  });

  test("the Euro plate is an ordinary plate on the head: added at a marker, and removed", () => {
    const fix = cameraRemedies(seed, ...P, picksFor())[0];
    assert.deepEqual(fix.edit, { op: "insert", slot: "plate", index: 0, id: "euro-plate" }, "inserted like any adapter");
    const bare = picksFor({ blockIds: ["euro-plate", ...A_CAM] });
    const plate = addOptions(seed, ...P, bare).find((o) => o.id === "euro-plate");
    assert.equal(plate, undefined, "not while the block already brings its own");
    const withPlate = addOptions(seed, ...P, picksFor({ headId: "lambda-50", modeName: "upright" })).find((o) => o.id === "euro-plate");
    assert.equal(withPlate, undefined, "and never on the lambda");
    const removed = revalidatePicks(seed, ...P, applyEdit(rig, { op: "remove", slot: "plate", index: 0 }));
    assert.equal(missingSlot(seed, ...P, removed.picks), "attach", "without it the block fits nothing");
  });

  test("the support comes off with its head, leaving the block on the floor, and goes back from the Add sheet", () => {
    const removal = supportRemoval(seed, ...P, rig);
    assert.equal(removal.label, "Remove Baby sticks and O'Connor 2575D");
    const { picks } = revalidatePicks(seed, ...P, applyEdit(rig, removal.edit));
    assert.deepEqual([picks.supportId, picks.headId, picks.plateIds], [null, null, ["euro-plate"]]);
    assert.equal(missingSlot(seed, ...P, picks), null);
    assert.equal(chainOf(picks).min, 0.75 + 4, "the Euro plate stays under the block, on the floor");
    const sticks = addOptions(seed, ...P, picks).find((o) => o.id === "standard-sticks");
    assert.deepEqual(sticks.positions, [{ slot: "support", index: 0, mode: null, where: "under the camera" }]);
    const back = revalidatePicks(seed, ...P, applyEdit(picks, { op: "insert", slot: "support", index: 0, id: "standard-sticks" })).picks;
    assert.equal(missingSlot(seed, ...P, back), "head", "then it asks for a head");
    assert.equal(supportRemoval(seed, ...P, picksFor({ ...rig, baseItemIds: ["rolling-spreaders"] })), null, "not onto spreaders");
  });
});

describe("solve mode still finds the camera block's rigs", () => {
  test("the 2575 with a Euro plate, and the lambda without one", () => {
    const chains = enumerateChains(seed, { packageId: P[0], buildId: P[1], maxBaseLayerItems: 0, maxAdapters: 0 }).filter((c) => c.support.id === "baby-sticks");
    const seen = new Set(chains.map((c) => `${c.head.id}+${c.plates.map((p) => p.id).join("") || "none"}`));
    assert.deepEqual([...seen].sort(), ["lambda-50+none", "oconnor-2575d+euro-plate"]);
  });
});
