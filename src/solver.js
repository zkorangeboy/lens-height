// Solver for the Lens Height Solver. See SPEC.md section 5.
import { getPackage, getBuild, buildAttachPoints, supportInterval, supportMoveableInterval } from "./model.js";
import {
  acceptsMount,
  adapterVariants,
  appleBoxCount,
  facingsMate,
  orderStack,
  ruleViolations,
  supportFacingOk,
  topFacingOf,
  tripodOnAppleBoxes,
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

/**
 * A chain's interval, given a {min, max} contribution from the support.
 * The one formula both computeInterval (full range) and
 * computeMoveableInterval (moveable range only) apply, so they can't
 * drift from each other on how base/head/build rises get folded in.
 */
function foldSupportRangeIntoChain(baseItems, adapters, mode, attach, supportRange) {
  const fixedRise =
    baseItems.reduce((sum, c) => sum + c.rise, 0) + adapters.reduce((sum, c) => sum + c.rise, 0);
  return {
    min: fixedRise + supportRange.min + mode.rise + attach.rise,
    max: fixedRise + supportRange.max + mode.rise + attach.rise,
  };
}

/**
 * A chain's rise interval (SPEC.md 5.2 step 1): sum of fixed rises (base
 * layer, adapters, head mode, build attach point) plus the support's full
 * adjustable range. Shared by every way a chain gets built so the
 * arithmetic lives in exactly one place.
 */
function computeInterval(baseItems, adapters, support, mode, attach) {
  return foldSupportRangeIntoChain(baseItems, adapters, mode, attach, supportInterval(support));
}

/**
 * A chain's moveable interval (SPEC.md 3.5 / 5.2 step 1): the same shape
 * as computeInterval, but counting only range a `moveable` component
 * contributes — an `adjustable` sub-range like `legRange` (3.2) is
 * excluded. Zero-width when the chain has no moveable component at all.
 */
function computeMoveableInterval(baseItems, adapters, support, mode, attach) {
  return foldSupportRangeIntoChain(baseItems, adapters, mode, attach, supportMoveableInterval(support));
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
 * components (SPEC.md 3.5) — today that's always the support, since it's
 * the only component that carries a range, but this scans every slot so
 * a future part with its own range needs no change here.
 */
function chainAdjustability({ baseItems, adapters, support, head, build }) {
  const components = [...baseItems, ...adapters, support, head, build];
  const maxRank = Math.max(...components.map((c) => ADJUSTABILITY_RANK[c.adjustability] ?? ADJUSTABILITY_RANK.fixed));
  return ADJUSTABILITY_BY_RANK[maxRank];
}

/**
 * Assemble a chain's derived fields (interval, moveable interval, piece
 * count, adjustability) from its resolved parts. The one place a chain
 * object is built, so enumerateChains, buildChain, and deltaSearch can't
 * drift from each other on what a chain even is.
 */
function assembleChain(baseItems, adapters, support, head, mode, build, attach) {
  const { min, max } = computeInterval(baseItems, adapters, support, mode, attach);
  const moveableInterval = computeMoveableInterval(baseItems, adapters, support, mode, attach);
  return {
    baseItems,
    adapters,
    support,
    head,
    mode,
    build,
    attach,
    min,
    max,
    moveableInterval,
    pieceCount: baseItems.length + adapters.length + 3, // + support + head + build
    adjustability: chainAdjustability({ baseItems, adapters, support, head, build }),
  };
}

/** SPEC.md 3.1: the default base-layer stacking cap. Taller stacks are
 * legal but ranked last (solve mode) or flagged (check mode) — this is
 * the single place that "2" is defined, so nothing else hardcodes it. */
export const DEFAULT_MAX_BASE_LAYER_ITEMS = 2;

/** SPEC.md 5.3: the default cap on adapters stacked between support and
 * head. Configurable per query, like the base-layer cap. */
export const DEFAULT_MAX_ADAPTERS = 2;

/**
 * The one place a chain is checked and built (SPEC.md 2, 2.1). Takes the
 * chosen parts — base items and adapters in any order — stacks each in a
 * valid order, checks every mount, facing, and hard rule, and returns
 * either `{ chain }` or `{ violations }`. Mount checks and the 2.1 rules
 * (family, apple boxes) are reported separately, each naming what broke.
 * enumerateChains drops violating chains; buildChain throws; deltaSearch
 * skips them.
 */
function resolveChain({ baseItems, adapters, support, head, mode, build, attach }) {
  const violations = [];

  const baseStack = orderStack(baseItems, "ground", "up");
  if (!baseStack) {
    violations.push(`Mount mismatch: base-layer items ${names(baseItems)} can't be stacked on the ground`);
  } else if (!acceptsMount(support, baseStack.topMount)) {
    violations.push(
      `Mount mismatch: support "${support.name || support.id}" doesn't sit on "${baseStack.topMount}" (it accepts ${[].concat(support.bottomMount).join(" or ")})`
    );
  }

  const adapterStack = orderStack(adapters, support.topMount, topFacingOf(support));
  if (!adapterStack) {
    violations.push(
      `Mount or facing mismatch: adapters ${names(adapters)} can't be stacked on support "${support.name || support.id}" (top mount "${support.topMount}") in any order`
    );
  } else {
    if (!acceptsMount(head, adapterStack.topMount)) {
      violations.push(
        `Mount mismatch: head "${head.name || head.id}" (bottomMount "${head.bottomMount}") doesn't mount to "${adapterStack.topMount}"`
      );
    } else if (!supportFacingOk(adapterStack.topFacing, mode.supportMountFacing || "up")) {
      const beneath = adapterStack.items.length
        ? adapterStack.items[adapterStack.items.length - 1]
        : support;
      violations.push(
        `Facing mismatch: head "${head.name || head.id}" in ${mode.name} mode needs ${(mode.supportMountFacing || "up") === "up" ? "an up" : "a down"}-facing mount beneath it, but "${beneath.name || beneath.id}"${beneath.mode ? ` (${beneath.mode} mode)` : ""} has its top mount facing ${adapterStack.topFacing}`
      );
    }
  }

  if (attach.mount !== head.topMount) {
    violations.push(
      `Mount mismatch: build attach "${attach.name}" (mount "${attach.mount}") doesn't mount to head "${head.name || head.id}" (topMount "${head.topMount}")`
    );
  } else if (!facingsMate(mode.cameraMountFacing, attach.facing)) {
    violations.push(
      `Facing mismatch: build attach "${attach.name}" (faces ${attach.facing}) can't mate with head mode "${mode.name}" (faces ${mode.cameraMountFacing})`
    );
  }

  violations.push(...ruleViolations(baseItems, adapters, support));

  if (violations.length > 0) return { violations };
  return { chain: assembleChain(baseStack.items, adapterStack.items, support, head, mode, build, attach) };
}

function names(items) {
  return items.map((c) => `"${c.name || c.id}"`).join(", ");
}

/**
 * Enumerate every mount-compatible chain from the package pool for a
 * given build (SPEC.md 5.3 step 1). Does not evaluate against a target.
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

  const baseItems = pool.filter((c) => c.category === "base");
  const adapterVariantPool = pool.filter((c) => c.category === "adapter").flatMap(adapterVariants);
  const supports = pool.filter((c) => c.category === "support");
  const heads = pool.filter((c) => c.category === "head");
  const attachPoints = buildAttachPoints(build, gear);

  const baseCombos = combinations(baseItems, maxBaseLayerItems);
  // One physical adapter appears once, in one mode: drop combos that use
  // two modes of the same adapter.
  const adapterCombos = combinations(adapterVariantPool, maxAdapters).filter(
    (combo) => new Set(combo.map((a) => a.id)).size === combo.length
  );
  const chains = [];

  for (const baseCombo of baseCombos) {
    for (const support of supports) {
      for (const adapterCombo of adapterCombos) {
        for (const head of heads) {
          for (const mode of head.modes) {
            for (const attach of attachPoints) {
              const { chain } = resolveChain({
                baseItems: baseCombo,
                adapters: adapterCombo,
                support,
                head,
                mode,
                build,
                attach,
              });
              if (chain) chains.push(chain);
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
 * produces (SPEC.md 5.1 / 5.6): used by check mode, and by anything that
 * needs to reconstruct a marked current rig (5.5). An explicit selection
 * is not exempt from the mount/facing rules in section 2 — a mismatched
 * one throws rather than being silently summed.
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
  { packageId, buildId, baseItemIds = [], supportId, adapterIds = [], adapterModes = {}, headId, modeName, attachName }
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
  const baseItems = baseItemIds.map((id) => resolveInPool(id, "base item"));
  const support = resolveInPool(supportId, "support");
  const adapters = adapterIds.map((id) => {
    const adapter = resolveInPool(id, "adapter");
    const variants = adapterVariants(adapter);
    const wanted = adapterModes[id];
    if (wanted === undefined) return variants[0];
    const variant = variants.find((v) => v.mode === wanted);
    if (!variant) throw new Error(`Adapter "${id}" has no mode "${wanted}"`);
    return variant;
  });
  const head = resolveInPool(headId, "head");
  const build = getBuild(gear, buildId);

  const mode = head.modes.find((m) => m.name === modeName);
  if (!mode) throw new Error(`Head "${headId}" has no mode "${modeName}"`);

  const attach = buildAttachPoints(build, gear).find((a) => a.name === attachName);
  if (!attach) throw new Error(`Build "${buildId}" has no attach point "${attachName}"`);

  const { chain, violations } = resolveChain({ baseItems, adapters, support, head, mode, build, attach });
  if (violations) throw new Error(violations.join("; "));
  return chain;
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
 * The one place feasibility, margin, and target-position math live
 * (SPEC.md 5.2). Both modes call this per chain instead of duplicating
 * it: solve mode once per enumerated chain, check mode once on the
 * chain it was given.
 */
export function evaluateChain(chain, target, tolerance = 0.5) {
  const m = margin(chain, target);
  return {
    min: chain.min,
    max: chain.max,
    marginBelow: m.below,
    marginAbove: m.above,
    feasible: isFeasible(chain, target, tolerance),
    targetPosition: targetPosition(chain, target),
  };
}

function stabilityScore(chain, target) {
  let score = 0;
  if (chain.baseItems.length > 1) score -= chain.baseItems.length - 1;
  for (const item of chain.baseItems) {
    if (item.stability === "low") score -= 2;
  }
  const range = chain.max - chain.min;
  if (range > 0) {
    const point = target.type === "fixed" ? target.height : target.high;
    const frac = (point - chain.min) / range;
    if (frac > 0.85) score -= 1;
  }
  return score;
}

function matchesCurrentRig(chain, currentRig) {
  if (!currentRig) return false;
  return chain.support.id === currentRig.supportId && chain.head.id === currentRig.headId;
}

/**
 * Solve-mode ranking criteria (SPEC.md 5.3 step 3), in priority order —
 * the single ordered list the spec calls for, so re-prioritizing is a
 * matter of reordering this array rather than rewriting compareChains.
 * Each `score` returns a number where higher is better; ties fall
 * through to the next criterion.
 */
const RANKING_CRITERIA = [
  {
    // The *heavy* soft apple-box penalty (SPEC.md 5.3 criterion 1): a
    // tripod on apple boxes is legal but sinks below every chain that
    // doesn't do it, whatever its margin. Not a rule — see rules.js for
    // the hard ones — and separate from the light general penalty below.
    name: "tripodOnAppleBoxes",
    score: (chain) => (tripodOnAppleBoxes(chain.baseItems, chain.support) ? -1 : 0),
  },
  {
    name: "margin",
    // Reads the evaluation solve() already attached, rather than
    // recomputing it.
    score: (chain) => Math.min(chain.evaluation.marginBelow, chain.evaluation.marginAbove),
  },
  {
    name: "adjustability",
    score: (chain) => ADJUSTABILITY_RANK[chain.adjustability] ?? ADJUSTABILITY_RANK.fixed,
  },
  {
    // The *light* general apple-box penalty (SPEC.md 5.3 criterion 4):
    // orders chains the hard rules already let through. Kept apart from
    // those rules, from the heavy tripod penalty, and from pieceCount, so
    // it still applies when piece counts tie.
    name: "appleBoxes",
    score: (chain) => -appleBoxCount(chain.baseItems),
  },
  {
    name: "pieceCount",
    score: (chain) => -chain.pieceCount, // fewer pieces is better
  },
  {
    name: "fastestToRig",
    score: (chain, ctx) => (matchesCurrentRig(chain, ctx.currentRig) ? 1 : 0),
  },
  {
    name: "stability",
    score: (chain, ctx) => stabilityScore(chain, ctx.target),
  },
];

/** Ranking per SPEC.md 5.3 step 3. Sorts best-first. */
export function compareChains(a, b, target, currentRig) {
  const ctx = { target, currentRig };
  for (const criterion of RANKING_CRITERIA) {
    const diff = criterion.score(b, ctx) - criterion.score(a, ctx);
    if (diff !== 0) return diff;
  }
  return 0;
}

function formatTargetLabel(target) {
  return target.type === "fixed" ? `${target.height}"` : `${target.low}"-${target.high}"`;
}

/**
 * Positive: chain falls short of the target (needs more rise).
 * Negative: chain is already too tall for the target at its minimum.
 * Zero: target sits inside the chain's interval. Derived from margin
 * rather than recomputed, so this can't drift from evaluateChain.
 */
function chainGap(chain, target) {
  const m = margin(chain, target);
  if (m.above < 0) return -m.above;
  if (m.below < 0) return m.below;
  return 0;
}

/**
 * Find the smallest-piece-count, smallest-overshoot combination of base
 * layer items whose combined rise closes `gapNeeded`. Search is
 * deliberately uncapped: SPEC.md 5.4 allows taller stacks here even
 * though normal enumeration caps at maxBaseLayerItems. `isValidCombo`
 * lets the caller rule out combos the chain's support can't take (an
 * apple box under a tripod, track under sticks): only valid combos are
 * ever suggested or counted toward what's "available". `comboCost`
 * ranks the valid ones: lower is preferred, ahead of item count.
 */
function findBaseLayerSuggestion(baseItems, gapNeeded, isValidCombo = () => true, comboCost = () => 0) {
  const riseOf = (combo) => combo.reduce((sum, i) => sum + i.rise, 0);
  const combos = combinations(baseItems, baseItems.length).filter((c) => c.length > 0 && isValidCombo(c));
  const closing = combos.filter((c) => riseOf(c) >= gapNeeded);

  if (closing.length === 0) {
    const maxPossible = Math.max(0, ...combos.map(riseOf));
    return { closesGap: false, maxAdditionalRise: maxPossible, stillShortBy: gapNeeded - maxPossible };
  }

  closing.sort((a, b) => {
    // Avoid apple boxes first (a tripod on them worst of all), then fewest items.
    if (comboCost(a) !== comboCost(b)) return comboCost(a) - comboCost(b);
    if (a.length !== b.length) return a.length - b.length;
    const sumA = a.reduce((sum, i) => sum + i.rise, 0);
    const sumB = b.reduce((sum, i) => sum + i.rise, 0);
    return sumA - sumB;
  });

  const best = closing[0];
  return { closesGap: true, items: best, addedRise: best.reduce((sum, i) => sum + i.rise, 0) };
}

function formatFallbackMessage(nearest, target, gap, direction, suggestion) {
  const targetLabel = formatTargetLabel(target);
  const rigLabel = [nearest.support, ...nearest.adapters, nearest.head].map((c) => c.name).join(" + ");

  if (direction === "short") {
    const base = `Closest: ${rigLabel}, tops out at ${nearest.max.toFixed(1)}". You're ${Math.abs(gap).toFixed(1)}" short of ${targetLabel}.`;
    if (suggestion && suggestion.closesGap) {
      const items = suggestion.items.map((i) => i.name).join(" + ");
      return `${base} Add ${items} (${suggestion.addedRise.toFixed(1)}") to close the gap.`;
    }
    if (suggestion) {
      return `${base} No combination of base-layer gear in this package closes the gap: the most available adds ${suggestion.maxAdditionalRise.toFixed(1)}", still ${suggestion.stillShortBy.toFixed(1)}" short. You need ${Math.abs(gap).toFixed(1)}" of additional rise.`;
    }
    return `${base} You need ${Math.abs(gap).toFixed(1)}" of additional rise.`;
  }

  if (direction === "tall") {
    return `Closest: ${rigLabel}, bottoms out at ${nearest.min.toFixed(1)}". You're ${Math.abs(gap).toFixed(1)}" too tall for ${targetLabel}. Base-layer gear only adds height, so this can't be closed with what's in the package.`;
  }

  return `Closest: ${rigLabel} reaches ${targetLabel}, but not within tolerance.`;
}

/** A resolved chain's parts, in the shape resolveChain takes. */
function partsOf(chain) {
  const { baseItems, adapters, support, head, mode, build, attach } = chain;
  return { baseItems, adapters, support, head, mode, build, attach };
}

function buildFallback(gear, target, packageId, buildId) {
  const coreChains = enumerateChains(gear, { packageId, buildId, maxBaseLayerItems: 0 });

  if (coreChains.length === 0) {
    return {
      nearestChain: null,
      gap: null,
      direction: null,
      suggestion: null,
      message: "No mount-compatible rig exists in this package for this build.",
    };
  }

  let nearest = coreChains[0];
  let nearestDistance = Math.abs(chainGap(nearest, target));
  for (const chain of coreChains) {
    const distance = Math.abs(chainGap(chain, target));
    if (distance < nearestDistance) {
      nearest = chain;
      nearestDistance = distance;
    }
  }

  const gap = chainGap(nearest, target);
  const direction = gap > 0 ? "short" : gap < 0 ? "tall" : "exact";

  let suggestion = null;
  if (direction === "short") {
    const baseItems = packagePool(gear, packageId).filter((c) => c.category === "base");
    const isValidCombo = (combo) => !resolveChain({ ...partsOf(nearest), baseItems: combo }).violations;
    const comboCost = (combo) => (tripodOnAppleBoxes(combo, nearest.support) ? 100 : 0) + appleBoxCount(combo);
    suggestion = findBaseLayerSuggestion(baseItems, gap, isValidCombo, comboCost);
  }

  return {
    nearestChain: nearest,
    gap,
    direction,
    suggestion,
    message: formatFallbackMessage(nearest, target, gap, direction, suggestion),
  };
}

/** Total adapter rise, rounded so 6 + 12 and 18 land on the same key. */
function totalAdapterRise(chain) {
  return Number(chain.adapters.reduce((sum, a) => sum + a.rise, 0).toFixed(6));
}

/** SPEC.md 5.3 step 4: what makes two chains "the same result". Base-layer
 * choices are deliberately not part of it. */
function equivalenceKey(chain) {
  return [chain.support.id, chain.head.id, chain.mode.name, chain.attach.name, totalAdapterRise(chain)].join("|");
}

/**
 * Collapse equivalent chains (SPEC.md 5.3 step 4). `rankedChains` is
 * already best-first. Each group becomes its simplest chain — fewest
 * pieces, ties to the better-ranked — carrying the rest as `alternates`
 * and the group size as `count`; results are then re-ordered by their
 * representative.
 */
function collapseEquivalent(rankedChains, target, currentRig) {
  const groups = new Map();
  for (const chain of rankedChains) {
    const key = equivalenceKey(chain);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(chain);
  }

  const results = [];
  for (const members of groups.values()) {
    let representative = members[0];
    for (const member of members) {
      if (member.pieceCount < representative.pieceCount) representative = member;
    }
    results.push({
      ...representative,
      alternates: members.filter((m) => m !== representative),
      count: members.length,
    });
  }
  results.sort((a, b) => compareChains(a, b, target, currentRig));
  return results;
}

/**
 * Solve mode (SPEC.md 5.3): "what configurations reach this target?"
 * Enumerates every mount-compatible chain and ranks the feasible ones.
 * Each returned chain carries its `evaluation` (SPEC.md 5.2) alongside
 * the usual min/max/pieceCount fields.
 *
 * @param {object} gear - merged gear data (see model.js mergeOverrides)
 * @param {object} query
 * @param {{type:"fixed",height:number}|{type:"range",low:number,high:number}} query.target
 * @param {string} query.packageId
 * @param {string} query.buildId
 * @param {number} [query.tolerance=0.5]
 * @param {number} [query.maxBaseLayerItems=DEFAULT_MAX_BASE_LAYER_ITEMS]
 * @param {number} [query.maxAdapters=DEFAULT_MAX_ADAPTERS]
 * @param {boolean} [query.collapse=true] - collapse equivalent chains (5.3 step 4)
 * @param {{supportId:string,headId:string}|null} [query.currentRig=null]
 * @returns {{feasible: object[], fallback: object|null}} each feasible entry
 *   carries `alternates` (the other chains it stands for) and `count`
 */
export function solve(gear, query) {
  const {
    target,
    packageId,
    buildId,
    tolerance = 0.5,
    maxBaseLayerItems = DEFAULT_MAX_BASE_LAYER_ITEMS,
    maxAdapters = DEFAULT_MAX_ADAPTERS,
    collapse = true,
    currentRig = null,
  } = query;

  const chains = enumerateChains(gear, { packageId, buildId, maxBaseLayerItems, maxAdapters });
  const evaluated = chains.map((chain) => ({ ...chain, evaluation: evaluateChain(chain, target, tolerance) }));
  const ranked = evaluated.filter((chain) => chain.evaluation.feasible);
  ranked.sort((a, b) => compareChains(a, b, target, currentRig));
  const feasible = collapse
    ? collapseEquivalent(ranked, target, currentRig)
    : ranked.map((chain) => ({ ...chain, alternates: [], count: 1 }));

  if (feasible.length > 0) {
    return { feasible, fallback: null };
  }

  return { feasible: [], fallback: buildFallback(gear, target, packageId, buildId) };
}

/** SPEC.md 5.7: a candidate may make at most this many changes. */
export const DEFAULT_MAX_DELTA_CHANGES = 3;

/** SPEC.md 5.7: only the best few candidates are returned. */
const DELTA_RESULT_LIMIT = 10;

/**
 * Delta search (SPEC.md 5.7): when check mode is infeasible, find the
 * smallest change to the current rig. A candidate makes up to
 * `maxChanges` changes: any additions (base-layer items, or adapters —
 * each tried in every mode) plus at most one swap (support, head+mode,
 * build attach point, or one adapter). Ranked by fewest changes first,
 * not fewest pieces of gear (the solve-mode metric); ties avoid the
 * apple-box penalties, then margin, then piece count.
 */
function deltaSearch(
  gear,
  { packageId, buildId, target, tolerance, currentRig, maxChanges = DEFAULT_MAX_DELTA_CHANGES }
) {
  const currentChain = buildChain(gear, { packageId, buildId, ...currentRig });
  const pool = packagePool(gear, packageId);
  const build = currentChain.build;
  const attachPoints = buildAttachPoints(build, gear);
  const current = partsOf(currentChain);

  const currentBaseIds = new Set(currentChain.baseItems.map((c) => c.id));
  const currentAdapterIds = new Set(currentChain.adapters.map((c) => c.id));
  const supports = pool.filter((c) => c.category === "support");
  const heads = pool.filter((c) => c.category === "head");
  const adapterVariantPool = pool.filter((c) => c.category === "adapter").flatMap(adapterVariants);

  // Everything that could be added: base items, and adapters in each mode.
  const addable = [
    ...pool.filter((c) => c.category === "base" && !currentBaseIds.has(c.id)).map((item) => ({ slot: "base", item })),
    ...adapterVariantPool.filter((v) => !currentAdapterIds.has(v.id)).map((item) => ({ slot: "adapter", item })),
  ];
  const additionCombos = combinations(addable, maxChanges).filter((combo) => {
    const ids = combo.filter((x) => x.slot === "adapter").map((x) => x.item.id);
    return new Set(ids).size === ids.length; // one mode per physical adapter
  });

  // Every way to change exactly one slot (or none): parts to override plus
  // the change to report.
  const swapOptions = [{ changes: [], parts: {} }];
  for (const support of supports) {
    if (support.id === currentChain.support.id) continue;
    swapOptions.push({ changes: [{ kind: "swap-support", from: currentChain.support, to: support }], parts: { support } });
  }
  for (const head of heads) {
    for (const mode of head.modes) {
      if (head.id === currentChain.head.id && mode.name === currentChain.mode.name) continue;
      swapOptions.push({
        changes: [{ kind: "swap-head", from: { head: currentChain.head, mode: currentChain.mode }, to: { head, mode } }],
        parts: { head, mode },
      });
    }
  }
  for (const attach of attachPoints) {
    if (attach.name === currentChain.attach.name) continue;
    swapOptions.push({ changes: [{ kind: "swap-attach", from: currentChain.attach, to: attach }], parts: { attach } });
  }
  currentChain.adapters.forEach((from, index) => {
    for (const to of adapterVariantPool) {
      // Another mode of the same adapter, or an adapter not already in the chain.
      if (to.id === from.id ? to.mode === from.mode : currentAdapterIds.has(to.id)) continue;
      swapOptions.push({
        changes: [{ kind: "swap-adapter", from, to }],
        parts: { adapters: currentChain.adapters.map((a, i) => (i === index ? to : a)) },
      });
    }
  });

  const candidates = [];

  for (const swap of swapOptions) {
    const budget = maxChanges - swap.changes.length;
    for (const addition of additionCombos) {
      if (addition.length > budget) continue;
      if (swap.changes.length === 0 && addition.length === 0) continue; // just the current rig — already known infeasible

      const addedBase = addition.filter((x) => x.slot === "base").map((x) => x.item);
      const addedAdapters = addition.filter((x) => x.slot === "adapter").map((x) => x.item);
      const adapters = [...(swap.parts.adapters ?? current.adapters), ...addedAdapters];
      if (new Set(adapters.map((a) => a.id)).size !== adapters.length) continue;

      // resolveChain applies every mount, facing, family, and apple-box
      // rule, so a candidate that breaks one simply isn't one.
      const { chain } = resolveChain({
        ...current,
        ...swap.parts,
        baseItems: [...current.baseItems, ...addedBase],
        adapters,
      });
      if (!chain) continue;
      const evaluation = evaluateChain(chain, target, tolerance);
      if (!evaluation.feasible) continue;

      const changes = [
        ...addition.map((x) =>
          x.slot === "base"
            ? { kind: "add", component: x.item }
            : { kind: "add-adapter", component: x.item, mode: x.item.mode }
        ),
        ...swap.changes,
      ];
      candidates.push({ changes, chain: { ...chain, evaluation }, evaluation });
    }
  }

  const marginOf = (c) => Math.min(c.evaluation.marginBelow, c.evaluation.marginAbove);
  candidates.sort((a, b) => {
    const changeDiff = a.changes.length - b.changes.length;
    if (changeDiff !== 0) return changeDiff;

    // The apple-box penalties from solve-mode ranking (5.3), heavy first.
    const heavy = (c) => (tripodOnAppleBoxes(c.chain.baseItems, c.chain.support) ? 1 : 0);
    if (heavy(a) !== heavy(b)) return heavy(a) - heavy(b);
    const light = (c) => appleBoxCount(c.chain.baseItems);
    if (light(a) !== light(b)) return light(a) - light(b);

    const marginDiff = marginOf(b) - marginOf(a);
    if (marginDiff !== 0) return marginDiff;

    return a.chain.pieceCount - b.chain.pieceCount;
  });

  if (candidates.length === 0) {
    return {
      candidates: [],
      total: 0,
      message: `No addition or swap of gear (up to ${maxChanges} changes) in this package reaches ${formatTargetLabel(target)} from the current rig (${currentChain.support.name} + ${currentChain.head.name}).`,
    };
  }

  return { candidates: candidates.slice(0, DELTA_RESULT_LIMIT), total: candidates.length, message: null };
}

/**
 * Check mode (SPEC.md 5.6): "does *this* rig reach the target?" Evaluates
 * one specific chain instead of enumerating every possibility. `chain`
 * defaults to `currentRig` when omitted (SPEC.md 5.5). When infeasible,
 * runs delta search (5.7) against the current rig instead of solve
 * mode's general fallback.
 *
 * @param {object} gear
 * @param {object} query
 * @param {object} query.target
 * @param {string} query.packageId
 * @param {string} query.buildId
 * @param {number} [query.tolerance=0.5]
 * @param {object} [query.chain] - explicit selection, see buildChain
 * @param {object} [query.currentRig] - same shape as query.chain; used as
 *   the default selection, and as the delta-search baseline
 * @returns {{chain: object, evaluation: object, delta: object|null}}
 */
export function checkChain(gear, query) {
  const { target, packageId, buildId, tolerance = 0.5, chain: selection, currentRig = null } = query;

  const resolved = selection || currentRig;
  if (!resolved) {
    throw new Error("check mode needs an explicit chain selection or a currentRig default");
  }

  const chain = buildChain(gear, { packageId, buildId, ...resolved });
  const evaluation = evaluateChain(chain, target, tolerance);

  if (evaluation.feasible) {
    return { chain, evaluation, delta: null };
  }

  return {
    chain,
    evaluation,
    delta: deltaSearch(gear, { packageId, buildId, target, tolerance, currentRig: resolved }),
  };
}

/**
 * Single entry point matching SPEC.md 5.1's `mode` input: dispatches to
 * solve mode or check mode.
 */
export function run(gear, query) {
  const mode = query.mode || "solve";
  if (mode === "solve") return solve(gear, query);
  if (mode === "check") return checkChain(gear, query);
  throw new Error(`Unknown mode: ${mode}`);
}
