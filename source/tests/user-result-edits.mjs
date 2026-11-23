import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {api,context,credential,instructorToken,regressionBody} from './fixtures/server_model.mjs';

const checks=[];async function check(name,run){await run();checks.push(name);console.log('PASS '+name);}
const uuid=()=>crypto.randomUUID(),path=id=>'/api/instructor/results/'+id+'/answers';
const group=api('POST','/api/instructor/groups',instructorToken,{name:'Ізольовані правки користувачів'}).group;
let sequence=0;
const pupil=(name='Помилка в ПІБ')=>api('POST','/api/register','',{fullName:name,username:'editable-pupil-'+(++sequence),groupId:group.id,...credential('synthetic-pupil-password')});
const one=pupil(),two=pupil();
const test=api('POST','/api/instructor/tests',instructorToken,{title:'Виправлення зданої роботи',mode:'training',published:true,questions:[
 {text:'Один варіант',answers:[{text:'Правильно',isCorrect:true},{text:'Інша відповідь',isCorrect:false}]},
 {text:'Два варіанти',answers:[{text:'Перший',isCorrect:true},{text:'Другий',isCorrect:true},{text:'Зайвий',isCorrect:false}]},
 {text:'Письмова відповідь',type:'written',maxPoints:3,rubric:'PRIVATE_RUBRIC',explanation:'PRIVATE_EXPLANATION'},
]}).test;
const submit=owner=>api('POST','/api/results',owner.token,{testId:test.id,submissionId:'pc-'+uuid(),durationSeconds:30,writtenProtocol:1,choiceProtocol:2,answers:[{questionId:test.questions[0].id,answerId:test.questions[0].answers[1].id},{questionId:test.questions[1].id,answerIds:[]},{questionId:test.questions[2].id,text:'Первинна письмова відповідь 🛩️'}]}).result;
let result=submit(one),foreign=submit(two);
const record=()=>context.resultRecordById_(result.id),current=()=>api('GET',path(result.id),instructorToken);
const rename=(owner,name,extra={})=>api('POST','/api/instructor/users/'+owner.user.id+'/name',instructorToken,{fullName:name,expectedFullName:owner.user.fullName,requestId:uuid(),...extra});
const correct=(changes,extra={})=>api('POST',path(result.id),instructorToken,{requestId:uuid(),expectedRevision:record().result.gradingRevision,reason:'PRIVATE_REASON: виправлення після збою застосунку',changes,...extra});
const savedIdentity=context.findUserById_(one.user.id),originalAnswers=JSON.parse(record().row[13]),initial=structuredClone(result);
const choiceChanges=()=>test.questions.filter(q=>q.type!=='written').map(q=>({questionId:q.id,answerIds:q.answers.filter(a=>a.isCorrect).map(a=>a.id)}));
const audit=action=>context.dataRows_('audit').filter(row=>row[3]===action);

