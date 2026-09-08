import Database from 'better-sqlite3';
import { Transaction } from '../../types/transaction';
import { AppDirectoryManager } from './app-directory-manager';
import { DatabaseMigration } from './database-migration';
import { getLogger } from './logger-service';
import { formatDateTime } from '../../utils/date-utils';

export class SQLiteService {
  private db: Database.Database | null = null;
  private claimTransactionStatement: Database.Statement | null = null;
  private pendingExportCountStatement: Database.Statement | null = null;
  
  constructor(private appDirManager: AppDirectoryManager) {}
  
  async initialize(): Promise<void> {
    const logger = getLogger();
    const dbPath = this.appDirManager.getDatabasePath();
    logger.info(`Initializing SQLite database at: ${dbPath}`);
    
    this.claimTransactionStatement = null;
    this.pendingExportCountStatement = null;
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    
    const migration = new DatabaseMigration(this.db);
    await migration.migrate();
    
    logger.success('SQLite database initialized');
  }
  
  async loadFingerprints(dateThreshold?: Date): Promise<Set<string>> {
    if (!this.db) throw new Error('Database not initialized');
    
    let query = 'SELECT transaction_fingerprint FROM transactions';
    const params: any[] = [];
    
    if (dateThreshold) {
      query += ' WHERE process_date >= ?';
      params.push(formatDateTime(dateThreshold));
    }
    
    const results = this.db.prepare(query).all(...params) as { transaction_fingerprint: string }[];
    const fingerprints = new Set(results.map(r => r.transaction_fingerprint));
    getLogger().info(`Loaded ${fingerprints.size} fingerprints`);
    
    return fingerprints;
  }
  
  async getLatestProcessDate(): Promise<string | null> {
    if (!this.db) throw new Error('Database not initialized');
    
    const result = this.db.prepare(
      'SELECT process_date FROM transactions ORDER BY process_date DESC LIMIT 1'
    ).get() as { process_date: string } | undefined;
    
    return result?.process_date || null;
  }
  
