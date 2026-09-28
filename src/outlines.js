// Schematic outlines for the drawing: one per kind of gear. Not covered in
// SPEC.md — this code is the spec for shapes.
// Each draws shapes only, inside the pixel box and points stackLayout
// (stack.js) hands it — where a piece's top and bottom are, where the nose
// is, where the lens is. None of it decides a height: every vertical
// position arrives computed. Returns SVG markup strings.
//
// Fills: `k-fixed`, `k-adjustable`, `k-moveable` (3.5), styled in
// styles.css. Every outline is drawn with the class `o`.

const n = (v) => Math.round(v * 10) / 10;
const attrs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => `${k}="${typeof v === "number" ? n(v) : v}"`)
    .join(" ");
const rect = (x, y, width, height, cls, extra = {}) =>
  `<rect ${attrs({ x, y, width: Math.max(width, 0), height: Math.max(height, 0), class: cls, ...extra })}/>`;
const line = (x1, y1, x2, y2, cls) => `<line ${attrs({ x1, y1, x2, y2, class: cls })}/>`;
const circle = (cx, cy, r, cls) => `<circle ${attrs({ cx, cy, r: Math.max(r, 0), class: cls })}/>`;
const poly = (points, cls) => `<polygon ${attrs({ points: points.map(([x, y]) => `${n(x)},${n(y)}`).join(" "), class: cls })}/>`;
const path = (d, cls) => `<path ${attrs({ d, class: cls })}/>`;

/** The box's geometry, for drawing inside it. */
const frame = (box) => ({
  left: box.x,
  right: box.x + box.width,
  top: box.y,
  bottom: box.y + box.height,
  cx: box.x + box.width / 2,
  cy: box.y + box.height / 2,
  w: box.width,
  h: box.height,
});
/** Something too thin to see still shows as a sliver this many px thick. */
const MIN_PX = 4;
const fill = (kind) => `o k-${kind || "fixed"}`;
/** Draw `inner` upside down within the box (an underslung head, an inverted camera). */
const flipped = (box, inner) => {
  const f = frame(box);
  return `<g transform="translate(0 ${n(2 * f.cy)}) scale(1 -1)">${inner}</g>`;
};

// --- Base layer ------------------------------------------------------------

function apple(block) {
  const f = frame(block.box);
  const h = Math.max(f.h, MIN_PX);
  const holes =
    h > 14
      ? [0.25, 0.75].map((at) => rect(f.left + f.w * at - f.w * 0.08, f.top + h * 0.35, f.w * 0.16, h * 0.18, "o hole", { rx: 3 })).join("")
      : "";
  return rect(f.left, f.bottom - h, f.w, h, fill(block.kind), { rx: 2 }) + holes;
}

function track(block) {
  // Side on: a round rail along the top, ties under it.
  const f = frame(block.box);
  const h = Math.max(f.h, MIN_PX);
  const rail = { rx: h * 0.35 };
  const ties = [0.1, 0.35, 0.6, 0.85].map((at) => rect(f.left + f.w * at, f.bottom - h * 0.35, f.w * 0.06, h * 0.35, "o k-fixed tie")).join("");
  return ties + rect(f.left, f.bottom - h, f.w, h * 0.65, fill(block.kind), rail);
}

function spreader(block) {
  // Side on: a low bar under the tripod feet, a caster wheel at each end.
  const f = frame(block.box);
  const h = Math.max(f.h, MIN_PX);
  const r = h * 0.3;
  const bar = rect(f.left, f.bottom - h, f.w, h * 0.35, fill(block.kind), { rx: h * 0.15 });
  const casters = [f.left + r, f.cx, f.right - r]
    .map((x) => line(x, f.bottom - h * 0.65, x, f.bottom - 2 * r, "o") + circle(x, f.bottom - r, r, "o k-fixed wheel"))
    .join("");
  return casters + bar;
}

// --- Supports ----------------------------------------------------------------

