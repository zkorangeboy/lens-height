# Lens Height Solver — Specification

A phone-first, offline-capable web app that answers: *given the grip and
camera package I have on this show, what combination of gear puts the lens
at a given height — or lets it travel across a given range without
re-rigging?*

This document is the source of truth for the data model and solver logic.
When behavior needs to change, change this file first, then update the
code to match.

---

## 1. Core concept: the mount chain

A rig is an **ordered chain of components from the ground to the optical
center of the lens**. Every component sits between two named mount points
and contributes a **signed rise** — the vertical distance from its bottom
mount to its top mount.

```
ground → [base layer] → [support] → [adapters] → [head] → [camera build] → optical center
```

Lens height = sum of all rises in the chain.

Two rules make this general enough to cover every case without
special-casing:

1. **Rises are signed.** A head mounted underslung contributes a *negative*
   rise. This is the only mechanism needed to handle underslung heads,
   low mode, and hanging configurations.
2. **Some rises are intervals, not scalars.** Tripod legs and dolly booms
   contribute `[min, max]`. The chain's total is therefore an interval:
   sum of fixed rises plus the sum of the adjustable ones.

**Reference plane definition:** "Lens height" always means the **optical
center of the lens** above the **finished floor** — not the top of the
camera, not the sensor plane, not the top of the track. Every measurement
entered into the database must respect this.

---

## 2. Mount types and compatibility

Components declare a `bottomMount` and a `topMount`. Two components may be
adjacent in a chain only if the lower one's `topMount` matches the upper
one's `bottomMount`. A component that fits more than one mount declares
`bottomMount` as a list and accepts any of them (a dolly sits on `ground`
*or* on `dolly-wheels` track).

Mount type vocabulary (extend as needed):

- `ground` — rests on the floor
- `dolly-wheels` — the top of dolly track: what a dolly's wheels ride on.
  Only dollies accept it.
- `mitchell` — Mitchell mount. **The standard head mount**: supports, heads,
  and adapters all use it unless they're genuinely something else.
- `bowl-100`, `bowl-150` — tripod/dolly bowls, for gear that really is
  bowl-mount. A bowl-mount head on a Mitchell support needs an adapter.
- `flat-38`, `flat-14` — flat plate with 3/8-16 or 1/4-20
- `euro` — Euro/Arri dovetail mount
- `dovetail` — camera dovetail plate
- `camera-base` — bottom of the camera body
- `optical-center` — terminal node; only the camera build produces this

The solver must reject chains with mismatched mounts rather than silently
summing them.

**Facing.** A mount also faces `up` or `down`. Two fields carry it:

- `mountFacing` — which way a support's or adapter's *top* mount faces.
  Default `up`. An adapter can declare it per mode (3.6).
- `supportMountFacing` — which way the mount *beneath* a component must
  face: its support-side mount. Default `up`, since almost everything sits
  on an up-facing mount. Every head mode declares one (3.3); adapters may.

The mount beneath must match what's above it requires: a head mode that
needs an up-facing mount can't sit on something whose top faces down, and
one that needs a down-facing mount can't sit on something whose top faces
up. Facing is checked separately from mount type, and the rejection says
which two pieces disagreed. (Head mode to camera attach point keeps its
own pairing, in 3.3 and 3.4.)

### 2.1 Chain rules beyond mounts

Two more hard rules reject a chain outright. Neither is a mount check —
gear with compatible mounts can still break them — so they are separate
checks, and the solver reports which rule failed.

**Family.** Supports and adapters may declare a `family` (e.g. `fisher`,
`chapman`). An adapter may declare `requiresFamily`; the chain is rejected
unless the support it's attached to has that same `family`. A support
with no `family` fails any `requiresFamily`. Adapters with no
`requiresFamily` (Mitchell risers) work on any support the mounts allow.
Family-specific gear often shares a mount type with everything else,
which is exactly why this can't be left to mount compatibility.

