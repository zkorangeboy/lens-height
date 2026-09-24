// Lens Height Solver — UI layer (SPEC.md step 3).
//
// Hard rule: no height math here. This file collects input, calls the
// solver, and renders exactly what comes back. Every interval, margin,
// feasibility flag, target position, and ranking decision below is read
// straight off a chain/evaluation/result object produced by src/solver.js
// or src/model.js — never recomputed. The only arithmetic in this file is
// presentational (formatting a given number as a string, or clamping an
// already-computed 0..1 position for CSS) and is called out as such.

import { solve, checkChain, DEFAULT_MAX_BASE_LAYER_ITEMS } from "./src/solver.js";
import { getPackage, getPackageComponents, getBuild, buildAttachPoints, supportInterval } from "./src/model.js";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let gear = null;

const state = {
  mode: "check", // "check" | "solve"
  packageId: null,
  buildId: null,
  selection: { baseItemIds: [], supportId: null, adapterIds: [], adapterModes: {}, headId: null, modeName: null, attachName: null },
  target: { type: "fixed", height: "", low: "", high: "" },
};

// ---------------------------------------------------------------------------
// DOM references
// ---------------------------------------------------------------------------

const el = {
  loading: document.getElementById("loading"),
  form: document.getElementById("query-form"),
  results: document.getElementById("results"),

  modeCheck: document.getElementById("mode-check"),
  modeSolve: document.getElementById("mode-solve"),
  chainSlotsSection: document.getElementById("chain-slots-section"),

  packageSelect: document.getElementById("package-select"),
  buildSelect: document.getElementById("build-select"),

  baseLayerCheckboxes: document.getElementById("base-layer-checkboxes"),
  supportSelect: document.getElementById("support-select"),
  adapterCheckboxes: document.getElementById("adapter-checkboxes"),
  headSelect: document.getElementById("head-select"),
  modeSelect: document.getElementById("mode-select"),
  attachSelect: document.getElementById("attach-select"),

  targetFixedBtn: document.getElementById("target-fixed"),
  targetRangeBtn: document.getElementById("target-range"),
  fixedFields: document.getElementById("fixed-target-fields"),
  rangeFields: document.getElementById("range-target-fields"),
  targetHeight: document.getElementById("target-height"),
  targetLow: document.getElementById("target-low"),
  targetHigh: document.getElementById("target-high"),

  runButton: document.getElementById("run-button"),
};

// ---------------------------------------------------------------------------
// Formatting helpers (presentation only — every value passed in already
// came from the solver; nothing here derives a new height).
// ---------------------------------------------------------------------------

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function fmtSigned(n) {
  return (n >= 0 ? "+" : "") + n.toFixed(1) + '"';
}

function fmtPlain(n) {
  return n.toFixed(1) + '"';
}

/** Clamp an already-computed 0..1 fraction so a marker never renders
 * off the edge of its track. Not a height computation — targetPosition
 * itself comes straight from evaluateChain(). */
function clamp01(fraction) {
  return Math.max(0, Math.min(1, fraction));
}

// ---------------------------------------------------------------------------
// Load gear.json and boot
// ---------------------------------------------------------------------------

init();

async function init() {
  const response = await fetch("./gear.json");
  gear = await response.json();

  populatePackageSelect();
  populateBuildSelect();
  onPackageChange();
  onBuildChange();

  wireEvents();
  applyModeVisibility();
  applyTargetTypeVisibility();

  el.loading.hidden = true;
  el.form.hidden = false;
}

// ---------------------------------------------------------------------------
// Populate selects from the loaded gear data
// ---------------------------------------------------------------------------

