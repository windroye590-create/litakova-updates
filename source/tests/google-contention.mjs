// Real handlers and fault injection on isolated sheets; no Google credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
import * as C from '../web/core.js';
import {context,api,instructorToken,credential,regressionTest} from './fixtures/server_model.mjs';
const checks=[],measurements={};
async function check(name,work){await work();checks.push(name);console.log('PASS '+name);}
const RealDate=Date;let now=Date.now();
context.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}};
const group=api('POST','/api/instructor/groups',instructorToken,{name:'Контроль черги записів'}).group;
let serial=0;
const person=()=>api('POST','/api/register','',{fullName:'Синтетичний Курсант '+(++serial),username:'contention_'+serial,groupId:group.id,...credential('synthetic-contention-password')});
const learner=person(),other=person(),training=regressionTest('Контроль блокування',50);
const exam=api('POST','/api/instructor/tests',instructorToken,{title:'Контроль здачі',mode:'exam',durationMinutes:30,published:true,questions:training.questions}).test;
const states=context.sheet_('pcState'),results=context.sheet_('results'),props=context.PropertiesService.getScriptProperties(),cache=context.CacheService.getScriptCache();
const nativeDelete=states.deleteRows,nativeSingle=states.deleteRow,flush=context.SpreadsheetApp.flush;
function request(method,path,owner=learner,body={}){
 const reply=JSON.parse(context.doPost({postData:{contents:JSON.stringify(C.payload(method,path,owner.token,body))}}).text);
 if(!reply.ok)throw Object.assign(Error(reply.error),{code:reply.code});return reply;
}
function start(owner=learner){return request('POST','/api/exam-session/start',owner,{testId:exam.id,deviceId:'device-'+owner.user.id,requestId:randomUUID()});}
function finishBody(started,owner=learner){const v=started.document.value;return {testId:exam.id,submissionId:v.submissionId,deviceId:'device-'+owner.user.id,fence:v.fence,expectedRevision:started.document.revision,requestId:randomUUID(),checkpoint:{answers:Object.fromEntries(exam.questions.map(q=>[String(q.id),String(q.answers[0].id)])),index:49,exitCount:0}};}
function quiet(){now+=context.ATTEMPT_QUIET_MS_+1;}
function idleCompact(){quiet();for(let i=0;i<100&&props.getProperty('LK_PC_STATE_GC_V1');i++)context.compactPcState_();assert.equal(props.getProperty('LK_PC_STATE_GC_V1'),null);}
const headers=owner=>states.rows.filter(row=>String(row[0])===String(owner.user.id)&&row[1]==='exam-attempt'&&row[4]===-1);
let started,done,body;
await check('Authenticated attempt traffic pauses publication before it takes the shared lock',()=>{
 started=start();body=finishBody(started);done=request('POST','/api/exam-session/finish',learner,body);
 assert.equal(done.completion.result.correct,50);assert.equal(done.tableSynced,false);
 const pending=context.resultRecordById_(done.completion.result.id);assert.equal(pending.row[26],'pending');
 const before=JSON.stringify(context.publicResultsSheet_().rows),locking=context.LockService.getScriptLock;let attempts=0;
 context.LockService.getScriptLock=()=>{attempts++;return locking();};
 try{const reply=request('GET','/api/public-table-sync',{token:instructorToken});assert.equal(reply.publicTableSync.state,'pending');assert.equal(attempts,0);}finally{context.LockService.getScriptLock=locking;}
 assert.equal(JSON.stringify(context.publicResultsSheet_().rows),before);quiet();
 assert.equal(request('GET','/api/public-table-sync',{token:instructorToken}).publicTableSync.state,'synced');
});
await check('Waiting signed requests announce priority while forged requests cannot pause publication',()=>{
 const locking=context.LockService.getScriptLock;context.LockService.getScriptLock=()=>({tryLock:()=>false,releaseLock(){}});
 cache.remove(context.ATTEMPT_TRAFFIC_CACHE_);
 try{
  assert.throws(()=>request('POST','/api/tests/'+training.id+'/start',{token:'forged.token'},{submissionId:'pc-'+randomUUID()}),error=>error.code==='BUSY');
  assert.equal(cache.get(context.ATTEMPT_TRAFFIC_CACHE_),null);
  assert.throws(()=>request('POST','/api/tests/'+training.id+'/start',learner,{submissionId:'pc-'+randomUUID()}),error=>error.code==='BUSY');
  assert.ok(Number(cache.get(context.ATTEMPT_TRAFFIC_CACHE_))>now);
 }finally{context.LockService.getScriptLock=locking;}
});
await check('One finishing snapshot plus the result commit replace a redundant completed-state rewrite',()=>{
 assert.equal(headers(learner).length,2);assert.equal(headers(learner).at(-1)[2],started.document.revision+1);
 const diskValue=context.pcStateRead_(context.findUserById_(learner.user.id),'exam-attempt',context.pcStateLatest_(context.pcStateHeaders_(context.findUserById_(learner.user.id)),'exam-attempt')).value;
 assert.equal(diskValue.status,'finishing');assert.equal(Object.keys(diskValue.answers).length,50);
 const reply=request('GET','/api/exam-session');assert.equal(reply.document.value.status,'completed');assert.equal(reply.completion.result.id,done.completion.result.id);
 assert.equal(headers(learner).length,2);measurements.finishStateGenerations=1;
});
await check('Lost finish acknowledgement and a new session resolve to the same accepted result',()=>{
 const reply=request('POST','/api/exam-session/finish',learner,body);
 assert.equal(reply.document.value.status,'completed');assert.equal(reply.completion.result.id,done.completion.result.id);
 assert.equal(results.rows.filter(row=>String(row[0])===String(done.completion.result.id)).length,1);
 assert.equal(headers(learner).length,2);
 const second=api('POST','/api/instructor/tests',instructorToken,{title:'Наступний іспит',mode:'exam',durationMinutes:30,published:true,questions:training.questions}).test;
 assert.equal(request('POST','/api/exam-session/start',learner,{testId:second.id,deviceId:'device-'+learner.user.id,requestId:randomUUID()}).document.value.test.id,second.id);
});
await check('Repeated checkpoints never delete rows; idle batches retain the latest three exact snapshots',()=>{
 let value=start(other),revision=value.document.revision;const v=value.document.value;
 let deleted=0;states.deleteRow=()=>{deleted++;throw Error('No row deletion while saving');};states.deleteRows=()=>{deleted++;throw Error('No row deletion while saving');};
 try{for(let i=0;i<8;i++)revision=request('POST','/api/exam-session/save',other,{...finishBody(value,other),expectedRevision:revision,requestId:randomUUID(),checkpoint:{answers:{[String(exam.questions[0].id)]:String(exam.questions[0].answers[0].id)},index:i,exitCount:0}}).document.revision;}finally{states.deleteRow=nativeSingle;states.deleteRows=nativeDelete;}
 assert.equal(deleted,0);assert.equal(headers(other).length,9);
 const before=request('GET','/api/exam-session',other).document;
 context.compactPcState_();assert.equal(headers(other).length,9);
 const foreign=JSON.stringify(states.rows.filter(row=>String(row[0])===String(learner.user.id)));
 idleCompact();assert.equal(headers(other).length,3);
 assert.deepEqual(request('GET','/api/exam-session',other).document,before);
 assert.equal(JSON.stringify(states.rows.filter(row=>String(row[0])===String(learner.user.id))),foreign);
 measurements.checkpointRowDeletes=deleted;
});
await check('A partially acknowledged maintenance batch resumes using current row positions',()=>{
 const user=context.findUserById_(other.user.id);let doc=context.examDocument_(user);
 for(let i=0;i<4;i++)doc=context.examWrite_(user,doc,doc.value,randomUUID());
 const wanted=JSON.stringify(context.examDocument_(user).value),foreign=JSON.stringify(states.rows.filter(row=>String(row[0])===String(learner.user.id)));
 quiet();let dropped=false;states.deleteRows=function(first,count){nativeDelete.call(this,first,count);if(!dropped){dropped=true;throw Error('lost delete acknowledgement');}};
 try{assert.throws(()=>context.compactPcState_(),/lost delete acknowledgement/);}finally{states.deleteRows=nativeDelete;}
 assert.equal(props.getProperty('LK_PC_STATE_GC_V1'),'1');idleCompact();
 assert.equal(JSON.stringify(context.examDocument_(user).value),wanted);
 assert.equal(JSON.stringify(states.rows.filter(row=>String(row[0])===String(learner.user.id))),foreign);
});
await check('Either failed durable flush refuses acknowledgement; replay keeps one result and all answers',()=>{
 for(const failAt of [1,2]){
  const owner=person(),s=start(owner),b=finishBody(s,owner);let count=0;
  context.SpreadsheetApp.flush=()=>{if(++count===failAt)throw Error('Injected durable flush failure');return flush();};
  try{assert.throws(()=>request('POST','/api/exam-session/finish',owner,b),/Injected durable flush failure/);}finally{context.SpreadsheetApp.flush=flush;}
  const reply=request('POST','/api/exam-session/finish',owner,b),record=context.resultRecordById_(reply.completion.result.id);
  assert.equal(reply.document.value.status,'completed');assert.equal(Object.keys(JSON.parse(record.row[13])).length,50);
  assert.equal(results.rows.filter(row=>String(row[1])===String(owner.user.id)&&String(row[4])===String(exam.id)).length,1);
 }
});
await check('A Google service failure during authentication remains retryable and leaves the valid session usable',()=>{
 const find=context.findUserById_;context.findUserById_=()=>{throw Error('Transient Google service unavailable');};
 try{assert.throws(()=>request('GET','/api/workspace'),error=>error.code==='SERVER_ERROR');}finally{context.findUserById_=find;}
 assert.equal(request('GET','/api/workspace').user.id,learner.user.id);
 assert.throws(()=>request('GET','/api/workspace',{token:'bad.token'}),error=>error.code==='SESSION_EXPIRED');
});
await check('Signing reads its current secret once per mutation, then drops the request cache',()=>{
 const read=props.getProperty;let secretReads=0;props.getProperty=function(key){if(key==='APP_SECRET')secretReads++;return read.call(this,key);};
 try{request('POST','/api/tests/'+training.id+'/start',other,{submissionId:'pc-'+randomUUID()});}finally{props.getProperty=read;}
 assert.equal(secretReads,1);assert.equal(context.requestSigningSecret_,null);assert.equal(context.requestSigningActive_,false);measurements.secretReadsPerStart=secretReads;
});
await check('Busy delivery retries stay staggered and bounded while offline backoff remains exponential',()=>{
 for(const code of ['BUSY','STATE_BUSY','HTTP_429'])for(const n of [1,2,5,100]){
  const low=C.deliveryRetryDelay(n,code,()=>0),high=C.deliveryRetryDelay(n,code,()=>1);
  assert.ok(low>=2250&&high<=15000&&low<high);assert.ok(C.retryable(code));
 }
 assert.equal(C.deliveryRetryDelay(9,'NETWORK',()=>1),300000);
});
await check('Publication repairs only the matching details within a large unrelated history',()=>{
 const details=context.sheet_('resultDetails');
 for(let i=0;i<10000;i++)details.appendRow(['foreign-history-'+i,'foreign-user','foreign-test','Історія','foreign-question','Історія',false,new Date(now)]);
 const record=context.resultRecordById_(done.completion.result.id);record.row[26]='pending';
 const foreign=JSON.stringify(details.rows.filter(row=>String(row[0]).startsWith('foreign-history-'))),prototype=Object.getPrototypeOf(details.getRange(1,1)),get=prototype.getValues;
 let cells=0;prototype.getValues=function(){if(this.sheet===details)cells+=this.rowCount*this.columnCount;return get.call(this);};
 try{context.ensureResultAuxiliaries_(record.result,record.row);context.ensureResultAuxiliaries_(record.result,record.row);}finally{prototype.getValues=get;}
 assert.ok(cells<=800,'Worker read unrelated historical details');
 assert.equal(details.rows.filter(row=>String(row[0])===String(record.result.id)).length,50);
 assert.equal(JSON.stringify(details.rows.filter(row=>String(row[0]).startsWith('foreign-history-'))),foreign);
 measurements.publicationDetailReadCellsWith10000ForeignRows=cells;
});
fs.writeFileSync(new URL('../verification/google-contention.json',import.meta.url),JSON.stringify({status:'passed',passed:checks.length,checks,measurements,syntheticDataOnly:true,productionRequests:0,liveGoogleLoadMeasured:false},null,2)+'\n');
