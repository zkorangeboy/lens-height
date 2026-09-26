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
  const f = frame(block.box);
  const h = Math.max(f.h, MIN_PX);
  const rail = block.shape.profile === "round" ? { rx: h * 0.3 } : {};
  return (
    rect(f.left, f.bottom - h * 0.4, f.w, h * 0.4, "o k-fixed tie") +
    rect(f.left + f.w * 0.04, f.bottom - h, f.w * 0.92, h * 0.6, fill(block.kind), rail)
  );
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

function wheels(shape, chassis) {
  // Two wheels always fit side by side under the chassis, however narrow.
  const r = Math.min(shape.wheelRadius, chassis.width / 5);
  const y = chassis.y + chassis.height - r;
  const at = [chassis.x + r * 1.6, chassis.x + chassis.width - r * 1.6];
  return at
    .map((x) => {
      if (shape.wheels === "pneumatic") return circle(x, y, r, "o tire") + circle(x, y, r * 0.45, "o hub");
      if (shape.wheels === "etw") return circle(x, y, r, "o track-wheel") + circle(x, y, r * 1.35, "o flange");
      return circle(x, y, r, "o skate-wheel");
    })
    .join("");
}

function dolly(block) {
  const { shape } = block;
  const c = shape.chassis;
  const ghosts = shape.ghosts.map((g) => line(shape.pivot.x, shape.pivot.y, g.x, g.y, "beam-ghost")).join("");
  return (
    ghosts +
    rect(c.x, c.y, c.width, Math.max(c.height, MIN_PX), "o k-fixed", { rx: 3 }) +
    wheels(shape, c) +
    line(shape.pivot.x, shape.pivot.y, shape.nose.x, shape.nose.y, "beam k-moveable") +
    circle(shape.pivot.x, shape.pivot.y, shape.noseRadius * 0.6, "o k-fixed") +
    circle(shape.nose.x, shape.nose.y, shape.noseRadius, "o k-fixed")
  );
}

// --- Nose fittings -----------------------------------------------------------

function sle(block) {
  const f = frame(block.box);
  // The leveling head hangs from the nose (the box top) with the Mitchell
  // plate at its foot; set all the way up, it's a sliver under the plate.
  const plate = block.shape.plate;
  return rect(f.left, f.top, f.w, Math.max(f.h, 8), fill(block.kind), { rx: 2 }) + rect(f.left - 2, plate - 2, f.w + 4, 3, "o k-fixed plate");
}

function lhe(block) {
  const { nose, foot, arm } = block.shape;
  const t = Math.max(arm, 4);
  return (
    rect(nose.x - t / 2, Math.min(nose.y, foot.y), t, Math.abs(foot.y - nose.y), fill(block.kind)) +
    rect(nose.x - t / 2, foot.y - t / 2, foot.x - nose.x + t, t, fill(block.kind)) +
    rect(foot.x - t, foot.y - t, t * 2, t / 2, "o k-fixed plate")
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
  const { near, far, plateTop, plateBottom, mitchell, side } = block.shape;
  const thick = Math.max(plateBottom - plateTop, MIN_PX);
  const stub = Math.max(mitchell, 4);
  const plate = rect(near.x - stub, plateBottom - thick, far.x - near.x + stub * 2, thick, fill(block.kind), { rx: 2 });
  const below = (x, cls) => rect(x - stub / 2, plateBottom, stub, stub * 0.6, cls);
  const above = (x, cls) => rect(x - stub / 2, plateBottom - thick - stub * 0.6, stub, stub * 0.6, cls);
  return (
    plate +
    below(near.x, "o k-fixed mitchell") +
    (side === "bottom" ? below(far.x, "o k-fixed mitchell in-use") + above(far.x, "o mitchell spare") : above(far.x, "o k-fixed mitchell in-use") + below(far.x, "o mitchell spare"))
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
  const { body, lens, barrel, inverted, handle } = block.shape;
  const h = Math.max(body.height, 10);
  const top = handle || inverted ? body.y : body.y + body.height - h;
  const bodyRect = rect(body.x, top, body.width, h, "o k-fixed body", { rx: 3 });
  const lensHeight = Math.min(h * 0.6, 18);
  const barrelRect = rect(body.x + body.width, lens.y - lensHeight / 2, barrel, lensHeight, "o k-fixed lens", { rx: 2 });
  const handleY = inverted ? top + h : top;
  const handleMark = path(
    `M ${n(body.x + body.width * 0.2)} ${n(handleY)} v ${inverted ? 4 : -4} h ${n(body.width * 0.6)} v ${inverted ? -4 : 4}`,
    "o handle"
  );
  return bodyRect + handleMark + barrelRect + circle(lens.x, lens.y, 4, "lens-dot");
}

const OUTLINES = {
  apple,
  track,
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

/** A tap target covering the whole outline, at least 44px each way. */
export function hitArea(block) {
  const f = frame(block.box);
  const w = Math.max(f.w, 44);
  const h = Math.max(f.h, 44);
  return rect(f.cx - w / 2, f.cy - h / 2, w, h, "hit-area");
}

/** A piece's outline. */
export function pieceSvg(block) {
  return `<g class="piece shape-${block.shape.type}">${outlineOf(block)}</g>`;
}

/**
 * The tap targets, one per piece, each covering its whole outline (at least
 * 44px each way). Pieces that share a mount overlap — an SLE under an offset
 * plate, a head on a tripod — so the targets are stacked largest first: a
 * small piece on a big one stays tappable, and the big one is tappable
 * everywhere else. `attrsOf(block)` is the markup that identifies a piece to
 * the UI (for example `data-piece="…"`).
 */
export function hitLayer(blocks, attrsOf) {
  const area = (b) => Math.max(b.box.width, 44) * Math.max(b.box.height, 44);
  return [...blocks]
    .sort((a, b) => area(b) - area(a))
    .map((b) => `<g class="piece-hit" ${attrsOf(b)}>${hitArea(b)}</g>`)
    .join("");
}

/** An insertion marker: a visible dot with a 44px hit circle. */
export function markerSvg(point, dataAttrs) {
  return `<g class="marker" ${dataAttrs}>${circle(point.x, point.y, 22, "marker-hit")}${circle(point.x, point.y, 9, "marker-dot")}</g>`;
}

/** The thin leader from a piece to its label, at the piece's anchor height. */
export function leaderSvg(block, toX) {
  return line(block.box.x + block.box.width, block.anchorY, toX, block.anchorY, "leader");
}
