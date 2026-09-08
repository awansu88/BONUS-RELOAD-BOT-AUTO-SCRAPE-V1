import { RawTransaction, Transaction } from '../../types/transaction';
import { FingerprintGenerator } from './fingerprint-generator';
import { SQLiteService } from './sqlite-service';
import { TransactionValidator } from './transaction-validator';

export type CentralIngestResult =
  | { status: 'ACCEPTED'; fingerprint: string; transaction: Transaction }
  | { status: 'DUPLICATE'; fingerprint: string }
  | { status: 'REJECTED'; errors: string[] };

/**
 * The single authoritative acceptance boundary for parsed transactions.
 * A returned ACCEPTED row has already been durably claimed in SQLite.
 */
export class CentralIngestService {
  constructor(
    private validator: TransactionValidator,
    private fingerprintGenerator: FingerprintGenerator,
    private sqliteService: SQLiteService,
  ) {}

  async ingest(raw: RawTransaction, filterProfileName: string): Promise<CentralIngestResult> {
    const validation = this.validator.validate(raw);
    if (!validation.valid) {
      return { status: 'REJECTED', errors: validation.errors };
    }

    const fingerprint = this.fingerprintGenerator.generate(raw);
    const transaction: Transaction = {
      ...raw,
      transactionFingerprint: fingerprint,
      filterProfile: filterProfileName,
      exportStatus: 'pending',
    };

    const claimed = await this.sqliteService.claimTransaction(transaction);
    return claimed
      ? { status: 'ACCEPTED', fingerprint, transaction }
      : { status: 'DUPLICATE', fingerprint };
  }
}
