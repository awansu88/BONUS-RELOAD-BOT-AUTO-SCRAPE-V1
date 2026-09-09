import type { Page } from 'playwright';
import type { RawTransaction } from '../../types/transaction';
import { PageScanner } from '../services/page-scanner';
import type { PlaywrightService } from '../services/playwright-service';
import type { SourceAdapter, SourcePageBatch, SourceScanRequest, SourceScanResult } from './source-adapter';

export interface LegacyPageScanner {
  setShouldStop(predicate: () => boolean): void;
  setDuplicateCheck(predicate: ((raw: RawTransaction) => boolean) | null): void;
  scanPages(filter: SourceScanRequest['filter'], maxPages: number,
    onPage?: (page: SourcePageBatch) => Promise<void>): Promise<SourceScanResult>;
}

export type LegacyPageScannerFactory = (page: Page) => LegacyPageScanner;

/** The sole production source in Phase 2: the unchanged browser pagination path. */
export class LegacyBrowserSourceAdapter implements SourceAdapter {
  constructor(
    private playwrightService: PlaywrightService,
    private scannerFactory: LegacyPageScannerFactory = (page) => new PageScanner(page),
  ) {}

  async scan(request: SourceScanRequest): Promise<SourceScanResult> {
    const page = this.playwrightService.getPage();
    if (!page) throw new Error('Browser page not available');

    await this.playwrightService.applyFilter(
      {
        name: request.filter.name,
        agent: request.filter.agent,
        depositType: request.filter.depositType,
      },
      { manualDateMode: request.manualDateMode },
    );

    request.onScanStart?.();
    const scanner = this.scannerFactory(page);
    scanner.setShouldStop(request.shouldStop);
    scanner.setDuplicateCheck(request.initialSyncMode ? null : request.duplicateCheck);
    return scanner.scanPages(request.filter, request.maxPages, request.onPage);
  }
}
