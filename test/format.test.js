// Display formatting (SPEC.md 7): every height, rise, and margin to the
// nearest ¼″, as a fraction, from one function in src/format.js.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { inches, inchesSpan, signedInches } from "../src/format.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("inches: nearest ¼″, as a fraction", () => {
  test("whole numbers and quarters", () => {
    assert.equal(inches(6), "6″");
    assert.equal(inches(17.75), "17¾″");
    assert.equal(inches(13.75), "13¾″");
    assert.equal(inches(20.5), "20½″");
    assert.equal(inches(3.25), "3¼″");
  });

  test("rounds to the nearest quarter; an exact eighth rounds toward zero", () => {
    assert.equal(inches(17.875), "17¾″", "the Fisher's reference height, as it's called on set");
    assert.equal(inches(13.875), "13¾″");
    assert.equal(inches(36.375), "36¼″");
    assert.equal(inches(17.9), "18″", "past the halfway point rounds up");
    assert.equal(inches(6.1), "6″");
    assert.equal(inches(6.2), "6¼″");
    assert.equal(inches(0.6), "½″", "no leading zero");
  });

  test("zero is 0″; something that rounds to zero is <¼″, never 0", () => {
    assert.equal(inches(0), "0″");
    assert.equal(inches(-0), "0″");
    assert.equal(inches(0.1), "<¼″");
    assert.equal(inches(0.125), "<¼″", "an eighth short is still short");
    assert.equal(inches(-0.1), "−<¼″");
    assert.equal(inches(0.13), "¼″");
  });

  test("negatives use a real minus sign", () => {
    assert.equal(inches(-4), "−4″");
    assert.equal(inches(-14.875), "−14¾″", "toward zero on the tie, whichever the sign");
  });
});

describe("signedInches and inchesSpan", () => {
  test("a rise is signed unless it's zero", () => {
    assert.equal(signedInches(6), "+6″");
    assert.equal(signedInches(-13), "−13″");
    assert.equal(signedInches(0), "0″");
    assert.equal(signedInches(17.375), "+17¼″");
    assert.equal(signedInches(0.05), "+<¼″");
  });

  test("a span has one unit mark", () => {
    assert.equal(inchesSpan(20, 32.5), "20–32½″");
    assert.equal(inchesSpan(26.375, 63.75), "26¼–63¾″");
    assert.equal(inchesSpan(-3, 4), "−3–4″");
  });
});

describe("the fraction formatter is the only one", () => {
  test("app.js and verdict.js format through src/format.js; nothing else rounds for display", () => {
    const app = readFileSync(path.join(root, "app.js"), "utf8");
    const verdict = readFileSync(path.join(root, "src/verdict.js"), "utf8");
    assert.match(app, /from "\.\/src\/format\.js"/);
    assert.match(verdict, /from "\.\/format\.js"/);
    for (const source of [app, verdict, readFileSync(path.join(root, "src/stack.js"), "utf8"), readFileSync(path.join(root, "src/rules.js"), "utf8")]) {
      assert.doesNotMatch(source, /Intl\.NumberFormat|toFixed\(|toPrecision\(/);
    }
  });
});
