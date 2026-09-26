// The app's version and last update (SPEC.md 7). The one place both live;
// package.json's version matches. Bump with every release.

export const VERSION = "0.7.0";
export const UPDATED = "2026-09-26T07:51:00-07:00";

/** "v0.7.0 · Updated Sep 26, 2026, 7:43 AM", in the viewer's time zone. */
export function versionNote(locale) {
  const when = new Date(UPDATED).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" });
  return `v${VERSION} · Updated ${when}`;
}