function tripod(block) {
  const f = frame(block.box);
  const { mount, topWidth, jointAt = 1 } = block.shape;
  const bowl = rect(mount.x - topWidth / 2, f.top, topWidth, Math.min(f.h * 0.06, 10), "o k-fixed");
  const collarR = Math.min(topWidth * 0.16, 3.5);
  const legs = [
    [mount.x - topWidth / 2, f.left],
    [mount.x, mount.x],
    [mount.x + topWidth / 2, f.right],
  ]
    .map(([fromX, toX]) => {
      // A fixed upper tube from the mount to the collar, and a lower tube
      // sliding out of it to the foot.
      const jointX = fromX + (toX - fromX) * jointAt;
      const jointY = f.top + (f.bottom - f.top) * jointAt;
      return (
        line(fromX, f.top, jointX, jointY, "leg k-fixed") +
        line(jointX, jointY, toX, f.bottom, "leg k-adjustable") +
        circle(jointX, jointY, collarR, "o k-fixed")
      );
    })
    .join("");
  const spreader = line(f.left + f.w * 0.12, f.bottom - f.h * 0.08, f.right - f.w * 0.12, f.bottom - f.h * 0.08, "o spreader");
  return legs + spreader + bowl;
}

/** From their reference photos, simplified, not traced: a
 * board, a tapered body faceted with two panel lines, and a flat Mitchell
 * cap on top. The hi-hat and low hat share this shape — the low hat is
 * just a shorter box, so its body comes out shorter too. */
function stand(block) {
  const f = frame(block.box);
  const boardH = Math.min(Math.max(f.h * 0.14, MIN_PX / 2), 6);
  const bodyBottom = f.bottom - boardH;
  const bodyTop = f.top;
  const bodyH = Math.max(bodyBottom - bodyTop, MIN_PX);
  const capH = Math.min(bodyH * 0.2, 5);
  const trapTop = bodyTop + capH;
  const bottomHalf = f.w * 0.3;
  const topHalf = f.w * 0.12;
  const capHalf = f.w * 0.15;
  const panel = (side) =>
    line(f.cx + side * bottomHalf * 0.53, bodyBottom, f.cx + side * topHalf * 0.42, trapTop, "o");
  return (
    poly(
      [
        [f.cx - bottomHalf, bodyBottom],
        [f.cx + bottomHalf, bodyBottom],
        [f.cx + topHalf, trapTop],
        [f.cx - topHalf, trapTop],
      ],
      fill(block.kind)
    ) +
    panel(1) +
    panel(-1) +
    rect(f.left, bodyBottom, f.w, boardH, "o k-fixed", { rx: 1 }) +
    rect(f.cx - capHalf, trapTop - capH, capHalf * 2, capH, fill(block.kind), { rx: 1 })
  );
}

/** A side view of one wheel of a wheel mode (SPEC.md 3.2): a pneumatic tire
 * with its hub; an ETW track wheel, grooved to ride round rail; or a tire
 * on a plate over skateboard wheels. */
function wheel(shape, center) {
  const r = shape.tire.radius;
  const tire = circle(center.x, center.y, r, "o tire") + circle(center.x, center.y, r * 0.42, "o hub");
  if (shape.wheels === "etw") {
    return tire + path(`M ${n(center.x - r * 0.35)} ${n(center.y + r)} a ${n(r * 0.35)} ${n(r * 0.25)} 0 0 1 ${n(r * 0.7)} 0`, "o groove");
  }
  if (shape.wheels === "skateboard" && shape.skate) {
    const { radius, plateTop, floor } = shape.skate;
    return (
      tire +
      rect(center.x - r * 1.1, plateTop, r * 2.2, floor - radius * 2 - plateTop, "o k-fixed skate-plate") +
      [-0.6, 0.6].map((dx) => circle(center.x + r * dx, floor - radius, radius, "o skate-wheel")).join("")
    );
  }
  return tire;
}

function beamPolygon(pivot, nose, width, cls) {
  // The beam as a bar of real width from pivot to nose: offset each end by
  // half the width, square to the beam.
  const dx = nose.x - pivot.x;
  const dy = nose.y - pivot.y;
  const len = Math.hypot(dx, dy) || 1;
  const ox = (-dy / len) * (width / 2);
  const oy = (dx / len) * (width / 2);
  return poly(
    [
      [pivot.x + ox, pivot.y + oy],
      [nose.x + ox, nose.y + oy],
      [nose.x - ox, nose.y - oy],
      [pivot.x - ox, pivot.y - oy],
    ],
    cls
  );
}

/** The Fisher 11 side elevation (7.2), simplified from the brochure's
 * dimension drawing: chassis and deck, raised rear box, push posts, a wheel
 * at each end, and the lift beam from its pivot to the nose. */
