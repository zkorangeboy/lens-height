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
ground → [base layer] → [support] → [head] → [camera build] → optical center
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
one's `bottomMount`.

Mount type vocabulary (extend as needed):

- `ground` — rests on the floor
- `bowl-100`, `bowl-150` — tripod/dolly bowls
- `mitchell` — Mitchell mount
- `flat-38`, `flat-14` — flat plate with 3/8-16 or 1/4-20
- `euro` — Euro/Arri dovetail mount
- `dovetail` — camera dovetail plate
- `camera-base` — bottom of the camera body
- `optical-center` — terminal node; only the camera build produces this

The solver must reject chains with mismatched mounts rather than silently
summing them.

---

## 3. Component categories

### 3.1 Base layer (optional, stackable)

Raises the whole rig off the floor. `ground → ground`.

- **Apple boxes.** Standard dimensions, so each box offers multiple rises
  depending on orientation:
  - Full: 8", 12", 20"
  - Half: 4", 12", 20"
  - Quarter: 2", 12", 20"
  - Pancake: 1", 12", 20"
  In practice only the small faces are load-bearing under legs; flag the
  12"/20" orientations as `stability: low`.
- **Track + wedges.** Contributes a fixed rise (measure it — it is not
  zero, and it is the most commonly forgotten offset in the chain).
- **Skate wheels / soft tires** on a dolly: affects the dolly's own base
  rise; store as a variant rather than a separate base component.

Solver constraint: cap base-layer stacking at **2 items** by default,
configurable. Taller stacks are legal but should be ranked last.

### 3.2 Support

The component with the adjustable range. `ground → bowl-*` or
`ground → mitchell`.

- **Tripods** (baby, standard, tall). Rise is the bowl height interval.
  Store `specMin`/`specMax` *and* `practicalMin`/`practicalMax` — the
  practical figures account for leveling on a rake and for the legs
  actually clearing the spreader. The solver uses practical figures;
  the UI may show spec figures for reference.
- **Hi-hat / low hat.** Fixed rise, no range.
- **Dollies.** Rise is `baseRise + boomRange`, where `baseRise` is floor
  (or track) to the boom's zero point. The boom interval is usually the
  widest range in the system and is what makes a dolly answer a range
  query by itself.

Each support declares `levelingLoss` — inches of usable range sacrificed
to level on uneven ground (default 1"). Subtract from the top of the
interval.

### 3.3 Head

`bowl-* | mitchell → flat-38 | dovetail`. Fixed rise.

A head has one or more **modes**. Each mode stores:

- `rise` — signed distance from the head's support-side mount to its
  camera-side mount in that mode. Negative when the camera-side mount
  hangs below the support mount.
- `cameraMountFacing` — `up` or `down`: which way the camera-side mount
  faces in that mode.

Examples:

- **O'Connor, normal:** positive rise, facing `up`.
- **O'Connor, underslung:** negative rise, facing `down`. The plate now
  faces the floor, so the camera must attach either inverted by its base
  or upright by its top handle (see 3.4).
- **Lambda, underslung:** the head hangs from the dolly nose, so the rise
  from nose to bottom bracket is negative, but the bracket faces `up`.
  The camera sits on it normally and contributes its usual positive rise.

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
      "bottomMount": "bowl-150",
      "topMount": "flat-38",
      "modes": [
        { "name": "normal",     "rise": 6.75, "cameraMountFacing": "up" },
        { "name": "underslung", "rise": -4.5, "cameraMountFacing": "down" }
      ],
      "measured": true,
      "notes": "Measured bowl seat to top of plate, 2024-xx-xx"
    },
    {
      "id": "sachtler-baby-150",
      "name": "Sachtler Baby Legs 150",
      "category": "support",
      "bottomMount": "ground",
      "topMount": "bowl-150",
      "riseRange": { "specMin": 10.0, "specMax": 28.0,
                     "practicalMin": 11.0, "practicalMax": 27.0 },
      "levelingLoss": 1.0,
      "spreadRequired": true,
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

### 5.1 Inputs

- `target`: either `{ type: "fixed", height: H }` or
  `{ type: "range", low: L, high: Hi }`
- `packageId` — restricts the component pool to gear actually on the show
- `buildId` — the camera build in use
- `tolerance` — default **±0.5"**, user-adjustable

### 5.2 Algorithm

1. **Enumerate chains.** From the package pool, generate every
   mount-compatible chain: `[base layer combos] × [support] × [head mode] ×
   [build attach point]`. Cap base-layer combos at 2 items.
   Prune aggressively on mount mismatch.
2. **Compute the interval.** For each chain, total rise is an interval
   `[min, max]`: sum of fixed rises, plus the sum of adjustable ranges
   (using practical figures, minus `levelingLoss` from the top).
3. **Test feasibility.**
   - Fixed target: feasible if `H ∈ [min - tol, max + tol]`.
   - Range target: feasible if `[L, Hi] ⊆ [min, max]` — the config must
     cover the whole move without re-rigging. Tolerance applies to the
     endpoints.
4. **Score and sort.** Each feasible chain reports two margin values:
   `marginBelow` and `marginAbove`. For a fixed target `H`: `marginBelow =
   H - min`, `marginAbove = max - H`. For a range target `[L, Hi]`:
   `marginBelow = L - min`, `marginAbove = max - Hi`. Both values are
   carried on the result (and shown to the user); ranking priority uses
   them as follows, in order:
   1. **Most margin left** — sort by `min(marginBelow, marginAbove)`
      descending. This favors configs sitting mid-range, which is what
      leaves room to adjust on the day.
   2. **Fewest pieces of gear** — count components in the chain,
      including each apple box.
   3. **Fastest to rig** — configs whose support+head match the currently
      assembled rig (see 5.4) sort up.
   4. **Most stable** — penalize tall base stacks, low-stability box
      orientations, and configs near the top of a tripod's range.

### 5.3 Failure output

When no chain is feasible, **do not return an empty result**. Return the
nearest achievable configuration and the shortfall:

> Closest: baby legs + 2575, tops out at 28.0". You're **4.0" short** of
> 32". Add a **half apple (4")** under the legs.

Compute this by finding the chain with the smallest absolute distance to
the target, then checking whether any available base-layer item or
combination closes the gap. If the gap cannot be closed with gear in the
package, say so explicitly and name the rise that would be needed.

### 5.4 Current rig state (v1.5)

Let the user mark one configuration as "built". Feeds ranking criterion 3
and enables the most useful answer of all: *what is the smallest change to
the rig I already have?*

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
