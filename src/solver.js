// Chain construction and height evaluation. See SPEC.md section 5.
import { stackLayout } from "./stack.js";
import { getPackage, getBuild, blockPieces, buildAttachPoints, riseRangeOf, supportInterval, supportMoveableInterval } from "./model.js";
import {
  acceptsMount,
  adapterVariants,
  needsNoseFitting,
  orderStack,
  ruleViolations,
  stackBaseOf,
  supportFacingOk,
  headModeSupportFacing,
  isRepeatable,
  stackPlates,
  whyAttach,
  whyBlockJoints,
  appleBoxOrientationViolation,
  supportVariants,
} from "./rules.js";

/**
 * Every subset of `items`, from size 0 up to and including `maxSize`
 * (or items.length, if smaller). Order within a subset follows the
 * input array; subsets themselves are not repeated.
 */
export function combinations(items, maxSize) {
  const cap = Math.min(maxSize, items.length);
  const result = [[]];
  const build = (start, current) => {
    if (current.length > 0) result.push([...current]);
    if (current.length === cap) return;
    for (let i = start; i < items.length; i++) {
      current.push(items[i]);
      build(i + 1, current);
      current.pop();
    }
  };
  build(0, []);
  return result;
}

function packagePool(gear, packageId) {
  return getPackage(gear, packageId).componentIds.map((id) => gear.components.find((c) => c.id === id));
}

/** No contribution: a missing support, nose fitting, or head (3.4). */
const NONE = { min: 0, max: 0 };

/**
 * A chain's interval, given {min, max} contributions from the support, the
 * nose fitting, and the head. The one formula both computeInterval (full
 * range) and computeMoveableInterval (moveable range only) apply, so they
 * can't drift from each other on how base, adapter, plate, and camera-block
 * rises get folded in.
 */
function foldIntoChain({ baseItems, adapters, plates = [], attach }, supportRange, noseRange, headRange) {
  const fixedRise = [...baseItems, ...adapters, ...plates].reduce((sum, c) => sum + c.rise, 0);
  return {
    min: fixedRise + supportRange.min + noseRange.min + headRange.min + attach.rise,
    max: fixedRise + supportRange.max + noseRange.max + headRange.max + attach.rise,
  };
}

/** A nose fitting's rise range (SPEC.md 3.7), or nothing when there's none. */
const noseRangeOf = (nose) => (nose ? riseRangeOf(nose) : NONE);

/**
 * A chain's rise interval (SPEC.md 5.2 step 1): sum of fixed rises (base
 * layer, adapters, plates, camera block at its attach point) plus the
 * support's, nose fitting's, and head's full ranges. Shared by every way a
 * chain gets built so the arithmetic lives in exactly one place.
 */
function computeInterval(parts) {
  const { support, nose, mode } = parts;
  return foldIntoChain(parts, support ? supportInterval(support) : NONE, noseRangeOf(nose), mode ? riseRangeOf(mode) : NONE);
}

/**
 * A chain's moveable interval (SPEC.md 3.5 / 5.2 step 1): the same shape
 * as computeInterval, but counting only range a `moveable` component
 * contributes — an `adjustable` sub-range like `legRange` (3.2) is
 * excluded. Zero-width when the chain has no moveable component at all.
 */
function computeMoveableInterval(parts) {
  const { support, nose, mode } = parts;
  // A nose fitting's range is adjustable, not moveable: it adds no width here.
  const noseLow = noseRangeOf(nose).min;
  // Nor is a head's (the Lambda 50's platform).
  const headLow = mode ? riseRangeOf(mode).min : 0;
  return foldIntoChain(parts, support ? supportMoveableInterval(support) : NONE, { min: noseLow, max: noseLow }, { min: headLow, max: headLow });
}

/**
 * Adjustability (SPEC.md 3.5), most to least capable. A component with
 * no `adjustability` field is `fixed` — the implied default for anything
 * with no range.
 */
const ADJUSTABILITY_RANK = { fixed: 0, adjustable: 1, moveable: 2 };
const ADJUSTABILITY_BY_RANK = ["fixed", "adjustable", "moveable"];

