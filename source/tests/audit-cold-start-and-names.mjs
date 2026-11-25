// Isolated real Apps Script model. Never uses production accounts or Sheets.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import {api,context,credential,instructorToken,lock,regressionTest,regressionBody} from './fixtures/server_model.mjs';
const checks=[];
async function check(name,run){try{await run();checks.push({name,status:'passed'});console.log('PASS '+name);}catch(error){checks.push({name,status:'failed',error:error.message});console.error('FAIL '+name+': '+error.message);}}
const cache=context.CacheService.getScriptCache(),group=api('POST','/api/instructor/groups',instructorToken,{name:'Аудит імен та холодного старту'}).group;
let sequence=0;
const pupil=()=>api('POST','/api/register','',{fullName:'ПІБ до виправлення',username:'audit-name-'+(++sequence),groupId:group.id,...credential('synthetic-audit-password')});
const rename=(owner,name,requestId=crypto.randomUUID())=>api('POST','/api/instructor/users/'+owner.user.id+'/name',instructorToken,{fullName:name,expectedFullName:owner.user.fullName,requestId});
const visible=id=>context.publicResultRows_().filter(row=>String(row[6])===String(id));
const drain=()=>{for(let i=0;i<30;i++)api('GET','/api/public-table-sync',instructorToken);};
const range=Object.getPrototypeOf(context.sheet_('users').getRange(1,1));
function faultOnce(sheet,row,column,after,run){const saved=range.setValue;let dropped=false;range.setValue=function(value){if(!dropped&&this.sheet===sheet&&this.row===row&&this.column===column){dropped=true;if(after)saved.call(this,value);throw Error('Injected lost name/publication acknowledgement');}return saved.call(this,value);};try{run();assert.equal(dropped,true);}finally{range.setValue=saved;}}

await check('A cadet without submissions keeps one existing public row and receives the corrected name',()=>{
 const owner=pupil(),name='Виправлений ПІБ без спроб';assert.equal(visible(owner.user.id).length,1);
 rename(owner,name);drain();const rows=visible(owner.user.id);assert.equal(rows.length,1);assert.equal(rows[0][0],name);assert.equal(rows[0][7],'');
 assert.equal(context.findUserById_(owner.user.id).username,owner.user.username);
});
await check('A failed cadet-publication marker cannot leave the acknowledged retry with an old public name',()=>{
 const owner=pupil(),name='Відновлений ПІБ після збою прапорця',request=crypto.randomUUID(),record=context.findUserById_(owner.user.id);
 faultOnce(context.sheet_('users'),record.rowNumber,10,false,()=>assert.throws(()=>rename(owner,name,request)));
 rename(owner,name,request);drain();assert.equal(context.findUserById_(owner.user.id).fullName,name);assert.equal(visible(owner.user.id)[0][0],name);
});
await check('A lost account-name acknowledgement retains publication and retry does not duplicate the cadet',()=>{
 const owner=pupil(),name='Відновлений ПІБ після втрати відповіді',request=crypto.randomUUID(),record=context.findUserById_(owner.user.id);
 faultOnce(context.sheet_('users'),record.rowNumber,3,true,()=>assert.throws(()=>rename(owner,name,request)));
 rename(owner,name,request);drain();const rows=visible(owner.user.id);assert.equal(rows.length,1);assert.equal(rows[0][0],name);
});
const test=regressionTest('Імена зданих робіт — аудит',2);
for(const [column,after,label] of [[27,false,'publication marker'],[3,true,'result-name acknowledgement']])await check('A failed '+label+' retries the existing result without losing its public name update',()=>{
 const owner=pupil(),result=api('POST','/api/results',owner.token,regressionBody(test,'audit-name-'+crypto.randomUUID())).result,record=context.resultRecordById_(result.id),name='Виправлений ПІБ роботи '+column,request=crypto.randomUUID(),before=structuredClone(record.result);
 faultOnce(context.sheet_('results'),record.rowNumber,column,after,()=>assert.throws(()=>rename(owner,name,request)));
 rename(owner,name,request);drain();const saved=context.findResultById_(result.id),rows=visible(owner.user.id).filter(row=>String(row[7])===String(result.id));
 assert.equal(rows.length,1);assert.equal(rows[0][0],name);for(const key of ['id','score','correct','completedAt','durationSeconds','testId'])assert.equal(saved[key],before[key],key);
});
await check('Manual table repair updates a stale placeholder by ID without changing a namesake or creating an attempt',()=>{
 const owner=pupil(),other=pupil(),name='ПІБ після старого збою',record=context.findUserById_(owner.user.id),others=JSON.stringify(visible(other.user.id));
 context.sheet_('users').getRange(record.rowNumber,3).setValue(name);context.sheet_('users').getRange(record.rowNumber,10).setValue('');
 api('POST','/api/instructor/results-sheet/sync',instructorToken);
 const rows=visible(owner.user.id);assert.equal(rows.length,1);assert.equal(rows[0][0],name);assert.equal(rows[0][7],'');assert.equal(JSON.stringify(visible(other.user.id)),others);
});
await check('Name publication preserves manual columns and does not reinterpret unidentified historical work as a placeholder',()=>{
 const owner=pupil(),sheet=context.publicResultsSheet_(),rows=context.publicResultRows_(),index=rows.findIndex(row=>String(row[6])===String(owner.user.id));
 if(sheet.getMaxColumns()<32)sheet.insertColumnsAfter(sheet.getMaxColumns(),32-sheet.getMaxColumns());
 sheet.getRange(1,32).setValue('Ручна колонка');sheet.getRange(index+2,32).setValue('Збережена ручна примітка');
 const historical=[owner.user.fullName,'','','','','Невизначена стара робота',String(owner.user.id),'','','','','','Історична група','','',''];
 context.appendPublicRow_(sheet,historical);rename(owner,'ПІБ зі збереженою приміткою');drain();
 assert.equal(sheet.getRange(index+2,32).getValue(),'Збережена ручна примітка');
 const remaining=visible(owner.user.id).find(row=>row[5]===historical[5]);assert.equal(remaining[0],historical[0]);assert.equal(remaining[12],historical[12]);
});

