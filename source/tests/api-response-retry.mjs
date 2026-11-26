import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import {audit,C,clone,model,install} from './storage-recovery/support.mjs';
const {api,check,finish}=audit('api-response-retry');
const health=()=>({ok:true,status:'online',version:26,serverBuild:'synthetic-health'});
const group=api('POST','/api/instructor/groups',model.instructorToken,{name:'Повтор API'}).group;
const p=api('POST','/api/register','',{username:'api_response_retry',fullName:'Синтетична перевірка API',groupId:group.id,...model.credential('synthetic-password')});
function relay(session=p){
 const sent=[],waits=[];let hook=null;
 const box=install({C:{...C,requestCapacity:(send,pause,random,capacity,safe)=>C.requestCapacity(send,async n=>waits.push(n),()=>0,capacity,safe)},S:{session},updateApplying:false,rpcFlights:0,
  local:async(path,envelope)=>{assert.equal(path,'/rpc');sent.push(clone(envelope));return hook?hook(envelope):api(envelope.method,envelope.path,envelope.token,envelope.body);}},['rpc']);
 return {box,sent,waits,hook:f=>hook=f};
}
await check('Health and missing synchronization protocols cannot acknowledge an API operation while a legitimate empty success remains valid',()=>{
 for(const path of ['/api/groups','/api/results','/api/account-state/document','/api/exam-session/start'])assert.equal(C.apiReply(health(),path).code,'BAD_API_RESPONSE');
 assert.equal(C.apiReply({ok:true},'/api/account-state/document').code,'BAD_API_RESPONSE');
 const empty={ok:true};assert.equal(C.apiReply(empty,'/api/instructor/tests/test'),empty);
 const invalidUser={ok:true,accountSyncProtocol:1,userId:'other'};assert.equal(C.apiReply(invalidUser,'/api/account-state/document'),invalidUser);
});
await check('The real application relay retries a read with the identical envelope and never exposes the health reply',async()=>{
 const pc=relay();let first=true;pc.hook(e=>{if(first){first=false;return health();}return api(e.method,e.path,e.token,e.body);});
 const reply=await pc.box.rpc('GET','/api/groups');assert.ok(Array.isArray(reply.groups));assert.equal(pc.sent.length,2);assert.deepEqual(pc.sent[0],pc.sent[1]);assert.deepEqual(pc.waits,[2500]);assert.equal(pc.box.rpcFlights,0);
});
await check('A committed account checkpoint with an unrelated acknowledgement replays its original ID and creates one revision',async()=>{
 const test=api('POST','/api/instructor/tests',model.instructorToken,{title:'Підтвердження тренування',mode:'training',published:true,questions:[{type:'written',text:'Текст',maxPoints:3,answers:[]}]}).test;
 const submissionId='pc-'+crypto.randomUUID(),start=api('POST','/api/tests/'+test.id+'/start',p.token,{submissionId});
 const run={test:start.test,submissionId,startPermit:start.startPermit,userId:p.user.id,answers:{[test.questions[0].id]:'Початковий текст 🇺🇦'},index:0,lastElapsed:10};
 const body={key:'training',expectedRevision:0,requestId:crypto.randomUUID(),value:run},pc=relay();let first=true;
 pc.hook(e=>{const r=api(e.method,e.path,e.token,e.body);if(first){first=false;return health();}return r;});
 const reply=await pc.box.rpc('POST','/api/account-state/document',body);assert.equal(reply.document.revision,1);assert.deepEqual(reply.document.value.answers,run.answers);assert.equal(pc.sent.length,2);assert.deepEqual(pc.sent[0],pc.sent[1]);
 assert.equal(api('GET','/api/account-state/document',p.token,{key:'training'}).document.revision,1);
});
await check('An unknown acknowledgement after non-idempotent creation is not automatically repeated',async()=>{
 const pc=relay({token:model.instructorToken,user:{id:'1',role:'instructor'}}),name='Створення без автоматичного дубля';
 pc.hook(e=>{api(e.method,e.path,e.token,e.body);return health();});
 await assert.rejects(pc.box.rpc('POST','/api/instructor/groups',{name}),e=>e.code==='BAD_API_RESPONSE');assert.equal(pc.sent.length,1);assert.equal(pc.waits.length,0);
 assert.equal(api('GET','/api/groups',model.instructorToken).groups.filter(x=>x.name===name).length,1);
});
await check('A missing envelope after four capacity refusals receives its own bounded retry allowance',async()=>{
 let calls=0;const waits=[];
 const reply=await C.requestCapacity(async()=>++calls<=4?{ok:false,code:'BUSY'}:calls===5?{ok:false,code:'BAD_API_RESPONSE'}:{ok:true},async n=>waits.push(n),()=>0,true,true);
 assert.equal(reply.ok,true);assert.equal(calls,6);assert.equal(waits.length,5);assert.equal(waits.at(-1),2500);
});
const source=fs.readFileSync(new URL('./live-google-load.mjs',import.meta.url),'utf8');
await check('The unchanged 240-second budget retains a final useful retry instead of aborting with unused time',async()=>{
 let at=0,calls=0;const waits=[];
 const box={C:{...C,examRetryDelay:()=>15000},Date:class extends Date{static now(){return at;}},pause:async n=>{waits.push(n);at+=n;}};
 vm.createContext(box);vm.runInContext(source.slice(source.indexOf('async function retry('),source.indexOf('async function stage(')),box);
 assert.equal(await box.retry(async()=>{if(++calls===1){at=230460;throw Object.assign(Error('Busy'),{code:'BUSY'});}at+=3500;return true;},240000,true),true);
 assert.equal(calls,2);assert.deepEqual(waits,[3180]);assert.equal(at,237140);assert.ok(at<240000);
});
await check('Redirected load requests share the 90-second operation budget and use the native 45-second receive timeout',async()=>{
 const requests=[],timeouts=[];let count=0;
 const box={state:{webAppUrl:'https://script.google.com/macros/s/synthetic/exec',secret:'synthetic-only'},URL,Buffer,assert,
  AbortSignal:{timeout:n=>{const signal={milliseconds:n};timeouts.push(signal);return signal;},any:parts=>({parts})},
  fetch:async(url,options)=>{requests.push({url,...options});if(++count===1)return {status:302,headers:{get:()=> 'https://script.googleusercontent.com/synthetic'}};return {status:200,ok:true,headers:{get:()=>null},text:async()=>'{"ok":true,"groups":[]}'};}};
 vm.createContext(box);vm.runInContext(source.slice(source.indexOf('async function transport('),source.indexOf('async function once(')),box);
 const reply=await box.transport({method:'GET',path:'/api/groups',body:{}});assert.equal(reply.reply.ok,true);assert.equal(requests.length,2);
 assert.equal(requests[0].signal.parts[0],requests[1].signal.parts[0]);assert.equal(requests[0].signal.parts[0].milliseconds,90000);
 assert.equal(requests[0].signal.parts[1].milliseconds,45000);assert.equal(requests[1].signal.parts[1].milliseconds,45000);assert.equal(requests[1].method,'GET');assert.equal(requests[1].body,undefined);
});
const report=finish({replayedLiveRun:45778991808,retryBudgetMilliseconds:240000,safeMutationReplayOnly:true,productionRequests:0});
fs.writeFileSync(new URL('../verification/api-response-retry.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