/**
 * A chain's adjustability is the most capable type found among its
 * components (SPEC.md 3.5): it scans every slot, so any part with its own
 * range counts.
 */
function chainAdjustability({ baseItems, adapters, support, nose, head, plates = [], build }) {
  const components = [...baseItems, ...adapters, support, nose, head, ...plates, build].filter(Boolean);
  const maxRank = Math.max(...components.map((c) => ADJUSTABILITY_RANK[c.adjustability] ?? ADJUSTABILITY_RANK.fixed));
  return ADJUSTABILITY_BY_RANK[maxRank];
}

/**
 * Assemble a chain's derived fields (interval, moveable interval, piece
 * count, adjustability) from its resolved parts. The one place a chain
 * object is built, so enumerateChains and buildChain can't drift from
 * each other on what a chain even is. A chain with no support
 * has no nose fitting, adapters, or head either (3.4).
 */
function assembleChain(parts) {
  const { baseItems, adapters, support = null, nose = null, head = null, mode = null, plates = [], build, blockPieces = [], attach } = parts;
  const { min, max } = computeInterval(parts);
  const moveableInterval = computeMoveableInterval(parts);
  return {
    baseItems,
    adapters,
    support,
    nose,
    head,
    mode,
    plates,
    build,
    blockPieces,
    attach,
    min,
    max,
    moveableInterval,
    // Every piece, the camera block counted as one.
    pieceCount: baseItems.length + adapters.length + plates.length + [support, nose, head].filter(Boolean).length + 1,
    adjustability: chainAdjustability(parts),
  };
}

/** SPEC.md 3.1: the default base-layer stacking cap. Taller stacks are
 * legal but flagged in the UI — this is the single place that "2" is
 * defined, so nothing else hardcodes it. */
export const DEFAULT_MAX_BASE_LAYER_ITEMS = 2;

/** Whether a chain's base layer is past the stacking cap (SPEC.md 3.1) —
 * legal, but flagged. Lives here so no UI compares counts to a cap. */
export function exceedsBaseLayerCap(chain, cap = DEFAULT_MAX_BASE_LAYER_ITEMS) {
  return chain.baseItems.length > cap;
}

/** The default cap on adapters `enumerateChains` combines per chain, kept
 * low so exhaustive combination search stays fast. Configurable per call. */
export const DEFAULT_MAX_ADAPTERS = 2;

/**
 * The one place a chain is checked and built (SPEC.md 2, 2.1). Takes the
 * chosen parts — base items and adapters in any order — stacks each in a
 * valid order, checks every mount, facing, and hard rule, and returns
 * either `{ chain }` or `{ violations }`. Mount checks and the 2.1 rules
 * (family, apple boxes) are reported separately, each naming what broke.
 * enumerateChains drops violating chains; buildChain throws.
 */
