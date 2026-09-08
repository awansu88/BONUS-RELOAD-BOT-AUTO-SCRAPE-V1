import { Page, ElementHandle } from 'playwright';
import { RawTransaction } from '../../types/transaction';
import { SELECTORS } from '../../utils/selector-repository';
import { getLogger } from './logger-service';
import {
  DEPOSIT_TABLE_LAYOUTS, DepositColumnKey, DepositTableLayout,
  FOOTER_ROW_MAX_CELLS, OMITTED_COLUMN, REQUIRED_DEPOSIT_FIELDS
} from '../sources/deposit-table-layouts';

/**
 * A row that could not be parsed into a RawTransaction. Emitted alongside
 * successful transactions so PageScanner / MonitoringEngine can log a
 * per-row diagnostic.
 */
export interface RowRejection {
  rowIndex: number;      // 1-based, for operator-facing logs
  reason: string;
  cellCount?: number;
  headerLabels?: string[];    // full <thead> label list, in DOM order
  cellTexts?: string[];       // <td> text content, in DOM order
  rowOuterHTML?: string;      // raw <tr> outerHTML for the rejected row
  resolved?: Partial<Record<ColumnKey, string>>;
  /**
   * When true, the row is a legitimate non-transaction placeholder
   * (empty <tr>, whitespace-only <td>s) and MUST NOT be logged. Neither
   * HTMLMapper nor PageScanner emits a diagnostic for silent rejections.
   * They are still counted in `rowsDetected` for accuracy.
   */
  silent?: boolean;
}

export interface ParseResult {
  transactions: RawTransaction[];
  rejections: RowRejection[];
  rowsDetected: number;
}

type ColumnKey = DepositColumnKey;

/**
 * Header-label → canonical-column-key map for the production deposit panel.
 * Used for reporting only (the body-index mapping is driven by the explicit
 * PRODUCTION_LAYOUTS registry below). Adding an entry has no effect on
 * parsing — it just makes the HEADER RESOLUTION diag block more useful.
 */
const HEADER_LABELS: Record<string, ColumnKey> = {
  '#':                'SEQUENCE',
  'user name':        'USER_NAME',
  'bank':             'BANK',
  'account name':     'ACCOUNT_NAME',
  'account number':   'ACCOUNT_NUMBER',
  'payment id':       'PAYMENT_ID',
  'currency':         'CURRENCY',
  'amount':           'AMOUNT',
  'status':           'STATUS',
  'external id':      'EXTERNAL_ID',
  'done':             'DONE',
  'deposit type':     'DEPOSIT_TYPE',
  'payment type':     'PAYMENT_TYPE',
  'agent':            'AGENT',
  'process date':     'PROCESS_DATE',
  'created at':       'CREATED_AT',
};

const REQUIRED_FIELDS = REQUIRED_DEPOSIT_FIELDS;
const OMITTED = OMITTED_COLUMN;
type ProductionLayout = DepositTableLayout;
const PRODUCTION_LAYOUTS = DEPOSIT_TABLE_LAYOUTS;

interface HeaderInfo {
  /** Raw header labels read from `<thead>`, in DOM order. */
  labels: string[];
  /** Canonical column key → 0-based header index (best-effort, reporting). */
  keyToIdx: Map<ColumnKey, number>;
  /** True when at least one canonical key was resolved from labels. */
  ok: boolean;
}

/**
 * HTMLMapper — pure parser for the production deposit panel.
 *
 * Responsibility: take the currently-rendered HTML table and emit
 * RawTransaction records. Nothing else. No business filtering, no
 * fingerprinting, no duplicate detection, no export. The browser is the
 * single source of truth for filtering; every row visible in `<tbody>` is
 * assumed to have already passed every configured browser filter.
 *
 * Layout support is driven exclusively by the PRODUCTION_LAYOUTS
 * registry above. Unknown (headerCount, bodyCount) combinations are
 * rejected with a rich diagnostic; no heuristic alignment.
 */
export class HTMLMapper {
  constructor(private page: Page) {}

