/** Phase 12 portable tests: no browser, network, Electron, SQLite, Google API, or real timers. */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/main');
const loggerSvc = require(path.join(DIST, 'main/services/logger-service.js'));
const logs = [];
loggerSvc.getLogger = () => ({ info(m){logs.push(m)}, warn(m){logs.push(m)}, error(m){logs.push(m)},
  debug(){}, success(){}, diag(){}, isDiagEnabled(){return false} });
const { MonitoringCycleSourceError, MonitoringFailurePolicy } = require(path.join(DIST, 'main/services/monitoring-failure-policy.js'));
const { MonitoringEngine } = require(path.join(DIST, 'main/services/monitoring-engine.js'));
const { TransactionValidator } = require(path.join(DIST, 'main/services/transaction-validator.js'));
const { FingerprintGenerator } = require(path.join(DIST, 'main/services/fingerprint-generator.js'));
const profile = { id:'p', name:'PGA', enabled:true, priority:1 };
const raw = { userName:'Trusted', bank:'BCA', accountName:'Trusted', accountNumber:'A1', amount:1000,
  status:'Approved', done:'Yes', depositType:'Bank', agent:'Agent', processDate:'2026-09-08 10:00:00', createdAt:'2026-09-08 09:59:00' };
const cfg = { version:'2', monitoring:{sourceMode:'AUTO',pollingInterval:2,maxPageScan:10,retryCount:0,
  requestTimeout:1,browserTimeout:1,batchSize:1000,maxCache:100}, browser:{},database:{},logging:{},
  features:{manualDateMode:true,initialSyncMode:false} };
const recovery = () => ({pendingFound:0,alreadyRemote:0,appended:0,reconciled:0,remaining:0,skipped:null,failureClass:null});
function scanResult(reason, transactions=[]) { return { transactions, perPage:[{pageNumber:1,rowsDetected:transactions.length,
  rowsParsed:transactions.length,rowsRejected:0,duplicate:0,buffered:0,exported:0}], navigationFailure:true,
  terminationReason:reason,lastPageScanned:1,configuredMaxPage:10 }; }