  async insertTransactions(transactions: Transaction[]): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    
    const insertStmt = this.db.prepare(`
      INSERT OR IGNORE INTO transactions (
        transaction_fingerprint, user_id, account_number, amount,
        process_date, filter_profile, export_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    
    const insertMany = this.db.transaction((txns: Transaction[]) => {
      for (const txn of txns) {
        insertStmt.run(
          txn.transactionFingerprint,
          txn.userName,
          txn.accountNumber,
          txn.amount,
          txn.processDate,
          txn.filterProfile,
          txn.exportStatus,
          formatDateTime(new Date())
        );
      }
    });
    
    insertMany(transactions);
    getLogger().info(`Inserted ${transactions.length} transactions`);
  }

  /**
   * Atomically claims a fingerprint for one transaction. The UNIQUE
   * constraint is the dedupe authority; conflicts preserve the first row.
   */
  async claimTransaction(transaction: Transaction): Promise<boolean> {
    if (!this.db) throw new Error('Database not initialized');

    if (!this.claimTransactionStatement) {
      this.claimTransactionStatement = this.db.prepare(`
      INSERT INTO transactions (
        transaction_fingerprint, user_id, account_number, amount,
        process_date, filter_profile, export_status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(transaction_fingerprint) DO NOTHING
    `);
    }
    const result = this.claimTransactionStatement.run(
      transaction.transactionFingerprint,
      transaction.userName,
      transaction.accountNumber,
      transaction.amount,
      transaction.processDate,
      transaction.filterProfile,
      transaction.exportStatus,
      formatDateTime(new Date())
    );

    return result.changes === 1;
  }
  
  async updateExportStatus(fingerprints: string[], status: 'pending' | 'exported' | 'failed'): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    
    const updateStmt = this.db.prepare(`
      UPDATE transactions SET export_status = ?, exported_at = ?
      WHERE transaction_fingerprint = ?
    `);
    
    const updateMany = this.db.transaction((fps: string[]) => {
      const exportedAt = status === 'exported' ? formatDateTime(new Date()) : null;
      for (const fp of fps) {
        updateStmt.run(status, exportedAt, fp);
      }
    });
    
    updateMany(fingerprints);
    getLogger().info(`Updated ${fingerprints.length} to status: ${status}`);
  }
  
  async getPendingExports(): Promise<Transaction[]> {
    if (!this.db) throw new Error('Database not initialized');
    
    const results = this.db.prepare(
      'SELECT * FROM transactions WHERE export_status = ? ORDER BY process_date ASC'
    ).all('pending') as any[];
    
    return results.map(r => this.mapToTransaction(r));
  }

  async getPendingExportCount(): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');
    if (!this.pendingExportCountStatement) {
      this.pendingExportCountStatement = this.db.prepare(
        "SELECT COUNT(*) AS count FROM transactions WHERE export_status = 'pending'"
      );
    }
    const result = this.pendingExportCountStatement.get() as { count: number };
    return result.count;
  }
  
  async getTodayExportCount(): Promise<number> {
    if (!this.db) throw new Error('Database not initialized');
    
    const today = new Date().toISOString().split('T')[0];
    const result = this.db.prepare(
      `SELECT COUNT(*) as count FROM transactions 
       WHERE export_status = 'exported' AND DATE(exported_at) = ?`
    ).get(today) as { count: number };
    
    return result.count;
  }
  
  /**
   * Total rows currently persisted in the transactions table. Used by the
   * Dashboard "Stored Transactions" counter.
   */
  async getStoredTransactionCount(): Promise<number> {
    if (!this.db) return 0;
    const result = this.db.prepare('SELECT COUNT(*) as count FROM transactions').get() as { count: number };
    return result.count;
  }

  /**
   * Resume Marker — the KEY_ID (short fingerprint) of the newest transaction
   * that was successfully exported to Google Sheets. Persisted in the
   * `app_state` table so the app can resume without duplicates or gaps
   * after restart or crash. Google Sheets remains the production source of
   * truth; SQLite is a fast local cache for resume + crash recovery.
   *
   * The marker is only ever advanced AFTER the Sheets append + Mark-Exported
   * steps have succeeded (see MonitoringEngine.exportBuffer).
   */
  async saveResumeMarker(keyId: string): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare(
      `INSERT INTO app_state(key, value, updated_at) VALUES('resume_marker', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    ).run(keyId, formatDateTime(new Date()));
  }

  async getResumeMarker(): Promise<string | null> {
    if (!this.db) return null;
    const row = this.db.prepare(
      `SELECT value FROM app_state WHERE key = 'resume_marker'`
    ).get() as { value: string } | undefined;
    return row?.value ?? null;
  }

  async cleanupOldRecords(daysToKeep: number): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - daysToKeep);
    
    const result = this.db.prepare(
      'DELETE FROM transactions WHERE created_at < ?'
    ).run(formatDateTime(cutoffDate));
    
    getLogger().info(`Cleaned up ${result.changes} old records`);
  }
  
  async vacuum(): Promise<void> {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare('VACUUM').run();
  }

  /**
   * Read-only accessor exposed for MaintenanceService (iteration 12).
   * Do NOT use this from the monitoring engine or scraping pipeline —
   * schema access continues to flow through the typed methods above.
   */
  getDb(): Database.Database | null {
    return this.db;
  }

  isReady(): boolean {
    return this.db !== null;
  }
  
  close(): void {
    this.claimTransactionStatement = null;
    this.pendingExportCountStatement = null;
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
  
  private mapToTransaction(row: any): Transaction {
    return {
      userName: row.user_id,
      bank: '',
      accountName: '',
      accountNumber: row.account_number,
      amount: row.amount,
      status: 'Approved',
      done: 'Yes',
      depositType: '',
      agent: '',
      processDate: row.process_date,
      // The SQLite schema pre-dates iter-9 and does not store Created At;
      // preserving the schema is required. For retry-queue rows that
      // survived a restart, GoogleSheetsService.formatRow falls back to
      // processDate when createdAt is empty (see the operator-facing
      // TIME STAMP contract).
      createdAt: '',
      transactionFingerprint: row.transaction_fingerprint,
      filterProfile: row.filter_profile,
      exportStatus: row.export_status
    };
  }
}
