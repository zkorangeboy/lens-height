// Flips on the drawing (SPEC.md 5.9, 7.2): which way up a piece hangs is one
// action in rules.js, offered only where it leaves a legal rig.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildChain } from "../src/solver.js";
import { flip, flips } from "../src/rules.js";
import { stackLayout } from "../src/stack.js";
import { flipButtonSvg } from "../src/outlines.js";

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

  test("offered only when the flipped rig is legal: not with a riser that would end up hanging", () => {
    assert.deepEqual(flips(seed, ...P, FISHER_SLE), [NOSE], "the SLE, and nothing else, on a plain Fisher rig");
    const riser = { ...FISHER_SLE, adapterIds: ["mitchell-riser-6"] };
    assert.equal(flip(seed, ...P, riser, NOSE), null);
    assert.deepEqual(flips(seed, ...P, riser), []);
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

  test("on a Fisher with an offset on the SLE, only the head flips: the SLE upside down would hang the offset", () => {
    const both = { ...FISHER_SLE, adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "top" } };
    assert.deepEqual(flips(seed, ...P, both), [HEAD]);
    assert.equal(flip(seed, ...P, both, NOSE), null);
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
  test("every piece has a flip point beside it, inside the drawing, clear by the 22px hit radius", () => {
    const layout = stackLayout(chainOf(ON_OFFSET), null, { frame: { width: 320, height: 520 } });
    for (const b of layout.blocks) {
      assert.ok(b.flipAt.x >= 22 && b.flipAt.x <= 320 - 22, `${b.slot} across`);
      assert.ok(b.flipAt.y >= 22 && b.flipAt.y <= layout.frame.height - 22, `${b.slot} up`);
    }
    const head = layout.blocks.find((b) => b.slot === "head");
    const beside = head.flipAt.x >= head.box.x + head.box.width || head.flipAt.x <= head.box.x;
    assert.ok(beside, "beside the head, not on it");
  });

  test("a circular-arrows icon with a 44px hit area", () => {
    const svg = flipButtonSvg({ x: 50, y: 80 }, 'data-flip="{}"');
    assert.match(svg, /<circle cx="50" cy="80" r="22" class="flip-hit"\/>/);
    assert.match(svg, /class="flip-arrows"/);
    assert.equal((svg.match(/ A 6 6 /g) || []).length, 2, "two arcs");
    assert.match(svg, /data-flip=/);
  });

  test("the UI only asks which pieces can flip and applies the flip: no toggles, no message", () => {
    assert.match(app, /flips\(gear/);
    assert.match(app, /flip\(gear/);
    assert.match(app, /flipButtonSvg\(/);
    assert.doesNotMatch(app, /data-toggle|toggleHtml|role="switch"/, "no toggles in the sheets");
    assert.doesNotMatch(app, /Camera mount/, "the camera's mount isn't a sheet choice");
  });
});