**Apple boxes** (`kind: "apple-box"`, 3.1):

- *Where they may go.* **Only a dolly is a hard prohibition**: an apple
  box may not be used in a chain whose support is a dolly (`kind:
  "dolly"`, 3.2). Track, not a box, is what goes under a dolly. Every
  other support — tripod, hi-hat, low hat — may sit on apple boxes.
- *Which faces.* Only a **full** apple may stand on its 12" or 20" face.
  Half, quarter, and pancake boxes are flat-only.

Where the hard rules allow an apple box, ranking discourages it (5.3),
in two separate, *soft* steps that are not rules and never reject a chain:

- **A tripod on apple boxes** is legal but heavily penalized — heavier than
  the general penalty below, because it is the case in practice least
  worth doing. Such a chain sorts below every chain that doesn't put a
  tripod on apple boxes, whatever its margin.
- **Any apple box** carries a lighter general penalty: among otherwise
  equivalent chains, the one without sorts above.

---

## 3. Component categories

### 3.1 Base layer (optional, stackable)

Raises the whole rig off the floor. Base-layer components declare a `kind`
(`apple-box` or `track`) and a single fixed `rise`. Base items stack from
the ground up, each one's `bottomMount` mating with the one below, and the
top of the stack is what the support must accept.

- **Apple boxes** (`kind: "apple-box"`, `ground → ground`). Standard
  dimensions, so each box offers multiple rises depending on which face it
  stands on. Each orientation is its own component, carrying `boxSize`
  (`full`, `half`, `quarter`, `pancake`) and `orientation` (`flat`,
  `12in`, `20in`):
  - Full: 8" flat, 12", 20"
  - Half: 4" flat
  - Quarter: 2" flat
  - Pancake: 1" flat
  Only a full apple may stand on its 12" or 20" face (2.1) — a half,
  quarter, or pancake on those faces is invalid, not merely unstable.
  Flag the 12"/20" orientations of a full apple as `stability: low`.
  Apple boxes may not go under a dolly (2.1); under a tripod they're legal
  but heavily penalized in ranking.
- **Track + wedges** (`kind: "track"`, `ground → dolly-wheels`). Contributes
  a fixed rise (measure it — it is not zero, and it is the most commonly
  forgotten offset in the chain). Its top is `dolly-wheels`, so only a
  dolly can sit on it: a tripod cannot be put on track. It goes on top of
  the base stack, and at most one fits in a chain.
- **Skate wheels / soft tires** on a dolly: affects the dolly's own base
  rise; store as a variant rather than a separate base component.

Solver constraint: cap base-layer stacking at **2 items** by default,
configurable. Taller stacks are legal but should be ranked last.

### 3.2 Support

The component with the adjustable range. Every support presents a
`mitchell` top (2). Tripods sit on `ground` only, so sticks can't be put on
track; dollies accept `ground` *or* `dolly-wheels`; hi-hats and low hats sit
on `ground`.

A support declares a `kind` — `tripod`, `dolly`, `hi-hat`, or `lo-hat` —
which the apple-box rules key off (2.1): a dolly forbids apple boxes, a
tripod on them is penalized in ranking.

- **Tripods** (`kind: "tripod"`; baby, standard, tall). Rise is the bowl
  height interval.
  Store `specMin`/`specMax` *and* `practicalMin`/`practicalMax` — the
  practical figures account for leveling on a rake and for the legs
  actually clearing the spreader. The solver uses practical figures;
  the UI may show spec figures for reference.
- **Hi-hat / low hat** (`kind: "hi-hat"`, `"lo-hat"`). Fixed rise, no range.
- **Dollies** (`kind: "dolly"`). Rise is `baseRise + boomRange`, where `baseRise` is floor
  (or track) to the boom's zero point. The boom interval is usually the
  widest range in the system and is what makes a dolly answer a range
  query by itself. When the column itself telescopes, declare `legRange`
  (same shape as `riseRange`) instead of a fixed `baseRise`: an
  `adjustable` sub-range stacked under the `moveable` `boomRange`. Legs
  reposition the boom between setups but don't move live, and don't widen
  what a `moveable` range query can ask of this support (5.2) — only the
  boom's own width does.

