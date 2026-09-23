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
 * A build's rise contribution, per SPEC.md 3.4: the sum of its own
 * components' rises (a plain "rise" field, or opticalCenterAboveBase for
 * the camera body).
 */
export function buildTotalRise(build, gear) {
  const byId = componentsById(gear);
  return build.componentIds.reduce((sum, id) => {
    const c = byId[id];
    const contribution = c.rise !== undefined ? c.rise : c.opticalCenterAboveBase;
    return sum + (contribution || 0);
  }, 0);
}

/**
 * The candidate attach points a build exposes (SPEC.md 3.4). "base" and
 * "base-inverted" are two facings of the same physical mount and always
 * available; "top-handle" only when the build declares a rated handle.
 */
export function buildAttachPoints(build, gear) {
  const totalRise = buildTotalRise(build, gear);
  const points = [
    { name: "base", mount: build.bottomMount, facing: "down", rise: totalRise, inverted: false },
    { name: "base-inverted", mount: build.bottomMount, facing: "up", rise: -totalRise, inverted: true },
  ];
  if (build.hasRatedTopHandle) {
    points.push({
      name: "top-handle",
      mount: build.bottomMount,
      facing: "up",
      rise: build.topHandleOffset,
      inverted: false,
    });
  }
  return points;
}

/**
 * A support's achievable rise interval, using practical (not spec)
 * figures, with levelingLoss subtracted from the top (SPEC.md 3.2).
 * Handles both plain-range supports (tripods, hi-hats) and dolly-style
 * supports (fixed baseRise + boomRange).
 */
export function supportInterval(support) {
  if (support.boomRange) {
    const base = support.baseRise || 0;
    return {
      min: base + support.boomRange.practicalMin,
      max: base + support.boomRange.practicalMax - (support.levelingLoss || 0),
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
