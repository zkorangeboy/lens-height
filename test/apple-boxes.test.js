// Apple boxes: the pancake, and any number of the same box (SPEC.md 3.1).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildChain } from "../src/solver.js";
import { addOptions, applyEdit, revalidatePicks } from "../src/rules.js";
import { stackLayout } from "../src/stack.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(path.join(root, "gear.json"), "utf8"));
const P = ["test-package", "a-cam"];
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
  // The A-cam block's QR plate needs a Euro plate on the 2575D's Euro receiver.
  plateIds: ["euro-plate"],
  blockIds: null,
  modeName: "normal",
  attachName: "base",
  ...over,
});
const chainOf = (picks) => buildChain(seed, { packageId: P[0], buildId: P[1], ...picks });

describe("the pancake", () => {
  test("an apple box that rises 1″, flat only", () => {
    const pancake = seed.components.find((c) => c.id === "apple-pancake");
    assert.equal(pancake.kind, "apple-box");
    assert.equal(pancake.boxSize, "pancake");
    assert.equal(pancake.rise, 1);
    assert.equal(pancake.orientation, "flat");
    assert.equal(pancake.modes, undefined, "no faces to stand on");
    assert.equal(pancake.shortName, "Pancake");
    assert.equal(chainOf(picksFor({ baseItemIds: ["apple-pancake"] })).min - chainOf(picksFor()).min, 1);
  });
});

describe("apple boxes are unlimited", () => {
  test("the same box any number of times, each adding its rise", () => {
    const three = chainOf(picksFor({ baseItemIds: ["apple-pancake", "apple-pancake", "apple-pancake"] }));
    assert.equal(three.min - chainOf(picksFor()).min, 3);
    assert.equal(three.baseItems.length, 3);
  });

  test("two full apples on different faces: modes go by position", () => {
    const picks = picksFor({ baseItemIds: ["apple-full", "apple-full"], baseModes: ["20in", "flat"] });
    const chain = chainOf(picks);
    assert.deepEqual(chain.baseItems.map((b) => b.mode), ["20in", "flat"]);
    assert.equal(chain.min - chainOf(picksFor()).min, 28);
    const { picks: kept, notes } = revalidatePicks(seed, ...P, picks);
    assert.deepEqual(notes, []);
    assert.deepEqual([kept.baseItemIds, kept.baseModes], [["apple-full", "apple-full"], ["20in", "flat"]]);
  });

  test("edits act on one box by position, not on every copy", () => {
    let picks = picksFor({ baseItemIds: ["apple-full"], baseModes: ["flat"] });
    picks = applyEdit(picks, { op: "insert", slot: "base", index: 1, id: "apple-full", mode: "flat" });
    picks = applyEdit(picks, { op: "mode", slot: "base", index: 1, mode: "12in" });
    assert.deepEqual(picks.baseModes, ["flat", "12in"], "only the second box turned");
    picks = applyEdit(picks, { op: "remove", slot: "base", index: 0 });
    assert.deepEqual([picks.baseItemIds, picks.baseModes], [["apple-full"], ["12in"]], "the one left keeps its face");
  });

  test("the Add sheet offers a box already in the rig, at every position it fits", () => {
    const options = addOptions(seed, ...P, picksFor({ baseItemIds: ["apple-half", "apple-half"] }));
    const half = options.find((o) => o.id === "apple-half");
    assert.deepEqual(half.positions.map((p) => p.where), ["on the floor", "on Half Apple Box", "on Half Apple Box"]);
  });

  test("each copy is its own piece in the drawing", () => {
    const layout = stackLayout(chainOf(picksFor({ baseItemIds: ["apple-half", "apple-half"] })), null);
    const boxes = layout.blocks.filter((b) => b.slot === "base");
    assert.deepEqual(boxes.map((b) => [b.index, b.bottom, b.top]), [[0, 0, 4], [1, 4, 8]]);
  });

  test("anything else is still one of each", () => {
    assert.throws(() => chainOf(picksFor({ baseItemIds: ["rolling-spreaders", "rolling-spreaders"] })), /only apple boxes repeat/);
    assert.throws(() => chainOf(picksFor({ adapterIds: ["mitchell-riser-6", "mitchell-riser-6"] })), /same adapter can't be used twice/);
    const { picks } = revalidatePicks(seed, ...P, picksFor({ baseItemIds: ["rolling-spreaders", "rolling-spreaders"] }));
    assert.deepEqual(picks.baseItemIds, ["rolling-spreaders"]);
  });
});
