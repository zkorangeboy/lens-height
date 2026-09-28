// The check screen's one-line verdict (SPEC.md 5.3). Whether the rig reaches
// the target is a comparison of heights, so it happens here, not in the UI:
// the UI shows `text` in the color `state` names.

import { inches, inchesSpan as span } from "./format.js";

/**
 * Success is only what the rig does — "Reaches 30″", "Covers 20–30″" —
 * with no margins and no warning state (a target inside the tolerance
 * reads like any other). Failure is only the shortfall.
 *
 * @param {object} chain - a resolved chain
 * @param {object|null} target - a normalized target, or null if none yet
 * @param {object|null} evaluation - evaluateChain(chain, target)
 * @returns {{state: "waiting"|"feasible"|"infeasible", text: string}}
 */
export function checkVerdict(chain, target, evaluation) {
  if (!target || !evaluation) {
    return { state: "waiting", text: `Reaches ${span(chain.min, chain.max)} · enter a target` };
  }

  if (!evaluation.feasible) {
    const s = evaluation.shortfall;
    const text =
      s.direction === "short"
        ? `${inches(s.amount)} too short`
        : s.direction === "tall"
          ? `${inches(s.amount)} too tall`
          : s.direction === "floor"
            ? `${inches(s.amount)} below the floor`
            : `Needs ${inches(s.amount)} more moveable travel`;
    return { state: "infeasible", text };
  }

  const text = target.type === "fixed" ? `Reaches ${inches(target.height)}` : `Covers ${span(target.low, target.high)}`;
  return { state: "feasible", text };
}
