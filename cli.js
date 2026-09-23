#!/usr/bin/env node
// Command-line runner for the solver, for quick checks against gear.json
// without a UI. No dependencies; plain ES module (see package.json).
//
// Usage:
//   node cli.js <height> <packageId> <buildId>
//   node cli.js <low> <high> <packageId> <buildId>
//
// Examples:
//   node cli.js 32 test-package build-placeholder
//   node cli.js 25 40 test-package build-placeholder

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { supportInterval } from "./src/model.js";
import { solve, margin } from "./src/solver.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function usageAndExit() {
  console.error("Usage: node cli.js <height> <packageId> <buildId>");
  console.error("       node cli.js <low> <high> <packageId> <buildId>");
  console.error("");
  console.error("Examples:");
  console.error("  node cli.js 32 test-package build-placeholder");
  console.error("  node cli.js 25 40 test-package build-placeholder");
  process.exit(1);
}

function isNumeric(value) {
  return value !== undefined && value !== "" && !Number.isNaN(Number(value));
}

function parseArgs(argv) {
  let target;
  let rest;

  if (isNumeric(argv[0]) && isNumeric(argv[1])) {
    const a = Number(argv[0]);
    const b = Number(argv[1]);
    target = { type: "range", low: Math.min(a, b), high: Math.max(a, b) };
    rest = argv.slice(2);
  } else if (isNumeric(argv[0])) {
    target = { type: "fixed", height: Number(argv[0]) };
    rest = argv.slice(1);
  } else {
    usageAndExit();
  }

  const [packageId, buildId] = rest;
  if (!packageId || !buildId) usageAndExit();

  return { target, packageId, buildId };
}

function formatTarget(target) {
  return target.type === "fixed" ? `${target.height}"` : `${target.low}"-${target.high}"`;
}

function signed(n) {
  const rounded = Math.round(n * 100) / 100;
  return (rounded >= 0 ? "+" : "") + rounded.toFixed(2) + '"';
}

function signedMargin(n) {
  const rounded = Math.round(n * 10) / 10;
  return (rounded >= 0 ? "+" : "") + rounded.toFixed(1);
}

function printChain(index, chain, target) {
  console.log(`${index}. ${chain.support.name} + ${chain.head.name} [${chain.mode.name}] + ${chain.build.name} [${chain.attach.name}]`);

  for (const item of chain.baseItems) {
    console.log(`     base       ${item.name.padEnd(38)} ${signed(item.rise)}`);
  }

  const supportRange = supportInterval(chain.support);
  console.log(
    `     support    ${chain.support.name.padEnd(38)} ${signed(supportRange.min)} to ${signed(supportRange.max)}`
  );
  console.log(
    `     head       ${chain.head.name.padEnd(38)} ${signed(chain.mode.rise)}  (${chain.mode.name}, faces ${chain.mode.cameraMountFacing})`
  );
  const invertedNote = chain.attach.inverted ? " (inverted)" : "";
  console.log(
    `     build      ${chain.build.name.padEnd(38)} ${signed(chain.attach.rise)}  (${chain.attach.name}${invertedNote})`
  );

  const m = margin(chain, target);
  console.log(
    `     interval: ${chain.min.toFixed(2)}" - ${chain.max.toFixed(2)}"    margin: ${signedMargin(m.below)} / ${signedMargin(m.above)}`
  );
  console.log("");
}

function main() {
  const { target, packageId, buildId } = parseArgs(process.argv.slice(2));

  const gear = JSON.parse(readFileSync(path.join(__dirname, "gear.json"), "utf8"));

  let result;
  try {
    result = solve(gear, { target, packageId, buildId });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  console.log(`Target: ${formatTarget(target)}    Package: ${packageId}    Build: ${buildId}`);
  console.log("");

  if (result.feasible.length === 0) {
    console.log("No feasible configuration.");
    console.log("");
    console.log(result.fallback.message);
    process.exit(1);
  }

  result.feasible.forEach((chain, i) => printChain(i + 1, chain, target));
}

main();
