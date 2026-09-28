// Stack layout: the drawing of a chain as a view model. Not covered in
// SPEC.md — this code is the spec for the drawing — except the rigging
// order below, which is height math (SPEC.md 5.2).
import { pieceRise, riseRangeOf, supportSegments } from "./model.js";

/** Which kind a piece's own adjustability puts it in (SPEC.md 3.5). */
const kindOf = (component) => component.adjustability || "fixed";

/** Adjustable extension is used before moveable: legs position the rig,
 * the boom takes what's left (SPEC.md 5.2). */
const ALLOCATION_ORDER = { fixed: 0, adjustable: 1, moveable: 2 };

/** Room above the highest thing drawn, as a fraction of the drawing. */
const HEADROOM = 0.05;

/** The drawing's size in pixels when the caller doesn't say. */
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
    noseX: 16.5, // the nose: its front face 37.75″ from the rear (brochure), whatever the lift
    noseRadius: 1.25,
    noseDrop: 6, // the round nose sits this far below the modeled nose height (5.8)
    beam: 2.5,
  },
  // The Fisher's nose fittings (5.8), in inches from the nose's center (x)
  // and from the Mitchell (heights), off the nose's front face. The x
  // positions follow the brochure's overall lengths from the rear: SLE
  // normal 45″, reversed 40″, LHE 51.75″ (the rear is at −20, the nose's
  // center at 16.5).
  fitting: {
    clamp: [1.25, 3.5], // on the nose's front face; the reversed SLE's front-most part (40″)
    clampReach: 2, // the clamp covers the nose this far above and below its center
    base: 0.5, // the plate from the clamp to the cage
    cage: 3, // the leveling cage
    diamond: 0.75, // the diamond plate carrying the Mitchell
    normal: [2, 8.5], // diamond plate, rear to front (front at 45″); Mitchell at its center
    reversed: [-3.75, 2.75], // turned back over the nose
    ring: [8.75, 15.25], // the LHE's flat ring (front at 51.75″)
    ringThickness: 0.75,
    elbow: 3, // how far below the clamp the arm bends forward
  },
  mitchell: 2.5, // a Mitchell mount's radius
  plateThickness: 1,
  riser: 5.5,
  swivel: 6,
  head: 7,
  // The Lambda 50's L-frame, from its mount: pan base, base plate forward,
  // column at the rear, the platform cantilevered forward from the column.
  lambda: {
    pan: { half: 2.5, height: 1.5 },
    plate: [-3, 8], // the base plate, rear to front
    plateThickness: 1,
    column: [-3, -1.5],
    platform: [-1.5, 9.5],
    platformThickness: 1,
    columnPast: 2, // how far the column runs past the platform
    cameraX: 3.5, // the camera, centered on the platform
  },
  camera: { back: -5, front: 6, height: 6, cone: 3, coneHalf: 1.5 }, // body (height if the camera gives none), the forward triangle
  plateLength: 6, // a plate with no `length` of its own
};

/** A flip button (7.2): 22px hit radius (a 44px target), set this far from its piece. */
const FLIP = { radius: 22, gap: 18 };
const FLIP_IMAGE = "Camera inverted — flip image";

