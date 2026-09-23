// Solver for the Lens Height Solver. See SPEC.md section 5.
import { getPackage, getBuild, buildAttachPoints, supportInterval, supportMoveableInterval } from "./model.js";

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
function foldSupportRangeIntoChain(baseItems, mode, attach, supportRange) {
  const baseRise = baseItems.reduce((sum, c) => sum + c.rise, 0);
  return {
    min: baseRise + supportRange.min + mode.rise + attach.rise,
    max: baseRise + supportRange.max + mode.rise + attach.rise,
  };
}

/**
 * A chain's rise interval (SPEC.md 5.2 step 1): sum of fixed rises (base
 * layer, head mode, build attach point) plus the support's full
 * adjustable range. Shared by enumerateChains and buildChain so the
 * arithmetic lives in exactly one place.
 */
function computeInterval(baseItems, support, mode, attach) {
  return foldSupportRangeIntoChain(baseItems, mode, attach, supportInterval(support));
}

/**
 * A chain's moveable interval (SPEC.md 3.5 / 5.2 step 1): the same shape
 * as computeInterval, but counting only range a `moveable` component
 * contributes — an `adjustable` sub-range like `legRange` (3.2) is
 * excluded. Zero-width when the chain has no moveable component at all.
 */
function computeMoveableInterval(baseItems, support, mode, attach) {
  return foldSupportRangeIntoChain(baseItems, mode, attach, supportMoveableInterval(support));
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
function chainAdjustability({ baseItems, support, head, build }) {
  const components = [...baseItems, support, head, build];
  const maxRank = Math.max(...components.map((c) => ADJUSTABILITY_RANK[c.adjustability] ?? ADJUSTABILITY_RANK.fixed));
  return ADJUSTABILITY_BY_RANK[maxRank];
}

/**
 * Assemble a chain's derived fields (interval, moveable interval, piece
 * count, adjustability) from its resolved parts. The one place a chain
 * object is built, so enumerateChains, buildChain, and deltaSearch can't
 * drift from each other on what a chain even is.
 */
function assembleChain(baseItems, support, head, mode, build, attach) {
  const { min, max } = computeInterval(baseItems, support, mode, attach);
  const moveableInterval = computeMoveableInterval(baseItems, support, mode, attach);
  return {
    baseItems,
    support,
    head,
    mode,
    build,
    attach,
    min,
    max,
    moveableInterval,
    pieceCount: baseItems.length + 3, // + support + head + build
    adjustability: chainAdjustability({ baseItems, support, head, build }),
  };
}

/**
 * Enumerate every mount-compatible chain from the package pool for a
 * given build (SPEC.md 5.3 step 1). Does not evaluate against a target.
 *
 * @param {object} gear - merged gear data
 * @param {object} opts
 * @param {string} opts.packageId
 * @param {string} opts.buildId
 * @param {number} [opts.maxBaseLayerItems=2]
 */
export function enumerateChains(gear, { packageId, buildId, maxBaseLayerItems = 2 }) {
  const pool = packagePool(gear, packageId);
  const build = getBuild(gear, buildId);

  const baseItems = pool.filter((c) => c.category === "base");
  const supports = pool.filter((c) => c.category === "support" && c.bottomMount === "ground");
  const heads = pool.filter((c) => c.category === "head");
  const attachPoints = buildAttachPoints(build, gear);

  const baseCombos = combinations(baseItems, maxBaseLayerItems);
  const chains = [];

  for (const baseCombo of baseCombos) {
    for (const support of supports) {
      for (const head of heads) {
        if (head.bottomMount !== support.topMount) continue;

        for (const mode of head.modes) {
          for (const attach of attachPoints) {
            if (attach.mount !== head.topMount) continue;
            // A mount point only mates with one that faces the opposite way.
            if (attach.facing === mode.cameraMountFacing) continue;

            chains.push(assembleChain(baseCombo, support, head, mode, build, attach));
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
 * @param {string} selection.headId
 * @param {string} selection.modeName
 * @param {string} selection.attachName
 */
export function buildChain(gear, { packageId, buildId, baseItemIds = [], supportId, headId, modeName, attachName }) {
  const pkg = getPackage(gear, packageId);
  const poolIds = new Set(pkg.componentIds);
  const byId = Object.fromEntries(gear.components.map((c) => [c.id, c]));

  const resolveInPool = (id, label) => {
    if (!id || !poolIds.has(id)) throw new Error(`${label} "${id}" is not in package "${packageId}"`);
    return byId[id];
  };

  const baseItems = baseItemIds.map((id) => resolveInPool(id, "base item"));
  const support = resolveInPool(supportId, "support");
  const head = resolveInPool(headId, "head");
  const build = getBuild(gear, buildId);

  const mode = head.modes.find((m) => m.name === modeName);
  if (!mode) throw new Error(`Head "${headId}" has no mode "${modeName}"`);

  const attach = buildAttachPoints(build, gear).find((a) => a.name === attachName);
  if (!attach) throw new Error(`Build "${buildId}" has no attach point "${attachName}"`);

  if (support.bottomMount !== "ground") {
    throw new Error(`Support "${supportId}" does not mount to the ground (bottomMount "${support.bottomMount}")`);
  }
  if (head.bottomMount !== support.topMount) {
    throw new Error(
      `Head "${headId}" (bottomMount "${head.bottomMount}") does not mount to support "${supportId}" (topMount "${support.topMount}")`
    );
  }
  if (attach.mount !== head.topMount) {
    throw new Error(
      `Build attach "${attachName}" (mount "${attach.mount}") does not mount to head "${headId}" (topMount "${head.topMount}")`
    );
  }
  if (attach.facing === mode.cameraMountFacing) {
    throw new Error(
      `Build attach "${attachName}" (faces ${attach.facing}) cannot mate with head mode "${modeName}" (faces ${mode.cameraMountFacing})`
    );
  }

  return assembleChain(baseItems, support, head, mode, build, attach);
}

/**
 * SPEC.md 5.2 step 3. `target.rangeType` (range targets only) defaults to
 * `"adjustable"` when omitted. A `"moveable"` range target is infeasible
 * outright unless the chain's adjustability (3.5, `chain.adjustability`)
 * is itself `"moveable"` — an adjustable-only chain can position itself
 * in [min, max] before the take but can't execute a live move.
 */
/**
 * SPEC.md 5.2 step 3. `target.rangeType` (range targets only) defaults to
 * `"adjustable"` when omitted. A `"moveable"` range target additionally
 * requires the requested span to fit within the chain's moveable
 * interval width — not just a check of `chain.adjustability`, since a
 * chain can combine a wide `adjustable` sub-range (legs) with a narrower
 * `moveable` one (a short boom): the label says `moveable`, but only the
 * boom's own width is usable for a live move.
 */
export function isFeasible(chain, target, tolerance) {
  if (target.type === "fixed") {
    return target.height >= chain.min - tolerance && target.height <= chain.max + tolerance;
  }
  const rangeType = target.rangeType || "adjustable";
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
 * though normal enumeration caps at maxBaseLayerItems.
 */
function findBaseLayerSuggestion(baseItems, gapNeeded) {
  const combos = combinations(baseItems, baseItems.length).filter((c) => c.length > 0);
  const closing = combos.filter((c) => c.reduce((sum, i) => sum + i.rise, 0) >= gapNeeded);

  if (closing.length === 0) {
    const maxPossible = baseItems.reduce((sum, i) => sum + i.rise, 0);
    return { closesGap: false, maxAdditionalRise: maxPossible, stillShortBy: gapNeeded - maxPossible };
  }

  closing.sort((a, b) => {
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
  const rigLabel = `${nearest.support.name} + ${nearest.head.name}`;

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
    suggestion = findBaseLayerSuggestion(baseItems, gap);
  }

  return {
    nearestChain: nearest,
    gap,
    direction,
    suggestion,
    message: formatFallbackMessage(nearest, target, gap, direction, suggestion),
  };
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
 * @param {number} [query.maxBaseLayerItems=2]
 * @param {{supportId:string,headId:string}|null} [query.currentRig=null]
 * @returns {{feasible: object[], fallback: object|null}}
 */
export function solve(gear, query) {
  const {
    target,
    packageId,
    buildId,
    tolerance = 0.5,
    maxBaseLayerItems = 2,
    currentRig = null,
  } = query;

  const chains = enumerateChains(gear, { packageId, buildId, maxBaseLayerItems });
  const evaluated = chains.map((chain) => ({ ...chain, evaluation: evaluateChain(chain, target, tolerance) }));
  const feasible = evaluated.filter((chain) => chain.evaluation.feasible);
  feasible.sort((a, b) => compareChains(a, b, target, currentRig));

  if (feasible.length > 0) {
    return { feasible, fallback: null };
  }

  return { feasible: [], fallback: buildFallback(gear, target, packageId, buildId) };
}

/**
 * Delta search (SPEC.md 5.7): when check mode is infeasible, find the
 * smallest change to the current rig — any number of base-layer
 * additions plus at most one swap (support, head+mode, or build attach
 * point) — that reaches the target. Ranked by fewest changes first, not
 * fewest pieces of gear (the solve-mode metric).
 */
function deltaSearch(gear, { packageId, buildId, target, tolerance, currentRig }) {
  const currentChain = buildChain(gear, { packageId, buildId, ...currentRig });
  const pool = packagePool(gear, packageId);
  const build = currentChain.build;
  const attachPoints = buildAttachPoints(build, gear);

  const currentBaseIds = new Set(currentChain.baseItems.map((c) => c.id));
  const availableBaseItems = pool.filter((c) => c.category === "base" && !currentBaseIds.has(c.id));
  const supports = pool.filter((c) => c.category === "support" && c.bottomMount === "ground");
  const heads = pool.filter((c) => c.category === "head");

  // Every "slot" option: the current one (no swap) plus every alternative
  // in the package pool.
  const supportOptions = [
    { value: currentChain.support, changed: false },
    ...supports.filter((s) => s.id !== currentChain.support.id).map((s) => ({ value: s, changed: true })),
  ];

  const headModeOptions = [{ value: { head: currentChain.head, mode: currentChain.mode }, changed: false }];
  for (const head of heads) {
    for (const mode of head.modes) {
      if (head.id === currentChain.head.id && mode.name === currentChain.mode.name) continue;
      headModeOptions.push({ value: { head, mode }, changed: true });
    }
  }

  const attachOptions = [
    { value: currentChain.attach, changed: false },
    ...attachPoints.filter((a) => a.name !== currentChain.attach.name).map((a) => ({ value: a, changed: true })),
  ];

  const additionCombos = combinations(availableBaseItems, availableBaseItems.length);

  const candidates = [];

  for (const supportOpt of supportOptions) {
    for (const headModeOpt of headModeOptions) {
      for (const attachOpt of attachOptions) {
        // At most one slot swapped per candidate.
        const swapCount = [supportOpt, headModeOpt, attachOpt].filter((o) => o.changed).length;
        if (swapCount > 1) continue;

        const support = supportOpt.value;
        const { head, mode } = headModeOpt.value;
        const attach = attachOpt.value;

        if (head.bottomMount !== support.topMount) continue;
        if (attach.mount !== head.topMount) continue;
        if (attach.facing === mode.cameraMountFacing) continue;

        for (const addition of additionCombos) {
          if (swapCount === 0 && addition.length === 0) continue; // that's just the current rig — already known infeasible

          const baseItems = [...currentChain.baseItems, ...addition];
          const chain = assembleChain(baseItems, support, head, mode, build, attach);
          const evaluation = evaluateChain(chain, target, tolerance);
          if (!evaluation.feasible) continue;

          const changes = [
            ...addition.map((item) => ({ kind: "add", component: item })),
            ...(supportOpt.changed ? [{ kind: "swap-support", from: currentChain.support, to: support }] : []),
            ...(headModeOpt.changed
              ? [{ kind: "swap-head", from: { head: currentChain.head, mode: currentChain.mode }, to: { head, mode } }]
              : []),
            ...(attachOpt.changed ? [{ kind: "swap-attach", from: currentChain.attach, to: attach }] : []),
          ];

          candidates.push({ changes, chain: { ...chain, evaluation }, evaluation });
        }
      }
    }
  }

  candidates.sort((a, b) => {
    const changeDiff = a.changes.length - b.changes.length;
    if (changeDiff !== 0) return changeDiff;

    const marginOf = (c) => Math.min(c.evaluation.marginBelow, c.evaluation.marginAbove);
    const marginDiff = marginOf(b) - marginOf(a);
    if (marginDiff !== 0) return marginDiff;

    return a.chain.pieceCount - b.chain.pieceCount;
  });

  if (candidates.length === 0) {
    return {
      candidates: [],
      message: `No single addition or swap of gear in this package reaches ${formatTargetLabel(target)} from the current rig (${currentChain.support.name} + ${currentChain.head.name}).`,
    };
  }

  return { candidates, message: null };
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
