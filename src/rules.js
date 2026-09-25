// Hard chain rules (SPEC.md 2 and 2.1). Each rule is its own function and
// reports its own violation, so a rejected chain can say which rule it
// broke. None of this is ranking: a chain that breaks a rule here is never
// a candidate; the soft apple-box preference lives in solver.js's
// RANKING_CRITERIA, deliberately separate.

import { buildAttachPoints, getBuild, getPackageComponents } from "./model.js";

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

// --- What may attach (SPEC.md 5.9) -----------------------------------------
//
// The check screen offers each slot only what can legally attach to what's
// below it. This is that logic, built from the same primitives as chain
// validation above and in solver.js's resolveChain, so the UI knows none of
// it. Every option that isn't offered carries a plain-language reason.

const MOUNT_WORDS = {
  ground: "the floor",
  "dolly-wheels": "dolly track",
  mitchell: "a Mitchell mount",
  "bowl-100": "a 100mm bowl",
  "bowl-150": "a 150mm bowl",
  "flat-38": "a 3/8 flat plate",
  "flat-14": "a 1/4 flat plate",
  dovetail: "a dovetail",
};
const plainMount = (mount) => MOUNT_WORDS[mount] || `a ${mount} mount`;
const plainMounts = (mounts) => [].concat(mounts).map(plainMount).join(" or ");
const anFacing = (facing) => (facing === "up" ? "an up-facing" : "a down-facing");
const nameOf = (component) => component.name || component.id;
const cap = (text) => text.charAt(0).toUpperCase() + text.slice(1);
/** "Mitchell Offset (underslung)" — a multi-mode adapter says which mode. */
const withMode = (component) => (component.mode ? `${nameOf(component)} (${component.mode})` : nameOf(component));

/** "Cleared Studio Dolly. It is a dolly, and…" — a reason that opens with the
 * component's own name reads better as "It", since the note just named it. */
function noteFor(verb, component, reason) {
  const name = nameOf(component).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const rest = reason.replace(new RegExp(`^${name}( \\([^)]*\\))?`), "It");
  return `${verb} ${nameOf(component)}. ${rest}`;
}

const ATTACH_LABELS = {
  base: "Upright on the plate",
  "base-inverted": "Inverted — flip image",
  "top-handle": "Hung from the top handle",
};

/** A mode named underslung is the "flipped" state of a component that has
 * one (SPEC.md 5.9); so is an inverted attach point. */
const isFlippedMode = (name) => /underslung/i.test(name || "");

const EMPTY_PICKS = () => ({
  baseItemIds: [],
  supportId: null,
  adapterIds: [],
  adapterModes: {},
  headId: null,
  modeName: null,
  attachName: null,
});

// Each `why…` returns null if the thing may go there, else the reason.

function whyBaseItem(item, keptBase) {
  const orientation = appleBoxOrientationViolation([item]);
  if (orientation) {
    const face = (item.orientation || "flat").replace("in", '"');
    return `A ${item.boxSize} apple can't stand on its ${face} face — only a full apple can.`;
  }
  if (orderStack([...keptBase, item], "ground", "up")) return null;
  const top = orderStack(keptBase, "ground", "up")?.topMount ?? "ground";
  return `${nameOf(item)} needs ${plainMounts(item.bottomMount)} to sit on, but the base layer below already ends in ${plainMount(top)}.`;
}

function whySupport(support, keptBase) {
  const top = orderStack(keptBase, "ground", "up")?.topMount ?? "ground";
  if (!acceptsMount(support, top)) {
    return `${nameOf(support)} sits on ${plainMounts(support.bottomMount)}, not on ${plainMount(top)}.`;
  }
  if (appleBoxPlacementViolation(keptBase, support)) {
    return `${nameOf(support)} is a dolly, and apple boxes can't go under a dolly — use track.`;
  }
  return null;
}

