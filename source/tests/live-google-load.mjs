// Explicitly dispatched live test. Only a guarded sandbox URL from setup is accepted.
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID, webcrypto} from 'node:crypto';
import * as C from '../web/core.js';
import {createExamSession} from '../web/exam-session.js';
globalThis.crypto ??= webcrypto;
const options = Object.fromEntries(process.argv.slice(2).reduce((out, value, index, all) => {if (value.startsWith('--')) out.push([value.slice(2), all[index + 1]]); return out;}, []));
const statePath = path.resolve(options.state || ''), out = path.resolve(options['report-dir'] || '');
const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
const production = JSON.parse(await fs.readFile(new URL('../../automation.json', import.meta.url), 'utf8'));
assert.match(state.namespace, /^LK_LT_[0-9a-f]{20}_$/);
assert.ok(state.webAppUrl.endsWith('/' + state.testDeploymentId + '/exec'));
assert.notEqual(state.testDeploymentId, state.productionDeploymentId);
assert.notEqual(state.testDeploymentId, production.deploymentId);
assert.notEqual(state.webAppUrl, production.webAppUrl);
assert.equal(state.scriptId, production.scriptId);
assert.ok(Object.values(state.createdBooks).every(id => id !== production.spreadsheetId));
assert.ok(state.headRestored && state.clients >= 20 && state.clients <= 27);
await fs.mkdir(out, {recursive: true});
const scratch = path.dirname(statePath), calls = [], phases = [], clients = [], cacheKeys = new Set(state.initialCacheKeys || []);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));
let phase = 'setup', teacher = null, teacherPolling = false, teacherFlight = null, active = 0, peakActive = 0;
async function trackCacheKeys(metrics){
  for(const key of metrics.cacheKeys||[])if(!cacheKeys.has(key)){cacheKeys.add(key);await fs.appendFile(path.join(scratch,'cache-keys.ndjson'),JSON.stringify(key)+'\n',{mode:0o600});}
}
async function localSave(client) {
  const filename = path.join(scratch, 'client-' + client.index + '.json'), temporary = filename + '.tmp';
  const raw = JSON.stringify(client.account);
  client.saving = (client.saving || Promise.resolve()).then(async () => {await fs.writeFile(temporary, raw, {mode: 0o600}); await fs.rename(temporary, filename);});
  await client.saving;
}
async function transport(envelope) {
  let url = state.webAppUrl, method = 'POST', body = JSON.stringify({...envelope, loadTestKey: state.secret});
  const operationTimeout=AbortSignal.timeout(90000);
  for (let redirects = 0; redirects < 6; redirects++) {
    const response = await fetch(url, {method, body, redirect: 'manual', headers: {'Content-Type': 'application/json', 'User-Agent': 'Litakova-Komisiia-PC/1.0.15 (gzip)'}, signal: AbortSignal.any([operationTimeout,AbortSignal.timeout(45000)])});
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = new URL(response.headers.get('location'), url);
      assert.ok(target.protocol === 'https:' && ['script.google.com', 'script.googleusercontent.com'].includes(target.hostname), 'Unexpected sandbox redirect');
      url = target.href;
      if ([301, 302, 303].includes(response.status)) {method = 'GET'; body = undefined;}
      continue;
    }
    const raw = await response.text(); assert.ok(Buffer.byteLength(raw) <= 8 * 1024 * 1024);
    let reply, category = '';
    try {reply = JSON.parse(raw);} catch {
      category = /too many scripts|simultaneously|too many times|quota|rate limit/i.test(raw) ? 'GOOGLE_QUOTA_OR_CONCURRENCY' : /authorization|accounts\.google|sign in/i.test(raw) ? 'GOOGLE_AUTHORIZATION' : 'NON_JSON_GOOGLE_RESPONSE';
      reply = {ok: false, code: response.ok ? 'BAD_JSON' : 'HTTP_' + response.status, error: category};
    }
    if (!response.ok) reply = {...reply, ok: false, code: 'HTTP_' + response.status};
    if (/too many|quota|limit exceeded/i.test(String(reply.error || ''))) category ||= 'GOOGLE_QUOTA_OR_CONCURRENCY';
    return {reply, status: response.status, category, encoding: response.headers.get('content-encoding') || 'identity',responseBytes:Buffer.byteLength(raw)};
  }
  throw Error('Sandbox redirect limit exceeded');
}
async function once(method, endpoint, body = {}, token = '', client = -1, label = phase) {
  const started = performance.now(); let wire;
  active++; peakActive = Math.max(peakActive, active);
  try {wire = await transport(C.payload(method, endpoint, token, body));}
  catch (error) {wire = {reply: {ok: false, code: error.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK'}, status: 0, category: error.name || 'NETWORK'};}
  finally {active--;}
  const reply = wire.reply, metrics = reply.loadTestMetrics || {};
  await trackCacheKeys(metrics);
  const record = {phase: label, client, method, path: endpoint, status: wire.status, code: reply.ok ? 'OK' : reply.code || 'API_ERROR', category: wire.category,
    milliseconds: Math.round(performance.now() - started), serverMilliseconds: metrics.elapsedMs ?? null, lockWaitMilliseconds: metrics.lockWaitMs ?? null,
    lockHeldMilliseconds: metrics.lockHeldMs ?? null, stages: metrics.stages || {}, sessionFailure: metrics.sessionFailure || null, signingKeyFingerprint:metrics.signingKeyFingerprint||null,encoding: wire.encoding,
    ...(endpoint==='/api/challenge'&&reply.ok?{challengeSaltLength:typeof reply.salt==='string'?reply.salt.length:null,challengeSaltBase64:typeof reply.salt==='string'&&/^[A-Za-z0-9+/]+={0,2}$/.test(reply.salt)}:{}),
    ...(endpoint.startsWith('/api/exam-session')&&reply.ok?{examProtocol:reply.examProtocol??null,hasExamDocument:!!reply.document,sandboxHealth:reply.loadTestSandbox===true,
      responseBytes:wire.responseBytes??null,examSyncProtocol:reply.examSyncProtocol??null,questionsOmitted:reply.document?.questionsOmitted===true,unchanged:reply.document?.unchanged===true}: {})};
  calls.push(record); await fs.appendFile(path.join(out, 'requests.jsonl'), JSON.stringify(record) + '\n');
  return reply;
}
async function rpc(method, endpoint, body = {}, token = '', client = -1) {
  const critical = method === 'POST' && (endpoint === '/api/results' || /^\/api\/tests\/[^/]+\/start$/.test(endpoint) || /^\/api\/exam-session\/(start|claim|finish|release)$/.test(endpoint));
  const send = async () => C.apiReply(await once(method, endpoint, body, token, client),endpoint);
  const replaySafe=C.apiReplaySafe(method,endpoint,body);
  const reply = await C.requestCapacity(send,undefined,undefined,critical,replaySafe);
  if (!reply.ok) throw Object.assign(Error(reply.code || 'API_ERROR'), {code: reply.code || 'API_ERROR'});
  return reply;
}
async function retry(work, deadline = 240000, exam = false) {
  const started = Date.now(); let state = null;
  for (;;) {
    if(Date.now()-started>=deadline)throw Object.assign(Error('CLIENT_RETRY_BUDGET'), {code:'CLIENT_RETRY_BUDGET'});
    try {return await work();} catch (error) {
      if (!C.retryable(error.code) || Date.now() - started >= deadline) throw error;
      state = C.nextDeliveryRetry(state,error.code);
      const remaining=deadline-(Date.now()-started);
      const delay = Math.min((exam ? C.examRetryDelay : C.deliveryRetryDelay)(state.attempt,error.code),Math.max(1,Math.floor(remaining/3)));
      await pause(delay);
    }
  }
}
async function stage(name, work, people = clients.filter(client => client.session)) {
  phase = name; const started = Date.now();
  const outcomes = await Promise.all(people.map(async client => {const at = Date.now(); try {await work(client); return {client: client.index, ok: true, milliseconds: Date.now() - at};} catch (error) {return {client: client.index, ok: false, code: error.code || error.name, milliseconds: Date.now() - at};}}));
  const item = {name, seconds: Math.round((Date.now() - started) / 1000), clients: people.length, succeeded: outcomes.filter(x => x.ok).length, outcomes};
  phases.push(item); console.log(JSON.stringify({phase: name, clients: people.length, succeeded: item.succeeded, seconds: item.seconds}));
  await fs.writeFile(path.join(out,'phases.json'),JSON.stringify(phases,null,2)+'\n');
  return item;
}
function select(test, index, half = false) {
  return Object.fromEntries(test.questions.slice(0, half ? Math.ceil(test.questions.length / 2) : undefined).map((q, i) => [String(q.id), q.type === 'written' ? 'Синтетична відповідь клієнта ' + index : q.answers.filter(a => a.isCorrect).map(a => String(a.id))]));
}
function startTeacherPoll() {
  teacherPolling = true;
  teacherFlight = (async () => {while (teacherPolling) {await once('GET', '/api/public-table-sync', {}, teacher.token, -1, 'teacher-publication'); if (teacherPolling) await pause(10000);}})();
}
async function stopTeacherPoll() {teacherPolling = false; if (teacherFlight) await teacherFlight; teacherFlight = null;}
async function inspectSandbox() {
  const wire = await transport({action: 'load-test-inspect'}); assert.equal(wire.reply.ok, true); return wire.reply.snapshot;
}
const percentiles = values => {values = values.filter(Number.isFinite).sort((a, b) => a - b); return {count: values.length, p50: values[Math.floor((values.length - 1) * .5)] ?? null, p95: values[Math.floor((values.length - 1) * .95)] ?? null, max: values.at(-1) ?? null};};
const started = Date.now(); let finalSnapshot = null, runError = null, expected = [], publication = null,credentialStorage=null;
try {
  const password = 'Synthetic_' + randomUUID();
  teacher = await rpc('POST', '/api/instructor/register', {fullName: 'Синтетичний Інструктор', username: 'load_teacher_' + state.namespace.slice(6, 14), inviteCode: state.inviteCode, ...await C.credential(password)});
  if(state.testedCandidate){
    const probe=await transport({action:'load-test-credential-check'});assert.equal(probe.reply.ok,true);await trackCacheKeys(probe.reply.loadTestMetrics||{});
    credentialStorage=probe.reply.credentialStorage;await fs.writeFile(path.join(out,'credential-storage.json'),JSON.stringify(credentialStorage,null,2)+'\n');
    assert.equal(credentialStorage.newWriterPreservedCredentials,true);assert.equal(credentialStorage.newCellsLiteral,true);
    if(credentialStorage.legacyRecoverable)assert.equal(credentialStorage.legacyRecovered,true);
  }
  const group = (await rpc('POST', '/api/instructor/groups', {name: 'Контроль Google ' + state.namespace.slice(6, 14)}, teacher.token)).group;
  for (let index = 0; index < state.clients; index++) {
    const username = 'load_' + state.namespace.slice(6, 14) + '_' + index;
    await rpc('POST', '/api/register', {fullName: 'Синтетичний Курсант ' + index, username, groupId: group.id, ...await C.credential(password)});
    clients.push({index, username, account: {pending: [], results: [], run: null}, device: randomUUID()});
  }
  const questions = n => Array.from({length: n}, (_, i) => i >= n - 2 ? {type: 'written', text: 'Синтетичне письмове питання ' + i, maxPoints: 3, rubric: 'Синтетичний критерій'} :
    {text: 'Синтетичне питання ' + i, answers: Array.from({length: 4}, (_, j) => ({text: 'Синтетичний варіант ' + j, isCorrect: j === 0 || i % 3 === 0 && j === 2}))});
  const tests = [];
  for (const [mode, count] of [['training', 50], ['exam', 200]]) {
    const test = (await rpc('POST', '/api/instructor/tests', {title: 'Контроль Google ' + mode, mode, durationMinutes: 30, published: true, accessProtocol: 1, questions: questions(count)}, teacher.token)).test;
    await rpc('POST', '/api/instructor/tests/' + test.id + '/access', {expectedRevision: 1, scope: 'all', open: true}, teacher.token); tests.push(test);
  }
  await stage('login', async client => {client.session = await C.signIn(client.username, password, group.name, (endpoint, body) => rpc('POST', endpoint, body, '', client.index)); await localSave(client);}, clients);
  await stage('workspace', client => retry(() => rpc('GET', '/api/workspace', {}, client.session.token, client.index)));
  const training = tests[0], exam = tests[1];
  await stage('training-start-50', async client => {
    const submissionId = 'pc-' + randomUUID();
    const reply = await retry(() => rpc('POST', '/api/tests/' + training.id + '/start', {submissionId}, client.session.token, client.index));
    client.account.run = {test: reply.test, submissionId, startPermit: reply.startPermit, userId: String(client.session.user.id), answers: {}, index: 0, lastElapsed: 0}; client.trainingRevision = 0; await localSave(client);
  });
  for (let checkpoint = 1; checkpoint <= 2; checkpoint++) {
    await stage('training-checkpoint-' + checkpoint, async client => {
      const run = client.account.run; if (!run) throw Object.assign(Error('NO_START'), {code: 'NO_START'});
      run.answers = select(training, client.index, checkpoint === 1); run.index = checkpoint === 1 ? 24 : 49; run.lastElapsed = checkpoint * 10;
      const body = {key: 'training', expectedRevision: client.trainingRevision, requestId: randomUUID(), value: clone(run)}; await localSave(client);
      const reply = await retry(() => rpc('POST', '/api/account-state/document', body, client.session.token, client.index)); client.trainingRevision = reply.document.revision;
    });
  }
  startTeacherPoll();
  await stage('training-finish-50', async client => {
    const run = client.account.run; if (!run) throw Object.assign(Error('NO_START'), {code: 'NO_START'});
    const answers = select(training, client.index), body = {testId: training.id, submissionId: run.submissionId, startPermit: run.startPermit, writtenProtocol: 1, choiceProtocol: 2, durationSeconds: 30,
      answers: training.questions.map(q => q.type === 'written' ? {questionId: q.id, text: answers[q.id]} : {questionId: q.id, answerIds: answers[q.id]})};
    const item = {body}; client.account.pending.push(item); await localSave(client);
    const reply = await retry(() => rpc('POST', '/api/results', body, client.session.token, client.index)); C.validateResult(reply.result, client.session.user.id, training.id);
    expected.push({id: String(reply.result.id), userId: String(client.session.user.id), test: training, answers}); client.account.results.push(reply.result); client.account.pending = []; client.account.run = null; await localSave(client);
  });
  await stopTeacherPoll();
  await stage('workspace-after-training', client => retry(() => rpc('GET', '/api/workspace', {}, client.session.token, client.index)));
  await stage('exam-start-200', async client => {
    client.account.run = null;
    client.exam = createExamSession({session: () => client.session, account: () => client.account, deviceId: () => client.device,
      rpc: (method, endpoint, body, token) => rpc(method, endpoint, body, token, client.index), persist: () => localSave(client), now: () => performance.now(),
      completed: async reply => {client.account.results.push(reply.result); client.examResult = reply.result;}});
    await retry(() => client.exam.start(exam.id));
  });
  for (let checkpoint = 1; checkpoint <= 2; checkpoint++) {
    await stage('exam-checkpoint-' + checkpoint, async client => {
      if (client.account.run?.examProtocol !== 1) throw Object.assign(Error('NO_START'), {code: 'NO_START'});
      client.account.run.answers = select(exam, client.index, checkpoint === 1); client.account.run.index = checkpoint === 1 ? 99 : 199; await localSave(client);
      await retry(() => client.exam.sync(), 240000, true);
      if(checkpoint===2)await retry(()=>client.exam.discover(),240000,true);
    });
  }
  startTeacherPoll();
  await stage('exam-finish-200', async client => {
    if (!client.exam || client.account.run?.examProtocol !== 1) throw Object.assign(Error('NO_START'), {code: 'NO_START'});
    client.account.run.answers = select(exam, client.index); await localSave(client);
    await retry(() => client.exam.finish(), 240000, true);
    assert.ok(client.examResult); C.validateResult(client.examResult, client.session.user.id, exam.id);
    expected.push({id: String(client.examResult.id), userId: String(client.session.user.id), test: exam, answers: select(exam, client.index)});
  });
  await stopTeacherPoll();
  phase = 'publication-drain';
  const publishStarted=Date.now(),publishUntil=publishStarted+600000;
  publication={budgetSeconds:600,publicRowsAfter180Seconds:null,seconds:null};
  do {
    await rpc('GET', '/api/public-table-sync', {}, teacher.token).catch(() => {});finalSnapshot=await inspectSandbox();
    if(publication.publicRowsAfter180Seconds===null&&Date.now()-publishStarted>=180000)publication.publicRowsAfter180Seconds=finalSnapshot.publicResultIds.length;
    if(expected.every(x=>finalSnapshot.publicResultIds.includes(x.id)))break;
    await pause(3000);
  }while(Date.now()<publishUntil);
  publication.seconds=Math.round((Date.now()-publishStarted)/1000);
  if(publication.publicRowsAfter180Seconds===null)publication.publicRowsAfter180Seconds=finalSnapshot.publicResultIds.length;
  for (const item of expected) {
    const rows = finalSnapshot.privateRows.filter(row => row.id === item.id); assert.equal(rows.length, 1, 'Duplicate or missing result');
    assert.equal(rows[0].userId, item.userId); assert.equal(rows[0].testId, String(item.test.id));
    for (const q of item.test.questions) {
      const stored = rows[0].answers[q.id], wanted = item.answers[q.id];
      assert.deepEqual(q.type === 'written' ? stored : (Array.isArray(stored) ? stored : [String(stored)]).sort(), q.type === 'written' ? wanted : [...wanted].sort(), 'Answer mismatch');
    }
  }
  const pairs = new Set();
  for (const row of finalSnapshot.privateRows) {const key = row.userId + ':' + row.testId; assert.ok(!pairs.has(key), 'Duplicate account/test result'); pairs.add(key);}
} catch (error) {runError = error.code || error.message || error.name;}
finally {
  await stopTeacherPoll();
  await fs.writeFile(path.join(scratch, 'cache-keys.json'), JSON.stringify([...cacheKeys]), {mode: 0o600});
  const summaries = {};
  for (const name of new Set(calls.map(row => row.phase))) {
    const rows = calls.filter(row => row.phase === name);
    summaries[name] = {requests: rows.length, codes: Object.fromEntries([...new Set(rows.map(row => row.code))].map(code => [code, rows.filter(row => row.code === code).length])),
      roundTripMs: percentiles(rows.map(row => row.milliseconds)), serverMs: percentiles(rows.map(row => row.serverMilliseconds)),
      lockWaitMs: percentiles(rows.map(row => row.lockWaitMilliseconds)), lockHeldMs: percentiles(rows.map(row => row.lockHeldMilliseconds))};
  }
  const report = {status: runError ? 'test_error' : 'completed', runError, actualGoogleServer: true, isolatedSyntheticData: true, productionDataWrites: 0,
    sharedGoogleAccountAndScriptLock: true, sourceVersion: C.APP_VERSION, clients: state.clients, authenticated: clients.filter(c => c.session).length,
    testedCandidate:state.testedCandidate===true,credentialStorage,
    seconds: Math.round((Date.now() - started) / 1000), peakActiveHTTP: peakActive, phases, summaries, publication,
    findings: {busyResponses: calls.filter(row => row.code === 'BUSY').length, googleQuotaResponses: calls.filter(row => row.category === 'GOOGLE_QUOTA_OR_CONCURRENCY').length,
      timeouts: calls.filter(row => row.code === 'TIMEOUT').length,signingKeyFingerprints:new Set(calls.map(row=>row.signingKeyFingerprint).filter(Boolean)).size, phaseFailures: phases.reduce((n, p) => n + p.clients - p.succeeded, 0)},
    results: {target: state.clients * 2, acknowledged: expected.length, authoritative: finalSnapshot?.privateRows.length ?? null, publicRows: finalSnapshot?.publicResultIds.length ?? null,
      answersVerifiedForAcknowledgedResults: !runError && !!finalSnapshot, pendingOnClients: clients.reduce((n, c) => n + c.account.pending.length + Number(!!c.account.run?.finishRequested), 0)}};
  await fs.writeFile(path.join(out, 'summary.json'), JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify({status: report.status, findings: report.findings, results: report.results}));
  if (runError) process.exitCode = 1;
}
