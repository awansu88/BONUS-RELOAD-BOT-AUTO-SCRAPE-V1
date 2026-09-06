import { GoogleSheetsService } from './google-sheets-service';
import { SQLiteService } from './sqlite-service';
import { getLogger } from './logger-service';

export type RecoveryFailureClass =
  | 'SHEETS_APPEND'
  | 'LOCAL_FINALIZATION';

export interface PendingRecoveryResult {
  pendingFound: number;
  alreadyRemote: number;
  appended: number;
  reconciled: number;
  remaining: number;
  skipped: 'RUNNING' | 'SHEETS_UNAVAILABLE' | 'BACKOFF' | 'STOPPED' | null;
  failureClass: RecoveryFailureClass | null;
}

/**
 * The sole owner of durable export retries. SQLite `pending` rows are read in
 * their database-defined process_date order; browser fingerprint caches and
 * scrape duplicate detection are deliberately not consulted.
 */
export class PendingExportRecovery {
  private inFlight: Promise<PendingRecoveryResult> | null = null;
  private consecutiveFailures = 0;
  private nextAttemptAt = 0;

  constructor(
    private sqliteService: SQLiteService,
    private googleSheetsService: GoogleSheetsService,
    private shouldStop: () => boolean = () => false,
    private now: () => number = Date.now,
  ) {}

  recover(options: { force?: boolean; batchSize?: number } = {}): Promise<PendingRecoveryResult> {
    if (this.inFlight) {
      getLogger().info('[PENDING RECOVERY] skipped: recovery already running');
      return Promise.resolve(this.emptyResult('RUNNING'));
    }
    if (!options.force && this.now() < this.nextAttemptAt) {
      return Promise.resolve(this.emptyResult('BACKOFF'));
    }

    const operation = this.drain(Math.max(1, options.batchSize || 1000));
    this.inFlight = operation;
    operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = null;
    }).catch(() => undefined);
    return operation;
  }

  private async drain(batchSize: number): Promise<PendingRecoveryResult> {
    const startedAt = this.now();
    const logger = getLogger();
    if (this.shouldStop()) return this.emptyResult('STOPPED');
    if (!this.googleSheetsService.isConnected()) {
      logger.info('[PENDING RECOVERY] deferred: Google Sheets unavailable');
      return this.emptyResult('SHEETS_UNAVAILABLE');
    }

    const pending = await this.sqliteService.getPendingExports();
    const result: PendingRecoveryResult = {
      pendingFound: pending.length, alreadyRemote: 0, appended: 0,
      reconciled: 0, remaining: pending.length, skipped: null, failureClass: null,
    };
    if (pending.length === 0) {
      this.resetBackoff();
      return result;
    }

    logger.info(`[PENDING RECOVERY] pending rows found=${pending.length}, batchSize=${batchSize}`);
    let remoteKeyIds: Set<string>;
    try {
      remoteKeyIds = await this.googleSheetsService.getExportedKeyIds();
    } catch {
      result.failureClass = 'SHEETS_APPEND';
      this.scheduleBackoff();
      logger.warn('[PENDING RECOVERY] failure=SHEETS_APPEND stage=reconciliation-read');
      return result;
    }

    for (let offset = 0; offset < pending.length; offset += batchSize) {
      if (this.shouldStop()) {
        result.skipped = 'STOPPED';
        break;
      }
      const batch = pending.slice(offset, offset + batchSize);
      const alreadyRemote = batch.filter(t => remoteKeyIds.has(this.keyId(t.transactionFingerprint)));
      const missing = batch.filter(t => !remoteKeyIds.has(this.keyId(t.transactionFingerprint)));
      result.alreadyRemote += alreadyRemote.length;

      try {
        if (alreadyRemote.length > 0) {
          await this.sqliteService.updateExportStatus(
            alreadyRemote.map(t => t.transactionFingerprint), 'exported'
          );
          result.reconciled += alreadyRemote.length;
        }
      } catch {
        result.failureClass = 'LOCAL_FINALIZATION';
        this.scheduleBackoff();
        logger.error('[PENDING RECOVERY] failure=LOCAL_FINALIZATION stage=remote-reconciliation');
        break;
      }

      if (missing.length === 0) continue;
      if (this.shouldStop()) {
        result.skipped = 'STOPPED';
        break;
      }
      try {
        await this.googleSheetsService.appendTransactions(missing);
        result.appended += missing.length;
        for (const transaction of missing) {
          remoteKeyIds.add(this.keyId(transaction.transactionFingerprint));
        }
      } catch {
        result.failureClass = 'SHEETS_APPEND';
        this.scheduleBackoff();
        logger.warn('[PENDING RECOVERY] failure=SHEETS_APPEND stage=batch-write');
        break;
      }

      try {
        await this.sqliteService.updateExportStatus(
          missing.map(t => t.transactionFingerprint), 'exported'
        );
        result.reconciled += missing.length;
        const marker = this.keyId(missing[missing.length - 1].transactionFingerprint);
        await this.sqliteService.saveResumeMarker(marker);
      } catch {
        result.failureClass = 'LOCAL_FINALIZATION';
        this.scheduleBackoff();
        logger.error('[PENDING RECOVERY] failure=LOCAL_FINALIZATION stage=post-append');
        break;
      }
    }

    result.remaining = (await this.sqliteService.getPendingExports()).length;
    if (!result.failureClass && result.skipped !== 'STOPPED') this.resetBackoff();
    logger.info(
      `[PENDING RECOVERY] complete found=${result.pendingFound}, alreadyRemote=${result.alreadyRemote}, ` +
      `appended=${result.appended}, reconciled=${result.reconciled}, remaining=${result.remaining}, ` +
      `durationMs=${this.now() - startedAt}`
    );
    return result;
  }

  private keyId(fingerprint: string): string {
    // Frozen production identity: first eight uppercase SHA-1 characters.
    return fingerprint.substring(0, 8).toUpperCase();
  }

  private scheduleBackoff(): void {
    this.consecutiveFailures++;
    const delay = Math.min(60_000, 5_000 * (2 ** (this.consecutiveFailures - 1)));
    this.nextAttemptAt = this.now() + delay;
  }

  private resetBackoff(): void {
    this.consecutiveFailures = 0;
    this.nextAttemptAt = 0;
  }

  private emptyResult(skipped: PendingRecoveryResult['skipped']): PendingRecoveryResult {
    return {
      pendingFound: 0, alreadyRemote: 0, appended: 0, reconciled: 0,
      remaining: 0, skipped, failureClass: null,
    };
  }
}