function whyAdapter(variant, support, keptAdapters) {
  if (keptAdapters.some((a) => a.id === variant.id)) return `${nameOf(variant)} is already in the rig.`;
  if (variant.requiresFamily && variant.requiresFamily !== support.family) {
    const has = support.family ? `is ${support.family} family` : "has no family";
    return `${nameOf(variant)} only fits a ${variant.requiresFamily}-family support, and ${nameOf(support)} ${has}.`;
  }
  if (orderStack([...keptAdapters, variant], support.topMount, topFacingOf(support))) return null;
  const below = orderStack(keptAdapters, support.topMount, topFacingOf(support));
  const beneath = keptAdapters.length ? withMode(keptAdapters[keptAdapters.length - 1]) : nameOf(support);
  if (below && !acceptsMount(variant, below.topMount)) {
    return `${withMode(variant)} needs ${plainMounts(variant.bottomMount)} beneath it, but what's below ends in ${plainMount(below.topMount)}.`;
  }
  const required = requiredSupportFacingOf(variant);
  return `${withMode(variant)} needs ${anFacing(required)} mount beneath it, but the top of ${beneath} faces ${below ? below.topFacing : "the wrong way"}.`;
}

function whyHeadMode(head, mode, stackTop, beneathName) {
  if (!acceptsMount(head, stackTop.topMount)) {
    return `${nameOf(head)} fits ${plainMounts(head.bottomMount)}, but what's below it ends in ${plainMount(stackTop.topMount)}.`;
  }
  const required = mode.supportMountFacing || "up";
  if (!supportFacingOk(stackTop.topFacing, required)) {
    const hint =
      required === "down"
        ? " Underslung hangs the head from a down-facing mount — only an offset in underslung mode supplies one."
        : "";
    return `${cap(mode.name)} mode needs ${anFacing(required)} mount beneath the head, but the top of ${beneathName} faces ${stackTop.topFacing}.${hint}`;
  }
  return null;
}

function whyAttach(attach, head, mode) {
  if (attach.mount !== head.topMount) {
    return `The camera build mounts on ${plainMount(attach.mount)}, but ${nameOf(head)} tops out in ${plainMount(head.topMount)}.`;
  }
  if (!facingsMate(mode.cameraMountFacing, attach.facing)) {
    return `In ${mode.name} mode the head's camera mount faces ${mode.cameraMountFacing}, so "${ATTACH_LABELS[attach.name] || attach.name}" doesn't fit.`;
  }
  return null;
}

/** The variant of `adapter` in `modeName` (the first mode if unspecified). */
function variantOf(adapter, modeName) {
  const variants = adapterVariants(adapter);
  return variants.find((v) => v.mode === modeName) || (modeName == null ? variants[0] : null);
}

/**
 * Walk `picks` ground up and drop or adjust whatever isn't legal on what's
 * beneath it (SPEC.md 5.9). Base items, the support, adapters, and the head
 * are cleared with a plain-language note; a head mode or attach point that
 * stopped fitting switches to the first legal one instead. A pick above an
 * empty required slot is kept, to be revalidated once it's filled.
 *
 * @returns {{ picks: object, notes: string[] }}
 */
