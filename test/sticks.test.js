// Sticks, rolling spreaders, and the O'Connor 2575D (SPEC.md 3.1, 3.2, 3.3).

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { buildChain } from "../src/solver.js";
import { supportInterval } from "../src/model.js";
import { slotOptions } from "../src/rules.js";
import { stackLayout } from "../src/stack.js";
import { outlineOf } from "../src/outlines.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const seed = JSON.parse(readFileSync(path.join(root, "gear.json"), "utf8"));
const P = ["test-package", "build-placeholder"];
const byId = (id) => seed.components.find((c) => c.id === id);
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
const opts = (over) => slotOptions(seed, ...P, picksFor(over));
const option = (list, id) => list.find((o) => o.id === id);

describe("sticks", () => {
  test("baby sticks 20–36″ and standard sticks 36–66″, adjustable, same mounts", () => {
    const baby = byId("baby-sticks");
    const standard = byId("standard-sticks");
    assert.equal(baby.name, "Baby sticks");
    assert.equal(baby.shortName, "Baby sticks");
    assert.equal(standard.name, "Standard sticks");
    assert.equal(standard.shortName, "Standards");
    assert.deepEqual(supportInterval(baby), { min: 20, max: 36 });
    assert.deepEqual(supportInterval(standard), { min: 36, max: 66 });
    for (const sticks of [baby, standard]) {
      assert.equal(sticks.adjustability, "adjustable");
      assert.equal(sticks.kind, "tripod");
    }
    assert.deepEqual(standard.bottomMount, baby.bottomMount);
    assert.equal(standard.topMount, baby.topMount);
    assert.ok(!byId("tripod-baby-placeholder"), "the old name is gone");
  });
});

describe("O'Connor 2575D", () => {
  test("+8.5″ on a Mitchell base, with an underslung mode at −8.5″", () => {
    const head = byId("oconnor-2575d");
    assert.equal(head.name, "O'Connor 2575D");
    assert.equal(head.shortName, "2575");
    assert.equal(head.bottomMount, "mitchell");
    assert.deepEqual(head.modes.map((m) => [m.name, m.rise]), [["normal", 8.5], ["underslung", -8.5]]);
    assert.ok(!byId("head-standard-placeholder"), "the old name is gone");
  });

  test("the rise lands in the chain: baby sticks + 2575 + camera", () => {
    const chain = chainOf(picksFor());
    const standard = chainOf(picksFor({ supportId: "standard-sticks" }));
    assert.equal(standard.min - chain.min, 16, "standard sticks start 16″ higher");
    assert.equal(standard.max - chain.max, 30);
  });
});

describe("rolling spreaders", () => {
  test("+3″, fixed, a base item that sits on the bare floor", () => {
    const spreaders = byId("rolling-spreaders");
    assert.equal(spreaders.category, "base");
    assert.equal(spreaders.rise, 3);
    assert.equal(spreaders.adjustability, "fixed");
    assert.equal(spreaders.shortName, "Spreaders");
    const on = chainOf(picksFor({ baseItemIds: ["rolling-spreaders"] }));
    const off = chainOf(picksFor());
    assert.equal(on.min - off.min, 3);
    assert.equal(on.max - off.max, 3);
  });

  test("only sticks sit on them: not hi-hats, low hats, or the dolly", () => {
    const on = opts({ baseItemIds: ["rolling-spreaders"], supportId: null, headId: null, modeName: null, attachName: null });
    assert.equal(option(on.support, "baby-sticks").available, true);
    assert.equal(option(on.support, "standard-sticks").available, true);
    for (const id of ["hihat-placeholder", "lohat-placeholder", "fisher-11"]) {
      assert.equal(option(on.support, id).available, false, id);
      assert.match(option(on.support, id).reason, /not on rolling spreaders/, id);
    }
    for (const id of ["hihat-placeholder", "lohat-placeholder", "fisher-11"]) {
      assert.throws(() => chainOf(picksFor({ baseItemIds: ["rolling-spreaders"], supportId: id })), undefined, id);
    }
  });

  test("nothing goes underneath: not an apple box, not track", () => {
    for (const under of ["apple-half", "apple-full", "square-track"]) {
      const o = opts({ baseItemIds: [under], supportId: null, headId: null, modeName: null, attachName: null });
      assert.equal(option(o.base, "rolling-spreaders").available, false, under);
      assert.match(option(o.base, "rolling-spreaders").reason, /bare floor only — nothing goes underneath/, under);
      assert.throws(() => chainOf(picksFor({ baseItemIds: [under, "rolling-spreaders"] })), undefined, under);
    }
    const onFloor = opts({ baseItemIds: [], supportId: null, headId: null, modeName: null, attachName: null });
    assert.equal(option(onFloor.base, "rolling-spreaders").available, true);
  });

  test("nothing stacks on them but sticks: an apple box on spreaders is rejected", () => {
    const o = opts({ baseItemIds: ["rolling-spreaders"], supportId: null, headId: null, modeName: null, attachName: null });
    assert.equal(option(o.base, "apple-half").available, false);
  });

  test("drawn as a low wheeled spreader, under the tripod's feet", () => {
    const layout = stackLayout(chainOf(picksFor({ supportId: "standard-sticks", baseItemIds: ["rolling-spreaders"] })), null, {
      frame: { width: 320, height: 520 },
    });
    const [spreaders, sticks] = layout.blocks;
    assert.equal(spreaders.shape.type, "spreader");
    assert.equal(sticks.start, spreaders.end, "the sticks stand on the spreaders");
    assert.ok(spreaders.box.x <= sticks.box.x && spreaders.box.x + spreaders.box.width >= sticks.box.x + sticks.box.width, "wider than the feet");
    const svg = outlineOf(spreaders);
    assert.equal((svg.match(/class="o k-fixed wheel"/g) || []).length, 3, "casters");
    assert.equal(spreaders.tag.lines[0], "Spreaders");
  });
});