function resolveChain({ baseItems, adapters, support = null, nose = null, head = null, mode = null, plates = [], build, blockPieces: pieces = [], attach }) {
  const violations = [];

  const baseStack = orderStack(baseItems, "ground", "up");
  if (!baseStack) {
    violations.push(`Mount mismatch: base-layer items ${names(baseItems)} can't be stacked on the ground`);
  } else if (support && !acceptsMount(support, baseStack.topMount)) {
    violations.push(
      `Mount mismatch: support "${support.name || support.id}" doesn't sit on "${baseStack.topMount}" (it accepts ${[].concat(support.bottomMount).join(" or ")})`
    );
  }

  // The support, nose fitting, adapters, and head come and go together (3.4).
  let adapterStack = { items: adapters };
  let below = null; // what the camera side starts on
  if (!support || !head) {
    if (support || head || nose || adapters.length) {
      violations.push(`Incomplete: a ${support ? "support needs a head" : "head needs a support"} (only the camera block may sit on the base alone)`);
    } else if (baseStack) {
      const last = baseStack.items[baseStack.items.length - 1];
      below = { topMount: baseStack.topMount, topFacing: "up", name: last ? last.name || last.id : "the floor" };
    }
  } else {
    // The nose fitting (SPEC.md 3.7): exactly one on a beam nose, none elsewhere.
    if (needsNoseFitting(support) && !nose) {
      violations.push(`Missing nose fitting: support "${support.name || support.id}" needs one`);
    } else if (nose && !acceptsMount(nose, support.topMount)) {
      violations.push(
        `Mount mismatch: nose fitting "${nose.name || nose.id}" doesn't mount to support "${support.name || support.id}" (top mount "${support.topMount}")`
      );
    }

    const base = stackBaseOf(support, nose);
    adapterStack = orderStack(adapters, base.topMount, base.topFacing);
    if (!adapterStack) {
      violations.push(
        `Mount or facing mismatch: adapters ${names(adapters)} can't be stacked on "${base.piece.name || base.piece.id}" (top mount "${base.topMount}") in any order`
      );
    } else if (!acceptsMount(head, adapterStack.topMount)) {
      violations.push(
        `Mount mismatch: head "${head.name || head.id}" (bottomMount "${head.bottomMount}") doesn't mount to "${adapterStack.topMount}"`
      );
    } else if (!supportFacingOk(adapterStack.topFacing, headModeSupportFacing(mode))) {
      const beneath = adapterStack.items.length
        ? adapterStack.items[adapterStack.items.length - 1]
        : base.piece;
      violations.push(
        `Facing mismatch: head "${head.name || head.id}" in ${mode.name} mode needs ${headModeSupportFacing(mode) === "up" ? "an up" : "a down"}-facing mount beneath it, but "${beneath.name || beneath.id}"${beneath.mode ? ` (${beneath.mode} mode)` : ""} has its top mount facing ${adapterStack.topFacing}`
      );
    }
    below = { topMount: head.topMount, topFacing: mode.cameraMountFacing || "up", name: head.name || head.id, headMode: mode.name };
  }

  // The camera side (3.4): plates, then the camera block at its attach point.
  let plateStack = { items: [] };
  if (below) {
    plateStack = stackPlates(plates, below);
    if (plateStack.why) {
      violations.push(`Mount mismatch: ${plateStack.why}`);
    } else {
      const onBlock = { ...below, topMount: plateStack.topMount, topFacing: plateStack.topFacing, name: plateStack.name, headMode: plates.length ? null : below.headMode };
      const why = whyAttach(attach, onBlock);
      if (why) violations.push(`Camera mismatch: ${why}`);
    }
  }
  const joints = whyBlockJoints(build, pieces);
  if (joints) violations.push(`Camera block mismatch: ${joints}`);

  if (support) violations.push(...ruleViolations(baseItems, adapters, support, nose));
  else violations.push(...[appleBoxOrientationViolation(baseItems)].filter(Boolean));

  if (violations.length > 0) return { violations };
  const chain = floorLimited(
    assembleChain({
      baseItems: baseStack.items,
      adapters: adapterStack.items,
      support,
      nose,
      head,
      mode,
      plates: plateStack.items,
      build,
      blockPieces: pieces,
      attach,
    })
  );
  return { chain };
}

/**
 * Nothing below the floor (SPEC.md 5.2): laid out fully retracted, the
 * lowest piece as drawn — an inverted camera's body, a hanging head — must
 * clear the floor. Every piece above the support rises with any extension,
 * so the reach's `min` rises by however far the lowest piece is under the
 * floor, and the moveable interval is cut to match. `retracted` keeps the
 * fully retracted lens height, which the layout allocates extension from.
 */
function floorLimited(chain) {
  const under = -stackLayout(chain, null).lowest;
  const limited = { ...chain, retracted: chain.min, belowFloor: 0 };
  if (!(under > 0)) return limited;
  const min = chain.min + under;
  if (min > chain.max) {
    // Under the floor even at the top of its reach: it can't be used at all.
    // It still builds, drawn at the top, so the check can say how far under.
    return { ...limited, min: chain.max, moveableInterval: { min: chain.max, max: chain.max }, belowFloor: min - chain.max };
  }
  return {
    ...limited,
    min,
    moveableInterval: { min: Math.max(chain.moveableInterval.min, min), max: Math.max(chain.moveableInterval.max, min) },
  };
}

