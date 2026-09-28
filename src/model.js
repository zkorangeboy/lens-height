// Data model for the Lens Height Solver. See SPEC.md sections 1-4.
// Plain ES module, no build step: usable from <script type="module"> or Node.

/**
 * Deep-merge the override layer (SPEC.md 4.1) onto the seed gear data.
 * Overrides win. customComponents are appended (or replace a seed
 * component of the same id, so a user can fully redefine a placeholder).
 *
 * @param {object} seed - parsed gear.json
 * @param {object} [overridesDoc] - parsed overrides object, same shape as
 *   the export format in SPEC.md 4.1
 * @returns {object} merged gear data, safe to hand to the solver
 */
export function mergeOverrides(seed, overridesDoc) {
  const merged = structuredClone(seed);

  if (!overridesDoc) return merged;

  const overrides = overridesDoc.overrides || {};
  for (const component of merged.components) {
    const fieldOverrides = overrides[component.id];
    if (fieldOverrides) deepAssign(component, fieldOverrides);
  }

  const customComponents = overridesDoc.customComponents || [];
  for (const custom of customComponents) {
    const existingIndex = merged.components.findIndex((c) => c.id === custom.id);
    if (existingIndex >= 0) {
      merged.components[existingIndex] = custom;
    } else {
      merged.components.push(custom);
    }
  }

  return merged;
}

