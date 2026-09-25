// Lens Height — the check screen (SPEC.md 7.2).
//
// This file is thin on purpose. It collects input, calls the solver
// (src/solver.js), the compatibility rules (src/rules.js), the verdict
// (src/verdict.js), and the stack layout (src/stack.js), and draws what they
// return. There is no height math and no compatibility logic here: margins,
// shortfalls, positions, columns, and label placement come back ready to
// draw, and what may be added, swapped, or toggled comes from rules.js. The
// only arithmetic is formatting a number for display.
//
// Solve mode and delta search are frozen and not shown (SPEC.md 5): nothing
// here calls them.

import { buildChain, evaluateChain, normalizeTarget, exceedsBaseLayerCap, DEFAULT_MAX_BASE_LAYER_ITEMS } from "./src/solver.js";
import { addOptions, applyEdit, defaultPicks, modeControl, revalidatePicks, slotOptions, swapOptions } from "./src/rules.js";
import { checkVerdict, inches } from "./src/verdict.js";
import { stackLayout } from "./src/stack.js";

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
  sheet: null, // what the open sheet is about: {slot, id} for a piece, {add: true} or {add: id} for the Add sheet
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
  sheet: document.getElementById("sheet"),

  targetFixedBtn: document.getElementById("target-fixed"),
  targetRangeBtn: document.getElementById("target-range"),
  fixedFields: document.getElementById("fixed-target-fields"),
  rangeFields: document.getElementById("range-target-fields"),
  rangeHint: document.getElementById("range-hint"),
  targetHeight: document.getElementById("target-height"),
  targetLow: document.getElementById("target-low"),
  targetHigh: document.getElementById("target-high"),
};

