import { load, CheerioAPI } from 'cheerio';
import { RawTransaction } from '../../types/transaction';
import {
  DEPOSIT_TABLE_LAYOUTS, DepositColumnKey, findDepositTableLayout,
  FOOTER_ROW_MAX_CELLS, OMITTED_COLUMN, REQUIRED_DEPOSIT_FIELDS
} from './deposit-table-layouts';

export enum RawHttpResponseClassification {
  DEPOSIT_TABLE = 'DEPOSIT_TABLE', EMPTY_DEPOSIT_TABLE = 'EMPTY_DEPOSIT_TABLE',
  LOGIN_PAGE = 'LOGIN_PAGE', PERMISSION_OR_ERROR_PAGE = 'PERMISSION_OR_ERROR_PAGE',
  UNKNOWN_LAYOUT = 'UNKNOWN_LAYOUT', MALFORMED_DEPOSIT_TABLE = 'MALFORMED_DEPOSIT_TABLE',
  INVALID_HTML = 'INVALID_HTML'
}

export enum RawHttpParseErrorCode {
  TABLE_NOT_FOUND = 'TABLE_NOT_FOUND', LOGIN_RESPONSE = 'LOGIN_RESPONSE',
  PERMISSION_RESPONSE = 'PERMISSION_RESPONSE', UNKNOWN_LAYOUT = 'UNKNOWN_LAYOUT',
  INVALID_AMOUNT = 'INVALID_AMOUNT', MISSING_REQUIRED_FIELD = 'MISSING_REQUIRED_FIELD',
  FOOTER_ROW = 'FOOTER_ROW', PAGINATION_AMBIGUOUS = 'PAGINATION_AMBIGUOUS'
}

export interface RawHttpRowRejection {
  rowIndex: number;
  code: RawHttpParseErrorCode;
  bodyCount: number;
  missingFields?: DepositColumnKey[];
}

export interface RawPaginationInfo {
  currentPage: number | null;
  nextPageNumber: number | null;
  nextHref: string | null;
  hasNext: boolean;
  valid: boolean;
  errorCode?: RawHttpParseErrorCode.PAGINATION_AMBIGUOUS;
}

export interface RawHttpParseResult {
  transactions: RawTransaction[];
  rejections: RawHttpRowRejection[];
  rowsDetected: number;
  layout: { headerCount: number; bodyCounts: number[]; recognized: boolean; layoutNames: string[]; headerLabels: string[] };
  pagination: RawPaginationInfo;
  classification: RawHttpResponseClassification;
  pageErrorCode?: RawHttpParseErrorCode;
}

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, ' ');
const REQUIRED_HEADER_LABELS = new Set([
  'user name', 'account number', 'amount', 'status', 'process date', 'created at'
]);

export class RawHttpHtmlParser {
  parse(html: string): RawHttpParseResult {
    const $ = load(typeof html === 'string' ? html : '');
    const table = $('table.table.table-striped.b-t').first();
    if (!table.length) return this.withoutTable($);

    const headerLabels = table.find('thead tr').first().find('th').toArray()
      .map(cell => normalizeText($(cell).text()));
    const headerCount = headerLabels.length;
    const normalizedHeaderLabels = new Set(headerLabels.map(label => label.toLowerCase()));
    const recognizedHeaderSignature = [...REQUIRED_HEADER_LABELS]
      .every(label => normalizedHeaderLabels.has(label));
    const rows = table.find('tbody > tr').toArray();
    const transactions: RawTransaction[] = [];
    const rejections: RawHttpRowRejection[] = [];
    const bodyCounts: number[] = [];
    const layoutNames = new Set<string>();
    let unknown = headerCount === 0;
    let malformed = false;

    rows.forEach((row, offset) => {
      const rowIndex = offset + 1;
      const cells = $(row).children('td').toArray();
      bodyCounts.push(cells.length);
      if (cells.length === 0 || normalizeText($(row).text()) === '') return;
      if (cells.length <= FOOTER_ROW_MAX_CELLS) {
        rejections.push({ rowIndex, code: RawHttpParseErrorCode.FOOTER_ROW, bodyCount: cells.length });
        return;
      }
      const layout = findDepositTableLayout(headerCount, cells.length);
      if (!layout) {
        unknown = true;
        rejections.push({ rowIndex, code: RawHttpParseErrorCode.UNKNOWN_LAYOUT, bodyCount: cells.length });
        return;
      }
      layoutNames.add(layout.name);
      const read = (key: DepositColumnKey): string => {
        const index = layout.map[key];
        if (index === OMITTED_COLUMN || !cells[index]) return '';
        if (key === 'ACCOUNT_NUMBER') {
          const canonical = $(cells[index]).attr('data-bank-number');
          if (canonical && canonical.trim()) return canonical.trim();
        }
        return normalizeText($(cells[index]).text());
      };
      const values = Object.fromEntries(Object.keys(layout.map).map(key => [key, read(key as DepositColumnKey)])) as Record<DepositColumnKey, string>;
      const missingFields = REQUIRED_DEPOSIT_FIELDS.filter(key => !values[key]);
      if (missingFields.length) {
        malformed = true;
        rejections.push({ rowIndex, code: RawHttpParseErrorCode.MISSING_REQUIRED_FIELD, bodyCount: cells.length, missingFields: [...missingFields] });
        return;
      }
      const amount = this.parseAmount(values.AMOUNT);
      if (Number.isNaN(amount)) {
        malformed = true;
        rejections.push({ rowIndex, code: RawHttpParseErrorCode.INVALID_AMOUNT, bodyCount: cells.length });
        return;
      }
      transactions.push({ userName: values.USER_NAME, bank: values.BANK,
        accountName: values.ACCOUNT_NAME, accountNumber: values.ACCOUNT_NUMBER,
        amount, status: values.STATUS, done: values.DONE, depositType: values.DEPOSIT_TYPE,
        agent: values.AGENT, processDate: values.PROCESS_DATE, createdAt: values.CREATED_AT });
    });

    const recognizedHeader = recognizedHeaderSignature
      && DEPOSIT_TABLE_LAYOUTS.some(layout => layout.headerCount === headerCount);
    if (!recognizedHeader) unknown = true;
    return {
      transactions, rejections, rowsDetected: rows.length,
      layout: { headerCount, bodyCounts, recognized: !unknown, layoutNames: [...layoutNames], headerLabels },
      pagination: this.pagination($),
      classification: unknown ? RawHttpResponseClassification.UNKNOWN_LAYOUT
        : malformed ? RawHttpResponseClassification.MALFORMED_DEPOSIT_TABLE
        : transactions.length ? RawHttpResponseClassification.DEPOSIT_TABLE
          : RawHttpResponseClassification.EMPTY_DEPOSIT_TABLE,
      ...(unknown ? { pageErrorCode: RawHttpParseErrorCode.UNKNOWN_LAYOUT } : {})
    };
  }