function dolly(block) {
  const s = block.shape;
  const c = s.chassis;
  const box = s.rearBox;
  const ghosts = s.ghosts.map((g) => beamPolygon(s.pivot, g, s.beam, "beam-ghost")).join("");
  const posts = [0, s.posts.width * 2.2]
    .map((dx) => rect(s.posts.x + dx - s.posts.width / 2, s.posts.top, s.posts.width, s.posts.bottom - s.posts.top, "o k-fixed post"))
    .join("");
  const grip = rect(s.posts.x - s.posts.width, s.posts.top, s.posts.width * 4.4, s.posts.width, "o k-fixed post");
  return (
    ghosts +
    posts +
    grip +
    rect(box.x, box.y, box.width, box.height, "o k-fixed", { rx: 2 }) +
    rect(c.x, c.y, c.width, c.height, "o k-fixed", { rx: 2 }) +
    s.tire.centers.map((center) => wheel(s, center)).join("") +
    beamPolygon(s.pivot, s.nose, s.beam, "o k-moveable beam") +
    circle(s.pivot.x, s.pivot.y, s.beam * 0.7, "o k-fixed") +
    circle(s.nose.x, s.nose.y, s.noseRadius, "o k-fixed")
  );
}

// --- Nose fittings -----------------------------------------------------------

function sle(block) {
  // From the brochure's close-ups, simplified (5.8): a clamp plate on the
  // nose's front face, the base it carries, a leveling cage, and the round
  // diamond plate with the Mitchell — forward of the nose, turned back over
  // it (reversed), or all of it upside down. The layout places every part.
  const { clamp, base, cage, diamond } = block.shape;
  const k = `o k-${block.kind}`;
  const struts = [0.2, 0.5, 0.8]
    .map((at) => line(cage.x + cage.width * at, cage.y, cage.x + cage.width * at, cage.y + cage.height, "o sle-strut"))
    .join("");
  return (
    rect(clamp.x, clamp.y, clamp.width, Math.max(clamp.height, MIN_PX), `${k} sle-clamp`, { rx: 1 }) +
    rect(base.x, base.y, base.width, Math.max(base.height, MIN_PX / 2), "o k-fixed sle-base") +
    rect(cage.x, cage.y, cage.width, Math.max(cage.height, MIN_PX / 2), "o k-fixed sle-cage", { rx: 1 }) +
    struts +
    rect(diamond.x, diamond.y, diamond.width, Math.max(diamond.height, MIN_PX / 2), "o k-fixed sle-diamond", { rx: 2 })
  );
}

function lhe(block) {
  // From the brochure's photo, simplified (5.8): a clamp plate on the
  // nose's front face, and a bent arm running down and forward to a flat
  // ring carrying an upward-facing Mitchell.
  const { clamp, arm, ring } = block.shape;
  const [top, elbow, end] = arm;
  return (
    rect(clamp.x, clamp.y, clamp.width, Math.max(clamp.height, MIN_PX), `o k-${block.kind} lhe-clamp`, { rx: 1 }) +
    path(`M ${n(top.x)} ${n(top.y)} L ${n(elbow.x)} ${n(elbow.y)} L ${n(end.x)} ${n(end.y)}`, "lhe-arm") +
    rect(ring.x, ring.y, ring.width, Math.max(ring.height, MIN_PX / 2), "o k-fixed lhe-ring", { rx: 2 })
  );
}

// --- Adapters ------------------------------------------------------------------

function riser(block) {
  const f = frame(block.box);
  const h = Math.max(f.h, MIN_PX);
  const y = f.bottom - h;
  return (
    rect(f.left, y, f.w, h, `o k-${block.kind} cage`) +
    line(f.left, y, f.right, f.bottom, "o") +
    line(f.right, y, f.left, f.bottom, "o") +
    rect(f.left - 1, y, f.w + 2, 2, "o k-fixed plate") +
    rect(f.left - 1, f.bottom - 2, f.w + 2, 2, "o k-fixed plate")
  );
}

/** From its reference photo, simplified, not traced (SPEC.md 3.6): a
 * plank from the near (support-side) Mitchell mount to the far
 * (camera-side) one, 8" over; an X-braced cage at the far end, inset from
 * and centered under its own flat Mitchell cap. */
