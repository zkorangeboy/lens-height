// Lens Height — the check screen (SPEC.md 7.2).
//
// This file is thin on purpose. It collects input, calls the solver
// (src/solver.js), the compatibility rules (src/rules.js), and the stack
// layout (src/stack.js), and renders what they return. There is no height
// math and no compatibility logic here: intervals, margins, shortfalls, and
// stack positions come back ready to draw, and which picks are legal comes
// from slotOptions / revalidatePicks. The only arithmetic is formatting a
// number for display.
//
// Solve mode is frozen and not shown (SPEC.md 5): nothing here calls it.

import { checkChain, buildChain, normalizeTarget, exceedsBaseLayerCap, DEFAULT_MAX_BASE_LAYER_ITEMS } from "./src/solver.js";
import { defaultPicks, revalidatePicks, slotOptions, modeControl } from "./src/rules.js";
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
};

const el = {
  loading: document.getElementById("loading"),
  form: document.getElementById("check-form"),
  statusBar: document.getElementById("status-bar"),
  resultBody: document.getElementById("result-body"),
  stackCard: document.getElementById("stack-card"),
  picks: document.getElementById("picks"),

  targetFixedBtn: document.getElementById("target-fixed"),
  targetRangeBtn: document.getElementById("target-range"),
  fixedFields: document.getElementById("fixed-target-fields"),
  rangeFields: document.getElementById("range-target-fields"),
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
const SIGNED = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1, signDisplay: "always" });
const fmtSigned = (n) => `${SIGNED.format(n)}"`;
const fmtPlain = (n) => `${n.toFixed(1)}"`;

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

init();

async function init() {
  gear = await (await fetch("./gear.json")).json();
  state.packageId = gear.packages[0].id;
  state.buildId = gear.builds[0].id;
  state.picks = defaultPicks(gear, state.packageId, state.buildId);

  wireTargetEvents();
  wirePickEvents();
  applyTargetTypeVisibility();

  el.loading.hidden = true;
  el.form.hidden = false;
  renderAll();
}

function renderAll() {
  renderPicks();
  renderResult();
}

// ---------------------------------------------------------------------------
// Target input
// ---------------------------------------------------------------------------

function wireTargetEvents() {
  el.form.addEventListener("submit", (event) => event.preventDefault());

  el.targetFixedBtn.addEventListener("click", () => setTargetType("fixed"));
  el.targetRangeBtn.addEventListener("click", () => setTargetType("range"));

  for (const [input, key] of [
    [el.targetHeight, "height"],
    [el.targetLow, "low"],
    [el.targetHigh, "high"],
  ]) {
    input.addEventListener("input", () => {
      state.target[key] = input.value;
      renderResult();
    });
  }
}

function setTargetType(type) {
  state.target.type = type;
  applyTargetTypeVisibility();
  renderResult();
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
// Picks: only what can legally attach, ground up (SPEC.md 5.9)
// ---------------------------------------------------------------------------

/** Apply a change to the picks: revalidate (rules.js decides what's still
 * legal and says why), then redraw everything. */
function applyPicks(next) {
  const { picks, notes } = revalidatePicks(gear, state.packageId, state.buildId, next);
  state.picks = picks;
  state.notes = notes;
  renderAll();
}

const optionsNow = () => slotOptions(gear, state.packageId, state.buildId, state.picks);

function wirePickEvents() {
  el.picks.addEventListener("change", (event) => {
    const t = event.target;
    const p = state.picks;
    switch (t.dataset.slot) {
      case "base":
        applyPicks({
          ...p,
          baseItemIds: t.checked ? [...p.baseItemIds, t.value] : p.baseItemIds.filter((id) => id !== t.value),
        });
        break;
      case "support":
        applyPicks({ ...p, supportId: t.value || null });
        break;
      case "adapter": {
        if (t.checked) {
          const first = optionsNow().adapters.find((a) => a.id === t.value)?.modes.find((m) => m.available);
          applyPicks({
            ...p,
            adapterIds: [...p.adapterIds, t.value],
            adapterModes: first && first.name ? { ...p.adapterModes, [t.value]: first.name } : p.adapterModes,
          });
        } else {
          const { [t.value]: _dropped, ...modes } = p.adapterModes;
          applyPicks({ ...p, adapterIds: p.adapterIds.filter((id) => id !== t.value), adapterModes: modes });
        }
        break;
      }
      case "adapter-mode":
        applyPicks({ ...p, adapterModes: { ...p.adapterModes, [t.dataset.id]: t.value } });
        break;
      case "head":
        applyPicks({ ...p, headId: t.value || null, modeName: null, attachName: null });
        break;
      case "head-mode":
        applyPicks({ ...p, modeName: t.value });
        break;
      case "attach":
        applyPicks({ ...p, attachName: t.value });
        break;
      case "build":
        state.buildId = t.value;
        state.picks = defaultPicks(gear, state.packageId, state.buildId);
        state.notes = [];
        renderAll();
        break;
      case "package":
        state.packageId = t.value;
        state.picks = defaultPicks(gear, state.packageId, state.buildId);
        state.notes = [];
        renderAll();
        break;
    }
  });

  // Toggles: a button that flips between two modes the rules say are legal.
  el.picks.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-toggle]");
    if (!btn) return;
    const p = state.picks;
    const next = btn.getAttribute("aria-checked") === "true" ? btn.dataset.off : btn.dataset.on;
    switch (btn.dataset.toggle) {
      case "adapter-mode":
        applyPicks({ ...p, adapterModes: { ...p.adapterModes, [btn.dataset.id]: next } });
        break;
      case "head-mode":
        applyPicks({ ...p, modeName: next });
        break;
      case "attach":
        applyPicks({ ...p, attachName: next });
        break;
    }
  });
}

