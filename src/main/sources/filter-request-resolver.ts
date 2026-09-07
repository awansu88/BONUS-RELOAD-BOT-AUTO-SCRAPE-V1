import { FilterProfile } from '../../types/filter-profile';
import { formatPanelDate } from '../../utils/date-utils';

export type FilterControl =
  | { kind: 'SELECT'; options: RuntimeFilterOption[] }
  | { kind: 'FREE_TEXT' }
  | { kind: 'UNAVAILABLE' };

export interface RuntimeFilterOption {
  value: string;
  label: string;
}

export interface RuntimeDateValue {
  available: boolean;
  value: string;
}

export interface FilterRuntimeSnapshot {
  payment: FilterControl;
  status: FilterControl;
  agent: FilterControl;
  dateFrom: RuntimeDateValue;
  dateTo: RuntimeDateValue;
}

export type FilterResolutionSource = 'VALUE' | 'LABEL' | 'LITERAL';

export interface ResolvedFilterValue {
  value: string;
  source: FilterResolutionSource;
}

export interface ResolvedFilterRequest {
  payment?: ResolvedFilterValue;
  agent?: ResolvedFilterValue;
  status: ResolvedFilterValue;
  dateFrom: string;
  dateTo: string;
  manualDateMode: boolean;
}

export type FilterResolutionField = 'payment' | 'status' | 'agent' | 'dateFrom' | 'dateTo';
export type FilterResolutionErrorCode =
  | 'PROFILE_PAYMENT_CONFLICT'
  | 'PAYMENT_UNAVAILABLE'
  | 'PAYMENT_AMBIGUOUS'
  | 'STATUS_UNAVAILABLE'
  | 'STATUS_AMBIGUOUS'
  | 'AGENT_UNAVAILABLE'
  | 'AGENT_AMBIGUOUS'
  | 'AGENT_CONTROL_UNSUPPORTED'
  | 'MANUAL_DATE_REQUIRED'
  | 'RUNTIME_CONTROL_UNAVAILABLE';

export class FilterResolutionError extends Error {
  constructor(
    public readonly code: FilterResolutionErrorCode,
    public readonly field: FilterResolutionField,
    public readonly profileName?: string,
  ) {
    super(`Filter resolution failed (${code}) for ${field}`);
    this.name = 'FilterResolutionError';
    Object.setPrototypeOf(this, FilterResolutionError.prototype);
  }
}

export interface ResolveFilterOptions {
  manualDateMode: boolean;
  now?: Date;
}

const LEGACY_STATUS = 'Approve';

function trimmed(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function failure(
  code: FilterResolutionErrorCode,
  field: FilterResolutionField,
  profile: FilterProfile,
): never {
  throw new FilterResolutionError(code, field, trimmed(profile.name) || undefined);
}

function resolveSelect(
  requested: string,
  control: FilterControl,
  field: 'payment' | 'status' | 'agent',
  profile: FilterProfile,
): ResolvedFilterValue {
  if (control.kind !== 'SELECT') {
    failure('RUNTIME_CONTROL_UNAVAILABLE', field, profile);
  }

  const options = control.options.map(option => ({
    value: trimmed(option.value),
    label: trimmed(option.label),
  }));
  if (options.some(option => option.value === requested)) {
    return { value: requested, source: 'VALUE' };
  }

  // Duplicate DOM rows are one semantic choice when their raw values agree.
  const labelValues = [...new Set(
    options.filter(option => option.label === requested).map(option => option.value),
  )];
  if (labelValues.length === 1) return { value: labelValues[0], source: 'LABEL' };
  if (labelValues.length > 1) {
    const code = field === 'payment' ? 'PAYMENT_AMBIGUOUS'
      : field === 'status' ? 'STATUS_AMBIGUOUS' : 'AGENT_AMBIGUOUS';
    failure(code, field, profile);
  }

  const code = field === 'payment' ? 'PAYMENT_UNAVAILABLE'
    : field === 'status' ? 'STATUS_UNAVAILABLE' : 'AGENT_UNAVAILABLE';
  failure(code, field, profile);
}

function requestedPayment(profile: FilterProfile): string | undefined {
  const payment = trimmed(profile.payment);
  const depositType = trimmed(profile.depositType);
  if (payment && depositType && payment !== depositType) {
    failure('PROFILE_PAYMENT_CONFLICT', 'payment', profile);
  }
  return payment || depositType || undefined;
}

/** Pure Phase 3 semantic resolver. It does not read or mutate browser state. */
export class FilterRequestResolver {
  resolve(
    profile: FilterProfile,
    runtime: FilterRuntimeSnapshot,
    options: ResolveFilterOptions,
  ): ResolvedFilterRequest {
    const paymentRequest = requestedPayment(profile);
    const agentRequest = trimmed(profile.agent) || undefined;

    const payment = paymentRequest
      ? resolveSelect(paymentRequest, runtime.payment, 'payment', profile)
      : undefined;
    const status = resolveSelect(LEGACY_STATUS, runtime.status, 'status', profile);

    let agent: ResolvedFilterValue | undefined;
    if (agentRequest) {
      if (runtime.agent.kind === 'FREE_TEXT') {
        agent = { value: agentRequest, source: 'LITERAL' };
      } else if (runtime.agent.kind === 'SELECT') {
        agent = resolveSelect(agentRequest, runtime.agent, 'agent', profile);
      } else {
        failure('AGENT_CONTROL_UNSUPPORTED', 'agent', profile);
      }
    }

    let dateFrom: string;
    let dateTo: string;
    if (options.manualDateMode) {
      if (!runtime.dateFrom.available) failure('RUNTIME_CONTROL_UNAVAILABLE', 'dateFrom', profile);
      if (!runtime.dateTo.available) failure('RUNTIME_CONTROL_UNAVAILABLE', 'dateTo', profile);
      dateFrom = runtime.dateFrom.value;
      dateTo = runtime.dateTo.value;
      if (!trimmed(dateFrom)) failure('MANUAL_DATE_REQUIRED', 'dateFrom', profile);
      if (!trimmed(dateTo)) failure('MANUAL_DATE_REQUIRED', 'dateTo', profile);
    } else {
      const today = formatPanelDate(options.now ?? new Date());
      dateFrom = today;
      dateTo = today;
    }

    return {
      ...(payment ? { payment } : {}),
      ...(agent ? { agent } : {}),
      status,
      dateFrom,
      dateTo,
      manualDateMode: options.manualDateMode,
    };
  }
}
