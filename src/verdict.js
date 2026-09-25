// The check screen's one-line verdict (SPEC.md 5.6). Picking the tightest
// margin and deciding whether it's tight are comparisons of heights, so they
// happen here, not in the UI: the UI shows `text` in the color `state` names.

/** A margin under this many inches is tight: feasible, but flagged. */
export const TIGHT_MARGIN = 1;

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
/** 32 -> "32″", 0.5 -> "0.5″" (and never "-0″"). */
export const inches = (n) => `${NUMBER.format(n === 0 ? 0 : n).replace("-", "−")}″`;
const span = (low, high) => `${NUMBER.format(low)}–${inches(high)}`;

export const isTight = (amount) => amount < TIGHT_MARGIN;

/** A moveable range's leftover travel once the move fits (5.2 step 3). */
function travelSpare(chain, target) {
  return chain.moveableInterval.max - chain.moveableInterval.min - (target.high - target.low);
}

const SIDES = {
  bottom: { spare: "to spare at bottom", past: "past the bottom" },
  top: { spare: "to spare at top", past: "past the top" },
  travel: { spare: "of moveable travel to spare", past: "more travel than it has" },
};

/**
 * @param {object} chain - a resolved chain
 * @param {object|null} target - a normalized target, or null if none yet
 * @param {object|null} evaluation - evaluateChain(chain, target)
 * @returns {{state: "waiting"|"feasible"|"tight"|"infeasible", text: string,
 *   tightest: {side: "bottom"|"top"|"travel", amount: number}|null}}
 */
export function checkVerdict(chain, target, evaluation) {
  if (!target || !evaluation) {
    return { state: "waiting", text: `Reaches ${span(chain.min, chain.max)} · enter a target`, tightest: null };
  }

  if (!evaluation.feasible) {
    const s = evaluation.shortfall;
    const text =
      s.direction === "short"
        ? `${inches(s.amount)} too short`
        : s.direction === "tall"
          ? `${inches(s.amount)} too tall`
          : `Needs ${inches(s.amount)} more moveable travel`;
    return { state: "infeasible", text, tightest: null };
  }

  const margins = [
    { side: "bottom", amount: evaluation.marginBelow },
    { side: "top", amount: evaluation.marginAbove },
  ];
  if (target.type === "range" && (target.rangeType || "moveable") === "moveable") {
    margins.push({ side: "travel", amount: travelSpare(chain, target) });
  }
  const tightest = margins.reduce((best, m) => (m.amount < best.amount ? m : best));
  const tight = isTight(tightest.amount);
  const words = SIDES[tightest.side];
  const room =
    tightest.amount < 0
      ? `${inches(-tightest.amount)} ${words.past}, within tolerance`
      : `${tight ? "only " : ""}${inches(tightest.amount)} ${words.spare}`;
  const what = target.type === "fixed" ? `Reaches ${inches(target.height)}` : `Covers ${span(target.low, target.high)}`;
  return { state: tight ? "tight" : "feasible", text: `${what} · ${room}`, tightest };
}