  async parseCurrentPage(): Promise<ParseResult> {
    const logger = getLogger();
    try {
      const header = await this.readHeader();
      const rows = await this.page.$$(SELECTORS.TABLE.ROWS);
      const transactions: RawTransaction[] = [];
      const rejections: RowRejection[] = [];

      logger.debug(`Found ${rows.length} rows on page`);

      // Emit the header layout once per parse. Print the RAW label list so
      // operators can identify unrecognised header labels (positions 11
      // and 17 on the modern panel, for example) at a glance.
      logger.diag(
        [
          '--------------------------------------------------',
          'HEADER RESOLUTION',
          `Header columns: ${header.labels.length}`,
          'Raw header labels:',
          ...header.labels.map((l, i) => `  [${(i + 1).toString().padStart(2, ' ')}] "${l}"`),
          'Resolved canonical keys:',
          ...(header.keyToIdx.size === 0
            ? ['  (none — thead parsing failed or all labels are unrecognised)']
            : [...header.keyToIdx.entries()].map(
                ([k, hi]) => `  ${k.padEnd(15)} → header col ${hi + 1} ("${header.labels[hi] || ''}")`
              )),
          '--------------------------------------------------'
        ].join('\n')
      );

      for (let i = 0; i < rows.length; i++) {
        const rowIndex = i + 1;
        try {
          const outcome = await this.parseRow(rows[i], rowIndex, header);
          if (outcome.ok) {
            transactions.push(outcome.transaction);
          } else if (outcome.rejection.silent) {
            // Empty placeholder row — never a real transaction, never
            // logged, never surfaced as a rejection to the operator.
          } else {
            rejections.push(outcome.rejection);
            this.logRejection(outcome.rejection);
          }
        } catch (error: any) {
          const rej: RowRejection = {
            rowIndex,
            reason: `Unexpected parse error: ${error?.message || error}`
          };
          rejections.push(rej);
          this.logRejection(rej);
        }
      }

      logger.info(`Parsed ${transactions.length} transactions (rejected ${rejections.length})`);
      return { transactions, rejections, rowsDetected: rows.length };
    } catch (error: any) {
      logger.error('Failed to parse page', error);
      return { transactions: [], rejections: [], rowsDetected: 0 };
    }
  }

  /**
   * Read `<thead> tr th` labels once per page. Returns the raw label list
   * (used for diagnostics) and a best-effort canonical-key → header-index
   * map (used for reporting only — the body-index mapping is driven by
   * PRODUCTION_LAYOUTS, not by header labels).
   */
  private async readHeader(): Promise<HeaderInfo> {
    try {
      const labels: string[] = await this.page.$$eval(
        `${SELECTORS.TABLE.HEADER} tr th`,
        (nodes: Element[]) =>
          nodes.map(n => (n.textContent || '').trim().toLowerCase().replace(/\s+/g, ' '))
      );
      const keyToIdx = new Map<ColumnKey, number>();
      labels.forEach((label, idx) => {
        const key = HEADER_LABELS[label];
        if (key && !keyToIdx.has(key)) keyToIdx.set(key, idx);
      });
      return { labels, keyToIdx, ok: labels.length > 0 };
    } catch {
      return { labels: [], keyToIdx: new Map(), ok: false };
    }
  }

  /**
   * Look up the explicit production layout for a given (headerCount,
   * bodyCount) shape. Returns undefined when no layout matches — the
   * caller then rejects the row with a rich diagnostic.
   */
  private findLayout(headerCount: number, bodyCount: number): ProductionLayout | undefined {
    return PRODUCTION_LAYOUTS.find(l => l.headerCount === headerCount && l.bodyCount === bodyCount);
  }

