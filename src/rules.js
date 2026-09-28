// Hard chain rules (SPEC.md 2 and 2.1). Each rule is its own function and
// reports its own violation, so a rejected chain can say which rule it
// broke. None of this is ranking: a chain that breaks a rule here is never
// a candidate; the soft apple-box preference lives in solver.js's
// RANKING_CRITERIA, deliberately separate.

import { blockPieces, buildAttachPoints, getBuild, getPackageComponents, pieceBottom, pieceRise } from "./model.js";
// solver.js imports this module too; buildChain is only called at run time, so the cycle is safe.
import { buildChain } from "./solver.js";

// --- Mounts and facing (SPEC.md 2) -----------------------------------------

/**
 * Typed interfaces (SPEC.md 2): each type has a male and a female side, and
 * a joint is legal when the two pieces meeting are the two sides of one
 * type — either side may be the lower one. The one table of pairs.
 */
export const INTERFACES = {
  "mitchell-male": { type: "mitchell", side: "male" },
  "mitchell-female": { type: "mitchell", side: "female" },
  "euro-dovetail": { type: "euro", side: "male" },
  "euro-receiver": { type: "euro", side: "female" },
  "qr-plate": { type: "qr", side: "male" },
  "qr-receiver": { type: "qr", side: "female" },
  "bolt-38": { type: "3/8", side: "male" },
  "holes-38": { type: "3/8", side: "female" },
};

/** Whether a lower piece's top and an upper piece's bottom mate. Typed
 * interfaces mate male to female of one type; any other mount (ground,
 * track, a beam nose, older names) mates only with itself. */
export function mates(lowerTop, upperBottom) {
  const lower = INTERFACES[lowerTop];
  const upper = INTERFACES[upperBottom];
  if (lower && upper) return lower.type === upper.type && lower.side !== upper.side;
  return lowerTop === upperBottom;
}

/** What a mount mates with: the other side of a typed interface, or itself. */
export function mateOf(mount) {
  const own = INTERFACES[mount];
  if (!own) return mount;
  return Object.keys(INTERFACES).find((m) => INTERFACES[m].type === own.type && INTERFACES[m].side !== own.side);
}

/** Camera-side pieces (SPEC.md 3.4): plates, camera-block pieces, the camera. */
const CAMERA_SIDE = new Set(["plate", "camera-plate", "camera-body"]);
export function isCameraSide(component) {
  return CAMERA_SIDE.has(component.category);
}

/** A component's bottomMount is a string, or a list when it fits several
 * (sticks accept `ground` or `spreader`). The floor and apple box tops
 * (`ground`) also take the bottom of any camera-side piece (SPEC.md 2). */
export function acceptsMount(component, mount) {
  if (mount === "ground" && isCameraSide(component)) return true;
  return [].concat(component.bottomMount).some((bottom) => mates(mount, bottom));
}

/** The mounts a component can sit on, for plain-language reasons. */
export function acceptedMounts(component) {
  return [].concat(component.bottomMount).map(mateOf);
}

/** Whether `item` can sit on `mount`, where `first` means it's the first
 * piece of the stack. The bare floor presents `floor` as well as `ground`
 * (SPEC.md 3.1): a `floor` item, like rolling spreaders, only goes first,
 * since an apple box's top is `ground` alone. */
