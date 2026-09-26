// Stack layout (SPEC.md 5.8): the drawing of a chain as a view model. All the
// height math a renderer would need — where each piece sits, how far forward
// it is, its pixel box and outline points, where the target falls, where each
// label goes — is done here, so the UI and the outlines (outlines.js) draw
// numbers they're handed and compute nothing.
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

/** The drawing's size in pixels when the caller doesn't say (5.8). */
const DEFAULT_FRAME = { width: 180, height: 520 };
const FRAME_PAD = 6;
/** Schematic widths may be drawn down to this fraction to fit across. */
const SQUEEZE_MIN = 0.25;

/**
 * Schematic horizontal sizes, in inches (5.8, 7.2). Only offset plates are
 * drawn to their real length (their `plateLength`); these just make each
 * outline read as what it is. Vertical sizes always come from the model.
 */
const DRAW = {
  appleWidth: { flat: 20, "12in": 20, "20in": 12 }, // sized by the face it stands on
  trackWidth: 30,
  tripodTop: 4,
  standWidth: { "hi-hat": 16, "lo-hat": 14 },
  dolly: {
    back: -12, // chassis, relative to its center
    front: 10,
    pivotX: -9, // where the beam pivots on the chassis
    noseX: 14, // the nose: fixed forward of the chassis, whatever the lift
    noseRadius: 1.25,
    chassis: 9, // chassis height, capped so a short dolly still reads
    wheel: { pneumatic: 3, etw: 1.5, skateboard: 1.25 },
  },
  noseBlock: 6,
  bracketFoot: 11, // how far forward the LHE's foot sets the Mitchell
  bracketArm: 1.5,
  mitchell: 1.5, // a Mitchell stub on an offset plate
  plateThickness: 1,
  riser: 5,
  head: 8,
  cradle: 11,
  camera: { back: -4, front: 3, barrel: 6, lensDot: 6 },
};

/** Which outline draws a support. */
const shapeOfSupport = (support) => ({ dolly: "dolly", tripod: "tripod", "hi-hat": "hi-hat", "lo-hat": "lo-hat" })[support.kind] || "hi-hat";

