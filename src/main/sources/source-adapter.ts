import type { FilterProfile } from '../../types/filter-profile';
import type { RawTransaction } from '../../types/transaction';

export interface PageStats {
  pageNumber: number;
  rowsDetected: number;
  rowsParsed: number;
  rowsRejected: number;
  duplicate: number;
  buffered: number;
  exported: number;
}

export type ScanTerminationReason =
  | 'END_OF_PAGINATION'
  | 'MAX_SCAN_REACHED'
  | 'FULL_DUPLICATE_PAGE'
  | 'STOP_REQUESTED'
  | 'NAVIGATION_FAILURE'
  | 'BROWSER_FAILURE'
  | 'HTTP_FAILURE'
  | 'SESSION_EXPIRED'
  | 'UNSAFE_RESPONSE';

export interface SourceScanResult {
  transactions: RawTransaction[];
  perPage: PageStats[];
  navigationFailure: boolean;
  terminationReason: ScanTerminationReason;
  lastPageScanned: number;
  configuredMaxPage: number;
}

export interface SourceScanRequest {
  filter: FilterProfile;
  manualDateMode: boolean;
  maxPages: number;
  initialSyncMode: boolean;
  shouldStop: () => boolean;
  duplicateCheck: (raw: RawTransaction) => boolean;
  /** Called after source preparation succeeds, immediately before acquisition starts. */
  onScanStart?: () => void;
}

/** Transport-neutral boundary for acquiring raw transaction rows. */
export interface SourceAdapter {
  scan(request: SourceScanRequest): Promise<SourceScanResult>;
}