function toggleHtml({ kind, id, control, isOn, focusKey }) {
  return `
    <button type="button" class="toggle" role="switch" aria-checked="${isOn}"
      data-toggle="${kind}" ${id ? `data-id="${escapeHtml(id)}"` : ""}
      data-on="${escapeHtml(control.on.name)}" data-off="${escapeHtml(control.off.name)}"
      data-focus-key="${escapeHtml(focusKey)}">
      <span class="toggle-track"><span class="toggle-thumb"></span></span>
      <span class="toggle-text">
        <span class="toggle-label">${escapeHtml(control.on.label)}</span>
        <span class="toggle-off">Off: ${escapeHtml(control.off.label)}</span>
      </span>
    </button>`;
}

function selectHtml({ slot, id, entries, current, placeholder, label, focusKey }) {
  const options = entries
    .map((e) => `<option value="${escapeHtml(e.value)}"${e.value === current ? " selected" : ""}>${escapeHtml(e.text)}</option>`)
    .join("");
  return `<select data-slot="${slot}" ${id ? `data-id="${escapeHtml(id)}"` : ""} aria-label="${escapeHtml(label)}" data-focus-key="${escapeHtml(focusKey)}">
      ${placeholder ? `<option value=""${current ? "" : " selected"}>${escapeHtml(placeholder)}</option>` : ""}${options}</select>`;
}

const dot = (component) => (component.measured === false ? ' <span class="dot-unmeasured" title="Unverified estimate"></span>' : "");

/** How to show a component's modes: nothing, text, a toggle, or a dropdown
 * — rules.js's modeControl decides which. */
function modeControlHtml({ control, current, kind, id, slot, focusKey, label }) {
  const hint = control.hint ? `<p class="hint">${escapeHtml(control.hint)}</p>` : "";
  if (control.type === "toggle") {
    return toggleHtml({ kind, id, control, isOn: current === control.on.name, focusKey }) + hint;
  }
  if (control.type === "static") {
    return `<p class="mode-static">${escapeHtml(control.entry.label)}</p>${hint}`;
  }
  if (control.type === "dropdown") {
    const entries = control.entries.map((e) => ({ value: e.name, text: e.label }));
    return selectHtml({ slot, id, entries, current, label, focusKey }) + hint;
  }
  return hint;
}