Each support declares `levelingLoss` — inches of usable range sacrificed
to level on uneven ground (default 1"). Subtract from the top of the
interval.

A support may declare a `family` (2.1) — the dolly family adapters can
require.

### 3.3 Head

`mitchell → flat-38 | dovetail`. Fixed rise. (A bowl-mount head declares
`bottomMount: bowl-*` and needs an adapter to sit on a Mitchell support.)

A head has one or more **modes**. Each mode stores:

- `rise` — signed distance from the head's support-side mount to its
  camera-side mount in that mode. Negative when the camera-side mount
  hangs below the support mount.
- `cameraMountFacing` — `up` or `down`: which way the camera-side mount
  faces in that mode.
- `supportMountFacing` — `up` or `down`: which way the mount *beneath* the
  head must face in that mode (2). Every mode declares it. A normal mode
  needs an up-facing mount beneath it. An underslung mode hangs the head
  from a down-facing mount, so it needs one — and a tripod, riser, or
  hi-hat top all face up, so in practice the only thing that supplies it
  is an offset in underslung mode (3.6). An underslung mode is therefore
  rejected directly on a tripod. (If omitted, `up`.)

Examples:

- **O'Connor, normal:** positive rise, facing `up`, needs an `up` mount
  beneath.
- **O'Connor, underslung:** negative rise, facing `down`, needs a `down`
  mount beneath. The plate now faces the floor, so the camera must attach
  either inverted by its base or upright by its top handle (see 3.4).
- **Lambda, underslung:** the head hangs from the dolly nose, so the rise
  from nose to bottom bracket is negative, but the bracket faces `up`.
  The camera sits on it normally and contributes its usual positive rise.
  Its nose is an ordinary up-facing mount, so this mode needs an `up` mount
  beneath it and no offset — "underslung" describes the rise, not the mount.

Inversion is never a flag on the head. It falls out of matching a
`down`-facing mount to a camera attach point (3.4). Measure each mode
separately; underslung rise is never simply `-rise`.

### 3.4 Camera build

`flat-38 | dovetail → optical-center`. Fixed rise, **composable** — do not
store one number per camera body.

A build is an ordered list of its own components:

- baseplate / bridgeplate (e.g. 19mm studio, 15mm LWS)
- risers (each with a rise)
- dovetail plate
- camera body — stores `opticalCenterAboveBase`, the distance from the
  bottom of the body to lens optical center, which depends on the lens
  mount height of that specific camera

The build's total rise is the sum. Builds are assembled once per show and
reused across queries.

A build exposes one or more **attach points**, each with its own facing
and signed offset to optical center:

- `base` — faces `down`; optical center is **above** it (positive).
  Mates with an `up`-facing head mount.
- `base-inverted` — the same base, camera flipped. Faces `up`; optical
  center is **below** it (negative). Mates with a `down`-facing mount.
  Results using it must be labeled "camera inverted — flip image."
- `top-handle` — faces `up`; optical center is **below** it (negative).
  Mates with a `down`-facing mount; camera hangs upright.

A down-facing head mount therefore produces up to two candidate chains
(inverted vs. hung from the handle), and the solver evaluates both. A
build only offers `top-handle` if it has a handle rated to carry it.

### 3.5 Adjustability

Every component declares an `adjustability`:

- `moveable` — adjustable *during* a take (a dolly boom, a jib arm, a
  powered column). The rig can execute a live move across this range.
- `adjustable` — adjustable *between* setups, not within a shot (tripod
  legs, a column riser). Repositioning takes re-rigging time and cannot
  happen mid-take.
- `fixed` — no range at all (hi-hats, risers, apple boxes). This is the
  implied value: any component with no range is `fixed`, whether or not
  the field is present.

Today only supports (3.2) carry a real range, so they're the only
components that are ever `moveable` or `adjustable` — every base-layer
item, adapter, head, and camera-build part is `fixed`. The field still lives on
every component, so a future part with its own range (a second boom, a
powered riser) needs no schema change to participate.

A chain's adjustability is the most capable type found among its
components, and is ranking criterion 3 in solve mode (5.3) — a chain that
*can* move live outranks one that can't, independent of any particular
query.

The label alone is not sufficient to satisfy a `moveable` range target,
though. A support can combine an `adjustable` sub-range with a narrower
`moveable` one (`legRange` + `boomRange`, 3.2) — its adjustability is
still `moveable` overall, since that's the most capable type present, but
only the `moveable` sub-range's own width is usable for a live move. 5.2
computes that width explicitly rather than trusting the label.

### 3.6 Adapter

`category: "adapter"`. Sits between the support and the head, and is
**chainable** — a chain may include zero or more, stacked so each one's
`bottomMount` mates with the top of the one below (the support's top, for
the first), and each one's facing requirement (2) is met by the top of the
one below. Each adapter declares:

- `bottomMount` / `topMount` — usually both `mitchell`.
- `rise` — signed distance from its bottom mount to its top mount.
  Negative when the top mount sits below the bottom mount.
- `mountFacing` — `up` or `down`: which way its top mount faces (default
  `up`).
- `supportMountFacing` — which way the mount beneath it must face (default
  `up`).
- `family`, `requiresFamily` — optional; see 2.1.

**Modes.** An adapter may instead declare several `modes`, following the
head-mode pattern (3.3). Each mode has its own `name`, signed `rise`, and
top-mount `mountFacing`. An adapter with no `modes` is simply a
single-mode adapter using the fields above. In a chain, an adapter is used
in exactly one of its modes, and the solver tries each. The same physical
adapter can appear only once in a chain, in one mode. When a selection
doesn't say which mode, the first one is used.

Adapters are `fixed`; they add their rise to both ends of the chain's
interval (5.2) and count as a piece of gear.

Three kinds are modeled:

- **Mitchell risers** — 6", 12", 18", 24". Measured. `mitchell → mitchell`,
  positive rise, no `requiresFamily`, so they work on any support the
  mounts allow. Their top always faces `up`.
- **Mitchell offset** — measured, `mitchell → mitchell`, two modes:
  - `upright`: rise +1", top mount faces `up`.
  - `underslung`: rise 0", top mount faces `down`.
  The underslung mode is what hangs a head: it presents the down-facing
  mount an underslung head mode requires (3.3), and nothing else in the
  gear model does. Upright, it's just a 1" riser.
- **Dolly configurations** — low mode, rotating offset, broken neck. Each
  is a way of rigging the dolly's head position, modeled as an adapter with
  its own signed rise (low mode is negative). They're family-specific:
  each declares `requiresFamily`, and the dolly declares the matching
  `family`.

---

## 4. Data format

All gear lives in a single JSON file, `gear.json`, shipped in the repo as
the **seed layer**. It is read-only at runtime.

```json
{
  "schemaVersion": 1,
  "components": [
    {
      "id": "oconnor-2575",
      "name": "O'Connor 2575D",
      "category": "head",
      "bottomMount": "mitchell",
      "topMount": "flat-38",
      "modes": [
        { "name": "normal",     "rise": 6.75, "cameraMountFacing": "up" },
        { "name": "underslung", "rise": -4.5, "cameraMountFacing": "down" }
      ],
      "measured": true,
      "notes": "Measured mount seat to top of plate, 2024-xx-xx"
    },
    {
      "id": "sachtler-baby-150",
      "name": "Sachtler Baby Legs 150",
      "category": "support",
      "bottomMount": "ground",
      "topMount": "mitchell",
      "riseRange": { "specMin": 10.0, "specMax": 28.0,
                     "practicalMin": 11.0, "practicalMax": 27.0 },
      "levelingLoss": 1.0,
      "spreadRequired": true,
      "measured": false
    },
    {
      "id": "mitchell-riser-6",
      "name": "Mitchell riser 6\"",
      "category": "adapter",
      "bottomMount": "mitchell",
      "topMount": "mitchell",
      "rise": 6.0,
      "mountFacing": "up",
      "measured": true
    },
    {
      "id": "dolly-low-mode",
      "name": "Dolly low mode",
      "category": "adapter",
      "bottomMount": "mitchell",
      "topMount": "mitchell",
      "rise": -4.0,
      "mountFacing": "up",
      "requiresFamily": "fisher",
      "measured": false
    }
  ],
  "packages": [
    {
      "id": "show-name",
      "name": "Show Name",
      "componentIds": ["oconnor-2575", "sachtler-baby-150", "..."]
    }
  ],
  "builds": [
    {
      "id": "a-cam-studio",
      "name": "A-Cam, studio bridgeplate",
      "componentIds": ["arri-bridgeplate-19", "riser-1in", "alexa35"]
    }
  ]
}
```

**Every numeric field carries a `measured` flag on its component.** Values
that came from manufacturer specs or estimates must be marked
`measured: false` and displayed in the UI with a visible indicator (a dot
next to the value). The user needs to know at a glance which numbers have
been verified with a tape.

### 4.1 Override layer

User edits are **never written into `gear.json`**. They go to a separate
object in local storage, keyed by component id and field:

```json
{
  "schemaVersion": 1,
  "overrides": {
    "oconnor-2575": { "rise": 6.5, "measured": true },
    "sachtler-baby-150": { "riseRange": { "practicalMax": 26.0 },
                           "measured": true }
  },
  "customComponents": [ /* full component objects, same schema */ ]
}
```

At load: deep-merge `overrides` onto the seed, override winning. This
means updating the repo seed never clobbers measurements taken on set,
and vice versa.

**Export**: a button that serializes the override object to the clipboard
and the native share sheet, in exactly this format. It must be pasteable
into the GitHub web editor from a phone with no conversion step.

**Import**: accepts the same format, merging rather than replacing.

---

## 5. Solver

The solver has two modes, and both reduce to the same per-chain evaluation
(5.2) so the math is never duplicated between them:

- **Solve mode** — "what configurations reach this target?" Enumerates
  every mount-compatible chain from the package pool and ranks the
  feasible ones (5.3).
- **Check mode** — "does *this specific* rig reach this target?" Evaluates
  one fully-specified chain — explicit, or defaulted to the current rig
  (5.5) — and reports its interval, margins, feasibility, and where the
  target falls in its adjustable range (5.6). When infeasible, it runs a
  delta search against the current rig instead of solve mode's
  general fallback (5.7).

### 5.1 Inputs

- `target`: either `{ type: "fixed", height: H }` or
  `{ type: "range", low: L, high: Hi }`. **A range target is always a
  moveable one** — the move happens *during* the take (a boom or jib
  move), so only components whose adjustability (3.5) is `moveable` can
  execute it. Callers don't supply anything to say so. The data model
  still carries an optional `rangeType`, which defaults to `"moveable"`;
  passing `"adjustable"` explicitly means the height changes *between*
  setups within a scene instead, and both `moveable` and `adjustable`
  range count toward covering it. It is not a required input and no UI
  needs to ask for it.
- `packageId` — restricts the component pool to gear actually on the show
- `buildId` — the camera build in use
- `tolerance` — default **±0.5"**, user-adjustable
- `mode` — `"solve"` (default) or `"check"`
- Solve mode also takes `collapse` (default on, 5.3 step 4).
- Check mode additionally takes a `chain` selection (base item ids,
  support id, adapter ids with the mode each is used in, head id + mode
  name, build attach name). If omitted, it
  defaults to the current rig (5.5); if there is no current rig either,
  check mode has nothing to evaluate.

### 5.2 Evaluating a chain

However a chain was produced — enumerated by solve mode or specified
directly for check mode — it is scored the same way:

1. **Compute the interval.** Total rise is an interval `[min, max]`: sum
   of fixed rises (base layer, adapters, head mode, build attach point), plus the
   support's full adjustable range (using practical figures, minus
   `levelingLoss` from the top). Alongside it, compute the chain's
   **moveable interval** `[moveableMin, moveableMax]` the same way, but
   summing only range contributed by `moveable` components (3.5) — an
   `adjustable` sub-range like `legRange` (3.2) counts toward `[min,
   max]` but not toward the moveable interval. A chain with no `moveable`
   component anywhere in it has a zero-width moveable interval.
