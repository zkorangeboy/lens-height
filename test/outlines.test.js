// The schematic outlines (SPEC.md 7.2): one per kind of gear, drawn inside
// the pixel boxes stackLayout hands them, with the adjustability fills inside,
// and the tap targets and markers the Add flow uses.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildChain } from "../src/solver.js";
import { stackLayout } from "../src/stack.js";
import { hitArea, hitLayer, markerSvg, outlineOf, pieceSvg } from "../src/outlines.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(path.join(root, "gear.json"), "utf8"));
const P = { packageId: "test-package", buildId: "build-placeholder" };
const rig = (over = {}) => ({
  ...P,
  supportId: "tripod-baby-placeholder",
  headId: "head-standard-placeholder",
  modeName: "normal",
  attachName: "base",
  ...over,
});
const fisher = (over = {}) => rig({ supportId: "fisher-11", noseId: "fisher-sle", noseMode: "upright", ...over });
const layoutOf = (selection, target = null) => stackLayout(buildChain(seed, selection), target, { frame: { width: 200, height: 520 } });
const svgOf = (selection, target) => layoutOf(selection, target).blocks.map((b) => [b.shape.type, outlineOf(b)]);

const RIGS = {
  tripod: rig({ baseItemIds: ["apple-full"], baseModes: { "apple-full": "12in" }, adapterIds: ["mitchell-riser-6"] }),
  hihat: rig({ supportId: "hihat-placeholder" }),
  lohat: rig({ supportId: "lohat-placeholder", adapterIds: ["rotating-offset"] }),
  fisherRound: fisher({ baseItemIds: ["round-track"], supportMode: "etw", adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" }, modeName: "underslung", attachName: "base-inverted" }),
  fisherSquare: fisher({ baseItemIds: ["square-track"] }),
  lhe: fisher({ noseId: "fisher-lhe", noseMode: undefined }),
  lambda: rig({ headId: "head-lambda-placeholder", modeName: "underslung" }),
  handle: rig({ adapterIds: ["mitchell-offset-24"], adapterModes: { "mitchell-offset-24": "bottom" }, modeName: "underslung", attachName: "top-handle" }),
};

describe("one outline per kind of gear", () => {
  test("every kind in the seed has its own outline", () => {
    const kinds = new Set(Object.values(RIGS).flatMap((selection) => layoutOf(selection).blocks.map((b) => b.shape.type)));
    assert.deepEqual([...kinds].sort(), [
      "apple", "camera", "dolly", "fluid-head", "hi-hat", "lambda", "lhe", "lo-hat", "offset", "riser", "sle", "swivel", "track", "tripod",
    ]);
    for (const selection of Object.values(RIGS)) {
      for (const [type, svg] of svgOf(selection)) {
        assert.match(svg, /^<(rect|line|circle|polygon|path|g)\b/, type);
        assert.doesNotMatch(svg, /NaN|undefined|Infinity/, type);
      }
    }
  });

  test("the adjustability fills sit inside the outlines", () => {
    const [tripod] = svgOf(rig());
    assert.match(tripod[1], /leg k-adjustable/, "tripod legs are adjustable");
    const fisherSvg = Object.fromEntries(svgOf(fisher()));
    assert.match(fisherSvg.dolly, /beam k-moveable/, "the Fisher's beam is moveable");
    assert.match(fisherSvg.dolly, /o k-fixed/, "its chassis is fixed");
    assert.match(fisherSvg.sle, /k-adjustable/, "the SLE upright is adjustable");
    assert.match(Object.fromEntries(svgOf(fisher({ noseMode: "reversed" }))).sle, /k-fixed/, "reversed, it's fixed");
  });

  test("tripod legs splay to the box's width, which grows with the set height", () => {
    const low = layoutOf(rig(), { type: "fixed", height: 26 }).blocks[0];
    const high = layoutOf(rig(), { type: "fixed", height: 38 }).blocks[0];
    assert.ok(high.box.height > low.box.height);
    assert.ok(high.box.width >= low.box.width * 0.99, "legs spread at least as wide when set higher");
    assert.equal((outlineOf(low).match(/class="leg /g) || []).length, 3, "three legs");
  });

  test("wheels are drawn per wheel mode", () => {
    const dollySvg = (selection) => Object.fromEntries(svgOf(selection)).dolly;
    assert.match(dollySvg(fisher()), /class="o tire"/);
    assert.match(dollySvg(fisher({ baseItemIds: ["round-track"], supportMode: "etw" })), /class="o track-wheel"/);
    assert.match(dollySvg(fisher({ baseItemIds: ["round-track"], supportMode: "skateboard" })), /class="o skate-wheel"/);
  });

  test("the beam is drawn from the pivot to the nose; a moveable range adds faint beams at both ends", () => {
    const fixed = Object.fromEntries(svgOf(fisher(), { type: "fixed", height: 40 })).dolly;
    assert.equal((fixed.match(/class="beam-ghost"/g) || []).length, 0);
    const move = Object.fromEntries(svgOf(fisher(), { type: "range", low: 30, high: 50 })).dolly;
    assert.equal((move.match(/class="beam-ghost"/g) || []).length, 2);
    assert.equal((move.match(/class="beam k-moveable"/g) || []).length, 1);
  });

  test("the offset plate marks the side in use", () => {
    const off = Object.fromEntries(svgOf(RIGS.fisherRound)).offset;
    assert.match(off, /mitchell in-use/);
    assert.match(off, /mitchell spare/);
  });

  test("the camera: body, lens, and the lens dot at the optical center; upside down when inverted", () => {
    const upright = layoutOf(rig()).blocks.at(-1);
    const inverted = layoutOf(RIGS.fisherRound).blocks.at(-1);
    for (const camera of [upright, inverted]) {
      const svg = outlineOf(camera);
      assert.match(svg, new RegExp(`class="lens-dot"`));
      assert.ok(svg.includes(`cx="${Math.round(camera.shape.lens.x * 10) / 10}"`), "the dot at the lens point");
    }
    assert.equal(upright.shape.inverted, false);
    assert.equal(inverted.shape.inverted, true);
    assert.match(outlineOf(inverted), /v 4/, "the handle is drawn on the underside");
    assert.match(outlineOf(upright), /v -4/, "and on top when upright");
  });

  test("an underslung fluid head is drawn upside down", () => {
    const head = layoutOf(RIGS.fisherRound).blocks.find((b) => b.slot === "head");
    assert.match(outlineOf(head), /scale\(1 -1\)/);
    assert.doesNotMatch(outlineOf(layoutOf(rig()).blocks.find((b) => b.slot === "head")), /scale\(1 -1\)/);
  });
});

describe("tap targets and markers", () => {
  test("every piece's whole outline is a tap target, at least 44px each way", () => {
    for (const selection of Object.values(RIGS)) {
      for (const b of layoutOf(selection).blocks) {
        const [, w, h] = hitArea(b).match(/width="([\d.]+)" height="([\d.]+)"/);
        assert.ok(Number(w) >= 44 && Number(h) >= 44, `${b.slot}: ${w}×${h}`);
        assert.ok(Number(w) >= b.box.width - 0.1 && Number(h) >= b.box.height - 0.1, `${b.slot} covers its outline`);
      }
    }
  });

  test("tap targets stack largest first, so a small piece on a big one stays tappable", () => {
    const layout = layoutOf(RIGS.fisherRound);
    const order = [...hitLayer(layout.blocks, (b) => `data-piece="${b.slot}"`).matchAll(/data-piece="(\w+)"/g)].map((m) => m[1]);
    assert.ok(order.indexOf("nose") > order.indexOf("adapter"), "the SLE's target is above the offset plate's");
    assert.ok(order.indexOf("support") < order.indexOf("nose"));
  });

  test("a marker has a 44px hit circle around a visible dot", () => {
    const svg = markerSvg({ x: 50, y: 80 }, 'data-place="{}"');
    assert.match(svg, /<circle cx="50" cy="80" r="22" class="marker-hit"\/>/);
    assert.match(svg, /r="9" class="marker-dot"/);
    assert.match(svg, /data-place=/);
  });

  test("a piece's outline and its tap target are separate, so targets can be stacked", () => {
    const b = layoutOf(rig()).blocks[0];
    assert.doesNotMatch(pieceSvg(b), /hit-area/);
    assert.match(hitLayer([b], () => 'data-piece="x"'), /hit-area/);
  });
});

describe("the outlines draw; they don't compute heights", () => {
  const source = readFileSync(path.join(root, "src/outlines.js"), "utf8");

  test("outlines.js imports nothing: no model, solver, or layout", () => {
    assert.doesNotMatch(source, /^import /m);
  });

  test("it never reads a height in inches: only pixel boxes and points from the layout", () => {
    for (const field of ["\\.rise\\b", "\\.start\\b", "\\.end\\b", "\\.bottom\\b(?!\\s*[-+])", "\\.top\\b", "\\.height\\b(?=\\s*[-+*/])", "Pct\\b", "riseRange", "(?<!Math)\\.(min|max)\\b"]) {
      const code = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      assert.doesNotMatch(code.replace(/f\.bottom|f\.top|box\.height|body\.height|c\.height|chassis\.height/g, ""), new RegExp(field), field);
    }
  });
});
