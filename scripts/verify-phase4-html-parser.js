const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const { RawHttpHtmlParser, RawHttpResponseClassification: C, RawHttpParseErrorCode: E } =
  require('../dist/main/main/sources/raw-http-html-parser');
const { FingerprintGenerator } = require('../dist/main/main/services/fingerprint-generator');
const parser = new RawHttpHtmlParser();
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/phase4', name), 'utf8');
const parse = name => parser.parse(fixture(name));

const expected = {
  userName: 'Example User', bank: 'SANITIZED BANK', accountName: 'Sample Account',
  accountNumber: '7976181505', amount: 100763, status: 'Approved', done: 'Yes',
  depositType: 'Example Type', agent: 'Example Agent',
  processDate: '2026-08-01 10:01:00', createdAt: '2026-08-01 10:00:00'
};

for (const [name, layout] of [['layout-17h-15b.html','17H/15B'], ['layout-16h-16b.html','16H/16B']]) {
  const result = parse(name);
  assert.strictEqual(result.classification, C.DEPOSIT_TABLE);
  assert.deepStrictEqual(result.transactions, [expected]);
  assert.deepStrictEqual(result.layout.layoutNames, [layout]);
}
const legacyOmitted = parse('layout-16h-15b.html');
assert.deepStrictEqual(legacyOmitted.transactions[0], { ...expected, accountNumber: '797-618-1505' });
assert.deepStrictEqual(Object.keys(parse('layout-17h-15b.html').transactions[0]).sort(), Object.keys(expected).sort());

const replace = (html, from, to) => parser.parse(html.replace(from, to));
let result = replace(fixture('layout-17h-15b.html'), 'data-bank-number="7976181505">797-618-1505', 'data-bank-number=" ">   ');
assert.strictEqual(result.rejections[0].code, E.MISSING_REQUIRED_FIELD);
result = replace(fixture('layout-17h-15b.html'), 'IDR 100,763.49', 'not-a-number');
assert.strictEqual(result.rejections[0].code, E.INVALID_AMOUNT);
assert.strictEqual(result.transactions.length, 0);
for (const [input, amount] of [['100,763.00',100763],['IDR 100,763.00',100763],['100763',100763],['100763.49',100763],['100763.50',100764]]) {
  result = replace(fixture('layout-17h-15b.html'), 'IDR 100,763.49', input);
  assert.strictEqual(result.transactions[0].amount, amount);
}
result = replace(fixture('layout-17h-15b.html'), 'Example User', '\n Example     User \n');
assert.strictEqual(result.transactions[0].userName, 'Example User');
assert.strictEqual(parse('account-data-attribute.html').transactions[0].accountNumber, '7976181505');
assert.strictEqual(parse('layout-16h-15b.html').transactions[0].accountNumber, '797-618-1505');

const canonical = parse('account-data-attribute.html').transactions[0];
const fingerprints = new FingerprintGenerator();
assert.strictEqual(fingerprints.generate({ ...canonical, accountNumber: '797-618-1505' }), fingerprints.generate(canonical));

assert.strictEqual(parse('empty.html').classification, C.EMPTY_DEPOSIT_TABLE);
result = parser.parse(fixture('empty.html').replace('</tbody>', '<tr></tr><tr>'+('<td> </td>'.repeat(15))+'</tr></tbody>'));
assert.strictEqual(result.classification, C.EMPTY_DEPOSIT_TABLE);
assert.strictEqual(result.rowsDetected, 2);
assert.strictEqual(result.rejections.length, 0);
result = parser.parse(fixture('empty.html').replace('</tbody>', '<tr><td colspan="17">Summary</td></tr></tbody>'));
assert.strictEqual(result.classification, C.EMPTY_DEPOSIT_TABLE);
assert.strictEqual(result.rejections[0].code, E.FOOTER_ROW);
assert.strictEqual(parse('unknown-layout.html').classification, C.UNKNOWN_LAYOUT);
result = parser.parse(fixture('layout-17h-15b.html').replace('</tbody>', '<tr>'+('<td>safe</td>'.repeat(14))+'</tr></tbody>'));
assert.strictEqual(result.classification, C.UNKNOWN_LAYOUT);
assert.strictEqual(result.transactions.length, 1); // diagnostic only; classification makes the page unsafe.
assert.strictEqual(parser.parse('<html><table><tr><td>unrelated</td></tr></table></html>').classification, C.INVALID_HTML);
assert.strictEqual(parse('login.html').classification, C.LOGIN_PAGE);
assert.strictEqual(parse('permission-error.html').classification, C.PERMISSION_OR_ERROR_PAGE);

const two = fixture('layout-17h-15b.html').replace('</tbody>', fixture('layout-17h-15b.html').match(/<tbody>([\s\S]*)<\/tbody>/)[1].replace('Example User','Second User')+'</tbody>');
result = parser.parse(two);
assert.deepStrictEqual(result.transactions.map(t => t.userName), ['Example User','Second User']);
result = replace(fixture('layout-17h-15b.html'), '2026-08-01 10:00:00', '');
assert.strictEqual(result.transactions[0].createdAt, '');

result = parse('pagination-page-1.html');
assert.deepStrictEqual(result.pagination, { currentPage: 1, nextPageNumber: 2, nextHref: '/safe/deposits?page=2', hasNext: true, valid: true });
result = parser.parse(fixture('empty.html').replace('<body>', '<body><a rel="next" href="?page=99">Other</a>'));
assert.strictEqual(result.pagination.hasNext, false);
assert.strictEqual(parse('pagination-final.html').pagination.hasNext, false);
result = parser.parse(fixture('pagination-page-1.html').replace('/safe/deposits?page=2','?page=1'));
assert.strictEqual(result.pagination.valid, false);
assert.strictEqual(result.pagination.hasNext, false);
assert.strictEqual(parse('pagination-page-1.html').pagination.nextPageNumber, 2);

// Registry parity and narrow executable security/wiring guards.
const mapper = fs.readFileSync(path.join(root, 'src/main/services/html-mapper.ts'), 'utf8');
for (const shape of [[17,15],[16,16],[16,15]]) assert(mapper.includes(`headerCount: ${shape[0]}`) && mapper.includes(`bodyCount: ${shape[1]}`));
const source = fs.readFileSync(path.join(root, 'src/main/sources/raw-http-html-parser.ts'), 'utf8');
for (const forbidden of [/\bfetch\s*\(/, /from ['"]axios['"]/, /\bcontext\.request\b/, /\bbrowserContext\.request\b/, /\b(cookie|authorization|csrf|xsrf)\b/i]) assert(!forbidden.test(source));
for (const file of ['src/main/services/monitoring-engine.ts','src/main/sources/legacy-browser-source-adapter.ts','src/main/sources/filter-request-resolver.ts'])
  assert(!fs.readFileSync(path.join(root, file), 'utf8').includes('RawHttpHtmlParser'));

console.log('Phase 4 raw HTTP HTML parser verification passed (Cases A-Z, parity, and security guards).');
