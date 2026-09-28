// The drawing-first check screen: the verdict line (SPEC.md 5.6), the
// drawing's columns, margins, and label lane (5.8), and editing the rig in
// place (5.9, 7.2).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildChain, enumerateChains, evaluateChain } from "../src/solver.js";
import { addOptions, applyEdit, defaultPicks, insertOptions, missingSlot, modeControl, revalidatePicks, slotOptions, swapOptions } from "../src/rules.js";
import { stackLayout } from "../src/stack.js";
import { checkVerdict } from "../src/verdict.js";

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
  // The A-cam block's QR bottom needs a Euro plate on the 2575D's Euro receiver.
  plateIds: ["euro-plate"],
  blockIds: null,
  modeName: "normal",
  attachName: "base",
  ...over,
});
const chainOf = (picks) => buildChain(seed, { packageId: P[0], buildId: P[1], ...picks });
const UNDERSLUNG = picksFor({
  adapterIds: ["mitchell-offset-10"],
  adapterModes: { "mitchell-offset-10": "bottom" },
  modeName: "underslung",
  attachName: "base-inverted",
});
// The Lambda 50 hung underslung from the bottom of an offset plate, and upright on the sticks.
const LAMBDA = picksFor({
  headId: "lambda-50", plateIds: [],
  modeName: "underslung",
  attachName: "base",
  adapterIds: ["mitchell-offset-10"],
  adapterModes: { "mitchell-offset-10": "bottom" },
});
const LAMBDA_UP = picksFor({ headId: "lambda-50", plateIds: [], modeName: "upright", attachName: "base" });
const available = (options) => options.filter((o) => o.available).map((o) => o.label);
const gap = (picks, slot, index) => insertOptions(seed, ...P, picks).find((g) => g.slot === slot && g.index === index);

// ---------------------------------------------------------------------------
// The verdict (SPEC.md 5.6)
// ---------------------------------------------------------------------------

describe("checkVerdict: one line — what the rig does, or the shortfall", () => {
  const chain = chainOf(picksFor()); // reach 33.25..49.25: sticks 20–36″, 2575 +8½″, Euro plate +¾″, A-cam +4″
  const verdict = (target) => checkVerdict(chain, target, evaluateChain(chain, target));

  test("success is only what the rig does: no margins", () => {
    assert.deepEqual(verdict({ type: "fixed", height: 40.25 }), { state: "feasible", text: "Reaches 40¼″" });
    assert.deepEqual(verdict({ type: "fixed", height: 43.25 }), { state: "feasible", text: "Reaches 43¼″" });
  });

  test("no warning state: a tight margin, or inside the ±½″ tolerance past the end, reads the same", () => {
    assert.deepEqual(verdict({ type: "fixed", height: 48.75 }), { state: "feasible", text: "Reaches 48¾″" }, "½″ to spare");
    assert.deepEqual(verdict({ type: "fixed", height: 49.5 }), { state: "feasible", text: "Reaches 49½″" }, "¼″ past the top, within tolerance");
    assert.deepEqual(verdict({ type: "fixed", height: 32.75 }), { state: "feasible", text: "Reaches 32¾″" }, "½″ past the bottom, the edge of the tolerance");
    assert.equal(verdict({ type: "fixed", height: 50 }).state, "infeasible", "¾″ past the top is past the tolerance");
  });

  test("failure is only the shortfall: too short, too tall, or not enough moveable travel", () => {
    assert.deepEqual(verdict({ type: "fixed", height: 54 }), { state: "infeasible", text: "4¾″ too short" });
    assert.equal(verdict({ type: "fixed", height: 29.75 }).text, "3½″ too tall");
    assert.equal(verdict({ type: "range", low: 36.25, high: 41.25 }).text, "Needs 5″ more moveable travel", "a tripod can't move live");
  });

  test("a range reads \"Covers\": a moveable range must fit the travel, but says nothing about what's left", () => {
    // Fisher 11, SLE upright (−4″ to 0″): reach 27.125..64.5, with 33.375″ of beam.
    const dolly = chainOf(picksFor({ supportId: "fisher-11", noseId: "fisher-sle" }));
    const move = (low, high) => ({ type: "range", low, high });
    const verdictFor = (target) => checkVerdict(dolly, target, evaluateChain(dolly, target));
    assert.deepEqual(verdictFor(move(29.125, 40.75)), { state: "feasible", text: "Covers 29–40¾″" });
    assert.deepEqual(verdictFor(move(31.75, 64.5)), { state: "feasible", text: "Covers 31¾–64½″" }, "0″ to spare at top");
    assert.deepEqual(verdictFor(move(29.75, 62.375)), { state: "feasible", text: "Covers 29¾–62¼″" }, "¾″ of beam left");
    const legsAndBoom = { min: 0, max: 50, moveableInterval: { min: 0, max: 10.5 } };
    const tooLong = move(20, 32);
    assert.equal(checkVerdict(legsAndBoom, tooLong, evaluateChain(legsAndBoom, tooLong)).text, "Needs 1½″ more moveable travel");
  });

  test("no target yet: the reach, and a prompt", () => {
    assert.deepEqual(checkVerdict(chain, null, null), { state: "waiting", text: "Reaches 33¼–49¼″ · enter a target" });
  });
});

// ---------------------------------------------------------------------------
// Columns, heights, margins (SPEC.md 5.8)
// ---------------------------------------------------------------------------

