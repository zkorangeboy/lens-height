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
ground → [base layer] → [support] → [nose fitting] → [adapters] → [head] → [camera build] → optical center
```

The nose fitting is present only on a support whose top needs one (a
J.L. Fisher dolly's beam nose, 3.7).

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
`bottomMount` as a list and accepts any of them (a Fisher 11 on pneumatic
tires sits on `ground` *or* on `square-track`).

Mount type vocabulary (extend as needed):

- `ground` — rests on the floor
- `square-track`, `round-track` — the top of square or round dolly track.
  Which a dolly can ride on depends on its wheel mode (3.2).
- `fisher-nose` — the nose of a J.L. Fisher beam. Only a nose fitting
  (3.7) accepts it; the nose fitting provides the Mitchell mount.
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
  dimensions. **One component per box size**, carrying `boxSize` (`full`,
  `half`, `quarter`, `pancake`) and `orientation`. A full apple can stand
  on more than one face, so its orientation is a **mode** — the same
  shape as an adapter's modes (3.6): each mode has a `name`, `label`,
  `rise`, `orientation`, and optional `stability`, overriding the
  component's own. Half, quarter, and pancake have no modes and stay flat:
  - Full: modes `flat` 8", `12in` 12" face, `20in` 20" face
  - Half: 4" flat
  - Quarter: 2" flat
  - Pancake: 1" flat
  Only a full apple may stand on its 12" or 20" face (2.1) — a half,
  quarter, or pancake on those faces is invalid, not merely unstable.
  Flag the 12"/20" modes of a full apple as `stability: low`. A chain
  selection names each moded base item's mode (`baseModes`, like
  `adapterModes`), defaulting to the first.
  Apple boxes may not go under a dolly (2.1); under a tripod they're legal
  but heavily penalized in ranking.
- **Track** (`kind: "track"`). **Square track** (`ground → square-track`)
  and **round track** (`ground → round-track`), each +2". Its rise is not
  zero, and it is the most commonly forgotten offset in the chain. Only a
  dolly in a wheel mode that rides that track can sit on it (3.2): a tripod
  cannot be put on track. It goes on top of the base stack, and at most one
  fits in a chain.
- **Rolling spreaders** (`kind: "spreader"`, `floor → spreader`), +3",
  fixed. They sit on the **bare floor only** — nothing goes underneath
  them, not an apple box, not track. A base item whose `bottomMount` is
  `floor` can only be the first item of the base stack: the floor itself
  presents both `ground` and `floor`, while an apple box's top presents
  only `ground`. Their top is a `spreader` mount, which **only sticks**
  accept (baby and standard sticks list it in their `bottomMount`); a
  hi-hat, low hat, or dolly can't sit on them. Not an apple box, so no
  apple-box penalty applies.
- **Wheels** are not a base item: a dolly's wheel set is a *mode of the
  dolly* (3.2), because it decides both the rise and what the dolly can sit
  on.

Solver constraint: cap base-layer stacking at **2 items** by default,
configurable. Taller stacks are legal but should be ranked last.

### 3.2 Support

The component with the adjustable range. Tripods, hi-hats, and low hats
present a `mitchell` top and sit on `ground` only, so sticks can't be put
on track; sticks alone also sit on rolling spreaders (3.1). The J.L. Fisher 11 presents a `fisher-nose` top that needs a nose
fitting (3.7), and what it sits on depends on its wheel mode.

**Support modes: wheel sets.** A support may declare `modes`, each with a
`name`, `label`, `rise` (an offset added to the whole support), and its own
`bottomMount`. A dolly's wheel set is such a mode. The Fisher 11
(docs/fisher-11.md):

| Wheel mode | Rise | Sits on |
|---|---:|---|
| Pneumatic (standard) | 0 | floor, or square track |
| ETW round track wheels | −0.5" | round track only |
| Skateboard wheels | +2" | round track only |

A chain selection names the support's mode (`supportMode`), defaulting to
the first that fits what's beneath it.

A support declares a `kind` — `tripod`, `dolly`, `hi-hat`, or `lo-hat` —
which the apple-box rules key off (2.1): a dolly forbids apple boxes, a
tripod on them is penalized in ranking.

- **Tripods** (`kind: "tripod"`; "sticks"). Rise is the bowl height
  interval, `adjustable`. Seed data: **Baby sticks** 20"–36" and
  **Standard sticks** 36"–66", both `ground` or `spreader` → `mitchell`.
  Store `specMin`/`specMax` *and* `practicalMin`/`practicalMax` — the
  practical figures account for leveling on a rake and for the legs
  actually clearing the spreader. The solver uses practical figures;
  the UI may show spec figures for reference.
- **Hi-hat / low hat** (`kind: "hi-hat"`, `"lo-hat"`). Fixed rise, no range.
- **Dollies** (`kind: "dolly"`). Rise is `baseRise + boomRange`, where `baseRise` is floor
  (or track) to the boom's zero point. For the Fisher 11, `baseRise` 17.875"
  is the floor to the nose with the beam fully down on pneumatic tires,
  measured so that an SLE nose fitting at 0 puts the Mitchell there, and
  `boomRange` is the 33.375" beam travel, with `levelingLoss` 0. The boom interval is usually the
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

A support may declare a `family` (2.1) — the dolly family nose fittings
and adapters can require.

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
  hi-hat top all face up, so what supplies it is the bottom side of a
  Mitchell offset (3.6), or an SLE nose fitting mounted underslung (3.7). An underslung mode is therefore
  rejected directly on a tripod. (If omitted, `up`.)

Examples:

- **O'Connor, normal:** positive rise, facing `up`, needs an `up` mount
  beneath. Seed data: the **O'Connor 2575D**, Mitchell base, +8.5″ normal;
  its underslung rise is entered as −8.5″, a placeholder to be corrected.
- **O'Connor, underslung:** negative rise, facing `down`, needs a `down`
  mount beneath. The plate now faces the floor, so the camera must attach
  either inverted by its base or upright by its top handle (see 3.4).
- **Lambda, underslung and overslung:** the lambda's bracket is about 13"
  from its mount. Underslung, the bracket hangs from the nose (rise about
  −13"); overslung, it stands above it (about +13"). Either way the bracket
  faces `up`: the camera sits on it normally and contributes its usual
  positive rise, and the nose is an ordinary up-facing mount, so both modes
  need an `up` mount beneath and no offset — "underslung" describes the
  rise, not the mount.

A head that holds the camera inside its own frame (the lambda) declares
`cradlesCamera: true`. It changes nothing about height or compatibility;
it tells the drawing (5.8) to draw the camera inside the head's cradle.

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
- `shortName` — every component (and build) has one, for its tag in the
  drawing (7.2): "SLE", "LHE", "Riser 6″", "2575".
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

Kinds modeled:

Adapters are generic Mitchell gear, not tied to a brand:

- **Mitchell risers** — 3", 6", 12", 18", 24". `mitchell → mitchell`,
  positive rise, no `requiresFamily`, so they work on any support the
  mounts allow. Their top always faces `up`.
- **Mitchell offsets, 10" and 24"** — flat plates with a Mitchell mount on
  both the top and the bottom of the offset end. There's no flipping; the
  mode is which side the next piece mounts to:
  - `top`: rise +1", top mount faces `up`.
  - `bottom`: rise 0", top mount faces `down`.
  The bottom side is what hangs a head: it presents the down-facing mount
  an underslung head mode requires (3.3). Each declares its real
  `plateLength` (10", 24"): the next piece mounts that far forward, and the
  drawing shows the plate at that length (5.8).
- **Rotating offset**: rise +4", faces `up`. Drawn as a swivel; it has no
  plate length in the data, so it doesn't move the chain sideways.

### 3.7 Nose fitting

`category: "nose"`. **A J.L. Fisher beam ends in a nose that takes a nose
fitting, and the fitting provides the Mitchell mount** (docs/fisher-11.md).
`fisher-nose → mitchell`, `requiresFamily: "fisher"`.

- A support whose top is `fisher-nose` needs **exactly one** nose fitting,
  the way every chain needs exactly one head. Without one the rig is
  *incomplete*, not illegal: check mode asks for one. Any other support
  takes none.
- Nose fittings have modes, like heads. A mode has either a fixed `rise`
  or an adjustable `riseRange` (`min`, `max`) with `adjustability:
  "adjustable"` (a hand screw, set between setups), plus `mountFacing` for
  its Mitchell. **This is the first adjustable range on a component other
  than the support**: it widens the chain's interval (5.2) and is drawn as
  adjustable (5.8).
- **SLE — 4-way Level Head**: `upright` rise −4" to 0", adjustable, faces
  up; `reversed` rise 0, fixed, faces up; `underslung` (mounted upside
  down) rise −8" to −4", adjustable, faces **down** (an assumed value, not
  from the brochure).
- **LHE — 4-way Low Level Head**: rise −14.875", fixed, faces up. It
  declares `hangsAsBracket: true`: it hangs the Mitchell well below the
  beam, and is drawn as an L-bracket whose foot sets the Mitchell forward
  of the nose, so what it carries stands clear of the beam (5.8). The SLE
  doesn't: it's a block on the nose, and the Mitchell stays right there.

Brochure checks (Mitchell height above the floor, pneumatic tires, on the
floor): SLE upright 13.875"–17.875" beam down, 47.25"–51.25" beam up; SLE
reversed 17.875" / 51.25"; LHE 3" / 36.375".

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
      "notes": "Mount seat to top of plate"
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
      "spreadRequired": true
    },
    {
      "id": "mitchell-riser-6",
      "name": "Mitchell riser 6\"",
      "category": "adapter",
      "bottomMount": "mitchell",
      "topMount": "mitchell",
      "rise": 6.0,
      "mountFacing": "up"
    },
    {
      "id": "fisher-lhe",
      "name": "LHE — 4-way Low Level Head",
      "category": "nose",
      "bottomMount": "fisher-nose",
      "topMount": "mitchell",
      "requiresFamily": "fisher",
      "modes": [{ "name": "fixed", "rise": -14.875, "mountFacing": "up" }]
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

**All gear values are treated as correct.** There is no "measured" or
"estimated" flag: a number that turns out wrong is corrected by hand, in
the seed or in the override layer below.

### 4.1 Override layer

User edits are **never written into `gear.json`**. They go to a separate
object in local storage, keyed by component id and field:

```json
{
  "schemaVersion": 1,
  "overrides": {
    "oconnor-2575": { "rise": 6.5 },
    "sachtler-baby-150": { "riseRange": { "practicalMax": 26.0 } }
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

**Solve mode is frozen and hidden from the UI — not removed.** The app's
one screen is check mode (7.2). The solve-mode code, its tests, and
`cli.js` stay in the repo and stay passing, and UI work does not touch
them; nothing in the UI calls solve mode. Shared pieces (5.2's evaluation,
the chain rules) keep serving both.

**Delta search (5.7) is frozen and hidden from the UI the same way.**
`checkChain` still runs it and its tests stay passing, but the check screen
evaluates the rig directly (`buildChain` + `evaluateChain`) and shows no
suggested fixes: the user edits the rig in the drawing instead (7.2).

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
  needs to ask for it. A range entered high-to-low is read low-to-high
  (`normalizeTarget`), so a UI never has to compare heights.
- `packageId` — restricts the component pool to gear actually on the show
- `buildId` — the camera build in use
- `tolerance` — default **±0.5"**, user-adjustable
- `mode` — `"solve"` (default) or `"check"`
- Solve mode also takes `dropDominated` (default on, 5.3 step 4) and
  `collapse` (default on, 5.3 step 5).
- Check mode additionally takes a `chain` selection (base item ids with
  their modes, support id and wheel mode, nose fitting id and mode, adapter
  ids with the mode each is used in, head id + mode name, build attach
  name). If omitted, it
  defaults to the current rig (5.5); if there is no current rig either,
  check mode has nothing to evaluate.

### 5.2 Evaluating a chain

However a chain was produced — enumerated by solve mode or specified
directly for check mode — it is scored the same way:

1. **Compute the interval.** Total rise is an interval `[min, max]`: sum
   of fixed rises (base layer, adapters, head mode, build attach point), plus the
   support's full adjustable range (using practical figures, minus
   `levelingLoss` from the top, plus its wheel mode's offset), plus the nose
   fitting's range (its `riseRange`, or its fixed `rise` at both ends). Alongside it, compute the chain's
   **moveable interval** `[moveableMin, moveableMax]` the same way, but
   summing only range contributed by `moveable` components (3.5) — an
   `adjustable` sub-range like `legRange` (3.2) or a nose fitting's
   `riseRange` (3.7) counts toward `[min, max]` but not toward the
   moveable interval. A chain with no `moveable`
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
targetPosition, shortfall }` — is what both modes report; solve mode
additionally uses it to rank (5.3).

`shortfall` is `null` when the chain is feasible. Otherwise it says how far
off the chain is, in one of three directions, so a UI never has to subtract
heights itself:

- `short` — the target sits above the chain's reach; `amount` is how far
  above (`H - max`, or `Hi - max` for a range).
- `tall` — the target sits below it; `amount` is how far below.
- `span` — the target is inside the chain's reach but a moveable range is
  wider than the moveable interval can travel; `amount` is the missing
  travel, with `needed` (the span) and `available` (the moveable width).

`short` and `tall` are checked first, `span` only when the position is
fine.

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
4. **Drop dominated chains.** Before anything is collapsed, remove chains
   that another chain beats outright. Chain B is **dominated** if some
   other chain A has all of:
   - `marginBelow` at least B's, and `marginAbove` at least B's;
   - no more pieces of gear than B;
   - adjustability (3.5) at least as capable as B's;
   - no ranking penalty that B lacks — each penalty in 5.3 step 3 (a tripod
     on apple boxes, the number of apple boxes, the stability penalty) is no
     worse in A than in B;

   *and* is strictly better than B on at least one of them. A chain that
   ties another on every one of these is not dominated by it; both stay.
   Dominated chains are **dropped entirely** — they are not kept as
   alternates. Dominance is judged across every feasible chain, not just
   within a group.

   Note what this does not do. The two margins always add up to the
   chain's range width, so a chain that moves the target closer to one end
   of its range (a taller riser) gains on one margin and loses on the
   other. Two such chains on the same support are therefore incomparable,
   and both survive; only a chain that changes nothing but the piece count
   or a penalty (6" + 12" against a single 18", an apple box against an
   equal plate) is dropped for it.
5. **Collapse equivalent chains.** Chains that share the same **support,
   head, head mode, and build attach point** are one result, whatever
   adapters and base-layer items they add. Each result is its group's
   **best-ranked** chain under the ranking in step 3 — not the simplest —
   carrying the rest of the group as `alternates` (best-ranked first) and
   `count`, the number of chains in the group (itself included). Results
   are ordered by their representative. Collapsing is on by default and
   can be turned off to get every chain flat.

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

The current rig is stored as a full chain selection — base item ids and
modes, support id and wheel mode, nose fitting id and mode, adapter ids and
each adapter's mode, head id and mode name, build attach name — not just a
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
`marginAbove`, `feasible`, and `targetPosition`. When infeasible,
`checkChain` also runs the delta search below (frozen and not shown in the
UI, 5).

**The verdict.** The check screen's one-line answer is a view model too
(`checkVerdict` in `src/verdict.js`), so the UI never compares heights:

- **Feasible** — what the rig does and its *tightest* margin in plain
  words: "Reaches 32″ · 4″ to spare at bottom", "Covers 20–32″ · only ½″
  to spare at top". The tightest of `marginBelow` ("at bottom"),
  `marginAbove` ("at top"), and — for a moveable range — the moveable
  travel left over once the move fits ("of moveable travel"). A margin
  inside the tolerance but below zero reads "¼″ past the top, within
  tolerance".
- **Tight** — feasible, but the tightest margin is under **1″**. Same
  words, prefixed "only", and shown in the warning color.
- **Infeasible** — the shortfall (5.2) in plain words: "3½″ too short",
  "3½″ too tall", "Needs 4″ more moveable travel".
- **Waiting** — no target yet: the rig's reach, and a prompt for a target.

The verdict is the only place margins are stated; the drawing has no
margin tags (5.8).

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

### 5.8 Stack layout

The ground-up picture (7.2) is a computed view model, not something the UI
derives from raw rises. `stackLayout(chain, target, options)` returns
everything a renderer needs — heights, horizontal positions, and pixel
boxes for a drawing of a given size — so the UI does no height math.

- **Blocks, bottom to top:** one per base item, the support (in its wheel
  mode), the nose fitting (if any, in its mode), each adapter, the head (in
  its mode), and the camera build (at its attach point). Each has its signed
  `rise`, a `kind` (`fixed`, `adjustable`, or `moveable`, 3.5), its
  `bottom` and `top` in inches (its lower and upper end, whichever way it
  runs), and `bottomPct` / `topPct` / `heightPct`. A block with a negative
  rise extends downward from where the piece below ended. The floor is
  height 0 and the lens is at the end of the last block.
- **Rigged to the target.** The chain is drawn set up to put the lens at the
  target: a fixed target's height, or the low end of a range (the move
  starts there), clamped into the chain's reach. The extension needed is
  allocated adjustable first — the support's legs, then a nose fitting's
  range — and moveable last, so everything set between setups positions
  the rig and the boom takes what's left. A nose fitting with a range is an
  `adjustable` block, and carries its `range`.
- **The support is split into parts** — its fixed base, its adjustable
  extension, its moveable extension — so each can be filled as what it is.
  Its block carries the support's `range` (min and max rise) alongside the
  rise at this setup.
- **Horizontal position.** Every block carries `x`, its horizontal position
  in inches (0 is the center of the base and support; forward, toward the
  lens, is positive), and `mountX`, where the next piece mounts. **Every
  piece sits on the mount of the piece below it**, with no gap and no
  connecting part the gear doesn't have. The chain moves sideways only where
  a piece really moves it: a Fisher's nose sits a fixed distance forward of
  the chassis and **doesn't move as the beam rises**; an offset plate moves
  the next piece by its real `plateLength`; the LHE's foot sets the
  Mitchell forward of the nose. Jib arms will later carry their own `x` the
  same way.
- **True scale on both axes.** One inch is the same number of pixels
  horizontally and vertically, for every piece; nothing is squeezed.
  Widths are real where the gear gives them (the Fisher 11 from its
  brochure: 40" long, 28" wheelbase, push posts 39.75" off the floor; an
  apple box by the face it stands on; an offset plate's length) and
  simplified but true-to-size otherwise (a head, a riser, a camera).
- **Scale fits the current rig and the target.** The drawing spans every
  piece as it's set now (including the Fisher's push posts and chassis),
  the target or move band, and the beam at the top of a moving range —
  vertically from the floor (or the lowest piece) to just above the
  highest of those, horizontally across all of them — at the largest one
  scale that fits both ways. The full reach does *not* stretch it; the
  reach rail is clipped. The caller passes the drawing's size in pixels
  (`frame`); the layout returns each block's pixel `box` (the bounding box
  of its outline: `x`, `y`, `width`, `height`, y measured down from the
  top), its `mount` point, and a `shape` saying which outline draws it
  (7.2) with that outline's own pixel points — a tripod's leg spread; a
  dolly's wheels (per wheel mode), chassis, deck, rear box, push posts,
  beam pivot and nose; an offset's side and far end; a camera's body, lens,
  and optical center, and whether it's inverted.
- **The Fisher beam.** The beam is drawn from a fixed pivot on the chassis
  to the nose at its current height; its angle is visual only. For a
  moveable range target the layout also gives the nose at the bottom and
  top of the move (`shape.ghosts`), so both ends can be drawn faintly.
  **The lift beam has zero horizontal travel**: the nose rises straight
  up. This is confirmed from years of use on the dolly; the brochure's
  side-elevation drawing implies the nose moves along an arc and is wrong
  on this point. The drawing does not follow the brochure here.
- **Bands:** `reach` is every lens height the chain can reach; `moveable`
  is the span the moveable portion can sweep from this setup (or `null` if
  the chain has none); `target` is the target's position — a line for a
  fixed height, a band for a range. All carry `bottomPct` / `topPct` /
  `heightPct`. `reach` and `moveable` are **clipped** to the drawing, with
  `continuesAbove` / `continuesBelow` saying so; `reach` also carries its
  real `min` and `max`, the labels at the rail's bottom and top.
- **No margin tags.** The margins are stated once, in the verdict (5.6);
  the drawing's rail shows the reach they're measured against.
- **Tags, not labels.** The drawing takes the full width; there is no
  label column. Each piece has a small `tag` — its `shortName` from the
  gear ("SLE", "LHE", "Riser 6″", "2575"), and for an inverted camera
  a second line, "Camera inverted — flip image" — placed beside the piece
  (to its right, or its left if there's no room), nudged up or down so no
  two tags overlap. The full name and rise are in the piece's sheet.
- **Insertion points** (`gaps`) are identified by slot and index: `base` 0
  is the floor, `base` *i* sits on base item *i*−1; `adapter` 0 sits on
  the nose fitting (or the support, if it takes none), `adapter` *i* on
  adapter *i*−1. Each carries its pixel `point`, where the Add flow's
  marker for it is drawn (7.2).

### 5.9 What may attach

Each slot in check mode offers only what can legally attach to what's
below it. That logic lives in `rules.js`, built from the same primitives
chain validation uses (2, 2.1), and the UI calls it rather than knowing any
of it:

- `slotOptions` — for every slot, every candidate, whether it's available
  given the picks below it, and if not, a plain-language reason.
- `revalidatePicks` — after any change, walk the picks ground up and drop
  or adjust whatever the change made illegal, returning plain-language notes
  saying why.
- `defaultPicks` — the first legal rig, for a fresh start.
- `modeControl` — whether a set of modes is shown as text, a toggle, or a
  dropdown.
- `insertOptions` — for every insertion point (5.8), what may be added
  there.
- `addOptions` — everything that can legally be added to the rig
  anywhere, one entry per component, each with the positions (slot and
  index, 5.8) where it fits, and a plain-words description of each for
  accessibility ("on the floor", "under O'Connor 2575D"). An item is
  added in its first mode that fits at the chosen position.
- `swapOptions` — for one piece of the rig, what may replace it.
- `applyEdit` — turn an insert, swap, remove, or mode change into the next
  picks, which then go through `revalidatePicks` like any other change.

**Picks are kept in stack order.** `revalidatePicks` returns the base items
and adapters in the order they physically stack, ground up, so the picks,
the chain, and the drawing agree on what "index 2" is.

**Adding and swapping at a position.** The drawing edits the rig where the
user tapped, so these are positional, not "anywhere in the stack":

- An item may be **inserted** at an insertion point if, in exactly that
  position, it mounts and faces right on what's below and what's above
  mounts and faces right on it; it passes its own rules (apple-box face,
  family, not already in the rig, no apple box under a dolly); and the rest
  of the rig survives revalidation without losing a piece. A head mode or
  camera mount that has to *switch* doesn't disqualify it — that's how an
  offset switched to its bottom side takes the head and camera with it. A
  multi-mode item fits a position if any of its modes does.
- A base item or adapter may be **swapped** for another on the same terms,
  in its place. A support may be swapped for any other that sits on the
  base layer; a head for any other with a legal mode. Adapters that no
  longer fit the new support are removed with a note, as in any change.
- Base items and adapters can be **removed**; the support and head can
  only be swapped, never left empty by an edit.
- Options that don't fit still carry their reason (for tests and
  debugging); the UI shows only the ones that fit.

The slots, ground up, and what each requires of what's beneath it:

1. **Base layer** (several): stacks on the base items already picked, from
   the ground (mounts, one track at most), and passes item rules (an
   apple-box face that isn't allowed is never offered).
2. **Support**, with its wheel mode: a support is offered if any mode sits
   on the top of the base stack, and it isn't a dolly if the base layer has
   an apple box (2.1). A wheel mode that stopped fitting switches to one
   that does, with a note.
3. **Nose fitting**, with its mode — only when the support's top is
   `fisher-nose` (3.7), and then exactly one. It must match the support's
   family. Missing, the rig is incomplete and check mode asks for one, as
   for a missing head. A nose fitting on a support that doesn't take one is
   cleared.
4. **Adapters** (several, each in a mode): mounts and faces right on top of
   the nose fitting, or the support if there is none, and the adapters
   below; matches the support's family (2.1), and isn't already used.
5. **Head**, with its mode: a head is offered if any mode is legal; a mode
   is legal if the mount and facing beneath the head suit it (3.3).
6. **Camera attach point**: mates with the head mode's camera-mount facing
   (3.3, 3.4).

**When a pick changes.** Picks are revalidated ground up. A base item,
support, adapter, or head that a change made illegal is *cleared*, and a
plain note says why ("Dolly can't go on apple boxes, so it was cleared").
A pick above an empty required slot is kept, and revalidated once that slot
is filled. A head mode or attach point that became illegal *switches* to the
first legal option instead — the same as flipping a toggle off — with a
note.

**Toggles, not dropdowns.** A mode named `underslung`, or an attach point
that is `inverted`, is offered as an on/off toggle rather than a dropdown,
and only when both states are legal right now (an underslung head mode needs
a down-facing mount beneath it, 3.3). When only one state is legal it's
shown as plain text, with the reason the other isn't available as a hint.
The camera attach point toggles between inverted and hung-from-the-handle
for an underslung head; for a normal head only the upright mount is legal,
so there's nothing to toggle.

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
- **Phone-first layout.** The one screen is check mode (7.2): target
  height at the top, a one-line verdict, then the rig drawing, which is
  also where the rig is edited. One thumb, held at chest height, in a dark room. Large tap
  targets, high contrast, no hover states. A package or build selector
  only appears when there is more than one to choose from.
- **Units:** inches throughout. Store all values as inches (floating
  point) and keep full precision in all math. **Display** every height,
  rise, and margin rounded to the nearest ¼" and written as a fraction —
  17¾", 6", 13¾", −¼" — the way heights are called on set. Rounding is
  display-only and lives in one formatting function in `src/`
  (`src/format.js`) that the UI and the verdict call. A value that isn't
  zero but rounds to zero displays as "<¼"", so a shortfall or a
  margin is never shown as 0. A metric display toggle is a nice-to-have;
  the storage unit does not change.

### 7.1 Data persistence caveat

iOS may evict cached site data after extended non-use. Home-screen PWAs
are considerably stickier than browser tabs, but the export-to-repo habit
is the real insurance. The app should prompt for an export if overrides
have changed and none has been taken in 30 days.

### 7.2 The check screen

Check mode is the app; solve mode and delta search are frozen and not
shown (5). The screen is built around a drawing of the rig. There is no
submit button: every change to the target or the rig recomputes
immediately. There is no summary card and no list of fixes. One column,
top to bottom:

1. **Target**, compact — a single height, or a range (two heights). A range
   is always a moveable range (5.1); there is nothing to choose.
2. **Verdict** — one line (5.6): "✓ Covers 20–32″ · only ½″ to spare at
   top", "✗ 3½″ too short". Green when feasible, the warning color when
   feasible but the tightest margin is under 1″, red when not.
3. **The drawing** (5.8) — the main element, full width: a simplified 2D
   side view of each piece, one kind of outline per kind of gear, at true
   scale on both axes and stretched to each piece's real bottom and top
   heights. Pieces connect: each sits on the mount of the one below. The
   moveable / adjustable / fixed fills sit inside the outlines. Each piece
   carries a small tag with its short name beside it; there's no label
   column. **The target line or move band is the one strong line**,
   across the full width. A rail on the left shows the reach, labeled
   with its lowest and highest lens heights, and the moveable sweep; where
   the reach runs past the drawing it is clipped and marked as continuing.
   The drawing's border takes the status color.

   The outlines (`src/outlines.js`, one module; each draws shapes only,
   inside the pixel box and points the layout hands it, and does no height
   math):
   - **Tripod** — splayed legs that stretch with the set height.
   - **Hi-hat, low hat** — a short stand on a spread base.
   - **Apple box** — a box sized by the face it stands on, with hand holes.
   - **Track** — rails on ties; square or round rails.
   - **Rolling spreaders** — a low spreader with a caster at each end,
     under the tripod feet.
   - **Fisher dolly** — a side elevation from the brochure's dimension
     drawing, simplified, not traced: a low chassis about 40" long with a
     raised rear box, one wheel at each end on a 28" wheelbase (drawn per
     wheel mode: pneumatic tires, ETW grooved track wheels, skateboard
     wheels under a plate), push posts at the rear 39.75" off the floor, and
     the lift beam pivoting on the chassis and rising forward to the nose.
     The nose stays at one horizontal position as it rises. For a moveable
     range target, faint outlines of the beam at the bottom and top of the
     move.
   - **SLE** — a small block with a plate. **LHE** — a short L-bracket
     hanging from the nose, its foot carrying the Mitchell forward.
   - **Riser** — a cage. **Offset** — a plate with a Mitchell on its top and
     bottom, the side in use marked. **Rotating offset** — a swivel.
   - **Fluid head** (the O'Connor 2575D) — pan base, tilt body, plate; upside down when
     underslung. **Lambda** — a cradle around the camera.
   - **Camera** — one outline, body and lens together, with the lens dot at
     the optical center; drawn upside down when inverted.
4. **Edit in the drawing** (5.9). Tapping a piece — anywhere in its
   outline, or its tag — opens a sheet to swap it, change its mode (a
   toggle for two states, a segmented choice for more, like a full apple's
   faces), or remove it. **One Add button** under the drawing opens a
   sheet of everything that can legally be added to the rig. Choosing an
   item closes the sheet; if it has exactly one legal attach point it goes
   straight there, and otherwise its legal attach points appear on the
   drawing as highlighted markers (positions from the layout, 5.8;
   legality from `rules.js`, 5.9), each with at least a 44px hit area. Tap
   a marker to insert there; tap anywhere else to cancel. There is no text
   list of positions. Sheets show only compatible options, with no list of
   what doesn't fit. The camera's sheet holds its mount (upright,
   inverted, top handle). A change that invalidates another pick clears or
   switches it with a plain-language note. There are no checkbox lists or
   dropdown sections.

**Information appears once.** Each piece shows only its short name, on its
tag in the drawing; its full name and signed rise are in its sheet. No
text legend beside the drawing. All gear values are treated as correct, so
there's no "estimated" marking (4). "Camera inverted — flip image" appears
once, on the camera's tag. A base
layer over the stacking cap is noted in a line under the drawing. Adjustability is always called
**moveable / adjustable / fixed** (3.5), in the drawing's key and in the
words.

**The UI is thin.** `index.html` and `app.js` collect input, call the solver
and `rules.js`, and render what comes back. All height math (intervals,
margins, shortfalls, stack positions) and all compatibility logic (mounts,
facing, family, apple boxes) stay in `src/`, and so does formatting a
number as a fraction (7): the UI calls it rather than rounding anything
itself.

---

## 8. Build order

1. Data model + seed JSON with a handful of real components.
2. Solver, with unit tests covering: fixed target, range target,
   underslung head (negative rise, both camera attach options), lambda underslung (negative head, upright camera), dolly boom, base-layer stacking,
   infeasible-with-suggestion.
3. Query UI + results list.
4. Gear editor + override layer + export/import.
5. PWA shell, service worker, offline verification.
6. Current rig state and ranking refinement.

Ship after step 5. Step 6 is what makes it live on the home screen rather
than in a bookmark.