function populatePackageSelect() {
  el.packageSelect.innerHTML = gear.packages
    .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`)
    .join("");
  state.packageId = gear.packages[0].id;
  el.packageSelect.value = state.packageId;
}

function populateBuildSelect() {
  el.buildSelect.innerHTML = gear.builds
    .map((b) => `<option value="${escapeHtml(b.id)}">${escapeHtml(b.name)}</option>`)
    .join("");
  state.buildId = gear.builds[0].id;
  el.buildSelect.value = state.buildId;
}

function onPackageChange() {
  const components = getPackageComponents(gear, state.packageId);
  state.pool = {
    baseItems: components.filter((c) => c.category === "base"),
    supports: components.filter((c) => c.category === "support"),
    adapters: components.filter((c) => c.category === "adapter"),
    heads: components.filter((c) => c.category === "head"),
  };

  renderBaseLayerCheckboxes();
  renderSupportSelect();
  renderAdapterCheckboxes();
  renderHeadSelect();
}

function onBuildChange() {
  const build = getBuild(gear, state.buildId);
  state.pool = state.pool || {};
  state.pool.attachPoints = buildAttachPoints(build, gear);
  renderAttachSelect();
}

function renderBaseLayerCheckboxes() {
  state.selection.baseItemIds = [];
  el.baseLayerCheckboxes.innerHTML = state.pool.baseItems
    .map(
      (item) => `
        <label class="checkbox-row">
          <input type="checkbox" value="${escapeHtml(item.id)}" />
          <span>${escapeHtml(item.name)}</span>
          ${item.measured === false ? '<span class="dot-unmeasured" title="Unverified estimate"></span>' : ""}
        </label>`
    )
    .join("");
}

function renderAdapterCheckboxes() {
  state.selection.adapterIds = [];
  state.selection.adapterModes = {};
  el.adapterCheckboxes.innerHTML = state.pool.adapters.length
    ? state.pool.adapters
        .map((item) => {
          const modePicker = item.modes
            ? `<select class="adapter-mode" data-adapter="${escapeHtml(item.id)}" aria-label="${escapeHtml(item.name)} mode">${item.modes
                .map((m) => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)} (top faces ${escapeHtml(m.mountFacing || "up")})</option>`)
                .join("")}</select>`
            : "";
          return `
        <div class="adapter-row">
          <label class="checkbox-row">
            <input type="checkbox" value="${escapeHtml(item.id)}" />
            <span>${escapeHtml(item.name)}</span>
            ${item.measured === false ? '<span class="dot-unmeasured" title="Unverified estimate"></span>' : ""}
          </label>
          ${modePicker}
        </div>`;
        })
        .join("")
    : '<span class="hint">No adapters in this package.</span>';
}

/** Read which adapters are ticked and, for multi-mode ones, the mode chosen. */
function readAdapterSelection() {
  const ids = Array.from(el.adapterCheckboxes.querySelectorAll("input:checked")).map((i) => i.value);
  const modes = {};
  for (const id of ids) {
    const picker = el.adapterCheckboxes.querySelector(`select[data-adapter="${id}"]`);
    if (picker) modes[id] = picker.value;
  }
  state.selection.adapterIds = ids;
  state.selection.adapterModes = modes;
}

function renderSupportSelect() {
  el.supportSelect.innerHTML = state.pool.supports
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}${c.measured === false ? " •" : ""}</option>`)
    .join("");
  state.selection.supportId = state.pool.supports[0]?.id || null;
  el.supportSelect.value = state.selection.supportId || "";
}

function renderHeadSelect() {
  el.headSelect.innerHTML = state.pool.heads
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)}${c.measured === false ? " •" : ""}</option>`)
    .join("");
  state.selection.headId = state.pool.heads[0]?.id || null;
  el.headSelect.value = state.selection.headId || "";
  renderModeSelect();
}