await check('A name edit updates the correct ID and its results while preserving login, password, key and dates',()=>{
 const beforeKey=api('GET','/api/local-storage/key',one.token).key;
 rename(one,'Петренко Петро Петрович');
 const after=context.findUserById_(one.user.id);
 for(const key of ['id','username','passwordHash','passwordSalt','createdAt','role','active','groupName'])assert.equal(after[key],savedIdentity[key],key);
 assert.equal(after.fullName,'Петренко Петро Петрович');assert.equal(record().result.userName,after.fullName);
 assert.equal(context.resultRecordById_(foreign.id).result.userName,two.user.fullName);
 assert.equal(api('GET','/api/local-storage/key',one.token).key,beforeKey);assert.equal(api('GET','/api/my-results',one.token).results.find(r=>r.id===result.id).userName,after.fullName);
});
await check('A retry after a partial name write reconciles results and creates a single audit entry',()=>{
 const owner={...one,user:{...one.user,fullName:context.findUserById_(one.user.id).fullName}},requestId=uuid();
 const range=Object.getPrototypeOf(context.sheet_('results').getRange(1,1)),set=range.setValue;let dropped=false;
 range.setValue=function(value){if(!dropped&&this.sheet===context.sheet_('results')&&this.column===3){dropped=true;throw Error('Injected result-name failure');}return set.call(this,value);};
 try{assert.throws(()=>rename(owner,'Петренко Петро',{requestId}));}finally{range.setValue=set;}
 const count=audit('USER_NAME').length;rename(owner,'Петренко Петро',{requestId});rename(owner,'Петренко Петро',{requestId});
 assert.equal(record().result.userName,'Петренко Петро');assert.equal(audit('USER_NAME').length,count+1);
 assert.throws(()=>rename(owner,'Чужий новий ПІБ',{requestId}),e=>e.code==='REQUEST_CONFLICT');
});
await check('Stale names and cadet access cannot overwrite another instructor change',()=>{
 assert.throws(()=>rename(one,'Ще один ПІБ'),e=>e.code==='REVISION_CONFLICT');
 assert.throws(()=>api('POST','/api/instructor/users/'+one.user.id+'/name',one.token,{fullName:'Forbidden',expectedFullName:'Петренко Петро',requestId:uuid()}),e=>e.code==='FORBIDDEN');
});
await check('The primary instructor can edit staff names while their title and role remain intact',()=>{
 const invite=api('POST','/api/instructor/invite',instructorToken);
 const teacher=api('POST','/api/instructor/register','',{fullName:'Помилка Викладача · Викладач',username:'editable-teacher',inviteCode:invite.code,...credential('synthetic-teacher-password')});
 const r=api('POST','/api/instructor/users/'+teacher.user.id+'/name',instructorToken,{fullName:'Правильний Викладач',expectedFullName:teacher.user.fullName,requestId:uuid()});
 assert.equal(r.user.fullName,'Правильний Викладач · Викладач');assert.equal(r.user.role,'instructor');
 const primary=context.requireSession_(instructorToken);
 assert.throws(()=>api('POST','/api/instructor/users/'+primary.id+'/name',teacher.token,{fullName:'Чуже ім’я',expectedFullName:primary.fullName,requestId:uuid()}),e=>e.code==='FORBIDDEN');
});
await check('Choice corrections recalculate the existing result and retain the immutable submission identity',()=>{
 const oldGrade=api('POST','/api/instructor/results/'+result.id+'/grade',instructorToken,{requestId:uuid(),expectedRevision:0,grades:[{questionId:test.questions[2].id,points:1,comment:'Початкова оцінка'}]});
 assert.equal(oldGrade.result.earnedPoints,1);
 const edited=correct(choiceChanges());result=edited.result;
 assert.equal(result.correct,2);assert.equal(result.earnedPoints,3);assert.equal(result.maxPoints,5);assert.equal(result.score,60);
 for(const key of ['id','userId','testId','completedAt','durationSeconds','total'])assert.equal(result[key],initial[key],key);
 assert.equal(result.answersCorrected,true);assert.equal(result.answerCorrectionCount,1);assert.deepEqual(current().originalAnswers,originalAnswers);
 assert.equal(context.dataRows_('results').filter(r=>r[0]===result.id).length,1);
});
await check('Changing a written answer invalidates only that answer grade and retains the original',()=>{
 const edited=correct([{questionId:test.questions[2].id,text:'Відновлена письмова відповідь'}]);result=edited.result;
 assert.equal(result.pendingWritten,1);assert.equal(result.score,null);assert.equal(result.earnedPoints,2);assert.equal(result.correct,2);
 assert.equal(JSON.parse(record().row[22])[test.questions[2].id],undefined);assert.deepEqual(edited.originalAnswers,originalAnswers);assert.equal(result.answerCorrectionCount,2);
 const pupilReview=api('GET','/api/results/'+result.id+'/review',one.token);
 assert.equal(pupilReview.result.answersCorrected,true);assert.equal(pupilReview.review.find(q=>q.type==='written').rubric,undefined);
 assert.equal(JSON.stringify(pupilReview).includes('PRIVATE_REASON'),false);
 assert.throws(()=>api('GET',path(result.id),one.token),e=>e.code==='FORBIDDEN');
});
await check('Another active review lease blocks corrections before any snapshot is written',()=>{
 const invite=api('POST','/api/instructor/invite',instructorToken),teacher=api('POST','/api/instructor/register','',{fullName:'Інший викладач',username:'correction-reviewer',inviteCode:invite.code,...credential('synthetic-reviewer-password')});
 const opened=api('POST','/api/instructor/results/'+result.id+'/review-session',teacher.token,{action:'open',clientId:'synthetic-other-review-client'});
 const before=context.dataRows_('answerChanges').length;
 assert.throws(()=>correct([{questionId:test.questions[0].id,answerIds:[]}]),e=>e.code==='REVIEW_IN_PROGRESS');assert.equal(context.dataRows_('answerChanges').length,before);
 api('POST','/api/instructor/results/'+result.id+'/review-session',teacher.token,{action:'release',clientId:'synthetic-other-review-client',leaseId:opened.reviewSession.leaseId});
});
await check('Stale revisions, missing reasons and unknown answer IDs cannot mutate accepted work',()=>{
 const before=JSON.stringify(record().row);
 for(const [changes,extra,code] of [[[{questionId:test.questions[0].id,answerIds:[]}],{expectedRevision:0},'REVISION_CONFLICT'],[choiceChanges(),{reason:''},'BAD_REQUEST'],[[{questionId:'missing',answerIds:[]}],{},'BAD_REQUEST'],[[{questionId:test.questions[0].id,answerIds:['missing']}],{},'BAD_REQUEST']])assert.throws(()=>correct(changes,extra),e=>e.code===code||e.code==='VALIDATION');
 assert.equal(JSON.stringify(record().row),before);
});
await check('A lost canonical-write acknowledgement retries one correction and one journal entry',()=>{
 const expectedRevision=record().result.gradingRevision,requestId=uuid(),changes=[{questionId:test.questions[0].id,answerIds:[]}],range=Object.getPrototypeOf(context.sheet_('results').getRange(1,1)),set=range.setValues;let dropped=false;
 range.setValues=function(values){const result=set.call(this,values);if(!dropped&&this.sheet===context.sheet_('results')&&this.row===record().rowNumber&&this.column===7){dropped=true;throw Error('Lost correction acknowledgement');}return result;};
 try{assert.throws(()=>correct(changes,{requestId,expectedRevision}));}finally{range.setValues=set;}
 const rows=context.dataRows_('answerChanges').length,entries=audit('RESULT_ANSWERS_CORRECT').length;
 const replay=correct(changes,{requestId,expectedRevision});assert.equal(replay.alreadyApplied,true);assert.equal(context.dataRows_('answerChanges').length,rows);assert.equal(audit('RESULT_ANSWERS_CORRECT').length,entries+1);
 correct(changes,{requestId,expectedRevision});assert.equal(audit('RESULT_ANSWERS_CORRECT').length,entries+1);
 assert.deepEqual(current().originalAnswers,originalAnswers);
});
await check('A snapshot-write failure leaves the result untouched and the same request can succeed later',()=>{
 const before=JSON.stringify(record().row),expectedRevision=record().result.gradingRevision,requestId=uuid(),changes=[{questionId:test.questions[0].id,answerIds:[test.questions[0].answers[0].id]}];
 const range=Object.getPrototypeOf(context.sheet_('answerChanges').getRange(1,1)),set=range.setValues;
 range.setValues=function(values){if(this.sheet===context.sheet_('answerChanges'))throw Error('Injected history write failure');return set.call(this,values);};
 try{assert.throws(()=>correct(changes,{requestId,expectedRevision}));}finally{range.setValues=set;}
 assert.equal(JSON.stringify(record().row),before);assert.equal(correct(changes,{requestId,expectedRevision}).result.correct,2);
});
await check('Corrupted original snapshots block further edits without replacing current answers',()=>{
 const meta=JSON.parse(record().row[22])._answerCorrection,rows=context.sheet_('answerChanges').rows,row=rows.find(r=>r[0]===meta.originalId),value=row[7],before=JSON.stringify(record().row);
 row[7]='json:corrupted';try{assert.throws(()=>correct([{questionId:test.questions[0].id,answerIds:[]}]),e=>e.code==='ANSWER_HISTORY_UNAVAILABLE');}finally{row[7]=value;}
 assert.equal(JSON.stringify(record().row),before);
});
await check('Written grading after an answer correction preserves the correction chain',()=>{
 const before=JSON.parse(record().row[22])._answerCorrection;
 const graded=api('POST','/api/instructor/results/'+result.id+'/grade',instructorToken,{expectedRevision:record().result.gradingRevision,requestId:uuid(),grades:[{questionId:test.questions[2].id,points:3,comment:'Перевірено виправлену відповідь'}]});
 assert.equal(graded.result.score,100);assert.deepEqual(JSON.parse(record().row[22])._answerCorrection,before);assert.deepEqual(current().originalAnswers,originalAnswers);
});
await check('Deleting one result purges only its private answer history',()=>{
 assert.ok(context.dataRows_('answerChanges').some(r=>String(r[1])===String(result.id)));
 api('DELETE','/api/instructor/results/'+result.id,instructorToken,{confirmResultId:String(result.id)});
 assert.equal(context.dataRows_('answerChanges').some(r=>String(r[1])===String(result.id)),false);assert.ok(context.resultRecordById_(foreign.id));
});

