import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHmac,randomUUID} from 'node:crypto';
import * as C from '../web/core.js';
import {context,api,instructorToken,lock} from './fixtures/server_model.mjs';
const checks=[];async function check(name,work){await work();checks.push(name);console.log('PASS '+name);}
const users=context.sheet_('users'),prototype=Object.getPrototypeOf(users.getRange(1,1)),nativeSet=prototype.setValues,nativeAppend=users.appendRow;
const salt=C.b64(Uint8Array.from({length:16},(_,i)=>i?0:251)),hash=C.b64(Uint8Array.from({length:32},(_,i)=>i?0:251));
assert.ok(salt.startsWith('+')&&hash.startsWith('+'));
const group=api('POST','/api/instructor/groups',instructorToken,{name:'Літеральні облікові дані'}).group;
function interpret(row,column,value){if((column===6||column===7)&&String(value).startsWith('+')){users.rows[row-1][column-1]='#ERROR!';users.formulas.set(row+':'+column,'='+value);}}
prototype.setValues=function(values){const out=nativeSet.call(this,values);if(this.sheet===users)values.forEach((row,y)=>row.forEach((value,x)=>interpret(this.row+y,this.column+x,value)));return out;};
users.appendRow=function(row){const out=nativeAppend.call(this,row),number=this.getLastRow();row.forEach((value,index)=>interpret(number,index+1,value));return out;};
let serial=0;
const register=(credentials={passwordHash:hash,passwordSalt:salt})=>api('POST','/api/register','',{fullName:'Синтетичний текстовий акаунт',username:'literal_'+(++serial),groupId:group.id,...credentials});
function signIn(person,verificationKey=hash){const challenge=api('POST','/api/challenge','',{username:person.user.username,groupName:group.name});assert.equal(challenge.salt,salt);return api('POST','/api/login','',{username:person.user.username,groupName:group.name,nonce:challenge.nonce,proof:createHmac('sha256',Buffer.from(verificationKey,'base64')).update(challenge.nonce).digest('base64')});}
function stored(person){const owner=context.findUserById_(person.user.id);return {owner,row:users.rows[owner.rowNumber-1]};}
let person;
try{
 await check('Leading plus signs remain literal in both credential cells and issued tokens stay valid',()=>{
  person=register();const {row}=stored(person);assert.equal(row[5],'b64:'+hash);assert.equal(row[6],'b64:'+salt);
  assert.equal(api('GET','/api/workspace',person.token).user.id,person.user.id);assert.equal(signIn(person).user.id,person.user.id);
 });
 await check('The real password derivation signs in using a salt beginning with plus',async()=>{
  const password='synthetic-plus-password',credentials={passwordSalt:salt,passwordHash:C.b64(await C.keyFor(password,salt))},p=register(credentials);
  const r=await C.signIn(p.user.username,password,group.name,(path,body)=>Promise.resolve(api('POST',path,'',body)));
  assert.equal(r.user.id,p.user.id);
 });
 await check('Password reset uses literal encoding, revokes old sessions and preserves the vault key and account ID',()=>{
  const before=api('GET','/api/local-storage/key',person.token),id=person.user.id;
  api('POST','/api/instructor/users/'+id+'/password',instructorToken,{passwordHash:hash,passwordSalt:salt});
  assert.throws(()=>api('GET','/api/workspace',person.token),error=>error.code==='SESSION_EXPIRED');
  const next=signIn(person);assert.equal(next.user.id,id);assert.deepEqual(api('GET','/api/local-storage/key',next.token),before);person=next;
 });
 await check('Unprefixed legacy credentials and their existing session remain compatible',()=>{
  const bytes=C.b64(new Uint8Array(16)),key=C.b64(new Uint8Array(32)),p=register({passwordSalt:bytes,passwordHash:key}),{owner,row}=stored(p);
  nativeSet.call(users.getRange(owner.rowNumber,6,1,2),[[key,bytes]]);
  assert.equal(api('GET','/api/workspace',p.token).user.id,p.user.id);assert.equal(context.findUserById_(p.user.id).passwordSalt,bytes);assert.equal(row[5],key);
 });
 await check('Recoverable legacy formulas restore exact bytes without replacing the account or invalidating its session',()=>{
  const p=register(),{owner}=stored(p),before=api('GET','/api/local-storage/key',p.token);
  users.getRange(owner.rowNumber,6,1,2).setValues([[hash,salt]]);assert.equal(users.rows[owner.rowNumber-1][6],'#ERROR!');
  assert.equal(api('GET','/api/workspace',p.token).user.id,p.user.id);assert.equal(signIn(p).user.id,p.user.id);
  assert.equal(users.rows[owner.rowNumber-1][5],'b64:'+hash);assert.equal(users.rows[owner.rowNumber-1][6],'b64:'+salt);
  assert.deepEqual(api('GET','/api/local-storage/key',p.token),before);
 });
 await check('Recovery yields when the lock is busy and never uses a shifted account row',()=>{
  const p=register(),{owner}=stored(p);users.getRange(owner.rowNumber,6,1,2).setValues([[hash,salt]]);
  const take=lock.tryLock;lock.tryLock=()=>false;
  try{assert.throws(()=>context.findUserById_(p.user.id),error=>error.code==='BUSY');}finally{lock.tryLock=take;}
  const before=users.rows[owner.rowNumber-1].slice();lock.tryLock=()=>{users.rows.splice(owner.rowNumber-1,1);return true;};
  try{assert.throws(()=>context.userFromRow_(before,owner.rowNumber-2),error=>error.code==='BUSY');}finally{users.rows.splice(owner.rowNumber-1,0,before);lock.tryLock=take;}
 });
 await check('Recovery does not release a lock already held by its caller',()=>{
  const p=register(),{owner}=stored(p);users.getRange(owner.rowNumber,6,1,2).setValues([[hash,salt]]);
  const release=lock.releaseLock,held=lock.hasLock;let releases=0;lock.hasLock=()=>true;lock.releaseLock=()=>{releases++;};
  try{assert.equal(context.findUserById_(p.user.id).passwordSalt,salt);assert.equal(releases,0);}finally{lock.releaseLock=release;if(held)lock.hasLock=held;else delete lock.hasLock;}
 });
 await check('Unrecoverable values remain untouched and a malformed challenge produces a Ukrainian error',async()=>{
  const p=register(),{owner}=stored(p);nativeSet.call(users.getRange(owner.rowNumber,7),[['#ERROR!']]);
  assert.equal(context.findUserById_(p.user.id).passwordSalt,'#ERROR!');assert.equal(users.rows[owner.rowNumber-1][6],'#ERROR!');
  await assert.rejects(()=>C.signIn('synthetic','password','',async()=>({salt:'#ERROR!',nonce:randomUUID()})),error=>error.code==='BAD_LOGIN_RESPONSE'&&error.message.includes('пошкоджені'));
 });
 await check('A transient missing signing-key read cannot replace the existing key or invalidate the account',()=>{
  const props=context.PropertiesService.getScriptProperties(),read=props.getProperty,key=read.call(props,'APP_SECRET');let first=true;
  props.getProperty=function(name){if(name==='APP_SECRET'&&first){first=false;return null;}return read.call(this,name);};
  try{assert.equal(api('GET','/api/workspace',person.token).user.id,person.user.id);}finally{props.getProperty=read;}
  assert.equal(props.getProperty('APP_SECRET'),key);
 });
 await check('A missing established signing key fails without regenerating it or changing accounts and vault keys',()=>{
  const props=context.PropertiesService.getScriptProperties(),key=props.getProperty('APP_SECRET'),before=JSON.stringify(users.rows),vault=api('GET','/api/local-storage/key',person.token);
  props.deleteProperty('APP_SECRET');
  try{assert.throws(()=>api('GET','/api/workspace',person.token),error=>error.code==='SERVER_ERROR');assert.equal(props.getProperty('APP_SECRET'),null);assert.equal(JSON.stringify(users.rows),before);}finally{props.setProperty('APP_SECRET',key);}
  assert.deepEqual(api('GET','/api/local-storage/key',person.token),vault);
 });
}finally{prototype.setValues=nativeSet;users.appendRow=nativeAppend;}
fs.mkdirSync(new URL('../verification/',import.meta.url),{recursive:true});
fs.writeFileSync(new URL('../verification/credential-literals.json',import.meta.url),JSON.stringify({status:'passed',passed:checks.length,checks,leadingPlusHashAndSalt:true,preservesExistingVaultKey:true,syntheticOnly:true,productionRequests:0},null,2)+'\n');