// ---------------------------------------------------------------------------
// Formatting (presentation only — every number arrives already computed)
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
const SIGNED = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, signDisplay: "exceptZero" });
const fmtSigned = (n) => `${SIGNED.format(n).replace("-", "−")}″`;
const dot = (estimated) => (estimated ? '<span class="dot" title="Estimated measurement" aria-label="estimated"></span>' : "");
const isEstimated = (component) => component.measured === false;
const pos = (o) => `bottom:${o.bottomPct}%;height:${o.heightPct}%`;
const ICONS = { feasible: "✓", tight: "✓", infeasible: "✗", waiting: "…" };

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
  el.rangeHint.hidden = isFixed;
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
    const t = event.target.closest("[data-piece],[data-add],[data-edit],[data-toggle],[data-build],[data-close],[data-dismiss-notes]");
    if (!t) return;
    if (t.dataset.piece) {
      const [slot, id] = t.dataset.piece.split("|");
      openSheet({ slot, id });
    } else if (t.dataset.add !== undefined) {
      // The Add button (data-add=""), or an item with several positions to choose from.
      openSheet({ add: t.dataset.add || true });
    } else if (t.dataset.edit) {
      const change = JSON.parse(t.dataset.edit);
      if (change.op !== "mode") closeSheet();
      edit(change);
    } else if (t.dataset.toggle) {
      const change = JSON.parse(t.dataset.toggle);
      edit({ ...change, mode: t.getAttribute("aria-checked") === "true" ? t.dataset.off : t.dataset.on });
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

  if (!p.supportId || !p.headId || !p.modeName || !p.attachName) {
    renderIncomplete();
    return;
  }

  const chain = buildChain(gear, { packageId: state.packageId, buildId: state.buildId, ...p });
  const evaluation = target ? evaluateChain(chain, target) : null;
  const verdict = checkVerdict(chain, target, evaluation);

  // Draw once to measure the labels (they wrap, so their heights vary), then
  // lay out again with those heights so none overlap.
  el.rig.dataset.state = verdict.state;
  el.rig.innerHTML = drawingHtml(stackLayout(chain, target));
  const lane = { plotPx: el.rig.querySelector(".plot").offsetHeight, labelPx: [] };
  for (const label of el.rig.querySelectorAll(".lane-label")) lane.labelPx[Number(label.dataset.block)] = label.offsetHeight;
  el.rig.innerHTML = drawingHtml(stackLayout(chain, target, { lane }));

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

/** A rig with an empty required slot: offer what fits there. */
function renderIncomplete() {
  const p = state.picks;
  const opts = slotOptions(gear, state.packageId, state.buildId, p);
  const slot = !p.supportId ? "support" : "head";
  const choices = opts[slot].filter((o) => o.available);
  setVerdict("waiting", !p.supportId ? "Choose a support" : !p.headId ? "Choose a head" : "Nothing on this camera fits the head");
  el.rig.dataset.state = "waiting";
  el.footer.innerHTML = "";
  el.addButton.hidden = true;
  el.rig.innerHTML = `<div class="empty-slot">${
    choices.length && (!p.supportId || !p.headId)
      ? `<div class="option-list">${choices.map((o) => optionButton({ op: "swap", slot, id: o.id }, o.name, null, isEstimated(o.component))).join("")}</div>`
      : `<p class="hint">${escapeHtml(opts.attach.find((a) => a.reason)?.reason || "Nothing fits here.")}</p>`
  }</div>`;
}

// --- The drawing (SPEC.md 5.8, 7.2) ------------------------------------------

function drawingHtml(layout) {
  const blocks = layout.blocks;
  // A piece with no rise (an offset in underslung mode) is drawn as a thin bar;
  // a camera its head cradles is drawn inside the head.
  const shape = (b) => `${b.direction === "flat" ? " is-flat" : ""}${b.cradled ? " is-cradled" : ""}`;
  const parts = blocks
    .flatMap((b) =>
      b.parts
        ? b.parts.map((part) => `<div class="part col-${b.column} kind-${part.kind}" style="${pos(part)}"></div>`)
        : [`<div class="part col-${b.column} kind-${b.kind}${shape(b)}" style="${pos(b)}"></div>`]
    )
    .join("");
  const hits = blocks
    .map((b) => `<button type="button" class="hit col-${b.column}${shape(b)}" style="${pos(b)}" data-piece="${pieceKey(b)}" aria-label="${escapeHtml(b.name)}"></button>`)
    .join("");

  const lane = layout.lane
    .map(
      (entry) => `<div class="leader-h from-col-${entry.column}" style="bottom:${entry.anchorPct}%"></div>
        <div class="leader-v" style="${pos(entry.leader)}"></div>
        ${labelHtml(blocks[entry.block], entry)}`
    )
    .join("");

  const connectors = layout.connectors
    .map((c) => `<div class="connector from-col-${c.fromColumn}" style="bottom:${c.pct}%"></div>`)
    .join("");

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

  return `<div class="plot" data-columns="${layout.columns}" aria-label="Lens reaches ${inches(reach.min)} to ${inches(reach.max)}">
    ${rail}
    <div class="floor" style="bottom:${layout.floor.pct}%"></div>
    ${target}
    ${connectors}
    ${parts}
    ${hits}
    <div class="lens col-${layout.lens.column}" style="bottom:${layout.lens.pct}%" aria-hidden="true"><span></span></div>
    ${lane}
  </div>`;
}

const pieceKey = (block) => `${block.slot}|${block.component.id}`;

function labelHtml(block, entry) {
  const detail = [
    block.modeLabel || block.mode,
    block.attach === "top-handle" ? "top handle" : null,
    block.parts ? block.kind : null,
  ].filter(Boolean);
  return `<button type="button" class="lane-label" style="bottom:${entry.pct}%" data-block="${entry.block}" data-piece="${pieceKey(block)}">
    <span class="label-name">${escapeHtml(block.name)}${dot(block.estimated)}</span>
    <span class="label-rise">${fmtSigned(block.rise)}${detail.length ? ` · ${escapeHtml(detail.join(" · "))}` : ""}</span>
    ${block.inverted ? '<span class="label-flag">Camera inverted — flip image</span>' : ""}
  </button>`;
}

function footerHtml(layout, chain) {
  const key = ["moveable", "adjustable", "fixed"]
    .map((kind) => `<span class="key"><i class="swatch kind-${kind}"></i>${kind[0].toUpperCase()}${kind.slice(1)}</span>`)
    .join("");
  const estimated = layout.estimated ? `<span class="key">${dot(true)}Estimated measurements</span>` : "";
  const cap = exceedsBaseLayerCap(chain)
    ? `<span class="key key-warning">${chain.baseItems.length} base items, over the ${DEFAULT_MAX_BASE_LAYER_ITEMS}-item stacking cap</span>`
    : "";
  return key + estimated + cap;
}

// --- The sheets: change one piece, or add one ----------------------------------

function optionButton(attrs, label, rise, estimated) {
  return `<button type="button" class="option" ${attrs}>
    <span>${escapeHtml(label)}${dot(estimated)}</span>${rise == null ? "" : `<span class="option-rise">${fmtSigned(rise)}</span>`}
  </button>`;
}
const editAttr = (change) => `data-edit="${escapeHtml(JSON.stringify(change))}"`;

/** Only what fits, as buttons (SPEC.md 7.2: no list of what doesn't). */
function optionsHtml(options, toChange, emptyText) {
  const fits = options.filter((o) => o.available);
  return fits.length
    ? `<div class="option-list">${fits.map((o) => optionButton(editAttr(toChange(o)), o.label, o.rise, isEstimated(o.component))).join("")}</div>`
    : `<p class="hint">${escapeHtml(emptyText)}</p>`;
}

function toggleHtml(change, control, current) {
  const isOn = current === control.on.name;
  return `<button type="button" class="toggle" role="switch" aria-checked="${isOn}"
      data-toggle="${escapeHtml(JSON.stringify(change))}"
      data-on="${escapeHtml(control.on.name)}" data-off="${escapeHtml(control.off.name)}">
    <span class="toggle-track"><span class="toggle-thumb"></span></span>
    <span class="toggle-text">
      <span class="toggle-label">${escapeHtml(control.on.label)}</span>
      <span class="toggle-off">Off: ${escapeHtml(control.off.label)}</span>
    </span>
  </button>`;
}

/** Nothing, text, a toggle, or (three or more states) a segmented choice —
 * rules.js's modeControl decides which. */
function modeHtml(control, change, current) {
  const hint = control.hint ? `<p class="hint">${escapeHtml(control.hint)}</p>` : "";
  if (control.type === "toggle") return toggleHtml(change, control, current) + hint;
  if (control.type === "dropdown") {
    return `<div class="choice" role="radiogroup">${control.entries
      .map(
        (e) => `<button type="button" class="choice-btn" role="radio" aria-checked="${e.name === current}" ${editAttr({ ...change, mode: e.name })}>${escapeHtml(e.label)}</button>`
      )
      .join("")}</div>${hint}`;
  }
  if (control.type === "static" && control.entry.label) return `<p class="mode-static">${escapeHtml(control.entry.label)}</p>${hint}`;
  return hint;
}

function renderSheet() {
  const html = state.sheet.add ? addSheetHtml(state.sheet.add) : pieceSheetHtml(state.sheet);
  if (html == null) {
    closeSheet();
    return;
  }
  el.sheet.innerHTML = `<div class="sheet-body">${html}<button type="button" class="sheet-done" data-close>Done</button></div>`;
}

function pieceSheetHtml({ slot, id }) {
  const p = state.picks;
  const ids = slot === "base" ? p.baseItemIds : slot === "adapter" ? p.adapterIds : null;
  const index = ids ? ids.indexOf(id) : 0;
  if (index < 0) return null; // it was removed
  const opts = slotOptions(gear, state.packageId, state.buildId, p);
  const chain = buildChain(gear, { packageId: state.packageId, buildId: state.buildId, ...p });
  const block = stackLayout(chain, normalizeTarget(state.target)).blocks.find((b) => b.slot === slot && b.index === index);
  if (!block) return null;

  const range = block.range ? ` · adjusts ${inches(block.range.min)} to ${inches(block.range.max)}` : "";
  const head = `<h2>${escapeHtml(block.name)}${dot(block.estimated)}</h2>
    <p class="sheet-sub">${fmtSigned(block.rise)} at this setup${range}${block.estimated ? " · estimated measurement" : ""}</p>`;

  if (slot === "build") {
    const control = modeControl(opts.attach);
    const builds =
      gear.builds.length > 1
        ? `<h3>Camera build</h3><div class="option-list">${gear.builds
            .filter((b) => b.id !== state.buildId)
            .map((b) => optionButton(`data-build="${escapeHtml(b.id)}"`, b.name, null, false))
            .join("")}</div>`
        : "";
    return `${head}<h3>Camera mount</h3>${modeHtml(control, { op: "mode", slot: "build" }, p.attachName)}${builds}`;
  }

  let mode = "";
  if (slot === "head") {
    const entry = opts.head.find((o) => o.id === p.headId);
    mode = `<h3>Mode</h3>${modeHtml(modeControl(entry.modes), { op: "mode", slot: "head" }, p.modeName)}`;
  } else if (slot === "adapter" || slot === "base") {
    const entry = (slot === "base" ? opts.base : opts.adapters).find((o) => o.id === id);
    if (entry.modes.length > 1) {
      const current = (slot === "base" ? p.baseModes : p.adapterModes)[id];
      mode = `<h3>${slot === "base" ? "Face" : "Mode"}</h3>${modeHtml(modeControl(entry.modes), { op: "mode", slot, index }, current)}`;
    }
  }

  const swap = optionsHtml(
    swapOptions(gear, state.packageId, state.buildId, p, slot, index),
    (o) => ({ op: "swap", slot, index, id: o.id, mode: o.mode }),
    "Nothing else fits here."
  );
  const remove =
    slot === "base" || slot === "adapter"
      ? `<button type="button" class="remove" ${editAttr({ op: "remove", slot, index })}>Remove ${escapeHtml(block.name)}</button>`
      : "";
  return `${head}${mode}<h3>Swap for</h3>${swap}${remove}`;
}

/** The Add sheet: everything that fits; an item with several positions
 * asks which. */
function addSheetHtml(which) {
  const options = addOptions(gear, state.packageId, state.buildId, state.picks);
  const chosen = options.find((o) => o.id === which);
  if (chosen) {
    return `<h2>Add ${escapeHtml(chosen.name)}</h2><p class="sheet-sub">Where?</p>
      <div class="option-list">${chosen.positions
        .map((at) => optionButton(editAttr({ op: "insert", slot: at.slot, index: at.index, id: chosen.id, mode: at.mode }), at.where, null, false))
        .join("")}</div>`;
  }
  if (!options.length) return `<h2>Add</h2><p class="hint">Nothing else fits this rig.</p>`;
  const item = (o) => {
    const [only] = o.positions;
    const attrs =
      o.positions.length === 1
        ? editAttr({ op: "insert", slot: only.slot, index: only.index, id: o.id, mode: only.mode })
        : `data-add="${escapeHtml(o.id)}"`;
    return optionButton(attrs, o.label, o.rise, isEstimated(o.component));
  };
  const group = (title, category) => {
    const list = options.filter((o) => o.component.category === category);
    return list.length ? `<h3>${title}</h3><div class="option-list">${list.map(item).join("")}</div>` : "";
  };
  return `<h2>Add to the rig</h2>${group("Under the support", "base")}${group("Between support and head", "adapter")}`;
}
