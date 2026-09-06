import { google } from 'googleapis';
import { GoogleAuth } from 'google-auth-library';
import fs from 'fs';
import { Transaction } from '../../types/transaction';
import { GoogleSheetsConfig, ConnectionTestResult, HeaderValidationResult } from '../../types/google-sheets';
import { AppDirectoryManager } from './app-directory-manager';
import { getLogger } from './logger-service';
import { WORKSHEET_NAME, EXPECTED_HEADERS, COLUMN } from '../../utils/constants';

/**
 * Result of a Google Sheets export, used by MonitoringEngine to log the
 * destination range and advance the Resume Marker.
 */
export interface ExportResult {
  startRow: number;
  endRow: number;
  rowsWritten: number;
  destinationRange: string;
  spreadsheetId: string;
  spreadsheetTitle: string;
  worksheetName: string;
}

export class GoogleSheetsService {
  private sheetsClient: any = null;
  private currentConfig: GoogleSheetsConfig | null = null;
  
  constructor(private appDirManager: AppDirectoryManager) {}
  
  async saveCredentialFile(sourcePath: string): Promise<string> {
    if (!fs.existsSync(sourcePath)) {
      throw new Error('Credential file not found');
    }
    
    try {
      const content = fs.readFileSync(sourcePath, 'utf8');
      const json = JSON.parse(content);
      
      if (!json.client_email || !json.private_key) {
        throw new Error('Invalid service account JSON. Missing required fields.');
      }
    } catch (error: any) {
      if (error.message.includes('Missing required fields')) throw error;
      throw new Error('Invalid JSON format.');
    }
    
    const destPath = this.appDirManager.getCredentialFilePath();
    fs.copyFileSync(sourcePath, destPath);
    getLogger().info(`Credential copied to: ${destPath}`);
    
    return destPath;
  }
  
  async testConnection(credentialPath: string, spreadsheetId: string): Promise<ConnectionTestResult> {
    const logger = getLogger();
    
    try {
      logger.info('Testing Google Sheets connection...');
      
      if (!fs.existsSync(credentialPath)) {
        throw new Error('Credential file not found.');
      }
      
      let credentialJson: any;
      try {
        credentialJson = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
      } catch {
        throw new Error('Invalid JSON format.');
      }
      
      if (!credentialJson.client_email || !credentialJson.private_key) {
        throw new Error('Invalid service account JSON.');
      }
      
      const serviceAccountEmail = credentialJson.client_email;
      
      const auth = new GoogleAuth({
        keyFile: credentialPath,
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });
      
      const authClient = await auth.getClient();
      const sheets = google.sheets({ version: 'v4', auth: authClient as any });
      
      let spreadsheet;
      try {
        spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
      } catch (error: any) {
        if (error.code === 404) throw new Error('Spreadsheet not found.');
        if (error.code === 403) throw new Error(`Permission denied. Share with: ${serviceAccountEmail}`);
        throw error;
      }
      
      const spreadsheetTitle = spreadsheet.data.properties?.title || 'Unknown';
      const worksheets = spreadsheet.data.sheets || [];
      const masterWorksheet = worksheets.find((s: any) => s.properties?.title === WORKSHEET_NAME);
      
      if (!masterWorksheet) {
        const available = worksheets.map((s: any) => s.properties?.title).filter(Boolean).join(', ');
        throw new Error(`Worksheet "MASTER" not found. Available: ${available || 'none'}`);
      }
      
      const headerValidation = await this.validateHeaders(sheets, spreadsheetId);
      
      if (headerValidation.empty) {
        await this.initializeHeaders(sheets, spreadsheetId);
        this.sheetsClient = sheets;
        return {
          success: true, serviceAccountEmail, spreadsheetTitle,
          worksheetName: WORKSHEET_NAME,
          message: 'Connection successful. Headers initialized.',
          headersInitialized: true
        };
      }
      
      if (!headerValidation.valid) {
        throw new Error(headerValidation.message);
      }
      
      this.sheetsClient = sheets;
      logger.success('Connection test successful');
      
      return {
        success: true, serviceAccountEmail, spreadsheetTitle,
        worksheetName: WORKSHEET_NAME,
        message: 'Connection successful. Worksheet format valid.',
        headersInitialized: false
      };
      
    } catch (error: any) {
      logger.error('Connection test failed', error);
      return { success: false, message: error.message || 'Unknown error', error: error.message };
    }
  }
  
  private async validateHeaders(sheets: any, spreadsheetId: string): Promise<HeaderValidationResult> {
    try {
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId, range: `${WORKSHEET_NAME}!B1:E1`
      });
      