function renderModeSelect() {
  const head = state.pool.heads.find((h) => h.id === state.selection.headId);
  const modes = head ? head.modes : [];
  el.modeSelect.innerHTML = modes
    .map((m) => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)} (faces ${escapeHtml(m.cameraMountFacing)})</option>`)
    .join("");
  state.selection.modeName = modes[0]?.name || null;
  el.modeSelect.value = state.selection.modeName || "";
}

function renderAttachSelect() {
  el.attachSelect.innerHTML = state.pool.attachPoints
    .map((a) => `<option value="${escapeHtml(a.name)}">${escapeHtml(a.name)}${a.inverted ? " (inverted)" : ""}</option>`)
    .join("");
  state.selection.attachName = state.pool.attachPoints[0]?.name || null;
  el.attachSelect.value = state.selection.attachName || "";
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

function wireEvents() {
  el.modeCheck.addEventListener("click", () => setMode("check"));
  el.modeSolve.addEventListener("click", () => setMode("solve"));

  el.packageSelect.addEventListener("change", () => {
    state.packageId = el.packageSelect.value;
    onPackageChange();
    clearResults();
  });
  el.buildSelect.addEventListener("change", () => {
    state.buildId = el.buildSelect.value;
    onBuildChange();
    clearResults();
  });

  el.baseLayerCheckboxes.addEventListener("change", () => {
    state.selection.baseItemIds = Array.from(el.baseLayerCheckboxes.querySelectorAll("input:checked")).map((i) => i.value);
    clearResults();
  });
  el.adapterCheckboxes.addEventListener("change", () => {
    readAdapterSelection();
    clearResults();
  });
  el.supportSelect.addEventListener("change", () => {
    state.selection.supportId = el.supportSelect.value;
    clearResults();
  });
  el.headSelect.addEventListener("change", () => {
    state.selection.headId = el.headSelect.value;
    renderModeSelect();
    clearResults();
  });
  el.modeSelect.addEventListener("change", () => {
    state.selection.modeName = el.modeSelect.value;
    clearResults();
  });
  el.attachSelect.addEventListener("change", () => {
    state.selection.attachName = el.attachSelect.value;
    clearResults();
  });

  el.targetFixedBtn.addEventListener("click", () => setTargetType("fixed"));
  el.targetRangeBtn.addEventListener("click", () => setTargetType("range"));

  el.targetHeight.addEventListener("input", () => {
    state.target.height = el.targetHeight.value;
    clearResults();
  });
  el.targetLow.addEventListener("input", () => {
    state.target.low = el.targetLow.value;
    clearResults();
  });
  el.targetHigh.addEventListener("input", () => {
    state.target.high = el.targetHigh.value;
    clearResults();
  });

  el.form.addEventListener("submit", (event) => {
    event.preventDefault();
    runQuery();
  });
}

function setMode(mode) {
  state.mode = mode;
  applyModeVisibility();
  clearResults();
}

function applyModeVisibility() {
  const isCheck = state.mode === "check";
  el.modeCheck.classList.toggle("is-active", isCheck);
  el.modeCheck.setAttribute("aria-selected", String(isCheck));
  el.modeSolve.classList.toggle("is-active", !isCheck);
  el.modeSolve.setAttribute("aria-selected", String(!isCheck));
  el.chainSlotsSection.hidden = !isCheck;
  el.runButton.textContent = isCheck ? "Check rig" : "Find configurations";
}

function setTargetType(type) {
  state.target.type = type;
  applyTargetTypeVisibility();
  clearResults();
}

function applyTargetTypeVisibility() {
  const isFixed = state.target.type === "fixed";
  el.targetFixedBtn.classList.toggle("is-active", isFixed);
  el.targetFixedBtn.setAttribute("aria-selected", String(isFixed));
  el.targetRangeBtn.classList.toggle("is-active", !isFixed);
  el.targetRangeBtn.setAttribute("aria-selected", String(!isFixed));
  el.fixedFields.hidden = !isFixed;
  el.rangeFields.hidden = isFixed;
}

function clearResults() {
  el.results.innerHTML = "";
}

// ---------------------------------------------------------------------------
// Building the target from form input (parsing/validation only — the
// solver decides what these numbers mean, this just reads them in)
// ---------------------------------------------------------------------------

function readTarget() {
  if (state.target.type === "fixed") {
    const height = Number(state.target.height);
    if (state.target.height === "" || !Number.isFinite(height)) return null;
    return { type: "fixed", height };
  }
  const low = Number(state.target.low);
  const high = Number(state.target.high);
  if (state.target.low === "" || state.target.high === "" || !Number.isFinite(low) || !Number.isFinite(high)) return null;
  return { type: "range", low, high };
}

// ---------------------------------------------------------------------------
// Run the query
// ---------------------------------------------------------------------------

function runQuery() {
  const target = readTarget();
  if (!target) {
    el.results.innerHTML = `<div class="card error-card">Enter a target height first.</div>`;
    return;
  }

  try {
    if (state.mode === "check") {
      const result = checkChain(gear, {
        target,
        packageId: state.packageId,
        buildId: state.buildId,
        chain: { ...state.selection },
      });
      renderCheckResult(result);
    } else {
      const result = solve(gear, { target, packageId: state.packageId, buildId: state.buildId });
      renderSolveResults(result);
    }
  } catch (err) {
    el.results.innerHTML = `<div class="card error-card"><strong>Can't evaluate this rig:</strong> ${escapeHtml(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------------------
// Rendering — every number below is read off the solver's own output
// ---------------------------------------------------------------------------

/** Components with measured: false, straight off the chain — a flag
 * lookup, not a height computation. */
function unmeasuredComponentsOf(chain) {
  return [...chain.baseItems, chain.support, ...chain.adapters, chain.head, chain.build].filter((c) => c.measured === false);
}

function renderUnverifiedBadge(chain) {
  const unmeasured = unmeasuredComponentsOf(chain);
  if (unmeasured.length === 0) return "";
  const names = unmeasured.map((c) => escapeHtml(c.name)).join(", ");
  return `
    <details class="badge-details">
      <summary class="badge badge-warning">Unverified ⓘ</summary>
      <p class="badge-tooltip">Estimated, not yet measured: ${names}</p>
    </details>`;
}

