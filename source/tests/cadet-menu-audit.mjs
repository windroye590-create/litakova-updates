// Real browser clicks against the shipped app and actual Code.gs on synthetic sheets.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {chromium} from 'playwright';
import {handleHostWindow} from './fixtures/host-window.mjs';
process.env.LITAKOVA_SERVER_SOURCE=new URL('../Code.gs',import.meta.url).pathname;
const {api,context,instructorToken,credential}=await import('./fixtures/server_model.mjs');
const buildVersion=JSON.parse(fs.readFileSync(new URL('../package.json',import.meta.url)));
const group=api('POST','/api/instructor/groups',instructorToken,{name:'Аудит меню курсанта'}).group;
const password='Synthetic-cadet-menu-only';
const person=api('POST','/api/register','',{username:'cadet_menu_audit',fullName:'Навігаційний Курсант Тестовий',groupId:group.id,...credential(password)});
const outsider=api('POST','/api/register','',{username:'foreign_menu_audit',fullName:'Чужий Курсант Ізольований',groupId:group.id,...credential(password)});
const choice={text:'Виберіть два прилади',explanation:'Приклад пояснення після перевірки.',answers:[{text:'Компас',isCorrect:true},{text:'Висотомір',isCorrect:true},{text:'Випадковий варіант',isCorrect:false}]};
const written={type:'written',text:'Поясніть рішення своїми словами',maxPoints:3,rubric:'Службовий критерій інструктора',explanation:'Пояснення після здачі.',answers:[]};
function make(title,mode='training',questions=[choice]){return api('POST','/api/instructor/tests',instructorToken,{title,description:'[[LK-RANDOM:N]]',mode,published:true,durationMinutes:30,passingPercent:70,questions}).test;}
const completed=[];
for(let i=0;i<53;i++){
 const t=make('Архівна робота курсанта '+String(i+1).padStart(2,'0'));
 const submissionId='pc-'+crypto.randomUUID(),started=api('POST','/api/tests/'+t.id+'/start',person.token,{submissionId});
 completed.push(api('POST','/api/results',person.token,{testId:t.id,submissionId,startPermit:started.startPermit,durationSeconds:35,choiceProtocol:2,writtenProtocol:1,answers:[{questionId:t.questions[0].id,answerIds:t.questions[0].answers.slice(0,2).map(a=>a.id)}]}).result);
}
const foreignTest=make('Чужий конфіденційний результат');
api('POST','/api/results',outsider.token,{testId:foreignTest.id,submissionId:'pc-'+crypto.randomUUID(),durationSeconds:30,choiceProtocol:2,writtenProtocol:1,answers:[{questionId:foreignTest.questions[0].id,answerIds:foreignTest.questions[0].answers.slice(0,2).map(a=>a.id)}]});
const training=make('АУДИТ — інтерактивне тренування','training',[choice,written,{...choice,text:'Заключне питання'}]);
const exam=make('АУДИТ — інтерактивний іспит','exam',[choice,written]);
const closed=make('АУДИТ — закритий тест');
const access=api('GET','/api/instructor/tests/'+closed.id+'/access',instructorToken);
api('POST','/api/instructor/tests/'+closed.id+'/access',instructorToken,{expectedRevision:access.test.access.revision,scope:'all',open:false});
let state={version:1,theme:'light',session:person,accounts:{},groups:[group]},journal={},offline=false;
const calls=[],errors=[],clicks=[],checks=[],inventories={},downloads=[];
let compactExamReplies=0;
const web=new URL('../web/',import.meta.url),output=new URL('../verification/',import.meta.url);
fs.mkdirSync(output,{recursive:true});
const clone=v=>JSON.parse(JSON.stringify(v));
const server=http.createServer(async(req,res)=>{
 try{
  if(handleHostWindow(req,res))return;
  const route=new URL(req.url,'http://fixture').pathname;res.setHeader('Cache-Control','no-store');
  if(route==='/clock'){res.end(JSON.stringify({ok:true,uptime:100000+performance.now(),launchId:'cadet-menu-audit'}));return;}
  if(route.startsWith('/updates/')){calls.push({method:'HOST',path:route});res.end(JSON.stringify({ok:true,state:2,currentVersion:buildVersion.version,currentCode:buildVersion.versionCode,message:'Установлено актуальну версію.'}));return;}
  if(route.startsWith('/vault/')){res.end(JSON.stringify({ok:false,code:'NOT_FOUND',error:'Isolated legacy storage fixture'}));return;}
  if(route==='/state'||route==='/journal'){
   if(req.method==='POST'){let raw='';for await(const chunk of req)raw+=chunk;const value=JSON.parse(raw);if(route==='/state')state=value;else if((value.serial||0)>(journal.serial||0))journal=value;res.end('{"ok":true}');}
   else res.end(JSON.stringify(route==='/state'?state:journal));return;
  }
  if(route==='/rpc'){
   let raw='';for await(const chunk of req)raw+=chunk;const envelope=JSON.parse(raw);calls.push(clone(envelope));
   if(offline){res.end(JSON.stringify({ok:false,code:'NETWORK',error:'Тестова відсутність мережі'}));return;}
   const reply=context.doPost({postData:{contents:raw}}).text;if(JSON.parse(reply).document?.questionsOmitted===true)compactExamReplies++;res.end(reply);return;
  }
  const file=new URL(route==='/'?'index.html':route.slice(1),web);if(!file.pathname.startsWith(web.pathname)||!fs.existsSync(file)){res.writeHead(404);res.end();return;}
  res.setHeader('Content-Type',({'.js':'text/javascript','.html':'text/html','.css':'text/css','.png':'image/png','.ttf':'font/ttf','.wasm':'application/wasm'})[path.extname(file.pathname)]||'application/octet-stream');res.end(fs.readFileSync(file));
 }catch(e){errors.push(String(e.stack||e));res.writeHead(500);res.end('{"ok":false,"code":"FIXTURE_ERROR"}');}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin='http://127.0.0.1:'+server.address().port;
let browser,page;
const account=()=>state.accounts[person.user.id];
async function until(predicate){for(let i=0;i<250;i++){if(predicate())return;await new Promise(r=>setTimeout(r,40));}throw Error('Expected state did not become ready');}
async function check(name,work){await work();checks.push(name);console.log('PASS '+name);}
const action=(name,scope=page)=>scope.locator('[data-action="'+name+'"]').first();
async function click(name,scope=page){await action(name,scope).click();}
async function nav(name){await page.locator('.nav [data-page="'+name+'"]').click();await page.locator('.nav [data-page="'+name+'"][aria-current=page]').waitFor({state:'attached'});}
async function inventory(name){if(process.env.LITAKOVA_CADET_SHOTS==='1'&&['home','tests','results','profile'].includes(name))await page.screenshot({path:new URL('cadet-menu-'+name+'.png',output).pathname,fullPage:true});inventories[name]=await page.locator('button:visible,input:visible,textarea:visible,select:visible,summary:visible').evaluateAll(els=>els.map(e=>({tag:e.tagName,action:e.dataset.action||'',page:e.dataset.page||'',type:e.type||'',disabled:e.disabled===true,label:(e.getAttribute('aria-label')||e.textContent||e.getAttribute('placeholder')||'').trim().slice(0,100)})));}
async function findTest(test){await nav('tests');await page.locator('#filter').fill(test.title);await page.locator('.test-card').filter({hasText:test.title}).waitFor();return page.locator('.test-card').filter({hasText:test.title});}
async function start(test){const card=await findTest(test);await click('start',card);await page.locator('#modal[open]').waitFor();await page.locator('#modal button.primary').click();await page.locator('.runner').waitFor();}
try{
 browser=await chromium.launch({headless:true,args:['--no-sandbox'],executablePath:process.env.LITAKOVA_CHROMIUM_EXECUTABLE});
 page=await browser.newPage({viewport:{width:1440,height:1000},locale:'uk-UA',acceptDownloads:true});page.setDefaultTimeout(15000);
 page.on('pageerror',e=>errors.push(String(e.stack||e)));page.on('dialog',dialog=>dialog.accept());
 await page.exposeFunction('recordAuditClick',value=>clicks.push(value));
 await page.addInitScript(()=>document.addEventListener('click',event=>{const e=event.target.closest('button,input,summary');if(e&&event.isTrusted)window.recordAuditClick({tag:e.tagName,action:e.dataset.action||'',page:e.dataset.page||'',type:e.type||''});},true));
 await page.route('**/*',route=>{if(route.request().url().startsWith(origin)||route.request().url().startsWith('blob:'))return route.continue();errors.push('Unexpected external request');return route.abort();});
 page.on('download',download=>downloads.push(download));
 await page.goto(origin+'/?key=cadet-menu-audit');await page.locator('.layout').waitFor();await until(()=>account()?.tests?.some(t=>String(t.id)===String(training.id)));
 await check('Cadet sees exactly Home, My tests, My results and Profile without instructor controls',async()=>{
  assert.deepEqual(await page.locator('.nav [data-page]').evaluateAll(els=>els.map(e=>e.dataset.page)),['home','tests','results','more']);
  assert.equal(await page.locator('[data-action=new-test],[data-action=add-cadet],[data-action=invite],[data-action=analytics],[data-action=audit]').count(),0);assert.equal(await page.locator('.cards .stat').count(),3);assert.ok(!(await page.locator('.cards').innerText()).toLocaleLowerCase('uk-UA').includes('у черзі'));assert.equal(await page.locator('[data-action=download-all]').count(),0);await inventory('home');
 });
 await check('Update data responds on all four menu pages and preserves the selected section',async()=>{
  for(const section of ['home','tests','results','more']){await nav(section);const refresh=page.locator('.topbar [data-action=refresh]');await refresh.waitFor();await refresh.click();await page.locator('.topbar [data-action=refresh]:not([disabled])').waitFor();assert.equal(await page.locator('.nav [data-page="'+section+'"]').getAttribute('aria-current'),'page');}
  await nav('home');
 });
 await check('Home shortcut opens the test catalogue and topbar theme toggles both ways without losing the page',async()=>{
  await page.getByRole('button',{name:/Перейти до тестів/}).click();await page.getByRole('heading',{name:'Мої тести',exact:true}).waitFor();
  await click('theme');await until(()=>state.theme==='dark');await click('theme');await until(()=>state.theme==='light');assert.equal(await page.getByRole('heading',{name:'Мої тести',exact:true}).count(),1);assert.equal(await page.locator('.catalog-note').count(),1);assert.equal(await page.locator('.test-card').filter({hasText:'Розпочате тренування можна завершити без інтернету'}).count(),0);await inventory('tests');
 });
 await check('Test search and clear work, catalogue Next and Previous change the actual visible cards',async()=>{
  await page.locator('#filter').fill(training.title);assert.equal(await page.locator('.test-card').count(),1);await page.locator('#filter').fill('');
  const first=await page.locator('.test-card h3').allTextContents();await page.locator('[data-action=list-page][data-list=tests][data-index="2"]').click();assert.notDeepEqual(await page.locator('.test-card h3').allTextContents(),first);
  await page.locator('[data-action=list-page][data-list=tests][data-index="1"]').click();assert.deepEqual(await page.locator('.test-card h3').allTextContents(),first);
 });
 await check('A closed test cannot start and a completed test cannot be started again',async()=>{
  let card=await findTest(closed);assert.equal(await action('start',card).isDisabled(),true);assert.equal(await card.locator('[data-action=download]').count(),0);
  await page.locator('#filter').fill(completed[0].testTitle);card=page.locator('.test-card').filter({hasText:completed[0].testTitle});assert.equal(await action('start',card).isDisabled(),true);
 });
 await check('Download and Refresh on PC cache the selected test without starting a run',async()=>{
  const card=await findTest(training);await click('download',card);await until(()=>account().fullTests[training.id]);assert.equal(account().run,null);await card.getByRole('button',{name:'↻ Оновити на ПК'}).click();await until(()=>calls.filter(c=>c.path==='/api/tests/'+training.id).length>=2);const cached=clone(account().fullTests[training.id]);offline=true;await click('download',card);await page.locator('#toast').filter({hasText:'Тестова відсутність мережі'}).waitFor();assert.deepEqual(account().fullTests[training.id],cached);offline=false;
 });
 await check('Available tests download from the catalogue while Home and Profile omit duplicate download actions',async()=>{
  await click('download-all');await until(()=>account().fullTests[exam.id]);await nav('home');assert.equal(await page.locator('[data-action=download-all]').count(),0);await nav('more');assert.equal(await page.locator('[data-action=download-all]').count(),0);await nav('home');assert.equal(account().run,null);assert.equal(account().pending.length,0);
 });
 await check('Home All shortcut opens My results and shows only the signed-in cadet',async()=>{
  await page.getByRole('button',{name:'Усі →',exact:true}).click();await page.getByRole('heading',{name:'Мої результати',exact:true}).waitFor();assert.equal(await page.getByText(outsider.user.fullName,{exact:false}).count(),0);
  assert.equal(await page.locator('[data-action=results-view],[data-action=grade-result],[data-action=delete-result]').count(),0);await inventory('results');
 });
 await check('Results Next and Previous work and result search does not change the saved test search',async()=>{
  assert.equal(account().results.length,53);const before=await page.locator('.compact-results tbody tr').allTextContents();await page.locator('[data-action=list-page][data-list=results][data-index="2"]').click();assert.notDeepEqual(await page.locator('.compact-results tbody tr').allTextContents(),before);
  await page.locator('[data-action=list-page][data-list=results][data-index="1"]').click();await page.locator('#filter').fill(completed[0].testTitle);assert.equal(await page.locator('.compact-results tbody tr').count(),1);
 });
 await check('Cadet results provide review without CSV, Excel or instructor export controls',async()=>{
  assert.equal(await page.locator('[data-action=export-csv],[data-action=export-xlsx],[data-action=group-statement]').count(),0);assert.equal(await page.locator('[data-action=review-result]').count(),1);assert.equal(downloads.length,0);
 });
 await check('All 53 own results stay accessible across both pages after removing cadet export controls',async()=>{
  await page.locator('#filter').fill('');assert.equal(await page.locator('.compact-results tbody tr').count(),50);await page.locator('[data-action=list-page][data-list=results][data-index="2"]').click();assert.equal(await page.locator('.compact-results tbody tr').count(),3);assert.equal(await page.locator('[data-action=export-csv]').count(),0);await page.locator('#filter').fill(completed[0].testTitle);
 });
 await check('Review opens, Back to results and Back to tests work, and cached review remains readable offline',async()=>{
  await click('review-result');await page.locator('.result-card').waitFor();await inventory('result-review');assert.equal(await page.locator('.review').count(),1);
  await click('nav',page.locator('.result-card'));await page.getByRole('heading',{name:'Мої результати',exact:true}).waitFor();await page.locator('#filter').fill(completed[0].testTitle);offline=true;
  await click('review-result');await page.locator('.result-card').waitFor();assert.equal(await page.locator('.review').count(),1);offline=false;await page.locator('.result-card [data-page=tests]').click();await page.getByRole('heading',{name:'Мої тести',exact:true}).waitFor();
 });
 await check('Profile opens the correct account and its theme switch survives reloading',async()=>{
  await nav('more');await page.getByRole('heading',{name:'Профіль',exact:true}).waitFor();await inventory('profile');assert.ok((await page.locator('.settings-grid').innerText()).includes(person.user.fullName));
  await click('theme',page.locator('.settings-grid'));await until(()=>state.theme==='dark');await page.reload();await page.locator('.layout').waitFor();await nav('more');assert.equal(state.theme,'dark');await click('theme',page.locator('.settings-grid'));await until(()=>state.theme==='light');
 });
 await check('Profile keeps update checking, identity and compact version metadata without duplicate download or queue controls',async()=>{
  await click('check-update');await until(()=>calls.some(c=>c.path==='/updates/check'));await page.locator('#update-message').filter({hasText:'Установлено актуальну версію'}).waitFor();assert.equal(await page.locator('.settings-grid [data-action=download-all],.settings-grid [data-action=sync]').count(),0);assert.equal(await page.getByRole('heading',{name:'Про застосунок',exact:true}).count(),0);assert.ok((await page.locator('.profile-meta').innerText()).includes(buildVersion.version));assert.equal(account().pending.length,0);
 });
 await check('Start confirmation can be cancelled by its button and Escape without creating an attempt',async()=>{
  const card=await findTest(training);await click('start',card);await page.locator('#modal[open]').waitFor();await click('cancel-modal',page.locator('#modal'));assert.equal(account().run,null);
  await click('start',card);await page.locator('#modal[open]').waitFor();await page.keyboard.press('Escape');assert.equal(await page.locator('#modal[open]').count(),0);assert.equal(account().run,null);
 });
 await start(training);
 await check('First and last question boundaries, numbered buttons, Next and Previous all respond',async()=>{
  await inventory('training-runner');assert.equal(await action('prev').isDisabled(),true);await click('next');await page.locator('[data-run-written]').waitFor();await click('next');assert.equal(await action('next').isDisabled(),true);await click('prev');await page.locator('[data-run-written]').waitFor();await page.locator('[data-action=question][data-q="0"]').click();
 });
 await check('Choice checkboxes toggle by mouse and keyboard and reject a third simultaneous answer',async()=>{
  await page.locator('[data-run-answer]').nth(0).check();await page.locator('[data-run-answer]').nth(1).check();await page.locator('[data-run-answer]').nth(2).click();assert.equal(await page.locator('[data-run-answer]:checked').count(),2);assert.equal(await page.locator('[data-run-answer]').nth(2).isChecked(),false);
  await page.locator('[data-run-answer]').nth(1).focus();await page.keyboard.press('Space');assert.equal(await page.locator('[data-run-answer]:checked').count(),1);await page.locator('[data-run-answer]').nth(1).check();
 });
 const text='Письмова відповідь курсанта\nДругий рядок 🇺🇦';
 await check('Skip unanswered opens the written question and writing survives changing questions',async()=>{
  await click('unanswered');await page.locator('[data-run-written]').fill(text);await click('next');await page.locator('[data-run-answer]').nth(0).check();await page.locator('[data-run-answer]').nth(1).check();await page.locator('[data-action=question][data-q="1"]').click();assert.equal(await page.locator('[data-run-written]').inputValue(),text);await until(()=>account().run.answers[training.questions[1].id]===text);await click('unanswered');await page.locator('#toast').filter({hasText:'На всі питання вже відповіли.'}).waitFor();assert.equal(await page.locator('[data-run-written]').inputValue(),text);
 });
 await check('Reopening an unfinished training through Home and Continue keeps all answers and its current question',async()=>{
  await page.reload();await page.locator('.layout').waitFor();assert.ok(account().run);assert.equal(await page.locator('[data-action=resume]').count(),1);await click('resume');await page.locator('.runner').waitFor();assert.equal(await page.locator('[data-run-written]').inputValue(),text);await page.reload();await page.locator('.layout').waitFor();if(await page.locator('[data-action=resume]').count())await click('resume');await page.locator('.runner').waitFor();assert.equal(await page.locator('[data-run-written]').inputValue(),text);
 });
 await check('Cancel finish keeps the active training and creates no result',async()=>{
  await click('finish');await page.locator('#modal[open]').waitFor();await click('cancel-modal',page.locator('#modal'));assert.ok(account().run);assert.equal(account().pending.length,0);
 });
 await check('Finishing offline keeps one durable queued work and both queue buttons retain it until reconnect',async()=>{
  offline=true;await click('finish');await page.locator('#modal[open]').waitFor();await page.locator('#modal button.primary').click();await page.locator('.result-card').waitFor();await until(()=>account().pending.length===1);assert.equal(account().run,null);await inventory('queued-result');
  await page.locator('.result-card [data-page=results]').click();await page.getByRole('heading',{name:'Мої результати',exact:true}).waitFor();await click('sync',page.locator('.topbar'));await until(()=>account().pending.length===1);await click('sync',page.locator('#results-panel'));assert.equal(account().pending.length,1);await nav('home');assert.equal(await page.locator('.cards .stat').count(),4);assert.ok((await page.locator('.cards').innerText()).toLocaleLowerCase('uk-UA').includes('у черзі'));await nav('more');assert.equal(await page.locator('.settings-grid [data-action=sync]').count(),0);await click('sync',page.locator('.topbar'));assert.equal(account().pending.length,1);assert.equal(account().pending[0].body.answers.find(a=>a.questionId===training.questions[1].id).text,text);
  await click('logout',page.locator('.settings-grid'));await page.locator('#modal[open]').waitFor();assert.ok((await page.locator('#modal').innerText()).includes('Зміни ще не надіслані'));await click('cancel-modal',page.locator('#modal'));assert.equal(state.session.user.id,person.user.id);assert.equal(account().pending.length,1);
 });
 await check('Reconnect and Send queue commit one result with exact written text and clear the pending indicator',async()=>{
  offline=false;await click('sync',page.locator('.topbar'));await until(()=>account().pending.length===0);const rows=api('GET','/api/my-results',person.token).results.filter(r=>r.testId===training.id);assert.equal(rows.length,1);
  assert.equal(api('GET','/api/results/'+rows[0].id+'/review',person.token).review.find(q=>q.type==='written').text,text);assert.equal(await page.locator('.topbar [data-action=sync]').count(),0);await nav('home');assert.equal(await page.locator('.cards .stat').count(),3);assert.ok(!(await page.locator('.cards').innerText()).toLocaleLowerCase('uk-UA').includes('у черзі'));
 });
 await start(exam);
 await check('Exam starts through its confirmation, accepts choices and written text and Sync now saves them',async()=>{
  await inventory('exam-runner');await page.locator('[data-run-answer]').nth(0).check();await page.locator('[data-run-answer]').nth(1).check();await click('next');await page.locator('[data-run-written]').fill(text);await click('sync-exam');await until(()=>!account().examRequest);assert.ok(account().run.examProtocol===1);
 });
 await check('Exam handoff returns Home and Continue restores editing with the same deadline and written answer',async()=>{
  const deadline=account().run.deadline;await click('handoff-exam');await page.getByRole('heading',{name:/Вітаємо/}).waitFor();await click('resume');await page.locator('.runner').waitFor();await until(()=>account().run.ownerId);assert.equal(account().run.deadline,deadline);await page.locator('[data-action=question][data-q="1"]').click();assert.equal(await page.locator('[data-run-written]').inputValue(),text);assert.equal(await page.locator('.run-answers').isDisabled(),false);
 });
 await check('Exam finish confirmation records one result and leaves the result screen responsive',async()=>{
  await click('finish');await page.locator('#modal[open]').waitFor();await page.locator('#modal button.primary').click();await page.locator('.result-card').waitFor();await until(()=>account().run===null);assert.equal(api('GET','/api/my-results',person.token).results.filter(r=>r.testId===exam.id).length,1);await page.locator('.result-card [data-page=results]').click();await page.getByRole('heading',{name:'Мої результати',exact:true}).waitFor();
 });
 await check('Compact menu opens every cadet section, closes after selection and responds to Escape',async()=>{
  await page.setViewportSize({width:800,height:650});const toggle=page.locator('[data-action=toggle-menu]');
  for(const section of ['home','tests','results','more']){await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'true');await nav(section);assert.equal(await toggle.getAttribute('aria-expanded'),'false');}
  await toggle.click();await page.keyboard.press('Escape');assert.equal(await toggle.getAttribute('aria-expanded'),'false');assert.equal(await toggle.evaluate(e=>e===document.activeElement),true);await toggle.click();await toggle.click();assert.equal(await toggle.getAttribute('aria-expanded'),'false');
 });
 await check('Keyboard Enter activates a menu item and the profile logout returns to the login form',async()=>{
  await page.setViewportSize({width:1440,height:1000});await page.locator('.nav [data-page=home]').focus();await page.keyboard.press('Enter');await page.locator('.nav [data-page=home][aria-current=page]').waitFor();await nav('more');await click('logout',page.locator('.settings-grid'));if(await page.locator('#modal[open]').count())await page.locator('#modal button.primary').click();await page.locator('#auth-form').waitFor();assert.equal(state.session,null);
 });
 await check('Cadet login role, registration toggle and password visibility controls respond',async()=>{
  await page.locator('[data-action=role][data-role=cadet]').click();const form=page.locator('#auth-form');
  await form.locator('[name=password]').fill(password);await click('show-password',form);assert.equal(await form.locator('[name=password]').getAttribute('type'),'text');await click('show-password',form);assert.equal(await form.locator('[name=password]').getAttribute('type'),'password');
  await click('auth-mode');await page.locator('[name=fullName]').waitFor();assert.equal(await page.locator('[name=inviteCode]').count(),0);await click('auth-mode');await page.locator('[name=username]').waitFor();assert.equal(await page.locator('[name=fullName]').count(),0);await inventory('cadet-login');
 });
 await check('Signing in again restores the same account and sidebar logout remains logged out after restart',async()=>{
  const form=page.locator('#auth-form');await form.locator('[name=username]').fill(person.user.username);await form.locator('[name=password]').fill(password);await form.locator('select').selectOption({label:group.name});await form.locator('button.primary').click();
  await page.locator('.layout').waitFor();assert.equal(state.session.user.id,person.user.id);assert.equal(account().pending.length,0);await click('logout',page.locator('.sidebar'));if(await page.locator('#modal[open]').count())await page.locator('#modal button.primary').click();await page.locator('#auth-form').waitFor();await page.reload();await page.locator('#auth-form').waitFor();assert.equal(state.session,null);
 });
 assert.deepEqual(errors,[]);assert.ok(clicks.length>70);assert.ok(compactExamReplies>0,'The actual browser must accept a short exam save response');assert.equal(calls.filter(c=>c.path?.startsWith('/api/instructor/')).length,0);
 const visibleActions=[...new Set(Object.values(inventories).flat().map(x=>x.action).filter(Boolean))].sort(),clickedActions=[...new Set(clicks.map(x=>x.action).filter(Boolean))].sort();assert.deepEqual(visibleActions.filter(a=>!clickedActions.includes(a)),[],'Every inventoried button action must be exercised');
 const report={status:'passed',version:buildVersion.version,visibleActions,clickedActions,checksPassed:checks.length,checks,realUserClicks:clicks.length,clicks,inventories,compactExamReplies,downloadCount:downloads.length,productionRequests:0,externalRequests:0,actualCodeGs:true,syntheticAccountsOnly:true,pageErrors:errors};
 fs.writeFileSync(new URL('cadet-menu-audit.json',output),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:checks.length,clicks:clicks.length,productionRequests:0}));
}catch(e){
 const report={status:'failed',checksPassed:checks.length,checks,error:String(e.stack||e),pageErrors:errors,clicks,inventories,productionRequests:0};fs.writeFileSync(new URL('cadet-menu-audit.json',output),JSON.stringify(report,null,2)+'\n');if(page){await page.screenshot({path:new URL('cadet-menu-audit-failure.png',output).pathname,fullPage:true}).catch(()=>{});console.error((await page.locator('body').innerText()).slice(-3000));}throw e;
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