export function revalidatePicks(gear, packageId, buildId, picks) {
  const pool = getPackageComponents(gear, packageId);
  const byId = Object.fromEntries(pool.map((c) => [c.id, c]));
  const build = getBuild(gear, buildId);
  const notes = [];
  const out = EMPTY_PICKS();

  // Base layer.
  const keptBase = [];
  for (const id of picks.baseItemIds || []) {
    const item = byId[id];
    if (!item) continue;
    const reason = whyBaseItem(item, keptBase);
    if (reason) notes.push(noteFor("Removed", item, reason));
    else {
      keptBase.push(item);
      out.baseItemIds.push(id);
    }
  }
  const baseStack = orderStack(keptBase, "ground", "up");

  // Support.
  let support = byId[picks.supportId] || null;
  if (support) {
    const reason = whySupport(support, keptBase);
    if (reason) {
      notes.push(noteFor("Cleared", support, reason));
      support = null;
    }
  }
  out.supportId = support ? support.id : null;

  if (!support) {
    // Nothing to validate the rest against yet: keep it as it was.
    out.adapterIds = [...(picks.adapterIds || [])];
    out.adapterModes = { ...(picks.adapterModes || {}) };
    out.headId = picks.headId ?? null;
    out.modeName = picks.modeName ?? null;
    out.attachName = picks.attachName ?? null;
    return { picks: out, notes };
  }

  // Adapters, each in its mode.
  const keptAdapters = [];
  for (const id of picks.adapterIds || []) {
    const adapter = byId[id];
    if (!adapter) continue;
    const wanted = (picks.adapterModes || {})[id];
    const tried = [variantOf(adapter, wanted), ...adapterVariants(adapter)].filter(Boolean);
    const legal = tried.find((v) => !whyAdapter(v, support, keptAdapters));
    if (!legal) {
      const reason = whyAdapter(tried[0] || adapterVariants(adapter)[0], support, keptAdapters);
      notes.push(noteFor("Removed", adapter, reason));
      continue;
    }
    if (wanted !== undefined && legal.mode !== wanted) {
      notes.push(noteFor(`Switched to ${legal.mode} mode:`, adapter, whyAdapter(variantOf(adapter, wanted), support, keptAdapters)));
    }
    keptAdapters.push(legal);
    out.adapterIds.push(id);
    if (legal.mode) out.adapterModes[id] = legal.mode;
  }
  const adapterStack = orderStack(keptAdapters, support.topMount, topFacingOf(support));
  const beneathName = adapterStack.items.length
    ? withMode(adapterStack.items[adapterStack.items.length - 1])
    : nameOf(support);

  // Head, and its mode.
  const legalModes = (head) => head.modes.filter((m) => !whyHeadMode(head, m, adapterStack, beneathName));
  let head = byId[picks.headId] || null;
  if (head && legalModes(head).length === 0) {
    notes.push(noteFor("Cleared", head, whyHeadMode(head, head.modes[0], adapterStack, beneathName)));
    head = null;
  }
  out.headId = head ? head.id : null;
  if (!head) {
    out.modeName = picks.modeName ?? null;
    out.attachName = picks.attachName ?? null;
    return { picks: out, notes };
  }

  let mode = head.modes.find((m) => m.name === picks.modeName);
  if (!mode || whyHeadMode(head, mode, adapterStack, beneathName)) {
    const replacement = legalModes(head)[0];
    if (mode) {
      notes.push(`Switched the head to ${replacement.name} mode. ${whyHeadMode(head, mode, adapterStack, beneathName)}`);
    }
    mode = replacement;
  }
  out.modeName = mode.name;

  // Camera attach point.
  const attachPoints = buildAttachPoints(build, gear);
  const legalAttaches = attachPoints.filter((a) => !whyAttach(a, head, mode));
  let attach = attachPoints.find((a) => a.name === picks.attachName);
  if (!attach || whyAttach(attach, head, mode)) {
    const replacement = legalAttaches[0] || null;
    if (attach && replacement) {
      notes.push(`Switched the camera mount to "${ATTACH_LABELS[replacement.name] || replacement.name}". ${whyAttach(attach, head, mode)}`);
    }
    attach = replacement;
  }
  out.attachName = attach ? attach.name : null;

  return { picks: out, notes };
}

/**
 * Every slot's candidates, each marked available or not given the picks
 * below it, with a plain-language reason when it isn't (SPEC.md 5.9). The
 * picks are revalidated first, so this never reasons from an illegal rig.
 */