/** A nose fitting's upside-down mode (SPEC.md 3.7). */
const isFlippedName = (name) => /underslung/i.test(name || "");

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

  // Spread the extension needed over the support's segments, the nose
  // fitting's range, and the head's (SPEC.md 5.2): adjustable first — legs,
  // then the nose fitting's hand screw, then the Lambda 50's platform —
  // moveable last.
  // No support and no head: the camera block sits on the base (3.4).
  const segments = chain.support ? supportSegments(chain.support) : [];
  const noseRange = chain.nose ? riseRangeOf(chain.nose) : null;
  const noseSegment = noseRange && {
    kind: noseRange.max > noseRange.min ? chain.nose.adjustability || "adjustable" : "fixed",
    base: noseRange.min,
    extent: noseRange.max - noseRange.min,
  };
  const headRange = chain.mode ? riseRangeOf(chain.mode) : null;
  const headSegment = headRange && {
    kind: headRange.max > headRange.min ? chain.head.adjustability || "adjustable" : kindOf(chain.head),
    base: headRange.min,
    extent: headRange.max - headRange.min,
  };
  const allSegments = [...segments, ...(noseSegment ? [noseSegment] : []), ...(headSegment ? [headSegment] : [])];
  const noseIndex = segments.length;
  const headIndex = allSegments.length - 1;
  const allocation = allSegments.map(() => 0);
  // Extension is measured from the fully retracted rig, even when the reach
  // is limited to keep every piece above the floor (5.8).
  let remaining = rigged - (chain.retracted ?? chain.min);
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
  chain.baseItems.forEach((item, index) => {
    const width =
      item.kind === "track"
        ? DRAW.trackLength
        : item.kind === "spreader"
          ? tripodSpread(supportRise) // within the legs' splay at the floor (7.2)
          : DRAW.appleWidth[item.orientation] || DRAW.appleWidth.flat;
    place(
      { slot: "base", index, name: item.name, component: item, kind: kindOf(item), mode: item.mode, modeLabel: item.modeLabel },
      item.rise,
      [-width / 2, width / 2]
    );
  });

  const supportShape = chain.support ? shapeOfSupport(chain.support) : null;
  const supportStart = cursor;
  // The wheels' datum: where a pneumatic tire touches. A wheel mode's rise
  // (ETW −½″, skateboard +2″) moves the whole dolly by that much.
  const datum = supportStart + (chain.support?.modeRise || 0);
  const D = DRAW.dolly;
  const cradles = Boolean(chain.head?.cradlesCamera);
  const L = DRAW.lambda;
  if (chain.support) {
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
      const noseAllocation = allocation[noseIndex];
      const bracket = Boolean(chain.nose.hangsAsBracket);
      const F = DRAW.fitting;
      const rise = noseSegment.base + noseAllocation;
      const mitchell = cursor + rise;
      const noseCenter = cursor - D.noseDrop;
      const shape = bracket ? "lhe" : chain.nose.mode === "reversed" ? "reversed" : isFlippedName(chain.nose.mode) ? "upside-down" : "normal";
      const plate = shape === "lhe" ? F.ring : shape === "reversed" ? F.reversed : F.normal;
      const mitchellX = (plate[0] + plate[1]) / 2;
      // Its parts' heights (5.8): the diamond plate (or the LHE's ring) at
      // the Mitchell, the cage beside it, and a clamp from the nose to the cage.
      const dir = shape === "upside-down" ? -1 : 1; // upside down, the cage is above the Mitchell
      const band = (a, c) => [Math.min(a, c), Math.max(a, c)];
      const diamond = band(mitchell, mitchell - dir * (shape === "lhe" ? F.ringThickness : F.diamond));
      const cage = band(mitchell - dir * F.diamond, mitchell - dir * (F.diamond + F.cage));
      const cageFoot = mitchell - dir * (F.diamond + F.cage + F.base);
      const base = band(mitchell - dir * (F.diamond + F.cage), cageFoot);
      const clamp =
        shape === "lhe"
          ? band(noseCenter - F.clampReach, noseCenter + F.clampReach)
          : [Math.min(noseCenter - F.clampReach, cageFoot), Math.max(noseCenter + F.clampReach, cageFoot)];
      const nosePieces = { shape, noseCenter, clamp, cage, base, diamond, plate, mitchellX, elbowAt: clamp[0] - F.elbow };
      const heights = shape === "lhe" ? [...clamp, ...diamond, nosePieces.elbowAt] : [...clamp, ...cage, ...base, ...diamond];
      const xs = shape === "lhe" ? [F.clamp[0], plate[1]] : [Math.min(F.clamp[0], plate[0]), Math.max(F.clamp[1], plate[1])];
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
          nosePieces,
          ...(noseSegment.extent > 0 ? { range: { min: noseRange.min, max: noseRange.max } } : {}),
        },
        rise,
        xs,
        // The Mitchell, where the next piece mounts: forward of the nose, or turned back over it.
        mountX + mitchellX,
        [Math.min(...heights), Math.max(...heights)]
      );
    }

    chain.adapters.forEach((adapter, index) => {
      const plate = adapter.plateLength;
      const rotating = adapter.drawAs === "swivel";
      const width = rotating ? DRAW.swivel : DRAW.riser;
      place(
        { slot: "adapter", index, name: adapter.name, component: adapter, kind: kindOf(adapter), mode: adapter.mode, modeLabel: adapter.modeLabel },
        adapter.rise,
        plate ? [-DRAW.mitchell, plate + DRAW.mitchell] : [-width / 2, width / 2],
        plate ? mountX + plate : mountX,
        // A flat offset plate is drawn as a thin band; the rotating offset's
        // cage fills its own rise instead, like a riser (5.8).
        plate && !rotating ? [cursor, cursor + DRAW.plateThickness] : null
      );
    });
    const headRise = headSegment.base + allocation[headIndex];
    place(
      {
        slot: "head",
        index: 0,
        name: chain.head.name,
        component: chain.head,
        kind: headSegment.kind,
        mode: chain.mode.name,
        ...(headSegment.extent > 0 ? { range: { min: headRange.min, max: headRange.max } } : {}),
      },
      headRise,
      cradles ? [L.column[0], L.platform[1]] : [-DRAW.head / 2, DRAW.head / 2],
      // The camera sits on the platform, forward of the column.
      cradles ? mountX + L.cameraX : mountX,
      // The L-frame: the column runs a little past the platform.
      cradles
        ? headRise < 0
          ? [cursor + headRise - L.columnPast, cursor]
          : [cursor, cursor + headRise + L.columnPast]
        : null
    );
  }

  // Plates between the head and the camera block (3.4); a plate on a
  // down-facing interface hangs, its rise negative.
  chain.plates.forEach((plate, index) => {
    const length = plate.length || DRAW.plateLength;
    place(
      { slot: "plate", index, name: plate.name, component: plate, kind: kindOf(plate), hangs: Boolean(plate.inverted) },
      plate.rise,
      [-length / 2, length / 2]
    );
  });

  // The camera block (3.4): its pieces at true scale, stacked as rigged —
  // upright, hanging inverted (the same pieces, going down), or hung from
  // the camera's top handle (the camera upright, its plates below it).
  const camera = chain.blockPieces.find((piece) => piece.category === "camera-body");
  const bodyHeight = camera?.bodyHeight || DRAW.camera.height;
  const lensAbove = camera?.opticalCenterAboveBase ?? bodyHeight / 2;
  const plates = chain.blockPieces.filter((piece) => piece !== camera);
  const lensAt = cursor + chain.attach.rise;
  const spans = [];
  let body;
  if (chain.attach.name === "top-handle" || !camera) {
    body = [lensAt - lensAbove, lensAt - lensAbove + bodyHeight];
    let at = body[0];
    for (const piece of [...plates].reverse()) {
      spans.unshift({ piece, low: at - pieceRise(piece), high: at }); // kept in the block's order
      at -= pieceRise(piece);
    }
  } else {
    const dir = chain.attach.inverted ? -1 : 1;
    let at = cursor;
    for (const piece of plates) {
      const next = at + dir * pieceRise(piece);
      spans.push({ piece, low: Math.min(at, next), high: Math.max(at, next) });
      at = next;
    }
    body = dir > 0 ? [at, at + bodyHeight] : [at - bodyHeight, at];
  }
  // The block's plates are centered under the camera body.
  const middle = (DRAW.camera.back + DRAW.camera.front) / 2;
  const widest = Math.max(0, ...plates.map((piece) => (piece.length || DRAW.plateLength) / 2));
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
      pieceSpans: { body, spans },
    },
    chain.attach.rise,
    [Math.min(DRAW.camera.back, middle - widest), Math.max(DRAW.camera.front + DRAW.camera.cone, middle + widest)],
    mountX,
    [Math.min(body[0], ...spans.map((p) => p.low)), Math.max(body[1], ...spans.map((p) => p.high))]
  );

  // Insertion points (5.8): base i sits on base item i-1 (0 is the floor);
  // adapter j sits on the nose fitting or support (j = 0) or on adapter j-1.
  const firstAdapterOn = chain.baseItems.length + (chain.nose ? 1 : 0);
  const gapSpots = [];
  for (let i = 0; i <= chain.baseItems.length; i++) {
    const on = i === 0 ? null : raw[i - 1];
    gapSpots.push({ slot: "base", index: i, x: 0, height: on ? on.end : 0, on: on && on.name });
  }
  for (let j = 0; chain.support && j <= chain.adapters.length; j++) {
    const on = raw[firstAdapterOn + j];
    gapSpots.push({ slot: "adapter", index: j, x: on.mountX, height: on.end, on: on.name });
  }
  // plate j sits on the head (or the base, with no head) or on plate j−1.
  const plateStart = raw.findIndex((b) => b.slot === "build") - chain.plates.length;
  for (let j = 0; j <= chain.plates.length; j++) {
    const on = raw[plateStart + j - 1];
    gapSpots.push({ slot: "plate", index: j, x: on ? on.mountX : 0, height: on ? on.end : 0, on: on && on.name });
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

  // Where a piece's flip button goes (5.8): beside it — to its right, or its
  // left if there's no room — inside the drawing, clear of the edge by the
  // button's 22px hit radius.
  // Beside it — right, left, below, then above — at the first spot inside
  // the drawing that covers no piece; failing that, to its right, kept inside.
  const flipPoint = (b, others) => {
    const cx = b.x + b.width / 2;
    const cy = b.y + b.height / 2;
    const spots = [
      { x: b.x + b.width + FLIP.gap, y: cy },
      { x: b.x - FLIP.gap, y: cy },
      { x: cx, y: b.y + b.height + FLIP.gap },
      { x: cx, y: b.y - FLIP.gap },
    ];
    const inside = (p) => p.x >= FLIP.radius && p.x <= frame.width - FLIP.radius && p.y >= FLIP.radius && p.y <= frame.height - FLIP.radius;
    const clear = (p) =>
      others.every((o) => p.x + FLIP.radius <= o.x || p.x - FLIP.radius >= o.x + o.width || p.y + FLIP.radius <= o.y || p.y - FLIP.radius >= o.y + o.height);
    const spot = spots.find((p) => inside(p) && clear(p)) || spots[0];
    return {
      x: round2(clamp(spot.x, FLIP.radius, frame.width - FLIP.radius)),
      y: round2(clamp(spot.y, FLIP.radius, Math.max(FLIP.radius, frame.height - FLIP.radius))),
    };
  };

  // Each piece's outline and its own points (7.2): shapes only, no heights.
  const shapeOf = (b) => {
    const at = b.x;
    switch (b.slot) {
      case "base":
        if (b.component.kind === "spreader") return { type: "spreader" };
        return b.component.kind === "track"
          ? { type: "track" }
          : { type: "apple" };
      case "support": {
        if (supportShape === "tripod") {
          // Legs telescope: a fixed upper tube, always b.range.min long, and
          // a lower tube sliding out of it. `jointAt` is where the collar
          // sits, as a fraction of the leg measured from the mount down —
          // 1 (the very foot) at the collapsed minimum, shrinking toward
          // range.min/range.max as the set height rises — so the upper
          // tube's own drawn length never changes.
          const jointAt = b.rise > 0 ? clamp(b.range.min / b.rise, 0, 1) : 1;
          return { type: "tripod", mount: pt(at, b.end), topWidth: px(DRAW.tripodTop), jointAt };
        }
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
          nose: pt(D.noseX, b.end - D.noseDrop),
          noseRadius: px(D.noseRadius),
          beam: px(D.beam),
          ghosts: moveGhosts ? moveGhosts.map((h) => pt(D.noseX, h - D.noseDrop)) : [],
        };
      }
      case "nose": {
        // Off the nose's front face (5.8): each part as a pixel box.
        const P = b.nosePieces;
        const F = DRAW.fitting;
        const clamp = box(at + F.clamp[0], at + F.clamp[1], ...P.clamp);
        if (P.shape === "lhe") {
          const armX = at + F.clamp[0] + (F.clamp[1] - F.clamp[0]) / 2;
          return {
            type: "lhe",
            clamp,
            // The arm: down from the clamp, then bent forward and down to the ring's rear edge.
            arm: [pt(armX, P.clamp[0]), pt(armX, P.elbowAt), pt(at + P.plate[0], P.diamond[1] - F.ringThickness / 2)],
            ring: box(at + P.plate[0], at + P.plate[1], ...P.diamond),
            mitchell: pt(b.mountX, b.end),
          };
        }
        return {
          type: "sle",
          position: P.shape,
          clamp,
          base: box(Math.min(at + F.clamp[0], at + P.plate[0]), Math.max(at + F.clamp[1], at + P.plate[1]), ...P.base),
          cage: box(at + P.plate[0] + 0.75, at + P.plate[1] - 0.75, ...P.cage),
          diamond: box(at + P.plate[0], at + P.plate[1], ...P.diamond),
          mitchell: pt(b.mountX, b.end),
        };
      }
      case "adapter":
        if (b.component.drawAs === "swivel") return { type: "rotating-offset" };
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
        if (b.component.cradlesCamera) {
          // Upright, the frame stands on its mount; underslung, it's the
          // same frame flipped, hanging under a down-facing mount.
          const dir = b.rise < 0 ? -1 : 1;
          const at0 = b.start;
          const panEnd = at0 + dir * L.pan.height;
          const plateEnd = panEnd + dir * L.plateThickness;
          const platformUnder = b.end - L.platformThickness; // the camera sits on the platform's top
          const columnEnd = dir > 0 ? b.end + L.columnPast : platformUnder - L.columnPast;
          const span = (a, c) => [Math.min(a, c), Math.max(a, c)];
          return {
            type: "lambda",
            hangs: dir < 0,
            mount: pt(at, at0),
            platformTop: pt(at + L.cameraX, b.end),
            pan: box(at - L.pan.half, at + L.pan.half, ...span(at0, panEnd)),
            plate: box(at + L.plate[0], at + L.plate[1], ...span(panEnd, plateEnd)),
            column: box(at + L.column[0], at + L.column[1], ...span(panEnd, columnEnd)),
            platform: box(at + L.platform[0], at + L.platform[1], platformUnder, b.end),
          };
        }
        return { type: "fluid-head", inverted: b.rise < 0 };
      case "plate":
        return { type: "plate", hangs: b.hangs };
      case "build":
        return {
          type: "camera",
          inverted: Boolean(b.inverted),
          handle: b.attach === "top-handle",
          attach: pt(at, b.start),
          body: box(at + DRAW.camera.back, at + DRAW.camera.front, ...b.pieceSpans.body),
          // Every other piece of the block, as a plate at its true rise.
          pieces: b.pieceSpans.spans.map(({ piece, low, high }) => {
            const half = (piece.length || DRAW.plateLength) / 2;
            const middle = at + (DRAW.camera.back + DRAW.camera.front) / 2;
            return { id: piece.id, name: piece.name, box: box(middle - half, middle + half, low, high) };
          }),
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
    const { start, end, x0, x1, drawnLow, drawnHigh, pieceSpans, nosePieces, ...rest } = block;
    return {
      ...rest,
      direction: block.rise > 0 ? "up" : block.rise < 0 ? "down" : "flat",
      bottom,
      top: upper,
      ...span(bottom, upper),
      box: box(x0, x1, drawnLow, drawnHigh),
      mount: pt(block.mountX, end),
      shape: shapeOf(block),
      ...(inner ? { parts: inner } : {}),
    };
  });

  // Flip points (5.8), once every piece's box is known.
  for (const b of blocks) b.flipAt = flipPoint(b.box, blocks.filter((o) => o !== b).map((o) => o.box));

  return {
    floor: { height: 0, pct: pct(0), y: Y(0) },
    frame: { width: frame.width, height: frame.height, scale: round2(scale) },
    blocks,
    // The one warning the drawing carries, shown under it (7.2).
    warning: chain.attach.inverted ? FLIP_IMAGE : null,
    gaps: gapSpots.map(({ x, height, ...g }) => ({ ...g, height, x, point: pt(x, height), pct: pct(height) })),
    lens: { height: cursor, pct: pct(cursor), ...blocks[blocks.length - 1].shape.opticalCenter },
    reach: { min: chain.min, max: chain.max, ...clipped(chain.min, chain.max) },
    // The lowest any piece above the support reaches as drawn, in inches: the
    // floor limit's measure (5.8). The base and support never rise with the lift.
    lowest: Math.min(...raw.filter((b) => b.slot !== "base" && b.slot !== "support").map((b) => b.drawnLow)),
    moveable: sweep && { ...sweep, ...clipped(sweep.min, sweep.max) },
    target: target && {
      low: targetLow,
      high: targetHigh,
      isRange: target.type === "range",
      ...span(targetLow, targetHigh),
    },
  };
}
