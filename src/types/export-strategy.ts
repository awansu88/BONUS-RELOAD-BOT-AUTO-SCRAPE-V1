export type ExportStrategy = 'BATCHED' | 'PER_PAGE';

/** Preserve the pre-13C behavior for missing or unrecognised persisted values. */
export function normalizeExportStrategy(value: unknown): ExportStrategy {
  return value === 'PER_PAGE' ? 'PER_PAGE' : 'BATCHED';
}
