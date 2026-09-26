// The version note (SPEC.md 7).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { VERSION, UPDATED, versionNote } from "../src/version.js";

test("one version, matching package.json, with a valid update time", () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version, VERSION);
  assert.ok(!Number.isNaN(Date.parse(UPDATED)));
});

test("the note shows the version and the update date and time", () => {
  const note = versionNote("en-US");
  assert.ok(note.startsWith(`v${VERSION} · Updated `));
  assert.match(note, /2026/);
  assert.match(note, /\d:\d\d/);
});
