/** Hotfix 13F verifier. Portable: synthetic HTML only; no browser, DB, or network. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/main/main');
const { RawHttpHtmlParser, RawHttpResponseClassification: C, RawHttpParseErrorCode: E } =
  require(path.join(DIST, 'sources/raw-http-html-parser.js'));
const { DEPOSIT_TABLE_LAYOUTS } = require(path.join(DIST, 'sources/deposit-table-layouts.js'));
const parser = new RawHttpHtmlParser();
const headers = ['#', 'User Name', 'Bank', 'Account Name', 'Account Number', 'Payment ID',
  'Currency', 'Amount', 'Status', 'External ID', 'Done', 'Deposit Type', 'Payment Type',
  'Agent', 'Process Date', 'Created At', 'Audit'];

function page(accountCell, { paymentCell = '<td>TEST_PAYMENT</td>', extraCells = '', extraRows = '' } = {}) {
  const cells = ['<td>1</td>', '<td>TEST_USER</td>', '<td>TEST_BANK</td>', '<td>TEST_ACCOUNT_NAME</td>',
    accountCell, paymentCell, '<td>TEST_CURRENCY</td>', '<td>100.50</td>', '<td>TEST_STATUS</td>',
    '<td>TEST_EXTERNAL</td>', '<td>Yes</td>', '<td>TEST_TYPE</td>', '<td>TEST_AGENT</td>',
    '<td>2026-09-09 01:02:03</td>', '<td>2026-09-09 01:01:03</td>', extraCells].join('');
  return `<table class="table table-striped b-t"><thead><tr>${headers.map(value => `<th>${value}</th>`).join('')}</tr></thead><tbody><tr>${cells}</tr>${extraRows}</tbody></table>`;
}
function parse(accountCell, options) { return parser.parse(page(accountCell, options)); }
function missingAccount(result) {
  assert.strictEqual(result.transactions.length, 0);
  assert.strictEqual(result.classification, C.MALFORMED_DEPOSIT_TABLE);
  assert.strictEqual(result.rejections[0].code, E.MISSING_REQUIRED_FIELD);
  assert.deepStrictEqual(result.rejections[0].missingFields, ['ACCOUNT_NUMBER']);
}

// A, B, O: empty visible text is valid when the mapped cell has one nested canonical value.
let result = parse('<td><span data-bank-number="TEST_ACCOUNT_001"></span></td>');
assert.strictEqual(result.classification, C.DEPOSIT_TABLE);
assert.strictEqual(result.transactions[0].accountNumber, 'TEST_ACCOUNT_001');

// C: the legacy direct-cell attribute remains supported.
result = parse('<td data-bank-number="TEST_ACCOUNT_002"></td>');
assert.strictEqual(result.classification, C.DEPOSIT_TABLE);
assert.strictEqual(result.transactions[0].accountNumber, 'TEST_ACCOUNT_002');

// D: visible text remains the fallback only when no non-empty canonical value exists.
result = parse('<td> TEST_VISIBLE_ACCOUNT </td>');
assert.strictEqual(result.transactions[0].accountNumber, 'TEST_VISIBLE_ACCOUNT');

// E: an empty direct attribute does not override one valid nested canonical value.
result = parse('<td data-bank-number="  "><span data-bank-number="TEST_NESTED"></span></td>');
assert.strictEqual(result.transactions[0].accountNumber, 'TEST_NESTED');

// F: data-bank is never interpreted as the account number.
missingAccount(parse('<td><span data-bank="TEST_BANK_ONLY"></span></td>'));

// G: canonical attributes outside the mapped account cell are not searched.
missingAccount(parse('<td></td>', { paymentCell: '<td data-bank-number="TEST_ELSEWHERE"></td>' }));

// H: duplicate descendants with one unique value are accepted.
result = parse('<td><span data-bank-number="TEST_SAME"></span><i data-bank-number=" TEST_SAME "></i></td>');
assert.strictEqual(result.transactions[0].accountNumber, 'TEST_SAME');

// I, K: conflicting values fail through existing validation and neither value enters diagnostics.
const firstSecret = 'TEST_CONFLICT_ALPHA'; const secondSecret = 'TEST_CONFLICT_BETA';
result = parse(`<td><span data-bank-number="${firstSecret}"></span><i data-bank-number="${secondSecret}"></i></td>`);
missingAccount(result);
assert(!JSON.stringify(result.rejections).includes(firstSecret));
assert(!JSON.stringify(result.rejections).includes(secondSecret));

// J: canonical values receive trim only, preserving punctuation and letters.
result = parse('<td><span data-bank-number="  TEST-Account_09 / X  "></span></td>');
assert.strictEqual(result.transactions[0].accountNumber, 'TEST-Account_09 / X');

// L, M: the registry remains 17H/15B and does not gain 17H/18B.
assert(DEPOSIT_TABLE_LAYOUTS.some(layout => layout.headerCount === 17 && layout.bodyCount === 15));
assert(!DEPOSIT_TABLE_LAYOUTS.some(layout => layout.headerCount === 17 && layout.bodyCount === 18));
result = parse('<td><span data-bank-number="TEST_ACCOUNT_003"></span></td>', { extraCells: '<td>A</td><td>B</td><td>C</td>' });
assert.strictEqual(result.classification, C.UNKNOWN_LAYOUT);
assert.strictEqual(result.rejections[0].code, E.UNKNOWN_LAYOUT);

// N: blank rows remain ignored and footer rows remain non-malformed rejections.
const validCell = '<td><span data-bank-number="TEST_ACCOUNT_004"></span></td>';
result = parse(validCell, { extraRows: `<tr>${'<td> </td>'.repeat(15)}</tr><tr><td>Summary</td></tr>` });
assert.strictEqual(result.classification, C.DEPOSIT_TABLE);
assert.strictEqual(result.transactions.length, 1);
assert.strictEqual(result.rejections.length, 1);
assert.strictEqual(result.rejections[0].code, E.FOOTER_ROW);

// P: corrected Hotfix 13D fixtures use empty-text nested canonical attributes and parse successfully.
for (const [file, expected] of [
  ['live-post-page1-sanitized.html', 'TEST_ACCOUNT_001'],
  ['live-post-page2-final-sanitized.html', 'TEST_ACCOUNT_002']
]) {
  const html = fs.readFileSync(path.join(ROOT, 'scripts/fixtures/hotfix13d', file), 'utf8');
  assert.match(html, /<td><span class="bank-accnumber" data-bank="TEST_BANK" data-bank-number="TEST_ACCOUNT_00[12]"><\/span><\/td>/);
  const parsed = parser.parse(html, { expectedPageNumber: file.includes('page1') ? 1 : 2 });
  assert.strictEqual(parsed.classification, C.DEPOSIT_TABLE);
  assert.strictEqual(parsed.transactions[0].accountNumber, expected);
}

console.log('PASS: Hotfix 13F cases A-P (nested account-number parity and fail-closed ambiguity).');
