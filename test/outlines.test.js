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
import { markerSvg, outlineOf, pieceAt, pieceSvg, tagSvg } from "../src/outlines.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(path.join(root, "gear.json"), "utf8"));
const P = { packageId: "test-package", buildId: "build-placeholder" };
const rig = (over = {}) => ({
  ...P,
  supportId: "baby-sticks",
  headId: "oconnor-2575d",
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
    assert.match(fisherSvg.dolly, /k-moveable beam/, "the Fisher's beam is moveable");
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
    const pneumatic = dollySvg(fisher());
    const etw = dollySvg(fisher({ baseItemIds: ["round-track"], supportMode: "etw" }));
    const skate = dollySvg(fisher({ baseItemIds: ["round-track"], supportMode: "skateboard" }));
    assert.equal((pneumatic.match(/class="o tire"/g) || []).length, 2, "one wheel at each end, side on");
    assert.doesNotMatch(pneumatic, /groove|skate/);
    assert.equal((etw.match(/class="o groove"/g) || []).length, 2, "ETW wheels are grooved for round rail");
    assert.equal((skate.match(/class="o skate-wheel"/g) || []).length, 4, "two skateboard wheels under each tire");
    assert.match(skate, /skate-plate/);
  });

  test("the beam is drawn from the pivot to the nose; a moveable range adds faint beams at both ends", () => {
    const fixed = Object.fromEntries(svgOf(fisher(), { type: "fixed", height: 40 })).dolly;
    assert.equal((fixed.match(/class="beam-ghost"/g) || []).length, 0);
    const move = Object.fromEntries(svgOf(fisher(), { type: "range", low: 30, high: 50 })).dolly;
    assert.equal((move.match(/class="beam-ghost"/g) || []).length, 2);
    assert.equal((move.match(/k-moveable beam/g) || []).length, 1);
    assert.match(fixed, /class="o k-fixed post"/, "push posts at the rear");
  });

  test("the offset plate marks the side in use", () => {
    const off = Object.fromEntries(svgOf(RIGS.fisherRound)).offset;
    assert.equal((off.match(/class="o hole"/g) || []).length, 2, "a Mitchell ring at each end");
    assert.match(off, /class="in-use"/);
  });

  test("the camera: a 6″ body centered on the optical center, and a forward triangle on it", () => {
    const upright = layoutOf(rig()).blocks.at(-1);
    const inverted = layoutOf(RIGS.fisherRound).blocks.at(-1);
    const handle = layoutOf(RIGS.handle).blocks.at(-1);
    for (const camera of [upright, inverted, handle]) {
      const { body, cone, opticalCenter } = camera.shape;
      const scale = camera.box.height / 6;
      assert.ok(Math.abs(body.height - 6 * scale) < 0.05, "a 6″ body");
      assert.ok(Math.abs(body.y + body.height / 2 - opticalCenter.y) < 0.05, "centered on the optical center");
      const selection = camera === upright ? rig() : camera === inverted ? RIGS.fisherRound : RIGS.handle;
      assert.equal(opticalCenter.y, layoutOf(selection).lens.y, "on the lens height, so on the target line when on target");
      // The triangle: its point on the optical center, its opening forward.
      const points = outlineOf(camera).match(/<polygon points="([^"]+)" class="lens-cone"/)[1].split(" ").map((p) => p.split(",").map(Number));
      const [[px, py], [ax, ay], [bx, by]] = points;
      const r = (v) => Math.round(v * 10) / 10;
      assert.deepEqual([px, py], [r(cone.x0), r(opticalCenter.y)], "the point on the optical center");
      assert.ok(ax > px && bx > px, "opening forward, the way the camera shoots");
      assert.ok(Math.abs((ay + by) / 2 - py) < 0.11, "centered vertically on the optical center");
      assert.ok(ay < py && by > py);
      assert.doesNotMatch(outlineOf(camera), /lens-dot|<circle/, "no lens square or dot");
    }
    assert.equal(upright.shape.inverted, false);
    assert.equal(inverted.shape.inverted, true);
    assert.match(outlineOf(inverted), /v 4/, "the handle is drawn on the underside");
    assert.match(outlineOf(upright), /v -4/, "and on top when upright");
    assert.deepEqual(
      outlineOf(inverted).match(/class="lens-cone"/g).length,
      1,
      "inverted, the triangle is not flipped: same forward shape"
    );
  });

  test("an underslung fluid head is drawn upside down", () => {
    const head = layoutOf(RIGS.fisherRound).blocks.find((b) => b.slot === "head");
    assert.match(outlineOf(head), /scale\(1 -1\)/);
    assert.doesNotMatch(outlineOf(layoutOf(rig()).blocks.find((b) => b.slot === "head")), /scale\(1 -1\)/);
  });
});