function deepAssign(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepAssign(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function componentsById(gear) {
  return Object.fromEntries(gear.components.map((c) => [c.id, c]));
}

export function getPackage(gear, packageId) {
  const pkg = gear.packages.find((p) => p.id === packageId);
  if (!pkg) throw new Error(`Unknown package: ${packageId}`);
  return pkg;
}

export function getPackageComponents(gear, packageId) {
  const byId = componentsById(gear);
  return getPackage(gear, packageId).componentIds.map((id) => byId[id]);
}

export function getBuild(gear, buildId) {
  const build = gear.builds.find((b) => b.id === buildId);
  if (!build) throw new Error(`Unknown build: ${buildId}`);
  return build;
}

/**
 * A camera block's pieces as rigged (SPEC.md 3.4): `pieceIds` bottom to top
 * (stripped, or with a plate added), or the block as defined.
 */
export function blockPieces(build, gear, pieceIds = build.componentIds) {
  const byId = componentsById(gear);
  return (pieceIds || build.componentIds).map((id) => byId[id]).filter(Boolean);
}

/** Whether `piece` is the bottom of the block as defined: while it's there,
 * the block is whole and presents its own `bottomInterface` (3.4). */
function isWholeBottom(build, piece) {
  return Boolean(build.bottomInterface) && piece?.id === build.componentIds[0];
}

/** The interface at a piece's bottom within a block: the block's
 * `bottomInterface` (the A-cam's QR) under its defined bottom piece, else
 * the piece's own bottom (SPEC.md 3.4). */
export function pieceBottom(build, piece) {
  return isWholeBottom(build, piece) ? build.bottomInterface : piece?.bottomMount;
}

/** A piece's rise: its `rise`, or the camera's optical center above its base. */
export function pieceRise(piece) {
  return (piece.rise !== undefined ? piece.rise : piece.opticalCenterAboveBase) || 0;
}

/**
 * A camera block's rise, per SPEC.md 3.4: the sum of its pieces' rises, from
 * the bottom of its bottom piece to the lens's optical center.
 */
export function buildTotalRise(build, gear, pieceIds) {
  return blockPieces(build, gear, pieceIds).reduce((sum, piece) => sum + pieceRise(piece), 0);
}

/**
 * The attach points a camera block exposes (SPEC.md 3.4), by its bottom
 * piece's bottom interface (or the block's own `bottomMount`, in older
 * data). "base" is upright; "base-inverted" is the whole block hanging
 * inverted, its rise negated; "top-handle" only when the block declares a
 * rated handle.
 */
export function buildAttachPoints(build, gear, pieceIds) {
  const pieces = blockPieces(build, gear, pieceIds);
  const totalRise = buildTotalRise(build, gear, pieceIds);
  const mount = build.bottomMount ?? pieceBottom(build, pieces[0]);
  // Named when it's a piece's own bottom; a whole block's QR bottom is the block's.
  const bottomName = build.bottomMount || isWholeBottom(build, pieces[0]) ? null : pieces[0]?.name;
  const common = { mount, bottomName, blockName: build.name || build.id };
  const points = [
    { name: "base", ...common, facing: "down", rise: totalRise, inverted: false },
    { name: "base-inverted", ...common, facing: "up", rise: -totalRise, inverted: true },
  ];
  if (build.hasRatedTopHandle) {
    points.push({ name: "top-handle", ...common, facing: "up", rise: build.topHandleOffset, inverted: false });
  }
  return points;
}

/**
 * A support's achievable rise interval, using practical (not spec)
 * figures, with levelingLoss subtracted from the top (SPEC.md 3.2).
 * Handles plain-range supports (tripods, hi-hats) and dolly-style
 * supports, whose base segment is either a fixed `baseRise` or an
 * adjustable `legRange` (a telescoping column) stacked under `boomRange`.
 */
export function supportInterval(support) {
  return shift(bareSupportInterval(support), support.modeRise);
}

/** A support mode's rise (a dolly's wheel set, SPEC.md 3.2) lifts or lowers
 * the whole support, so every support figure moves by it. */
const shift = (range, by = 0) => ({ min: range.min + by, max: range.max + by });

function bareSupportInterval(support) {
  if (support.boomRange) {
    const legMin = support.legRange ? support.legRange.practicalMin : support.baseRise || 0;
    const legMax = support.legRange ? support.legRange.practicalMax : support.baseRise || 0;
    return {
      min: legMin + support.boomRange.practicalMin,
      max: legMax + support.boomRange.practicalMax - (support.levelingLoss || 0),
    };
  }
  if (support.riseRange) {
    return {
      min: support.riseRange.practicalMin,
      max: support.riseRange.practicalMax - (support.levelingLoss || 0),
    };
  }
  const fixed = support.rise || 0;
  return { min: fixed, max: fixed };
}

/**
 * The interval a support can cover with *live* movement alone (SPEC.md
 * 3.5 / 5.2): the same shape as supportInterval, but counting only range
 * contributed by a `moveable` component. `legRange` (adjustable — legs
 * reposition between setups, not during a take) is deliberately excluded
 * here even though it counts toward supportInterval; only `boomRange`
 * (or a plain `riseRange` support whose own adjustability is `moveable`)
 * does. A support with no moveable range collapses to a zero-width point.
 */
export function supportMoveableInterval(support) {
  return shift(bareSupportMoveableInterval(support), support.modeRise);
}

function bareSupportMoveableInterval(support) {
  if (support.boomRange) {
    const base = support.baseRise || 0; // fixed, not legRange — legs are excluded
    return {
      min: base + support.boomRange.practicalMin,
      max: base + support.boomRange.practicalMax - (support.levelingLoss || 0),
    };
  }
  if (support.riseRange && support.adjustability === "moveable") {
    return {
      min: support.riseRange.practicalMin,
      max: support.riseRange.practicalMax - (support.levelingLoss || 0),
    };
  }
  return { min: 0, max: 0 };
}

/**
 * A support's range as stacked segments, bottom to top, so a
 * renderer can draw the fixed base, the adjustable extension, and the
 * moveable extension apart. Each segment has a `kind` (SPEC.md 3.5), a
 * `base` (its rise fully retracted) and an `extent` (how much further it
 * can extend). The bases sum to supportInterval's min, and bases plus
 * extents to its max; levelingLoss comes off the top segment's extent.
 */
export function supportSegments(support) {
  const [first, ...rest] = bareSupportSegments(support);
  return [{ ...first, base: first.base + (support.modeRise || 0) }, ...rest];
}

/**
 * The rise range of any piece that isn't a support (SPEC.md 3.7, 5.2): its
 * `riseRange` if it's adjustable (a nose fitting's hand screw), else its
 * fixed `rise` at both ends.
 */
export function riseRangeOf(component) {
  if (component.riseRange) return { min: component.riseRange.min, max: component.riseRange.max };
  const fixed = component.rise || 0;
  return { min: fixed, max: fixed };
}

function bareSupportSegments(support) {
  const leveling = support.levelingLoss || 0;
  const extentOf = (min, max, loss = 0) => Math.max(0, max - loss - min);

  if (support.boomRange) {
    const { practicalMin, practicalMax } = support.boomRange;
    const below = support.legRange
      ? {
          kind: "adjustable",
          base: support.legRange.practicalMin,
          extent: extentOf(support.legRange.practicalMin, support.legRange.practicalMax),
        }
      : { kind: "fixed", base: support.baseRise || 0, extent: 0 };
    return [below, { kind: "moveable", base: practicalMin, extent: extentOf(practicalMin, practicalMax, leveling) }];
  }
  if (support.riseRange) {
    const { practicalMin, practicalMax } = support.riseRange;
    const kind = support.adjustability === "moveable" ? "moveable" : "adjustable";
    return [{ kind, base: practicalMin, extent: extentOf(practicalMin, practicalMax, leveling) }];
  }
  return [{ kind: "fixed", base: support.rise || 0, extent: 0 }];
}

/**
 * Turn a resolved chain (as produced by solver.js's enumerateChains or
 * buildChain) back into the minimal, serializable picks needed to
 * reconstruct it later — the shape solver.js's buildChain expects
 * (SPEC.md 5.1).
 */
export function describeCurrentRig(chain) {
  return {
    baseItemIds: chain.baseItems.map((c) => c.id),
    // Each base item's mode by position (a full apple's face), null for none.
    baseModes: chain.baseItems.map((c) => c.mode ?? null),
    supportId: chain.support ? chain.support.id : null,
    // The support's mode (a dolly's wheel set), if it has modes.
    supportMode: chain.support ? chain.support.mode ?? null : null,
    noseId: chain.nose ? chain.nose.id : null,
    noseMode: chain.nose ? chain.nose.mode ?? null : null,
    adapterIds: chain.adapters.map((c) => c.id),
    // Which mode each multi-mode adapter is in (single-mode adapters have none).
    adapterModes: Object.fromEntries(chain.adapters.filter((c) => c.mode).map((c) => [c.id, c.mode])),
    headId: chain.head ? chain.head.id : null,
    modeName: chain.mode ? chain.mode.name : null,
    plateIds: chain.plates.map((c) => c.id),
    // The camera block's pieces as rigged, or null for the block as defined.
    blockIds: sameIds(chain.blockPieces.map((c) => c.id), chain.build.componentIds) ? null : chain.blockPieces.map((c) => c.id),
    attachName: chain.attach.name,
  };
}

const sameIds = (a, b) => a.length === b.length && a.every((id, i) => id === b[i]);
