// Operation counts and recovery against the actual application functions.
// Synthetic services only; these are not live Google timing measurements.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import * as C from '../web/core.js';
import {context, api, credential, instructorToken, regressionTest} from './fixtures/server_model.mjs';
const benchmark=process.argv.includes('--benchmark-only'),checks=[],measurements={};
async function check(name,work){await work();checks.push(name);console.log('PASS '+name);}
const group=api('POST','/api/instructor/groups',instructorToken,{name:'Ізольована перевірка затримок'}).group;
const owner=api('POST','/api/register','',{username:'latency-synthetic',fullName:'Синтетичний курсант затримок',groupId:group.id,...credential('synthetic-latency-password')});
const training=regressionTest('Затримки — 50 питань',50);
const exam=api('POST','/api/instructor/tests',instructorToken,{title:'Затримки — іспит 50',mode:'exam',durationMinutes:30,published:true,questions:training.questions}).test;
const book=context.spreadsheet_(),findSheet=book.getSheetByName;
let lookupCounts=null;
book.getSheetByName=function(name){if(lookupCounts)lookupCounts[name]=(lookupCounts[name]||0)+1;return findSheet.call(this,name);};
function request(path,body){const reply=JSON.parse(context.doPost({postData:{contents:JSON.stringify(C.payload('POST',path,owner.token,body))}}).text);if(!reply.ok)throw Object.assign(Error(reply.error),{code:reply.code});return reply;}
function measure(name,work){lookupCounts={};try{const result=work();measurements[name]={sheetHandleLookups:Object.values(lookupCounts).reduce((a,b)=>a+b,0),bySheet:{...lookupCounts}};return result;}finally{lookupCounts=null;}}
try{
 const begun=measure('trainingStart',()=>request('/api/tests/'+training.id+'/start',{submissionId:'pc-'+crypto.randomUUID()}));
 const submission={...C.submission({test:begun.test,answers:Object.fromEntries(training.questions.map(q=>[String(q.id),String(q.answers[0].id)])),submissionId:begun.submissionId,startedUptime:0,startPermit:begun.startPermit},100000)};
 const done=measure('trainingFinish',()=>request('/api/results',submission));assert.equal(done.result.correct,50);
 const started=measure('examStart',()=>request('/api/exam-session/start',{testId:exam.id,deviceId:'latency-device',requestId:crypto.randomUUID()}));
 const v=started.document.value,finish={testId:exam.id,deviceId:'latency-device',submissionId:v.submissionId,fence:v.fence,expectedRevision:started.document.revision,requestId:crypto.randomUUID(),checkpoint:{answers:Object.fromEntries(exam.questions.map(q=>[String(q.id),String(q.answers[0].id)])),index:49,exitCount:0}};
 const accepted=measure('examFinish',()=>request('/api/exam-session/finish',finish));assert.equal(accepted.completion.result.correct,50);
 if(!benchmark){
  await check('Sheet handles are reused only within one request; no request cache survives its response',()=>{assert.equal(context.requestSheetCache_,null);for(const name of ['trainingStart','trainingFinish','examStart','examFinish'])assert.ok(Object.values(measurements[name].bySheet).every(count=>count===1),name+' repeated a sheet lookup');});
  await check('Lost finish replies still resolve to one immutable result with all 50 answers',()=>{const retry=request('/api/exam-session/finish',finish);assert.equal(retry.completion.result.id,accepted.completion.result.id);const stored=context.resultRecordById_(accepted.completion.result.id);assert.equal(Object.keys(JSON.parse(stored.row[13])).length,50);});
  await check('Role and account status are read again on the next request',()=>{const users=context.sheet_('users'),row=users.rows.find(r=>String(r[0])===String(owner.user.id));row[7]=false;try{assert.throws(()=>request('/api/exam-session/finish',finish),e=>e.code==='SESSION_EXPIRED');assert.equal(context.requestSheetCache_,null);}finally{row[7]=true;}assert.equal(request('/api/exam-session/finish',finish).completion.result.id,accepted.completion.result.id);});
 }
}finally{book.getSheetByName=findSheet;}

