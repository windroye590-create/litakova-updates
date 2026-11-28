// Real server handlers and controller; isolated identities, no live Google RPCs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import * as C from '../web/core.js';
const {createExamSession}=await import(process.env.LITAKOVA_EXAM_SYNC_CONTROLLER_SOURCE?pathToFileURL(process.env.LITAKOVA_EXAM_SYNC_CONTROLLER_SOURCE).href:new URL('../web/exam-session.js',import.meta.url).href);
const {context,api,credential,instructorToken}=await import('./fixtures/server_model.mjs');
const benchmark=process.argv.includes('--benchmark-only'),checks=[],measurements={},clone=structuredClone;
async function check(name,work){await work();checks.push(name);console.log('PASS '+name);}
let serverTime=Date.now(),serial=0;const RealDate=Date;
context.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[serverTime]));}static now(){return serverTime;}};
const group=api('POST','/api/instructor/groups',instructorToken,{name:'Ізольована коротка синхронізація'}).group;
function person(){return api('POST','/api/register','',{username:'short_sync_'+(++serial),fullName:'Синтетична коротка синхронізація '+serial,groupId:group.id,...credential('synthetic-compact-sync-password')});}
function makeTest(count){return api('POST','/api/instructor/tests',instructorToken,{title:'Короткий обмін '+count,mode:'exam',durationMinutes:30,published:true,questions:Array.from({length:count},(_,i)=>count===200&&i%10===1?{type:'written',text:('Поясніть відповідь на питання '+i+'. ').repeat(4),maxPoints:3,rubric:'PRIVATE-COMPACT-RUBRIC',answers:[]}:{type:'choice',text:('Контрольне запитання '+i+' українською мовою. ').repeat(4),answers:Array.from({length:4},(_,j)=>({text:('Варіант '+j+' відповіді. ').repeat(4),isCorrect:j===0||i%5===0&&j===1}))})}).test;}
let parsing=0;const parse=context.parseQuestions_;
context.parseQuestions_=function(...args){parsing++;return parse.apply(this,args);};
function wire(owner,method,path,body){const raw=context.doPost({postData:{contents:JSON.stringify(C.payload(method,path,owner.token,body))}}).text;const reply=JSON.parse(raw);if(!reply.ok)throw Object.assign(Error(reply.error),{code:reply.code});return {reply,bytes:Buffer.byteLength(raw)};}
function pc(owner=person(),initial={},device='compact-device-'+owner.user.id){
 let session={token:owner.token,user:owner.user},hook=null,legacy=false,failDisk=false,clock=10000,saves=0,disk=clone(initial);
 const a={run:null,...clone(initial)},calls=[],completions=[];
 const controller=createExamSession({session:()=>session,account:()=>a,deviceId:()=>device,now:()=>clock,
  persist:async()=>{saves++;if(failDisk)throw Error('Synthetic local storage failure');disk=clone(a);},completed:async value=>completions.push(clone(value)),pause:async()=>{},
  rpc:async(method,path,body)=>{const durableRequestId=disk.examRequest?.requestId,sent=clone(body);if(legacy)delete sent.examSyncProtocol;const before=parsing,result=wire(owner,method,path,sent),call={method,path,body:clone(body),reply:clone(result.reply),bytes:result.bytes,questionParses:parsing-before,durableRequestId};calls.push(call);return hook?hook(call):clone(result.reply);}});
 return {owner,a,device,controller,calls,completions,saves:()=>saves,disk:()=>disk,failDisk:value=>failDisk=value,hook:value=>hook=value,legacy:()=>legacy=true,advance:ms=>{clock+=ms;serverTime+=ms;},switch:()=>session={token:'other-session',user:{id:'other-owner',role:'cadet'}}};
}
function answerAll(p,test){const byId=new Map(test.questions.map(q=>[String(q.id),q]));p.a.run.answers=Object.fromEntries(p.a.run.test.questions.map(q=>{const original=byId.get(String(q.id));return [String(q.id),q.type==='written'?'Точний текст\nписьмової відповіді':C.choiceValue(q,original.answers.filter(a=>a.isCorrect).map(a=>String(a.id)))];}));p.a.run.index=test.questions.length-1;}
const small=makeTest(50),large=makeTest(200);
for(const test of [small,large]){
 const p=pc();await p.controller.start(test.id);const original=clone(p.a.run.test),deadline=p.a.run.deadline;
 let writes=p.saves();await p.controller.discover();const read=p.calls.at(-1),fullRead=wire(p.owner,'GET','/api/exam-session',{});
 answerAll(p,test);const expected=clone(p.a.run.answers);await p.controller.sync();const saved=p.calls.at(-1);
 const full=wire(p.owner,'GET','/api/exam-session',{});
 measurements['questions'+test.questions.length]={readBytes:read.bytes,fullReadBytes:fullRead.bytes,saveBytes:saved.bytes,fullBytes:full.bytes,readQuestionParses:read.questionParses,saveQuestionParses:saved.questionParses,readProfileWrites:p.saves()-writes-2};
 // Count the unchanged read separately, because a save durably records its ID and acknowledgement.
 writes=p.saves();await p.controller.discover();measurements['questions'+test.questions.length].unchangedProfileWrites=p.saves()-writes;
 assert.deepEqual(p.a.run.test,original);assert.equal(p.a.run.deadline,deadline);
 const remote=context.examDocument_(context.findUserById_(p.owner.user.id));assert.deepEqual(JSON.parse(JSON.stringify(remote.value.answers)),expected);
 if(!benchmark){
  await check(test.questions.length+' questions: unchanged read omits question text and does not rewrite the profile',()=>{assert.equal(read.reply.document.questionsOmitted,true);assert.equal(read.reply.document.unchanged,true);assert.equal(read.questionParses,0);assert.ok(read.bytes<full.bytes*.15);assert.equal(measurements['questions'+test.questions.length].unchangedProfileWrites,0);});
  await check(test.questions.length+' questions: short save acknowledges exact choices and written text after the durable write',()=>{assert.equal(saved.reply.document.questionsOmitted,true);assert.equal(saved.reply.document.unchanged,false);assert.equal(saved.reply.document.revision,2);assert.equal(saved.questionParses,1);assert.ok(saved.bytes<full.bytes*.2);assert.equal(p.a.examRequest,undefined);assert.deepEqual(p.disk().run.answers,expected);assert.ok(!JSON.stringify(saved.reply).includes('PRIVATE-COMPACT-RUBRIC'));});
  await check(test.questions.length+' questions: clients without the optional protocol still receive the full frozen test',()=>{assert.equal(full.reply.document.questionsOmitted,undefined);assert.deepEqual(full.reply.document.value.test,original);});
 }
}
if(!benchmark){
 await check('An unchanged short read cannot hide an unacknowledged initial full snapshot',async()=>{
  const p=pc();p.failDisk(true);await assert.rejects(()=>p.controller.start(small.id),e=>e.localSave===true);assert.equal(p.disk().run,undefined);await assert.rejects(()=>p.controller.discover(),e=>e.localSave===true);assert.equal(p.disk().run,undefined);p.failDisk(false);const before=p.saves();await p.controller.discover();assert.equal(p.calls.at(-1).reply.document.questionsOmitted,true);assert.equal(p.saves(),before+1);assert.equal(p.disk().run.test.questions.length,50);await p.controller.discover();assert.equal(p.saves(),before+1);
 });
 await check('A failed local request-ID save is retried before any compact cloud write',async()=>{
  const p=pc();await p.controller.start(small.id);answerAll(p,small);p.failDisk(true);await assert.rejects(()=>p.controller.sync(),e=>e.localSave===true);const pending=clone(p.a.examRequest);await assert.rejects(()=>p.controller.sync(),e=>e.localSave===true);assert.equal(p.calls.filter(c=>c.path.endsWith('/save')).length,0);p.failDisk(false);await p.controller.sync();const sent=p.calls.filter(c=>c.path.endsWith('/save'));assert.equal(sent.length,1);assert.equal(sent[0].durableRequestId,pending.requestId);assert.equal(sent[0].body.requestId,pending.requestId);assert.equal(p.a.run.revision,2);
 });
 await check('New clients retain full-response compatibility when the server ignores the optional protocol',async()=>{
  const p=pc();p.legacy();await p.controller.start(small.id);answerAll(p,small);const expected=clone(p.a.run.answers);await p.controller.sync();assert.equal(p.calls.at(-1).reply.document.questionsOmitted,undefined);assert.deepEqual(p.a.run.answers,expected);await p.controller.discover();assert.equal(p.calls.at(-1).reply.document.questionsOmitted,undefined);await p.controller.finish();assert.equal(p.completions[0].result.correct,50);
 });
 await check('Incomplete compact state cannot acknowledge a save without a complete fallback',async()=>{
  const p=pc();await p.controller.start(small.id);answerAll(p,small);let first=true;p.hook(call=>{const r=clone(call.reply);if(first&&r.document.questionsOmitted){first=false;delete r.document.value.answers;}return r;});await p.controller.sync();assert.equal(p.calls.filter(c=>c.path.endsWith('/save')).length,2);assert.equal(p.calls.at(-1).reply.document.questionsOmitted,undefined);assert.equal(p.a.run.revision,2);assert.equal(p.a.examRequest,undefined);
 });
 await check('Wrong revision, device, fence or attempt identity fall back to a complete response',async()=>{
  const p=pc();await p.controller.start(small.id);await p.controller.discover();const hint=clone(p.calls.at(-1).body);
  for(const patch of [{knownRevision:0},{knownFence:999},{knownDeviceId:'another-device'},{knownTestId:'another-test'},{knownSubmissionId:'another-attempt'},{examSyncProtocol:2}]){const r=wire(p.owner,'GET','/api/exam-session',{...hint,...patch}).reply;assert.equal(r.document.questionsOmitted,undefined);assert.equal(r.document.value.test.questions.length,50);assert.equal(String(r.userId),String(p.owner.user.id));}
 });
 await check('A foreign attempt hint can only return the authenticated cadet own attempt',async()=>{
  const a=pc(),b=pc();await a.controller.start(small.id);await a.controller.discover();await b.controller.start(large.id);const reply=wire(b.owner,'GET','/api/exam-session',a.calls.at(-1).body).reply;assert.equal(String(reply.userId),String(b.owner.user.id));assert.equal(reply.document.value.test.questions.length,200);assert.equal(reply.document.questionsOmitted,undefined);assert.notEqual(reply.document.value.submissionId,a.a.run.submissionId);
 });
 await check('The optional short protocol cannot bypass the multiple-choice compatibility requirement',async()=>{
  const p=pc();await p.controller.start(small.id);await p.controller.discover();const request={...C.payload('GET','/api/exam-session',p.owner.token,p.calls.at(-1).body),choiceProtocol:1};const reply=JSON.parse(context.doPost({postData:{contents:JSON.stringify(request)}}).text);assert.equal(reply.ok,false);assert.equal(reply.code,'UPDATE_REQUIRED');
 });
 await check('A malformed short read is retried once with a full response and the local answers survive',async()=>{
  const p=pc();await p.controller.start(small.id);answerAll(p,small);const expected=clone(p.a.run.answers);let first=true;
  p.hook(call=>{const r=clone(call.reply);if(first&&r.document.questionsOmitted){first=false;r.document.value.submissionId='wrong-attempt';}return r;});
  const before=p.calls.length;await p.controller.discover();assert.equal(p.calls.length-before,2);assert.equal(p.calls.at(-1).body.examSyncProtocol,undefined);assert.deepEqual(p.a.run.answers,expected);assert.equal(p.a.run.test.questions.length,50);
 });
 await check('A malformed short save replays the same request ID and checkpoint without a second commit',async()=>{
  const p=pc();await p.controller.start(small.id);answerAll(p,small);let first=true;
  p.hook(call=>{const r=clone(call.reply);if(first&&r.document.questionsOmitted){first=false;r.document.value.deadline++;}return r;});
  await p.controller.sync();const sent=p.calls.filter(c=>c.path.endsWith('/save'));assert.equal(sent.length,2);assert.equal(sent[0].body.requestId,sent[1].body.requestId);assert.deepEqual(sent[0].body.checkpoint,sent[1].body.checkpoint);assert.equal(sent[1].body.examSyncProtocol,undefined);assert.equal(context.examDocument_(context.findUserById_(p.owner.user.id)).revision,2);assert.equal(p.a.examRequest,undefined);
 });
 await check('An unsolicited short reply after full fallback is rejected without clearing unsent work',async()=>{
  const p=pc();await p.controller.start(small.id);answerAll(p,small);const expected=clone(p.a.run.answers);
  p.hook(call=>{const r=clone(call.reply);r.examSyncProtocol=1;r.document.questionsOmitted=true;r.document.unchanged=true;r.document.value.ownerId='unrelated-device';r.document.value.test={id:r.document.value.test.id};return r;});
  await assert.rejects(()=>p.controller.discover(),e=>e.code==='BAD_EXAM_STATE');assert.deepEqual(p.a.run.answers,expected);assert.equal(p.a.run.test.questions.length,50);assert.equal(p.controller.status().pending,true);
 });
 await check('Lost save acknowledgement keeps one request and reuses the committed revision after reconnect',async()=>{
  const p=pc();await p.controller.start(large.id);answerAll(p,large);const expected=clone(p.a.run.answers);let first=true;
  p.hook(call=>{if(first&&call.path.endsWith('/save')){first=false;throw Object.assign(Error('Lost acknowledgement'),{code:'NETWORK'});}return clone(call.reply);});
  await assert.rejects(()=>p.controller.sync(),e=>e.code==='NETWORK');const pending=clone(p.a.examRequest);assert.equal(p.disk().examRequest.requestId,pending.requestId);await p.controller.sync();const sent=p.calls.filter(c=>c.path.endsWith('/save'));assert.equal(sent.length,2);assert.equal(sent[1].body.requestId,pending.requestId);assert.deepEqual(sent[1].body.checkpoint,pending.checkpoint);assert.equal(p.a.run.revision,2);assert.equal(p.a.examRequest,undefined);assert.deepEqual(p.a.run.answers,expected);
 });
 await check('Typing during a slow short save is retained and the newer answers are acknowledged next',async()=>{
  const p=pc();await p.controller.start(large.id);answerAll(p,large);const q=p.a.run.test.questions.find(q=>q.type==='written');let first=true;
  p.hook(call=>{if(first&&call.path.endsWith('/save')){first=false;p.a.run.answers[String(q.id)]='Новий текст під час запиту';}return clone(call.reply);});
  await p.controller.sync();assert.equal(p.calls.filter(c=>c.path.endsWith('/save')).length,2);assert.equal(p.a.run.revision,3);assert.equal(context.examDocument_(context.findUserById_(p.owner.user.id)).value.answers[String(q.id)],'Новий текст під час запиту');assert.equal(p.disk().run.answers[String(q.id)],'Новий текст під час запиту');
 });
 await check('Handoff and claim use full responses; the former owner is fenced and keeps its unsent backup',async()=>{
  const p=pc();await p.controller.start(small.id);const deadline=p.a.run.deadline;answerAll(p,small);await p.controller.sync();const other=pc(p.owner,{},'second-compact-device');await other.controller.discover();assert.equal(other.calls.at(-1).reply.document.questionsOmitted,undefined);await other.controller.claim();assert.equal(other.calls.at(-1).reply.document.questionsOmitted,undefined);
  p.a.run.answers[String(p.a.run.test.questions[0].id)]='0';await p.controller.discover();assert.equal(p.calls.at(-1).reply.document.questionsOmitted,undefined);assert.equal(p.controller.owned(),false);assert.ok(p.a.examBackups.length);assert.equal(p.a.run.deadline,deadline);await other.controller.release();assert.equal(other.calls.at(-1).reply.document.questionsOmitted,undefined);
 });
 await check('Finishing elsewhere returns the complete authoritative result instead of a short active response',async()=>{
  const p=pc();await p.controller.start(small.id);answerAll(p,small);await p.controller.sync();const r=p.a.run;
  wire(p.owner,'POST','/api/exam-session/finish',{testId:r.test.id,submissionId:r.submissionId,deviceId:p.device,fence:r.fence,expectedRevision:r.revision,requestId:crypto.randomUUID(),checkpoint:{answers:clone(r.answers),index:r.index,exitCount:0}});
  await p.controller.discover();assert.equal(p.calls.at(-1).reply.document.questionsOmitted,undefined);assert.equal(p.completions.length,1);assert.equal(p.a.run,null);assert.equal(p.completions[0].result.correct,50);
 });
 await check('Finishing and account replacement never reuse an old cached question set',async()=>{
  const p=pc();await p.controller.start(small.id);answerAll(p,small);await p.controller.finish();assert.equal(p.calls.at(-1).body.examSyncProtocol,undefined);assert.equal(p.calls.at(-1).reply.document.questionsOmitted,undefined);assert.equal(p.completions[0].result.correct,50);await p.controller.start(large.id);assert.equal(p.calls.at(-1).reply.document.questionsOmitted,undefined);assert.equal(p.a.run.test.questions.length,200);
 });
 await check('Revoked access is checked afresh before any short response is returned',async()=>{
  const p=pc();await p.controller.start(small.id);answerAll(p,small);const expected=clone(p.a.run.answers),row=context.sheet_('users').rows.find(r=>String(r[0])===String(p.owner.user.id));row[7]=false;
  try{await assert.rejects(()=>p.controller.discover(),e=>e.code==='SESSION_EXPIRED');assert.deepEqual(p.a.run.answers,expected);}finally{row[7]=true;}
 });
 await check('Account changes during short-read fallback cannot trigger another request for the previous account',async()=>{
  const p=pc();await p.controller.start(small.id);const before=p.calls.length;
  p.hook(call=>{const r=clone(call.reply);r.document.value.fence++;p.switch();return r;});assert.equal(await p.controller.discover(),false);assert.equal(p.calls.length,before+1);
 });
 await check('Clock updates stay monotonic, and an expired attempt gets a full state',async()=>{
  const p=pc();await p.controller.start(small.id);p.advance(5000);const before=p.controller.elapsed();p.hook(call=>{const r=clone(call.reply);r.serverNow-=10000;return r;});await p.controller.discover();assert.ok(p.controller.elapsed()>=before);p.hook(null);serverTime=p.a.run.deadline+1;await p.controller.discover();assert.equal(p.calls.at(-1).reply.document.questionsOmitted,undefined);assert.ok(p.controller.expired());
 });
}
context.parseQuestions_=parse;
const report={status:'passed',passed:checks.length,checks,measurements,benchmarkOnly:benchmark,productionRequests:0,liveGoogleTimingMeasured:false,
 serverSHA256:createHash('sha256').update(fs.readFileSync(process.env.LITAKOVA_SERVER_SOURCE||new URL('../Code.gs',import.meta.url))).digest('hex'),
 controllerSHA256:createHash('sha256').update(fs.readFileSync(process.env.LITAKOVA_EXAM_SYNC_CONTROLLER_SOURCE||new URL('../web/exam-session.js',import.meta.url))).digest('hex')};
fs.writeFileSync(process.env.LITAKOVA_EXAM_SYNC_REPORT||new URL('../verification/exam-sync-compact.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
