/**
 * paramDiff.ts — pure dirty-set helper for the Faust param push path.
 *
 * AudioEngine posts UI settings to the DSP worklet; pushing a value the
 * worklet already has wastes a structured-clone postMessage and a param-path
 * lookup on the worklet thread. This helper diffs against a "last applied"
 * map and calls back only for the values that actually changed.
 *
 * Pure and dependency-free on purpose: unit-tested in scripts/test-audio.ts
 * (t22). AudioEngine itself is browser-only (WebAudio + WASM) and cannot run
 * under Node.
 */

/** Tolerance below which two param values count as "the same". UI sliders
 *  produce stable floats, so this is effectively equality. */
export const PARAM_EPS = 1e-9;

/**
 * For each entry in `values` (in key order), call `apply(name, value)` only
 * when the value differs from `lastApplied` by more than PARAM_EPS, and
 * record the new value in `lastApplied` (mutated in place — it is the
 * caller's cache). Returns the names actually applied.
 */
export function applyChangedParams(
  lastApplied: Map<string, number>,
  values: Record<string, number>,
  apply: (name: string, value: number) => void,
): string[] {
  const applied: string[] = [];
  for (const name of Object.keys(values)) {
    const value = values[name];
    const last = lastApplied.get(name);
    if (last !== undefined && Math.abs(value - last) < PARAM_EPS) continue;
    lastApplied.set(name, value);
    applied.push(name);
    apply(name, value);
  }
  return applied;
}