2. **Compute margin.** Two values, not one:
   - Fixed target `H`: `marginBelow = H - min`, `marginAbove = max - H`.
   - Range target `[L, Hi]`: `marginBelow = L - min`, `marginAbove = max -
     Hi`.
3. **Test feasibility.**
   - Fixed target: feasible if `H ∈ [min - tol, max + tol]` — equivalently
     `marginBelow >= -tol` and `marginAbove >= -tol`.
   - Range target, `rangeType: "adjustable"` (only when passed
     explicitly; see 5.1): feasible if
     `[L, Hi] ⊆ [min, max]` — the config must cover the whole move without
     re-rigging. Tolerance applies to the endpoints. The chain's
     adjustability (3.5) doesn't matter here — there's time between
     setups to use all of it, `moveable` or `adjustable` alike.
   - Range target, `rangeType: "moveable"` (the default): feasible only if the
     requested span fits within the moveable interval —
     `Hi - L <= moveableMax - moveableMin` (tolerance applies here too) —
     *and* the span itself sits inside the total interval,
     `[L, Hi] ⊆ [min, max]`. The moveable interval doesn't have to be
     positioned at `[L, Hi]` itself: any `adjustable` range elsewhere in
     the chain can reposition it anywhere the total interval allows, so
     only its *width* — how far it can move live — limits what a
     moveable target can ask for. A chain whose only range is
     `adjustable` has a zero-width moveable interval and so is rejected
     outright, same as before, no matter how wide `[min, max]` is.
