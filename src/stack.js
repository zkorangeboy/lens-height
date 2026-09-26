// Stack layout (SPEC.md 5.8): the drawing of a chain as a view model. All the
// height math a renderer would need — where each piece sits, how far forward
// it is, its pixel box and outline points, where the target falls, where each
// tag goes — is done here, so the UI and the outlines (outlines.js) draw
// numbers they're handed and compute nothing.
import { riseRangeOf, supportSegments } from "./model.js";

/** Which kind a piece's own adjustability puts it in (SPEC.md 3.5). */
const kindOf = (component) => component.adjustability || "fixed";

/** Adjustable extension is used before moveable: legs position the rig,
 * the boom takes what's left (SPEC.md 5.8). */
const ALLOCATION_ORDER = { fixed: 0, adjustable: 1, moveable: 2 };

/** Room above the highest thing drawn, as a fraction of the drawing. */
const HEADROOM = 0.05;

/** The drawing's size in pixels when the caller doesn't say (5.8). */
const DEFAULT_FRAME = { width: 320, height: 520 };
const FRAME_PAD = 6;

/**
 * Sizes, in inches, at true scale on both axes (5.8). Real where the gear
 * gives them — the Fisher 11 from its brochure's side elevation — and
 * simplified but true-to-size otherwise. Heights of the pieces themselves
 * always come from the model; these are only what the outlines need
 * around them.
 */
const DRAW = {
  appleWidth: { flat: 20, "12in": 20, "20in": 12 }, // a full apple is 20 × 12 × 8
  trackLength: 44,
  spreaderWidth: 36, // wider than baby or standard sticks' feet at full spread
  tripodTop: 4,
  standWidth: { "hi-hat": 16, "lo-hat": 14 },
  dolly: {
    rear: -20, // a 40″ chassis, centered on the support
    front: 20,
    wheelX: 14, // 28″ wheelbase: one wheel each end
    tire: 4.25, // pneumatic tire radius
    skate: { wheel: 1, plate: 2 }, // skateboard wheels under a 2″ plate
    chassisBottom: 3, // above the wheel datum
    deck: 12,
    rearBox: { from: -20, to: -8, top: 20 },
    posts: { x: -18.5, top: 39.75 }, // push posts, operating height
    pivot: { x: -4 }, // the beam pivots on the deck
    noseX: 21, // the nose: forward of the chassis, whatever the lift
    noseRadius: 1.25,
    beam: 2.5,
  },
  noseBlock: 5,
  noseBody: 3, // the SLE's leveling head, under its Mitchell plate
  bracketFoot: 10, // how far forward the LHE's foot sets the Mitchell (51.75″ overall vs 40″)
  bracketThickness: 1.5,
  mitchell: 2.5, // a Mitchell mount's radius
  plateThickness: 1,
  riser: 5.5,
  swivel: 6,
  head: 7,
  cradle: 11,
  camera: { back: -5, front: 6, height: 6, cone: 3, coneHalf: 1.5 }, // body (height if the build gives none), the forward triangle
};

/** Tag text size, in pixels: an 11px font at about 6.2px a character. */
const TAG = { char: 6.2, line: 13, padX: 5, padY: 3, gap: 4 };
const FLIP_IMAGE = "Camera inverted — flip image";

/** Which outline draws a support. */
const shapeOfSupport = (support) => ({ dolly: "dolly", tripod: "tripod", "hi-hat": "hi-hat", "lo-hat": "lo-hat" })[support.kind] || "hi-hat";

/** A tripod's legs splay wider the higher it's set, within reason. */
const tripodSpread = (rise) => Math.min(34, Math.max(14, rise * 0.6));

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} chain - a resolved chain (solver.js buildChain)
 * @param {{type:"fixed",height:number}|{type:"range",low:number,high:number}|null} [target]
 * @param {{frame?: {width: number, height: number}}} [options] - the
 *   drawing area's size in pixels; the layout's own `frame.height` may be
 *   less, when the rig is wide and the width sets the scale
 */