function renderInvertedBadge(chain) {
  if (!chain.attach.inverted) return "";
  return `<span class="badge badge-info">Camera inverted — flip image</span>`;
}

function renderCapBadge(chain) {
  if (chain.baseItems.length <= DEFAULT_MAX_BASE_LAYER_ITEMS) return "";
  return `<span class="badge badge-danger">Exceeds ${DEFAULT_MAX_BASE_LAYER_ITEMS}-item base-layer cap (${chain.baseItems.length} items)</span>`;
}

function renderBadgeRow(chain) {
  const badges = [renderUnverifiedBadge(chain), renderInvertedBadge(chain), renderCapBadge(chain)].filter(Boolean).join("");
  return badges ? `<div class="badge-row">${badges}</div>` : "";
}

function renderComponentBreakdown(chain) {
  const rows = chain.baseItems.map((item) => componentRow("Base", item.name, fmtSigned(item.rise), item.measured === false));

  const supRange = supportInterval(chain.support);
  rows.push(
    componentRow(
      "Support",
      chain.support.name,
      `${fmtSigned(supRange.min)} to ${fmtSigned(supRange.max)}`,
      chain.support.measured === false
    )
  );
  for (const adapter of chain.adapters) {
    const label = adapter.mode ? `${adapter.name} — ${adapter.mode}, top faces ${adapter.mountFacing}` : adapter.name;
    rows.push(componentRow("Adapter", label, fmtSigned(adapter.rise), adapter.measured === false));
  }
  rows.push(
    componentRow(
      "Head",
      `${chain.head.name} — ${chain.mode.name}, faces ${chain.mode.cameraMountFacing}`,
      fmtSigned(chain.mode.rise),
      chain.head.measured === false
    )
  );
  rows.push(
    componentRow(
      "Build",
      `${chain.build.name} — ${chain.attach.name}${chain.attach.inverted ? " (inverted)" : ""}`,
      fmtSigned(chain.attach.rise),
      chain.build.measured === false
    )
  );

  return rows.join("");
}

function componentRow(slot, label, value, unmeasured) {
  return `
    <div class="component-row">
      <span class="component-slot">${escapeHtml(slot)}</span>
      <span class="component-label">${escapeHtml(label)}${unmeasured ? ' <span class="dot-unmeasured" title="Unverified estimate"></span>' : ""}</span>
      <span class="component-value">${escapeHtml(value)}</span>
    </div>`;
}

function renderMarginRow(evaluation) {
  return `<div class="stat-row"><span>Margin below / above</span><span>${fmtSigned(evaluation.marginBelow)} / ${fmtSigned(evaluation.marginAbove)}</span></div>`;
}

/** Renders where the target sits within [chain.min, chain.max], using
 * evaluation.targetPosition exactly as evaluateChain() computed it. The
 * only arithmetic here is *100 to turn a given 0..1 fraction into a CSS
 * percentage, and clamp01 so a tolerance-passing edge case can't push
 * the marker off the visible track. */
function renderTargetPositionBar(chain, evaluation) {
  const pos = evaluation.targetPosition;
  if (!pos) {
    return `<div class="range-bar-note">This chain has no adjustable range.</div>`;
  }
  const low = clamp01(pos.low) * 100;
  const high = clamp01(pos.high) * 100;
  const bandLeft = Math.min(low, high);
  const bandWidth = Math.max(Math.max(low, high) - bandLeft, 1.5);
  return `
    <div class="range-bar">
      <div class="range-bar-track">
        <div class="range-bar-band" style="left:${bandLeft}%;width:${bandWidth}%"></div>
      </div>
      <div class="range-bar-labels"><span>${fmtPlain(chain.min)}</span><span>${fmtPlain(chain.max)}</span></div>
    </div>`;
}

function adapterLabel(adapter) {
  return `${adapter.name}${adapter.mode ? ` (${adapter.mode})` : ""}`;
}

function describeChange(change) {
  switch (change.kind) {
    case "add":
      return `Add ${change.component.name}`;
    case "add-adapter":
      return `Add ${change.component.name}${change.mode ? ` (${change.mode})` : ""}`;
    case "swap-adapter":
      return `Swap adapter: ${adapterLabel(change.from)} → ${adapterLabel(change.to)}`;
    case "swap-support":
      return `Swap support: ${change.from.name} → ${change.to.name}`;
    case "swap-head":
      return `Swap head: ${change.from.head.name} (${change.from.mode.name}) → ${change.to.head.name} (${change.to.mode.name})`;
    case "swap-attach":
      return `Swap camera attach: ${change.from.name} → ${change.to.name}`;
    default:
      return change.kind;
  }
}

