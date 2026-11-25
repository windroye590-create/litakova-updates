import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

process.env.LITAKOVA_SERVER_SOURCE = new URL('../Code.gs', import.meta.url).pathname;
const {context, instructorToken, credential} = await import('./fixtures/server_model.mjs');
let requests = 0, snapshots = 0, rejectedWrites = 0, transitions = 0;
const raw = (method, path, token, body = {}) => {
  requests++;
  return JSON.parse(context.doPost({postData: {contents: JSON.stringify({
    action: 'api', method, path, token, body, writtenProtocol: 1, choiceProtocol: 2, deliveryProtocol: 1,
  })}}).text);
};
const api = (...args) => {
  const reply = raw(...args);
  assert.equal(reply.ok, true, reply.code + ': ' + reply.error);
  return reply;
};
const uuid = () => crypto.randomUUID();
const clone = value => JSON.parse(JSON.stringify(value));
const report = {status: 'running', kind: 'isolated_randomized_api_state_machine', seeds: [271828, 314159], works: 0,
  productionRequests: 0, independentScoringOracle: true, sourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(new URL('../Code.gs', import.meta.url))).digest('hex')};
const started = performance.now();
for (const initialSeed of report.seeds) {
  let seed = initialSeed;
  const random = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
  const group = api('POST', '/api/instructor/groups', instructorToken, {name: 'Ізольований аудит ' + initialSeed}).group;
  const person = api('POST', '/api/register', '', {username: 'global-audit-' + initialSeed, fullName: 'Синтетичний Курсант ' + initialSeed,
    groupId: group.id, ...credential('synthetic-audit-password')});
  const stranger = api('POST', '/api/register', '', {username: 'global-outsider-' + initialSeed, fullName: 'Інший Синтетичний Курсант',
    groupId: group.id, ...credential('synthetic-audit-password')});
  for (let work = 0; work < 20; work++) {
    const questions = Array.from({length: 2 + random(19)}, (_, i) => {
      const base = {text: 'Синтетичне питання ' + i, maxPoints: [1, 3, 10, 100][random(4)], explanation: 'PRIVATE_EXPLANATION'};
      if (i === 1 || (i > 1 && random(3) === 0)) return {...base, type: 'written', rubric: 'PRIVATE_RUBRIC'};
      const two = random(2) === 0;
      return {...base, answers: Array.from({length: 4}, (_, j) => ({text: 'Варіант ' + j, isCorrect: j === 0 || (two && j === 2)}))};
    });
    const test = api('POST', '/api/instructor/tests', instructorToken, {title: 'Випадкове оцінювання ' + initialSeed + ':' + work,
      mode: 'training', published: true, passingPercent: 1 + random(100), accessProtocol: 1, questions}).test;
    api('POST', '/api/instructor/tests/' + test.id + '/access', instructorToken, {expectedRevision: 1, scope: 'all', open: true});
    const submissionId = 'pc-' + uuid();
    const run = api('POST', '/api/tests/' + test.id + '/start', person.token, {submissionId});
    const chosen = {}, grades = {};
    for (const q of test.questions) chosen[q.id] = q.type === 'written' ? '=Первинна відповідь 🛩️ ' + random(100) : q.answers.filter(() => random(3) === 0).slice(0, 2).map(a => String(a.id));
    const original = clone(chosen);
    const body = {testId: test.id, submissionId, startPermit: run.startPermit, durationSeconds: 1 + random(3000), writtenProtocol: 1, choiceProtocol: 2,
      answers: test.questions.map(q => q.type === 'written' ? {questionId: q.id, text: chosen[q.id]} : {questionId: q.id, answerIds: chosen[q.id]})};
    // A closed gate must preserve the already issued attempt, but reject a new start.
    api('POST', '/api/instructor/tests/' + test.id + '/access', instructorToken, {expectedRevision: 2, scope: 'all', open: false});
    assert.equal(raw('POST', '/api/tests/' + test.id + '/start', stranger.token, {submissionId: 'pc-' + uuid()}).code, 'TEST_CLOSED');
    let result = api('POST', '/api/results', person.token, body).result;
    const identity = Object.fromEntries(['id', 'userId', 'testId', 'completedAt', 'durationSeconds', 'total'].map(k => [k, result[k]]));
    const path = '/api/instructor/results/' + result.id;
    const record = () => context.resultRecordById_(result.id);
    const assertState = () => {
      // Deliberately calculate from independent sets and grade maps, not application helpers.
      let earned = 0, maximum = 0, correct = 0, choiceCount = 0, pending = 0;
      for (const q of test.questions) {
        maximum += q.maxPoints;
        if (q.type === 'written') { if (Object.hasOwn(grades, q.id)) earned += grades[q.id]; else pending++; }
        else {
          choiceCount++;
          const expected = new Set(q.answers.filter(a => a.isCorrect).map(a => String(a.id)));
          if (chosen[q.id].length === expected.size && chosen[q.id].every(id => expected.has(id))) { correct++; earned += q.maxPoints; }
        }
      }
      const score = pending ? null : Math.round(100 * earned / maximum);
      const expected = {correct, earnedPoints: earned, maxPoints: maximum, choiceTotal: choiceCount, pendingWritten: pending,
        score, passed: pending ? null : score >= test.passingPercent, gradingStatus: pending ? 'pending_review' : 'graded'};
      for (const [key, value] of Object.entries({...identity, ...expected})) assert.equal(result[key], value, initialSeed + ':' + work + ':' + transitions + ':' + key);
      const stored = JSON.parse(record().row[13]);
      for (const q of test.questions) assert.deepEqual(q.type === 'written' ? stored[q.id] : (Array.isArray(stored[q.id]) ? stored[q.id] : stored[q.id] === '0' ? [] : [stored[q.id]]).sort(), q.type === 'written' ? chosen[q.id] : [...chosen[q.id]].sort());
      snapshots++;
    };
    assertState();
    for (let step = 0; step < 12; step++) {
      const before = JSON.stringify(record().row);
      const forbidden = raw('POST', path + '/answers', stranger.token, {requestId: uuid(), expectedRevision: result.gradingRevision,
        reason: 'PRIVATE_REASON', changes: [{questionId: test.questions[0].id, answerIds: []}]});
      assert.equal(forbidden.code, 'FORBIDDEN');
      const stale = raw('POST', path + '/answers', instructorToken, {requestId: uuid(), expectedRevision: result.gradingRevision + 1,
        reason: 'PRIVATE_REASON', changes: [{questionId: test.questions[0].id, answerIds: []}]});
      assert.equal(stale.code, 'REVISION_CONFLICT');
      assert.equal(JSON.stringify(record().row), before); rejectedWrites += 2;
      if (step % 3 === 0) {
        const items = test.questions.filter(q => q.type === 'written').map(q => ({questionId: q.id, points: random(q.maxPoints + 1), comment: 'CADET_FEEDBACK'}));
        const gradeBody = {requestId: uuid(), expectedRevision: result.gradingRevision, grades: items, finalize: true};
        result = api('POST', path + '/grade', instructorToken, gradeBody).result;
        for (const g of items) grades[g.questionId] = g.points;
        const replay = api('POST', path + '/grade', instructorToken, gradeBody).result;
        assert.equal(replay.gradingRevision, result.gradingRevision);
      } else {
        const q = step % 3 === 1 ? test.questions[0] : test.questions.filter(q => q.type === 'written')[random(test.questions.filter(q => q.type === 'written').length)];
        const value = q.type === 'written' ? 'Нове виправлення 🛩️ ' + step : chosen[q.id].length ? [] : [String(q.answers[random(q.answers.length)].id)];
        const edit = {requestId: uuid(), expectedRevision: result.gradingRevision, reason: 'PRIVATE_REASON: синтетичний аудит',
          changes: [q.type === 'written' ? {questionId: q.id, text: value} : {questionId: q.id, answerIds: value}]};
        const reply = api('POST', path + '/answers', instructorToken, edit); result = reply.result;
        chosen[q.id] = value; if (q.type === 'written') delete grades[q.id];
        const after = JSON.stringify(record().row);
        assert.equal(api('POST', path + '/answers', instructorToken, edit).result.gradingRevision, result.gradingRevision);
        const conflict = raw('POST', path + '/answers', instructorToken, {...edit, reason: 'PRIVATE_REASON: змінений повтор'});
        assert.equal(conflict.code, 'REQUEST_CONFLICT'); assert.equal(JSON.stringify(record().row), after); rejectedWrites++;
        for (const question of test.questions) {
          const saved = reply.originalAnswers[question.id], expected = original[question.id];
          assert.deepEqual(question.type === 'written' ? saved : (Array.isArray(saved) ? saved : saved === '0' ? [] : [saved]).sort(), question.type === 'written' ? expected : [...expected].sort());
        }
      }
      assertState(); transitions++;
      const own = api('GET', '/api/results/' + result.id + '/review', person.token);
      assert.ok(!/PRIVATE_REASON/.test(JSON.stringify(own)), 'Private correction reason leaked');
      if (result.pendingWritten) assert.ok(!/PRIVATE_RUBRIC/.test(JSON.stringify(own)), 'Unreleased rubric leaked');
      for (const answer of own.review.filter(q => q.type === 'written')) {
        assert.equal(answer.comment, Object.hasOwn(grades, answer.questionId) ? 'CADET_FEEDBACK' : '');
      }
      assert.equal(raw('GET', '/api/results/' + result.id + '/review', stranger.token).code, 'FORBIDDEN');
    }
    assert.equal(api('POST', '/api/results', person.token, body).result.id, identity.id);
    assert.equal(context.dataRows_('results').filter(row => String(row[0]) === String(identity.id)).length, 1);
    report.works++;
  }
  console.log('PASS independent scoring, corrections, original history, revisions and ownership; seed=' + initialSeed);
}
Object.assign(report, {status: 'passed', transitions, scoringSnapshots: snapshots, rejectedWrites, requests, seconds: Math.round(performance.now() - started) / 1000});
fs.mkdirSync(new URL('../verification/stress/', import.meta.url), {recursive: true});
fs.writeFileSync(new URL('../verification/stress/global-state-machine.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
