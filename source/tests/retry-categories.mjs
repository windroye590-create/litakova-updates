// Replay the live BUSY x4 -> lost acknowledgement trace against real controllers.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {createExamSession} from '../web/exam-session.js';
import {audit,C,model,install,clone} from './storage-recovery/support.mjs';
const {api,check,finish}=audit('retry-categories');
const group=api('POST','/api/instructor/groups',model.instructorToken,{name:'Повтор після зміни помилки'}).group;
const p=api('POST','/api/register','',{username:'retry_categories',fullName:'Тест повторів',groupId:group.id,...model.credential('synthetic-password')});
const t=api('POST','/api/instructor/tests',model.instructorToken,{title:'Повтор збереження',mode:'exam',durationMinutes:20,published:true,questions:[{type:'written',text:'Відповідь',maxPoints:3,answers:[]}]}).test;
const source=fs.readFileSync(new URL('./live-google-load.mjs',import.meta.url),'utf8');
const retrySource=source.slice(source.indexOf('async function retry('),source.indexOf('async function stage('));
await check('Capacity and network streaks reset independently while consecutive outages retain bounded exponential backoff',()=>{
 let state=null;
 for(let i=1;i<=20;i++){state=C.nextDeliveryRetry(state,'BUSY');assert.equal(state.attempt,i);assert.ok(C.deliveryRetryDelay(i,'BUSY',()=>1)<=15000);}
 state=C.nextDeliveryRetry(state,'TIMEOUT');assert.equal(state.attempt,1);assert.equal(C.deliveryRetryDelay(state.attempt,'TIMEOUT',()=>1),10000);
 for(let i=0;i<12;i++)state=C.nextDeliveryRetry(state,'NETWORK');
 assert.equal(C.deliveryRetryDelay(state.attempt,'NETWORK',()=>1),300000);
 assert.equal(C.examRetryDelay(state.attempt,'NETWORK',()=>1),30000);
 assert.equal(C.nextDeliveryRetry(state,'STATE_BUSY').attempt,1);
});
await check('Recorded BUSY x4 then 90-second lost acknowledgement recovers inside the unchanged 240-second budget',async()=>{
 let at=0,count=0;const sent=[],waits=[],a={run:null};
 const pc=createExamSession({session:()=>({token:p.token,user:p.user}),account:()=>a,deviceId:()=> 'retry-replay-device',now:()=>at,persist:async()=>{},random:()=>1,
  rpc:async(m,path,body,token)=>{
   if(!path.endsWith('/save'))return api(m,path,token,body);
   sent.push(clone(body));count++;
   if(count<=4){at+=[3590,3666,2834,3359][count-1];throw Object.assign(Error('Busy'),{code:'BUSY'});}
   const reply=api(m,path,token,body);
   if(count===5){at+=90002;throw Object.assign(Error('Lost acknowledgement'),{code:'TIMEOUT'});}
   return reply;
  }});
 await pc.start(t.id);const startedRevision=a.run.revision;a.run.answers[t.questions[0].id]='Остаточна відповідь 🇺🇦';
 const box={C:{...C,examRetryDelay:(n,c)=>C.examRetryDelay(n,c,()=>1)},Date:class extends Date{static now(){return at;}},pause:async n=>{waits.push(n);at+=n;}};
 vm.createContext(box);vm.runInContext(retrySource,box);
 await box.retry(()=>pc.sync(),240000,true);
 assert.equal(count,6);assert.ok(at<240000);assert.equal(waits.at(-1),10000);
 for(const body of sent)assert.deepEqual(body,sent[0]);
 assert.equal(a.run.revision,startedRevision+1);assert.equal(a.examRequest,undefined);
 const reply=await pc.finish();assert.ok(reply);
 const result=api('GET','/api/my-results',p.token).results.filter(r=>r.testId===t.id);assert.equal(result.length,1);
});
await check('A persisted result queue with many capacity failures gives a new network error its first delay without changing answers',async()=>{
 const body={testId:'synthetic-training',submissionId:'same-stable-id',answers:[{questionId:'q',text:'Збережений текст'}]};
 const a={pending:[{body:clone(body),attempts:20,nextAt:0,deliveryRetry:{kind:'capacity',attempt:20}}],results:[],reviews:{},fullTests:{}};
 let disk;const sent=[];
 const box=install({C,crypto,S:{session:{token:p.token,user:p.user}},user:()=>p.user,instructor:()=>false,alive:()=>true,account:()=>a,id:C.id,
  working:false,refreshing:false,updateApplying:false,syncing:false,page:'home',lastResult:null,lastError:'',render:()=>{},toast:()=>{},Date:class extends Date{static now(){return 100000;}},
  persist:async()=>{disk=clone(a);},rpc:async(m,path,b)=>{sent.push(clone(b));throw Object.assign(Error('Timeout'),{code:'TIMEOUT'});}},['syncQueue']);
 await box.syncQueue();assert.equal(a.pending.length,1);assert.equal(a.pending[0].attempts,21);
 assert.ok(a.pending[0].nextAt>=105000&&a.pending[0].nextAt<=110000);assert.deepEqual(a.pending[0].body,body);assert.deepEqual(sent,[body]);assert.deepEqual(disk,a);
});
await check('Actual exam background resets the network retry delay after capacity refusals and resets again after success',async()=>{
 const u=api('POST','/api/register','',{username:'retry_background',fullName:'Фоновий повтор',groupId:group.id,...model.credential('synthetic-password')});
 let at=0,calls=0,failing=true;const a={run:null};
 const pc=createExamSession({session:()=>({token:u.token,user:u.user}),account:()=>a,deviceId:()=> 'background-device',now:()=>at,persist:async()=>{},random:()=>1,
  rpc:async(m,path,b,token)=>{if(path.endsWith('/save')){calls++;if(failing)throw Object.assign(Error('Retry'),{code:calls<=4?'BUSY':'TIMEOUT'});}return api(m,path,token,b);}});
 await pc.start(t.id);a.run.answers[t.questions[0].id]='Фонова відповідь';
 for(let i=0;i<4;i++){await assert.rejects(pc.background());at+=16000;}
 await assert.rejects(pc.background());const before=calls;at+=9999;assert.equal(await pc.background(),false);assert.equal(calls,before);
 failing=false;at++;await pc.background();assert.equal(calls,before+1);assert.equal(a.examRequest,undefined);
});
finish({replayedLiveRun:45687233159,retryBudgetMilliseconds:240000,productionRequests:0});
