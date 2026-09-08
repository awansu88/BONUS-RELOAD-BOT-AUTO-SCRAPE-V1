import { PendingExportRecovery, PendingRecoveryResult } from './pending-export-recovery';

export interface ExportDrainOptions {
  force?: boolean;
  batchSize?: number;
}

/**
 * Serializes signals to drain SQLite's durable pending-export queue.
 *
 * This queue deliberately owns no transaction data. Every signal gets its own
 * recovery invocation and result, in FIFO order. Rejections are propagated to
 * their caller while the internal tail is repaired for the next signal.
 */
export class ExportWriterQueue {
  private tail: Promise<void> = Promise.resolve();

  constructor(private pendingExportRecovery: PendingExportRecovery) {}

  enqueue(options: ExportDrainOptions = {}): Promise<PendingRecoveryResult> {
    const recoveryOptions = { ...options };
    const request = this.tail.then(() => this.pendingExportRecovery.recover(recoveryOptions));
    this.tail = request.then(
      () => undefined,
      () => undefined,
    );
    return request;
  }
}