describe("stackLayout: horizontal position and pixel geometry", () => {
  const close = (a, b, eps = 0.05) => Math.abs(a - b) <= eps;
  const at = (layout, slot) => layout.blocks.find((b) => b.slot === slot);

  test("an upright rig stacks on one line: every piece at x 0, heights contiguous", () => {
    const layout = stackLayout(chainOf(picksFor({ adapterIds: ["mitchell-riser-6"] })), { type: "fixed", height: 40 });
    for (const b of layout.blocks) {
      assert.equal(b.x, 0, b.slot);
      assert.equal(b.mountX, 0, b.slot);
      assert.ok(b.top >= b.bottom);
    }
    assert.equal(at(layout, "adapter").bottom, at(layout, "support").top, "the riser starts where the support ends");
    assert.equal(at(layout, "adapter").top, at(layout, "adapter").bottom + 6);
    assert.equal(layout.columns, undefined, "no columns: horizontal position replaces them");
  });

  test("true vertical scale: every piece's box is its rise at one pixels-per-inch scale", () => {
    for (const picks of [picksFor({ adapterIds: ["mitchell-riser-6"] }), UNDERSLUNG, LAMBDA]) {
      const layout = stackLayout(chainOf(picks), { type: "fixed", height: 20 }, { frame: { width: 200, height: 500 } });
      const { scale } = layout.frame;
      for (const b of layout.blocks) {
        // An offset plate is drawn with its thickness, a camera with its body past the lens,
        // the Lambda 50 with its column running 2″ past the platform.
        if (b.component.plateLength || b.slot === "build") continue;
        if (b.shape.type === "lambda") {
          assert.ok(close(b.box.height, (b.top - b.bottom + 2) * scale, 0.3), `lambda: ${b.box.height}`);
          continue;
        }
        assert.ok(close(b.box.height, (b.top - b.bottom) * scale, 0.3), `${b.slot}: ${b.box.height} vs ${(b.top - b.bottom) * scale}`);
        assert.ok(close(b.box.y, layout.floor.y - b.top * scale, 0.3) || b.bottom < 0, `${b.slot} top at its height`);
      }
    }
  });

  test("true scale on both axes: one inch is the same pixels across as up", () => {
    const tripodRig = stackLayout(chainOf(picksFor()), null, { frame: { width: 320, height: 520 } });
    const { scale } = tripodRig.frame;
    assert.ok(close(tripodRig.blocks[0].shape.topWidth, 4 * scale, 0.05), "the tripod's 4″ top");
    const block = tripodRig.blocks.find((b) => b.slot === "build").shape;
    assert.ok(close(block.body.width, 11 * scale, 0.1), "an 11″ camera body");
    assert.ok(close(block.body.height, 5 * scale, 0.1), "5″ tall");
    const dovetail = block.pieces.find((p) => p.id === "arri-dovetail").box;
    assert.ok(close(dovetail.width, 10 * scale, 0.1) && close(dovetail.height, 1 * scale, 0.1), "a 10″ Arri dovetail, 1″ thick");
    const fisher = stackLayout(chainOf(picksFor({ supportId: "fisher-11", noseId: "fisher-sle" })), null, { frame: { width: 320, height: 520 } });
    const dolly = fisher.blocks.find((b) => b.slot === "support").shape;
    const k = fisher.frame.scale;
    assert.ok(close(dolly.chassis.width, 40 * k, 0.3), "a 40″ chassis");
    assert.ok(close(dolly.tire.centers[1].x - dolly.tire.centers[0].x, 28 * k, 0.3), "a 28″ wheelbase");
    assert.ok(close(fisher.floor.y - dolly.posts.top, 39.75 * k, 0.3), "push posts 39¾″ off the floor");
    assert.equal(fisher.frame.squeeze, undefined, "nothing is squeezed");
  });

  test("an offset plate moves the next piece by its real length, drawn at the vertical scale", () => {
    const layout = stackLayout(chainOf(UNDERSLUNG), { type: "fixed", height: 12 }, { frame: { width: 240, height: 500 } });
    const plate = at(layout, "adapter");
    assert.equal(at(layout, "head").x - plate.x, 10, "10″ forward, exactly");
    assert.equal(plate.mountX - plate.x, 10);
    assert.ok(close(plate.shape.far.x - plate.shape.near.x, 10 * layout.frame.scale, 0.2), "and drawn 10″ long at the true scale");
    assert.equal(plate.shape.side, "bottom");
    assert.equal(at(layout, "head").top, at(layout, "support").top, "the head hangs from the plate, at the top of the support");
    assert.equal(at(layout, "plate").top, at(layout, "head").bottom, "the Euro plate hangs from the head");
    assert.equal(at(layout, "plate").rise, -0.75, "inverted, its rise negated");
    assert.equal(at(layout, "build").top, at(layout, "plate").bottom, "the camera block hangs from the plate");
    assert.equal(layout.lens.height, at(layout, "build").bottom, "the lens is at the bottom of the hanging camera");
    assert.equal(at(layout, "build").shape.inverted, true);
  });

  test("a 24″ plate fits by drawing the whole rig smaller, never by shortening the plate", () => {
    const picks = picksFor({ adapterIds: ["mitchell-offset-24"], adapterModes: { "mitchell-offset-24": "bottom" }, modeName: "underslung", attachName: "base-inverted" });
    const layout = stackLayout(chainOf(picks), { type: "fixed", height: 12 }, { frame: { width: 180, height: 520 } });
    const plate = at(layout, "adapter");
    assert.ok(close(plate.shape.far.x - plate.shape.near.x, 24 * layout.frame.scale, 0.3));
    for (const b of layout.blocks) {
      assert.ok(b.box.x >= -0.5 && b.box.x + b.box.width <= 180.5, `${b.slot} inside the frame`);
    }
  });

  test("a wide rig fits by width, and the drawing is only as tall as it needs", () => {
    const fisherRig = stackLayout(chainOf(picksFor({ supportId: "fisher-11", noseId: "fisher-sle" })), null, { frame: { width: 320, height: 520 } });
    assert.ok(fisherRig.frame.height < 520, "shorter than asked: the width set the scale");
    for (const b of fisherRig.blocks) {
      assert.ok(b.box.x >= -0.5 && b.box.x + b.box.width <= 320.5, `${b.slot} inside across`);
      assert.ok(b.box.y >= -0.5 && b.box.y + b.box.height <= fisherRig.frame.height + 0.5, `${b.slot} inside up and down`);
    }
    const tall = stackLayout(chainOf(picksFor({ adapterIds: ["mitchell-riser-24", "mitchell-riser-18"] })), null, { frame: { width: 320, height: 520 } });
    assert.equal(tall.frame.height, 520, "a tall rig uses the full height");
  });

  test("the Lambda 50 cradles its camera: upright on the platform, in both modes", () => {
    for (const [picks, hangs] of [[LAMBDA, true], [LAMBDA_UP, false]]) {
      const layout = stackLayout(chainOf(picks), null);
      const head = layout.blocks.find((b) => b.slot === "head");
      const camera = layout.blocks.at(-1);
      assert.equal(head.shape.type, "lambda");
      assert.equal(head.shape.hangs, hangs);
      assert.equal(camera.cradled, true);
      assert.equal(camera.inverted, false, "the camera is never inverted on a lambda");
      assert.equal(camera.start, head.end, "the camera sits on the platform");
      assert.equal(camera.x, head.mountX, "centered on the platform, forward of the column");
      assert.ok(camera.x > head.x, "the platform is cantilevered forward from the column");
      assert.equal(head.kind, "adjustable", "drawn in the adjustable color");
    }
  });

  test("the Lambda 50's platform moves along the column as the rise is set", () => {
    const at = (picks, height) => stackLayout(chainOf(picks), { type: "fixed", height }).blocks.find((b) => b.slot === "head");
    // Upright on baby sticks: legs first (20–36″), then the platform (+10″ to +18″).
    const low = chainOf(LAMBDA_UP).min;
    const high = chainOf(LAMBDA_UP).max;
    assert.equal(high - low, 16 + 8, "the legs' 16″ plus the platform's 8″");
    assert.equal(at(LAMBDA_UP, low).rise, 10);
    assert.equal(at(LAMBDA_UP, high).rise, 18);
    assert.equal(at(LAMBDA_UP, high - 3).rise, 15, "the legs are set first, the platform takes the rest");
    assert.deepEqual(at(LAMBDA_UP, low).range, { min: 10, max: 18 });
    // Underslung: −18″ at the bottom of the reach, −10″ at the top.
    assert.equal(at(LAMBDA, chainOf(LAMBDA).min).rise, -18);
    assert.equal(at(LAMBDA, chainOf(LAMBDA).max).rise, -10);
    // In the drawing, the platform slides up the column, away from the pan base.
    const aboveBase = (h) => {
      const layout = stackLayout(chainOf(LAMBDA_UP), { type: "fixed", height: h }, { frame: { width: 320, height: 520 } });
      const head = layout.blocks.find((b) => b.slot === "head");
      return (head.shape.pan.y + head.shape.pan.height - head.shape.platformTop.y) / layout.frame.scale;
    };
    assert.ok(close(aboveBase(high), 18, 0.05), "platform 18″ above the mount");
    assert.ok(close(aboveBase(high - 8), 10, 0.05), "and 10″ at the bottom of its travel");
  });

  test("the scale fits the content: the reach rail is clipped, not the drawing stretched", () => {
    const chain = chainOf(picksFor({ supportId: "fisher-11", noseId: "fisher-sle" })); // reach 27.125..64.5
    const layout = stackLayout(chain, { type: "fixed", height: 30 }, { frame: { width: 400, height: 520 } });
    assert.equal(layout.lens.height, 30);
    // The current rig tops out at the push posts, 39¾″: the drawing fits that, not the 63¾″ reach.
    assert.ok(layout.lens.pct > 60 && layout.lens.pct < 90, `the lens at ${layout.lens.pct}%, under the push posts`);
    assert.deepEqual([layout.reach.min, layout.reach.max], [27.125, 64.5], "the rail is labeled with the real reach");
    assert.equal(layout.reach.topPct, 100);
    assert.equal(layout.reach.continuesAbove, true);
    assert.equal(layout.reach.continuesBelow, false);
    assert.equal(layout.moveable.continuesAbove, true);
    assert.equal(layout.margins, undefined, "no margin tags; the verdict states the margin");

    const tall = stackLayout(chain, { type: "fixed", height: 70 }, { frame: { width: 400, height: 520 } });
    assert.equal(tall.reach.continuesAbove, false, "a target above the reach stretches the drawing, so the rail fits");
    assert.ok(tall.target.bottomPct < 100);
  });

  test("insertion points carry their pixel point: the floor, and the mount of the piece below", () => {
    const layout = stackLayout(chainOf(picksFor({ baseItemIds: ["apple-half"], adapterIds: ["mitchell-riser-6"] })), null);
    const g = (slot, index) => layout.gaps.find((x) => x.slot === slot && x.index === index);
    const [box, support, riser] = layout.blocks;
    assert.equal(g("base", 0).height, 0);
    assert.equal(g("base", 0).point.y, layout.floor.y);
    assert.equal(g("base", 1).height, box.top);
    assert.deepEqual(g("adapter", 0).point, support.mount);
    assert.deepEqual(g("adapter", 1).point, riser.mount);
    assert.equal(g("adapter", 1).on, riser.name);
    const head = layout.blocks.find((b) => b.slot === "head");
    const plate = layout.blocks.find((b) => b.slot === "plate");
    assert.deepEqual(g("plate", 0).point, head.mount, "a plate goes on the head");
    assert.deepEqual(g("plate", 1).point, plate.mount, "or on the Euro plate, under the camera block");
    assert.equal(layout.gaps.length, 6);
    const hung = stackLayout(chainOf(UNDERSLUNG), null);
    assert.equal(hung.gaps.find((x) => x.slot === "adapter" && x.index === 1).x, 10, "on the far end of the plate");
  });

  test("nothing is marked estimated: all gear values are treated as correct", () => {
    const layout = stackLayout(chainOf(picksFor({ adapterIds: ["mitchell-riser-6"] })), null);
    assert.equal(layout.estimated, undefined);
    for (const b of layout.blocks) assert.equal(b.estimated, undefined, b.slot);
  });
});