/** A tripod's legs splay wider the higher it's set, within reason. */
const tripodSpread = (rise) => Math.min(34, Math.max(14, rise * 0.6));

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round2 = (n) => Math.round(n * 100) / 100;

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
 * @param {{lane?: {plotPx: number, labelPx: number[]}, frame?: {width: number, height: number}}} [options] -
 *   each block's measured label height and the plot's height, and the
 *   drawing area's size, all in pixels
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

  // Walk the chain from the floor, in heights and in horizontal inches. The
  // chain moves sideways only where a piece really moves it (5.8): the
  // Fisher's nose, an offset plate's length, the LHE's foot.
  //
  // A horizontal position is kept as two parts: `real` inches (an offset
  // plate's length, drawn true to the vertical scale) and `schematic` inches
  // (everything else), which may be drawn narrower so the rig fits.
  const H = (real, schematic = 0) => ({ real, schematic });
  const plus = (a, b) => H(a.real + b.real, a.schematic + b.schematic);
  const raw = [];
  let cursor = 0;
  let mountX = H(0);
  const place = (block, rise, extent, nextMountX = mountX) => {
    const start = cursor;
    cursor += rise;
    const [from, to] = extent.map((e) => (typeof e === "number" ? H(0, e) : e));
    raw.push({ ...block, rise, start, end: cursor, h: mountX, h0: plus(mountX, from), h1: plus(mountX, to), hMount: nextMountX });
    mountX = nextMountX;
  };

  chain.baseItems.forEach((item, index) => {
    const width = item.kind === "track" ? DRAW.trackWidth : DRAW.appleWidth[item.orientation] || DRAW.appleWidth.flat;
    place(
      { slot: "base", index, name: item.name, component: item, kind: kindOf(item), mode: item.mode, modeLabel: item.modeLabel },
      item.rise,
      [-width / 2, width / 2]
    );
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
  const supportRise = supportParts.reduce((sum, part) => sum + part.rise, 0);
  const supportShape = shapeOfSupport(chain.support);
  const supportExtent =
    supportShape === "dolly"
      ? [DRAW.dolly.back, DRAW.dolly.noseX + DRAW.dolly.noseRadius]
      : supportShape === "tripod"
        ? [-tripodSpread(supportRise) / 2, tripodSpread(supportRise) / 2]
        : [-DRAW.standWidth[supportShape] / 2, DRAW.standWidth[supportShape] / 2];
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
    supportRise,
    supportExtent,
    supportShape === "dolly" ? H(0, DRAW.dolly.noseX) : H(0)
  );

  if (chain.nose) {
    const noseAllocation = allocation[allSegments.length - 1];
    const bracket = Boolean(chain.nose.hangsAsBracket);
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
        bracket,
        ...(noseSegment.extent > 0 ? { range: { min: noseRange.min, max: noseRange.max } } : {}),
      },
      noseSegment.base + noseAllocation,
      bracket ? [-DRAW.bracketArm, DRAW.bracketFoot + DRAW.bracketArm] : [-DRAW.noseBlock / 2, DRAW.noseBlock / 2],
      bracket ? plus(mountX, H(0, DRAW.bracketFoot)) : mountX
    );
  }

  chain.adapters.forEach((adapter, index) => {
    const plate = adapter.plateLength;
    place(
      { slot: "adapter", index, name: adapter.name, component: adapter, kind: kindOf(adapter), mode: adapter.mode, modeLabel: adapter.modeLabel },
      adapter.rise,
      plate ? [H(0, -DRAW.mitchell), H(plate, DRAW.mitchell)] : [-DRAW.riser / 2, DRAW.riser / 2],
      plate ? plus(mountX, H(plate)) : mountX
    );
  });
  const cradles = Boolean(chain.head.cradlesCamera);
  place(
    { slot: "head", index: 0, name: chain.head.name, component: chain.head, kind: kindOf(chain.head), mode: chain.mode.name },
    chain.mode.rise,
    cradles ? [-DRAW.cradle / 2, DRAW.cradle / 2] : [-DRAW.head / 2, DRAW.head / 2]
  );
  place(
    {
      slot: "build",
      index: 0,
      name: chain.build.name,
      component: chain.build,
      kind: kindOf(chain.build),
      attach: chain.attach.name,
      inverted: Boolean(chain.attach.inverted),
      cradled: cradles,
    },
    chain.attach.rise,
    [DRAW.camera.back, DRAW.camera.front + DRAW.camera.barrel]
  );

  // Insertion points (5.8): base i sits on base item i-1 (0 is the floor);
  // adapter j sits on the nose fitting or support (j = 0) or on adapter j-1.
  const firstAdapterOn = chain.baseItems.length + (chain.nose ? 1 : 0);
  const gapSpots = [];
  for (let i = 0; i <= chain.baseItems.length; i++) {
    const on = i === 0 ? null : raw[i - 1];
    gapSpots.push({ slot: "base", index: i, h: H(0), height: on ? on.end : 0, on: on && on.name });
  }
  for (let j = 0; j <= chain.adapters.length; j++) {
    const on = raw[firstAdapterOn + j];
    gapSpots.push({ slot: "adapter", index: j, h: on.hMount, height: on.end, on: on.name });
  }

  // The moveable portion: how far the lens can sweep from this setup with
  // everything else held still.
  const moveableExtent = segments.reduce((sum, s) => (s.kind === "moveable" ? sum + s.extent : sum), 0);
  const moveableUsed = segments.reduce((sum, s, i) => (s.kind === "moveable" ? sum + allocation[i] : sum), 0);
  const sweep = moveableExtent > 0 ? { min: cursor - moveableUsed, max: cursor - moveableUsed + moveableExtent } : null;

  const targetLow = !target ? null : target.type === "fixed" ? target.height : target.low;
  const targetHigh = !target ? null : target.type === "fixed" ? target.height : target.high;

  // The nose at the bottom and top of a moveable range move (5.8): the beam
  // lifts it by as much as the move asks, within what the beam has left.
  const supportBlock = raw.find((b) => b.slot === "support");
  const moveGhosts =
    supportShape === "dolly" && target && target.type === "range" && sweep
      ? [supportBlock.end, supportBlock.end + clamp(targetHigh - targetLow, 0, sweep.max - cursor)]
      : null;

  // What's drawn beyond a piece's own rise: an offset plate's thickness.
  const drawnTop = (b) => (b.component.plateLength ? Math.max(b.start, b.end) + DRAW.plateThickness : Math.max(b.start, b.end));

  // The drawing's scale fits the content (5.8): the floor (or a piece hanging
  // below it) up to just above the highest of the lens, the target, and the
  // pieces; across every piece. One scale for both axes.
  const heights = [0, cursor, ...raw.flatMap((b) => [b.start, b.end, drawnTop(b)])];
  if (target) heights.push(targetLow, targetHigh);
  if (moveGhosts) heights.push(...moveGhosts);
  const lo = Math.min(...heights);
  const top = Math.max(...heights);
  const hi = top + (top - lo) * HEADROOM || lo + 1;
  // Scale (5.8): true vertical scale for the height of the frame. Schematic
  // widths squeeze (down to SQUEEZE_MIN) so the rig fits across; only if
  // the real plate lengths still don't fit does the whole drawing shrink.
  const frame = { width: DEFAULT_FRAME.width, height: DEFAULT_FRAME.height, ...(options.frame || {}) };
  const across = frame.width - 2 * FRAME_PAD;
  const spanAt = (k) => {
    const xs = raw.flatMap((b) => [b.h0, b.h1]).map((h) => h.real + h.schematic * k);
    return { min: Math.min(...xs), max: Math.max(...xs) };
  };
  let scale = frame.height / (hi - lo);
  let squeeze = 1;
  while (squeeze > SQUEEZE_MIN && (spanAt(squeeze).max - spanAt(squeeze).min) * scale > across) squeeze = round2(squeeze - 0.05);
  const width = spanAt(squeeze);
  scale = Math.min(scale, across / (width.max - width.min || 1));
  const inchesAcross = (h) => h.real + h.schematic * squeeze;
  const xMin = width.min;
  const xOffset = (frame.width - (width.max - width.min) * scale) / 2;
  const X = (x) => round2(xOffset + (x - xMin) * scale);
  const Y = (height) => round2(frame.height - (height - lo) * scale);
  const pt = (x, height) => ({ x: X(x), y: Y(height) });
  const pct = (height) => round2((((height - lo) * scale) / frame.height) * 100);
  const span = (from, to) => ({ bottomPct: pct(from), topPct: pct(to), heightPct: round2(pct(to) - pct(from)) });
  const clipped = (from, to) => ({
    ...span(clamp(from, lo, hi), clamp(to, lo, hi)),
    continuesBelow: from < lo,
    continuesAbove: to > hi,
  });
  for (const b of raw) {
    b.x = round2(inchesAcross(b.h));
    b.x0 = inchesAcross(b.h0);
    b.x1 = inchesAcross(b.h1);
    b.mountX = round2(inchesAcross(b.hMount));
  }
  const box = (x0, x1, from, to) => ({ x: X(x0), y: Y(to), width: round2((x1 - x0) * scale), height: round2((to - from) * scale) });

  // Each piece's outline and its own points (7.2): shapes only, no heights.
  const sq = (inches) => inches * squeeze; // a schematic width, squeezed
  const shapeOf = (b) => {
    const bottom = Math.min(b.start, b.end);
    const upper = Math.max(b.start, b.end);
    const at = b.x;
    switch (b.slot) {
      case "base":
        return b.component.kind === "track"
          ? { type: "track", profile: b.component.topMount === "round-track" ? "round" : "square" }
          : { type: "apple" };
      case "support":
        if (supportShape === "dolly") {
          const chassisTop = b.start + Math.min(DRAW.dolly.chassis, b.rise * 0.6);
          return {
            type: "dolly",
            wheels: b.mode || "pneumatic",
            wheelRadius: round2(DRAW.dolly.wheel[b.mode] * scale || DRAW.dolly.wheel.pneumatic * scale),
            chassis: box(sq(DRAW.dolly.back), sq(DRAW.dolly.front), b.start, chassisTop),
            pivot: pt(sq(DRAW.dolly.pivotX), chassisTop),
            nose: pt(b.mountX, b.end),
            noseRadius: round2(DRAW.dolly.noseRadius * scale),
            ghosts: moveGhosts ? moveGhosts.map((h) => pt(b.mountX, h)) : [],
          };
        }
        if (supportShape === "tripod") return { type: "tripod", mount: pt(at, b.end), topWidth: round2(sq(DRAW.tripodTop) * scale) };
        return { type: supportShape, mount: pt(at, b.end) };
      case "nose":
        return b.bracket
          ? { type: "lhe", nose: pt(at, b.start), foot: pt(b.mountX, b.end), arm: round2(sq(DRAW.bracketArm) * scale) }
          : { type: "sle", plate: Y(b.end) };
      case "adapter":
        if (b.component.plateLength) {
          return {
            type: "offset",
            side: b.mode === "bottom" ? "bottom" : "top",
            near: pt(at, b.start),
            far: pt(b.mountX, b.start),
            plateTop: Y(b.start + DRAW.plateThickness),
            plateBottom: Y(b.start),
            mitchell: round2(sq(DRAW.mitchell) * scale),
          };
        }
        return { type: b.component.drawAs === "swivel" ? "swivel" : "riser" };
      case "head":
        return b.component.cradlesCamera
          ? { type: "lambda", mount: pt(at, b.start), bracket: pt(at, b.end), hangs: b.rise < 0 }
          : { type: "fluid-head", inverted: b.rise < 0 };
      case "build":
        return {
          type: "camera",
          inverted: Boolean(b.inverted),
          handle: b.attach === "top-handle",
          attach: pt(at, b.start),
          lens: pt(at + sq(DRAW.camera.lensDot), b.end),
          body: box(at + sq(DRAW.camera.back), at + sq(DRAW.camera.front), bottom, upper),
          barrel: round2(sq(DRAW.camera.barrel) * scale),
        };
      default:
        return { type: "block" };
    }
  };

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
    const { start, end, x0, x1, h, h0, h1, hMount, ...rest } = block;
    return {
      ...rest,
      direction: block.rise > 0 ? "up" : block.rise < 0 ? "down" : "flat",
      bottom,
      top: upper,
      ...span(bottom, upper),
      anchorPct: pct((bottom + upper) / 2),
      anchorY: Y((bottom + upper) / 2),
      box: box(x0, x1, bottom, block.component.plateLength ? drawnTop(block) : upper),
      mount: pt(block.mountX, end),
      shape: shapeOf(block),
      ...(inner ? { parts: inner } : {}),
    };
  });

  // The label lane: every block's label, each near its own height but
  // never overlapping (5.8).
  const entries = blocks
    .map((b, i) => ({ block: i, anchorPct: b.anchorPct, anchorY: b.anchorY, size: labelPct(i) }))
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
    floor: { height: 0, pct: pct(0), y: Y(0) },
    frame: { width: frame.width, height: frame.height, scale: round2(scale), squeeze },
    blocks,
    gaps: gapSpots.map(({ h, height, ...g }) => {
      const x = round2(inchesAcross(h));
      return { ...g, height, x, point: pt(x, height), pct: pct(height) };
    }),
    lane: labels,
    lens: { height: cursor, pct: pct(cursor), ...pt(raw[raw.length - 1].x + sq(DRAW.camera.lensDot), cursor) },
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