function renderDeltaCandidate(candidate, index) {
  const changesHtml = candidate.changes.map((c) => `<li>${escapeHtml(describeChange(c))}</li>`).join("");
  return `
    <li class="delta-candidate">
      <div class="delta-candidate-header">#${index + 1} — ${candidate.changes.length} change${candidate.changes.length === 1 ? "" : "s"}</div>
      <ul class="change-list">${changesHtml}</ul>
      <div class="stat-row"><span>Interval</span><span>${fmtPlain(candidate.chain.min)} – ${fmtPlain(candidate.chain.max)}</span></div>
      ${renderMarginRow(candidate.evaluation)}
      ${renderBadgeRow(candidate.chain)}
    </li>`;
}

function renderCheckResult(result) {
  const feasible = result.evaluation.feasible;
  const banner = `<div class="feasibility-banner ${feasible ? "is-feasible" : "is-infeasible"}">${feasible ? "Feasible" : "Not feasible"}</div>`;

  const chainCard = `
    <div class="card result-card">
      ${renderComponentBreakdown(result.chain)}
      <div class="stat-row"><span>Interval</span><span>${fmtPlain(result.chain.min)} – ${fmtPlain(result.chain.max)}</span></div>
      ${renderMarginRow(result.evaluation)}
      <div class="stat-row"><span>Adjustability</span><span>${escapeHtml(result.chain.adjustability)}</span></div>
      ${renderTargetPositionBar(result.chain, result.evaluation)}
      ${renderBadgeRow(result.chain)}
    </div>`;

  let deltaHtml = "";
  if (!feasible && result.delta) {
    if (result.delta.candidates.length === 0) {
      deltaHtml = `<div class="card"><h3>Closest changes</h3><p>${escapeHtml(result.delta.message)}</p></div>`;
    } else {
      deltaHtml = `
        <div class="card">
          <h3>Smallest changes that reach the target</h3>
          ${result.delta.total > result.delta.candidates.length ? `<p class="hint">Showing the best ${result.delta.candidates.length} of ${result.delta.total}.</p>` : ""}
          <ul class="delta-list">${result.delta.candidates.map(renderDeltaCandidate).join("")}</ul>
        </div>`;
    }
  }

  el.results.innerHTML = banner + chainCard + deltaHtml;
}

/** One line per alternate: what differs (base layer, adapters) and where it lands. */
function summarizeAlternate(chain) {
  const parts = [...chain.baseItems.map((i) => i.name), ...chain.adapters.map(adapterLabel)];
  return `${parts.length ? parts.join(" + ") : "no adapters or base layer"} — ${fmtPlain(chain.min)} to ${fmtPlain(chain.max)}`;
}

function renderAlternates(chain) {
  if (!chain.count || chain.count < 2) return "";
  const items = chain.alternates.map((alt) => `<li>${escapeHtml(summarizeAlternate(alt))}</li>`).join("");
  return `
    <details class="badge-details">
      <summary class="badge badge-info">+${chain.count - 1} more options</summary>
      <ul class="change-list badge-tooltip">${items}</ul>
    </details>`;
}

function renderSolveResults(result) {
  if (result.feasible.length === 0) {
    const fb = result.fallback;
    el.results.innerHTML = `
      <div class="card">
        <div class="feasibility-banner is-infeasible">No feasible configuration</div>
        <p>${escapeHtml(fb.message)}</p>
      </div>`;
    return;
  }

  const cards = result.feasible
    .map(
      (chain, i) => `
      <li class="card result-card">
        <div class="result-rank">#${i + 1}</div>
        ${renderComponentBreakdown(chain)}
        <div class="stat-row"><span>Interval</span><span>${fmtPlain(chain.min)} – ${fmtPlain(chain.max)}</span></div>
        ${renderMarginRow(chain.evaluation)}
        <div class="stat-row"><span>Adjustability</span><span>${escapeHtml(chain.adjustability)}</span></div>
        <div class="stat-row"><span>Pieces</span><span>${chain.pieceCount}</span></div>
        ${renderBadgeRow(chain)}
        ${renderAlternates(chain)}
      </li>`
    )
    .join("");

  el.results.innerHTML = `<ul class="result-list">${cards}</ul>`;
}
