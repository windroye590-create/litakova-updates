import {handleHostWindow} from './fixtures/host-window.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {chromium} from 'playwright';
import {createHash} from 'node:crypto';
process.env.LITAKOVA_SERVER_SOURCE = new URL('../Code.gs', import.meta.url).pathname;
const {context, api, credential, instructorToken, regressionTest} = await import('./fixtures/server_model.mjs');
const group = api('POST', '/api/instructor/groups', instructorToken, {name: 'Ізольована швидка навігація'}).group;
const cadet = api('POST', '/api/register', '', {username: 'responsive-navigation', fullName: 'Синтетична Перевірка', groupId: group.id, ...credential('synthetic-navigation-password')});
const test = regressionTest('Швидка навігація на 200 питаннях', 200);
const web = process.env.LITAKOVA_OPT_WEB_ROOT || new URL('../web/', import.meta.url).pathname;
const benchmark = process.argv.includes('--benchmark-only'), errors = [], checks = [];
let state = {version: 1, session: cadet, accounts: {}, groups: [group]}, journal = {}, stateDelay = 0, delayedAcks = 0, failState = false;
const server = http.createServer(async (req, res) => {
  if (handleHostWindow(req, res)) return;
  try {
    const route = new URL(req.url, 'http://local').pathname;
    const read = async () => {const parts = []; for await (const part of req) parts.push(part); return Buffer.concat(parts).toString('utf8');};
    const json = value => {res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value));};
    if (route === '/clock') return json({ok: true, uptime: 100000 + performance.now(), launchId: 'isolated-navigation'});
    if (route.startsWith('/updates/')) return json({ok: true, state: 2, message: 'Ізольована перевірка'});
    if (route === '/state' || route === '/journal') {
      if (req.method !== 'POST') return json(route === '/state' ? state : journal);
      const value = JSON.parse(await read());
      if (route === '/state') {
        const delay = stateDelay;
        if (delay) {await new Promise(resolve => setTimeout(resolve, delay)); delayedAcks++;}
        if (failState) {failState = false; return json({ok: false, code: 'STORAGE_WRITE', error: 'Синтетична помилка запису'});}
        state = value;
      } else journal = value;
      return json({ok: true});
    }
    if (route === '/rpc') {const raw = await read(); res.setHeader('Content-Type', 'application/json'); res.end(context.doPost({postData: {contents: raw}}).text); return;}
    const file = path.resolve(web, route === '/' ? 'index.html' : route.slice(1));
    if (!file.startsWith(path.resolve(web) + path.sep)) throw Error('Invalid path');
    res.setHeader('Content-Type', ({'.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png'})[path.extname(file)] || 'application/octet-stream');
    res.end(fs.readFileSync(file));
  } catch (error) {errors.push(error.message); res.statusCode = 500; res.end('Isolated fixture error');}
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({headless: true, args: ['--no-sandbox'], executablePath: process.env.LITAKOVA_CHROMIUM_EXECUTABLE});
  const page = await browser.newPage({viewport: {width: 1366, height: 900}, locale: 'uk-UA'});
  page.setDefaultTimeout(20000); page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port + '/?key=isolated-navigation');
  await page.locator('.layout').waitFor();
  await page.locator('.nav [data-page="tests"]').click();
  await page.locator('[data-action="start"][data-id="' + test.id + '"]').click();
  await page.locator('#modal button.primary').click();
  await page.locator('.runner').waitFor();
  await page.evaluate(async () => (await import('/app.js')).persist());
  stateDelay = 1200;
  const started = performance.now();
  const first = await page.evaluate(async () => {
    const app = await import('/app.js'), run = app.account().run, key = String(run.test.questions[0].id);
    document.querySelector('[data-run-answer]').click();
    const answer = run.answers[key]; document.querySelector('[data-action="next"]').click(); return {key, answer};
  });
  await page.locator('[data-action="question"][data-q="1"].current').waitFor();
  const navigationMs = Math.round(performance.now() - started), renderedBeforeDiskAcknowledgement = delayedAcks === 0;
  if (!benchmark) assert.ok(renderedBeforeDiskAcknowledgement, 'Navigation waited for the slow profile write');
  checks.push(renderedBeforeDiskAcknowledgement ? 'Question two renders while a 1200 ms profile write is pending' : 'Baseline navigation waited for the delayed disk acknowledgement');
  stateDelay = 0;
  const second = await page.evaluate(async () => {
    const app = await import('/app.js'), run = app.account().run, key = String(run.test.questions[1].id);
    document.querySelector('[data-run-answer]').click();
    const answer = run.answers[key];
    document.querySelector('[data-action="question"][data-q="2"]').click();
    document.querySelector('[data-action="question"][data-q="4"]').click();
    await app.persist(); return {key, answer};
  });
  assert.deepEqual(state.accounts[cadet.user.id].run.answers[first.key], first.answer);
  assert.deepEqual(state.accounts[cadet.user.id].run.answers[second.key], second.answer);
  assert.equal(state.accounts[cadet.user.id].run.index, 4);
  checks.push('Rapid navigation and newer answers are durably saved after the delayed write');
  failState = true;
  const failure = await page.evaluate(async () => {
    try {const app=await import('/app.js');await app.clickAction({dataset: {action: 'question', q: '6'}});await app.persist();} catch (error) {return error.code;}
  });
  assert.equal(failure, 'STORAGE_WRITE');
  await page.evaluate(async () => (await import('/app.js')).clickAction({dataset: {action: 'retry-save'}}));
  assert.deepEqual(state.accounts[cadet.user.id].run.answers[first.key], first.answer);
  assert.deepEqual(state.accounts[cadet.user.id].run.answers[second.key], second.answer);
  checks.push('A disk failure remains visible and retry preserves both answers');
  await page.reload(); await page.locator('.layout').waitFor();
  const restored = await page.evaluate(async () => (await import('/app.js')).account().run.answers);
  assert.deepEqual(restored[first.key], first.answer); assert.deepEqual(restored[second.key], second.answer);
  assert.deepEqual(errors, []); checks.push('Restart restores every selected answer without application errors');
  const report = {status: 'passed', benchmarkOnly: benchmark, passed: checks.length, checks, questions: 200,
    simulatedDiskMilliseconds: 1200, navigationMilliseconds: navigationMs, renderedBeforeDiskAcknowledgement, productionWrites: false, pageErrors: errors,
    appSHA256: createHash('sha256').update(fs.readFileSync(path.join(web, 'app.js'))).digest('hex')};
  fs.writeFileSync(process.env.LITAKOVA_OPT_UI_REPORT || new URL('../verification/global-optimization-ui.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {if (browser) await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