describe("stackLayout: nothing in the drawing is labeled", () => {
  test("no tags on any piece, across a spread of rigs", () => {
    for (const picks of [picksFor(), UNDERSLUNG, LAMBDA, picksFor({ supportId: "fisher-11", noseId: "fisher-sle", adapterIds: ["mitchell-riser-6"] })]) {
      const layout = stackLayout(chainOf(picks), null);
      for (const b of layout.blocks) assert.equal(b.tag, undefined, b.slot);
    }
  });

  test("an inverted camera is the drawing's one warning", () => {
    assert.equal(stackLayout(chainOf(UNDERSLUNG), null).warning, "Camera inverted — flip image");
    assert.equal(stackLayout(chainOf(picksFor()), null).warning, null);
  });
});


// ---------------------------------------------------------------------------
// Editing in place (SPEC.md 5.9)
// ---------------------------------------------------------------------------

describe("insertOptions: only what legally fits at that exact point", () => {
  test("on a tripod: apple boxes and rolling spreaders at the floor; risers and either offset mode on the support", () => {
    assert.deepEqual(available(gap(picksFor(), "base", 0).options), [
      "Pancake Apple Box", "Quarter Apple Box", "Half Apple Box", "Full Apple Box (#1 LA)", "Full Apple Box (#2 Chicago)", "Full Apple Box (#3 NY)",
      "Rolling spreaders",
    ]);
    const onApple = gap(picksFor({ baseItemIds: ["apple-half"] }), "base", 1).options.find((o) => o.id === "rolling-spreaders");
    assert.equal(onApple.available, false, "nothing goes under spreaders");
    assert.match(onApple.reason, /bare floor only — nothing goes underneath them/);
    const hihat = gap(picksFor({ supportId: "hihat-placeholder" }), "base", 0).options.find((o) => o.id === "rolling-spreaders");
    assert.equal(hihat.available, false, "a hi-hat can't sit on spreaders");
    assert.deepEqual(available(gap(picksFor(), "adapter", 0).options), [
      'Mitchell Riser 3"', 'Mitchell Riser 6"', 'Mitchell Riser 12"', 'Mitchell Riser 18"', 'Mitchell Riser 24"',
      "Mitchell Offset, 10″ (Top of the plate)", "Mitchell Offset, 10″ (Bottom of the plate)",
      "Mitchell Offset, 24″ (Top of the plate)", "Mitchell Offset, 24″ (Bottom of the plate)",
      "Rotating Offset",
    ]);
    const track = gap(picksFor(), "base", 0).options.find((o) => o.id === "round-track");
    assert.equal(track.available, false);
    assert.match(track.reason, /Baby sticks sits on the floor or rolling spreaders, not on round track/);
  });

  test("on a Fisher: only track at the floor (round track by switching wheels), and adapters sit on the nose fitting", () => {
    const dolly = picksFor({ supportId: "fisher-11", noseId: "fisher-sle" });
    assert.deepEqual(available(gap(dolly, "base", 0).options), ["Round Track"]);
    const apple = gap(dolly, "base", 0).options.find((o) => o.id === "apple-half");
    assert.match(apple.reason, /apple boxes can't go under a dolly/);
    assert.equal(gap(dolly, "adapter", 0).where, "on SLE — 4-way Level Head (Upright)");
    assert.equal(insertOptions(seed, ...P, { ...dolly, noseId: null }).some((g) => g.slot === "adapter"), false, "no nose fitting, nothing to stack adapters on");
  });

  test("nothing stacks on top of track, and nothing is offered on an underslung offset", () => {
    const onTrack = picksFor({ supportId: "fisher-11", supportMode: "etw", noseId: "fisher-sle", baseItemIds: ["round-track"] });
    assert.deepEqual(available(gap(onTrack, "base", 1).options), []);
    assert.match(gap(onTrack, "base", 1).options.find((o) => o.id === "apple-half").reason, /needs the floor beneath it, but Round Track ends in round track/);
    assert.deepEqual(available(gap(UNDERSLUNG, "adapter", 1).options), []);
    assert.match(
      gap(UNDERSLUNG, "adapter", 1).options.find((o) => o.id === "mitchell-riser-6").reason,
      /needs an up-facing mount beneath it, but the top of Mitchell Offset, 10″ \(Bottom of the plate\) faces down/
    );
  });

  test("position matters: a riser fits under the underslung offset, not over it", () => {
    assert.ok(available(gap(UNDERSLUNG, "adapter", 0).options).includes('Mitchell Riser 6"'));
    assert.ok(!available(gap(UNDERSLUNG, "adapter", 1).options).includes('Mitchell Riser 6"'));
  });

  test("an addition that would switch the head's mode is fine; one that leaves the head nothing is not", () => {
    // The standard head switches to underslung (and the camera inverts) when the offset goes underslung.
    const hung = gap(picksFor(), "adapter", 0).options.find((o) => o.label === "Mitchell Offset, 10″ (Bottom of the plate)");
    assert.equal(hung.available, true);
    // The Lambda 50 upright switches to underslung under an offset's bottom side, camera still upright.
    const onLambda = gap(LAMBDA_UP, "adapter", 0).options.find((o) => o.label === "Mitchell Offset, 10″ (Bottom of the plate)");
    assert.equal(onLambda.available, true);
  });

  test("apple boxes are unlimited; anything else already in the rig isn't offered again", () => {
    const withBox = picksFor({ baseItemIds: ["apple-half"], adapterIds: ["mitchell-riser-6"] });
    assert.equal(gap(withBox, "base", 1).options.find((o) => o.id === "apple-half").available, true, "a second half apple");
    const riser = gap(withBox, "adapter", 1).options.find((o) => o.id === "mitchell-riser-6");
    assert.equal(riser.available, false);
    assert.match(riser.reason, /already in the rig/);
    const spreaders = picksFor({ baseItemIds: ["rolling-spreaders"] });
    const second = gap(spreaders, "base", 1).options.find((o) => o.id === "rolling-spreaders");
    assert.equal(second.available, false, "spreaders are one of each");
  });

  test("options carry a plain rise and label, and reasons never leak field names", () => {
    for (const picks of [picksFor(), UNDERSLUNG, LAMBDA, picksFor({ supportId: "fisher-11", noseId: "fisher-sle" })]) {
      for (const g of insertOptions(seed, ...P, picks)) {
        for (const o of g.options) {
          assert.equal(typeof o.rise, "number");
          assert.ok(o.label);
          if (o.reason) assert.doesNotMatch(o.reason, /bottomMount|topMount|mountFacing|requiresFamily|undefined|null|\[object/);
        }
      }
    }
  });
});

describe("swapOptions", () => {
  test("a support swaps for any other that sits on the base layer", () => {
    assert.deepEqual(available(swapOptions(seed, ...P, picksFor(), "support")), ["Standard sticks", "Fisher 11 Dolly", "Hi-Hat", "Low Hat"]);
    const onApple = swapOptions(seed, ...P, picksFor({ baseItemIds: ["apple-half"] }), "support");
    assert.deepEqual(available(onApple), ["Standard sticks", "Hi-Hat", "Low Hat"], "not the dolly on an apple box");
    assert.ok(onApple.every((o) => o.rise === null), "a support has a range, not one rise");
  });

  test("a head swaps for another with a legal mode", () => {
    assert.deepEqual(available(swapOptions(seed, ...P, picksFor(), "head")), ["Lambda 50"]);
    assert.deepEqual(available(swapOptions(seed, ...P, UNDERSLUNG, "head")), ["Lambda 50"], "the lambda hangs underslung from the offset's bottom");
  });

  test("an adapter swaps in its place: the underslung offset for a riser", () => {
    const options = swapOptions(seed, ...P, UNDERSLUNG, "adapter", 0);
    assert.deepEqual(available(options), [
      'Mitchell Riser 3"', 'Mitchell Riser 6"', 'Mitchell Riser 12"', 'Mitchell Riser 18"', 'Mitchell Riser 24"',
      "Mitchell Offset, 24″",
      "Rotating Offset",
    ]);
    assert.ok(!options.some((o) => o.id === "mitchell-offset-10"), "the piece itself isn't a swap");
    // Each piece once, never a choice of side: that's a flip. The swap keeps the head where it is.
    assert.equal(options.find((o) => o.id === "mitchell-offset-24").mode, "bottom", "on the same side as the plate it replaces");
  });

  test("a base item swaps in its place", () => {
    const options = swapOptions(seed, ...P, picksFor({ baseItemIds: ["apple-half"] }), "base", 0);
    assert.ok(available(options).includes("Full Apple Box"), "once, not once per face");
    assert.ok(!available(options).includes("Square Track"), "a tripod can't stand on track");
  });
});

describe("applyEdit, then revalidatePicks", () => {
  const next = (picks, change) => revalidatePicks(seed, ...P, applyEdit(picks, change));

  test("insert at a position, and the picks keep that order", () => {
    const { picks } = next(picksFor({ adapterIds: ["mitchell-riser-12"] }), { op: "insert", slot: "adapter", index: 0, id: "mitchell-riser-6" });
    assert.deepEqual(picks.adapterIds, ["mitchell-riser-6", "mitchell-riser-12"]);
    const top = next(picksFor({ adapterIds: ["mitchell-riser-12"] }), { op: "insert", slot: "adapter", index: 1, id: "mitchell-riser-6" }).picks;
    assert.deepEqual(top.adapterIds, ["mitchell-riser-12", "mitchell-riser-6"]);
  });

  test("inserting the offset underslung takes the head and camera with it, with no notes: that's what the user did", () => {
    const { picks, notes } = next(picksFor(), { op: "insert", slot: "adapter", index: 0, id: "mitchell-offset-10", mode: "bottom" });
    assert.deepEqual(picks, UNDERSLUNG);
    assert.deepEqual(notes, []);
  });

  test("remove, and what depended on it switches back", () => {
    const { picks, notes } = next(UNDERSLUNG, { op: "remove", slot: "adapter", index: 0 });
    assert.deepEqual(picks, picksFor());
    assert.deepEqual(notes, []);
  });

  test("swap a base item, a support, a head", () => {
    assert.deepEqual(next(picksFor({ baseItemIds: ["apple-half"] }), { op: "swap", slot: "base", index: 0, id: "apple-full" }).picks.baseItemIds, ["apple-full"]);
    const onDolly = next(picksFor(), { op: "swap", slot: "support", id: "fisher-11" }).picks;
    assert.deepEqual([onDolly.supportId, onDolly.supportMode, onDolly.noseId], ["fisher-11", "pneumatic", null]);
    assert.equal(missingSlot(seed, ...P, onDolly), "nose", "a Fisher asks for its nose fitting next");
    const withNose = next(onDolly, { op: "swap", slot: "nose", id: "fisher-sle" }).picks;
    assert.deepEqual([withNose.noseId, withNose.noseMode], ["fisher-sle", "upright"]);
    assert.equal(missingSlot(seed, ...P, withNose), null);
    const lambda = next(picksFor(), { op: "swap", slot: "head", id: "lambda-50" }).picks;
    assert.deepEqual([lambda.headId, lambda.modeName, lambda.attachName], ["lambda-50", "upright", "base"]);
  });

  test("swapping the Fisher for a tripod clears the nose fitting, with a note, and keeps the adapters", () => {
    const start = picksFor({ supportId: "fisher-11", noseId: "fisher-sle", adapterIds: ["mitchell-riser-6"] });
    const { picks, notes } = next(start, { op: "swap", slot: "support", id: "baby-sticks" });
    assert.equal(picks.noseId, null);
    assert.deepEqual(picks.adapterIds, ["mitchell-riser-6"]);
    assert.deepEqual(notes, ["Removed SLE"]);
  });

  test("mode edits: an adapter's mode, a wheel set, the SLE's position", () => {
    const flipped = next(picksFor({ adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "top" } }), {
      op: "mode", slot: "adapter", index: 0, mode: "bottom",
    }).picks;
    assert.equal(flipped.modeName, "underslung");
    assert.equal(next(UNDERSLUNG, { op: "mode", slot: "build", mode: "top-handle" }).picks.attachName, "base-inverted", "no top handle to hang from");
    const fisher = picksFor({ supportId: "fisher-11", noseId: "fisher-sle", baseItemIds: ["round-track"] });
    assert.equal(next(fisher, { op: "mode", slot: "support", mode: "skateboard" }).picks.supportMode, "skateboard");
    assert.equal(next(fisher, { op: "mode", slot: "nose", mode: "reversed" }).picks.noseMode, "reversed");
  });

  test("revalidatePicks returns picks in stack order", () => {
    const { picks } = revalidatePicks(seed, ...P, picksFor({
      adapterIds: ["mitchell-offset-10", "mitchell-riser-6"],
      adapterModes: { "mitchell-offset-10": "bottom" },
      modeName: "underslung",
      attachName: "base-inverted",
    }));
    assert.deepEqual(picks.adapterIds, ["mitchell-riser-6", "mitchell-offset-10"], "the riser goes under the hanging offset");
    assert.deepEqual(chainOf(picks).adapters.map((a) => a.id), picks.adapterIds, "picks and chain agree on the order");
  });

  test("every offered insert and swap, applied, builds — with the piece where it was put", () => {
    const starts = [
      defaultPicks(seed, ...P),
      UNDERSLUNG,
      LAMBDA,
      picksFor({ supportId: "fisher-11", supportMode: "etw", noseId: "fisher-sle", baseItemIds: ["round-track"] }),
      picksFor({ baseItemIds: ["apple-full", "apple-full"], baseModes: ["flat", "12in"] }),
      picksFor({ baseItemIds: ["apple-half"], adapterIds: ["mitchell-riser-6", "mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "top" } }),
    ];
    let tried = 0;
    for (const start of starts) {
      for (const g of insertOptions(seed, ...P, start)) {
        for (const o of g.options.filter((x) => x.available)) {
          const { picks } = next(start, { op: "insert", slot: g.slot, index: g.index, id: o.id, mode: o.mode });
          const ids = g.slot === "base" ? picks.baseItemIds : picks.adapterIds;
          assert.equal(ids[g.index], o.id, `${o.label} at ${g.slot} ${g.index}`);
          assert.doesNotThrow(() => chainOf(picks));
          tried++;
        }
      }
      const pieces = [
        ...start.baseItemIds.map((_, index) => ["base", index]),
        ...start.adapterIds.map((_, index) => ["adapter", index]),
        ["support", 0],
        ["head", 0],
      ];
      for (const [slot, index] of pieces) {
        for (const o of swapOptions(seed, ...P, start, slot, index).filter((x) => x.available)) {
          const { picks } = next(start, { op: "swap", slot, index, id: o.id, mode: o.mode });
          if (!missingSlot(seed, ...P, picks)) assert.doesNotThrow(() => chainOf(picks), `${slot} → ${o.label}`);
          tried++;
        }
      }
    }
    assert.ok(tried > 60, `tried ${tried}`);
  });
});

// ---------------------------------------------------------------------------
// One Add button (SPEC.md 5.9, 7.2)
// ---------------------------------------------------------------------------

describe("addOptions: everything that can be added, with where it fits", () => {
  const add = (picks) => Object.fromEntries(addOptions(seed, ...P, picks).map((o) => [o.id, o]));

  test("one entry per component; one legal position means no question to ask", () => {
    const options = add(picksFor());
    assert.deepEqual(options["apple-half"].positions.map((p) => p.where), ["on the floor"]);
    assert.deepEqual(options["mitchell-riser-6"].positions.map((p) => p.where), ["on Baby sticks"]);
    assert.equal(Object.values(options).filter((o) => o.id === "apple-full").length, 1, "the full apple once, not once per face");
    assert.equal(options["apple-full"].positions[0].mode, "flat", "added in its first mode that fits");
    assert.ok(!options["round-track"], "a tripod can't stand on track, so track isn't offered");
    assert.ok(!options["dolly-low-mode-placeholder"], "dolly-only adapters aren't offered on a tripod");
  });

  test("several legal positions are listed in plain words", () => {
    const options = add(picksFor({ baseItemIds: ["apple-half"], adapterIds: ["mitchell-riser-12"] }));
    assert.deepEqual(options["apple-quarter"].positions.map((p) => p.where), ["on the floor", "on Half Apple Box"]);
    assert.deepEqual(options["mitchell-riser-6"].positions.map((p) => p.where), ["on Baby sticks", "under O'Connor 2575D"]);
    assert.deepEqual(options["apple-half"].positions.map((p) => p.where), ["on the floor", "on Half Apple Box"], "apple boxes are unlimited");
    assert.ok(!options["mitchell-riser-12"], "other gear is one of each");
  });

  test("a position is only offered where the item really fits: nothing goes on an underslung offset", () => {
    const riser = add(UNDERSLUNG)["mitchell-riser-6"];
    assert.deepEqual(riser.positions.map((p) => [p.slot, p.index, p.where]), [["adapter", 0, "on Baby sticks"]]);
  });

  test("on a Fisher: track is the only base item, and adapters go on the nose fitting", () => {
    const options = add(picksFor({ supportId: "fisher-11", noseId: "fisher-sle" }));
    assert.deepEqual(Object.values(options).filter((o) => o.component.category === "base").map((o) => o.id), ["round-track"]);
    assert.deepEqual(options["mitchell-riser-6"].positions.map((p) => p.where), ["on SLE — 4-way Level Head (Upright)"]);
    assert.ok(!options["fisher-sle"] && !options["fisher-lhe"], "the nose fitting is swapped, not added");
  });

  test("every offered position, applied, puts the item there and builds", () => {
    for (const start of [picksFor(), UNDERSLUNG, LAMBDA, picksFor({ baseItemIds: ["apple-half"], adapterIds: ["mitchell-riser-12"] })]) {
      for (const option of addOptions(seed, ...P, start)) {
        for (const at of option.positions) {
          const { picks } = revalidatePicks(seed, ...P, applyEdit(start, { op: "insert", slot: at.slot, index: at.index, id: option.id, mode: at.mode }));
          const ids = at.slot === "base" ? picks.baseItemIds : picks.adapterIds;
          assert.equal(ids[at.index], option.id, `${option.label} ${at.where}`);
          assert.doesNotThrow(() => chainOf(picks));
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Gear model: full apple faces as modes, the lambda (SPEC.md 3.1, 3.3)
// ---------------------------------------------------------------------------

describe("apple boxes: one item per size, a full apple's face is a mode", () => {
  const boxes = seed.components.filter((c) => c.kind === "apple-box");

  test("one component per box size; only the full apple has modes", () => {
    assert.equal(new Set(boxes.map((b) => b.boxSize)).size, boxes.length);
    for (const box of boxes) {
      if (box.boxSize === "full") {
        assert.deepEqual(box.modes.map((m) => [m.name, m.rise, m.orientation]), [["flat", 8, "flat"], ["12in", 12, "12in"], ["20in", 20, "20in"]]);
      } else {
        assert.equal(box.modes, undefined, box.id);
        assert.equal(box.orientation, "flat");
      }
    }
  });

  test("the face is chosen in the full apple's sheet, as a three-way control", () => {
    const entry = slotOptions(seed, ...P, picksFor({ baseItemIds: ["apple-full"] })).base.find((o) => o.id === "apple-full");
    const control = modeControl(entry.modes);
    assert.equal(control.type, "dropdown", "three states: drawn as a segmented choice");
    assert.deepEqual(control.entries.map((e) => e.label), ["#1 LA", "#2 Chicago", "#3 NY"]);
    const half = slotOptions(seed, ...P, picksFor({ baseItemIds: ["apple-half"] })).base.find((o) => o.id === "apple-half");
    assert.equal(modeControl(half.modes).type, "static", "a half apple is flat-only: nothing to choose");
  });

  test("turning a full apple on its face changes the rise, and survives revalidation", () => {
    const flat = chainOf(picksFor({ baseItemIds: ["apple-full"] }));
    const { picks, notes } = revalidatePicks(seed, ...P, applyEdit(picksFor({ baseItemIds: ["apple-full"] }), { op: "mode", slot: "base", index: 0, mode: "20in" }));
    assert.deepEqual(notes, []);
    assert.deepEqual(picks.baseModes, ["20in"]);
    const onEnd = chainOf(picks);
    assert.equal(onEnd.min - flat.min, 12);
    assert.equal(onEnd.baseItems[0].stability, "low");
  });

  test("a face that doesn't exist falls back to the first, with a note", () => {
    const { picks, notes } = revalidatePicks(seed, ...P, picksFor({ baseItemIds: ["apple-full"], baseModes: { "apple-full": "sideways" } }));
    assert.deepEqual(picks.baseModes, ["flat"], "the older keyed-by-id form is still read");
    assert.equal(notes.length, 1);
  });

  test("the solver tries every face, but never two faces of one box", () => {
    const chains = enumerateChains(seed, { packageId: P[0], buildId: P[1], maxBaseLayerItems: 2, maxAdapters: 0 });
    const faces = new Set(chains.flatMap((c) => c.baseItems.filter((b) => b.id === "apple-full").map((b) => b.mode)));
    assert.deepEqual([...faces].sort(), ["12in", "20in", "flat"]);
    for (const chain of chains) {
      const ids = chain.baseItems.map((b) => b.id);
      assert.equal(new Set(ids).size, ids.length);
    }
  });
});

describe("the Lambda 50: upright and underslung, cradling the camera", () => {
  const lambda = seed.components.find((c) => c.id === "lambda-50");

  test("two modes adjustable over 10–18″, the platform always facing up; underslung needs a down-facing mount", () => {
    assert.equal(lambda.name, "Lambda 50");
    assert.equal(lambda.adjustability, "adjustable");
    assert.deepEqual(lambda.modes.map((m) => [m.name, m.riseRange, m.cameraMountFacing, m.supportMountFacing]), [
      ["upright", { min: 10, max: 18 }, "up", "up"],
      ["underslung", { min: -18, max: -10 }, "up", "down"],
    ]);
    assert.equal(lambda.cradlesCamera, true);
  });

  test("underslung is rejected directly on sticks and on the SLE, and accepted under an offset plate's bottom side", () => {
    const hung = (over) => ({ ...picksFor({ headId: "lambda-50", plateIds: [], modeName: "underslung", attachName: "base" }), ...over });
    assert.throws(() => chainOf(hung()), /underslung mode needs a down-facing mount beneath it, but "Baby sticks"/);
    assert.throws(
      () => chainOf(hung({ supportId: "fisher-11", noseId: "fisher-sle", noseMode: "upright" })),
      /underslung mode needs a down-facing mount beneath it, but "SLE/
    );
    const underPlate = chainOf(LAMBDA);
    assert.equal(underPlate.mode.name, "underslung");
    assert.equal(underPlate.attach.name, "base", "the camera sits upright");
    const onFisher = chainOf(hung({ supportId: "fisher-11", noseId: "fisher-sle", noseMode: "upright", adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "bottom" } }));
    assert.equal(onFisher.mode.name, "underslung");
    // And the check screen agrees: not offered on the sticks, with the reason.
    const onSticks = slotOptions(seed, ...P, LAMBDA_UP).head.find((o) => o.id === lambda.id);
    const underslung = onSticks.modes.find((m) => m.name === "underslung");
    assert.equal(underslung.available, false);
    assert.match(underslung.reason, /needs a down-facing mount beneath the head/);
  });

  test("upright needs an up-facing mount: under an offset's bottom side it switches to underslung, camera still upright", () => {
    const { picks, notes } = revalidatePicks(seed, ...P, { ...LAMBDA, modeName: "upright" });
    assert.equal(picks.modeName, "underslung");
    assert.equal(picks.attachName, "base");
    assert.deepEqual(notes, [], "it follows from the offset the user turned over");
  });

  test("the camera is never inverted, and the reach spans both ends of the platform", () => {
    for (const picks of [LAMBDA, LAMBDA_UP]) assert.ok(!chainOf(picks).attach.inverted);
    const up = chainOf(LAMBDA_UP);
    const sticks = chainOf(picksFor());
    // Baby sticks 20–36″ and the A-cam block either way: 2575 +8½″ vs the lambda's +10″ to +18″.
    // The lambda takes the block's QR bottom directly; the 2575 needs the Euro plate (+¾″).
    assert.equal(up.min - sticks.min, 10 - (8.5 + 0.75));
    assert.equal(up.max - sticks.max, 18 - (8.5 + 0.75));
    assert.equal(up.adjustability, "adjustable");
  });
});

