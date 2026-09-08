import type { SourceMode } from '../../types/source-mode';
import { normalizeSourceMode } from '../../types/source-mode';
import type { FastHttpSessionOwner } from './fast-http-source-adapter';
import type { SourceAdapter } from './source-adapter';

export type EffectiveSourceMode = 'FAST' | 'LEGACY';

export interface FastReadiness {
  ready: boolean;
  reason: 'FAST_READY' | 'BROWSER_PAGE_UNAVAILABLE' | 'BROWSER_PAGE_CLOSED'
    | 'REQUEST_CONTEXT_UNAVAILABLE' | 'BROWSER_URL_UNAVAILABLE' | 'INVALID_BROWSER_ORIGIN';
}

/** Reads existing objects only. It performs no request and creates no runtime object. */
export function evaluateFastReadiness(session: FastHttpSessionOwner): FastReadiness {
  const page = session.getPage();
  if (!page) return { ready: false, reason: 'BROWSER_PAGE_UNAVAILABLE' };
  if (typeof page.isClosed === 'function' && page.isClosed())
    return { ready: false, reason: 'BROWSER_PAGE_CLOSED' };
  if (!session.getRequestContext()) return { ready: false, reason: 'REQUEST_CONTEXT_UNAVAILABLE' };
  let url: URL;
  try { url = new URL(page.url()); }
  catch { return { ready: false, reason: 'BROWSER_URL_UNAVAILABLE' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return { ready: false, reason: 'INVALID_BROWSER_ORIGIN' };
  return { ready: true, reason: 'FAST_READY' };
}

export interface CycleSourceSelection {
  requestedMode: SourceMode;
  effectiveMode: EffectiveSourceMode;
  source: SourceAdapter;
  reason: 'EXPLICIT' | FastReadiness['reason'];
}

export class SourceModeSelector {
  constructor(
    private readonly legacySource: SourceAdapter,
    private readonly fastSource: SourceAdapter,
    private readonly session: FastHttpSessionOwner,
  ) {}

  getFastReadiness(): FastReadiness { return evaluateFastReadiness(this.session); }

  selectForCycle(value: unknown): CycleSourceSelection {
    const requestedMode = normalizeSourceMode(value);
    if (requestedMode === 'LEGACY')
      return { requestedMode, effectiveMode: 'LEGACY', source: this.legacySource, reason: 'EXPLICIT' };
    const readiness = this.getFastReadiness();
    if (requestedMode === 'FAST')
      return { requestedMode, effectiveMode: 'FAST', source: this.fastSource,
        reason: readiness.ready ? 'EXPLICIT' : readiness.reason };
    return readiness.ready
      ? { requestedMode, effectiveMode: 'FAST', source: this.fastSource, reason: 'FAST_READY' }
      : { requestedMode, effectiveMode: 'LEGACY', source: this.legacySource, reason: readiness.reason };
  }
}