4. **Locate the target in the adjustable range.** `targetPosition` is
   `(point - min) / (max - min)` — 0 at the bottom of the chain's
   reachable interval, 1 at the top — evaluated at `H` for a fixed target
   and at both `L` and `Hi` for a range target. Not meaningful when the
   chain has no adjustable range (`max === min`).

The output — `{ min, max, marginBelow, marginAbove, feasible,
targetPosition }` — is what both modes report; solve mode additionally
uses it to rank (5.3).

### 5.3 Solve mode

1. **Enumerate chains.** From the package pool, generate every valid
   chain: `[base layer combos] × [support] × [adapter combos] × [head mode] ×
   [build attach point]`. An adapter combo picks a mode for each adapter
   (3.6), and never uses the same adapter twice. Cap base-layer combos at
   2 items and adapter combos at 2 items (both configurable). A combo is
   stacked in whatever order makes its mounts and facings mate; a combo
   with no valid order is dropped. Prune aggressively on mount and facing
   mismatch, and reject any chain that breaks a hard rule in 2.1 (family,
   apple boxes on a dolly, apple-box faces) — each as its own check, not
   folded into mount compatibility.
2. **Evaluate each chain** (5.2). Keep the feasible ones.
3. **Score and sort.** Ranking priority, in order. This order is kept as
   a single ordered list of criteria in the implementation, so
   re-prioritizing is a one-line reordering, not a rewrite of the
   comparison logic:
   1. **Not a tripod on apple boxes** — a chain that puts a tripod on
      apple boxes sorts below every chain that doesn't, before anything
      else is considered. This is the *heavy* soft apple-box penalty
      (2.1): legal, but the case least worth doing, so it outweighs even
      margin. It is a ranking step, not a rule; the chain is still
      returned.
   2. **Most margin left** — sort by `min(marginBelow, marginAbove)`
      descending. This favors configs sitting mid-range, which is what
      leaves room to adjust on the day.
   3. **Most capable adjustability** — `moveable` > `adjustable` >
      `fixed`, using the most capable type found in the chain (3.5). This
      applies to every query, not only a `moveable` range target: a chain
      that *can* move live outranks one that can only be repositioned
      between setups, because it leaves more options open on the day.
   4. **No apple boxes** — sort by the number of apple boxes in the chain,
      fewest first. This is the *light* general apple-box penalty (2.1):
      among chains equal on the criteria above, one with an apple box sorts
      below one without. It is deliberately separate from the hard rule,
      from the heavy penalty, and from "fewest pieces" — it applies even
      when the piece counts tie.
   5. **Fewest pieces of gear** — count components in the chain,
      including each apple box and each adapter.
   6. **Fastest to rig** — configs whose support+head match the current
      rig (5.5) sort up.
   7. **Most stable** — penalize tall base stacks, low-stability box
      orientations, and configs near the top of a tripod's range.
