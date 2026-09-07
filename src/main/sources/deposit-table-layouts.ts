import { SELECTORS } from '../../utils/selector-repository';

export type DepositColumnKey = keyof typeof SELECTORS.COLUMNS;

export const OMITTED_COLUMN = -1;
export const FOOTER_ROW_MAX_CELLS = 6;
export const REQUIRED_DEPOSIT_FIELDS: readonly DepositColumnKey[] = [
  'USER_NAME', 'ACCOUNT_NUMBER', 'AMOUNT', 'PROCESS_DATE'
];

export interface DepositTableLayout {
  headerCount: number;
  bodyCount: number;
  name: string;
  map: Readonly<Record<DepositColumnKey, number>>;
}

/** Shared frozen registry used by both the Legacy and raw-HTML parsers. */
export const DEPOSIT_TABLE_LAYOUTS: readonly DepositTableLayout[] = [
  {
    headerCount: 17, bodyCount: 15,
    name: '17H/15B — production standard row (Payment Type + col-17 omitted)',
    map: { SEQUENCE: 0, USER_NAME: 1, BANK: 2, ACCOUNT_NAME: 3,
      ACCOUNT_NUMBER: 4, PAYMENT_ID: 5, CURRENCY: 6, AMOUNT: 7,
      STATUS: 8, EXTERNAL_ID: 9, DONE: 10, DEPOSIT_TYPE: 11,
      PAYMENT_TYPE: OMITTED_COLUMN, AGENT: 12, PROCESS_DATE: 13, CREATED_AT: 14 }
  },
  {
    headerCount: 16, bodyCount: 16, name: '16H/16B — legacy full row',
    map: { SEQUENCE: 0, USER_NAME: 1, BANK: 2, ACCOUNT_NAME: 3,
      ACCOUNT_NUMBER: 4, PAYMENT_ID: 5, CURRENCY: 6, AMOUNT: 7,
      STATUS: 8, EXTERNAL_ID: 9, DONE: 10, DEPOSIT_TYPE: 11,
      PAYMENT_TYPE: 12, AGENT: 13, PROCESS_DATE: 14, CREATED_AT: 15 }
  },
  {
    headerCount: 16, bodyCount: 15, name: '16H/15B — legacy row with Payment Type omitted',
    map: { SEQUENCE: 0, USER_NAME: 1, BANK: 2, ACCOUNT_NAME: 3,
      ACCOUNT_NUMBER: 4, PAYMENT_ID: 5, CURRENCY: 6, AMOUNT: 7,
      STATUS: 8, EXTERNAL_ID: 9, DONE: 10, DEPOSIT_TYPE: 11,
      PAYMENT_TYPE: OMITTED_COLUMN, AGENT: 12, PROCESS_DATE: 13, CREATED_AT: 14 }
  }
];

export function findDepositTableLayout(headerCount: number, bodyCount: number): DepositTableLayout | undefined {
  return DEPOSIT_TABLE_LAYOUTS.find(layout =>
    layout.headerCount === headerCount && layout.bodyCount === bodyCount);
}
