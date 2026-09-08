import { FastHttpSourceAdapter, FastHttpSessionOwner } from './fast-http-source-adapter';
import type { SourceAdapter, SourceScanRequest, SourceScanResult } from './source-adapter';

/** Narrow, transport-neutral capability consumed by MonitoringEngine. */
export interface ConcurrentSourceAdapter extends SourceAdapter {
  readonly maxConcurrentScans: number;
}

type WorkerFactory = (session: FastHttpSessionOwner, index: number) => SourceAdapter;

/**
 * Exactly two single-active FAST workers sharing one authenticated session owner.
 * Waiting scans are assigned FIFO; the pool never creates a browser/request context.
 */
export class FastHttpSourcePool implements ConcurrentSourceAdapter {
  readonly maxConcurrentScans = 2;
  private readonly workers: readonly [SourceAdapter, SourceAdapter];
  private readonly available: number[] = [0, 1];
  private readonly waiters: Array<(workerIndex: number) => void> = [];

  constructor(session: FastHttpSessionOwner, workerFactory: WorkerFactory = value => new FastHttpSourceAdapter(value)) {
    this.workers = [workerFactory(session, 0), workerFactory(session, 1)];
  }

  async scan(request: SourceScanRequest): Promise<SourceScanResult> {
    const workerIndex = await this.acquire();
    try {
      return await this.workers[workerIndex].scan(request);
    } finally {
      this.release(workerIndex);
    }
  }

  private acquire(): Promise<number> {
    const workerIndex = this.available.shift();
    if (workerIndex !== undefined) return Promise.resolve(workerIndex);
    return new Promise(resolve => this.waiters.push(resolve));
  }

  private release(workerIndex: number): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(workerIndex);
    else this.available.push(workerIndex);
  }
}