function names(items) {
  return items.map((c) => `"${c.name || c.id}"`).join(", ");
}

/**
 * Enumerate every mount-compatible chain from the package pool for a
 * given build, stacked so every mount and facing mates and no chain
 * breaks a hard rule (2, 2.1). Does not evaluate against a target; used
 * by tests that check a rule against every legal combination, not by
 * the app itself.
 *
 * @param {object} gear - merged gear data
 * @param {object} opts
 * @param {string} opts.packageId
 * @param {string} opts.buildId
 * @param {number} [opts.maxBaseLayerItems=DEFAULT_MAX_BASE_LAYER_ITEMS]
 * @param {number} [opts.maxAdapters=DEFAULT_MAX_ADAPTERS]
 */
export function enumerateChains(
  gear,
  { packageId, buildId, maxBaseLayerItems = DEFAULT_MAX_BASE_LAYER_ITEMS, maxAdapters = DEFAULT_MAX_ADAPTERS }
) {
  const pool = packagePool(gear, packageId);
  const build = getBuild(gear, buildId);

  // Base items and adapters in each of their modes (a full apple's faces).
  const baseVariantPool = pool.filter((c) => c.category === "base").flatMap(adapterVariants);
  const adapterVariantPool = pool.filter((c) => c.category === "adapter").flatMap(adapterVariants);
  // Supports in each wheel mode; nose fittings in each of their modes.
  const supports = pool.filter((c) => c.category === "support").flatMap(supportVariants);
  const noseVariantPool = pool.filter((c) => c.category === "nose").flatMap(adapterVariants);
  const nosesFor = (support) => (needsNoseFitting(support) ? noseVariantPool : [null]);
  const heads = pool.filter((c) => c.category === "head");
  const attachPoints = buildAttachPoints(build, gear);
  const pieces = blockPieces(build, gear);
  // No plate, or one (the Euro plate under a QR-plated block).
  const plateCombos = [[], ...pool.filter((c) => c.category === "plate").map((plate) => [plate])];

  // One physical box is in one orientation at a time.
  const baseCombos = combinations(baseVariantPool, maxBaseLayerItems).filter(
    (combo) => new Set(combo.map((b) => b.id)).size === combo.length
  );
  // One physical adapter appears once, in one mode: drop combos that use
  // two modes of the same adapter.
  const adapterCombos = combinations(adapterVariantPool, maxAdapters).filter(
    (combo) => new Set(combo.map((a) => a.id)).size === combo.length
  );
  const chains = [];

  for (const baseCombo of baseCombos) {
    for (const support of supports) {
      for (const nose of nosesFor(support)) {
      for (const adapterCombo of adapterCombos) {
        for (const head of heads) {
          for (const mode of head.modes) {
            for (const plates of plateCombos) {
              for (const attach of attachPoints) {
                const { chain } = resolveChain({
                  baseItems: baseCombo,
                  adapters: adapterCombo,
                  support,
                  nose,
                  head,
                  mode,
                  plates,
                  build,
                  blockPieces: pieces,
                  attach,
                });
                // A rig under the floor at every lift is no candidate (5.8).
                if (chain && !chain.belowFloor) chains.push(chain);
              }
            }
          }
        }
      }
      }
    }
  }

  return chains;
}

/**
 * Resolve an explicit chain selection into the same shape enumerateChains
 * produces (SPEC.md 5.1): the app's check screen calls this directly. An
 * explicit selection is not exempt from the mount/facing rules in section
 * 2 — a mismatched one throws rather than being silently summed.
 *
 * @param {object} gear
 * @param {object} selection
 * @param {string} selection.packageId
 * @param {string} selection.buildId
 * @param {string[]} [selection.baseItemIds]
 * @param {string} selection.supportId
 * @param {string[]} [selection.adapterIds]
 * @param {Object<string,string>} [selection.adapterModes] - adapter id -> mode name;
 *   an adapter with modes that isn't listed is used in its first mode
 * @param {string} selection.headId
 * @param {string} selection.modeName
 * @param {string} selection.attachName
 */