  private async parseRow(
    row: ElementHandle,
    rowIndex: number,
    header: HeaderInfo
  ): Promise<
    | { ok: true; transaction: RawTransaction }
    | { ok: false; rejection: RowRejection }
  > {
    const cells = await row.$$('td');

    if (cells.length === 0) {
      return { ok: false, rejection: { rowIndex, reason: 'Row has 0 cells (empty tr)', cellCount: 0, silent: true } };
    }

    // Empty placeholder rows — sometimes the panel emits a <tr> with the
    // expected number of <td>s but every cell is whitespace-only. These
    // are not transactions; skip silently before the layout registry runs
    // so they never surface as "Unknown Layout" or "Missing required
    // field" rejections.
    const rowIsEmpty = await this.rowHasNoText(row);
    if (rowIsEmpty) {
      return {
        ok: false,
        rejection: {
          rowIndex,
          reason: 'Empty placeholder row (silent skip)',
          cellCount: cells.length,
          silent: true,
        }
      };
    }

    // Footer / summary rows (SubTotal / Total with colspan). Clean skip.
    if (cells.length <= FOOTER_ROW_MAX_CELLS) {
      const firstCellText = await this.getCellText(cells, 0);
      return {
        ok: false,
        rejection: {
          rowIndex,
          reason: `Footer/summary row skipped (${cells.length} cells, first cell="${firstCellText}")`,
          cellCount: cells.length
        }
      };
    }

    const layout = this.findLayout(header.labels.length, cells.length);
    if (!layout) {
      // Unknown production layout — collect a rich diagnostic so the
      // operator can add the missing entry to PRODUCTION_LAYOUTS.
      const cellTexts = await this.readAllCellTexts(cells);
      const outerHTML = await this.readRowOuterHTML(row);
      const known = PRODUCTION_LAYOUTS
        .map(l => `${l.headerCount}H/${l.bodyCount}B (${l.name})`)
        .join('; ');
      return {
        ok: false,
        rejection: {
          rowIndex,
          reason:
            `Unknown production layout: header=${header.labels.length}, body=${cells.length}. ` +
            `Known layouts: ${known}. Add an explicit entry to PRODUCTION_LAYOUTS ` +
            `in html-mapper.ts.`,
          cellCount: cells.length,
          headerLabels: header.labels,
          cellTexts,
          rowOuterHTML: outerHTML,
        }
      };
    }

    const read = async (key: ColumnKey): Promise<string> => {
      const idx = layout.map[key];
      if (idx === undefined || idx === OMITTED) return '';
      return this.getCellText(cells, idx);
    };

    const resolved: Partial<Record<ColumnKey, string>> = {
      USER_NAME:      await read('USER_NAME'),
      BANK:           await read('BANK'),
      ACCOUNT_NAME:   await read('ACCOUNT_NAME'),
      ACCOUNT_NUMBER: await read('ACCOUNT_NUMBER'),
      PAYMENT_ID:     await read('PAYMENT_ID'),
      CURRENCY:       await read('CURRENCY'),
      AMOUNT:         await read('AMOUNT'),
      STATUS:         await read('STATUS'),
      EXTERNAL_ID:    await read('EXTERNAL_ID'),
      DONE:           await read('DONE'),
      DEPOSIT_TYPE:   await read('DEPOSIT_TYPE'),
      PAYMENT_TYPE:   await read('PAYMENT_TYPE'),
      AGENT:          await read('AGENT'),
      PROCESS_DATE:   await read('PROCESS_DATE'),
      CREATED_AT:     await read('CREATED_AT'),
    };

    const missing = REQUIRED_FIELDS.filter(k => !resolved[k]);
    if (missing.length > 0) {
      return {
        ok: false,
        rejection: {
          rowIndex,
          reason: `Missing required field(s): ${missing.join(', ')} (layout=${layout.name})`,
          cellCount: cells.length,
          resolved
        }
      };
    }

    const amount = this.parseAmount(resolved.AMOUNT || '');
    if (isNaN(amount)) {
      return {
        ok: false,
        rejection: {
          rowIndex,
          reason: `Invalid Amount Format: "${resolved.AMOUNT || ''}"`,
          cellCount: cells.length,
          resolved
        }
      };
    }

    return {
      ok: true,
      transaction: {
        userName:      resolved.USER_NAME      || '',
        bank:          resolved.BANK           || '',
        accountName:   resolved.ACCOUNT_NAME   || '',
        accountNumber: resolved.ACCOUNT_NUMBER || '',
        amount,
        status:        resolved.STATUS         || '',
        done:          resolved.DONE           || '',
        depositType:   resolved.DEPOSIT_TYPE   || '',
        agent:         resolved.AGENT          || '',
        processDate:   resolved.PROCESS_DATE   || '',
        createdAt:     resolved.CREATED_AT     || ''
      }
    };
  }