function rotatingOffset(block) {
  const f = frame(block.box);
  const h = Math.max(f.h, MIN_PX * 4);
  const top = f.bottom - h;
  const atW = (a, b) => [f.left + f.w * a, f.left + f.w * b];
  const atH = (a, b) => [top + h * a, top + h * b];
  const [footL, footR] = atW(0, 0.525);
  const [boxL, boxR] = atW(0.5, 0.925);
  const [capL, capR] = atW(0.45, 0.975);
  const [capY0, capY1] = atH(0, 0.14);
  const [boxY0, boxY1] = atH(0.12, 0.74);
  const [plankY0, plankY1] = atH(0.74, 0.86);
  const [footY0, footY1] = atH(0.86, 1);
  return (
    rect(footL, footY0, footR - footL, footY1 - footY0, "o k-fixed ro-mount", { rx: 1 }) +
    rect(f.left, plankY0, f.w, plankY1 - plankY0, `${fill(block.kind)} ro-plank`, { rx: 1 }) +
    rect(boxL, boxY0, boxR - boxL, boxY1 - boxY0, `o k-${block.kind || "fixed"} cage`, { "fill-opacity": 0.35 }) +
    line(boxL, boxY0, boxR, boxY1, "o") +
    line(boxR, boxY0, boxL, boxY1, "o") +
    rect(capL, capY0, capR - capL, capY1 - capY0, "o k-fixed ro-mount", { rx: 1 })
  );
}

function offset(block) {
  // A plate with a Mitchell ring at each end, all within its thickness — no
  // stubs: the piece below meets its bottom face, the next piece meets the
  // face in use at the far end, marked.
  const { near, far, plateTop, plateBottom, mitchell, side } = block.shape;
  const thick = Math.max(plateBottom - plateTop, MIN_PX);
  const top = plateBottom - thick;
  const ring = (x) => rect(x - mitchell * 0.8, top + thick * 0.25, mitchell * 1.6, thick * 0.5, "o hole", { rx: thick * 0.25 });
  const faceY = side === "bottom" ? plateBottom - 1.5 : top;
  return (
    rect(near.x - mitchell, top, far.x - near.x + mitchell * 2, thick, fill(block.kind), { rx: Math.min(thick / 2, 4) }) +
    ring(near.x) +
    ring(far.x) +
    rect(far.x - mitchell, faceY, mitchell * 2, 1.5, "in-use")
  );
}

// --- Heads -------------------------------------------------------------------

function fluidHead(block) {
  const f = frame(block.box);
  const h = Math.max(f.h, MIN_PX * 2);
  const top = f.bottom - h;
  // Stacked with no gap, filling the whole rise: the receiver plate on top,
  // the tilt body, the pan base on the Mitchell at the bottom (7.2).
  const inner =
    rect(f.left - f.w * 0.1, top, f.w * 1.2, h * 0.15, "o k-fixed plate") +
    rect(f.left, top + h * 0.15, f.w, h * 0.55, fill(block.kind), { rx: h * 0.1 }) +
    rect(f.left + f.w * 0.2, top + h * 0.7, f.w * 0.6, h * 0.3, "o k-fixed pan");
  return block.shape.inverted ? flipped(block.box, inner) : inner;
}

function lambda(block) {
  // An L-frame in its own color (adjustable): pan base on the mount, base
  // plate forward, column at the rear, the platform cantilevered forward
  // from the column. Underslung it's the same frame flipped; the layout
  // hands over each part's box already placed.
  const { pan, plate, column, platform } = block.shape;
  const part = (b, cls, rx = 1.5) => rect(b.x, b.y, b.width, Math.max(b.height, MIN_PX / 2), cls, { rx });
  const k = `o k-${block.kind}`;
  return (
    part(plate, `${k} lambda-plate`) +
    part(column, `${k} lambda-column`) +
    part(platform, `${k} lambda-platform`) +
    part(pan, "o k-fixed lambda-pan", Math.min(pan.width, pan.height) / 2)
  );
}

// --- Camera --------------------------------------------------------------------

/** A thin plate at its true rise; a zero-rise plate (a QR plate) is a sliver. */
function plateRect(box, cls) {
  const f = frame(box);
  const h = Math.max(f.h, MIN_PX / 2);
  return rect(f.left, f.cy - h / 2, f.w, h, cls, { rx: 1 });
}

/** A plate between the head and the camera block (the Euro plate). */
function plate(block) {
  return plateRect(block.box, `o k-${block.kind} camera-plate`);
}

function camera(block) {
  // The camera block (3.4): each plate at its true rise, the body, and a
  // triangle at the optical center opening forward, the way the camera
  // shoots. Inverted, the body flips (handle underneath) and the plates are
  // above it; the triangle doesn't — it stays on the optical center,
  // pointing forward.
  const { body, cone, opticalCenter, inverted, pieces = [] } = block.shape;
  const b = frame(body);
  const y = opticalCenter.y;
  const handleY = inverted ? b.bottom : b.top;
  const handle = path(
    `M ${n(b.left + b.w * 0.2)} ${n(handleY)} v ${inverted ? 4 : -4} h ${n(b.w * 0.6)} v ${inverted ? -4 : 4}`,
    "o handle"
  );
  const plates = pieces.map((piece) => plateRect(piece.box, "o k-fixed camera-plate")).join("");
  const triangle = poly([[cone.x0, y], [cone.x1, y - cone.half], [cone.x1, y + cone.half]], "lens-cone");
  return plates + rect(b.left, b.top, b.w, b.h, "o k-fixed camera", { rx: 2 }) + handle + triangle;
}