function renderPicks() {
  const opts = optionsNow();
  const p = state.picks;
  const focused = document.activeElement?.dataset?.focusKey;
  const parts = [];

  parts.push(`<h2>Your rig <span class="subtle">floor up</span></h2>`);
  if (state.notes.length) {
    parts.push(`<ul class="notes" role="status">${state.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("")}</ul>`);
  }

  if (gear.packages.length > 1) {
    parts.push(`<div class="field"><span class="field-label">Package</span>${selectHtml({
      slot: "package", label: "Package", current: state.packageId, focusKey: "package",
      entries: gear.packages.map((x) => ({ value: x.id, text: x.name })),
    })}</div>`);
  }

  // 1. Base layer
  const bases = opts.base.filter((o) => o.available);
  parts.push(`<div class="field"><span class="field-label">1 · Base layer</span><div class="checkbox-list">${
    bases.length
      ? bases
          .map(
            (o) => `<label class="checkbox-row"><input type="checkbox" data-slot="base" value="${escapeHtml(o.id)}" data-focus-key="base:${escapeHtml(o.id)}"${
              p.baseItemIds.includes(o.id) ? " checked" : ""
            } /><span>${escapeHtml(o.name)}${dot(o.component)}</span></label>`
          )
          .join("")
      : '<span class="hint">No base-layer gear fits here.</span>'
  }</div></div>`);

  // 2. Support
  const supports = opts.support.filter((o) => o.available);
  parts.push(`<div class="field"><span class="field-label">2 · Support</span>${selectHtml({
    slot: "support", label: "Support", current: p.supportId, focusKey: "support", placeholder: "Choose a support…",
    entries: supports.map((o) => ({ value: o.id, text: o.name + (o.component.measured === false ? " •" : "") })),
  })}</div>`);

  // 3. Adapters
  const adapters = opts.adapters.filter((o) => o.available);
  parts.push(`<div class="field"><span class="field-label">3 · Adapters</span><div class="checkbox-list">${
    adapters.length
      ? adapters
          .map((o) => {
            const on = p.adapterIds.includes(o.id);
            const control = on && o.modes.length > 1 ? modeControl(o.modes) : null;
            const current = p.adapterModes[o.id];
            return `<div class="adapter-row"><label class="checkbox-row"><input type="checkbox" data-slot="adapter" value="${escapeHtml(o.id)}" data-focus-key="adapter:${escapeHtml(o.id)}"${
              on ? " checked" : ""
            } /><span>${escapeHtml(o.name)}${dot(o.component)}</span></label>${
              control
                ? modeControlHtml({ control, current, kind: "adapter-mode", id: o.id, slot: "adapter-mode", focusKey: `adapter-mode:${o.id}`, label: `${o.name} mode` })
                : ""
            }</div>`;
          })
          .join("")
      : '<span class="hint">No adapters fit here.</span>'
  }</div></div>`);

  // 4. Head, and its mode
  const heads = opts.head.filter((o) => o.available);
  const pickedHead = opts.head.find((o) => o.id === p.headId);
  parts.push(`<div class="field"><span class="field-label">4 · Head</span>${selectHtml({
    slot: "head", label: "Head", current: p.headId, focusKey: "head", placeholder: "Choose a head…",
    entries: heads.map((o) => ({ value: o.id, text: o.name + (o.component.measured === false ? " •" : "") })),
  })}${
    pickedHead
      ? modeControlHtml({ control: modeControl(pickedHead.modes), current: p.modeName, kind: "head-mode", slot: "head-mode", focusKey: "head-mode", label: "Head mode" })
      : ""
  }</div>`);

  // 5. Camera
  parts.push(`<div class="field"><span class="field-label">5 · Camera</span>${
    gear.builds.length > 1
      ? selectHtml({ slot: "build", label: "Camera build", current: state.buildId, focusKey: "build", entries: gear.builds.map((b) => ({ value: b.id, text: b.name })) })
      : ""
  }${
    pickedHead
      ? modeControlHtml({ control: modeControl(opts.attach), current: p.attachName, kind: "attach", slot: "attach", focusKey: "attach", label: "Camera mount" })
      : '<p class="hint">Choose a head first.</p>'
  }</div>`);

  el.picks.innerHTML = parts.join("");
  if (focused) el.picks.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus();
}

// ---------------------------------------------------------------------------
// The live result
// ---------------------------------------------------------------------------

const unmeasuredComponentsOf = (chain) =>
  [...chain.baseItems, chain.support, ...chain.adapters, chain.head, chain.build].filter((c) => c.measured === false);

function badgesHtml(chain) {
  const badges = [];
  const unmeasured = unmeasuredComponentsOf(chain);
  if (unmeasured.length) {
    badges.push(`<details class="badge-details"><summary class="badge badge-warning">Unverified ⓘ</summary>
      <p class="badge-tooltip">Estimated, not yet measured: ${unmeasured.map((c) => escapeHtml(c.name)).join(", ")}</p></details>`);
  }
  if (chain.attach.inverted) badges.push('<span class="badge badge-info">Camera inverted — flip image</span>');
  if (exceedsBaseLayerCap(chain)) {
    badges.push(`<span class="badge badge-danger">Exceeds ${DEFAULT_MAX_BASE_LAYER_ITEMS}-item base-layer cap (${chain.baseItems.length} items)</span>`);
  }
  return badges.length ? `<div class="badge-row">${badges.join("")}</div>` : "";
}

const marginRow = (evaluation) =>
  `<div class="stat-row"><span>Margin below / above</span><span>${fmtSigned(evaluation.marginBelow)} / ${fmtSigned(evaluation.marginAbove)}</span></div>`;

