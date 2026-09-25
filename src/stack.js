// Stack layout (SPEC.md 5.8): the drawing of a chain as a view model. All the
// height math a renderer would need — where each piece sits, which column it
// hangs in, where the target and its margins fall, where each label goes — is
// done here, so the UI draws percentages and numbers it is handed and
// computes nothing.
import { supportSegments } from "./model.js";
import { margin } from "./solver.js";
import { isTight } from "./verdict.js";

/** Which kind a piece's own adjustability puts it in (SPEC.md 3.5). */
const kindOf = (component) => component.adjustability || "fixed";

/** Adjustable extension is used before moveable: legs position the rig,
 * the boom takes what's left (SPEC.md 5.8). */
const ALLOCATION_ORDER = { fixed: 0, adjustable: 1, moveable: 2 };

/** How tall a lane entry is, as a percentage of the drawing, unless the
 * caller says otherwise: a label, a label with a flag line, a "+". */
const DEFAULT_LANE = { label: 7, flagged: 10, add: 5 };

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round2 = (n) => Math.round(n * 100) / 100;
const sign = (n) => (n > 0 ? 1 : n < 0 ? -1 : 0);

/**
 * Place lane entries as close to their anchors as they can go without
 * overlapping: entries that would collide are grouped and the group is
 * centered on its members' anchors, kept inside 0..100.
 * @param {{anchorPct: number, size: number}[]} entries - sorted by anchor
 * @returns {number[]} each entry's center
 */
function spreadLane(entries) {
  const groups = [];
  const settle = (group) => {
    let offset = 0;
    let want = 0;
    for (const e of group.members) {
      want += e.anchorPct - offset - e.size / 2;
      offset += e.size;
    }
    group.size = offset;
    group.bottom = clamp(want / group.members.length, 0, Math.max(0, 100 - group.size));
  };
  for (const entry of entries) {
    const group = { members: [entry] };
    settle(group);
    groups.push(group);
    while (groups.length > 1) {
      const below = groups[groups.length - 2];
      const above = groups[groups.length - 1];
      if (below.bottom + below.size <= above.bottom + 1e-9) break;
      groups.splice(-2, 2, { members: [...below.members, ...above.members] });
      settle(groups[groups.length - 1]);
    }
  }
  const centers = [];
  for (const group of groups) {
    let cursor = group.bottom;
    for (const e of group.members) {
      centers.push(cursor + e.size / 2);
      cursor += e.size;
    }
  }
  return centers;
}

/**
 * @param {object} chain - a resolved chain (solver.js buildChain)
 * @param {{type:"fixed",height:number}|{type:"range",low:number,high:number}|null} [target]
 * @param {{lane?: {label?: number, flagged?: number, add?: number},
 *   openGaps?: {slot: "base"|"adapter", index: number}[]}} [options] -
 *   lane entry sizes (percent of the drawing), and which insertion points
 *   get a "+" (default: all of them)
 */
