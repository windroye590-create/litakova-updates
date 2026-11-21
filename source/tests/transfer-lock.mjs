// The actual Apps Script, with strict lock/flush ordering and isolated records.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {gzipSync} from 'node:zlib';
import * as C from '../web/core.js';
import {context,api,credential,instructorToken,regressionBody} from './fixtures/server_model.mjs';
const checks=[],measurements={};
async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
const group=api('POST','/api/instructor/groups',instructorToken,{name:'Ізольована передача великих тестів'}).group;
let sequence=0;
const person=()=>api('POST','/api/register','',{username:'transfer-lock-'+(++sequence),fullName:'Курсант перевірки '+sequence,groupId:group.id,...credential('synthetic-transfer-password')});
const owners=Array.from({length:5},person);
const question={text:'Розгорнуте питання з українським текстом. '.repeat(20),explanation:'Пояснення після завершення. '.repeat(50),answers:Array.from({length:6},(_,i)=>({text:'Варіант '+i+' — навчальний текст. '.repeat(12),isCorrect:i<2}))};
const training=api('POST','/api/instructor/tests',instructorToken,{title:'200 питань: передача',mode:'training',published:true,questions:Array.from({length:200},(_,i)=>({...structuredClone(question),text:i+' '+question.text}))}).test;
const exam=api('POST','/api/instructor/tests',instructorToken,{title:'200 питань: іспит',mode:'exam',published:true,durationMinutes:30,questions:training.questions}).test;
const original={lock:context.LockService.getScriptLock,flush:context.SpreadsheetApp.flush,copy:context.copyObject_,review:context.buildResultReview_,json:context.JSON,output:context.ContentService.createTextOutput};
let held=false,active=null;
const lock={tryLock(){assert.equal(held,false,'A request cannot take an already held mutation lock');held=true;active?.events.push('lock');return true;},releaseLock(){assert.equal(held,true);active?.events.push('unlock');held=false;}};
context.LockService.getScriptLock=()=>lock;
context.SpreadsheetApp.flush=()=>{if(active){assert.equal(held,true);active.flushes++;active.events.push('flush');if(active.failFlush){active.failFlush=false;throw Error('Injected final attempt flush failure');}}return original.flush();};
context.copyObject_=function(value){
 if(active&&value?.test?.questions?.length===200&&value.status&&!value.sourceTest){active.publicCopies.push(held);active.events.push('public-copy');}
 return original.copy(value);
};
context.buildResultReview_=function(...args){if(active){active.reviewLocks.push(held);active.events.push('review');}return original.review(...args);};
context.JSON={parse:JSON.parse,stringify(value,...args){if(active&&value?.ok!==undefined){active.serializations.push(held);active.events.push('serialize');}return JSON.stringify(value,...args);}};
const range=Object.getPrototypeOf(context.sheet_('results').getRange(1,1)),read=range.getValues,set=range.setValues;
range.getValues=function(){if(active&&!held)active.postUnlockReads++;return read.call(this);};
range.setValues=function(...args){if(active)assert.equal(held,true,'Sheets writes remain inside the lock');return set.apply(this,args);};
function request(owner,method,path,body={},legacy=false){const p=C.payload(method,path,owner.token,body);if(legacy)delete p.deliveryProtocol;return JSON.parse(context.doPost({postData:{contents:JSON.stringify(p)}}).text);}
function measure(name,run,extra={}){active={events:[],flushes:0,publicCopies:[],reviewLocks:[],serializations:[],postUnlockReads:0,...extra};try{const reply=run();assert.equal(held,false);measurements[name]=active;return reply;}finally{active=null;}}
function good(reply){assert.equal(reply.ok,true,reply.error);return reply;}
const body=(test,submissionId,permit)=>({...regressionBody(test,submissionId),writtenProtocol:1,choiceProtocol:2,answers:test.questions.map(q=>({questionId:q.id,answerIds:q.answers.filter(a=>a.isCorrect).map(a=>a.id)})),...(permit?{startPermit:permit}:{})});
try{
 const sid='pc-'+crypto.randomUUID();let accepted,started,finished;
 await check('A large training start serializes outside the lock and exposes no answer key',()=>{
  started=good(measure('trainingStart',()=>request(owners[0],'POST','/api/tests/'+training.id+'/start',{submissionId:sid})));
  assert.equal(started.test.questions.length,200);assert.equal(JSON.stringify(started).includes('isCorrect'),false);
  assert.deepEqual(measurements.trainingStart.serializations,[false]);assert.equal(measurements.trainingStart.flushes,0);
 });
 await check('A training result flushes and commits its cursor before unlocked review construction',()=>{
  accepted=good(measure('trainingFinish',()=>request(owners[0],'POST','/api/results',body(training,sid,started.startPermit))));
  assert.equal(accepted.result.correct,200);assert.equal(accepted.review.length,200);
  const m=measurements.trainingFinish;assert.deepEqual(m.reviewLocks,[false]);assert.deepEqual(m.serializations,[false]);assert.equal(m.flushes,1);assert.equal(m.postUnlockReads,0);
  assert.ok(m.events.indexOf('flush')<m.events.indexOf('unlock'));assert.ok(m.events.indexOf('unlock')<m.events.indexOf('review'));
  assert.equal(context.PropertiesService.getScriptProperties().getProperty('LK_WORKSPACE_WRITE'),null);
 });
 let began;
 await check('A large exam copies its public snapshot after unlocking while preserving all question IDs',()=>{
  began=good(measure('examStart',()=>request(owners[1],'POST','/api/exam-session/start',{testId:exam.id,deviceId:'synthetic-transfer-device',requestId:crypto.randomUUID()})));
  const m=measurements.examStart;assert.deepEqual(m.publicCopies,[false]);assert.deepEqual(m.serializations,[false]);assert.equal(m.postUnlockReads,0);assert.equal(m.flushes,1);
  assert.equal(began.document.value.test.questions.length,200);assert.equal(JSON.stringify(began).includes('sourceTest'),false);assert.equal(JSON.stringify(began).includes('isCorrect'),false);
  const raw=Buffer.from(JSON.stringify(began));const zipped=gzipSync(raw);measurements.syntheticWire={plainBytes:raw.length,gzipBytes:zipped.length};assert.ok(zipped.length<raw.length);
 });
 const v=()=>began.document.value;
 const finishBody=()=>({testId:exam.id,deviceId:'synthetic-transfer-device',requestId:crypto.randomUUID(),submissionId:v().submissionId,fence:v().fence,expectedRevision:began.document.revision,checkpoint:{answers:Object.fromEntries(exam.questions.map(q=>[q.id,q.answers.filter(a=>a.isCorrect).map(a=>a.id)])),index:199,exitCount:0}});
 let ending;
 await check('Exam completion keeps both durable writes locked and builds review and response after unlocking',()=>{
  ending=finishBody();finished=good(measure('examFinish',()=>request(owners[1],'POST','/api/exam-session/finish',ending)));
  assert.equal(finished.completion.result.correct,200);assert.equal(finished.document.value.status,'completed');
  const m=measurements.examFinish;assert.equal(m.flushes,2);assert.deepEqual(m.reviewLocks,[false]);assert.deepEqual(m.publicCopies,[false]);assert.deepEqual(m.serializations,[false]);assert.equal(m.postUnlockReads,0);
  assert.equal(Object.keys(JSON.parse(context.resultRecordById_(finished.completion.result.id).row[13])).length,200);
 });
 await check('Retrying an exam completion after a lost response returns exactly one saved result',()=>{
  const retried=good(request(owners[1],'POST','/api/exam-session/finish',ending));assert.equal(retried.completion.result.id,finished.completion.result.id);
  assert.equal(context.sheet_('results').rows.filter(r=>String(r[0])===String(finished.completion.result.id)).length,1);
 });
 await check('A failed training flush cannot acknowledge a result or clear its recovery obligation',()=>{
  const id='pc-'+crypto.randomUUID(),start=good(request(owners[2],'POST','/api/tests/'+training.id+'/start',{submissionId:id})),data=body(training,id,start.startPermit);
  const failed=measure('failedTrainingFlush',()=>request(owners[2],'POST','/api/results',data),{failFlush:true});assert.equal(failed.ok,false);
  assert.ok(context.PropertiesService.getScriptProperties().getProperty('LK_WORKSPACE_WRITE'));assert.deepEqual(measurements.failedTrainingFlush.reviewLocks,[]);
  const retried=good(request(owners[2],'POST','/api/results',data));assert.equal(retried.alreadyAccepted,true);
  assert.equal(context.sheet_('results').rows.filter(r=>String(r[1])===String(owners[2].user.id)&&String(r[4])===String(training.id)).length,1);
 });
 await check('Response construction failure preserves the committed work for an idempotent retry',()=>{
  const id='pc-'+crypto.randomUUID(),start=good(request(owners[3],'POST','/api/tests/'+training.id+'/start',{submissionId:id})),data=body(training,id,start.startPermit);
  const build=context.buildResultReview_;context.buildResultReview_=()=>{assert.equal(held,false);throw Error('Injected response presentation failure');};
  try{assert.equal(request(owners[3],'POST','/api/results',data).ok,false);}finally{context.buildResultReview_=build;}
  const again=good(request(owners[3],'POST','/api/results',data));assert.equal(again.alreadyAccepted,true);assert.equal(again.result.correct,200);
  assert.equal(context.sheet_('results').rows.filter(r=>String(r[1])===String(owners[3].user.id)&&String(r[4])===String(training.id)).length,1);
 });
 await check('Legacy clients retain their complete response and original locked presentation path',()=>{
  const id='pc-'+crypto.randomUUID(),start=good(request(owners[4],'POST','/api/tests/'+training.id+'/start',{submissionId:id},true));
  const accepted=good(measure('legacyTrainingFinish',()=>request(owners[4],'POST','/api/results',body(training,id,start.startPermit),true)));
  assert.equal(accepted.result.correct,200);assert.equal(accepted.review.length,200);assert.deepEqual(measurements.legacyTrainingFinish.reviewLocks,[true]);assert.deepEqual(measurements.legacyTrainingFinish.serializations,[true]);
 });
}finally{
 context.LockService.getScriptLock=original.lock;context.SpreadsheetApp.flush=original.flush;context.copyObject_=original.copy;context.buildResultReview_=original.review;context.JSON=original.json;context.ContentService.createTextOutput=original.output;range.getValues=read;range.setValues=set;
}
const report={status:'passed',passed:checks.length,checks,measurements,questions:200,actualAppsScriptExecuted:true,liveGoogleLoadMeasured:false,productionRequests:0};
fs.mkdirSync(new URL('../verification/',import.meta.url),{recursive:true});fs.writeFileSync(new URL('../verification/transfer-lock.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,passed:report.passed,syntheticWire:measurements.syntheticWire}));
