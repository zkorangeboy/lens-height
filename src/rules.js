// Hard chain rules (SPEC.md 2 and 2.1). Each rule is its own function and
// reports its own violation, so a rejected chain can say which rule it
// broke. None of this is ranking: a chain that breaks a rule here is never
// a candidate; the soft apple-box preference lives in solver.js's
// RANKING_CRITERIA, deliberately separate.

// --- Mounts and facing (SPEC.md 2) -----------------------------------------

/** A component's bottomMount is a string, or a list when it fits several
 * (a dolly accepts `ground` or `dolly-wheels`). */
export function acceptsMount(component, mount) {
  const accepted = component.bottomMount;
  return Array.isArray(accepted) ? accepted.includes(mount) : accepted === mount;
}

/** Which way a support's or adapter's top mount faces (default `up`). */
export function topFacingOf(component) {
  return component.mountFacing || "up";
}

/** Which way the mount *beneath* a component must face (default `up`):
 * its support-side mount. Head modes declare it per mode. */
export function requiredSupportFacingOf(component) {
  return component.supportMountFacing || "up";
}

/** The mount beneath must face the way what's above it requires. */
export function supportFacingOk(lowerTopFacing, requiredFacing) {
  return lowerTopFacing === requiredFacing;
}

/** Head mode to camera attach point is its own pairing (SPEC.md 3.3,
 * 3.4): the two mounts must face opposite ways. */
export function facingsMate(headModeFacing, attachFacing) {
  return headModeFacing !== attachFacing;
}

/**
 * The ways an adapter can be used (SPEC.md 3.6): one resolved copy per
 * mode, each carrying that mode's rise and top-mount facing plus its
 * `mode` name. An adapter with no `modes` is a single-mode adapter and
 * yields itself (`mode: null`). A resolved copy still looks like an
 * adapter — `id`, `name`, `rise`, `mountFacing` — so everything that
 * reads those works unchanged.
 */
export function adapterVariants(adapter) {
  if (!adapter.modes || adapter.modes.length === 0) return [{ ...adapter, mode: null }];
  return adapter.modes.map((m) => ({
    ...adapter,
    mode: m.name,
    rise: m.rise,
    mountFacing: m.mountFacing || "up",
  }));
}

/**
 * Stack `items` on top of a mount, bottom to top, in an order where every
 * item's bottom mount and facing mate with what's below it. Returns
 * `{ items, topMount, topFacing }` for the first valid order (input order
 * breaks ties, so it's deterministic), or null if no order works. Used
 * for both the base layer and the adapter stack.
 */
export function orderStack(items, startMount, startFacing) {
  const search = (remaining, placed, mount, facing) => {
    if (remaining.length === 0) return { items: placed, topMount: mount, topFacing: facing };
    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i];
      if (!acceptsMount(item, mount)) continue;
      if (!supportFacingOk(facing, requiredSupportFacingOf(item))) continue;
      const rest = remaining.filter((_, j) => j !== i);
      const found = search(rest, [...placed, item], item.topMount, topFacingOf(item));
      if (found) return found;
    }
    return null;
  };
  return search(items, [], startMount, startFacing);
}

// --- Family (SPEC.md 2.1) --------------------------------------------------

/** An adapter's `requiresFamily` must equal the `family` of the support
 * it's attached to. Separate from mount compatibility: family-specific
 * gear often shares a mount type with everything else. */
export function familyViolation(adapters, support) {
  for (const adapter of adapters) {
    if (adapter.requiresFamily && adapter.requiresFamily !== support.family) {
      const have = support.family ? `family "${support.family}"` : "no family";
      return `Family mismatch: adapter "${adapter.name || adapter.id}" requires family "${adapter.requiresFamily}", but support "${support.name || support.id}" has ${have}`;
    }
  }
  return null;
}

// --- Apple boxes (SPEC.md 2.1) ---------------------------------------------

export function isAppleBox(item) {
  return item.kind === "apple-box";
}

export function isDolly(support) {
  return support.kind === "dolly";
}

export function isTripod(support) {
  return support.kind === "tripod";
}

export function appleBoxCount(baseItems) {
  return baseItems.filter(isAppleBox).length;
}

/** Soft, not a rule (SPEC.md 2.1): a tripod on apple boxes is legal but
 * heavily penalized in ranking. Lives here beside the hard rules so
 * "what counts as a tripod on apple boxes" is defined once. */
export function tripodOnAppleBoxes(baseItems, support) {
  return isTripod(support) && appleBoxCount(baseItems) > 0;
}

/** Hard rule: only a dolly forbids apple boxes. */
export function appleBoxPlacementViolation(baseItems, support) {
  const box = baseItems.find(isAppleBox);
  if (box && isDolly(support)) {
    return `Apple box rule: "${box.name || box.id}" can't be used under "${support.name || support.id}" — apple boxes can't go under a dolly (use track)`;
  }
  return null;
}

/** Hard rule: only a full apple may stand on its 12" or 20" face. Half,
 * quarter, and pancake are flat-only. */
export function appleBoxOrientationViolation(baseItems) {
  for (const item of baseItems.filter(isAppleBox)) {
    const orientation = item.orientation || "flat";
    if (orientation !== "flat" && item.boxSize !== "full") {
      return `Apple box rule: a ${item.boxSize} apple can't be used on its ${orientation.replace("in", '"')} face — only a full apple can`;
    }
  }
  return null;
}

/** Every hard rule that isn't a mount check, in one list. */
export function ruleViolations(baseItems, adapters, support) {
  return [
    familyViolation(adapters, support),
    appleBoxPlacementViolation(baseItems, support),
    appleBoxOrientationViolation(baseItems),
  ].filter(Boolean);
}
