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
import { checkVerdict, TIGHT_MARGIN } from "../src/verdict.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(path.join(root, "gear.json"), "utf8"));
const P = ["test-package", "build-placeholder"];

const picksFor = (over = {}) => ({
  baseItemIds: [],
  baseModes: {},
  supportId: "baby-sticks",
  supportMode: null,
  noseId: null,
  noseMode: null,
  adapterIds: [],
  adapterModes: {},
  headId: "oconnor-2575d",
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
const LAMBDA = picksFor({ headId: "head-lambda-placeholder", modeName: "underslung", attachName: "base" });
const available = (options) => options.filter((o) => o.available).map((o) => o.label);
const gap = (picks, slot, index) => insertOptions(seed, ...P, picks).find((g) => g.slot === slot && g.index === index);

// ---------------------------------------------------------------------------
// The verdict (SPEC.md 5.6)
// ---------------------------------------------------------------------------

describe("checkVerdict: one line, the tightest margin in plain words", () => {
  const chain = chainOf(picksFor()); // reach 35..51
  const verdict = (target) => checkVerdict(chain, target, evaluateChain(chain, target));

  test("feasible names the tightest margin and which side it's on", () => {
    const v = verdict({ type: "fixed", height: 42 });
    assert.equal(v.state, "feasible");
    assert.equal(v.text, "Reaches 42″ · 7″ to spare at bottom");
    assert.deepEqual(v.tightest, { side: "bottom", amount: 7 });
    assert.equal(verdict({ type: "fixed", height: 45 }).text, "Reaches 45″ · 6″ to spare at top");
  });

  test(`a margin under ${TIGHT_MARGIN}″ is feasible but tight, and says "only"`, () => {
    const v = verdict({ type: "fixed", height: 50.5 });
    assert.equal(v.state, "tight");
    assert.equal(v.text, "Reaches 50½″ · only ½″ to spare at top");
    assert.equal(verdict({ type: "fixed", height: 50 }).state, "feasible", "exactly 1″ is not tight");
  });

  test("inside the tolerance but past the end says so", () => {
    const v = verdict({ type: "fixed", height: 51.25 });
    assert.equal(v.state, "tight");
    assert.equal(v.text, "Reaches 51¼″ · ¼″ past the top, within tolerance");
  });

  test("infeasible gives the shortfall: too short, too tall, or not enough moveable travel", () => {
    assert.deepEqual(verdict({ type: "fixed", height: 54.5 }), { state: "infeasible", text: "3½″ too short", tightest: null });
    assert.equal(verdict({ type: "fixed", height: 31.5 }).text, "3½″ too tall");
    assert.equal(verdict({ type: "range", low: 38, high: 43 }).text, "Needs 5″ more moveable travel", "a tripod can't move live");
  });

  test("a moveable range weighs the travel left over, too", () => {
    // Fisher 11, SLE upright (−4″ to 0″): reach 28.875..66.25, with 33.375″ of beam.
    const dolly = chainOf(picksFor({ supportId: "fisher-11", noseId: "fisher-sle" }));
    const move = (low, high) => ({ type: "range", low, high });
    const verdictFor = (target) => checkVerdict(dolly, target, evaluateChain(dolly, target));
    assert.equal(verdictFor(move(30.875, 42.5)).text, "Covers 30¾–42½″ · 2″ to spare at bottom");
    const top = verdictFor(move(33.5, 66.25)); // 32.75″ of 33.375″ of beam, 0″ above
    assert.equal(top.state, "tight");
    assert.equal(top.text, "Covers 33½–66¼″ · only 0″ to spare at top");
    // The SLE's 4″ widens the reach, not the live move: this one barely fits the beam.
    const wide = verdictFor(move(31.5, 64.125)); // 32.625″ move, 0.75″ of beam left
    assert.deepEqual(wide.tightest, { side: "travel", amount: 0.75 });
    assert.equal(wide.text, "Covers 31½–64″ · only ¾″ of moveable travel to spare");

    // Legs plus a short boom: plenty of reach, but the move barely fits the boom.
    const legsAndBoom = { min: 0, max: 50, moveableInterval: { min: 0, max: 10.5 } };
    const shortMove = move(20, 30);
    const v2 = checkVerdict(legsAndBoom, shortMove, evaluateChain(legsAndBoom, shortMove));
    assert.deepEqual(v2.tightest, { side: "travel", amount: 0.5 });
    assert.equal(v2.text, "Covers 20–30″ · only ½″ of moveable travel to spare");
    const adjustable = { ...shortMove, rangeType: "adjustable" };
    assert.notEqual(checkVerdict(legsAndBoom, adjustable, evaluateChain(legsAndBoom, adjustable)).tightest.side, "travel", "travel only counts for a moveable range");
  });

  test("no target yet: the reach, and a prompt", () => {
    assert.deepEqual(checkVerdict(chain, null, null), { state: "waiting", text: "Reaches 35–51″ · enter a target", tightest: null });
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
        // An offset plate is drawn with its thickness, a camera with its body past the lens.
        if (b.component.plateLength || b.slot === "build") continue;
        assert.ok(close(b.box.height, (b.top - b.bottom) * scale, 0.3), `${b.slot}: ${b.box.height} vs ${(b.top - b.bottom) * scale}`);
        assert.ok(close(b.box.y, layout.floor.y - b.top * scale, 0.3) || b.bottom < 0, `${b.slot} top at its height`);
      }
    }
  });

  test("true scale on both axes: one inch is the same pixels across as up", () => {
    const tripodRig = stackLayout(chainOf(picksFor()), null, { frame: { width: 320, height: 520 } });
    const { scale } = tripodRig.frame;
    assert.ok(close(tripodRig.blocks[0].shape.topWidth, 4 * scale, 0.05), "the tripod's 4″ top");
    assert.ok(close(tripodRig.blocks[2].shape.body.width, 11 * scale, 0.1), "an 11″ camera body");
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
    assert.equal(at(layout, "build").top, at(layout, "head").bottom, "the camera hangs from the head");
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

  test("the lambda cradles its camera: same position, the camera on the bracket", () => {
    const layout = stackLayout(chainOf(LAMBDA), { type: "fixed", height: 22 });
    const [, head, camera] = layout.blocks;
    assert.equal(camera.x, head.x);
    assert.equal(camera.cradled, true);
    assert.equal(head.shape.type, "lambda");
    assert.equal(head.shape.hangs, true);
    assert.equal(camera.bottom, head.bottom, "the camera sits on the bracket at the bottom of the head");
    const over = stackLayout(chainOf({ ...LAMBDA, modeName: "overslung" }), null);
    assert.equal(over.blocks[1].shape.hangs, false);
    assert.equal(over.blocks[2].x, over.blocks[1].x);
  });

  test("the scale fits the content: the reach rail is clipped, not the drawing stretched", () => {
    const chain = chainOf(picksFor({ supportId: "fisher-11", noseId: "fisher-sle" })); // reach 28.875..66.25
    const layout = stackLayout(chain, { type: "fixed", height: 30 }, { frame: { width: 400, height: 520 } });
    assert.equal(layout.lens.height, 30);
    // The current rig tops out at the push posts, 39¾″: the drawing fits that, not the 63¾″ reach.
    assert.ok(layout.lens.pct > 60 && layout.lens.pct < 90, `the lens at ${layout.lens.pct}%, under the push posts`);
    assert.deepEqual([layout.reach.min, layout.reach.max], [28.875, 66.25], "the rail is labeled with the real reach");
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
    assert.equal(layout.gaps.length, 4);
    const hung = stackLayout(chainOf(UNDERSLUNG), null);
    assert.equal(hung.gaps.find((x) => x.slot === "adapter" && x.index === 1).x, 10, "on the far end of the plate");
  });

  test("nothing is marked estimated: all gear values are treated as correct", () => {
    const layout = stackLayout(chainOf(picksFor({ adapterIds: ["mitchell-riser-6"] })), null);
    assert.equal(layout.estimated, undefined);
    for (const b of layout.blocks) assert.equal(b.estimated, undefined, b.slot);
  });
});

describe("stackLayout: tags beside the pieces", () => {
  const overlap = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  test("each piece's tag is its short name from the gear", () => {
    const layout = stackLayout(chainOf(picksFor({ supportId: "fisher-11", noseId: "fisher-sle", adapterIds: ["mitchell-riser-6"] })), null);
    assert.deepEqual(layout.blocks.map((b) => b.tag.lines[0]), ["Fisher 11", "SLE", "Riser 6″", "2575", "Camera"]);
    assert.equal(layout.lane, undefined, "no label column");
  });

  test("an inverted camera's tag says so, once", () => {
    const camera = stackLayout(chainOf(UNDERSLUNG), null).blocks.at(-1);
    assert.deepEqual(camera.tag.lines, ["Camera", "Camera inverted — flip image"]);
    assert.equal(camera.tag.warn, true);
    assert.equal(stackLayout(chainOf(picksFor()), null).blocks.at(-1).tag.lines.length, 1);
  });

  test("tags never overlap each other and stay inside the drawing, across a spread of rigs", () => {
    const rigs = [
      picksFor(),
      UNDERSLUNG,
      LAMBDA,
      picksFor({ baseItemIds: ["apple-quarter", "apple-half"], adapterIds: ["mitchell-riser-6", "mitchell-offset-10"] }),
      picksFor({ supportId: "fisher-11", noseId: "fisher-lhe" }),
      picksFor({ supportId: "fisher-11", noseId: "fisher-sle", baseItemIds: ["round-track"], supportMode: "etw", adapterIds: ["mitchell-riser-6"] }),
    ];
    for (const picks of rigs) {
      for (const target of [null, { type: "fixed", height: 20 }, { type: "fixed", height: 60 }]) {
        const layout = stackLayout(chainOf(picks), target, { frame: { width: 330, height: 520 } });
        const tags = layout.blocks.map((b) => b.tag);
        for (let i = 0; i < tags.length; i++) {
          assert.ok(tags[i].x >= 0 && tags[i].x + tags[i].width <= 330.5, `${layout.blocks[i].slot} tag across`);
          for (let j = i + 1; j < tags.length; j++) assert.ok(!overlap(tags[i], tags[j]), `${JSON.stringify(picks)}: tags ${i} and ${j}`);
        }
      }
    }
  });

  test("a tag sits beside its piece: to the right when there's room", () => {
    const layout = stackLayout(chainOf(picksFor()), null, { frame: { width: 330, height: 520 } });
    const head = layout.blocks.find((b) => b.slot === "head");
    assert.ok(head.tag.x >= head.box.x + head.box.width, "right of the head");
    assert.ok(Math.abs(head.tag.y + head.tag.height / 2 - head.anchorY) < 1, "level with it");
  });
});

// ---------------------------------------------------------------------------
// Editing in place (SPEC.md 5.9)
// ---------------------------------------------------------------------------

describe("insertOptions: only what legally fits at that exact point", () => {
  test("on a tripod: apple boxes and rolling spreaders at the floor; risers and either offset mode on the support", () => {
    assert.deepEqual(available(gap(picksFor(), "base", 0).options), [
      "Quarter Apple Box", "Half Apple Box", "Full Apple Box (Flat, 8″)", "Full Apple Box (12″ face)", "Full Apple Box (20″ face)",
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
    const track = gap(picksFor(), "base", 0).options.find((o) => o.id === "square-track");
    assert.equal(track.available, false);
    assert.match(track.reason, /Baby sticks sits on the floor or rolling spreaders, not on square track/);
  });

  test("on a Fisher: only track at the floor (round track by switching wheels), and adapters sit on the nose fitting", () => {
    const dolly = picksFor({ supportId: "fisher-11", noseId: "fisher-sle" });
    assert.deepEqual(available(gap(dolly, "base", 0).options), ["Square Track", "Round Track"]);
    const apple = gap(dolly, "base", 0).options.find((o) => o.id === "apple-half");
    assert.match(apple.reason, /apple boxes can't go under a dolly/);
    assert.equal(gap(dolly, "adapter", 0).where, "on SLE — 4-way Level Head (Upright)");
    assert.equal(insertOptions(seed, ...P, { ...dolly, noseId: null }).some((g) => g.slot === "adapter"), false, "no nose fitting, nothing to stack adapters on");
  });

  test("nothing stacks on top of track, and nothing is offered on an underslung offset", () => {
    const onTrack = picksFor({ supportId: "fisher-11", noseId: "fisher-sle", baseItemIds: ["square-track"] });
    assert.deepEqual(available(gap(onTrack, "base", 1).options), []);
    assert.match(gap(onTrack, "base", 1).options.find((o) => o.id === "apple-half").reason, /needs the floor beneath it, but Square Track ends in square track/);
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
    // The lambda head's one mode needs an up-facing mount: an underslung offset would clear it.
    const onLambda = gap(LAMBDA, "adapter", 0).options.find((o) => o.label === "Mitchell Offset, 10″ (Bottom of the plate)");
    assert.equal(onLambda.available, false);
    assert.match(onLambda.reason, /Lambda Head/);
  });

  test("something already in the rig isn't offered again", () => {
    const withBox = picksFor({ baseItemIds: ["apple-half"] });
    const again = gap(withBox, "base", 1).options.find((o) => o.id === "apple-half");
    assert.equal(again.available, false);
    assert.match(again.reason, /already in the rig/);
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
    assert.deepEqual(available(swapOptions(seed, ...P, picksFor(), "head")), ["Lambda Head"]);
    assert.deepEqual(available(swapOptions(seed, ...P, UNDERSLUNG, "head")), [], "the lambda needs an up-facing mount");
  });

  test("an adapter swaps in its place: the underslung offset for a riser", () => {
    const options = swapOptions(seed, ...P, UNDERSLUNG, "adapter", 0);
    assert.deepEqual(available(options), [
      'Mitchell Riser 3"', 'Mitchell Riser 6"', 'Mitchell Riser 12"', 'Mitchell Riser 18"', 'Mitchell Riser 24"',
      "Mitchell Offset, 24″ (Top of the plate)", "Mitchell Offset, 24″ (Bottom of the plate)",
      "Rotating Offset",
    ]);
    assert.ok(!options.some((o) => o.id === "mitchell-offset-10"), "the piece itself isn't a swap");
  });

  test("a base item swaps in its place", () => {
    const options = swapOptions(seed, ...P, picksFor({ baseItemIds: ["apple-half"] }), "base", 0);
    assert.ok(available(options).includes("Full Apple Box (Flat, 8″)"));
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

  test("inserting the offset underslung takes the head and camera with it, with notes", () => {
    const { picks, notes } = next(picksFor(), { op: "insert", slot: "adapter", index: 0, id: "mitchell-offset-10", mode: "bottom" });
    assert.deepEqual(picks, UNDERSLUNG);
    assert.equal(notes.length, 2);
  });

  test("remove, and what depended on it switches back", () => {
    const { picks, notes } = next(UNDERSLUNG, { op: "remove", slot: "adapter", index: 0 });
    assert.deepEqual(picks, picksFor());
    assert.match(notes[0], /Switched the head to normal mode/);
  });

  test("swap a base item, a support, a head", () => {
    assert.deepEqual(next(picksFor({ baseItemIds: ["apple-half"] }), { op: "swap", slot: "base", index: 0, id: "apple-full" }).picks.baseItemIds, ["apple-full"]);
    const onDolly = next(picksFor(), { op: "swap", slot: "support", id: "fisher-11" }).picks;
    assert.deepEqual([onDolly.supportId, onDolly.supportMode, onDolly.noseId], ["fisher-11", "pneumatic", null]);
    assert.equal(missingSlot(seed, ...P, onDolly), "nose", "a Fisher asks for its nose fitting next");
    const withNose = next(onDolly, { op: "swap", slot: "nose", id: "fisher-sle" }).picks;
    assert.deepEqual([withNose.noseId, withNose.noseMode], ["fisher-sle", "upright"]);
    assert.equal(missingSlot(seed, ...P, withNose), null);
    const lambda = next(picksFor(), { op: "swap", slot: "head", id: "head-lambda-placeholder" }).picks;
    assert.deepEqual([lambda.headId, lambda.modeName, lambda.attachName], ["head-lambda-placeholder", "underslung", "base"]);
  });

  test("swapping the Fisher for a tripod clears the nose fitting, with a note, and keeps the adapters", () => {
    const start = picksFor({ supportId: "fisher-11", noseId: "fisher-sle", adapterIds: ["mitchell-riser-6"] });
    const { picks, notes } = next(start, { op: "swap", slot: "support", id: "baby-sticks" });
    assert.equal(picks.noseId, null);
    assert.deepEqual(picks.adapterIds, ["mitchell-riser-6"]);
    assert.match(notes[0], /^Cleared SLE — 4-way Level Head\. It mounts on a Fisher beam nose/);
  });

  test("mode edits: an adapter's mode, the head's, the camera's mount", () => {
    const flipped = next(picksFor({ adapterIds: ["mitchell-offset-10"], adapterModes: { "mitchell-offset-10": "top" } }), {
      op: "mode", slot: "adapter", index: 0, mode: "bottom",
    }).picks;
    assert.equal(flipped.modeName, "underslung");
    assert.equal(next(UNDERSLUNG, { op: "mode", slot: "build", mode: "top-handle" }).picks.attachName, "top-handle");
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
      picksFor({ supportId: "fisher-11", noseId: "fisher-sle", baseItemIds: ["square-track"] }),
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
    assert.ok(!options["square-track"], "a tripod can't stand on track, so track isn't offered");
    assert.ok(!options["dolly-low-mode-placeholder"], "dolly-only adapters aren't offered on a tripod");
  });

  test("several legal positions are listed in plain words", () => {
    const options = add(picksFor({ baseItemIds: ["apple-half"], adapterIds: ["mitchell-riser-12"] }));
    assert.deepEqual(options["apple-quarter"].positions.map((p) => p.where), ["on the floor", "on Half Apple Box"]);
    assert.deepEqual(options["mitchell-riser-6"].positions.map((p) => p.where), ["on Baby sticks", "under O'Connor 2575D"]);
    assert.ok(!options["apple-half"], "already in the rig");
  });

  test("a position is only offered where the item really fits: nothing goes on an underslung offset", () => {
    const riser = add(UNDERSLUNG)["mitchell-riser-6"];
    assert.deepEqual(riser.positions.map((p) => [p.slot, p.index, p.where]), [["adapter", 0, "on Baby sticks"]]);
  });

  test("on a Fisher: track is the only base item, and adapters go on the nose fitting", () => {
    const options = add(picksFor({ supportId: "fisher-11", noseId: "fisher-sle" }));
    assert.deepEqual(Object.values(options).filter((o) => o.component.category === "base").map((o) => o.id), ["square-track", "round-track"]);
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
    assert.deepEqual(control.entries.map((e) => e.label), ["Flat, 8″", "12″ face", "20″ face"]);
    const half = slotOptions(seed, ...P, picksFor({ baseItemIds: ["apple-half"] })).base.find((o) => o.id === "apple-half");
    assert.equal(modeControl(half.modes).type, "static", "a half apple is flat-only: nothing to choose");
  });

  test("turning a full apple on its face changes the rise, and survives revalidation", () => {
    const flat = chainOf(picksFor({ baseItemIds: ["apple-full"] }));
    const { picks, notes } = revalidatePicks(seed, ...P, applyEdit(picksFor({ baseItemIds: ["apple-full"] }), { op: "mode", slot: "base", index: 0, mode: "20in" }));
    assert.deepEqual(notes, []);
    assert.deepEqual(picks.baseModes, { "apple-full": "20in" });
    const onEnd = chainOf(picks);
    assert.equal(onEnd.min - flat.min, 12);
    assert.equal(onEnd.baseItems[0].stability, "low");
  });

  test("a face that doesn't exist falls back to the first, with a note", () => {
    const { picks, notes } = revalidatePicks(seed, ...P, picksFor({ baseItemIds: ["apple-full"], baseModes: { "apple-full": "sideways" } }));
    assert.deepEqual(picks.baseModes, { "apple-full": "flat" });
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

describe("the lambda head: underslung and overslung, cradling the camera", () => {
  const lambda = seed.components.find((c) => c.id === "head-lambda-placeholder");

  test("two ~13″ modes, both with an up-facing camera mount", () => {
    assert.deepEqual(lambda.modes.map((m) => [m.name, m.rise, m.cameraMountFacing, m.supportMountFacing]), [
      ["underslung", -13, "up", "up"],
      ["overslung", 13, "up", "up"],
    ]);
    assert.equal(lambda.cradlesCamera, true);
  });

  test("its modes are a toggle, and the camera stays upright either way", () => {
    const entry = slotOptions(seed, ...P, LAMBDA).head.find((o) => o.id === lambda.id);
    const control = modeControl(entry.modes);
    assert.equal(control.type, "toggle");
    assert.deepEqual([control.on.name, control.off.name], ["underslung", "overslung"]);
    const { picks, notes } = revalidatePicks(seed, ...P, applyEdit(LAMBDA, { op: "mode", slot: "head", mode: "overslung" }));
    assert.deepEqual(notes, []);
    assert.equal(picks.attachName, "base");
    assert.equal(chainOf(picks).max - chainOf(LAMBDA).max, 26);
  });
});
