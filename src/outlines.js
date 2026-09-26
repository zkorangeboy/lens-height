// Schematic outlines for the drawing (SPEC.md 7.2): one per kind of gear.
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
  // Side on: a rail along the top, ties under it.
  const f = frame(block.box);
  const h = Math.max(f.h, MIN_PX);
  const rail = block.shape.profile === "round" ? { rx: h * 0.35 } : {};
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
  const { mount, topWidth } = block.shape;
  const bowl = rect(mount.x - topWidth / 2, f.top, topWidth, Math.min(f.h * 0.06, 10), "o k-fixed");
  const legs = [
    [mount.x - topWidth / 2, f.left],
    [mount.x, mount.x],
    [mount.x + topWidth / 2, f.right],
  ]
    .map(([fromX, toX]) => line(fromX, f.top, toX, f.bottom, `leg k-${block.kind}`))
    .join("");
  const spreader = line(f.left + f.w * 0.12, f.bottom - f.h * 0.08, f.right - f.w * 0.12, f.bottom - f.h * 0.08, "o spreader");
  return legs + spreader + bowl;
}

function stand(block) {
  const f = frame(block.box);
  const stem = Math.max(f.w * 0.18, 4);
  const foot = Math.min(f.h * 0.25, 10);
  return (
    poly([[f.left, f.bottom], [f.right, f.bottom], [f.cx + stem, f.bottom - foot], [f.cx - stem, f.bottom - foot]], fill(block.kind)) +
    rect(f.cx - stem / 2, f.top, stem, f.h - foot, fill(block.kind)) +
    rect(f.cx - stem, f.top, stem * 2, Math.min(4, f.h), "o k-fixed")
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
  // The leveling head under its Mitchell plate, with a neck up to the nose
  // when the plate is set below it. What mounts on the plate sits above.
  const f = frame(block.box);
  const { plate, nose } = block.shape;
  const neck = plate > nose ? rect(f.cx - 3, nose, 6, plate - nose, fill(block.kind)) : "";
  return neck + rect(f.left, plate, f.w, f.bottom - plate, fill(block.kind), { rx: 2 }) + rect(f.left - 2, plate - 2, f.w + 4, 3, "o k-fixed plate");
}

function lhe(block) {
  // A bracket hanging from the nose: an arm running down and forward, then
  // a short foot carrying the Mitchell ring (the brochure's LHE, simplified).
  const { nose, foot, thickness, mitchell } = block.shape;
  const t = Math.max(thickness, 3);
  const elbow = nose.x + (foot.x - nose.x) * 0.45;
  return (
    path(
      [
        `M ${n(nose.x - t)} ${n(nose.y)}`,
        `L ${n(nose.x + t)} ${n(nose.y)}`,
        `L ${n(elbow + t)} ${n(foot.y)}`,
        `L ${n(foot.x + mitchell)} ${n(foot.y)}`,
        `L ${n(foot.x + mitchell)} ${n(foot.y + t)}`,
        `L ${n(elbow - t)} ${n(foot.y + t)}`,
        "Z",
      ].join(" "),
      fill(block.kind)
    ) + rect(foot.x - mitchell, foot.y - 2, mitchell * 2, 2, "o k-fixed plate")
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

function swivel(block) {
  const f = frame(block.box);
  return rect(f.left, f.top, f.w, Math.max(f.h, MIN_PX), fill(block.kind), { rx: 3 }) + circle(f.cx, f.cy, Math.min(f.w, f.h) * 0.3, "o hub");
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
  const inner =
    rect(f.left + f.w * 0.2, f.bottom - h * 0.3, f.w * 0.6, h * 0.3, "o k-fixed pan") +
    rect(f.left, top + h * 0.2, f.w, h * 0.5, fill(block.kind), { rx: h * 0.15 }) +
    rect(f.left - f.w * 0.1, top, f.w * 1.2, h * 0.15, "o k-fixed plate");
  return block.shape.inverted ? flipped(block.box, inner) : inner;
}

function lambda(block) {
  const f = frame(block.box);
  const { mount, bracket } = block.shape;
  const arm = Math.max(f.w * 0.14, 3);
  return (
    rect(mount.x - arm, Math.min(mount.y, bracket.y), arm * 2, Math.abs(bracket.y - mount.y), `o k-${block.kind} cradle`) +
    rect(f.left, bracket.y, f.w, arm, "o k-fixed plate") +
    rect(f.right - arm, bracket.y - Math.abs(bracket.y - mount.y) * 0.5, arm, Math.abs(bracket.y - mount.y) * 0.5, `o k-${block.kind} cradle`) +
    rect(mount.x - arm * 1.5, mount.y - arm, arm * 3, arm, "o k-fixed mitchell")
  );
}

// --- Camera --------------------------------------------------------------------

function camera(block) {
  // One outline, body and lens together, the lens dot at the optical center.
  // Inverted, the handle is underneath; hung from the handle, it's on top.
  const { body, lens, opticalCenter, inverted } = block.shape;
  const b = frame(body);
  const y = opticalCenter.y;
  const outline = [
    `M ${n(b.left)} ${n(b.top)}`,
    `H ${n(b.right)}`,
    `V ${n(y - lens.half)}`,
    `H ${n(lens.x1)}`,
    `V ${n(y + lens.half)}`,
    `H ${n(b.right)}`,
    `V ${n(b.bottom)}`,
    `H ${n(b.left)}`,
    "Z",
  ].join(" ");
  const handleY = inverted ? b.bottom : b.top;
  const handle = path(
    `M ${n(b.left + b.w * 0.2)} ${n(handleY)} v ${inverted ? 4 : -4} h ${n(b.w * 0.6)} v ${inverted ? -4 : 4}`,
    "o handle"
  );
  return path(outline, "o k-fixed camera") + handle + line(b.right, y - lens.half, b.right, y + lens.half, "o") + circle(opticalCenter.x, opticalCenter.y, 3.5, "lens-dot");
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
  swivel,
  offset,
  "fluid-head": fluidHead,
  lambda,
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
 * A piece's tag (7.2): its short name in a small box beside it, placed by
 * the layout; an inverted camera's tag has a second, warning line.
 * `dataAttrs` identifies the piece, so the tag opens its sheet too.
 */
export function tagSvg(tag, dataAttrs, escape) {
  const lines = tag.lines
    .map((text, i) => `<text x="${n(tag.x + 5)}" y="${n(tag.y + 3 + 10 + i * 13)}" class="${i > 0 ? "tag-flag" : "tag-name"}">${escape(text)}</text>`)
    .join("");
  return `<g class="tag${tag.warn ? " is-warn" : ""}" ${dataAttrs}>${rect(tag.x, tag.y, tag.width, tag.height, "tag-box", { rx: 4 })}${lines}</g>`;
}