const OUTLINES = {
  apple,
  track,
  spreader,
  tripod,
  "hi-hat": stand,
  "lo-hat": stand,
  dolly,
  sle,
  lhe,
  riser,
  "rotating-offset": rotatingOffset,
  offset,
  "fluid-head": fluidHead,
  lambda,
  plate,
  camera,
};

/** The one outline for a block, by its layout `shape.type`. */
export function outlineOf(block) {
  const draw = OUTLINES[block.shape.type];
  return draw ? draw(block) : rect(block.box.x, block.box.y, block.box.width, block.box.height, fill(block.kind));
}

/** A piece's outline. */
export function pieceSvg(block) {
  return `<g class="piece shape-${block.shape.type}">${outlineOf(block)}</g>`;
}

/**
 * Which piece a tap is on (7.2). Each piece's whole outline is its target,
 * padded to at least 44px (22px around it). Pieces are drawn in chain order,
 * each on top of the piece it mounts on, so a tap inside outlines goes to
 * the topmost one — the SLE over the dolly's nose, a cradled camera over its
 * cradle, a head over the tripod. A tap just outside goes to the nearest
 * outline within the padding. Anywhere else is no piece. `point` is in the
 * drawing's own pixels.
 * @returns {number|null} the index of the block tapped, or null
 */
export function pieceAt(blocks, point) {
  const PAD = 22;
  const edges = (b) => {
    // A sliver (a plate) is drawn at least MIN_PX thick, centered on its box.
    const f = frame(b.box);
    const grow = Math.max(0, (MIN_PX - f.h) / 2);
    return { left: f.left, right: f.right, top: f.top - grow, bottom: f.bottom + grow };
  };
  const distance = (e) =>
    Math.hypot(Math.max(e.left - point.x, 0, point.x - e.right), Math.max(e.top - point.y, 0, point.y - e.bottom));
  let best = null;
  blocks.forEach((b, i) => {
    const d = distance(edges(b));
    if (d > PAD) return;
    // Nearer wins; on a tie (inside several), the one drawn on top — later in the chain.
    if (!best || d < best.d || (d === best.d && i > best.i)) best = { i, d };
  });
  return best ? best.i : null;
}

/** An insertion marker: a visible dot with a 44px hit circle. */
export function markerSvg(point, dataAttrs) {
  return `<g class="marker" ${dataAttrs}>${circle(point.x, point.y, 22, "marker-hit")}${circle(point.x, point.y, 9, "marker-dot")}</g>`;
}

/**
 * A flip button (7.2): a small circular-arrows icon in a disc, with a 44px
 * hit circle. Drawn only where rules.js says the flip is legal.
 */
export function flipButtonSvg(point, dataAttrs) {
  const { x, y } = point;
  const r = 6; // the arrows' radius
  // Two arcs around the centre, each ending in an arrowhead: flip over.
  const arc = (from, to) => `M ${n(x + r * Math.cos(from))} ${n(y + r * Math.sin(from))} A ${r} ${r} 0 0 1 ${n(x + r * Math.cos(to))} ${n(y + r * Math.sin(to))}`;
  const head = (at) => {
    const tip = { x: x + r * Math.cos(at), y: y + r * Math.sin(at) };
    const back = at - 0.9;
    const side = (d) => `${n(tip.x + 3.2 * Math.cos(back + d))} ${n(tip.y + 3.2 * Math.sin(back + d))}`;
    return `M ${side(0.9)} L ${n(tip.x)} ${n(tip.y)} L ${side(-0.9)}`;
  };
  const a1 = -Math.PI * 0.95;
  const b1 = -Math.PI * 0.15;
  const a2 = Math.PI * 0.05;
  const b2 = Math.PI * 0.85;
  return (
    `<g class="flip" ${dataAttrs}>` +
    circle(x, y, 22, "flip-hit") +
    circle(x, y, 12, "flip-disc") +
    path(`${arc(a1, b1)} ${head(b1)} ${arc(a2, b2)} ${head(b2)}`, "flip-arrows") +
    `</g>`
  );
}
