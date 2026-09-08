export type SourceMode = 'AUTO' | 'FAST' | 'LEGACY';

/** Preserve the production Legacy path for absent, old, or malformed config. */
export function normalizeSourceMode(value: unknown): SourceMode {
  return value === 'AUTO' || value === 'FAST' || value === 'LEGACY' ? value : 'LEGACY';
}