function shortfallText(evaluation) {
  const s = evaluation.shortfall;
  if (s.direction === "short") {
    return { head: `Short by ${fmtPlain(s.amount)}`, detail: `This rig tops out at ${fmtPlain(evaluation.max)}.` };
  }
  if (s.direction === "tall") {
    return { head: `Too tall by ${fmtPlain(s.amount)}`, detail: `This rig bottoms out at ${fmtPlain(evaluation.min)}.` };
  }
  return {
    head: `${fmtPlain(s.amount)} short on live travel`,
    detail: `The move is ${fmtPlain(s.needed)} wide; this rig can move ${fmtPlain(s.available)} during a take.`,
  };
}

function describeChange(change) {
  const adapter = (a) => `${a.name}${a.mode ? ` (${a.mode})` : ""}`;
  switch (change.kind) {
    case "add":
      return `Add ${change.component.name}`;
    case "add-adapter":
      return `Add ${change.component.name}${change.mode ? ` (${change.mode})` : ""}`;
    case "swap-adapter":
      return `Swap ${adapter(change.from)} for ${adapter(change.to)}`;
    case "swap-support":
      return `Swap the support: ${change.from.name} → ${change.to.name}`;
    case "swap-head":
      return `Swap the head: ${change.from.head.name} (${change.from.mode.name}) → ${change.to.head.name} (${change.to.mode.name})`;
    case "swap-attach":
      return `Change the camera mount: ${change.from.name} → ${change.to.name}`;
    default:
      return change.kind;
  }
}

function fixHtml(candidate) {
  const e = candidate.evaluation;
  return `<li class="fix">
    <ul class="change-list">${candidate.changes.map((c) => `<li>${escapeHtml(describeChange(c))}</li>`).join("")}</ul>
    <div class="fix-lands">Lens reach ${fmtPlain(e.min)} – ${fmtPlain(e.max)} · margin ${fmtSigned(e.marginBelow)} / ${fmtSigned(e.marginAbove)}</div>
  </li>`;
}

/** The three best fixes, and a way to open the rest. */
function fixesHtml(delta) {
  if (!delta) return "";
  if (delta.candidates.length === 0) {
    return `<div class="fixes"><h3>Fixes</h3><p>${escapeHtml(delta.message)}</p></div>`;
  }
  const best = delta.candidates.slice(0, 3);
  const rest = delta.candidates.slice(3);
  const more = rest.length
    ? `<details class="more-fixes"><summary>Show ${rest.length} more fix${rest.length === 1 ? "" : "es"}${
        delta.total > delta.candidates.length ? ` (best ${delta.candidates.length} of ${delta.total})` : ""
      }</summary><ul class="fix-list">${rest.map(fixHtml).join("")}</ul></details>`
    : "";
  return `<div class="fixes"><h3>Smallest fixes</h3><ul class="fix-list">${best.map(fixHtml).join("")}</ul>${more}</div>`;
}

function setStatus(stateName, icon, text) {
  el.form.dataset.state = stateName;
  el.statusBar.innerHTML = `<span class="status-icon" aria-hidden="true">${icon}</span><span class="status-text">${escapeHtml(text)}</span>`;
}

function renderResult() {
  const p = state.picks;
  const target = normalizeTarget(state.target);
  const complete = p.supportId && p.headId && p.modeName && p.attachName;

  if (!complete) {
    setStatus("waiting", "…", !p.supportId ? "Choose a support" : !p.headId ? "Choose a head" : "Finish the rig");
    el.resultBody.innerHTML = "";
    el.stackCard.innerHTML = "";
    return;
  }

  let chain;
  let result = null;
  try {
    if (target) {
      result = checkChain(gear, { target, packageId: state.packageId, buildId: state.buildId, chain: p });
      chain = result.chain;
    } else {
      chain = buildChain(gear, { packageId: state.packageId, buildId: state.buildId, ...p });
    }
  } catch (err) {
    // revalidatePicks keeps this from happening; show it rather than fail silently.
    setStatus("infeasible", "✗", "Can't evaluate this rig");
    el.resultBody.innerHTML = `<div class="card error-card">${escapeHtml(err.message)}</div>`;
    el.stackCard.innerHTML = "";
    return;
  }

  renderStack(chain, target);

  if (!result) {
    setStatus("waiting", "…", "Enter a target height");
    el.resultBody.innerHTML = `<div class="card"><div class="stat-row"><span>Lens reach</span><span>${fmtPlain(chain.min)} – ${fmtPlain(chain.max)}</span></div>${badgesHtml(chain)}</div>`;
    return;
  }

  const e = result.evaluation;
  if (e.feasible) {
    setStatus("feasible", "✓", `Feasible — reaches ${fmtPlain(e.min)} to ${fmtPlain(e.max)}`);
    el.resultBody.innerHTML = `<div class="card result-feasible">
      <div class="stat-row"><span>Lens reach</span><span>${fmtPlain(e.min)} – ${fmtPlain(e.max)}</span></div>
      ${marginRow(e)}
      <div class="stat-row"><span>Adjustability</span><span>${escapeHtml(chain.adjustability)}</span></div>
      ${badgesHtml(chain)}</div>`;
    return;
  }

  const text = shortfallText(e);
  setStatus("infeasible", "✗", text.head);
  el.resultBody.innerHTML = `<div class="card result-infeasible">
    <p class="shortfall">${escapeHtml(text.detail)}</p>
    ${marginRow(e)}
    ${badgesHtml(chain)}
    ${fixesHtml(result.delta)}</div>`;
}

