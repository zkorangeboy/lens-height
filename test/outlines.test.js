// The schematic outlines (src/outlines.js): one per kind of gear. Drawing
// code is its own spec (SPEC.md no longer describes shapes); this is a
// smoke test, not a shape-by-shape check.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildChain } from "../src/solver.js";
import { stackLayout } from "../src/stack.js";
import { outlineOf } from "../src/outlines.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(path.join(root, "gear.json"), "utf8"));
const P = { packageId: "test-package", buildId: "a-cam" };
const rig = (over = {}) => ({
  ...P,
  supportId: "baby-sticks",
  headId: "oconnor-2575d",
  // The A-cam block's QR bottom needs a Euro plate on the 2575D's Euro receiver.
  plateIds: ["euro-plate"],
  blockIds: null,
  modeName: "normal",
  attachName: "base",
  ...over,
});
const fisher = (over = {}) => rig({ supportId: "fisher-11", noseId: "fisher-sle", noseMode: "upright", ...over });
const layoutOf = (selection, target = null) => stackLayout(buildChain(seed, selection), target, { frame: { width: 200, height: 520 } });

const RIGS = {
  tripod: rig({ baseItemIds: ["apple-full"], baseModes: { "apple-full": "12in" }, adapterIds: ["mitchell-riser-6"] }),
  hihat: rig({ supportId: "hihat-placeholder" }),
  lohat: rig({ supportId: "lohat-placeholder", adapterIds: ["rotating-offset"] }),
  fisherRound: fisher({ baseItemIds: ["round-track"], supportMode: "etw", adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" }, modeName: "underslung", attachName: "base-inverted" }),
  fisherFloor: fisher(),
  lhe: fisher({ noseId: "fisher-lhe", noseMode: undefined }),
  lambda: rig({ headId: "lambda-50", plateIds: [], modeName: "upright" }),
  lambdaHung: fisher({ headId: "lambda-50", plateIds: [], modeName: "underslung", adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" } }),
  hung24: rig({ adapterIds: ["mitchell-offset-24"], adapterModes: { "mitchell-offset-24": "bottom" }, modeName: "underslung", attachName: "base-inverted" }),
};

describe("every gear kind renders without error", () => {
  test("every kind in the seed has its own outline, and none renders broken markup", () => {
    const kinds = new Set(Object.values(RIGS).flatMap((selection) => layoutOf(selection).blocks.map((b) => b.shape.type)));
    assert.deepEqual([...kinds].sort(), [
      "apple", "camera", "dolly", "fluid-head", "hi-hat", "lambda", "lhe", "lo-hat", "offset", "plate", "riser", "rotating-offset", "sle", "track", "tripod",
    ]);
    for (const selection of Object.values(RIGS)) {
      for (const block of layoutOf(selection).blocks) {
        const svg = outlineOf(block);
        assert.match(svg, /^<(rect|line|circle|polygon|path|g)\b/, block.shape.type);
        assert.doesNotMatch(svg, /NaN|undefined|Infinity/, block.shape.type);
      }
    }
  });
});