4. **Collapse equivalent chains.** Adapter combinations multiply chains
   without adding real choices: a 6" riser plus a 12" riser and a single
   18" riser put the head in the same place. Chains that share the same
   **support, head, head mode, build attach point, and total adapter
   rise** are one result. Each result is the *simplest* chain in its group
   — fewest pieces of gear, ties broken by the ranking above — carrying
   the rest of the group as `alternates`, and `count`, the number of
   chains in the group (itself included). Results are then ordered by
   their representative. Base-layer choices are not part of the group key,
   so a group's alternates may differ in base layer as well as in which
   adapters make up the rise. Collapsing is on by default and can be
   turned off to get every chain flat.

### 5.4 Solve-mode failure output

When no chain is feasible, **do not return an empty result**. Return the
nearest achievable configuration and the shortfall:

> Closest: baby legs + 2575, tops out at 28.0". You're **4.0" short** of
> 32". Add a **half apple (4")** under the legs.

Compute this by finding the chain with the smallest absolute distance to
the target, then checking whether any available base-layer item or
combination closes the gap. Only base-layer gear the rules in 2 and 2.1
allow under that chain's support counts — no apple box under a dolly, no
track under sticks. Among combinations that close it, ones that avoid
apple boxes are preferred (a tripod on apple boxes last of all), then
fewest items. If the gap cannot be closed with gear in the package, say so
explicitly and name the rise that would be needed.