// ---------------------------------------------------------------------------
// The stack, floor to lens (SPEC.md 5.8). stackLayout hands back positions as
// percentages; this only places them.
// ---------------------------------------------------------------------------

const pos = (o) => `bottom:${o.bottomPct}%;height:${o.heightPct}%`;

function blockHtml(block) {
  const parts = block.parts || [block];
  return parts
    .map((part) => `<div class="stack-block kind-${part.kind} slot-${block.slot}" style="${pos(part)}"></div>`)
    .join("");
}

function rowHtml(block) {
  const detail = block.mode ? ` — ${block.mode}` : block.attach ? ` — ${block.attach}` : "";
  const range = block.range ? `<span class="row-range">${fmtPlain(block.range.min)} to ${fmtPlain(block.range.max)}</span>` : "";
  return `<li class="stack-row">
    <span class="swatch kind-${block.kind}" aria-hidden="true"></span>
    <span class="row-name">${escapeHtml(block.name)}${escapeHtml(detail)}${dot(block.component)}${range}</span>
    <span class="row-rise">${fmtSigned(block.rise)}</span>
  </li>`;
}

function renderStack(chain, target) {
  const layout = stackLayout(chain, target);
  const rows = [...layout.blocks].reverse();

  const targetRow = layout.target
    ? `<li class="stack-row row-target"><span class="swatch swatch-target" aria-hidden="true"></span>
        <span class="row-name">${layout.target.isRange ? "Move" : "Target"}</span>
        <span class="row-rise">${layout.target.isRange ? `${fmtPlain(layout.target.low)} – ${fmtPlain(layout.target.high)}` : fmtPlain(layout.target.low)}</span></li>`
    : "";

  el.stackCard.innerHTML = `
    <h2>Rig <span class="subtle">floor to lens</span></h2>
    <div class="stack">
      <div class="stack-strip">
        <div class="stack-blocks">${layout.blocks.map(blockHtml).join("")}</div>
        <div class="stack-rail">
          <div class="stack-band band-reach" style="${pos(layout.reach)}" title="Every lens height this rig can reach"></div>
          ${layout.moveable ? `<div class="stack-band band-moveable" style="${pos(layout.moveable)}" title="What the moveable part can sweep from this setup"></div>` : ""}
        </div>
        <div class="stack-floor" style="bottom:${layout.floor.pct}%"></div>
        ${layout.target ? `<div class="stack-target${layout.target.isRange ? " is-range" : ""}" style="${pos(layout.target)}"></div>` : ""}
        <div class="stack-lens" style="bottom:${layout.lens.pct}%"></div>
      </div>
      <ol class="stack-rows">
        <li class="stack-row row-lens"><span class="swatch swatch-lens" aria-hidden="true"></span><span class="row-name">Lens</span><span class="row-rise">${fmtPlain(layout.lens.height)}</span></li>
        ${targetRow}
        ${rows.map(rowHtml).join("")}
        <li class="stack-row row-floor"><span class="swatch swatch-floor" aria-hidden="true"></span><span class="row-name">Floor</span><span class="row-rise">${fmtPlain(layout.floor.height)}</span></li>
      </ol>
    </div>
    <div class="legend">
      <span><i class="swatch kind-fixed"></i>Fixed</span>
      <span><i class="swatch kind-adjustable"></i>Set between setups</span>
      <span><i class="swatch kind-moveable"></i>Moves during the take</span>
    </div>`;
}