export function stackLayout(chain, target = null, options = {}) {
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

  // Walk the chain from the floor, in heights and horizontal inches. Each
  // piece sits on the mount of the one below; the chain moves sideways only
  // where a piece really moves it (5.8). `drawn` is the vertical span of a
  // piece's outline when it reaches past its own rise (a dolly's push
  // posts, a camera body past the lens axis, a plate's thickness).
  const raw = [];
  let cursor = 0;
  let mountX = 0;
  const place = (block, rise, extent, nextMountX = mountX, drawn = null) => {
    const start = cursor;
    cursor += rise;
    const low = Math.min(start, cursor);
    const high = Math.max(start, cursor);
    raw.push({
      ...block,
      rise,
      start,
      end: cursor,
      x: mountX,
      x0: mountX + extent[0],
      x1: mountX + extent[1],
      mountX: nextMountX,
      drawnLow: drawn ? Math.min(low, drawn[0]) : low,
      drawnHigh: drawn ? Math.max(high, drawn[1]) : high,
    });
    mountX = nextMountX;
  };

  chain.baseItems.forEach((item, index) => {
    const width =
      item.kind === "track"
        ? DRAW.trackLength
        : item.kind === "spreader"
          ? DRAW.spreaderWidth
          : DRAW.appleWidth[item.orientation] || DRAW.appleWidth.flat;
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
  const supportStart = cursor;
  // The wheels' datum: where a pneumatic tire touches. A wheel mode's rise
  // (ETW −½″, skateboard +2″) moves the whole dolly by that much.
  const datum = supportStart + (chain.support.modeRise || 0);
  const D = DRAW.dolly;
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
    supportShape === "dolly"
      ? [D.rear, D.noseX + D.noseRadius]
      : supportShape === "tripod"
        ? [-tripodSpread(supportRise) / 2, tripodSpread(supportRise) / 2]
        : [-DRAW.standWidth[supportShape] / 2, DRAW.standWidth[supportShape] / 2],
    supportShape === "dolly" ? D.noseX : 0,
    supportShape === "dolly" ? [Math.min(supportStart, datum - 0.5), datum + D.posts.top] : null
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
      bracket ? [-DRAW.bracketThickness, DRAW.bracketFoot + DRAW.mitchell] : [-DRAW.noseBlock / 2, DRAW.noseBlock / 2],
      bracket ? mountX + DRAW.bracketFoot : mountX,
      // The SLE's head hangs under its plate; the plate carries what's above.
      bracket ? null : [cursor + noseSegment.base + noseAllocation - DRAW.noseBody, cursor]
    );
  }

  chain.adapters.forEach((adapter, index) => {
    const plate = adapter.plateLength;
    const width = adapter.drawAs === "swivel" ? DRAW.swivel : DRAW.riser;
    place(
      { slot: "adapter", index, name: adapter.name, component: adapter, kind: kindOf(adapter), mode: adapter.mode, modeLabel: adapter.modeLabel },
      adapter.rise,
      plate ? [-DRAW.mitchell, plate + DRAW.mitchell] : [-width / 2, width / 2],
      plate ? mountX + plate : mountX,
      plate ? [cursor, cursor + DRAW.plateThickness] : null
    );
  });
  const cradles = Boolean(chain.head.cradlesCamera);
  place(
    { slot: "head", index: 0, name: chain.head.name, component: chain.head, kind: kindOf(chain.head), mode: chain.mode.name },
    chain.mode.rise,
    cradles ? [-DRAW.cradle / 2, DRAW.cradle / 2] : [-DRAW.head / 2, DRAW.head / 2]
  );
  // The camera: its body is centered on the optical center, whichever way it's mounted.
  const lensAt = cursor + chain.attach.rise;
  const bodyHalf = (chain.build.bodyHeight || DRAW.camera.height) / 2;
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
    [DRAW.camera.back, DRAW.camera.front + DRAW.camera.cone],
    mountX,
    [lensAt - bodyHalf, lensAt + bodyHalf]
  );

  // Insertion points (5.8): base i sits on base item i-1 (0 is the floor);
  // adapter j sits on the nose fitting or support (j = 0) or on adapter j-1.
  const firstAdapterOn = chain.baseItems.length + (chain.nose ? 1 : 0);
  const gapSpots = [];
  for (let i = 0; i <= chain.baseItems.length; i++) {
    const on = i === 0 ? null : raw[i - 1];
    gapSpots.push({ slot: "base", index: i, x: 0, height: on ? on.end : 0, on: on && on.name });
  }
  for (let j = 0; j <= chain.adapters.length; j++) {
    const on = raw[firstAdapterOn + j];
    gapSpots.push({ slot: "adapter", index: j, x: on.mountX, height: on.end, on: on.name });
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

  // The scale fits the current rig and the target (5.8): every piece as it's
  // set now, the target, and the top of a moving beam — at the largest one
  // scale, in pixels per inch, that fits both ways.
  const heights = [0, cursor, ...raw.flatMap((b) => [b.drawnLow, b.drawnHigh])];
  if (target) heights.push(targetLow, targetHigh);
  if (moveGhosts) heights.push(...moveGhosts);
  const lo = Math.min(...heights);
  const top = Math.max(...heights);
  const hi = top + (top - lo) * HEADROOM || lo + 1;
  const xMin = Math.min(...raw.map((b) => b.x0));
  const xMax = Math.max(...raw.map((b) => b.x1));
  const asked = { width: DEFAULT_FRAME.width, height: DEFAULT_FRAME.height, ...(options.frame || {}) };
  const scale = Math.min(asked.height / (hi - lo), (asked.width - 2 * FRAME_PAD) / (xMax - xMin || 1));
  // When the width is what limits the scale, the drawing is only as tall as
  // the rig needs: the caller sizes it to `frame.height`.
  const frame = { width: asked.width, height: round2(Math.min(asked.height, (hi - lo) * scale)) };
  const xOffset = (frame.width - (xMax - xMin) * scale) / 2;
  const X = (x) => round2(xOffset + (x - xMin) * scale);
  const Y = (height) => round2(frame.height - (height - lo) * scale);
  const px = (inches) => round2(inches * scale);
  const pt = (x, height) => ({ x: X(x), y: Y(height) });
  const pct = (height) => round2((((height - lo) * scale) / frame.height) * 100);
  const span = (from, to) => ({ bottomPct: pct(from), topPct: pct(to), heightPct: round2(pct(to) - pct(from)) });
  const clipped = (from, to) => ({
    ...span(clamp(from, lo, hi), clamp(to, lo, hi)),
    continuesBelow: from < lo,
    continuesAbove: to > hi,
  });
  const box = (x0, x1, from, to) => ({ x: X(x0), y: Y(to), width: px(x1 - x0), height: px(to - from) });

  // Each piece's outline and its own points (7.2): shapes only, no heights.
  const shapeOf = (b) => {
    const at = b.x;
    switch (b.slot) {
      case "base":
        if (b.component.kind === "spreader") return { type: "spreader" };
        return b.component.kind === "track"
          ? { type: "track", profile: b.component.topMount === "round-track" ? "round" : "square" }
          : { type: "apple" };
      case "support": {
        if (supportShape === "tripod") return { type: "tripod", mount: pt(at, b.end), topWidth: px(DRAW.tripodTop) };
        if (supportShape !== "dolly") return { type: supportShape, mount: pt(at, b.end) };
        const wheels = b.mode || "pneumatic";
        const tireCenter = datum + D.tire;
        return {
          type: "dolly",
          wheels,
          tire: { radius: px(D.tire), centers: [pt(-D.wheelX, tireCenter), pt(D.wheelX, tireCenter)] },
          skate: wheels === "skateboard" ? { radius: px(D.skate.wheel), plateTop: Y(b.start + D.skate.plate), floor: Y(b.start) } : null,
          chassis: box(D.rear, D.front, datum + D.chassisBottom, datum + D.deck),
          rearBox: box(D.rearBox.from, D.rearBox.to, datum + D.deck, datum + D.rearBox.top),
          posts: { x: X(D.posts.x), top: Y(datum + D.posts.top), bottom: Y(datum + D.rearBox.top), width: px(1) },
          pivot: pt(D.pivot.x, datum + D.deck),
          nose: pt(D.noseX, b.end),
          noseRadius: px(D.noseRadius),
          beam: px(D.beam),
          ghosts: moveGhosts ? moveGhosts.map((h) => pt(D.noseX, h)) : [],
        };
      }
      case "nose":
        return b.bracket
          ? { type: "lhe", nose: pt(at, b.start), foot: pt(b.mountX, b.end), thickness: px(DRAW.bracketThickness), mitchell: px(DRAW.mitchell) }
          : { type: "sle", plate: Y(b.end), nose: Y(b.start) };
      case "adapter":
        if (b.component.plateLength) {
          return {
            type: "offset",
            side: b.mode === "bottom" ? "bottom" : "top",
            near: pt(at, b.start),
            far: pt(b.mountX, b.start),
            plateTop: Y(b.start + DRAW.plateThickness),
            plateBottom: Y(b.start),
            mitchell: px(DRAW.mitchell),
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
          body: box(at + DRAW.camera.back, at + DRAW.camera.front, b.drawnLow, b.drawnHigh),
          // The triangle: its point at the body's front, on the optical
          // center; its opening forward, the way the camera shoots.
          cone: { x0: X(at + DRAW.camera.front), x1: X(at + DRAW.camera.front + DRAW.camera.cone), half: px(DRAW.camera.coneHalf) },
          opticalCenter: pt(at + DRAW.camera.front, b.end),
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
    const { start, end, x0, x1, drawnLow, drawnHigh, ...rest } = block;
    return {
      ...rest,
      direction: block.rise > 0 ? "up" : block.rise < 0 ? "down" : "flat",
      bottom,
      top: upper,
      ...span(bottom, upper),
      anchorY: Y((bottom + upper) / 2),
      box: box(x0, x1, drawnLow, drawnHigh),
      mount: pt(block.mountX, end),
      shape: shapeOf(block),
      ...(inner ? { parts: inner } : {}),
    };
  });

  // Tags (5.8): each piece's short name beside it — to its right, or its
  // left if there's no room — nudged down past any tag it would overlap.
  const placed = [];
  const order = blocks.map((b, i) => i).sort((a, c) => blocks[a].anchorY - blocks[c].anchorY);
  for (const i of order) {
    const b = blocks[i];
    const lines = [b.component.shortName || b.name, ...(b.inverted ? [FLIP_IMAGE] : [])];
    const width = round2(Math.max(...lines.map((l) => l.length)) * TAG.char + 2 * TAG.padX);
    const height = lines.length * TAG.line + 2 * TAG.padY;
    // Beside the piece; a piece wider than half the drawing (a dolly) keeps
    // its tag inside its own outline instead.
    let x = b.box.width > frame.width / 2 ? b.box.x + TAG.gap : b.box.x + b.box.width + TAG.gap;
    if (x + width > frame.width) x = b.box.x - TAG.gap - width;
    x = clamp(x, 0, Math.max(0, frame.width - width));
    let y = clamp(b.anchorY - height / 2, 0, Math.max(0, frame.height - height));
    const overlaps = (t) => x < t.x + t.width && t.x < x + width && y < t.y + t.height && t.y < y + height;
    for (let tries = 0; tries <= placed.length; tries++) {
      const other = placed.find(overlaps);
      if (!other) break;
      y = other.y + other.height + 2;
    }
    const tag = { lines, x: round2(x), y: round2(Math.min(y, Math.max(0, frame.height - height))), width, height, warn: Boolean(b.inverted) };
    placed.push(tag);
    b.tag = tag;
  }

  return {
    floor: { height: 0, pct: pct(0), y: Y(0) },
    frame: { width: frame.width, height: frame.height, scale: round2(scale) },
    blocks,
    gaps: gapSpots.map(({ x, height, ...g }) => ({ ...g, height, x, point: pt(x, height), pct: pct(height) })),
    lens: { height: cursor, pct: pct(cursor), ...blocks[blocks.length - 1].shape.opticalCenter },
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
