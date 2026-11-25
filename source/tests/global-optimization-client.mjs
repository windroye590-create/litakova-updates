import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';
const moduleURL = process.env.LITAKOVA_OPT_ACCOUNT_SOURCE ? pathToFileURL(process.env.LITAKOVA_OPT_ACCOUNT_SOURCE) : new URL('../web/account-sync.js', import.meta.url);
const {createAccountSync} = await import(moduleURL.href);
const app = fs.readFileSync(process.env.LITAKOVA_OPT_APP_SOURCE || new URL('../web/app.js', import.meta.url), 'utf8');
const checks = [], measurements = {}, benchmark = process.argv.includes('--benchmark-only');
async function check(name, run) {await run(); checks.push(name); console.log('PASS ' + name);}
const clone = value => JSON.parse(JSON.stringify(value));
const s = {token: 'isolated-teacher', user: {id: 'isolated-teacher', role: 'instructor'}}, a = {draft: null};
let revision = 0, remote = null, diskWrites = 0, posts = 0, rejectDisk = false, stable = true;
const controller = createAccountSync({session: () => s, account: () => a, snapshot: () => ({'test-draft': a.draft}),
  apply: async (key, value) => {a.draft = value;}, persist: async () => {diskWrites++; if (rejectDisk) throw Error('Synthetic disk failure');},
  delay: 100000, rpc: async (method, path, body) => {
    const base = {accountSyncProtocol: 1, userId: s.user.id};
    if (path === '/api/account-state') return {...base, cursor: String(revision), stable, documents: revision ? [{key: 'test-draft', revision}] : []};
    if (method === 'POST') {assert.equal(body.expectedRevision, revision); posts++; revision++; remote = clone(body.value);}
    return {...base, document: {key: 'test-draft', revision, value: clone(remote)}};
  }});
try {
  await controller.sync(true); diskWrites = 0;
  for (let i = 0; i < 4; i++) await controller.sync(true);
  measurements.unchangedAccountPollDiskWrites = diskWrites;
  if (!benchmark) {
    await check('Unchanged account polls do not re-encrypt and rewrite the local profile', async () => assert.equal(diskWrites, 0));
    await check('A changed remote document is applied and durably saved', async () => {
      revision++; remote = {localId: 'remote-large-draft', title: 'Remote', text: 'П'.repeat(1000000)};
      const before = diskWrites; await controller.sync(true); assert.deepEqual(a.draft, remote); assert.ok(diskWrites > before);
    });
    await check('A local change cannot be posted before its request ID is durably saved', async () => {
      a.draft = {...a.draft, title: 'Local pending edit'}; rejectDisk = true; const count = posts;
      await controller.sync(true); assert.equal(posts, count); assert.match(controller.status().error, /disk failure/);
      await controller.sync(true); assert.equal(posts, count, 'A retry bypassed an unacknowledged request ID'); assert.match(controller.status().error, /disk failure/);
      rejectDisk = false; await controller.sync(true); assert.equal(posts, count + 1); assert.equal(remote.title, a.draft.title); assert.equal(controller.status().pending, 0);
    });
    await check('An unchanged poll retries an earlier failed save of applied remote data', async () => {
      revision++; remote = {...remote, title: 'Remote edit before disk outage'}; rejectDisk = true;
      await controller.sync(true); assert.match(controller.status().error, /disk failure/);
      const before = diskWrites; await controller.sync(true); assert.ok(diskWrites > before); assert.match(controller.status().error, /disk failure/);
      rejectDisk = false; await controller.sync(true); assert.equal(controller.status().error, ''); assert.equal(a.draft.title, remote.title);
    });
    await check('An unstable cursor is persisted and forces a later retry', async () => {
      stable = false; const before = diskWrites; await controller.sync(true); assert.equal(a.pcSync.cursor, ''); assert.ok(diskWrites > before);
      stable = true; await controller.sync(true); assert.equal(a.pcSync.cursor, String(revision));
    });
  }
} finally {controller.reset();}

function appFunction(name) {
  const start = app.search(new RegExp('^(?:async )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name);
  const end = app.slice(start + 1).search(/\n(?:async )?function /);
  return end < 0 ? app.slice(start) : app.slice(start, start + 1 + end);
}
let saves = 0, next = 0; const timers = new Map();
const box = {clearTimeout: key => timers.delete(key), setTimeout: fn => {timers.set(++next, fn); return next;}, saveTimer: null,
  scheduledSave: false, saving: null, diskWriter: {save: async () => {saves++;}}, updateStorageNotice() {}, user: () => null, toast() {}};
vm.createContext(box); vm.runInContext(appFunction('persist'), box); vm.runInContext(appFunction('scheduleSave'), box);
box.scheduleSave(); await box.persist();
for (const fn of [...timers.values()]) await fn();
measurements.answerThenImmediateSaveDiskWrites = saves;
if (!benchmark) await check('An immediate save supersedes the pending autosave without a duplicate write', async () => assert.equal(saves, 1));
const report = {status: 'passed', passed: checks.length, checks, benchmarkOnly: benchmark, measurements, productionRequests: 0};
fs.writeFileSync(process.env.LITAKOVA_OPT_CLIENT_REPORT || new URL('../verification/global-optimization-client.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
