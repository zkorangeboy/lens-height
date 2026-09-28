// Flips (SPEC.md 6): which way up a piece hangs is one action in
// rules.js, offered only where it leaves a legal rig.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildChain } from "../src/solver.js";
import { flip, flips, insertOptions } from "../src/rules.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(path.join(root, "gear.json"), "utf8"));
const app = readFileSync(path.join(root, "app.js"), "utf8");
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
  modeName: "normal",
  plateIds: ["euro-plate"],
  blockIds: null,
  attachName: "base",
  ...over,
});
const chainOf = (picks) => buildChain(seed, { packageId: P[0], buildId: P[1], ...picks });
const FISHER_SLE = picksFor({ supportId: "fisher-11", noseId: "fisher-sle", noseMode: "upright" });
const ON_OFFSET = picksFor({ adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "top" } });
const NOSE = { slot: "nose", index: 0 };
const HEAD = { slot: "head", index: 0 };
const orientation = (picks) => [picks.noseMode, picks.adapterModes["mitchell-offset-10"] ?? null, picks.modeName, picks.attachName];

describe("the SLE flips", () => {
  test("upright → upside down takes the head underslung and inverts the camera block, and back", () => {
    const down = flip(seed, ...P, FISHER_SLE, NOSE);
    assert.deepEqual(orientation(down), ["underslung", null, "underslung", "base-inverted"]);
    assert.equal(chainOf(down).attach.inverted, true, "the whole block hangs inverted");
    const up = flip(seed, ...P, down, NOSE);
    assert.deepEqual(orientation(up), ["upright", null, "normal", "base"]);
  });

  test("from its reversed position, too; the lambda goes underslung with it, the camera staying upright", () => {
    assert.equal(flip(seed, ...P, { ...FISHER_SLE, noseMode: "reversed" }, NOSE).noseMode, "underslung");
    const lambda = { ...FISHER_SLE, headId: "lambda-50", modeName: "upright", plateIds: [] };
    assert.deepEqual(orientation(flip(seed, ...P, lambda, NOSE)), ["underslung", null, "underslung", "base"]);
  });

  test("offered only when the flipped rig is legal", () => {
    assert.deepEqual(flips(seed, ...P, FISHER_SLE), [NOSE], "the SLE, and nothing else, on a plain Fisher rig");
  });

  test("a 6″ riser under the SLE flipped upside down lowers an underslung 2575 by 6″ (SPEC.md 3.6)", () => {
    const riser = { ...FISHER_SLE, adapterIds: ["mitchell-riser-6"] };
    assert.deepEqual(flips(seed, ...P, riser), [NOSE]);
    const down = flip(seed, ...P, riser, NOSE);
    assert.deepEqual(orientation(down), ["underslung", null, "underslung", "base-inverted"]);
    const chain = chainOf(down);
    const [flippedRiser] = chain.adapters;
    assert.equal(flippedRiser.rise, -6, "the 6″ riser hangs, its rise negated");
    assert.equal(flippedRiser.mountFacing, "down");
    const withoutRiser = chainOf(flip(seed, ...P, FISHER_SLE, NOSE));
    assert.equal(chain.max, withoutRiser.max - 6, "6″ lower at the top of the reach");
  });
});

describe("a head on an offset plate flips to the other side", () => {
  test("top → bottom side, the camera following; and back", () => {
    const bottom = flip(seed, ...P, ON_OFFSET, HEAD);
    assert.deepEqual(orientation(bottom), [null, "bottom", "underslung", "base-inverted"]);
    const top = flip(seed, ...P, bottom, HEAD);
    assert.deepEqual(orientation(top), [null, "top", "normal", "base"]);
    assert.deepEqual(flips(seed, ...P, ON_OFFSET), [HEAD]);
    assert.deepEqual(flips(seed, ...P, bottom), [HEAD]);
  });

  test("the lambda on an offset plate flips the same way", () => {
    const lambda = { ...ON_OFFSET, headId: "lambda-50", modeName: "upright", plateIds: [] };
    assert.deepEqual(orientation(flip(seed, ...P, lambda, HEAD)), [null, "bottom", "underslung", "base"]);
  });

  test("on a Fisher with an offset on the SLE, both flip: the offset follows the SLE down, hanging from its top face instead (SPEC.md 3.6)", () => {
    const both = { ...FISHER_SLE, adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "top" } };
    assert.deepEqual(flips(seed, ...P, both), [NOSE, HEAD]);
    const down = flip(seed, ...P, both, NOSE);
    assert.deepEqual(orientation(down), ["underslung", "top", "underslung", "base-inverted"]);
    const [offset] = chainOf(down).adapters;
    assert.equal(offset.rise, -1, "the offset's top face, 1″ lower, now hanging");
    assert.equal(offset.mountFacing, "down");
  });
});

describe("no flip, add, or swap that leaves the rig under the floor at every lift", () => {
  test("a low hat's head can't flip to hang under an offset: it would be under the floor", () => {
    const lohat = picksFor({ supportId: "lohat-placeholder", adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "top" } });
    assert.equal(flip(seed, ...P, lohat, HEAD), null);
    assert.deepEqual(flips(seed, ...P, lohat), []);
    const bottomSide = insertOptions(seed, ...P, picksFor({ supportId: "lohat-placeholder" }))
      .find((g) => g.slot === "adapter" && g.index === 0)
      .options.find((o) => o.id === "mitchell-offset-10" && o.mode === "bottom");
    assert.equal(bottomSide.available, false);
    assert.equal(bottomSide.reason, "Below the floor");
  });
});

describe("no flip button where there's nothing to flip", () => {
  test("never on an offset plate: it's symmetrical, and flipping its head is what moves it", () => {
    assert.equal(flip(seed, ...P, ON_OFFSET, { slot: "adapter", index: 0 }), null);
    assert.ok(flips(seed, ...P, ON_OFFSET).every((p) => p.slot !== "adapter"));
  });

  test("not on a head sitting directly on sticks, or on a riser", () => {
    assert.deepEqual(flips(seed, ...P, picksFor()), []);
    assert.equal(flip(seed, ...P, picksFor(), HEAD), null);
    assert.deepEqual(flips(seed, ...P, picksFor({ adapterIds: ["mitchell-riser-6"] })), []);
  });

  test("not with no head at all: the camera on the floor", () => {
    assert.deepEqual(flips(seed, ...P, picksFor({ supportId: null, headId: null, modeName: null })), []);
  });
});

describe("the button", () => {
  test("the UI only asks which pieces can flip and applies the flip: no toggles, no message", () => {
    assert.match(app, /flips\(gear/);
    assert.match(app, /flip\(gear/);
    assert.match(app, /flipButtonSvg\(/);
    assert.doesNotMatch(app, /data-toggle|toggleHtml|role="switch"/, "no toggles in the sheets");
    assert.doesNotMatch(app, /Camera mount/, "the camera's mount isn't a sheet choice");
  });
});
