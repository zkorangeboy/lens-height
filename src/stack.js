// Stack layout (SPEC.md 5.8): the drawing of a chain as a view model. All the
// height math a renderer would need — where each piece sits, which column it
// hangs in, where the target falls, where each label goes — is
// done here, so the UI draws percentages and numbers it is handed and
// computes nothing.
import { riseRangeOf, supportSegments } from "./model.js";

/** Which kind a piece's own adjustability puts it in (SPEC.md 3.5). */
const kindOf = (component) => component.adjustability || "fixed";

/** Adjustable extension is used before moveable: legs position the rig,
 * the boom takes what's left (SPEC.md 5.8). */
const ALLOCATION_ORDER = { fixed: 0, adjustable: 1, moveable: 2 };

/** How tall a label is, as a percentage of the drawing, unless the caller
 * measured it (labels wrap, so heights vary). */
const DEFAULT_LABEL_PCT = 7;

/** Room above the highest thing drawn, as a fraction of the drawing. */
const HEADROOM = 0.06;

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
 * @param {{lane?: {plotPx: number, labelPx: number[]}}} [options] - the
 *   drawing's height and each block's measured label height, in pixels
 */
export function stackLayout(chain, target = null, options = {}) {
  const lane = options.lane;
  const labelPct = (i) =>
    lane && lane.plotPx > 0 && lane.labelPx && lane.labelPx[i] > 0 ? (lane.labelPx[i] / lane.plotPx) * 100 : DEFAULT_LABEL_PCT;

  // Where to rig it: the target (the low end of a range, where the move
  // starts), clamped into what this chain can reach. No target: fully retracted.
  const reference = !target ? chain.min : target.type === "fixed" ? target.height : target.low;
  const rigged = clamp(reference, chain.min, chain.max);

  // Spread the extension needed over the support's segments and the nose
  // fitting's range (SPEC.md 5.8): adjustable first — legs, then the nose
  // fitting's hand screw — moveable last.
  const segments = supportSegments(chain.support);
  const noseRange = chain.nose ? riseRangeOf(chain.nose) : null;
  const noseSegment = noseRange && {
    kind: noseRange.max > noseRange.min ? chain.nose.adjustability || "adjustable" : "fixed",
    base: noseRange.min,
    extent: noseRange.max - noseRange.min,
  };
  const allSegments = noseSegment ? [...segments, noseSegment] : segments;
  const allocation = allSegments.map(() => 0);
  let remaining = rigged - chain.min;
  const byPriority = allSegments
    .map((segment, index) => ({ segment, index }))
    .sort((a, b) => ALLOCATION_ORDER[a.segment.kind] - ALLOCATION_ORDER[b.segment.kind]);
  for (const { segment, index } of byPriority) {
    const take = Math.min(segment.extent, remaining);
    allocation[index] = take;
    remaining -= take;
  }

  // Walk the chain from the floor, in heights. A block that runs the other
  // way from the last one with any height starts a new column (5.8) —
  // except a camera cradled by its head, which stays in the head's column; a
  // nose fitting that doesn't hang as a bracket (the SLE), which stays in the
  // dolly's column; and the first piece mounted on one that does (the LHE),
  // which stays in the bracket's column.
  const raw = [];
  const connectors = [];
  let cursor = 0;
  let column = 0;
  let direction = 0;
  let onBracket = false;
  const place = (block, rise) => {
    const start = cursor;
    cursor += rise;
    const runs = sign(rise);
    if (block.cradled || (block.nose && !block.bracket)) {
      // Drawn inside the piece it belongs to; the direction doesn't change.
    } else if (runs !== 0) {
      const reverses = direction !== 0 && runs !== direction;
      if (reverses && !onBracket) {
        column += 1;
        connectors.push({ fromColumn: column - 1, toColumn: column, height: start });
      }
      onBracket = Boolean(block.bracket) && reverses;
      direction = runs;
    }
    raw.push({ ...block, rise, start, end: cursor, column });
  };

  chain.baseItems.forEach((item, index) => {
    place({ slot: "base", index, name: item.name, component: item, kind: kindOf(item), mode: item.mode, modeLabel: item.modeLabel }, item.rise);
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
      mode: chain.support.mode,
      modeLabel: chain.support.modeLabel,
      parts: supportParts,
      range: {
        min: segments.reduce((sum, s) => sum + s.base, 0),
        max: segments.reduce((sum, s) => sum + s.base + s.extent, 0),
      },
    },
    supportParts.reduce((sum, part) => sum + part.rise, 0)
  );

  if (chain.nose) {
    const noseAllocation = allocation[allSegments.length - 1];
    place(
      {
        slot: "nose",
        index: 0,
        name: chain.nose.name,
        component: chain.nose,
        kind: noseSegment.kind,
        mode: chain.nose.mode,
        modeLabel: chain.nose.modeLabel,
        nose: true,
        bracket: Boolean(chain.nose.hangsAsBracket),
        ...(noseSegment.extent > 0 ? { range: { min: noseRange.min, max: noseRange.max } } : {}),
      },
      noseSegment.base + noseAllocation
    );
  }

  chain.adapters.forEach((adapter, index) => {
    place({ slot: "adapter", index, name: adapter.name, component: adapter, kind: kindOf(adapter), mode: adapter.mode, modeLabel: adapter.modeLabel }, adapter.rise);
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
      cradled: Boolean(chain.head.cradlesCamera),
    },
    chain.attach.rise
  );

  // Insertion points (5.8): base i sits on base item i-1 (0 is the floor);
  // adapter j sits on the nose fitting or support (j = 0) or on adapter j-1.
  const baseCount = chain.baseItems.length + (chain.nose ? 1 : 0);
  const gaps = [];
  for (let i = 0; i <= chain.baseItems.length; i++) {
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

  // The drawing's scale fits the content (5.8): the floor (or a piece hanging
  // below it) up to just above the highest of the lens, the target, and the
  // pieces. The reach doesn't stretch it; it's clipped instead.
  const heights = [0, cursor, ...raw.flatMap((b) => [b.start, b.end])];
  if (target) heights.push(targetLow, targetHigh);
  const lo = Math.min(...heights);
  const top = Math.max(...heights);
  const hi = top + (top - lo) * HEADROOM || lo + 1;
  const pct = (height) => round2(((height - lo) / (hi - lo)) * 100);
  const span = (from, to) => ({ bottomPct: pct(from), topPct: pct(to), heightPct: round2(pct(to) - pct(from)) });
  const clipped = (from, to) => ({
    ...span(clamp(from, lo, hi), clamp(to, lo, hi)),
    continuesBelow: from < lo,
    continuesAbove: to > hi,
  });

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

  // The label lane: every block's label, each near its own height but
  // never overlapping (5.8).
  const entries = blocks
    .map((b, i) => ({ block: i, column: b.column, anchorPct: b.anchorPct, size: labelPct(i) }))
    .sort((a, b) => a.anchorPct - b.anchorPct || a.block - b.block);
  const centers = spreadLane(entries);
  const labels = entries.map((entry, i) => {
    const at = round2(centers[i]);
    return {
      ...entry,
      size: round2(entry.size),
      pct: at,
      leader: { bottomPct: Math.min(at, entry.anchorPct), heightPct: round2(Math.abs(at - entry.anchorPct)) },
    };
  });


  return {
    floor: { height: 0, pct: pct(0) },
    blocks,
    columns: column + 1,
    connectors: connectors.map((c) => ({ ...c, pct: pct(c.height) })),
    gaps: gaps.map((g) => ({ ...g, pct: pct(g.height) })),
    lane: labels,
    lens: { height: cursor, pct: pct(cursor), column },
    reach: { min: chain.min, max: chain.max, ...clipped(chain.min, chain.max) },
    moveable: sweep && { ...sweep, ...clipped(sweep.min, sweep.max) },
    target: target && {
      low: targetLow,
      high: targetHigh,
      isRange: target.type === "range",
      ...span(targetLow, targetHigh),
    },
  };
}