  private withoutTable($: CheerioAPI): RawHttpParseResult {
    const login = $('form#login-form').length > 0 || $('form').filter((_, form) =>
      $(form).find('input[type="password"]').length > 0 && $(form).find('input[name*="user"],input[type="email"]').length > 0).length > 0;
    const text = normalizeText(`${$('title').text()} ${$('body').text()}`).toLowerCase();
    const permission = /\b(permission denied|unauthorized|forbidden|access denied|application error)\b/.test(text)
      || $('[role="alert"].error,.error-page,.access-denied').length > 0;
    const classification = login ? RawHttpResponseClassification.LOGIN_PAGE
      : permission ? RawHttpResponseClassification.PERMISSION_OR_ERROR_PAGE
        : RawHttpResponseClassification.INVALID_HTML;
    const pageErrorCode = login ? RawHttpParseErrorCode.LOGIN_RESPONSE
      : permission ? RawHttpParseErrorCode.PERMISSION_RESPONSE : RawHttpParseErrorCode.TABLE_NOT_FOUND;
    return { transactions: [], rejections: [], rowsDetected: 0,
      layout: { headerCount: 0, bodyCounts: [], recognized: false, layoutNames: [], headerLabels: [] },
      pagination: this.pagination($), classification, pageErrorCode };
  }

  private pagination($: CheerioAPI): RawPaginationInfo {
    const container = $('ul.pagination,nav.pagination,.pagination').first();
    const base: RawPaginationInfo = { currentPage: null, nextPageNumber: null, nextHref: null, hasNext: false, valid: true };
    if (!container.length) return base;
    const active = container.find('.active').first();
    const currentPage = this.pageNumber(active.attr('data-page') || active.find('a').attr('data-page') || active.text() || active.find('a').attr('href'));
    base.currentPage = currentPage;
    if (currentPage === null) return { ...base, valid: false, errorCode: RawHttpParseErrorCode.PAGINATION_AMBIGUOUS };
    const expected = currentPage + 1;
    const nextControls = container.find('a[rel="next"],li.next a,a.next').toArray();
    const explicit = container.find('a').toArray().filter(link => this.pageNumber($(link).attr('data-page') || $(link).attr('href') || $(link).text()) === expected);
    const candidates = nextControls.length ? nextControls : explicit;
    if (nextControls.some(link => this.pageNumber($(link).attr('data-page') || $(link).attr('href') || $(link).text()) !== expected))
      return { ...base, valid: false, errorCode: RawHttpParseErrorCode.PAGINATION_AMBIGUOUS };
    const usable = candidates.filter(link => !$(link).closest('.disabled').length && $(link).attr('aria-disabled') !== 'true');
    if (usable.length !== 1) return usable.length > 1 ? { ...base, valid: false, errorCode: RawHttpParseErrorCode.PAGINATION_AMBIGUOUS } : base;
    const href = $(usable[0]).attr('href');
    if (!href || href === '#') return base;
    return { currentPage, nextPageNumber: expected, nextHref: href, hasNext: true, valid: true };
  }

  private pageNumber(value?: string): number | null {
    if (!value) return null;
    const plain = value.trim().match(/^\d+$/);
    const query = value.match(/[?&]page=(\d+)(?:&|#|$)/i);
    const numeric = Number(plain?.[0] || query?.[1]);
    return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
  }

  private parseAmount(value: string): number {
    if (!value) return NaN;
    const cleaned = value.replace(/[^0-9.\-]/g, '');
    if (!cleaned || cleaned === '-' || cleaned === '.') return NaN;
    const numeric = parseFloat(cleaned);
    return Number.isNaN(numeric) ? NaN : Math.round(numeric);
  }
}
