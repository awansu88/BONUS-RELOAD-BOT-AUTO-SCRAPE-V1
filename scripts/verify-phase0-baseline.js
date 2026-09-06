/** Phase 0 production-contract characterization tests. No network or live data. */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DIST = path.resolve(__dirname, '..', 'dist/main/main');
const loggerSvc = require(path.join(DIST, 'services/logger-service.js'));
loggerSvc.getLogger = () => ({ info(){}, warn(){}, error(){}, debug(){}, success(){}, diag(){}, isDiagEnabled(){ return false; } });
const { FingerprintGenerator } = require(path.join(DIST, 'services/fingerprint-generator.js'));
const { TransactionValidator } = require(path.join(DIST, 'services/transaction-validator.js'));
const { PageScanner } = require(path.join(DIST, 'services/page-scanner.js'));
const { GoogleSheetsService } = require(path.join(DIST, 'services/google-sheets-service.js'));
const { ConfigManager } = require(path.join(DIST, 'services/config-manager.js'));
const { FilterManager } = require(path.join(DIST, 'services/filter-manager.js'));
const { SQLiteService } = require(path.join(DIST, 'services/sqlite-service.js'));

const base = {
  userName: ' Alice   Example ', bank: 'BCA', accountName: 'Alice Example',
  accountNumber: '0012-345 678', amount: 1000.6, status: 'Approved', done: 'Yes',
  depositType: 'SANITIZED', agent: 'Test Agent', processDate: ' 2026-08-01 10:20:30 ',
  createdAt: '2026-08-01 10:20:00'
};
function rows(names) { return names.map((name, i) => ({ ...base, userName: name, accountNumber: String(100000 + i) })); }
function scannerPage(pages) {
  const state = { i: 0 };
  return { state, page: {
    url: () => `https://example.invalid/deposits?page=${state.i + 1}`,
    evaluate: async fn => { const s=fn.toString(); if (/\.click\(\)/.test(s)) { state.i++; return {clicked:true}; } if (/aria-disabled/.test(s)) return state.i + 1 < pages.length; return state.i + 1; },
    waitForFunction: async()=>{}, waitForSelector:async()=>{}, waitForLoadState:async()=>{}, waitForTimeout:async()=>{}, $$:async()=>[], $$eval:async()=>[]
  }};
}
async function scan(pages, duplicateCheck, max=10) {
  const {page,state}=scannerPage(pages); const scanner=new PageScanner(page);
  scanner.htmlMapper={parseCurrentPage:async()=>({transactions:pages[state.i],rejections:[],rowsDetected:pages[state.i].length})};
  scanner.setDuplicateCheck(duplicateCheck); return scanner.scanPages({name:'Sanitized profile'},max);
}
(async () => {
  const fp = new FingerprintGenerator();
  assert.equal(fp.generate(base), '2ed37da2610fac3a1ca8fce5c28f5f838b40a623');
  assert.equal(fp.generate({...base,userName:'ALICE Example',amount:1000.4}), 'a8af3daf094b251e3b40d927c7efd8a363d6e5d5');
  assert.notEqual(fp.generate(base), fp.generate({...base,userName:'alice   example'}), 'username casing remains significant');
  assert.equal(fp.generate({...base,accountNumber:'0012 345-678'}), fp.generate(base), 'account punctuation/whitespace normalized');
  assert.equal(fp.generate({...base,amount:1000.49}), fp.generate({...base,amount:1000}), 'amount rounds to integer');
  assert.equal(fp.generate({...base,processDate:'2026-08-01 10:20:30'}), fp.generate(base), 'date outer whitespace normalized');
  assert.equal(fp.getShortFingerprint(fp.generate(base)), '2ED37DA2');
  assert.deepEqual(new TransactionValidator().validate(base), {valid:true,errors:[]});
  assert.deepEqual(new TransactionValidator().validate({...base,userName:' ',accountNumber:'',amount:NaN,processDate:' '}),
    {valid:false,errors:['Missing User Name','Missing Account Number','Invalid Amount','Invalid Process Date']});

  for (const [newCount,dupCount] of [[5,15],[1,19]]) {
    const p1=[...rows(Array.from({length:newCount},(_,i)=>`new${i}`)),...rows(Array.from({length:dupCount},(_,i)=>`dup${i}`))];
    const r=await scan([p1,rows(['dup-next'])], x=>x.userName.startsWith('dup'));
    assert.equal(r.perPage.length,2); assert.equal(r.terminationReason,'FULL_DUPLICATE_PAGE');
  }
  const allDup=await scan([rows(Array.from({length:20},(_,i)=>`dup${i}`)),rows(['new-never'])],()=>true);
  assert.equal(allDup.perPage.length,1); assert.equal(allDup.terminationReason,'FULL_DUPLICATE_PAGE'); assert.equal(allDup.perPage[0].duplicate,20);
  const initial=await scan([rows(Array.from({length:20},(_,i)=>`dup${i}`)),rows(['also-seen'])],null,2);
  assert.equal(initial.perPage.length,2); assert.equal(initial.terminationReason,'MAX_SCAN_REACHED');
  const maxOne=await scan([rows(['new']),rows(['never'])],()=>false,1);
  assert.equal(maxOne.lastPageScanned,1); assert.equal(maxOne.terminationReason,'MAX_SCAN_REACHED');

  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'phase0-'));
  const paths={getFilterProfilesPath:()=>path.join(tmp,'filters.json'),getAppConfigPath:()=>path.join(tmp,'app.json'),getGoogleSheetsConfigPath:()=>path.join(tmp,'sheets.json')};
  const saved=[{id:'legacy-1',name:'Legacy profile',enabled:true,priority:7,agent:'Agent Label',payment:'Payment Label',depositType:'legacy-value',status:'Approve',bank:'BCA',done:'Yes',verified:'Yes',firstDeposit:'No',username:'demo-user',accountName:'Demo Name',accountNumber:'000-111',includeKeyword:'safe',excludeKeyword:'test'}];
  fs.writeFileSync(paths.getFilterProfilesPath(),JSON.stringify(saved));
  const cm=new ConfigManager(paths), fm=new FilterManager(cm); await fm.loadProfiles();
  assert.deepEqual(fm.getAllProfiles(),saved); assert.equal(fm.getEnabledProfiles()[0].payment,'Payment Label');

  const gs=new GoogleSheetsService({}); const requests=[];
  gs.sheetsClient={spreadsheets:{values:{get:async()=>({data:{values:[['existing-user']]}}),update:async r=>requests.push(r)}}};
  gs.currentConfig={spreadsheetId:'sanitized-sheet-id',spreadsheetTitle:'Fixture'};
  const tx={...base,userName:'fixture-user',transactionFingerprint:fp.generate(base),filterProfile:'Fixture',exportStatus:'pending'};
  const exportResult=await gs.appendTransactions([tx]);
  assert.equal(exportResult.destinationRange,'MASTER!B3:E3');
  assert.deepEqual(requests[0].requestBody.values,[['fixture-user',1000.6,'2ED37DA2','2026-08-01 10:20:00']]);
  assert.equal(requests[0].valueInputOption,'USER_ENTERED');

  const dbPath=path.join(tmp,'existing.db');
  try {
    const old=new Database(dbPath); old.exec(`CREATE TABLE transactions (id INTEGER PRIMARY KEY AUTOINCREMENT, transaction_fingerprint TEXT NOT NULL UNIQUE,user_id TEXT NOT NULL,account_number TEXT NOT NULL,amount REAL NOT NULL,process_date TEXT NOT NULL,filter_profile TEXT NOT NULL,export_status TEXT NOT NULL DEFAULT 'pending',exported_at TEXT,created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE app_state(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); CREATE TABLE schema_version(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP); INSERT INTO schema_version(version) VALUES(1);`);
    old.prepare(`INSERT INTO transactions(transaction_fingerprint,user_id,account_number,amount,process_date,filter_profile,export_status) VALUES(?,?,?,?,?,?,?)`).run(tx.transactionFingerprint,'fixture-user','000111',100,'2026-08-01 00:00:00','Legacy profile','pending');
    old.prepare(`INSERT INTO app_state(key,value) VALUES('resume_marker','2ED37DA2')`).run(); old.close();
    const sqlite=new SQLiteService({getDatabasePath:()=>dbPath}); await sqlite.initialize();
    assert((await sqlite.loadFingerprints()).has(tx.transactionFingerprint));
    const pending=await sqlite.getPendingExports(); assert.equal(pending.length,1); assert.equal(pending[0].exportStatus,'pending'); assert.equal(await sqlite.getResumeMarker(),'2ED37DA2'); sqlite.close();
  } catch (error) {
    if (!/bindings file/.test(String(error && error.message))) throw error;
    const migrationSource=fs.readFileSync(path.resolve(__dirname,'../src/main/services/database-migration.ts'),'utf8');
    assert(/transaction_fingerprint TEXT NOT NULL UNIQUE/.test(migrationSource));
    assert(/CREATE TABLE IF NOT EXISTS app_state/.test(migrationSource));
    console.warn('WARN: SQLite runtime compatibility case skipped: better-sqlite3 native binding is unavailable for this Node ABI. Schema contract assertions passed.');
  }

  const engineSource=fs.readFileSync(path.resolve(__dirname,'../src/main/services/monitoring-engine.ts'),'utf8');
  assert(/retryQueue\.push\(\.\.\.pending\)/.test(engineSource), 'startup restores pending rows');
  assert(!/retryQueue\.(shift|pop|splice)\s*\(/.test(engineSource), 'characterizes absent retry consumer');
  console.log('PASS: Phase 0 characterization suite (fingerprint, validation, profiles, duplicate stop, initial sync, max page, Sheets, SQLite, retry recovery).');
})().catch(e=>{ console.error(e); process.exitCode=1; });
