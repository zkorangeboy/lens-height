// Lens Height — the check screen (SPEC.md 7.2).
//
// This file is thin on purpose. It collects input, calls the solver
// (src/solver.js), the compatibility rules (src/rules.js), the verdict
// (src/verdict.js), and the stack layout (src/stack.js), and draws what they
// return. There is no height math and no compatibility logic here: margins,
// shortfalls, positions, pixel boxes, and label placement come back ready to
// draw, what may be added, swapped, or toggled comes from rules.js, and every
// number is written by src/format.js (¼″ fractions). There is no arithmetic
// here at all.
//
// Solve mode and delta search are frozen and not shown (SPEC.md 5): nothing
// here calls them.

import { buildChain, evaluateChain, normalizeTarget, exceedsBaseLayerCap, DEFAULT_MAX_BASE_LAYER_ITEMS } from "./src/solver.js";
import {
  addOptions,
  applyEdit,
  baseModeAt,
  blockOptions,
  cameraRemedies,
  defaultPicks,
  missingSlot,
  flip,
  flips,
  modeControl,
  revalidatePicks,
  sheetModes,
  slotOptions,
  supportRemoval,
  swapOptions,
} from "./src/rules.js";
import { checkVerdict } from "./src/verdict.js";
import { inches, signedInches as fmtSigned } from "./src/format.js";
import { stackLayout } from "./src/stack.js";
import { flipButtonSvg, markerSvg, pieceAt, pieceSvg } from "./src/outlines.js";
import { versionNote } from "./src/version.js";

document.getElementById("version").textContent = versionNote();

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let gear = null;

const state = {
  packageId: null,
  buildId: null,
  picks: null, // always revalidated
  notes: [], // plain-language "why did that change" messages
  target: { type: "fixed", height: "", low: "", high: "" },
  sheet: null, // what the open sheet is about: {slot, id} for a piece, {add: true} for the Add sheet
  placing: null, // an item chosen in the Add sheet, waiting for a tap on one of its markers
  layout: null, // the drawing's layout, to find which piece a tap is on
};

const el = {
  loading: document.getElementById("loading"),
  app: document.getElementById("app"),
  verdict: document.getElementById("verdict"),
  notes: document.getElementById("notes"),
  notesList: document.getElementById("notes-list"),
  rig: document.getElementById("rig"),
  footer: document.getElementById("rig-footer"),
  addButton: document.getElementById("add-button"),
  placingHint: document.getElementById("placing-hint"),
  sheet: document.getElementById("sheet"),

  targetFixedBtn: document.getElementById("target-fixed"),
  targetRangeBtn: document.getElementById("target-range"),
  fixedFields: document.getElementById("fixed-target-fields"),
  rangeFields: document.getElementById("range-target-fields"),
  targetHeight: document.getElementById("target-height"),
  targetLow: document.getElementById("target-low"),
  targetHigh: document.getElementById("target-high"),
};

// ---------------------------------------------------------------------------
// Formatting (every number arrives computed; src/format.js writes it)
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
const pos = (o) => `bottom:${o.bottomPct}%;height:${o.heightPct}%`;
const ICONS = { feasible: "✓", infeasible: "✗", waiting: "…" };

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

init();

async function init() {
  gear = await (await fetch("./gear.json")).json();
  state.packageId = gear.packages[0].id;
  state.buildId = gear.builds[0].id;
  state.picks = defaultPicks(gear, state.packageId, state.buildId);

  wireTarget();
  wireEdits();
  applyTargetTypeVisibility();

  el.loading.hidden = true;
  el.app.hidden = false;
  render();
}

// ---------------------------------------------------------------------------
// Target input
// ---------------------------------------------------------------------------

function wireTarget() {
  el.targetFixedBtn.addEventListener("click", () => setTargetType("fixed"));
  el.targetRangeBtn.addEventListener("click", () => setTargetType("range"));
  for (const [input, key] of [
    [el.targetHeight, "height"],
    [el.targetLow, "low"],
    [el.targetHigh, "high"],
  ]) {
    input.addEventListener("input", () => {
      state.target[key] = input.value;
      render();
    });
  }
}

function setTargetType(type) {
  state.target.type = type;
  applyTargetTypeVisibility();
  render();
}

function applyTargetTypeVisibility() {
  const isFixed = state.target.type === "fixed";
  el.targetFixedBtn.classList.toggle("is-active", isFixed);
  el.targetFixedBtn.setAttribute("aria-pressed", String(isFixed));
  el.targetRangeBtn.classList.toggle("is-active", !isFixed);
  el.targetRangeBtn.setAttribute("aria-pressed", String(!isFixed));
  el.fixedFields.hidden = !isFixed;
  el.rangeFields.hidden = isFixed;
}