const source=fs.readFileSync(process.env.LITAKOVA_LATENCY_APP_SOURCE||new URL('../web/app.js',import.meta.url),'utf8');
function install(box,name){const start=source.search(new RegExp('^(?:async )?function '+name+'\\(','m'));assert.ok(start>=0,name);const tail=source.slice(start+1).search(/\n(?:async )?function /);vm.runInContext(tail<0?source.slice(start):source.slice(start,start+1+tail),box);}
const clone=structuredClone,initialRun={test:clone(training),answers:{},index:0,submissionId:'pc-latency-navigation',startedUptime:100000,exitCount:0};
const account={run:clone(initialRun),pending:[]},state={journalSerial:0,session:owner,accounts:{[owner.user.id]:account}};
let fullWrites=0,journalWrites=0,durable=clone(state),lastJournal={},failJournal=false,backgroundCalls=0;
let timerSerial=0;const timers=new Map();
const box={C,structuredClone,TextEncoder,S:state,id:String,account:()=>account,user:()=>state.session?.user,instructor:()=>state.session?.user.role==='instructor',
 updateApplying:false,alive:()=>true,render(){},updateStorageNotice(){},toast(){},uptime:()=>101000,examSession:{elapsed:()=>1},accountSync:{changed(){}},
 saveTimer:null,scheduledSave:false,saving:null,checkpoint:null,journalSaving:Promise.resolve(),journalPending:0,journalError:'',lastTimerSaved:0,
 clearTimeout:key=>timers.delete(key),setTimeout:(run,delay)=>{timers.set(++timerSerial,{run,delay});return timerSerial;},
 diskWriter:{async save(){fullWrites++;durable=clone(state);}},
 local:async(path,value)=>{assert.equal(path,'/journal');journalWrites++;lastJournal=clone(value);if(failJournal)throw Error('Synthetic lost journal acknowledgement');return {ok:true};},
 backgroundTick:async()=>{backgroundCalls++;}
};vm.createContext(box);
for(const name of ['persist','scheduleSave','stamp','journal','runCheckpoint','moveQuestion'])install(box,name);
for(let i=0;i<50;i++){const q=account.run.test.questions[i];account.run.answers[String(q.id)]=String(q.answers[0].id);await box.moveQuestion(i);}
measurements.navigation50={fullProfileWritesBeforeIdle:fullWrites,journalWrites,pendingFullProfileWrites:timers.size};
if(!benchmark){
 await check('Fifty rapid answers and navigation steps retain every answer without fifty full profile rewrites',()=>{assert.equal(fullWrites,0);assert.equal(journalWrites,50);assert.equal(timers.size,1);const recovered=clone(durable);assert.ok(C.applyCheckpoint(recovered,lastJournal));assert.deepEqual(recovered.accounts[owner.user.id].run.answers,clone(account.run.answers));assert.equal(recovered.accounts[owner.user.id].run.index,49);});
 await check('One deferred full snapshot includes the latest answer and question index',async()=>{const timer=[...timers.values()][0];await timer.run();await box.saving;assert.equal(fullWrites,1);assert.deepEqual(durable.accounts[owner.user.id].run.answers,clone(account.run.answers));assert.equal(durable.accounts[owner.user.id].run.index,49);});
 await check('A lost journal acknowledgement rejects navigation persistence and retains a recoverable exact snapshot',async()=>{failJournal=true;await assert.rejects(()=>box.moveQuestion(21),/lost journal acknowledgement/);await Promise.resolve();assert.match(box.journalError,/lost journal acknowledgement/);const recovered=clone(durable);assert.ok(C.applyCheckpoint(recovered,lastJournal));assert.equal(recovered.accounts[owner.user.id].run.index,21);assert.deepEqual(recovered.accounts[owner.user.id].run.answers,clone(account.run.answers));failJournal=false;});
 install(box,'saveRunClock');
 await check('Clock checkpoints save elapsed time in the journal without rewriting full question text or starting a cloud request',async()=>{const fullBefore=fullWrites,journalBefore=journalWrites;box.saveRunClock();await box.journalSaving;box.saveRunClock();await box.journalSaving;assert.equal(fullWrites,fullBefore);assert.equal(journalWrites,journalBefore+1);assert.equal(lastJournal.lastElapsed,1);assert.equal(lastJournal.index,21);assert.equal(backgroundCalls,0);});
 install(box,'deliveryTick');
 await check('The faster wake-up skips idle, logged-out, instructor and paused application states',async()=>{await box.deliveryTick();assert.equal(backgroundCalls,0);state.session=null;await box.deliveryTick();state.session={user:{role:'instructor'}};await box.deliveryTick();state.session=owner;box.updateApplying=true;account.pending=[{}];await box.deliveryTick();assert.equal(backgroundCalls,0);box.updateApplying=false;});
 await check('Only due retryable results or an exam finishing/releasing wake delivery early',async()=>{account.pending=[{nextAt:Date.now()+60000}];await box.deliveryTick();assert.equal(backgroundCalls,0);account.pending=[{nextAt:Date.now()-1}];await box.deliveryTick();assert.equal(backgroundCalls,1);account.pending=[{permanent:true,failureCode:'FORBIDDEN'}];await box.deliveryTick();assert.equal(backgroundCalls,1);account.pending=[];account.run={examProtocol:1,finishRequested:true};await box.deliveryTick();account.run={examProtocol:1,releaseRequested:true};await box.deliveryTick();assert.equal(backgroundCalls,3);account.run={examProtocol:1};await box.deliveryTick();assert.equal(backgroundCalls,3);});
}
const report={status:'passed',passed:checks.length,checks,measurements,benchmarkOnly:benchmark,productionRequests:0,liveGoogleTimingMeasured:false};
fs.writeFileSync(process.env.LITAKOVA_LATENCY_REPORT||new URL('../verification/latency-optimization.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