export function slotOptions(gear, packageId, buildId, rawPicks) {
  const { picks } = revalidatePicks(gear, packageId, buildId, rawPicks);
  const pool = getPackageComponents(gear, packageId);
  const build = getBuild(gear, buildId);
  const byId = Object.fromEntries(pool.map((c) => [c.id, c]));

  const keptBase = picks.baseItemIds.map((id) => byId[id]);
  const support = byId[picks.supportId] || null;
  const keptAdapters = picks.adapterIds.map((id) => variantOf(byId[id], picks.adapterModes[id]));
  const adapterStack = support ? orderStack(keptAdapters, support.topMount, topFacingOf(support)) : null;
  const beneathName = adapterStack?.items.length
    ? withMode(adapterStack.items[adapterStack.items.length - 1])
    : support && nameOf(support);
  const head = byId[picks.headId] || null;
  const mode = head?.modes.find((m) => m.name === picks.modeName) || null;

  const entry = (component, reason, extra = {}) => ({
    id: component.id,
    name: nameOf(component),
    component,
    available: !reason,
    reason,
    ...extra,
  });

  // Base layer: judged against the *other* picked items, so a picked one stays available.
  const base = pool
    .filter((c) => c.category === "base")
    .map((item) => {
      const others = keptBase.filter((b) => b.id !== item.id);
      return entry(item, whyBaseItem(item, others));
    });

  const supports = pool
    .filter((c) => c.category === "support")
    .map((candidate) => entry(candidate, whySupport(candidate, keptBase)));

  const NEED_SUPPORT = "Choose a support first.";
  const adapters = pool
    .filter((c) => c.category === "adapter")
    .map((adapter) => {
      const others = keptAdapters.filter((a) => a.id !== adapter.id);
      const modes = adapterVariants(adapter).map((variant) => {
        const reason = support ? whyAdapter(variant, support, others) : NEED_SUPPORT;
        return { name: variant.mode, label: variant.mode || "", flipped: isFlippedMode(variant.mode), available: !reason, reason };
      });
      const anyLegal = modes.some((m) => m.available);
      return entry(adapter, anyLegal ? null : modes[0].reason, { modes });
    });

  const heads = pool
    .filter((c) => c.category === "head")
    .map((candidate) => {
      const modes = candidate.modes.map((m) => {
        const reason = adapterStack ? whyHeadMode(candidate, m, adapterStack, beneathName) : NEED_SUPPORT;
        return { name: m.name, label: m.name, flipped: isFlippedMode(m.name), available: !reason, reason };
      });
      return entry(candidate, modes.some((m) => m.available) ? null : modes[0].reason, { modes });
    });

  const attach = buildAttachPoints(build, gear).map((point) => {
    const reason = head && mode ? whyAttach(point, head, mode) : "Choose a head first.";
    return {
      name: point.name,
      label: ATTACH_LABELS[point.name] || point.name,
      flipped: Boolean(point.inverted),
      available: !reason,
      reason,
      attach: point,
    };
  });

  return { picks, base, support: supports, adapters, head: heads, attach };
}

/** The first legal rig: the first support, head, mode, and attach point that fit. */
export function defaultPicks(gear, packageId, buildId) {
  let picks = EMPTY_PICKS();
  const firstAvailable = (list) => list.find((o) => o.available);
  const support = firstAvailable(slotOptions(gear, packageId, buildId, picks).support);
  if (support) picks = { ...picks, supportId: support.id };
  const head = firstAvailable(slotOptions(gear, packageId, buildId, picks).head);
  if (head) picks = { ...picks, headId: head.id };
  // Revalidating fills in the head's first legal mode and attach point.
  return revalidatePicks(gear, packageId, buildId, picks).picks;
}

/**
 * How to present a set of modes (SPEC.md 5.9): nothing, plain text, an
 * on/off toggle, or a dropdown. `entries` are {name, label, flipped,
 * available, reason}. A toggle needs exactly two legal states, one of them
 * the flipped (underslung / inverted) one; when a flipped state exists but
 * isn't legal right now, its reason comes back as a `hint`.
 */
export function modeControl(entries) {
  const legal = entries.filter((e) => e.available);
  const blockedFlip = entries.find((e) => e.flipped && !e.available);
  const hint = blockedFlip ? blockedFlip.reason : null;
  if (legal.length === 0) return { type: "none", hint };
  if (legal.length === 1) return { type: "static", entry: legal[0], hint };
  const flipped = legal.filter((e) => e.flipped);
  if (legal.length === 2 && flipped.length === 1) {
    return { type: "toggle", on: flipped[0], off: legal.find((e) => !e.flipped), hint };
  }
  return { type: "dropdown", entries: legal, hint };
}
