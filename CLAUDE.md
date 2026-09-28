Read SPEC.md before any work. It is the source of truth for the data
model, the rules, and the height math — not for drawing, wording, or
styling. Plain HTML/CSS/JS, no frameworks, no build step.

Two tiers of work:

- **Model, rules, or height changes** (gear.json, src/model.js,
  src/solver.js, src/rules.js — anything that changes what a chain means
  or whether it's legal): update SPEC.md first. If a change conflicts
  with SPEC.md, stop and ask. Add tests. Run the suite.
- **Drawing, wording, or styling changes** (src/outlines.js, src/stack.js,
  styles.css, copy in app.js): edit the code, run the suite, take at most
  one screenshot. No SPEC.md updates, no new tests, no tap-through
  verification, no mutation checks. I'll check it on my phone.

Run the test suite only once, at the end of a task, not after each edit.
If it fails, fix and rerun only the failing tests, then run the full
suite once more at the end.