describe("taps, markers, and tags", () => {
  // A support is tapped low, on its legs or chassis; anything else at its center.
  // An SLE, on its body under the plate (its neck runs up behind the head).
  // A base item, near its end (a dolly's wheels sit down into round track).
  // A lambda cradle, on its arm just under the mount (its middle holds the camera).
  const centerOf = (b) =>
    b.slot === "base"
      ? { x: b.box.x + 3, y: b.box.y + Math.max(b.box.height, 4) / 2 }
      : b.slot === "support" || b.shape.type === "sle"
      ? { x: b.box.x + b.box.width / 2, y: b.box.y + b.box.height - 6 }
      : b.shape.type === "lambda"
        ? { x: b.shape.mount.x, y: b.shape.mount.y + 4 }
        : { x: b.box.x + b.box.width / 2, y: b.box.y + Math.max(b.box.height, 4) / 2 };
  const slotAt = (layout, point) => {
    const i = pieceAt(layout.blocks, point);
    return i === null ? null : layout.blocks[i].slot;
  };

  test("a tap anywhere on a piece's outline opens that piece, even where outlines overlap", () => {
    for (const selection of Object.values(RIGS)) {
      const layout = layoutOf(selection, { type: "fixed", height: 30 });
      for (const b of layout.blocks) {
        // A bracket's box is mostly the space it hangs around; it has its own test below.
        if (b.shape.type === "lhe") continue;
        const hit = slotAt(layout, centerOf(b));
        // Where outlines overlap (everything on a dolly), the one drawn on top wins.
        assert.equal(hit, b.slot, `${JSON.stringify(selection).slice(0, 60)}: ${b.slot}`);
      }
    }
  });

  test("the LHE is tappable on its arm, just under the nose", () => {
    const layout = layoutOf(RIGS.lhe);
    const lhe = layout.blocks.find((b) => b.slot === "nose");
    assert.equal(slotAt(layout, { x: lhe.shape.nose.x, y: lhe.shape.nose.y + 4 }), "nose");
  });

  test("an SLE set down under an offset plate stays tappable", () => {
    const layout = layoutOf(fisher({ adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" }, modeName: "underslung", attachName: "base-inverted" }), { type: "fixed", height: 5 });
    const sle = layout.blocks.find((b) => b.slot === "nose");
    assert.ok(sle.box.height > 4, "the SLE is set below 0");
    assert.equal(slotAt(layout, centerOf(sle)), "nose");
  });

  test("a sliver still has a 44px target: 22px around it", () => {
    const layout = layoutOf(RIGS.fisherRound);
    const plate = layout.blocks.find((b) => b.slot === "adapter");
    assert.equal(slotAt(layout, { x: plate.box.x + plate.box.width - 2, y: plate.box.y - 12 }), "adapter", "just above the plate's far end");
    assert.equal(slotAt(layout, { x: -100, y: -100 }), null, "far away is no piece");
  });

  test("a marker has a 44px hit circle around a visible dot", () => {
    const svg = markerSvg({ x: 50, y: 80 }, 'data-place="{}"');
    assert.match(svg, /<circle cx="50" cy="80" r="22" class="marker-hit"\/>/);
    assert.match(svg, /r="9" class="marker-dot"/);
    assert.match(svg, /data-place=/);
  });

  test("a tag draws its lines, escaped, and opens its piece", () => {
    const tag = { lines: ["Riser 6″", "<b>"], x: 10, y: 20, width: 60, height: 32, warn: true };
    const svg = tagSvg(tag, 'data-piece="adapter|r"', (t) => t.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
    assert.match(svg, /data-piece="adapter\|r"/);
    assert.match(svg, /Riser 6″/);
    assert.match(svg, /&lt;b&gt;/);
    assert.match(svg, /class="tag is-warn"/);
  });

  test("an outline carries no tap target of its own: taps are resolved by pieceAt", () => {
    assert.doesNotMatch(pieceSvg(layoutOf(rig()).blocks[0]), /data-piece|hit-area/);
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
      assert.doesNotMatch(code.replace(/f\.bottom|f\.top|e\.bottom|e\.top|box\.height|body\.height|c\.height|chassis\.height|posts\.bottom|posts\.top|b\.top|b\.bottom/g, ""), new RegExp(field), field);
    }
  });
});
