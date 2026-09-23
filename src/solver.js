// Solver for the Lens Height Solver. See SPEC.md section 5.
import { getPackage, getBuild, buildAttachPoints, supportInterval } from "./model.js";

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

/**
 * Enumerate every mount-compatible chain from the package pool for a
 * given build (SPEC.md 5.2 step 1). Does not filter by target height.
 *
 * @param {object} gear - merged gear data
 * @param {object} opts
 * @param {string} opts.packageId
 * @param {string} opts.buildId
 * @param {number} [opts.maxBaseLayerItems=2]
 */
export function enumerateChains(gear, { packageId, buildId, maxBaseLayerItems = 2 }) {
  const pool = getPackage(gear, packageId).componentIds.map(
    (id) => gear.components.find((c) => c.id === id)
  );
  const build = getBuild(gear, buildId);

  const baseItems = pool.filter((c) => c.category === "base");
  const supports = pool.filter((c) => c.category === "support" && c.bottomMount === "ground");
  const heads = pool.filter((c) => c.category === "head");
  const attachPoints = buildAttachPoints(build, gear);

  const baseCombos = combinations(baseItems, maxBaseLayerItems);
  const chains = [];

  for (const baseCombo of baseCombos) {
    const baseRise = baseCombo.reduce((sum, c) => sum + c.rise, 0);

    for (const support of supports) {
      const { min: supMin, max: supMax } = supportInterval(support);

      for (const head of heads) {
        if (head.bottomMount !== support.topMount) continue;

        for (const mode of head.modes) {
          for (const attach of attachPoints) {
            if (attach.mount !== head.topMount) continue;
            // A mount point only mates with one that faces the opposite way.
            if (attach.facing === mode.cameraMountFacing) continue;

            chains.push({
              baseItems: baseCombo,
              support,
              head,
              mode,
              build,
              attach,
              min: baseRise + supMin + mode.rise + attach.rise,
              max: baseRise + supMax + mode.rise + attach.rise,
              pieceCount: baseCombo.length + 3, // + support + head + build
            });
          }
        }
      }
    }
  }

  return chains;
}

export function isFeasible(chain, target, tolerance) {
  if (target.type === "fixed") {
    return target.height >= chain.min - tolerance && target.height <= chain.max + tolerance;
  }
  return target.low >= chain.min - tolerance && target.high <= chain.max + tolerance;
}

export function headroom(chain, target) {
  if (target.type === "fixed") {
    return Math.min(target.height - chain.min, chain.max - target.height);
  }
  return Math.min(target.low - chain.min, chain.max - target.high);
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

/** Ranking per SPEC.md 5.2 step 4. Sorts best-first. */
export function compareChains(a, b, target, currentRig) {
  const headroomDiff = headroom(b, target) - headroom(a, target);
  if (headroomDiff !== 0) return headroomDiff;

  const pieceDiff = a.pieceCount - b.pieceCount;
  if (pieceDiff !== 0) return pieceDiff;

  const aFast = matchesCurrentRig(a, currentRig) ? 1 : 0;
  const bFast = matchesCurrentRig(b, currentRig) ? 1 : 0;
  if (aFast !== bFast) return bFast - aFast;

  return stabilityScore(b, target) - stabilityScore(a, target);
}

/**
 * Positive: chain falls short of the target (needs more rise).
 * Negative: chain is already too tall for the target at its minimum.
 * Zero: target sits inside the chain's interval.
 */
function chainGap(chain, target) {
  if (target.type === "fixed") {
    if (target.height > chain.max) return target.height - chain.max;
    if (target.height < chain.min) return target.height - chain.min;
    return 0;
  }
  if (target.high > chain.max) return target.high - chain.max;
  if (target.low < chain.min) return target.low - chain.min;
  return 0;
}

/**
 * Find the smallest-piece-count, smallest-overshoot combination of base
 * layer items whose combined rise closes `gapNeeded`. Search is
 * deliberately uncapped: SPEC.md 5.3 allows taller stacks here even
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
  const targetLabel = target.type === "fixed" ? `${target.height}"` : `${target.low}"-${target.high}"`;
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
    const baseItems = getPackage(gear, packageId)
      .componentIds.map((id) => gear.components.find((c) => c.id === id))
      .filter((c) => c.category === "base");
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
 * Main entry point (SPEC.md 5.1-5.3).
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
  const feasible = chains.filter((chain) => isFeasible(chain, target, tolerance));
  feasible.sort((a, b) => compareChains(a, b, target, currentRig));

  if (feasible.length > 0) {
    return { feasible, fallback: null };
  }

  return { feasible: [], fallback: buildFallback(gear, target, packageId, buildId) };
}
