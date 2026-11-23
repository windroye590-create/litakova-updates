// Real browser and Code.gs; synthetic accounts, local transport, no production writes.
import {handleHostWindow} from './fixtures/host-window.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('playwright');
process.env.LITAKOVA_SERVER_SOURCE=new URL('../Code.gs',import.meta.url).pathname;
const {context,api,credential,instructorToken}=await import('./fixtures/server_model.mjs');
const actor=api('GET','/api/workspace',instructorToken).user;
const group=api('POST','/api/instructor/groups',instructorToken,{name:'Редагування — UI'}).group;
const cadet=api('POST','/api/register','',{fullName:'Помилка Прізвища UI',username:'edit_ui',groupId:group.id,...credential('synthetic-cadet-password')});
const test=api('POST','/api/instructor/tests',instructorToken,{title:'Виправлення після здачі UI',mode:'training',published:true,questions:[
 {text:'Вибір після збою',answers:[{text:'Правильний варіант',isCorrect:true},{text:'Інший варіант',isCorrect:false},{text:'Третій варіант',isCorrect:false}]},
 {text:'Письмова після збою',type:'written',maxPoints:3,rubric:'PRIVATE_CRITERIA'}
]}).test;
const result=api('POST','/api/results',cadet.token,{testId:test.id,submissionId:'pc-'+crypto.randomUUID(),durationSeconds:35,writtenProtocol:1,choiceProtocol:2,answers:[{questionId:test.questions[0].id,answerIds:[test.questions[0].answers[1].id]},{questionId:test.questions[1].id,text:'Первинний текст <script>no()</script>'}]}).result;
api('POST','/api/instructor/results/'+result.id+'/grade',instructorToken,{requestId:crypto.randomUUID(),expectedRevision:0,grades:[{questionId:test.questions[1].id,points:2,comment:'Первинна оцінка'}]});
let state={version:1,session:{token:instructorToken,user:actor},accounts:{},groups:[]},journal={},dropCorrection=false,failState=false;
const requests=[],checks=[],errors=[];
const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.ttf':'font/ttf'};
const server=http.createServer(async(req,res)=>{
 if(handleHostWindow(req,res))return;
 try{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/state'||url.pathname==='/journal'){
   if(req.method==='POST'){const chunks=[];for await(const c of req)chunks.push(c);const value=JSON.parse(Buffer.concat(chunks));if(url.pathname==='/state'){if(failState){res.end('{"ok":false,"error":"Тестовий збій диска"}');return;}state=value;}else journal=value;res.end('{"ok":true}');}
   else res.end(JSON.stringify(url.pathname==='/state'?state:journal));return;
  }
  if(url.pathname==='/clock'){res.end(JSON.stringify({ok:true,uptime:performance.now()+100000,launchId:'answer-edits-ui'}));return;}
  if(url.pathname.startsWith('/updates/')){res.end('{"ok":true,"state":2}');return;}
  if(url.pathname==='/rpc'){
   const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks).toString(),request=JSON.parse(raw);requests.push(request);
   const reply=context.doPost({postData:{contents:raw}}).text;
   if(dropCorrection&&request.method==='POST'&&request.path.endsWith('/answers')){dropCorrection=false;res.end('{"ok":false,"code":"NETWORK","error":"Перевірка втрати підтвердження"}');return;}
   res.setHeader('Content-Type','application/json');res.end(reply);return;
  }
  const name=url.pathname==='/'?'index.html':url.pathname.slice(1),file=new URL('../web/'+name,import.meta.url);
  if(!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',mime[path.extname(name)]||'application/octet-stream');res.end(fs.readFileSync(file));
 }catch(error){res.writeHead(500);res.end(String(error));}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser,page,currentCheck='launch';
const click=action=>page.locator('button[data-action="'+action+'"]').first().click();
async function check(name,fn){currentCheck=name;await fn();checks.push(name);console.log('PASS '+name);}
async function ready(){await page.getByRole('heading',{name:'Кабінет інструктора'}).waitFor();await page.waitForFunction(()=>document.querySelector('.topbar')?.textContent.includes('Оновлено'));}
async function openWork(){await page.locator('.nav [data-page=results]').click();await page.locator('#filter').fill('Прізвища UI');await page.locator('[data-action=grade-result][data-id="'+result.id+'"]').click();await page.getByRole('heading',{name:'Перевірка письмової роботи'}).waitFor();}
const choice=()=>page.locator('input[data-correction-question="'+test.questions[0].id+'"]');
const written=()=>page.locator('textarea[data-correction-question="'+test.questions[1].id+'"]');
try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.LITAKOVA_CHROMIUM_EXECUTABLE});
 page=await browser.newPage({viewport:{width:1366,height:900}});page.on('pageerror',error=>errors.push(error.message));
 await page.goto('http://127.0.0.1:'+server.address().port);await ready();
 await check('Cadet name dialog changes the selected ID and leaves login intact',async()=>{
  await page.locator('.nav [data-page=cadets]').click();await page.locator('[data-action=edit-user-name][data-id="'+cadet.user.id+'"]').click();
  await page.locator('#modal input[name=fullName]').fill('Правильне Прізвища UI');await page.locator('#modal button.primary').click();await page.locator('#modal').waitFor({state:'hidden'});
  assert.equal(context.findUserById_(cadet.user.id).fullName,'Правильне Прізвища UI');assert.equal(context.findUserById_(cadet.user.id).username,'edit_ui');assert.equal(context.findResultById_(result.id).userName,'Правильне Прізвища UI');
 });
 await check('Staff name controls are available to the primary instructor',async()=>{await page.locator('.nav [data-page=more]').click();await page.locator('#instructors-panel [data-action=edit-user-name][data-id="'+actor.id+'"]').waitFor();});
 await openWork();await click('correct-answers');
 await check('Correction editor shows escaped original text and enforces two selected choices',async()=>{
  await page.getByRole('heading',{name:'Виправлення відповідей'}).waitFor();assert.equal(await written().inputValue(),'Первинний текст <script>no()</script>');assert.equal(await page.locator('.answer-correction-question script').count(),0);
  assert.equal(await page.locator('[data-action=save-answer-correction]').isDisabled(),true);
  await choice().nth(0).check();await choice().nth(2).click();assert.equal(await choice().nth(2).isChecked(),false);await choice().nth(1).uncheck();
  assert.equal(await page.locator('[data-action=save-answer-correction]').isEnabled(),true);
  await click('save-answer-correction');await page.waitForFunction(()=>document.querySelector('#toast')?.textContent.includes('Укажіть причину'));assert.equal(context.findResultById_(result.id).gradingRevision,1);
 });
 await check('Unsaved corrections survive reload and remain in this account',async()=>{
  await written().fill('Відновлена відповідь UI');await page.locator('#correction-reason').fill('PRIVATE_UI_REASON: збій програми');await page.waitForTimeout(400);await page.reload();await ready();await openWork();await click('correct-answers');
  assert.equal(await written().inputValue(),'Відновлена відповідь UI');assert.equal(await page.locator('#correction-reason').inputValue(),'PRIVATE_UI_REASON: збій програми');
 });
 await check('A disk-write failure retains the draft and prevents any correction RPC',async()=>{
  const before=requests.filter(r=>r.method==='POST'&&r.path.endsWith('/answers')).length;
  failState=true;await click('save-answer-correction');await page.getByText('Тестовий збій диска',{exact:true}).first().waitFor();assert.equal(requests.filter(r=>r.method==='POST'&&r.path.endsWith('/answers')).length,before);assert.equal(context.findResultById_(result.id).gradingRevision,1);assert.equal(await written().isDisabled(),true);failState=false;
 });
 await check('Lost acknowledgement freezes the request; retry updates the same attempt once',async()=>{
  dropCorrection=true;await click('save-answer-correction');await page.getByText('Перевірка втрати підтвердження',{exact:true}).first().waitFor();
  const saved=structuredClone(state.accounts[actor.id].answerCorrectionDrafts[result.id].request);assert.ok(saved.requestId);assert.equal(context.findResultById_(result.id).gradingRevision,2);assert.equal(await written().isDisabled(),true);
  await click('save-answer-correction');await page.getByRole('heading',{name:'Перевірка письмової роботи'}).waitFor();assert.equal(context.findResultById_(result.id).gradingRevision,2);assert.equal(context.findResultById_(result.id).pendingWritten,1);assert.equal(context.findResultById_(result.id).correct,1);
  assert.equal(context.dataRows_('results').filter(row=>row[0]===result.id).length,1);assert.equal(await page.locator('[data-grade-prop=points]').inputValue(),'');
  const sent=requests.filter(r=>r.method==='POST'&&r.path.endsWith('/answers'));assert.equal(sent.length,2);assert.deepEqual(sent[0].body.changes,sent[1].body.changes);assert.equal(sent[0].body.requestId,sent[1].body.requestId);
 });
 await click('correct-answers');
 await check('Primary answers remain visible after correction and narrow layout fits',async()=>{
  await page.locator('.answer-correction-question details').nth(1).locator('summary').click();assert.ok((await page.locator('.answer-correction-question details').nth(1).textContent()).includes('Первинний текст <script>no()</script>'));
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:new URL('../verification/user-result-edits-narrow.png',import.meta.url).pathname,fullPage:true});await page.setViewportSize({width:1366,height:900});
 });
 await check('Stale work is rejected and reloading keeps the previous local draft for comparison',async()=>{
  await written().fill('Місцевий конфлікт');await page.locator('#correction-reason').fill('Місцева причина');
  api('POST','/api/instructor/results/'+result.id+'/grade',instructorToken,{requestId:crypto.randomUUID(),expectedRevision:2,reviewLease:requests.filter(r=>r.method==='POST'&&r.path.endsWith('/answers')).at(-1).body.reviewLease,grades:[{questionId:test.questions[1].id,points:3,comment:'Оцінено паралельно'}]});
  await click('save-answer-correction');await page.locator('[data-action=reload-answer-correction]').waitFor();await click('reload-answer-correction');await page.getByText('Попередня чернетка виправлення',{exact:true}).waitFor();assert.equal(await written().inputValue(),'Відновлена відповідь UI');assert.ok((await page.locator('body').textContent()).includes('Місцевий конфлікт'));
 });
 await check('Cadet sees recalculated work without correction controls or private reasons',async()=>{
  await click('logout');await page.locator('[data-role=cadet]').click();await page.locator('input[name=username]').fill('edit_ui');await page.locator('input[name=password]').fill('synthetic-cadet-password');await page.locator('select[name=group]').selectOption({label:group.name});await page.locator('#auth-form button.primary').click();await page.getByRole('heading',{name:/Вітаємо/}).waitFor();await page.waitForFunction(()=>document.querySelector('.topbar')?.textContent.includes('Оновлено'));
  await page.locator('.nav [data-page=results]').click();await page.locator('[data-action=review-result][data-id="'+result.id+'"]').click();await page.locator('.score').waitFor();assert.equal(await page.locator('[data-action=correct-answers]').count(),0);assert.equal((await page.locator('body').textContent()).includes('PRIVATE_UI_REASON'),false);assert.equal((await page.locator('body').textContent()).includes('PRIVATE_CRITERIA'),false);assert.ok((await page.locator('body').textContent()).includes('виправив інструктор'));
 });
 assert.deepEqual(errors,[]);
 fs.writeFileSync(new URL('../verification/user-result-edits-ui.json',import.meta.url),JSON.stringify({status:'passed',passed:checks.length,checks,pageErrors:errors,productionWrites:false,testedAt:new Date().toISOString()},null,2)+'\n');
}catch(error){console.error(currentCheck,error);fs.writeFileSync(new URL('../verification/user-result-edits-ui.json',import.meta.url),JSON.stringify({status:'failed',passed:checks.length,checks,currentCheck,error:String(error),pageErrors:errors},null,2)+'\n');process.exitCode=1;}
finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