export function sitsOn(item, mount, first) {
  return acceptsMount(item, mount) || (first && mount === "ground" && acceptsMount(item, "floor"));
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

/** A riser or an offset (SPEC.md 3.6): mounts to a Mitchell of either
 * facing, and its own rise/facing follow whichever one it lands on. */
export function followsMount(component) {
  return Boolean(component.followsMount);
}

const flipFacing = (facing) => (facing === "down" ? "up" : "down");

/** Whether `item` can sit on a mount facing `facing` (SPEC.md 2, 3.6): a
 * riser or offset takes either facing; anything else needs the facing it
 * declares (default `up`). */
export function facingAccepted(item, facing) {
  return followsMount(item) || supportFacingOk(facing, requiredSupportFacingOf(item));
}

/** `item` as it actually sits given the facing beneath it (SPEC.md 3.6): a
 * riser or offset hung from a down-facing mount presents its declared
 * rise negated and its declared facing flipped; on an up-facing mount, or
 * for anything that doesn't `followsMount`, it's unchanged. */
export function facedVariant(item, facing) {
  if (!followsMount(item) || facing !== "down") return item;
  return { ...item, rise: -item.rise, mountFacing: flipFacing(topFacingOf(item)) };
}

/** Apple boxes are unlimited (SPEC.md 3.1): the same box may appear any
 * number of times. Everything else is one of each per chain. */
export function isRepeatable(component) {
  return component.kind === "apple-box";
}

/** The mode of the base item at `index` of `picks.baseItemIds`: `baseModes`
 * is an array by position (the same box can stand on different faces), or,
 * in the older form, an object keyed by id. */
export function baseModeAt(picks, index) {
  const modes = picks.baseModes;
  if (Array.isArray(modes)) return modes[index] ?? null;
  return (modes || {})[picks.baseItemIds[index]] ?? null;
}

/** The mount beneath a head must face down in an underslung mode and up in
 * any other (SPEC.md 3.3). No exceptions: keyed on the mode itself, so no
 * head's data can hang an underslung mode from an up-facing mount. */
export function headModeSupportFacing(mode) {
  return /underslung/i.test(mode.name || "") ? "down" : "up";
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
  return adapter.modes.map(({ name, label, ...fields }) => ({
    ...adapter,
    ...fields,
    mode: name,
    modeLabel: label || name,
    mountFacing: fields.mountFacing || "up",
  }));
}

/** Base items and nose fittings take modes the same way (SPEC.md 3.1,
 * 3.7): a full apple's faces, an SLE's upright/reversed/underslung. */
export const componentVariants = adapterVariants;

/**
 * A support's modes (SPEC.md 3.2): a dolly's wheel set. Each resolved copy
 * carries the mode's own `bottomMount` (what it can sit on) and its rise as
 * `modeRise`, which model.js adds to every support figure. A support with no
 * modes yields itself (`mode: null`, `modeRise: 0`).
 */
export function supportVariants(support) {
  if (!support.modes || support.modes.length === 0) return [{ ...support, mode: null, modeRise: 0 }];
  return support.modes.map(({ name, label, rise, ...fields }) => ({
    ...support,
    ...fields,
    mode: name,
    modeLabel: label || name,
    modeRise: rise || 0,
  }));
}

// --- Nose fittings (SPEC.md 3.7) --------------------------------------------

/** The mount only a nose fitting accepts: a J.L. Fisher beam nose. */
export const NOSE_MOUNT = "fisher-nose";

/** A support whose top is a beam nose needs exactly one nose fitting; any
 * other support takes none. */
export function needsNoseFitting(support) {
  return support.topMount === NOSE_MOUNT;
}

/** What the adapter stack starts on: the nose fitting's Mitchell if there
 * is one, else the support's top. */
export function stackBaseOf(support, nose) {
  const top = nose || support;
  return { topMount: top.topMount, topFacing: topFacingOf(top), piece: top };
}

// --- The camera side (SPEC.md 3.4) ----------------------------------------

/**
 * Stack plates on a mount, bottom to top, in the order given: each must mate
 * with what's below (2). A plate on a down-facing interface hangs inverted —
 * its rise negated, its top facing down — so the facing carries up. `below`
 * is `{topMount, topFacing, name}`. Returns `{items, topMount, topFacing,
 * name}`, or `{why, index}` for the first plate that doesn't fit.
 */
export function stackPlates(plates, below) {
  let { topMount, topFacing, name } = below;
  const items = [];
  for (const [index, plate] of plates.entries()) {
    if (!acceptsMount(plate, topMount)) {
      return { why: `${nameOf(plate)} needs ${plainMounts(acceptedMounts(plate))} beneath it, but ${name} ends in ${plainMount(topMount)}.`, index };
    }
    const inverted = topFacing === "down";
    items.push({ ...plate, rise: inverted ? -plate.rise : plate.rise, inverted });
    topMount = plate.topMount;
    name = nameOf(plate);
  }
  return { items, topMount, topFacing, name };
}

/** Why a camera block's pieces, as rigged, don't mate with each other (3.4),
 * or null. A block with its own `bottomMount` (older data) isn't checked. */
export function whyBlockJoints(build, pieces) {
  if (build.bottomMount) return null;
  if (pieces.length === 0) return `${nameOf(build)} has no pieces.`;
  for (let i = 1; i < pieces.length; i++) {
    const bottom = pieceBottom(build, pieces[i]);
    if (!mates(pieces[i - 1].topMount, bottom)) {
      return `${nameOf(pieces[i])} needs ${plainMount(mateOf(bottom))} beneath it, but ${nameOf(pieces[i - 1])} ends in ${plainMount(pieces[i - 1].topMount)}.`;
    }
  }
  return null;
}

/** Why a camera block can't attach this way on what's below, or null.
 * `below` is `{topMount, topFacing, name, headMode}`; the floor and apple
 * box tops take any camera-side piece (2). */
export function whyAttach(attach, below) {
  if (below.topMount !== "ground" && !mates(below.topMount, attach.mount)) {
    const needs = plainMount(mateOf(attach.mount));
    const who = attach.bottomName ? `${attach.blockName}'s ${attach.bottomName}` : attach.blockName || "The camera";
    return `${who} needs ${needs} beneath it, but ${below.name} ends in ${plainMount(below.topMount)}.`;
  }
  if (!facingsMate(below.topFacing, attach.facing)) {
    const label = ATTACH_LABELS[attach.name] || attach.name;
    return below.headMode
      ? `In ${below.headMode} mode the head's camera mount faces ${below.topFacing}, so "${label}" doesn't fit.`
      : `The top of ${below.name} faces ${below.topFacing}, so "${label}" doesn't fit.`;
  }
  return null;
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
      if (!sitsOn(item, mount, placed.length === 0)) continue;
      if (!facingAccepted(item, facing)) continue;
      const faced = facedVariant(item, facing);
      const rest = remaining.filter((_, j) => j !== i);
      const found = search(rest, [...placed, faced], faced.topMount, topFacingOf(faced));
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

/** Every hard rule that isn't a mount check, in one list. The nose fitting,
 * like an adapter, must match the support's family. */
export function ruleViolations(baseItems, adapters, support, nose = null) {
  return [
    familyViolation(nose ? [nose, ...adapters] : adapters, support),
    appleBoxPlacementViolation(baseItems, support),
    appleBoxOrientationViolation(baseItems),
  ].filter(Boolean);
}

// --- What may attach (SPEC.md 6) -----------------------------------------
//
// The check screen offers each slot only what can legally attach to what's
// below it. This is that logic, built from the same primitives as chain
// validation above and in solver.js's resolveChain, so the UI knows none of
// it. Every option that isn't offered carries a plain-language reason.

const MOUNT_WORDS = {
  ground: "the floor",
  floor: "the bare floor",
  spreader: "rolling spreaders",
  "round-track": "round track",
  "fisher-nose": "a Fisher beam nose",
  mitchell: "a Mitchell mount",
  "mitchell-female": "a Mitchell mount",
  "mitchell-male": "a Mitchell base",
  "euro-dovetail": "a Euro dovetail",
  "euro-receiver": "a Euro receiver",
  "qr-plate": "a QR plate",
  "qr-receiver": "a QR receiver",
  "bolt-38": "a 3/8″ bolt",
  "holes-38": "3/8″ holes",
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
const withMode = (component) =>
  component.mode ? `${nameOf(component)} (${component.modeLabel || component.mode})` : nameOf(component);

// Notes (SPEC.md 6): a few words, only for a piece the user didn't touch
// that was removed or swapped for another setting of its own. Never a reason.
const shortOf = (component) => component.shortName || nameOf(component);
const removedNote = (component) => `Removed ${shortOf(component)}`;
/** "Wheels → ETW", "Full apple → #1 LA". */
const switchedNote = (component, variant) =>
  `${component.category === "support" ? "Wheels" : shortOf(component)} → ${variant.shortLabel || variant.modeLabel || variant.mode}`;

const ATTACH_LABELS = {
  base: "Upright on the plate",
  "base-inverted": "Inverted — flip image",
  "top-handle": "Hung from the top handle",
};

/** A mode named underslung is the "flipped" state of a component that has
 * one (SPEC.md 6); so is an inverted attach point. */
const isFlippedMode = (name) => /underslung/i.test(name || "");

const EMPTY_PICKS = () => ({
  baseItemIds: [],
  baseModes: [],
  supportId: null,
  supportMode: null,
  noseId: null,
  noseMode: null,
  adapterIds: [],
  adapterModes: {},
  headId: null,
  modeName: null,
  plateIds: [],
  blockIds: null,
  attachName: null,
});

/** A mode is the "flipped" state (a toggle's on side, SPEC.md 6) if it's
 * named underslung or turns the mount it presents to face down (the bottom
 * of a U offset plate). */
const isFlipped = (variant) => isFlippedMode(variant.mode) || variant.mountFacing === "down";

/** Orientation modes (SPEC.md 6) are flips on the drawing, never sheet
 * choices: every head mode, both sides of an offset plate, an SLE's
 * upside-down mode. A full apple's faces, a dolly's wheels, and the SLE's
 * reversed position aren't. */
function isOrientation(component, variant) {
  if (component.category === "head") return true;
  if (component.category === "adapter") return adapterVariants(component).some((v) => v.mountFacing === "down");
  return isFlippedMode(variant.mode);
}

// Each `why…` returns null if the thing may go there, else the reason.

function whyBaseItem(item, keptBase) {
  const orientation = appleBoxOrientationViolation([item]);
  if (orientation) {
    const face = (item.orientation || "flat").replace("in", '"');
    return `A ${item.boxSize} apple can't stand on its ${face} face — only a full apple can.`;
  }
  if (orderStack([...keptBase, item], "ground", "up")) return null;
  if (acceptsMount(item, "floor")) return `${nameOf(item)} sit on the bare floor only — nothing goes underneath them.`;
  const top = orderStack(keptBase, "ground", "up")?.topMount ?? "ground";
  return `${nameOf(item)} needs ${plainMounts(acceptedMounts(item))} to sit on, but the base layer below already ends in ${plainMount(top)}.`;
}

/** `support` is a resolved variant: in a wheel mode, if it has modes. */
function whySupport(support, keptBase) {
  const top = orderStack(keptBase, "ground", "up")?.topMount ?? "ground";
  if (!acceptsMount(support, top)) {
    return `${withMode(support)} sits on ${plainMounts(acceptedMounts(support))}, not on ${plainMount(top)}.`;
  }
  if (appleBoxPlacementViolation(keptBase, support)) {
    return `${nameOf(support)} is a dolly, and apple boxes can't go under a dolly — use track.`;
  }
  return null;
}

function whyNose(nose, support) {
  if (!needsNoseFitting(support)) {
    return `${nameOf(nose)} mounts on ${plainMounts(acceptedMounts(nose))}, and ${nameOf(support)} tops out in ${plainMount(support.topMount)} — it takes no nose fitting.`;
  }
  if (nose.requiresFamily && nose.requiresFamily !== support.family) {
    const has = support.family ? `is ${support.family} family` : "has no family";
    return `${nameOf(nose)} only fits a ${nose.requiresFamily}-family support, and ${nameOf(support)} ${has}.`;
  }
  if (!acceptsMount(nose, support.topMount)) {
    return `${nameOf(nose)} mounts on ${plainMounts(acceptedMounts(nose))}, but ${nameOf(support)} tops out in ${plainMount(support.topMount)}.`;
  }
  return null;
}

/** `base` is stackBaseOf(support, nose): what the first adapter sits on. */
function whyAdapter(variant, base, keptAdapters, support) {
  if (keptAdapters.some((a) => a.id === variant.id)) return `${nameOf(variant)} is already in the rig.`;
  if (variant.requiresFamily && variant.requiresFamily !== support.family) {
    const has = support.family ? `is ${support.family} family` : "has no family";
    return `${nameOf(variant)} only fits a ${variant.requiresFamily}-family support, and ${nameOf(support)} ${has}.`;
  }
  if (orderStack([...keptAdapters, variant], base.topMount, base.topFacing)) return null;
  const below = orderStack(keptAdapters, base.topMount, base.topFacing);
  const beneath = keptAdapters.length ? withMode(keptAdapters[keptAdapters.length - 1]) : withMode(base.piece);
  if (below && !acceptsMount(variant, below.topMount)) {
    return `${withMode(variant)} needs ${plainMounts(acceptedMounts(variant))} beneath it, but what's below ends in ${plainMount(below.topMount)}.`;
  }
  const required = requiredSupportFacingOf(variant);
  return `${withMode(variant)} needs ${anFacing(required)} mount beneath it, but the top of ${beneath} faces ${below ? below.topFacing : "the wrong way"}.`;
}

function whyHeadMode(head, mode, stackTop, beneathName) {
  if (!acceptsMount(head, stackTop.topMount)) {
    return `${nameOf(head)} fits ${plainMounts(acceptedMounts(head))}, but what's below it ends in ${plainMount(stackTop.topMount)}.`;
  }
  const required = headModeSupportFacing(mode);
  if (!supportFacingOk(stackTop.topFacing, required)) {
    const hint =
      required === "down"
        ? " Underslung hangs the head from a down-facing mount, like the bottom of an offset plate."
        : "";
    return `${cap(mode.name)} mode needs ${anFacing(required)} mount beneath the head, but the top of ${beneathName} faces ${stackTop.topFacing}.${hint}`;
  }
  return null;
}


/** The variant of `component` in `modeName` (the first mode if unspecified). */
function variantOf(component, modeName, variantsOf = adapterVariants) {
  const variants = variantsOf(component);
  return variants.find((v) => v.mode === modeName) || (modeName == null ? variants[0] : null);
}

/**
 * Pick a moded piece's variant: the one asked for if it's legal, else the
 * first legal one, with a note when that's a switch. `why(variant)` is the
 * rule. Returns the variant, or null (and a note) if no mode is legal.
 */
function settleMode(component, wanted, why, notes, variantsOf = adapterVariants) {
  const variants = variantsOf(component);
  const asked = wanted == null ? null : variants.find((v) => v.mode === wanted) || null;
  const legal = [asked, ...variants].filter(Boolean).find((v) => !why(v));
  if (!legal) {
    notes.push(removedNote(component));
    return null;
  }
  if (wanted != null && legal.mode !== wanted) notes.push(switchedNote(component, legal));
  return legal;
}

/**
 * Walk `picks` ground up and drop or adjust whatever isn't legal on what's
 * beneath it (SPEC.md 6). Base items, the support, the nose fitting,
 * adapters, and the head are cleared with a plain-language note; a mode or
 * attach point that stopped fitting switches to the first legal one instead.
 * A pick above an empty required slot is kept, to be revalidated once it's
 * filled.
 *
 * @returns {{ picks: object, notes: string[] }}
 */
export function revalidatePicks(gear, packageId, buildId, picks) {
  const pool = getPackageComponents(gear, packageId);
  const byId = Object.fromEntries(pool.map((c) => [c.id, c]));
  const build = getBuild(gear, buildId);
  const notes = [];
  const out = EMPTY_PICKS();
  const keepCameraAsIs = () => {
    out.plateIds = [...(picks.plateIds || [])];
    out.blockIds = picks.blockIds ?? null;
    out.attachName = picks.attachName ?? null;
  };
  const keepRestAsIs = () => {
    out.adapterIds = [...(picks.adapterIds || [])];
    out.adapterModes = { ...(picks.adapterModes || {}) };
    out.headId = picks.headId ?? null;
    out.modeName = picks.modeName ?? null;
    keepCameraAsIs();
    return { picks: out, notes };
  };

  // Base layer, each item in its mode (a full apple's face).
  const keptBase = [];
  (picks.baseItemIds || []).forEach((id, index) => {
    const component = byId[id];
    if (!component) return;
    if (!isRepeatable(component) && keptBase.some((b) => b.id === id)) return; // one of each
    const legal = settleMode(component, baseModeAt(picks, index), (v) => whyBaseItem(v, keptBase), notes);
    if (legal) keptBase.push(legal);
  });
  // Kept in the order they physically stack, so picks and drawing agree.
  const baseStack = orderStack(keptBase, "ground", "up");
  out.baseItemIds = baseStack.items.map((item) => item.id);
  out.baseModes = baseStack.items.map((item) => item.mode ?? null);

  // Support, in its wheel mode.
  const supportComponent = byId[picks.supportId] || null;
  const support =
    supportComponent && settleMode(supportComponent, picks.supportMode, (v) => whySupport(v, keptBase), notes, supportVariants);
  out.supportId = support ? support.id : null;
  out.supportMode = support ? support.mode : null;
  if (!support) {
    out.noseId = picks.noseId ?? null;
    out.noseMode = picks.noseMode ?? null;
    // With a head (or anything else that needs a support) still picked, the
    // support is missing: keep the rest to revalidate once one is chosen.
    if (picks.headId || picks.noseId || (picks.adapterIds || []).length) return keepRestAsIs();
    // No support and no head: the camera block sits on the base (3.4).
    settleCamera(baseTopOf(baseStack), build, gear, byId, picks, out, notes);
    return { picks: out, notes };
  }

  // Nose fitting: exactly one on a beam nose, none elsewhere (SPEC.md 3.7).
  const noseComponent = byId[picks.noseId] || null;
  let nose = null;
  if (noseComponent) nose = settleMode(noseComponent, picks.noseMode, (v) => whyNose(v, support), notes);
  out.noseId = nose ? nose.id : null;
  out.noseMode = nose ? nose.mode ?? null : null;
  if (needsNoseFitting(support) && !nose) return keepRestAsIs(); // incomplete, like a missing head

  // Adapters, each in its mode.
  const base = stackBaseOf(support, nose);
  const keptAdapters = [];
  for (const id of picks.adapterIds || []) {
    const adapter = byId[id];
    if (!adapter) continue;
    const legal = settleMode(adapter, (picks.adapterModes || {})[id], (v) => whyAdapter(v, base, keptAdapters, support), notes);
    if (legal) keptAdapters.push(legal);
  }
  const adapterStack = orderStack(keptAdapters, base.topMount, base.topFacing);
  out.adapterIds = adapterStack.items.map((adapter) => adapter.id);
  for (const adapter of adapterStack.items) if (adapter.mode) out.adapterModes[adapter.id] = adapter.mode;
  const beneathName = adapterStack.items.length
    ? withMode(adapterStack.items[adapterStack.items.length - 1])
    : withMode(base.piece);

  // Head, and its mode.
  const legalModes = (head) => head.modes.filter((m) => !whyHeadMode(head, m, adapterStack, beneathName));
  let head = byId[picks.headId] || null;
  if (head && legalModes(head).length === 0) {
    notes.push(removedNote(head));
    head = null;
  }
  out.headId = head ? head.id : null;
  if (!head) {
    out.modeName = picks.modeName ?? null;
    keepCameraAsIs();
    return { picks: out, notes };
  }

  let mode = head.modes.find((m) => m.name === picks.modeName);
  if (!mode || whyHeadMode(head, mode, adapterStack, beneathName)) {
    const replacement = legalModes(head)[0];
    // No note: the head follows what the user just did beneath it (5.9).
    mode = replacement;
  }
  out.modeName = mode.name;

  settleCamera(headTopOf(head, mode), build, gear, byId, picks, out, notes);
  return { picks: out, notes };
}

/** What the camera side starts on with no support and no head: the top of
 * the base stack (the floor, an apple box, track, spreaders). */
function baseTopOf(baseStack) {
  const last = baseStack.items[baseStack.items.length - 1];
  return { topMount: baseStack.topMount, topFacing: "up", name: last ? withMode(last) : "the floor" };
}

/** What the camera side starts on: the head's top, facing its mode's way. */
function headTopOf(head, mode) {
  return { topMount: head.topMount, topFacing: mode.cameraMountFacing || "up", name: nameOf(head), headMode: mode.name };
}

/** The camera block's pieces as rigged (3.4): `blockIds`, checked against
 * the block's definition — plates added at its bottom, then what's left of
 * the block after stripping from the bottom (the camera always stays).
 * Returns `{added, rest}` ids, or null if `blockIds` isn't that shape. */
function blockShape(build, byId, blockIds) {
  const defined = build.componentIds;
  if (blockIds == null) return { added: [], rest: [...defined] };
  const ids = blockIds.filter((id) => byId[id] || defined.includes(id));
  const firstDefined = ids.findIndex((id) => defined.includes(id));
  if (firstDefined < 0) return null;
  const added = ids.slice(0, firstDefined);
  const rest = ids.slice(firstDefined);
  const suffix = defined.slice(defined.length - rest.length);
  if (rest.length === 0 || rest.some((id, i) => id !== suffix[i])) return null;
  if (added.some((id) => byId[id]?.category !== "plate")) return null;
  return { added, rest };
}

/**
 * Settle the camera side on `below` (SPEC.md 3.4): plates that no longer
 * mate are removed; a plate added to the block's bottom that no longer
 * mates is taken off it; a block whose pieces don't mate goes back to its
 * definition; and the attach point settles like a head mode, or is left
 * empty when nothing fits (the rig is then incomplete, `missingSlot`).
 */
function settleCamera(below, build, gear, byId, picks, out, notes) {
  const kept = [];
  for (const id of picks.plateIds || []) {
    const plate = byId[id];
    if (!plate || plate.category !== "plate" || kept.some((p) => p.id === id)) continue;
    const stack = stackPlates([...kept, plate], below);
    if (stack.why) notes.push(removedNote(plate));
    else kept.push(plate);
  }
  out.plateIds = kept.map((p) => p.id);
  const plates = stackPlates(kept, below);
  const onBlock = { topMount: plates.topMount, topFacing: plates.topFacing, name: plates.name, headMode: kept.length ? null : below.headMode };

  let shape = blockShape(build, byId, picks.blockIds);
  const piecesOf = (ids) => blockPieces(build, gear, ids);
  if (!shape || whyBlockJoints(build, piecesOf([...shape.added, ...shape.rest]))) {
    if (shape && shape.added.length && !whyBlockJoints(build, piecesOf(shape.rest))) {
      for (const id of shape.added) notes.push(removedNote(byId[id]));
      shape = { added: [], rest: shape.rest };
    } else {
      notes.push(`Reset ${shortOf(build)}`);
      shape = { added: [], rest: [...build.componentIds] };
    }
  }
  // A plate added to the block's bottom that no longer mates below comes off it.
  while (shape.added.length) {
    const bottom = byId[shape.added[0]];
    if (acceptsMount(bottom, onBlock.topMount)) break;
    notes.push(removedNote(bottom));
    shape = { added: shape.added.slice(1), rest: shape.rest };
  }
  const ids = [...shape.added, ...shape.rest];
  const asDefined = ids.length === build.componentIds.length && ids.every((id, i) => id === build.componentIds[i]);
  out.blockIds = asDefined ? null : ids;

  const attachPoints = buildAttachPoints(build, gear, ids);
  const legal = attachPoints.filter((a) => !whyAttach(a, onBlock));
  let attach = attachPoints.find((a) => a.name === picks.attachName);
  if (!attach || whyAttach(attach, onBlock)) {
    // No note: the camera mount follows what the user just did beneath it (5.9).
    attach = legal[0] || null;
  }
  out.attachName = attach ? attach.name : null;
}

/** What the camera block attaches to right now, given revalidated picks:
 * `{below, onBlock, plates}`, or null while the rig below is incomplete. */
function cameraBelow(gear, packageId, picks) {
  const pool = getPackageComponents(gear, packageId);
  const byId = Object.fromEntries(pool.map((c) => [c.id, c]));
  let below = null;
  if (!picks.supportId && !picks.headId) {
    const base = picks.baseItemIds.map((id, i) => variantOf(byId[id], baseModeAt(picks, i)));
    below = baseTopOf(orderStack(base, "ground", "up") || { items: base, topMount: "ground" });
  } else if (picks.headId && picks.modeName) {
    const head = byId[picks.headId];
    below = headTopOf(head, head.modes.find((m) => m.name === picks.modeName));
  }
  if (!below) return null;
  const plates = stackPlates(picks.plateIds.map((id) => byId[id]), below);
  return {
    below,
    plates,
    onBlock: { topMount: plates.topMount, topFacing: plates.topFacing, name: plates.name, headMode: picks.plateIds.length ? null : below.headMode },
  };
}

/**
 * Every slot's candidates, each marked available or not given the picks
 * below it, with a plain-language reason when it isn't (SPEC.md 6). The
 * picks are revalidated first, so this never reasons from an illegal rig.
 */
export function slotOptions(gear, packageId, buildId, rawPicks) {
  const { picks } = revalidatePicks(gear, packageId, buildId, rawPicks);
  const pool = getPackageComponents(gear, packageId);
  const build = getBuild(gear, buildId);
  const byId = Object.fromEntries(pool.map((c) => [c.id, c]));

  const keptBase = picks.baseItemIds.map((id, i) => variantOf(byId[id], baseModeAt(picks, i)));
  const support = picks.supportId ? variantOf(byId[picks.supportId], picks.supportMode, supportVariants) : null;
  const nose = picks.noseId ? variantOf(byId[picks.noseId], picks.noseMode) : null;
  const complete = support && (nose || !needsNoseFitting(support));
  const base = complete ? stackBaseOf(support, nose) : null;
  const keptAdapters = picks.adapterIds.map((id) => variantOf(byId[id], picks.adapterModes[id]));
  const adapterStack = base ? orderStack(keptAdapters, base.topMount, base.topFacing) : null;
  const beneathName = adapterStack?.items.length
    ? withMode(adapterStack.items[adapterStack.items.length - 1])
    : base && withMode(base.piece);
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
  const modeEntry = (component, variant, reason) => ({
    name: variant.mode,
    label: variant.modeLabel || "",
    flipped: isFlipped(variant),
    orientation: isOrientation(component, variant),
    available: !reason,
    reason,
  });
  const withModes = (component, variants, why) => {
    const modes = variants.map((v) => modeEntry(component, v, why(v)));
    return entry(component, modes.some((m) => m.available) ? null : modes[0].reason, { modes });
  };

  // Base layer: judged against the *other* picked items, so a picked one stays available.
  const baseItems = pool
    .filter((c) => c.category === "base")
    .map((item) => {
      const others = keptBase.filter((b) => b.id !== item.id);
      return withModes(item, adapterVariants(item), (v) => whyBaseItem(v, others));
    });

  const supports = pool
    .filter((c) => c.category === "support")
    .map((candidate) => withModes(candidate, supportVariants(candidate), (v) => whySupport(v, keptBase)));

  const NEED_SUPPORT = "Choose a support first.";
  const NEED_NOSE = "Choose a nose fitting first.";
  const noses = pool
    .filter((c) => c.category === "nose")
    .map((candidate) => withModes(candidate, adapterVariants(candidate), (v) => (support ? whyNose(v, support) : NEED_SUPPORT)));

  const notReady = !support ? NEED_SUPPORT : NEED_NOSE;
  const adapters = pool
    .filter((c) => c.category === "adapter")
    .map((adapter) => {
      const others = keptAdapters.filter((a) => a.id !== adapter.id);
      return withModes(adapter, adapterVariants(adapter), (v) => (base ? whyAdapter(v, base, others, support) : notReady));
    });

  const heads = pool
    .filter((c) => c.category === "head")
    .map((candidate) => {
      const modes = candidate.modes.map((m) => {
        const reason = adapterStack ? whyHeadMode(candidate, m, adapterStack, beneathName) : notReady;
        return { name: m.name, label: m.label || m.name, flipped: isFlippedMode(m.name), orientation: true, available: !reason, reason };
      });
      return entry(candidate, modes.some((m) => m.available) ? null : modes[0].reason, { modes });
    });

  // The camera side (3.4): plates, then the block at its attach points.
  const camera = cameraBelow(gear, packageId, picks);
  const NEED_HEAD = support ? "Choose a head first." : NEED_SUPPORT;
  const plates = pool
    .filter((c) => c.category === "plate")
    .map((plate) => {
      if (!camera) return entry(plate, NEED_HEAD);
      const others = picks.plateIds.filter((id) => id !== plate.id).map((id) => byId[id]);
      return entry(plate, stackPlates([...others, plate], camera.below).why || null);
    });
  const attach = buildAttachPoints(build, gear, picks.blockIds).map((point) => {
    const reason = camera ? whyAttach(point, camera.onBlock) : NEED_HEAD;
    return {
      name: point.name,
      label: ATTACH_LABELS[point.name] || point.name,
      flipped: Boolean(point.inverted),
      orientation: true,
      available: !reason,
      reason,
      attach: point,
    };
  });

  return { picks, base: baseItems, support: supports, nose: noses, adapters, head: heads, plates, attach };
}

/**
 * Which required slot is empty, ground up, or null when the rig is
 * complete: "support", "nose" (a beam nose with no nose fitting, SPEC.md
 * 3.7), "head", or "attach" (the camera block fits nothing below it). With
 * no support and no head, the rig is complete when the camera block sits
 * on the base (3.4). The UI asks this rather than knowing which supports
 * take a nose fitting.
 */
export function missingSlot(gear, packageId, buildId, rawPicks) {
  const { picks } = revalidatePicks(gear, packageId, buildId, rawPicks);
  if (!picks.supportId) {
    const onBase = !picks.headId && !picks.noseId && picks.adapterIds.length === 0;
    return onBase && picks.attachName ? null : "support";
  }
  const support = getPackageComponents(gear, packageId).find((c) => c.id === picks.supportId);
  if (needsNoseFitting(support) && !picks.noseId) return "nose";
  if (!picks.headId || !picks.modeName) return "head";
  if (!picks.attachName) return "attach";
  return null;
}

/** The first legal rig: the first support (and nose fitting, if it takes
 * one), head, mode, and attach point that fit. */
export function defaultPicks(gear, packageId, buildId) {
  let picks = EMPTY_PICKS();
  const firstAvailable = (list) => list.find((o) => o.available);
  const support = firstAvailable(slotOptions(gear, packageId, buildId, picks).support);
  if (support) picks = { ...picks, supportId: support.id };
  const nose = firstAvailable(slotOptions(gear, packageId, buildId, picks).nose);
  if (support && nose && needsNoseFitting(support.component)) picks = { ...picks, noseId: nose.id };
  const head = firstAvailable(slotOptions(gear, packageId, buildId, picks).head);
  if (head) picks = { ...picks, headId: head.id };
  // Revalidating fills in the first legal modes and attach point.
  picks = revalidatePicks(gear, packageId, buildId, picks).picks;
  // A camera block that fits nothing on the head gets the first fix (a plate).
  const [fix] = missingSlot(gear, packageId, buildId, picks) === "attach" ? cameraRemedies(gear, packageId, buildId, picks) : [];
  return fix ? revalidatePicks(gear, packageId, buildId, applyEdit(picks, fix.edit)).picks : picks;
}

/**
 * How to present a set of modes (SPEC.md 6): nothing, plain text, an
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

/**
 * The modes a piece's sheet offers (SPEC.md 6): never an orientation —
 * that's a flip on the drawing. None at all while the piece is in an
 * orientation mode (an SLE upside down). `entries` are a slot option's
 * `modes`; `current` is the piece's mode now.
 */
export function sheetModes(entries, current) {
  const now = entries.find((e) => e.name === current);
  if (now && now.orientation) return [];
  return entries.filter((e) => !e.orientation);
}

// --- Flips (SPEC.md 6) ----------------------------------------------------

/**
 * One flip, as one action: the piece's orientation and every mode that
 * depends on it change together, and the rig comes back revalidated — or
 * null when the flip wouldn't leave a complete rig with every piece kept.
 * `piece` is `{slot: "nose"}` (the SLE: upright or reversed ↔ upside down)
 * or `{slot: "head"}` (a head on an offset plate: top ↔ bottom side).
 * Offset plates themselves never flip; flipping their head moves it.
 */
export function flip(gear, packageId, buildId, rawPicks, piece) {
  const { picks } = revalidatePicks(gear, packageId, buildId, rawPicks);
  const byId = Object.fromEntries(getPackageComponents(gear, packageId).map((c) => [c.id, c]));
  let next = null;
  if (piece.slot === "nose" && picks.noseId) {
    const variants = adapterVariants(byId[picks.noseId]);
    const upsideDown = variants.find((v) => isFlippedMode(v.mode));
    if (upsideDown) {
      const nowUpsideDown = isFlippedMode(picks.noseMode);
      const target = nowUpsideDown ? variants.find((v) => !isFlippedMode(v.mode)) : upsideDown;
      next = { ...picks, noseMode: target.mode };
    }
  } else if (piece.slot === "head" && picks.headId && picks.adapterIds.length) {
    // The adapter directly beneath the head must be an offset plate: flip its side.
    const id = picks.adapterIds[picks.adapterIds.length - 1];
    const variants = adapterVariants(byId[id]);
    const now = variants.find((v) => v.mode === (picks.adapterModes[id] ?? variants[0].mode));
    const other = variants.find((v) => (v.mountFacing === "down") !== (now.mountFacing === "down"));
    if (other) next = { ...picks, adapterModes: { ...picks.adapterModes, [id]: other.mode } };
  }
  if (!next) return null;
  // The head's mode and the camera's mount follow: let them settle to the one that fits.
  next = { ...next, modeName: null, attachName: null };
  const { picks: flipped } = revalidatePicks(gear, packageId, buildId, next);
  const kept =
    !missingSlot(gear, packageId, buildId, flipped) &&
    flipped.noseMode === next.noseMode &&
    !whyLost(gear, packageId, buildId, { ...next, modeName: flipped.modeName, attachName: flipped.attachName });
  return kept ? flipped : null;
}

/** The pieces that can flip right now (SPEC.md 6): `{slot, index}` each. */
export function flips(gear, packageId, buildId, rawPicks) {
  return [{ slot: "nose", index: 0 }, { slot: "head", index: 0 }].filter((piece) => flip(gear, packageId, buildId, rawPicks, piece));
}

// --- Editing in the drawing (SPEC.md 6) ------------------------------
//
// The check screen edits the rig where the user tapped: add at an insertion
// point, swap a piece in place, remove one, change a mode. These say what
// fits *at that position* and turn an edit into the next picks; the picks
// then go through revalidatePicks like any other change.

/** Why `items` can't stack in exactly this order on a mount, or null if they
 * can. `startName` names what's beneath the first item. */
function whyNotInOrder(items, startMount, startFacing, startName) {
  let mount = startMount;
  let facing = startFacing;
  let belowName = startName;
  for (const [i, item] of items.entries()) {
    if (!sitsOn(item, mount, i === 0)) {
      if (i > 0 && acceptsMount(item, "floor")) return `${withMode(item)} sit on the bare floor only — nothing goes underneath them.`;
      const where = belowName ? `${belowName} ends in ${plainMount(mount)}` : `here it would sit on ${plainMount(mount)}`;
      return `${withMode(item)} needs ${plainMounts(acceptedMounts(item))} beneath it, but ${where}.`;
    }
    if (!facingAccepted(item, facing)) {
      const required = requiredSupportFacingOf(item);
      return `${withMode(item)} needs ${anFacing(required)} mount beneath it, but the top of ${belowName} faces ${facing}.`;
    }
    const faced = facedVariant(item, facing);
    mount = faced.topMount;
    facing = topFacingOf(faced);
    belowName = withMode(item);
  }
  return null;
}

/** Whether a complete rig is under the floor even at the top of its reach
 * (SPEC.md 5.2): no action should lead there. */
function belowFloorAtEveryLift(gear, packageId, buildId, picks) {
  if (missingSlot(gear, packageId, buildId, picks)) return false;
  try {
    return buildChain(gear, { packageId, buildId, ...picks }).belowFloor > 0;
  } catch {
    return false;
  }
}

const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const MODES_KEY = { base: "baseModes", adapter: "adapterModes" };
const IDS_KEY = { base: "baseItemIds", adapter: "adapterIds", plate: "plateIds" };

/** Would `next` survive revalidation with every piece still in it, in the
 * same order and mode? A head mode or camera mount switching is fine.
 * Returns the reason it wouldn't, or null. */
function whyLost(gear, packageId, buildId, next) {
  const { picks, notes } = revalidatePicks(gear, packageId, buildId, next);
  // The camera block's pieces: null is the block as defined.
  const asRigged = (ids) => ids ?? getBuild(gear, buildId).componentIds;
  const sameModes = (slot) =>
    next[IDS_KEY[slot]].every((id) => ((next[MODES_KEY[slot]] || {})[id] ?? null) === (picks[MODES_KEY[slot]][id] ?? null));
  const sameBaseModes = next.baseItemIds.every((_, i) => baseModeAt(next, i) === baseModeAt(picks, i));
  const kept =
    sameList(picks.baseItemIds, next.baseItemIds) &&
    sameBaseModes &&
    picks.supportId === next.supportId &&
    (picks.noseId ?? null) === (next.noseId ?? null) &&
    sameList(picks.adapterIds, next.adapterIds) &&
    sameModes("adapter") &&
    (picks.headId ?? null) === (next.headId ?? null) &&
    (!next.headId || Boolean(picks.modeName)) &&
    sameList(picks.plateIds, next.plateIds || []) &&
    sameList(asRigged(picks.blockIds), asRigged(next.blockIds)) &&
    Boolean(picks.attachName);
  if (kept) return belowFloorAtEveryLift(gear, packageId, buildId, picks) ? "Below the floor" : null;
  return notes.find((n) => /^(Cleared|Removed)/.test(n)) || notes[0] || "The rest of the rig wouldn't fit with it.";
}

/** Everything that could go in a base-layer or adapter position, one entry
 * per usable way (a multi-mode item once per mode). */
function candidatesFor(pool, slot) {
  return pool.filter((c) => c.category === slot).flatMap(adapterVariants);
}

const optionEntry = (candidate, reason) => ({
  id: candidate.id,
  mode: candidate.mode ?? null,
  name: nameOf(candidate),
  label: withMode(candidate),
  rise: candidate.rise,
  component: candidate,
  available: !reason,
  reason,
});

/** Why `candidate` can't be at `index` of the base layer or adapter stack,
 * given `list` (the other pieces in that slot, in stack order), or null. */
function whyAtPosition(ctx, slot, list, index, candidate, replacing) {
  const { gear, packageId, buildId, picks, support, stackBase } = ctx;
  const ids = picks[IDS_KEY[slot]];
  if (!isRepeatable(candidate) && ids.some((id, i) => id === candidate.id && !(replacing && i === index))) {
    return `${nameOf(candidate)} is already in the rig.`;
  }
  const items = [...list];
  items.splice(index, replacing ? 1 : 0, candidate);

  if (slot === "plate") {
    if (!ctx.camera) return "Choose a head first.";
    const why = stackPlates(items, ctx.camera.below).why;
    if (why) return why;
  } else if (slot === "base") {
    if (appleBoxOrientationViolation([candidate])) return whyBaseItem(candidate, []);
    const why = whyNotInOrder(items, "ground", "up", null);
    if (why) return why;
    // The support may switch wheel modes to ride it (round track: ETW).
    if (support && supportVariants(ctx.supportComponent).every((v) => whySupport(v, items))) {
      return whySupport(support, items);
    }
  } else {
    if (candidate.requiresFamily && candidate.requiresFamily !== support.family) {
      return whyAdapter(candidate, stackBase, [], support);
    }
    const why = whyNotInOrder(items, stackBase.topMount, stackBase.topFacing, withMode(stackBase.piece));
    if (why) return why;
  }

  // Whatever is above must still have somewhere to go.
  const next = {
    ...picks,
    [IDS_KEY[slot]]: items.map((c) => c.id),
    ...(MODES_KEY[slot]
      ? {
          [MODES_KEY[slot]]:
            slot === "base"
              ? items.map((c) => c.mode ?? null)
              : Object.fromEntries(items.filter((c) => c.mode).map((c) => [c.id, c.mode])),
        }
      : {}),
  };
  return whyLost(gear, packageId, buildId, next);
}

function editContext(gear, packageId, buildId, rawPicks) {
  const { picks } = revalidatePicks(gear, packageId, buildId, rawPicks);
  const pool = getPackageComponents(gear, packageId);
  const byId = Object.fromEntries(pool.map((c) => [c.id, c]));
  const supportComponent = byId[picks.supportId] || null;
  const support = supportComponent && variantOf(supportComponent, picks.supportMode, supportVariants);
  const nose = picks.noseId ? variantOf(byId[picks.noseId], picks.noseMode) : null;
  // Adapters need something to stack on: the nose fitting, or a support that takes none.
  const stackBase = support && (nose || !needsNoseFitting(support)) ? stackBaseOf(support, nose) : null;
  const head = byId[picks.headId] || null;
  const base = picks.baseItemIds.map((id, i) => variantOf(byId[id], baseModeAt(picks, i)));
  const adapters = picks.adapterIds.map((id) => variantOf(byId[id], picks.adapterModes[id]));
  const plates = picks.plateIds.map((id) => byId[id]);
  const camera = cameraBelow(gear, packageId, picks);
  return { gear, packageId, buildId, picks, pool, byId, supportComponent, support, nose, stackBase, head, base, adapters, plates, camera };
}

/** Where an insertion point is, in plain words: "on the floor", "on
 * Standard Level Head (Upright)", "under O'Connor 2575D". */
function positionWords(ctx, slot, index) {
  if (slot === "base") return index === 0 ? "on the floor" : `on ${withMode(ctx.base[index - 1])}`;
  if (slot === "plate") return `on ${index === 0 ? ctx.camera.below.name : nameOf(ctx.plates[index - 1])}`;
  if (index > 0 && index === ctx.adapters.length && ctx.head) return `under ${nameOf(ctx.head)}`;
  return `on ${index === 0 ? withMode(ctx.stackBase.piece) : withMode(ctx.adapters[index - 1])}`;
}

/**
 * Every insertion point in the rig (SPEC.md 6) with what may be added
 * there: `base` 0 is the floor and `base` i sits on base item i-1; `adapter`
 * 0 sits on the nose fitting (or the support, if it takes none) and
 * `adapter` i on adapter i-1. Adapter points only exist once there's
 * something to stack on.
 *
 * @returns {{slot: "base"|"adapter", index: number, where: string, options: object[]}[]}
 */
export function insertOptions(gear, packageId, buildId, rawPicks) {
  const ctx = editContext(gear, packageId, buildId, rawPicks);
  const gaps = [];
  const slots = [["base", ctx.base]];
  if (ctx.stackBase) slots.push(["adapter", ctx.adapters]);
  if (ctx.camera) slots.push(["plate", ctx.plates]);
  for (const [slot, list] of slots) {
    for (let index = 0; index <= list.length; index++) {
      const options = candidatesFor(ctx.pool, slot).map((candidate) =>
        optionEntry(candidate, whyAtPosition(ctx, slot, list, index, candidate, false))
      );
      gaps.push({ slot, index, where: positionWords(ctx, slot, index), options });
    }
  }
  return gaps;
}

/**
 * Everything that can legally be added to the rig (SPEC.md 6's Add
 * button): one entry per component, with every position it fits. At each
 * position it goes in its first mode that fits there.
 *
 * @returns {{id, name, label, rise, component, positions: {slot, index, mode, where}[]}[]}
 */
export function addOptions(gear, packageId, buildId, rawPicks) {
  const byComponent = new Map();
  // With no support and no head, a support can go back under the camera (3.4).
  const ctx = editContext(gear, packageId, buildId, rawPicks);
  if (!ctx.picks.supportId && !ctx.picks.headId) {
    for (const option of slotOptions(gear, packageId, buildId, ctx.picks).support.filter((o) => o.available)) {
      byComponent.set(option.id, {
        id: option.id,
        name: option.name,
        label: option.name,
        rise: null,
        component: option.component,
        positions: [{ slot: "support", index: 0, mode: null, where: "under the camera" }],
      });
    }
  }
  for (const gap of insertOptions(gear, packageId, buildId, rawPicks)) {
    const placed = new Set();
    for (const option of gap.options) {
      if (!option.available || placed.has(option.id)) continue;
      placed.add(option.id);
      if (!byComponent.has(option.id)) {
        byComponent.set(option.id, { id: option.id, name: option.name, label: option.name, rise: option.rise, component: option.component, positions: [] });
      }
      byComponent.get(option.id).positions.push({ slot: gap.slot, index: gap.index, mode: option.mode, where: gap.where });
    }
  }
  return [...byComponent.values()];
}

/**
 * What may replace one piece of the rig (SPEC.md 6). Base items and
 * adapters are judged in their exact place; a support needs only to sit on
 * the base layer, and a head needs one legal mode on what's beneath it.
 * The piece itself isn't listed (its modes are a toggle, not a swap).
 */
export function swapOptions(gear, packageId, buildId, rawPicks, slot, index = 0) {
  const ctx = editContext(gear, packageId, buildId, rawPicks);
  if (slot === "base" || slot === "adapter" || slot === "plate") {
    const list = { base: ctx.base, adapter: ctx.adapters, plate: ctx.plates }[slot];
    const current = list[index];
    // One entry per component, in its first mode that fits — preferring the
    // side the current piece is on, so a swap doesn't flip the head. Which
    // side is a flip on the drawing, never a swap choice (5.9).
    const sameSide = (c) => (c.mountFacing === "down") === (current?.mountFacing === "down");
    const byComponent = new Map();
    const variants = candidatesFor(ctx.pool, slot)
      .filter((c) => !(current && c.id === current.id))
      .sort((a, b) => Number(sameSide(b)) - Number(sameSide(a)));
    for (const candidate of variants) {
      const entry = optionEntry(candidate, whyAtPosition(ctx, slot, list, index, candidate, true));
      const seen = byComponent.get(candidate.id);
      if (!seen || (!seen.available && entry.available)) byComponent.set(candidate.id, entry);
    }
    // Listed in pool order, each by its own name; a full apple's face is changed in its sheet.
    return [...new Set(candidatesFor(ctx.pool, slot).map((c) => c.id))]
      .filter((id) => byComponent.has(id))
      .map((id) => ({ ...byComponent.get(id), label: byComponent.get(id).name }));
  }
  const opts = slotOptions(gear, packageId, buildId, ctx.picks);
  const currentId = { support: ctx.picks.supportId, nose: ctx.picks.noseId, head: ctx.picks.headId }[slot];
  return opts[slot]
    .filter((o) => o.id !== currentId)
    // A support, nose fitting, or head has no single rise (a range, or one
    // per mode), so none is given.
    .map((o) => ({ ...optionEntry({ ...o.component, mode: null }, o.reason), rise: null, modes: o.modes }));
}

/**
 * Turn one edit into the next picks (not yet revalidated):
 * - `{op: "insert", slot: "base"|"adapter", index, id, mode?}`
 * - `{op: "swap", slot: "base"|"adapter", index, id, mode?}`, or
 *   `{op: "swap", slot: "support"|"nose"|"head", id}` (a support or nose
 *   fitting starts in its first mode that fits)
 * - `{op: "remove", slot: "base"|"adapter", index}`
 * - `{op: "mode", slot: "base"|"adapter", index, mode}`, or `{op: "mode",
 *   slot: "support"|"nose"|"head", mode}` (a wheel set, a nose fitting's
 *   mode, a head mode), or `{op: "mode", slot: "build", mode}` (the camera's
 *   attach point)
 */
export function applyEdit(picks, edit) {
  const next = {
    ...picks,
    baseItemIds: [...picks.baseItemIds],
    baseModes: picks.baseItemIds.map((_, i) => baseModeAt(picks, i)),
    adapterIds: [...picks.adapterIds],
    adapterModes: { ...picks.adapterModes },
    plateIds: [...(picks.plateIds || [])],
    blockIds: picks.blockIds ?? null,
  };
  // The camera block's pieces as rigged (3.4): the edit carries them, from blockOptions.
  if (edit.op === "block") return { ...next, blockIds: edit.ids };
  // Taking the support away takes everything that needs it (3.4, 5.9).
  if (edit.op === "remove" && edit.slot === "support") {
    return { ...next, supportId: null, supportMode: null, noseId: null, noseMode: null, adapterIds: [], adapterModes: {}, headId: null, modeName: null };
  }
  // A support added back under the camera.
  if (edit.op === "insert" && edit.slot === "support") return { ...next, supportId: edit.id, supportMode: null };
  const ids = next[IDS_KEY[edit.slot]];
  const modes = next[MODES_KEY[edit.slot]];
  // Base modes go by position (an array); adapter modes by id.
  const byPosition = edit.slot === "base";
  const setMode = (id, mode) => {
    if (modes && mode) modes[id] = mode;
  };
  const dropMode = (id) => {
    if (id && modes && !ids.includes(id)) delete modes[id];
  };

  switch (edit.op) {
    case "insert":
      ids.splice(edit.index, 0, edit.id);
      if (byPosition) modes.splice(edit.index, 0, edit.mode ?? null);
      else setMode(edit.id, edit.mode);
      break;
    case "remove": {
      const [gone] = ids.splice(edit.index, 1);
      if (byPosition) modes.splice(edit.index, 1);
      else dropMode(gone);
      break;
    }
    case "swap":
      if (edit.slot === "support") Object.assign(next, { supportId: edit.id, supportMode: null });
      else if (edit.slot === "nose") Object.assign(next, { noseId: edit.id, noseMode: null });
      else if (edit.slot === "head") next.headId = edit.id;
      else {
        const [gone] = ids.splice(edit.index, 1, edit.id);
        if (byPosition) modes.splice(edit.index, 1, edit.mode ?? null);
        else {
          dropMode(gone);
          setMode(edit.id, edit.mode);
        }
      }
      break;
    case "mode":
      if (byPosition) modes[edit.index] = edit.mode;
      else if (modes) modes[ids[edit.index]] = edit.mode;
      else if (edit.slot === "support") next.supportMode = edit.mode;
      else if (edit.slot === "nose") next.noseMode = edit.mode;
      else if (edit.slot === "head") next.modeName = edit.mode;
      else if (edit.slot === "build") next.attachName = edit.mode;
      break;
    default:
      throw new Error(`Unknown edit "${edit.op}"`);
  }
  return next;
}

// --- The camera block's sheet, and fixing a camera that fits nothing (3.4) ---

/** Whether `next` is a complete rig that kept every piece `next` names. */
function stillWorks(gear, packageId, buildId, next) {
  return !whyLost(gear, packageId, buildId, next) && !missingSlot(gear, packageId, buildId, next);
}

/**
 * The camera block as rigged, for its sheet (SPEC.md 3.4, 7.2): its pieces
 * top to bottom with their rises, and the block edits that fit right now —
 * strip the bottom piece, put the last removed one back, add a plate to its
 * bottom. Each edit is `{op: "block", ids}`, offered only when the rig
 * still works after it.
 *
 * @returns {{name, pieces: {id, name, rise}[], strip, restore, add: {label, edit}[]}}
 */
export function blockOptions(gear, packageId, buildId, rawPicks) {
  const { picks } = revalidatePicks(gear, packageId, buildId, rawPicks);
  const build = getBuild(gear, buildId);
  const pool = getPackageComponents(gear, packageId);
  const ids = picks.blockIds ?? build.componentIds;
  const pieces = blockPieces(build, gear, ids);
  const works = (edit) => stillWorks(gear, packageId, buildId, applyEdit(picks, edit));
  const offer = (label, ids) => {
    const edit = { op: "block", ids };
    return works(edit) ? { label, edit } : null;
  };

  const strip = pieces.length > 1 ? offer(`Remove ${nameOf(pieces[0])}`, ids.slice(1)) : null;
  // Put back the piece just below what's left of the block as defined.
  const { restoreId } = blockOptionsUnchecked(gear, buildId, picks);
  const restore = restoreId ? offer(`Put ${nameOf(blockPieces(build, gear, [restoreId])[0])} back`, [restoreId, ...ids]) : null;
  const add = pool
    .filter((c) => c.category === "plate" && ids[0] !== c.id)
    .map((plate) => offer(`Add ${nameOf(plate)} to the bottom`, [plate.id, ...ids]))
    .filter(Boolean);

  return {
    name: nameOf(build),
    pieces: [...pieces].reverse().map((piece) => ({ id: piece.id, name: nameOf(piece), rise: pieceRise(piece), camera: piece.category === "camera-body" })),
    strip,
    restore,
    add,
  };
}

/**
 * When the camera block fits nothing below it (`missingSlot` says
 * "attach"), the edits that would make the rig complete (SPEC.md 6): a
 * plate on the head, a plate added to the block's bottom, or the last
 * stripped piece put back. `{label, edit}` each; empty if nothing helps.
 */
export function cameraRemedies(gear, packageId, buildId, rawPicks) {
  const { picks } = revalidatePicks(gear, packageId, buildId, rawPicks);
  const camera = cameraBelow(gear, packageId, picks);
  if (!camera) return [];
  const pool = getPackageComponents(gear, packageId);
  const block = blockOptionsUnchecked(gear, buildId, picks);
  const candidates = [
    ...pool
      .filter((c) => c.category === "plate" && !picks.plateIds.includes(c.id))
      .map((plate) => ({ label: `${nameOf(plate)} on ${camera.onBlock.name}`, edit: { op: "insert", slot: "plate", index: picks.plateIds.length, id: plate.id } })),
    ...pool
      .filter((c) => c.category === "plate" && block.ids[0] !== c.id)
      .map((plate) => ({ label: `${nameOf(plate)} on the bottom of ${block.name}`, edit: { op: "block", ids: [plate.id, ...block.ids] } })),
    ...(block.restoreId ? [{ label: `Put ${nameOf(blockPieces(getBuild(gear, buildId), gear, [block.restoreId])[0])} back on ${block.name}`, edit: { op: "block", ids: [block.restoreId, ...block.ids] } }] : []),
  ];
  return candidates.filter(({ edit }) => {
    const next = applyEdit(picks, edit);
    return !missingSlot(gear, packageId, buildId, next) && !whyLost(gear, packageId, buildId, next);
  });
}

/** The block's ids as rigged, and the stripped piece that would go back first. */
function blockOptionsUnchecked(gear, buildId, picks) {
  const build = getBuild(gear, buildId);
  const ids = picks.blockIds ?? build.componentIds;
  const defined = build.componentIds;
  const firstDefined = defined.indexOf(ids.find((id) => defined.includes(id)));
  return { name: nameOf(build), ids, restoreId: ids[0] === defined[firstDefined] && firstDefined > 0 ? defined[firstDefined - 1] : null };
}

/**
 * Taking the support away (SPEC.md 6): with it go the nose fitting, the
 * Mitchell adapters, and the head, and the camera block sits on the base.
 * Offered only when that rig works. `{label, edit}`, or null.
 */
export function supportRemoval(gear, packageId, buildId, rawPicks) {
  const { picks } = revalidatePicks(gear, packageId, buildId, rawPicks);
  if (!picks.supportId) return null;
  const pool = getPackageComponents(gear, packageId);
  const byId = Object.fromEntries(pool.map((c) => [c.id, c]));
  const edit = { op: "remove", slot: "support" };
  const next = revalidatePicks(gear, packageId, buildId, applyEdit(picks, edit)).picks;
  if (missingSlot(gear, packageId, buildId, next)) return null;
  const gone = [picks.supportId, picks.noseId, ...picks.adapterIds, picks.headId].filter(Boolean).map((id) => nameOf(byId[id]));
  const list = gone.length > 1 ? `${gone.slice(0, -1).join(", ")} and ${gone[gone.length - 1]}` : gone[0];
  return { label: `Remove ${list}`, edit };
}