export function stackLayout(chain, target = null, options = {}) {
  const laneSize = { ...DEFAULT_LANE, ...(options.lane || {}) };

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

  // Walk the chain from the floor, in heights. A block that runs the other
  // way from the last one with any height starts a new column (5.8).
  const raw = [];
  const connectors = [];
  let cursor = 0;
  let column = 0;
  let direction = 0;
  const place = (block, rise) => {
    const start = cursor;
    cursor += rise;
    const runs = sign(rise);
    if (runs !== 0) {
      if (direction !== 0 && runs !== direction) {
        column += 1;
        connectors.push({ fromColumn: column - 1, toColumn: column, height: start });
      }
      direction = runs;
    }
    raw.push({ ...block, estimated: block.component.measured === false, rise, start, end: cursor, column });
  };

  chain.baseItems.forEach((item, index) => {
    place({ slot: "base", index, name: item.name, component: item, kind: kindOf(item) }, item.rise);
  });

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
      index: 0,
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

  chain.adapters.forEach((adapter, index) => {
    place({ slot: "adapter", index, name: adapter.name, component: adapter, kind: kindOf(adapter), mode: adapter.mode }, adapter.rise);
  });
  place({ slot: "head", index: 0, name: chain.head.name, component: chain.head, kind: kindOf(chain.head), mode: chain.mode.name }, chain.mode.rise);
  place(
    {
      slot: "build",
      index: 0,
      name: chain.build.name,
      component: chain.build,
      kind: kindOf(chain.build),
      attach: chain.attach.name,
      inverted: Boolean(chain.attach.inverted),
    },
    chain.attach.rise
  );

  // Insertion points (5.8): base i sits on base item i-1 (0 is the floor);
  // adapter j sits on the support (j = 0) or on adapter j-1.
  const baseCount = chain.baseItems.length;
  const gaps = [];
  for (let i = 0; i <= baseCount; i++) {
    const on = i === 0 ? null : raw[i - 1];
    gaps.push({ slot: "base", index: i, column: 0, height: on ? on.end : 0, on: on && on.name });
  }
  for (let j = 0; j <= chain.adapters.length; j++) {
    const on = raw[baseCount + j];
    gaps.push({ slot: "adapter", index: j, column: on.column, height: on.end, on: on.name });
  }

  // The moveable portion: how far the lens can sweep from this setup with
  // everything else held still.
  const moveableExtent = segments.reduce((sum, s) => (s.kind === "moveable" ? sum + s.extent : sum), 0);
  const moveableUsed = segments.reduce((sum, s, i) => (s.kind === "moveable" ? sum + allocation[i] : sum), 0);
  const sweep = moveableExtent > 0 ? { min: cursor - moveableUsed, max: cursor - moveableUsed + moveableExtent } : null;

  const targetLow = !target ? null : target.type === "fixed" ? target.height : target.low;
  const targetHigh = !target ? null : target.type === "fixed" ? target.height : target.high;

  // The drawing's scale: floor (or anything below it) to the highest point,
  // with a little headroom so the lens marker isn't clipped. One scale for
  // every column, so heights compare across them.
  const heights = [0, cursor, chain.min, chain.max, ...raw.flatMap((b) => [b.start, b.end])];
  if (target) heights.push(targetLow, targetHigh);
  const lo = Math.min(...heights);
  const top = Math.max(...heights);
  const hi = top + (top - lo) * 0.04 || lo + 1;
  const pct = (height) => round2(((height - lo) / (hi - lo)) * 100);
  const span = (from, to) => ({ bottomPct: pct(from), topPct: pct(to), heightPct: round2(pct(to) - pct(from)) });

  const blocks = raw.map((block) => {
    const bottom = Math.min(block.start, block.end);
    const upper = Math.max(block.start, block.end);
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
      bottom,
      top: upper,
      ...span(bottom, upper),
      anchorPct: pct((bottom + upper) / 2),
      ...(inner ? { parts: inner } : {}),
    };
  });

  // The label lane: every block's label, and a "+" at each open insertion
  // point, each near its own height but never overlapping (5.8).
  const open = options.openGaps
    ? new Set(options.openGaps.map((g) => `${g.slot}:${g.index}`))
    : new Set(gaps.map((g) => `${g.slot}:${g.index}`));
  const sequence = (slot, index) =>
    ({ base: 0, support: 1, adapter: 2, head: 3, build: 4 })[slot] * 1000 + index * 2;
  const entries = [
    ...blocks.map((b, i) => ({
      type: "block",
      block: i,
      column: b.column,
      anchorPct: b.anchorPct,
      size: b.inverted ? laneSize.flagged : laneSize.label,
      order: sequence(b.slot, b.index) + 1,
    })),
    ...gaps
      .filter((g) => open.has(`${g.slot}:${g.index}`))
      .map((g) => ({
        type: "gap",
        slot: g.slot,
        index: g.index,
        column: g.column,
        on: g.on,
        anchorPct: pct(g.height),
        size: laneSize.add,
        order: sequence(g.slot, g.index),
      })),
  ].sort((a, b) => a.anchorPct - b.anchorPct || a.order - b.order);
  const centers = spreadLane(entries);
  const lane = entries.map(({ order, ...entry }, i) => {
    const at = round2(centers[i]);
    return {
      ...entry,
      pct: at,
      leader: { bottomPct: Math.min(at, entry.anchorPct), heightPct: round2(Math.abs(at - entry.anchorPct)) },
    };
  });

  const m = target && margin(chain, target);

  return {
    floor: { height: 0, pct: pct(0) },
    blocks,
    columns: column + 1,
    connectors: connectors.map((c) => ({ ...c, pct: pct(c.height) })),
    gaps: gaps.map((g) => ({ ...g, pct: pct(g.height) })),
    lane,
    lens: { height: cursor, pct: pct(cursor), column },
    reach: { min: chain.min, max: chain.max, ...span(chain.min, chain.max) },
    moveable: sweep && { ...sweep, ...span(sweep.min, sweep.max) },
    target: target && {
      low: targetLow,
      high: targetHigh,
      isRange: target.type === "range",
      ...span(targetLow, targetHigh),
    },
    margins: m && {
      above: { amount: m.above, tight: isTight(m.above), pct: pct(targetHigh) },
      below: { amount: m.below, tight: isTight(m.below), pct: pct(targetLow) },
    },
    estimated: blocks.some((b) => b.estimated),
  };
}
