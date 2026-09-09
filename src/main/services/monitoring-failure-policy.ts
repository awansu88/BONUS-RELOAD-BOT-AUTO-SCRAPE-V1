import type { ScanTerminationReason } from '../sources/source-adapter';
import type { SourceMode } from '../../types/source-mode';

export type MonitoringFailureAction = 'RETRY' | 'PAUSE';

export interface MonitoringFailureContext {
  requestedMode?: SourceMode;
  effectiveMode?: SourceMode;
}

export interface MonitoringFailureDecision {
  action: MonitoringFailureAction;
  reason: string;
  retryInMs: number | null;
  consecutiveFailures: number;
}

/** A transport-neutral failure raised only after every trusted row was handed to ingest. */
export class MonitoringCycleSourceError extends Error {
  readonly isCycleFatal = true;
  requestedMode?: SourceMode;
  effectiveMode?: SourceMode;

  constructor(
    public readonly terminationReason: ScanTerminationReason,
    public readonly filterName: string,
    public readonly rowsHandedOff: number,
  ) {
    super(`Source scan failed (${terminationReason}) for filter "${filterName}"`);
    this.name = 'MonitoringCycleSourceError';
    Object.setPrototypeOf(this, MonitoringCycleSourceError.prototype);
  }
}

const PAUSE_REASONS = new Set([
  'SESSION_EXPIRED', 'UNSAFE_RESPONSE',
  'REQUEST_FORM_MISSING', 'REQUEST_PARAMETER_MISSING', 'REQUEST_METHOD_UNSUPPORTED',
  'REQUEST_URL_INVALID', 'REQUEST_ORIGIN_UNSAFE',
]);
const RUNTIME_PREREQUISITES = new Set(['BROWSER_PAGE_UNAVAILABLE', 'REQUEST_CONTEXT_UNAVAILABLE']);

/** Stateful only for the deterministic consecutive-retry ladder; classification has no I/O. */
export class MonitoringFailurePolicy {
  private consecutiveFailures = 0;

  decide(error: unknown, context: MonitoringFailureContext = {}): MonitoringFailureDecision {
    const candidate = error as { terminationReason?: unknown; code?: unknown } | null;
    const reason = typeof candidate?.terminationReason === 'string'
      ? candidate.terminationReason
      : typeof candidate?.code === 'string' ? candidate.code : 'UNKNOWN_CYCLE_FATAL';
    const pause = PAUSE_REASONS.has(reason)
      || (RUNTIME_PREREQUISITES.has(reason) && context.requestedMode !== 'AUTO');

    if (pause) {
      return { action: 'PAUSE', reason, retryInMs: null, consecutiveFailures: this.consecutiveFailures };
    }

    this.consecutiveFailures++;
    const retryInMs = Math.min(5000 * (2 ** (this.consecutiveFailures - 1)), 60000);
    return { action: 'RETRY', reason, retryInMs, consecutiveFailures: this.consecutiveFailures };
  }

  reset(): void { this.consecutiveFailures = 0; }
}
