// Display formatting for heights, rises, and margins (SPEC.md 7). The one
// place a number is rounded for display: to the nearest ¼″, written as a
// fraction the way heights are called on set. All math keeps full
// precision; nothing here feeds back into it.

const QUARTERS = ["", "¼", "½", "¾"];
const MINUS = "−";

/**
 * A magnitude as a fraction, no sign and no unit: 17.8 -> "17¾" (nearest
 * ¼), 6 -> "6", 0.25 -> "¼". An exact eighth sits halfway between quarters;
 * it rounds toward zero, so the Fisher's 17.875″ reads 17¾″ as it's called
 * on set. A value that isn't zero but rounds to zero is "<¼", so a
 * shortfall or margin never reads as nothing.
 */
function magnitude(n) {
  const size = Math.abs(n);
  const quarters = Math.ceil(size * 4 - 0.5);
  if (quarters === 0) return size === 0 ? "0" : "<¼";
  const whole = Math.floor(quarters / 4);
  const part = QUARTERS[quarters % 4];
  return whole === 0 ? part : `${whole}${part}`;
}

/** 17.875 -> "17¾″", -4 -> "−4″", 0 -> "0″", 0.1 -> "<¼″". */
export function inches(n) {
  return `${n < 0 ? MINUS : ""}${magnitude(n)}″`;
}

/** A rise, always signed unless zero: 6 -> "+6″", -13 -> "−13″", 0 -> "0″". */
export function signedInches(n) {
  return `${n > 0 ? "+" : n < 0 ? MINUS : ""}${magnitude(n)}″`;
}

/** A span of heights, one unit mark: (20, 32.5) -> "20–32½″". */
export function inchesSpan(low, high) {
  return `${low < 0 ? MINUS : ""}${magnitude(low)}–${inches(high)}`;
}
