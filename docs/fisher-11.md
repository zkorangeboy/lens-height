# J.L. Fisher Model 11 — gear model

Source: J.L. Fisher Model 11 brochure (3.07.2014), plus Zach's corrections.
Numbers are treated as correct and will be corrected by hand as needed.

---

## 1. The beam nose takes a nose fitting

The lift beam ends in a nose that accepts a **nose fitting**. The fitting
provides the Mitchell mount. Every Fisher 11 chain needs **exactly one** nose
fitting, the same way every chain needs exactly one head.

```
floor → [track] → Fisher 11 (wheels + beam) → [nose fitting] → adapters → head → camera
```

- New mount type `fisher-nose`: the dolly's top mount.
- New category **nose fitting**: bottom mount `fisher-nose`, top mount
  `mitchell`, `requiresFamily: "fisher"`.
- A Fisher chain without a nose fitting is incomplete, not illegal — treat it
  like a missing head.

---

## 2. Reference point

**Dolly on the floor on pneumatic tires, beam fully down, SLE upright at the
top of its adjustment (equal to SLE reversed): 17.875″.**

Checks against the brochure:

| Configuration                      | Beam down | Beam up  |
|------------------------------------|----------:|---------:|
| SLE upright, top of adjustment     | 17.875″   | 51.25″ (spec max) |
| SLE upright, bottom of adjustment  | 13.875″ (spec "standard head" min) | 47.25″ |
| SLE reversed                       | 17.875″   | 51.25″   |
| LHE                                | 3.0″ (spec) | 36.375″ (spec) |

Beam travel is 33.375″ in every configuration. The drawing shows 17.625″ for
SLE reversed; per Zach, reversed equals the top of the upright range, so
17.875″ is used.

---

## 3. Components

### Support: Fisher Model 11 Dolly

- `family: fisher`, `adjustability: moveable`
- `baseRise: 17.875`, `range: 0 → 33.375` (beam travel), `levelingLoss: 0`
- `topMount: fisher-nose`
- **Wheel set is a mode of the dolly**, because it decides what the dolly can
  sit on and shifts the whole rig:

| Wheel mode              | Rise  | Sits on                          |
|-------------------------|------:|----------------------------------|
| Pneumatic (standard)    | 0     | floor, or square track (built-in guides) |
| ETW round track wheels  | −0.5″ | round track only                 |
| Skateboard wheels       | +2″   | round track only                 |

### Track (base layer)

| Item          | Rise | Top mount     |
|---------------|-----:|---------------|
| Square track  | +2″  | `square-track` |
| Round track   | +2″  | `round-track`  |

Resulting totals vs. floor: square track + pneumatic +2″; round track + ETW
+1.5″; round track + skateboard +4″.

### Nose fittings

**SLE — 4-way Level Head** (standard package). Three modes:
- `upright`: rise **−4 → 0, adjustable** (hand screw, set between setups),
  Mitchell faces up
- `reversed`: rise 0, fixed, Mitchell faces up
- `underslung` (SLE mounted upside down): Mitchell faces **down**, rise
  **−8 → −4, adjustable** — *assumed value, not from the brochure*

**LHE — 4-way Low Level Head** (full package):
- rise −14.875, fixed, Mitchell faces up

Note: the SLE upright mode is the first *adjustable* range on a component
other than the support. The model needs to allow an adjustable range on a
nose fitting, and the drawing should show it as adjustable.

### Risers — Mitchell both ends, nominal heights, no family requirement

R3 (3″), R6 (6″), R12 (12″), RJ6 (6″), RJ12 (12″), RJ18 (18″).

### Offsets

**U — Camera Offset, 10″** and **TH — Camera Offset, 24″**: flat plates
with a Mitchell mount on both the top and the bottom of the offset end. No
flipping; the choice is which side you mount to:
- `top`: rise +1″, faces up
- `bottom`: rise 0, faces down

**RO — Rotating Offset**: rise +4″, faces up.

---

## 4. Out of scope for now

Center Mount (CM), crossarms, jib arms, bazooka, High Hat (HH), ESLE, LHA,
ball adapters and ball-adapter risers, UA, HBA, MEA, AP angle plate, rotating
offsets other than RO, and the Fisher fluid heads.