function harness(source={scan:async()=>scanResult('SESSION_EXPIRED')}, options={}) {
  const sqlite={claimTransaction:options.claimTransaction||(async()=>true),getPendingExports:async()=>[],getPendingExportCount:async()=>0,
    getTodayExportCount:async()=>0,getStoredTransactionCount:async()=>0,isReady:()=>true,getResumeMarker:async()=> 'MARKER',saveResumeMarker:async()=>{}};
  const sheets={isConnected:()=>false,connect:async()=>{}};
  const configManager={loadAppConfig:async()=>cfg,loadGoogleSheetsConfig:async()=>null};
  const filters={getEnabledProfiles:()=>[profile],loadProfiles:async()=>{}};
  const playwright={isReady:()=>true,validateSession:async()=>({ok:true})};
  const engine=new MonitoringEngine(playwright,filters,new TransactionValidator(),new FingerprintGenerator(),sqlite,sheets,configManager,source);
  engine.config=cfg; engine.isRunning=true; engine.recoverPendingExports=async()=>recovery();
  return {engine,sqlite,sheets,configManager};
}
(async()=>{
  // A-F: structured reason and real processFilter -> central ingest ordering.
  for (const reason of ['SESSION_EXPIRED','UNSAFE_RESPONSE','HTTP_FAILURE']) {
    const claimed=[]; const {engine}=harness({scan:async()=>scanResult(reason,[raw])},{claimTransaction:async tx=>{claimed.push(tx);return true}});
    let thrown; try { await engine.processFilter(profile,engine.sourceAdapterOverride) } catch(e) { thrown=e }
    assert.ok(thrown instanceof MonitoringCycleSourceError); assert.equal(thrown.terminationReason,reason);
    assert.equal(thrown.filterName,'PGA'); assert.equal(thrown.rowsHandedOff,1); assert.equal(claimed.length,1);
  }
  // G-AC: classification matrix and complete bounded ladder.
  let policy=new MonitoringFailurePolicy();
  for(const reason of ['SESSION_EXPIRED','UNSAFE_RESPONSE']) { const d=policy.decide(new MonitoringCycleSourceError(reason,'PGA',0),{requestedMode:'AUTO'});
    assert.equal(d.action,'PAUSE'); assert.equal(d.retryInMs,null); }
  policy=new MonitoringFailurePolicy();
  for(const expected of [5000,10000,20000,40000,60000,60000]) assert.equal(policy.decide(new MonitoringCycleSourceError('HTTP_FAILURE','PGA',0)).retryInMs,expected);
  policy.reset(); assert.equal(policy.decide(new MonitoringCycleSourceError('NAVIGATION_FAILURE','PGA',0)).retryInMs,5000);
  policy.reset(); assert.equal(policy.decide(new MonitoringCycleSourceError('BROWSER_FAILURE','PGA',0)).retryInMs,5000);
  for(const reason of ['REQUEST_CONTEXT_UNAVAILABLE','BROWSER_PAGE_UNAVAILABLE']) { const e=Object.assign(new Error('safe'),{code:reason,isCycleFatal:true});
    policy.reset(); assert.equal(policy.decide(e,{requestedMode:'AUTO'}).action,'RETRY'); policy.reset(); assert.equal(policy.decide(e,{requestedMode:'FAST'}).action,'PAUSE'); }
  for(const reason of ['REQUEST_FORM_MISSING','REQUEST_PARAMETER_MISSING','REQUEST_METHOD_UNSUPPORTED','REQUEST_URL_INVALID','REQUEST_ORIGIN_UNSAFE'])
    for(const requestedMode of ['AUTO','FAST']) assert.equal(policy.decide(Object.assign(new Error('safe'),{code:reason}),{requestedMode}).action,'PAUSE');
  policy.reset(); assert.deepEqual(policy.decide(Object.assign(new Error('unknown'),{isCycleFatal:true})),
    {action:'RETRY',reason:'UNKNOWN_CYCLE_FATAL',retryInMs:5000,consecutiveFailures:1});
  // AE-AN/AU-AV: real loop policy, pause persistence, retries, success reset, polling.
  let f=harness(), sleeps=[]; f.engine.runMonitoringCycle=async()=>{throw Object.assign(new MonitoringCycleSourceError('SESSION_EXPIRED','PGA',8),{requestedMode:'AUTO',effectiveMode:'FAST'})};
  f.engine.sleep=async ms=>sleeps.push(ms); await f.engine.runMonitoringLoop(); assert.equal(f.engine.getState(),'PAUSED');
  assert.equal(f.engine.isMonitoring(),false); assert.deepEqual(sleeps,[]); await f.engine.stopMonitoring(); assert.equal(f.engine.getState(),'IDLE');
  f=harness(); sleeps=[]; let attempts=0; const states=[]; f.engine.setStateChangeCallback(s=>states.push(s));
  f.engine.runMonitoringCycle=async()=>{attempts++;if(attempts<=2)throw Object.assign(new MonitoringCycleSourceError('HTTP_FAILURE','PGA',0),{requestedMode:'FAST',effectiveMode:'FAST'});f.engine.isRunning=false};
  f.engine.sleep=async ms=>sleeps.push(ms); await f.engine.runMonitoringLoop(); assert.deepEqual(sleeps,[5000,10000]); assert.ok(states.includes('ERROR'));
  f=harness(); sleeps=[]; attempts=0; f.engine.runMonitoringCycle=async()=>{attempts++;if(attempts<=2)throw Object.assign(new MonitoringCycleSourceError('HTTP_FAILURE','PGA',0),{requestedMode:'AUTO',effectiveMode:'FAST'});if(attempts===4)f.engine.isRunning=false};
  f.engine.sleep=async ms=>sleeps.push(ms); await f.engine.runMonitoringLoop(); assert.deepEqual(sleeps,[5000,10000,2000]);
  assert.equal(f.engine.failurePolicy.decide(new MonitoringCycleSourceError('HTTP_FAILURE','PGA',0)).retryInMs,5000);
  // AO-AT: startup rollback is retryable and preserves volatile state/marker.
  f=harness();f.engine.isRunning=false;f.engine.buffer=[raw];f.engine.resumeMarker='KEEP';f.configManager.loadGoogleSheetsConfig=async()=>({credentialJsonPath:'x'});
  f.sheets.connect=async()=>{throw new Error('google startup failure')}; await assert.rejects(()=>f.engine.startMonitoring('https://panel.example'),/google startup failure/);
  assert.equal(f.engine.isMonitoring(),false);assert.equal(f.engine.getState(),'ERROR');assert.equal(f.engine.buffer.length,1);assert.equal(f.engine.resumeMarker,'KEEP');
  f.sheets.connect=async()=>{};f.engine.resolveResumeMarker=async()=>{};f.engine.recoverPendingExports=async()=>recovery();f.engine.runMonitoringLoop=async()=>{};
  await f.engine.startMonitoring('https://panel.example');assert.equal(f.engine.isMonitoring(),true);f.engine.isRunning=false;
  for(const stage of ['resolve','recovery']) {f.engine.resolveResumeMarker=stage==='resolve'?async()=>{throw new Error('resume failure')}:async()=>{};
    f.engine.recoverPendingExports=stage==='recovery'?async()=>{throw new Error('recovery failure')}:async()=>recovery();await assert.rejects(()=>f.engine.startMonitoring('x'));
    assert.equal(f.engine.isMonitoring(),false);assert.equal(f.engine.getState(),'ERROR');}
  // AD/AW-BJ: architectural and security boundary guards.
  const es=fs.readFileSync(path.join(ROOT,'src/main/services/monitoring-engine.ts'),'utf8');
  const ps=fs.readFileSync(path.join(ROOT,'src/main/services/monitoring-failure-policy.ts'),'utf8');
  assert.match(es,/if \(error && error\.isProfileUnavailable\)/);assert.equal((es.match(/new ExportWriterQueue\(/g)||[]).length,1);
  assert.equal((es.match(/selectForCycle\(/g)||[]).length,1);assert.match(es,/advertised === 2 \? 2 : 1/);
  assert.doesNotMatch(es+ps,/newBrowser|newContext|request\.newContext|appendTransactions/);
  assert.doesNotMatch(logs.join('\n').toLowerCase(),/cookie|authorization|credential|token=/);
  assert.ok(logs.some(x=>x.includes('action=PAUSE reason=SESSION_EXPIRED')));
  assert.ok(logs.some(x=>x.includes('action=RETRY reason=HTTP_FAILURE consecutive=2 retryInMs=10000')));
  console.log('Phase 12 production hardening verification: PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
