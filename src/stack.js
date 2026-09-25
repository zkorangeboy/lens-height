// Stack layout (SPEC.md 5.8): the ground-up picture of a chain as a view
// model. All the height math a renderer would need — where each piece sits,
// where the target falls — is done here, so the UI draws percentages and
// numbers it is handed and computes nothing.
import { supportSegments } from "./model.js";

/** Which kind a piece's own adjustability puts it in (SPEC.md 3.5). */
const kindOf = (component) => component.adjustability || "fixed";

/** Adjustable extension is used before moveable: legs position the rig,
 * the boom takes what's left (SPEC.md 5.8). */
const ALLOCATION_ORDER = { fixed: 0, adjustable: 1, moveable: 2 };

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} chain - a resolved chain (solver.js buildChain)
 * @param {{type:"fixed",height:number}|{type:"range",low:number,high:number}|null} [target]
 * @returns {{
 *   floor: {pct: number},
 *   blocks: object[],
 *   lens: {height: number, pct: number},
 *   reach: object,
 *   moveable: object|null,
 *   target: object|null,
 * }}
 */
export function stackLayout(chain, target = null) {
  // Where to rig it: the target (the low end of a range, where the move
  // starts), clamped into what this chain can reach. No target: fully retracted.
  const reference = !target ? chain.min : target.type === "fixed" ? target.height : target.low;
  const rigged = clamp(reference, chain.min, chain.max);

  // Spread the extension needed over the support's segments.
  const segments = supportSegments(chain.support);
  const allocation = segments.map(() => 0);
  let remaining = rigged - chain.min;
  const byPriority = segments
    .map((segment, index) => ({ segment, index }))
    .sort((a, b) => ALLOCATION_ORDER[a.segment.kind] - ALLOCATION_ORDER[b.segment.kind]);
  for (const { segment, index } of byPriority) {
    const take = Math.min(segment.extent, remaining);
    allocation[index] = take;
    remaining -= take;
  }

  // Walk the chain up from the floor, in heights.
  const raw = [];
  let cursor = 0;
  const place = (block, rise) => {
    const start = cursor;
    cursor += rise;
    raw.push({ ...block, rise, start, end: cursor });
  };

  for (const item of chain.baseItems) {
    place({ slot: "base", name: item.name, component: item, kind: kindOf(item) }, item.rise);
  }

  const supportParts = segments.map((segment, index) => ({
    kind: segment.kind,
    rise: segment.base + allocation[index],
  }));
  const supportKind = segments.some((s) => s.kind === "moveable" && s.extent > 0)
    ? "moveable"
    : segments.some((s) => s.kind === "adjustable" && s.extent > 0)
      ? "adjustable"
      : "fixed";
  place(
    {
      slot: "support",
      name: chain.support.name,
      component: chain.support,
      kind: supportKind,
      parts: supportParts,
      range: {
        min: segments.reduce((sum, s) => sum + s.base, 0),
        max: segments.reduce((sum, s) => sum + s.base + s.extent, 0),
      },
    },
    supportParts.reduce((sum, part) => sum + part.rise, 0)
  );

  for (const adapter of chain.adapters) {
    place({ slot: "adapter", name: adapter.name, component: adapter, kind: kindOf(adapter), mode: adapter.mode }, adapter.rise);
  }
  place({ slot: "head", name: chain.head.name, component: chain.head, kind: kindOf(chain.head), mode: chain.mode.name }, chain.mode.rise);
  place(
    { slot: "build", name: chain.build.name, component: chain.build, kind: kindOf(chain.build), attach: chain.attach.name, inverted: chain.attach.inverted },
    chain.attach.rise
  );

  // The moveable portion: how far the lens can sweep from this setup with
  // everything else held still.
  const moveableExtent = segments.reduce((sum, s, i) => (s.kind === "moveable" ? sum + s.extent : sum), 0);
  const moveableUsed = segments.reduce((sum, s, i) => (s.kind === "moveable" ? sum + allocation[i] : sum), 0);
  const sweep = moveableExtent > 0 ? { min: cursor - moveableUsed, max: cursor - moveableUsed + moveableExtent } : null;

  const targetLow = !target ? null : target.type === "fixed" ? target.height : target.low;
  const targetHigh = !target ? null : target.type === "fixed" ? target.height : target.high;

  // The drawing's scale: floor (or anything below it) to the highest point,
  // with a little headroom so the lens marker isn't clipped.
  const heights = [0, cursor, chain.min, chain.max, ...raw.flatMap((b) => [b.start, b.end])];
  if (target) heights.push(targetLow, targetHigh);
  const lo = Math.min(...heights);
  const top = Math.max(...heights);
  const hi = top + (top - lo) * 0.04 || lo + 1;
  const pct = (height) => round2(((height - lo) / (hi - lo)) * 100);
  const span = (from, to) => ({ bottomPct: pct(from), heightPct: round2(pct(to) - pct(from)) });

  const blocks = raw.map((block) => {
    const bottom = Math.min(block.start, block.end);
    const top = Math.max(block.start, block.end);
    let inner;
    if (block.parts) {
      let partCursor = block.start;
      inner = block.parts.map((part) => {
        const from = partCursor;
        partCursor += part.rise;
        return { kind: part.kind, rise: part.rise, ...span(Math.min(from, partCursor), Math.max(from, partCursor)) };
      });
    }
    const { start, end, ...rest } = block;
    return {
      ...rest,
      direction: block.rise > 0 ? "up" : block.rise < 0 ? "down" : "flat",
      ...span(bottom, top),
      ...(inner ? { parts: inner } : {}),
    };
  });

  return {
    floor: { height: 0, pct: pct(0) },
    blocks,
    lens: { height: cursor, pct: pct(cursor) },
    reach: { min: chain.min, max: chain.max, ...span(chain.min, chain.max) },
    moveable: sweep && { ...sweep, ...span(sweep.min, sweep.max) },
    target: target && {
      low: targetLow,
      high: targetHigh,
      isRange: target.type === "range",
      ...span(targetLow, targetHigh),
    },
  };
}