await check('A queued cold read rechecks readiness after the first initializer finishes under the shared lock',()=>{
 const previous=new Map(cache.values),take=lock.tryLock,release=lock.releaseLock,migrate=context.migrateTestQuestionCounts_;
 let scans=0,released=0;context.migrateTestQuestionCounts_=()=>{scans++;return migrate();};cache.values.clear();
 lock.tryLock=()=>{context.ensureSchema_(true);return true;};lock.releaseLock=()=>{released++;};
 try{context.ensureSchema_(false);assert.equal(scans,1,'The same completed initialization was repeated');assert.equal(released,1);}finally{lock.tryLock=take;lock.releaseLock=release;context.migrateTestQuestionCounts_=migrate;cache.values=new Map(previous);}
});
await check('Explicit maintenance still repairs headers even when readiness is already cached',()=>{
 const sheet=context.sheet_('answerChanges'),header=sheet.rows[0][0];sheet.rows[0][0]='Damaged test header';context.ensureSchema_(true,true);assert.equal(sheet.rows[0][0],header);
});
await check('Failure during schema repair cannot mark a partial initialization as ready',()=>{
 const old=new Map(cache.values),set=range.setValues,sheet=context.sheet_('answerChanges');cache.values.clear();let injected=false;
 range.setValues=function(values){if(!injected&&this.sheet===sheet&&this.row===1){injected=true;throw Error('Injected schema write failure');}return set.call(this,values);};
 try{assert.throws(()=>context.ensureSchema_(false));assert.equal(cache.get('LK_SCHEMA_ANSWER_CHANGES_V1'),null);}finally{range.setValues=set;}
 try{context.ensureSchema_(false);assert.equal(cache.get('LK_SCHEMA_ANSWER_CHANGES_V1'),'1');}finally{cache.values=new Map(old);}
});
const report={status:checks.every(x=>x.status==='passed')?'passed':'failed',passed:checks.filter(x=>x.status==='passed').length,total:checks.length,checks,actualAppsScriptExecuted:true,productionRequests:0};
fs.mkdirSync(new URL('../verification/',import.meta.url),{recursive:true});fs.writeFileSync(new URL('../verification/audit-cold-start-and-names.json',import.meta.url),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,passed:report.passed,total:report.total}));if(report.status!=='passed')process.exitCode=1;