      const headers = response.data.values?.[0] || [];
      
      if (headers.length === 0) {
        return { valid: false, empty: true, message: 'Empty worksheet. Will initialize.' };
      }
      
      const expected = Object.values(EXPECTED_HEADERS);
      const errors: string[] = [];
      
      expected.forEach((exp, i) => {
        const actual = headers[i]?.trim() || '';
        if (actual !== exp) {
          const col = String.fromCharCode(66 + i);
          errors.push(`Column ${col}: Expected "${exp}", found "${actual || '(empty)'}"`);
        }
      });
      
      if (errors.length > 0) {
        return { valid: false, empty: false, errors, message: 'Invalid headers. ' + errors.join('. ') };
      }
      
      return { valid: true, empty: false, message: 'Headers valid' };
    } catch (error: any) {
      return { valid: false, empty: false, message: `Failed: ${error.message}` };
    }
  }
  
  private async initializeHeaders(sheets: any, spreadsheetId: string): Promise<void> {
    getLogger().info('Initializing headers...');
    
    // Only write header labels into columns B..E — the operator-owned
    // ArrayFormula cells in A, F and I must never be touched by the app.
    const headerRow = ['USER ID', 'AMOUNT', 'KEY_ID', 'TIME STAMP'];
    
    await sheets.spreadsheets.values.update({
      spreadsheetId, range: `${WORKSHEET_NAME}!B1:E1`,
      valueInputOption: 'RAW', requestBody: { values: [headerRow] }
    });
    
    getLogger().success('Headers initialized');
  }
  
  async connect(config: GoogleSheetsConfig): Promise<void> {
    const auth = new GoogleAuth({
      keyFile: config.credentialJsonPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets']
    });
    
    const authClient = await auth.getClient();
    this.sheetsClient = google.sheets({ version: 'v4', auth: authClient as any });
    this.currentConfig = config;
    
    getLogger().success('Google Sheets connected');
  }
  
  /**
   * Determine the first empty row in Column B (USER ID) — the ONE and only
   * signal the exporter uses to place new rows. ArrayFormula outputs in
   * columns A/F/I are ignored entirely, so historical drift (previous
   * append behaviour placing rows at 503 or 50001) cannot recur.
   *
   * The scan reads B2:B (unbounded), walks the returned array top-down,
   * and returns the 1-based row of the first empty cell. When the range
   * contains no empty cells (fully packed), returns `2 + values.length`.
   */
  async findInsertionRow(): Promise<number> {
    if (!this.sheetsClient || !this.currentConfig) {
      throw new Error('Google Sheets client not initialized');
    }
    const response = await this.sheetsClient.spreadsheets.values.get({
      spreadsheetId: this.currentConfig.spreadsheetId,
      range: `${WORKSHEET_NAME}!${COLUMN.USER_ID}2:${COLUMN.USER_ID}`,
      // Ensure we see raw values, not formatted ones — an empty cell must
      // report as an empty string (or missing), not as the ArrayFormula
      // spillover from column A.
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const values: any[][] = response.data.values || [];
    for (let i = 0; i < values.length; i++) {
      const cell = values[i]?.[0];
      if (cell === undefined || cell === null || String(cell).trim() === '') {
        return 2 + i;
      }
    }
    return 2 + values.length;
  }
  
  /**
   * Read the newest KEY_ID (short fingerprint) from Column D of the MASTER
   * worksheet. Google Sheets is the production source of truth — this is
   * called at startup and after Sheets writes to keep the SQLite Resume
   * Marker in sync.
   *
   * Returns null when column D holds only the header row (or is empty).
   */
  async getLatestExportedKeyId(): Promise<string | null> {
    if (!this.sheetsClient || !this.currentConfig) return null;
    try {
      const response = await this.sheetsClient.spreadsheets.values.get({
        spreadsheetId: this.currentConfig.spreadsheetId,
        range: `${WORKSHEET_NAME}!${COLUMN.KEY_ID}2:${COLUMN.KEY_ID}`,
        valueRenderOption: 'UNFORMATTED_VALUE',
      });
      const values: any[][] = response.data.values || [];
      // Walk bottom-up; the newest export sits at the largest row index.
      for (let i = values.length - 1; i >= 0; i--) {
        const cell = values[i]?.[0];
        if (cell !== undefined && cell !== null && String(cell).trim() !== '') {
          return String(cell).trim();
        }
      }
      return null;
    } catch (error: any) {
      getLogger().warn(`Failed to read latest KEY_ID from Sheets: ${error?.message || error}`);
      return null;
    }
  }

  /**
   * Read MASTER column D once for pending-export reconciliation. Values are
   * normalized to the frozen eight-character uppercase KEY_ID contract.
   * Unlike the resume-marker convenience read, failures are surfaced so a
   * recovery drain cannot mistake an unavailable read for an empty Sheet.
   */
  async getExportedKeyIds(): Promise<Set<string>> {
    if (!this.sheetsClient || !this.currentConfig) {
      throw new Error('Google Sheets client not initialized');
    }
    const response = await this.sheetsClient.spreadsheets.values.get({
      spreadsheetId: this.currentConfig.spreadsheetId,
      range: `${WORKSHEET_NAME}!${COLUMN.KEY_ID}2:${COLUMN.KEY_ID}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const ids = new Set<string>();
    for (const row of response.data.values || []) {
      const value = row?.[0];
      if (value !== undefined && value !== null && String(value).trim() !== '') {
        ids.add(String(value).trim().toUpperCase());
      }
    }
    return ids;
  }
  
  /**
   * Append a batch of transactions to the MASTER worksheet.
   *
   * Placement is decided by findInsertionRow() (Column B scan only). The
   * write range is strictly B..E so the operator-owned ArrayFormula cells
   * in A, F and I are never touched. Returns an ExportResult carrying the
   * destination range so the caller (MonitoringEngine) can log the export
   * block and advance the Resume Marker.
   */
  async appendTransactions(transactions: Transaction[]): Promise<ExportResult> {
    if (!this.sheetsClient || !this.currentConfig) {
      throw new Error('Google Sheets client not initialized');
    }
    if (transactions.length === 0) {
      throw new Error('appendTransactions called with empty batch');
    }
    
    const logger = getLogger();
    const startRow = await this.findInsertionRow();
    const endRow = startRow + transactions.length - 1;
    const destinationRange = `${WORKSHEET_NAME}!${COLUMN.USER_ID}${startRow}:${COLUMN.TIME_STAMP}${endRow}`;
    const rows = transactions.map(t => this.formatRow(t));
    
    logger.info(
      '\n========== [SHEETS EXPORT] ==========\n' +
      `  Spreadsheet ID    : ${this.currentConfig.spreadsheetId}\n` +
      `  Spreadsheet Name  : ${this.currentConfig.spreadsheetTitle || '(unknown)'}\n` +
      `  Worksheet Name    : ${WORKSHEET_NAME}\n` +
      `  Destination Range : ${destinationRange}\n` +
      `  Starting Row      : ${startRow}\n` +
      `  Ending Row        : ${endRow}\n` +
      `  Rows Written      : ${transactions.length}\n` +
      '======================================'
    );
    
    try {
      await this.sheetsClient.spreadsheets.values.update({
        spreadsheetId: this.currentConfig.spreadsheetId,
        range: destinationRange,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: rows }
      });
      logger.info(`[SHEETS EXPORT] Export Result : SUCCESS`);
    } catch (error: any) {
      logger.error(`[SHEETS EXPORT] Export Result : FAILED — ${error?.message || error}`);
      throw error;
    }
    
    getLogger().success(`Exported ${transactions.length} transactions`);
    return {
      startRow, endRow,
      rowsWritten: transactions.length,
      destinationRange,
      spreadsheetId: this.currentConfig.spreadsheetId,
      spreadsheetTitle: this.currentConfig.spreadsheetTitle || '',
      worksheetName: WORKSHEET_NAME,
    };
  }
  
  /**
   * Row layout for Columns B..E only. Columns A, F, and I are permanent
   * ArrayFormulas and MUST NOT be included in the update payload.
   *
   *   B → USER ID    (userName)
   *   C → AMOUNT     (numeric)
   *   D → KEY_ID     (short fingerprint — Resume Marker source)
   *   E → TIME STAMP (createdAt — the panel's Created Date, used for
   *                    operator-side reconciliation with the deposit
   *                    panel which is sorted by Created At. Falls back
   *                    to processDate on older data that lacks a
   *                    createdAt field.)
   *
   * Fingerprint inputs remain unchanged; TIME STAMP is purely operational.
   */
  private formatRow(t: Transaction): any[] {
    return [
      t.userName,
      t.amount,
      t.transactionFingerprint.substring(0, 8).toUpperCase(),
      t.createdAt || t.processDate,
    ];
  }
  
  isConnected(): boolean {
    return this.sheetsClient !== null && this.currentConfig !== null;
  }
}