await check('Large Unicode answer originals survive chunk boundaries and are archived before intake cleanup',()=>{
 const owner=pupil('Курсант із довгими відповідями'),essay='Я🛩️'.repeat(650);
 const large=api('POST','/api/instructor/tests',instructorToken,{title:'Великі первинні відповіді',mode:'training',published:true,questions:Array.from({length:16},(_,i)=>({type:'written',text:'Письмове питання '+i,maxPoints:1,rubric:'Критерії викладача'}))}).test;
 const accepted=api('POST','/api/results',owner.token,{testId:large.id,submissionId:'pc-'+uuid(),durationSeconds:70,writtenProtocol:1,choiceProtocol:2,answers:large.questions.map(q=>({questionId:q.id,text:essay}))}).result;
 const updated=api('POST',path(accepted.id),instructorToken,{requestId:uuid(),expectedRevision:0,reason:'Відновлення письмової відповіді після збою',changes:[{questionId:large.questions[0].id,text:'Відновлена відповідь'}]});
 assert.equal(updated.originalAnswers[large.questions[0].id],essay);
 const chunks=context.dataRows_('answerChanges').filter(row=>String(row[1])===String(accepted.id));assert.ok(chunks.length>2);
 for(const chunk of chunks){const last=String(chunk[7]).charCodeAt(String(chunk[7]).length-1);assert.ok(last<0xd800||last>0xdbff);}
 const preview=api('GET','/api/instructor/intake',instructorToken);
 let job=api('POST','/api/instructor/intake/start',instructorToken,{requestId:uuid(),previewToken:preview.previewToken,confirmation:'НОВИЙ НАБІР'}).intake;
 let calls=0;while(job.state!=='completed'){assert.ok(++calls<200);job=api('POST','/api/instructor/intake/continue',instructorToken,{jobId:job.id}).intake;}
 const book=context.SpreadsheetApp.openById(job.archive.id),archived=book.getSheetByName('Виправлення відповідей');assert.ok(archived);
 assert.ok(archived.rows.some(row=>row.some(value=>String(value).includes(chunks[0][0]))));assert.equal(context.dataRows_('answerChanges').length,0);
 assert.equal(JSON.stringify(archived.rows).includes(owner.token),false);
});

const report={status:'passed',passed:checks.length,checks,actualAppsScriptExecuted:true,productionRecordsChanged:0};fs.mkdirSync(new URL('../verification/',import.meta.url),{recursive:true});fs.writeFileSync(new URL('../verification/user-result-edits.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,passed:report.passed}));