export function buildChain(
  gear,
  {
    packageId,
    buildId,
    baseItemIds = [],
    baseModes = {},
    supportId,
    supportMode,
    noseId = null,
    noseMode,
    adapterIds = [],
    adapterModes = {},
    headId,
    modeName,
    plateIds = [],
    blockIds = null,
    attachName,
  }
) {
  const pkg = getPackage(gear, packageId);
  const poolIds = new Set(pkg.componentIds);
  const byId = Object.fromEntries(gear.components.map((c) => [c.id, c]));

  const resolveInPool = (id, label) => {
    if (!id || !poolIds.has(id)) throw new Error(`${label} "${id}" is not in package "${packageId}"`);
    return byId[id];
  };

  if (new Set(adapterIds).size !== adapterIds.length) {
    throw new Error("The same adapter can't be used twice in one chain");
  }
  const inMode = (component, wanted, label, variantsOf = adapterVariants) => {
    const variants = variantsOf(component);
    if (wanted === undefined) return variants[0];
    const variant = variants.find((v) => v.mode === wanted);
    if (!variant) throw new Error(`${label} "${component.id}" has no mode "${wanted}"`);
    return variant;
  };
  // Apple boxes may repeat (SPEC.md 3.1); anything else is one of each.
  const nonRepeating = baseItemIds.filter((id) => !(byId[id] && isRepeatable(byId[id])));
  if (new Set(nonRepeating).size !== nonRepeating.length) {
    throw new Error("The same base item can't be used twice in one chain (only apple boxes repeat)");
  }
  const baseModeOf = (index) =>
    (Array.isArray(baseModes) ? baseModes[index] : baseModes[baseItemIds[index]]) ?? undefined;
  const baseItems = baseItemIds.map((id, index) => inMode(resolveInPool(id, "base item"), baseModeOf(index), "Base item"));
  // No support and no head: the camera block on the base (3.4).
  const support = supportId ? inMode(resolveInPool(supportId, "support"), supportMode ?? undefined, "Support", supportVariants) : null;
  const nose = noseId ? inMode(resolveInPool(noseId, "nose fitting"), noseMode ?? undefined, "Nose fitting") : null;
  const adapters = adapterIds.map((id) => {
    const adapter = resolveInPool(id, "adapter");
    const variants = adapterVariants(adapter);
    const wanted = adapterModes[id];
    if (wanted === undefined) return variants[0];
    const variant = variants.find((v) => v.mode === wanted);
    if (!variant) throw new Error(`Adapter "${id}" has no mode "${wanted}"`);
    return variant;
  });
  const head = headId ? resolveInPool(headId, "head") : null;
  const build = getBuild(gear, buildId);

  const mode = head ? head.modes.find((m) => m.name === modeName) : null;
  if (head && !mode) throw new Error(`Head "${headId}" has no mode "${modeName}"`);

  if (new Set(plateIds).size !== plateIds.length) throw new Error("The same plate can't be used twice in one chain");
  const plates = plateIds.map((id) => resolveInPool(id, "plate"));
  const pieces = blockPieces(build, gear, blockIds);
  const attach = buildAttachPoints(build, gear, blockIds).find((a) => a.name === attachName);
  if (!attach) throw new Error(`Build "${buildId}" has no attach point "${attachName}"`);

  const { chain, violations } = resolveChain({ baseItems, adapters, support, nose, head, mode, plates, build, blockPieces: pieces, attach });
  if (violations) throw new Error(violations.join("; "));
  return chain;
}

/**
 * Turn raw form input into a target (SPEC.md 5.1), or null if it isn't a
 * usable one yet. Values may be strings straight from inputs. A range
 * entered high-to-low is read low-to-high, so callers never compare heights.
 */