// ---------------------------------------------------------------------------
// Editing: every change is an edit rules.js understands, then revalidated
// ---------------------------------------------------------------------------

function edit(change) {
  commit(applyEdit(state.picks, change));
}

function commit(next) {
  const { picks, notes } = revalidatePicks(gear, state.packageId, state.buildId, next);
  state.picks = picks;
  state.notes = notes;
  render();
}

function wireEdits() {
  document.addEventListener("click", (event) => {
    // Placing an item: a marker inserts it; a tap anywhere else cancels.
    if (state.placing) {
      const marker = event.target.closest("[data-place]");
      state.placing = null;
      if (marker) edit(JSON.parse(marker.dataset.place));
      else render();
      return;
    }
    const t = event.target.closest("[data-piece],[data-drawing],[data-add],[data-place-item],[data-edit],[data-flip],[data-build],[data-close],[data-dismiss-notes]");
    if (!t) return;
    if (t.dataset.drawing !== undefined) {
      // A tap on the drawing: src/outlines.js says which piece it's on, from
      // the tap in the drawing's own coordinates (the SVG's transform).
      const svg = t.ownerSVGElement;
      const at = Object.assign(svg.createSVGPoint(), { x: event.clientX, y: event.clientY }).matrixTransform(svg.getScreenCTM().inverse());
      const hit = pieceAt(state.layout.blocks, at);
      if (hit !== null) {
        const [slot, id, at] = pieceKey(state.layout.blocks[hit]).split("|");
        openSheet({ slot, id, at: Number(at) });
      }
    } else if (t.dataset.piece) {
      const [slot, id, at] = t.dataset.piece.split("|");
      openSheet({ slot, id, at: Number(at) });
    } else if (t.dataset.add !== undefined) {
      openSheet({ add: true });
    } else if (t.dataset.placeItem) {
      // An item with several legal attach points: show them on the drawing.
      const item = addOptions(gear, state.packageId, state.buildId, state.picks).find((o) => o.id === t.dataset.placeItem);
      closeSheet();
      state.placing = item;
      render();
    } else if (t.dataset.edit) {
      const change = JSON.parse(t.dataset.edit);
      // A mode or a camera block edit keeps its sheet open, to strip a block piece by piece.
      if (change.op !== "mode" && change.op !== "block") closeSheet();
      edit(change);
    } else if (t.dataset.flip) {
      // One tap flips it, with everything that depends on it; no message (7.2).
      const flipped = flip(gear, state.packageId, state.buildId, state.picks, JSON.parse(t.dataset.flip));
      if (flipped) {
        state.picks = flipped;
        state.notes = [];
        render();
      }
    } else if (t.dataset.build) {
      state.buildId = t.dataset.build;
      closeSheet();
      commit(state.picks);
    } else if (t.dataset.close !== undefined) {
      closeSheet();
    } else if (t.dataset.dismissNotes !== undefined) {
      state.notes = [];
      renderNotes();
    }
  });

  // Tap outside the sheet to close it.
  el.sheet.addEventListener("click", (event) => {
    if (event.target === el.sheet) closeSheet();
  });
  el.sheet.addEventListener("close", () => {
    state.sheet = null;
  });
}

function openSheet(what) {
  state.sheet = what;
  renderSheet();
  if (!el.sheet.open) el.sheet.showModal();
}