  /**
   * Emit an operator-friendly diagnostic block for every rejected row.
   *
   * When the rejection carries a headerLabels + cellTexts + outerHTML
   * bundle (unknown-layout case), print all three so the operator can
   * copy the layout facts directly into PRODUCTION_LAYOUTS.
   * Gated by the operator's Diagnostic Logging toggle.
   */
  private logRejection(rej: RowRejection): void {
    const lines: string[] = [
      '----------------------------------------',
      `Rejected Row #${rej.rowIndex}`,
    ];

    if (rej.headerLabels && rej.headerLabels.length > 0) {
      lines.push(`Header (${rej.headerLabels.length} columns):`);
      rej.headerLabels.forEach((l, i) => {
        lines.push(`  H[${(i + 1).toString().padStart(2, ' ')}] "${l}"`);
      });
    }

    if (rej.cellTexts && rej.cellTexts.length > 0) {
      lines.push(`Body (${rej.cellTexts.length} cells):`);
      rej.cellTexts.forEach((t, i) => {
        lines.push(`  B[${(i + 1).toString().padStart(2, ' ')}] "${t}"`);
      });
    }

    if (rej.resolved) {
      lines.push('Resolved Mapping:');
      const order: readonly [ColumnKey, string][] = [
        ['USER_NAME','User Name'],['BANK','Bank'],['ACCOUNT_NAME','Account Name'],
        ['ACCOUNT_NUMBER','Account Number'],['PAYMENT_ID','Payment ID'],
        ['CURRENCY','Currency'],['AMOUNT','Amount'],['STATUS','Status'],
        ['EXTERNAL_ID','External ID'],['DONE','Done'],['DEPOSIT_TYPE','Deposit Type'],
        ['PAYMENT_TYPE','Payment Type'],['AGENT','Agent'],['PROCESS_DATE','Process Date'],
        ['CREATED_AT','Created At']
      ];
      for (const [k, label] of order) {
        lines.push(`  ${label} = "${rej.resolved[k] ?? ''}"`);
      }
    }

    if (rej.rowOuterHTML) {
      lines.push('Raw <tr> outerHTML:');
      // Fold long HTML at 240 chars for readability; keep the raw payload
      // so the operator can copy-paste into an issue.
      lines.push(rej.rowOuterHTML);
    }

    lines.push('Reject Reason:');
    lines.push(`  ${rej.reason}`);
    lines.push('----------------------------------------');
    getLogger().diag(lines.join('\n'));
  }

  private async getCellText(cells: ElementHandle[], zeroBasedIndex: number): Promise<string> {
    const cell = cells[zeroBasedIndex];
    if (!cell) return '';
    const text = await cell.textContent();
    return text?.trim().replace(/\s+/g, ' ') || '';
  }

  private async readAllCellTexts(cells: ElementHandle[]): Promise<string[]> {
    const texts: string[] = [];
    for (let i = 0; i < cells.length; i++) {
      texts.push(await this.getCellText(cells, i));
    }
    return texts;
  }

  private async readRowOuterHTML(row: ElementHandle): Promise<string> {
    try {
      return await row.evaluate((el: Element) => (el as HTMLElement).outerHTML || '');
    } catch {
      return '';
    }
  }

  /**
   * Cheap emptiness probe: returns true when the row's aggregate text
   * content is all whitespace. Used to silent-skip placeholder rows
   * before the layout registry lookup. HTML comments contribute nothing
   * to textContent so commented-out cells do not falsely resurrect a row.
   */
  private async rowHasNoText(row: ElementHandle): Promise<boolean> {
    try {
      return await row.evaluate((el: Element) => (el.textContent || '').trim().length === 0);
    } catch {
      return false;
    }
  }

  private parseAmount(amountText: string): number {
    if (!amountText) return NaN;
    const cleaned = amountText.replace(/[^0-9.\-]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.') return NaN;
    const numeric = parseFloat(cleaned);
    if (isNaN(numeric)) return NaN;
    return Math.round(numeric);
  }
}