export function normalizeTarget({ type, height, low, high }) {
  const num = (value) => (value === "" || value == null ? NaN : Number(value));
  if (type === "fixed") {
    const h = num(height);
    return Number.isFinite(h) ? { type: "fixed", height: h } : null;
  }
  const a = num(low);
  const b = num(high);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return { type: "range", low: Math.min(a, b), high: Math.max(a, b) };
}

/**
 * SPEC.md 5.2 step 3. `target.rangeType` (range targets only) defaults to
 * `"moveable"` when omitted (5.1): a range target is a live move. A
 * `"moveable"` range target requires the requested span to fit within the
 * chain's moveable interval width — not just a check of
 * `chain.adjustability`, since a chain can combine a wide `adjustable`
 * sub-range (legs) with a narrower `moveable` one (a short boom): the
 * label says `moveable`, but only the boom's own width is usable for a
 * live move. An explicit `"adjustable"` skips that width check.
 */
export function isFeasible(chain, target, tolerance) {
  if (target.type === "fixed") {
    return target.height >= chain.min - tolerance && target.height <= chain.max + tolerance;
  }
  const rangeType = target.rangeType || "moveable";
  if (rangeType === "moveable") {
    const requestedWidth = target.high - target.low;
    const moveableWidth = chain.moveableInterval.max - chain.moveableInterval.min;
    if (requestedWidth > moveableWidth + tolerance) return false;
  }
  return target.low >= chain.min - tolerance && target.high <= chain.max + tolerance;
}

/**
 * How much room a chain leaves below and above the target (SPEC.md 5.2
 * step 2). For a fixed target H: below = H - min, above = max - H.
 * For a range target [L, Hi]: below = L - min, above = max - Hi.
 */
export function margin(chain, target) {
  if (target.type === "fixed") {
    return { below: target.height - chain.min, above: chain.max - target.height };
  }
  return { below: target.low - chain.min, above: chain.max - target.high };
}

/**
 * Where the target sits in the chain's adjustable range (SPEC.md 5.2
 * step 4): 0 at the bottom of [min, max], 1 at the top. `low`/`high` are
 * identical for a fixed target; for a range target they're evaluated at
 * L and Hi separately. null when the chain has no adjustable range.
 */
function targetPosition(chain, target) {
  const range = chain.max - chain.min;
  if (range <= 0) return null;

  if (target.type === "fixed") {
    const p = (target.height - chain.min) / range;
    return { low: p, high: p };
  }
  return {
    low: (target.low - chain.min) / range,
    high: (target.high - chain.min) / range,
  };
}

/**
 * How far off an infeasible chain is (SPEC.md 5.2), so a UI never subtracts
 * heights itself. `short`/`tall` come straight from the margins (the one
 * place they're computed); `span` only when the target is within reach but
 * a moveable range is wider than the moveable interval can travel.
 */
function shortfallOf(chain, target, feasible) {
  if (feasible) return null;
  if (chain.belowFloor) return { direction: "floor", amount: chain.belowFloor };
  const m = margin(chain, target);
  if (m.above < 0) return { direction: "short", amount: -m.above };
  if (m.below < 0) return { direction: "tall", amount: -m.below };
  const needed = target.high - target.low;
  const available = chain.moveableInterval.max - chain.moveableInterval.min;
  return { direction: "span", amount: needed - available, needed, available };
}

/**
 * The one place feasibility, margin, and target-position math live
 * (SPEC.md 5.2): the check screen calls this once on the chain it was
 * given.
 */
export function evaluateChain(chain, target, tolerance = 0.5) {
  const m = margin(chain, target);
  // A rig that's under the floor at every lift reaches nothing (5.8).
  const feasible = !chain.belowFloor && isFeasible(chain, target, tolerance);
  return {
    min: chain.min,
    max: chain.max,
    marginBelow: m.below,
    marginAbove: m.above,
    feasible,
    targetPosition: targetPosition(chain, target),
    shortfall: shortfallOf(chain, target, feasible),
  };
}