### 5.5 Current rig

The user can mark one specific chain as "built" — the rig actually
standing on set right now. This is a first-class concept the solver
depends on in two places, not a deferred nicety:

- **Solve-mode ranking criterion 6** (5.3) sorts a chain up when its
  support and head match the current rig — swapping base-layer items or
  flipping the camera mount is fast; swapping the legs or the head is not.
- **Check mode** (5.6) defaults to it when no explicit chain is given, and
  **delta search** (5.7) measures every candidate against it.

The current rig is stored as a full chain selection — base item ids,
support id, adapter ids and each adapter's mode, head id and mode name,
build attach name — not just a
support/head pair, so it can be reconstructed and evaluated exactly, not
approximated.

### 5.6 Check mode

Given a chain — explicit, or defaulted from the current rig (5.5) — check
mode resolves the referenced components and evaluates it (5.2). A
check-mode chain is not exempt from the mount and facing rules in section
2, or the hard rules in 2.1, just because the user specified it directly:
an invalid selection is rejected the same way solve mode prunes one during
enumeration, and the rejection says which rule it broke.

The result is the evaluation itself — interval, `marginBelow`,
`marginAbove`, `feasible`, and `targetPosition`. When infeasible, it also
runs the delta search below.

### 5.7 Delta search

When check mode is infeasible, the general "add any base-layer item"
fallback (5.4) isn't the most useful answer — the user already has a rig
built and wants the smallest change to it, not the single closest
alternative from scratch. Delta search looks for:

- **Additions** — one or more items from the package, not already in the
  current rig: base-layer items stacked under it, or adapters (a Mitchell
  riser, an offset) stacked between support and head. An added adapter is
  tried in each of its modes. Only additions the rules in 2 and 2.1 allow
  count: no apple box under a dolly, no adapter of the wrong family, no
  head mode left without the facing it needs.
- **Swaps** — replacing exactly one of support, head (and its mode),
  build attach point, or one adapter with a different one from the package
  pool (a 6" riser for a 12" one, an offset in another mode), holding
  everything else fixed. A swap that would break a rule is not a candidate.

Each added item or swapped slot counts as one change, and a candidate may
make at most **3 changes** in total (configurable) — past that it's a new
rig, not a change to this one. Candidates are ranked by **fewest changes**
first — not fewest pieces of gear, the solve-mode metric. Ties go to the
candidate that avoids the apple-box penalties in 5.3 (a tripod on apple
boxes last), then to margin, then to piece count. Adjustability (5.3
criterion 3) is not part of this ranking: fewest changes always dominates
in check mode, regardless of whether a candidate happens to be more
capable than the current rig. Only the best 10 candidates are returned,
along with how many there were in all. If no combination of additions or
swaps reaches the target, say so explicitly, the same way 5.4 does for
solve mode.

---

## 6. Non-height constraints (v2, but reserve the fields now)

Add optional boolean flags to components and to the query, so the data
model does not need refactoring later:

- `spreadRequired` — legs need floor space; blocks tight-corner setups
- `minTiltClearance` — how low the camera can tilt down before hitting
  the support
- `maxRake` — how far off level the support can still be used
- `weightLimit` — payload capacity vs. build weight

Query-side flags: `tightSpace`, `onSlope`, `needsLowTilt`.

---

## 7. App shape

- **Single-page PWA.** Installable to the home screen, no app store.
- **Offline-first.** Service worker caches the entire app shell and seed
  data. The app must be fully functional in airplane mode on first launch
  after install — no network calls in the query path, ever.
- **Local storage** for overrides, packages, builds, and current rig
  state. No account, no backend, no sync.
- **Hosted on GitHub Pages** from the repo, deploying on push.
- **Phone-first layout.** The primary screen is: target height input,
  package/build selector, results list. One thumb, held at chest height,
  in a dark room. Large tap targets, high contrast, no hover states.
- **Units:** decimal inches throughout, matching how heights are called on
  set. Store all values as inches (floating point). A metric display
  toggle is a nice-to-have; the storage unit does not change.

### 7.1 Data persistence caveat

iOS may evict cached site data after extended non-use. Home-screen PWAs
are considerably stickier than browser tabs, but the export-to-repo habit
is the real insurance. The app should prompt for an export if overrides
have changed and none has been taken in 30 days.

---

## 8. Build order

1. Data model + seed JSON with a handful of real, measured components.
2. Solver, with unit tests covering: fixed target, range target,
   underslung head (negative rise, both camera attach options), lambda underslung (negative head, upright camera), dolly boom, base-layer stacking,
   infeasible-with-suggestion.
3. Query UI + results list.
4. Gear editor + override layer + export/import.
5. PWA shell, service worker, offline verification.
6. Current rig state and ranking refinement.

Ship after step 5. Step 6 is what makes it live on the home screen rather
than in a bookmark.
