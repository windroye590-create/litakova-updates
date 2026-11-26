// Successful HTTP/JSON responses are not sufficient to acknowledge an exam.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createExamSession} from '../web/exam-session.js';
import {audit,C,clone,model} from './storage-recovery/support.mjs';
const {api,check,finish}=audit('exam-response-retry');
const group=api('POST','/api/instructor/groups',model.instructorToken,{name:'Повтор неповної відповіді Google'}).group;
const test=api('POST','/api/instructor/tests',model.instructorToken,{title:'Перевірка відповіді сервера',mode:'exam',durationMinutes:20,published:true,questions:[{type:'written',text:'Збережіть відповідь',maxPoints:3,answers:[]}]}).test;
let sequence=0;
const health=()=>({ok:true,loadTestSandbox:true,namespace:'synthetic-only'});
function client(){
 const person=api('POST','/api/register','',{username:'response_retry_'+(++sequence),fullName:'Синтетична перевірка '+sequence,groupId:group.id,...model.credential('synthetic-password')});
 const a={run:null},sent=[],waits=[],completions=[];let hook=null,pauseHook=null,at=0,disk=clone(a),session={token:person.token,user:person.user};
 const controller=createExamSession({session:()=>session,account:()=>a,deviceId:()=> 'response-device-'+person.user.id,now:()=>at,random:()=>0,
  persist:async()=>{disk=clone(a);},completed:async r=>completions.push(clone(r)),pause:async n=>{waits.push(n);at+=n;if(pauseHook)pauseHook();},
  rpc:async(m,path,body,token)=>{sent.push({path,body:clone(body)});return hook?hook(m,path,body,token):api(m,path,token,body);}});
 return {a,controller,sent,waits,completions,person,disk:()=>disk,hook:f=>hook=f,pauseHook:f=>pauseHook=f,switch:()=>{session={token:'other-session',user:{id:'other-user',role:'cadet'}};}};
}
await check('A health response before start is rejected then retried with the exact original request ID',async()=>{
 const pc=client();let first=true;
 pc.hook((m,path,b,t)=>{if(first){first=false;return health();}return api(m,path,t,b);});
 await pc.controller.start(test.id);assert.equal(pc.sent.length,2);assert.deepEqual(pc.sent[0],pc.sent[1]);assert.deepEqual(pc.waits,[2500]);assert.ok(pc.controller.owned());assert.equal(pc.a.run.revision,1);
});
await check('A committed start with an unrelated acknowledgement resumes one original attempt with its fixed deadline',async()=>{
 const pc=client();let first=true,original;
 pc.hook((m,path,b,t)=>{const r=api(m,path,t,b);if(first){first=false;original=clone(r);return health();}return r;});
 await pc.controller.start(test.id);assert.equal(pc.sent.length,2);assert.deepEqual(pc.sent[0],pc.sent[1]);
 assert.equal(pc.a.run.submissionId,original.document.value.submissionId);assert.equal(pc.a.run.deadline,original.document.value.deadline);assert.equal(pc.a.run.fence,original.document.value.fence);assert.equal(pc.a.run.revision,1);
});
await check('A committed save followed by a health response retries identical answers and does not create an extra revision',async()=>{
 const pc=client();await pc.controller.start(test.id);pc.a.run.answers[test.questions[0].id]='Точна відповідь 🇺🇦';const before=pc.a.run.revision;let first=true;
 pc.hook((m,path,b,t)=>{const r=api(m,path,t,b);if(path.endsWith('/save')&&first){first=false;return health();}return r;});
 await pc.controller.sync();const saves=pc.sent.filter(x=>x.path.endsWith('/save'));assert.equal(saves.length,2);assert.deepEqual(saves[0],saves[1]);assert.equal(pc.a.run.revision,before+1);assert.equal(pc.a.run.answers[test.questions[0].id],'Точна відповідь 🇺🇦');assert.equal(pc.a.examRequest,undefined);
});
await check('A committed finish with a health response confirms one result using the frozen final request',async()=>{
 const pc=client();await pc.controller.start(test.id);pc.a.run.answers[test.questions[0].id]='Остаточний текст';let first=true;
 pc.hook((m,path,b,t)=>{const r=api(m,path,t,b);if(path.endsWith('/finish')&&first){first=false;return health();}return r;});
 await pc.controller.finish();const sends=pc.sent.filter(x=>x.path.endsWith('/finish'));assert.equal(sends.length,2);assert.deepEqual(sends[0],sends[1]);assert.equal(pc.completions.length,1);assert.equal(pc.completions[0].review[0].text,'Остаточний текст');assert.equal(pc.a.run,null);
 assert.equal(api('GET','/api/my-results',pc.person.token).results.filter(r=>r.testId===test.id).length,1);
});
await check('Persistent missing envelopes stop bounded retries and keep the disk finish intent until a valid acknowledgement',async()=>{
 const pc=client();await pc.controller.start(test.id);pc.a.run.answers[test.questions[0].id]='Не втрачати';
 pc.hook((m,path,b,t)=>{api(m,path,t,b);return health();});
 await assert.rejects(pc.controller.finish(),e=>e.code==='BAD_EXAM_RESPONSE'&&C.retryable(e.code));
 const sends=pc.sent.filter(x=>x.path.endsWith('/finish'));assert.equal(sends.length,3);for(const s of sends)assert.deepEqual(s,sends[0]);
 assert.equal(pc.completions.length,0);assert.equal(pc.disk().run.finishCheckpoint.answers[test.questions[0].id],'Не втрачати');assert.equal(pc.a.run.finishRequested,true);
 pc.hook(null);await pc.controller.finish();assert.equal(pc.a.run,null);assert.equal(pc.completions.length,1);
 assert.equal(api('GET','/api/my-results',pc.person.token).results.filter(r=>r.testId===test.id).length,1);
});
await check('A reply for another account remains a nonretryable validation error and cannot unlock the exam',async()=>{
 const pc=client();pc.hook((m,path,b,t)=>({...api(m,path,t,b),userId:'other-user'}));
 await assert.rejects(pc.controller.start(test.id),e=>e.code==='BAD_EXAM_STATE');assert.equal(pc.sent.length,1);assert.equal(pc.waits.length,0);assert.equal(pc.a.run,null);assert.equal(pc.controller.owned(),false);
});
await check('Unrelated discovery responses cannot erase an active local answer or acknowledge its pending checkpoint',async()=>{
 const pc=client();await pc.controller.start(test.id);pc.a.run.answers[test.questions[0].id]='Локальна відповідь';const before=clone(pc.a);
 pc.hook(()=>health());await assert.rejects(pc.controller.discover(),e=>e.code==='BAD_EXAM_RESPONSE');assert.deepEqual(pc.a,before);assert.equal(pc.controller.status().pending,true);
});
await check('Switching accounts during a retry pause prevents sending another request with the previous session',async()=>{
 const pc=client();pc.hook(()=>health());pc.pauseHook(()=>pc.switch());assert.equal(await pc.controller.start(test.id),false);assert.equal(pc.sent.length,1);assert.equal(pc.a.run,null);
});
const report=finish({replayedLiveRun:45775264237,automaticAttemptsPerRequest:3,strictExamValidationPreserved:true,productionRequests:0});
fs.writeFileSync(new URL('../verification/exam-response-retry.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