function closeSheet() {
  state.sheet = null;
  if (el.sheet.open) el.sheet.close();
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function render() {
  const p = state.picks;
  const target = normalizeTarget(state.target);
  renderNotes();

  const missing = missingSlot(gear, state.packageId, state.buildId, p);
  if (missing) {
    renderIncomplete(missing);
    return;
  }

  const chain = buildChain(gear, { packageId: state.packageId, buildId: state.buildId, ...p });
  const evaluation = target ? evaluateChain(chain, target) : null;
  const verdict = checkVerdict(chain, target, evaluation);

  // Draw once to measure the drawing area, then lay out at that size.
  el.rig.dataset.state = verdict.state;
  el.rig.innerHTML = drawingHtml(stackLayout(chain, target));
  const area = el.rig.querySelector(".drawing");
  // The full drawing height from styles.css; the layout may use less (a wide rig).
  const tallest = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--plot-height"));
  const frame = { width: area.clientWidth, height: tallest };
  state.layout = stackLayout(chain, target, { frame });
  el.rig.innerHTML = drawingHtml(state.layout, state.placing);
  el.placingHint.hidden = !state.placing;
  if (state.placing) el.placingHint.textContent = `Add ${state.placing.name}: tap a point`;

  setVerdict(verdict.state, verdict.text);
  el.footer.innerHTML = footerHtml(stackLayout(chain, target), chain);
  el.addButton.hidden = addOptions(gear, state.packageId, state.buildId, p).length === 0;

  if (state.sheet) renderSheet();
}

function setVerdict(stateName, text) {
  el.verdict.dataset.state = stateName;
  el.verdict.innerHTML = `<span class="verdict-icon" aria-hidden="true">${ICONS[stateName]}</span><span>${escapeHtml(text)}</span>`;
}

function renderNotes() {
  el.notes.hidden = state.notes.length === 0;
  el.notesList.innerHTML = state.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("");
}

/** A rig with an empty required slot: offer what fits there. When the camera
 * block fits nothing below it, say why and offer what would make it fit (rules.js). */
function renderIncomplete(missing) {
  const opts = slotOptions(gear, state.packageId, state.buildId, state.picks);
  const words = { support: "Choose a support", nose: "Choose a nose fitting", head: "Choose a head", attach: "The camera doesn't fit" };
  setVerdict("waiting", words[missing]);
  el.rig.dataset.state = "waiting";
  el.footer.innerHTML = "";
  el.addButton.hidden = true;
  el.placingHint.hidden = true;
  if (missing === "attach") {
    const remedies = cameraRemedies(gear, state.packageId, state.buildId, state.picks);
    el.rig.innerHTML = `<div class="empty-slot">${
      remedies.length ? `<h3>Add</h3><div class="option-list">${remedies.map((r) => optionButton(editAttr(r.edit), r.label, null)).join("")}</div>` : ""
    }</div>`;
    return;
  }
  const choices = opts[missing].filter((o) => o.available);
  el.rig.innerHTML = `<div class="empty-slot">${
    choices.length
      ? `<div class="option-list">${choices.map((o) => optionButton(editAttr({ op: "swap", slot: missing, id: o.id }), o.name, null)).join("")}</div>`
      : ""
  }</div>`;
}

// --- The drawing (SPEC.md 5.8, 7.2) ------------------------------------------

function drawingHtml(layout, placing = null) {
  const blocks = layout.blocks;
  const { width, height } = layout.frame;

  // Outlines (src/outlines.js); nothing in the drawing is labeled (7.2). A
  // tap anywhere on the drawing is resolved to a piece by pieceAt.
  const pieces = blocks.map((b) => pieceSvg(b)).join("");

  // Flip buttons: beside each piece rules.js says can flip right now, at the
  // point the layout gives it. None while an item is being placed.
  const flipButtons = placing
    ? ""
    : flips(gear, state.packageId, state.buildId, state.picks)
        .map((piece) => {
          const b = blocks.find((x) => x.slot === piece.slot && x.index === piece.index);
          return b ? flipButtonSvg(b.flipAt, `data-flip="${escapeHtml(JSON.stringify(piece))}" role="button" aria-label="Flip ${escapeHtml(b.name)}"`) : "";
        })
        .join("");

  // Placing an item: its legal attach points, as markers (positions from the
  // layout, legality from rules.js via addOptions).
  const markers = placing
    ? placing.positions
        .map((at) => {
          const gap = layout.gaps.find((g) => g.slot === at.slot && g.index === at.index);
          const insert = { op: "insert", slot: at.slot, index: at.index, id: placing.id, mode: at.mode };
          return gap ? markerSvg(gap.point, `data-place="${escapeHtml(JSON.stringify(insert))}" role="button" aria-label="Add ${escapeHtml(placing.name)} ${escapeHtml(at.where)}"`) : "";
        })
        .join("")
    : "";

  const target = layout.target
    ? `<div class="target-mark${layout.target.isRange ? " is-range" : ""}" style="${pos(layout.target)}"></div>`
    : "";

  // The reach rail, labeled with the lowest and highest lens heights, and
  // marked where it runs past the drawing.
  const reach = layout.reach;
  const rail = `<div class="rail" aria-hidden="true">
      <div class="band band-reach${reach.continuesAbove ? " continues-above" : ""}${reach.continuesBelow ? " continues-below" : ""}" style="${pos(reach)}"></div>
      ${layout.moveable ? `<div class="band band-moveable" style="${pos(layout.moveable)}"></div>` : ""}
    </div>
    <span class="rail-label rail-top" style="bottom:${reach.topPct}%">${reach.continuesAbove ? "↑ " : ""}${inches(reach.max)}</span>
    <span class="rail-label rail-bottom" style="bottom:${reach.bottomPct}%">${reach.continuesBelow ? "↓ " : ""}${inches(reach.min)}</span>`;

  return `<div class="plot${placing ? " is-placing" : ""}" style="height:${height}px" aria-label="Lens reaches ${inches(reach.min)} to ${inches(reach.max)}">
    ${rail}
    <div class="floor" style="bottom:${layout.floor.pct}%"></div>
    ${target}
    <svg class="drawing" viewBox="0 0 ${width} ${height}" aria-hidden="false">
      ${PATTERNS}
      <g class="pieces">${pieces}</g>
      <rect class="tap-surface" data-drawing x="0" y="0" width="${width}" height="${height}"/>
      <g class="flips">${flipButtons}</g>
      <g class="markers">${markers}</g>
    </svg>
  </div>`;
}

/** Fills for the three kinds (3.5): adjustable dotted, moveable striped. */
const PATTERNS = `<defs>
  <pattern id="fill-moveable" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="8" height="8" class="pat-moveable-bg"/><rect width="4" height="8" class="pat-moveable"/>
  </pattern>
  <pattern id="fill-adjustable" width="6" height="6" patternUnits="userSpaceOnUse">
    <rect width="6" height="6" class="pat-adjustable-bg"/><circle cx="3" cy="3" r="1.1" class="pat-adjustable"/>
  </pattern>
</defs>`;

// Which piece: its slot, id, and position (the same apple box can appear twice).
const pieceKey = (block) => `${block.slot}|${block.component.id}|${block.index}`;


function footerHtml(layout, chain) {
  const key = ["moveable", "adjustable", "fixed"]
    .map((kind) => `<span class="key"><i class="swatch kind-${kind}"></i>${kind[0].toUpperCase()}${kind.slice(1)}</span>`)
    .join("");
  const cap = exceedsBaseLayerCap(chain)
    ? `<span class="key key-warning">${chain.baseItems.length} base items, over the ${DEFAULT_MAX_BASE_LAYER_ITEMS}-item stacking cap</span>`
    : "";
  // The drawing's one warning, from the layout (an inverted camera).
  const flip = layout.warning ? `<span class="key key-warning">${escapeHtml(layout.warning)}</span>` : "";
  return flip + key + cap;
}

// --- The sheets: change one piece, or add one ----------------------------------

function optionButton(attrs, label, rise) {
  return `<button type="button" class="option" ${attrs}>
    <span>${escapeHtml(label)}</span>${rise == null ? "" : `<span class="option-rise">${fmtSigned(rise)}</span>`}
  </button>`;
}
const editAttr = (change) => `data-edit="${escapeHtml(JSON.stringify(change))}"`;

/** Only what fits, as buttons under a heading; nothing at all when nothing
 * fits (SPEC.md 7.2: no list of what doesn't, no explanation). */
function optionsHtml(title, options, toChange) {
  const fits = options.filter((o) => o.available);
  return fits.length
    ? `<h3>${escapeHtml(title)}</h3><div class="option-list">${fits.map((o) => optionButton(editAttr(toChange(o)), o.label, o.rise)).join("")}</div>`
    : "";
}

/** Nothing, text, or a segmented choice — rules.js's modeControl decides
 * which, from the modes a sheet may offer (never which way up a piece hangs: that's a
 * flip on the drawing, 7.2). Its hint is left out: no explanation text. */
function modeHtml(control, change, current) {
  const choices = control.type === "toggle" ? [control.off, control.on] : control.entries;
  if (choices) {
    return `<div class="choice" role="radiogroup">${choices
      .map(
        (e) => `<button type="button" class="choice-btn" role="radio" aria-checked="${e.name === current}" ${editAttr({ ...change, mode: e.name })}>${escapeHtml(e.label)}</button>`
      )
      .join("")}</div>`;
  }
  if (control.type === "static" && control.entry.label) return `<p class="mode-static">${escapeHtml(control.entry.label)}</p>`;
  return "";
}

function renderSheet() {
  const html = state.sheet.add ? addSheetHtml() : pieceSheetHtml(state.sheet);
  if (html == null) {
    closeSheet();
    return;
  }
  el.sheet.innerHTML = `<div class="sheet-body">${html}<button type="button" class="sheet-done" data-close>Done</button></div>`;
}

function pieceSheetHtml({ slot, id, at }) {
  const p = state.picks;
  const ids = { base: p.baseItemIds, adapter: p.adapterIds, plate: p.plateIds }[slot] || null;
  // The same position if it still holds this piece, else wherever it moved.
  const index = !ids ? 0 : ids[at] === id ? at : ids.indexOf(id);
  if (index < 0) return null; // it was removed
  const opts = slotOptions(gear, state.packageId, state.buildId, p);
  const chain = buildChain(gear, { packageId: state.packageId, buildId: state.buildId, ...p });
  const block = stackLayout(chain, normalizeTarget(state.target)).blocks.find((b) => b.slot === slot && b.index === index);
  if (!block) return null;

  const range = block.range ? ` · adjusts ${inches(block.range.min)} to ${inches(block.range.max)}` : "";
  const head = `<h2>${escapeHtml(block.name)}</h2>
    <p class="sheet-sub">${fmtSigned(block.rise)} at this setup${range}</p>`;

  if (slot === "build") return blockSheetHtml(head);

  // A full apple's face, a wheel set, the SLE's upright or reversed position.
  // Which way up (a head's mode, an offset's side, the SLE upside down) is a
  // flip on the drawing, never here (7.2); a plate has no modes.
  let mode = "";
  const list = { base: opts.base, adapter: opts.adapters, support: opts.support, nose: opts.nose }[slot];
  const entry = list && list.find((o) => o.id === id);
  if (entry) {
    const current = { base: baseModeAt(p, index), adapter: p.adapterModes[id], support: p.supportMode, nose: p.noseMode }[slot];
    const modes = sheetModes(entry.modes, current);
    if (modes.length > 1) {
      const title = { base: "Face", support: "Wheels" }[slot] || "Position";
      mode = `<h3>${title}</h3>${modeHtml(modeControl(modes), { op: "mode", slot, index }, current)}`;
    }
  }

  const swap = optionsHtml("Swap for", swapOptions(gear, state.packageId, state.buildId, p, slot, index), (o) => ({ op: "swap", slot, index, id: o.id, mode: o.mode }));
  const removal = slot === "support" ? supportRemoval(gear, state.packageId, state.buildId, p) : null;
  const remove =
    slot === "base" || slot === "adapter" || slot === "plate"
      ? `<button type="button" class="remove" ${editAttr({ op: "remove", slot, index })}>Remove ${escapeHtml(block.name)}</button>`
      : removal
        ? `<button type="button" class="remove" ${editAttr(removal.edit)}>${escapeHtml(removal.label)}</button>`
        : "";
  return `${head}${mode}${swap}${remove}`;
}

/** The camera block's sheet (3.4): its pieces and rises, the edits that fit
 * (strip the bottom piece, put one back, add a Euro plate), and its mount. */
function blockSheetHtml(head) {
  const block = blockOptions(gear, state.packageId, state.buildId, state.picks);
  const pieces = `<ul class="block-pieces">${block.pieces
    .map((piece) => `<li><span>${escapeHtml(piece.name)}</span><span class="option-rise">${piece.camera ? `lens ${fmtSigned(piece.rise)}` : fmtSigned(piece.rise)}</span></li>`)
    .join("")}</ul>`;
  const edits = [block.strip, block.restore, ...block.add].filter(Boolean);
  const editList = edits.length ? `<div class="option-list">${edits.map((e) => optionButton(editAttr(e.edit), e.label, null)).join("")}</div>` : "";
  const builds =
    gear.builds.length > 1
      ? `<h3>Camera block</h3><div class="option-list">${gear.builds
          .filter((b) => b.id !== state.buildId)
          .map((b) => optionButton(`data-build="${escapeHtml(b.id)}"`, b.name, null))
          .join("")}</div>`
      : "";
  // Its mount follows what it hangs from: nothing to choose (3.4).
  return `${head}<h3>Pieces, top to bottom</h3>${pieces}${editList}${builds}`;
}

/** The Add sheet: everything that fits; an item with several positions
 * asks which. */
/** The Add sheet: everything that fits. An item with one legal attach point
 * goes straight there; one with several shows its points on the drawing. */
function addSheetHtml() {
  const options = addOptions(gear, state.packageId, state.buildId, state.picks);
  if (!options.length) return `<h2>Add</h2>`;
  const item = (o) => {
    const [only] = o.positions;
    const attrs =
      o.positions.length === 1
        ? editAttr({ op: "insert", slot: only.slot, index: only.index, id: o.id, mode: only.mode })
        : `data-place-item="${escapeHtml(o.id)}"`;
    return optionButton(attrs, o.label, o.rise);
  };
  const group = (title, category) => {
    const list = options.filter((o) => o.component.category === category);
    return list.length ? `<h3>${title}</h3><div class="option-list">${list.map(item).join("")}</div>` : "";
  };
  return `<h2>Add to the rig</h2>${group("Support", "support")}${group(state.picks.supportId ? "Under the support" : "Under the camera", "base")}${group("Between support and head", "adapter")}${group(state.picks.headId ? "Between head and camera" : "Plates", "plate")}`;
}
