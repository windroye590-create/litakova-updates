import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
process.env.LITAKOVA_SERVER_SOURCE = process.env.LITAKOVA_OPT_SERVER_SOURCE || new URL('../Code.gs', import.meta.url).pathname;
const {context, api, credential, instructorToken} = await import('./fixtures/server_model.mjs');
const checks = [], measurements = {};
const check = (name, fn) => { fn(); checks.push(name); console.log('PASS ' + name); };
const group = api('POST', '/api/instructor/groups', instructorToken, {name: 'Ізольована глобальна оптимізація'}).group;
const cadet = api('POST', '/api/register', '', {username: 'global-performance-owner', fullName: 'Синтетичний Курсант', groupId: group.id, ...credential('synthetic-performance-password')});
const users = context.sheet_('users'), cache = context.CacheService.getScriptCache();
for (let i = 0; i < 3000; i++) users.appendRow(['synthetic-extra-' + i, 'synthetic-login-' + i, 'Синтетичний ' + i, group.name, 'cadet', '', '', true, '', '']);
const proto = Object.getPrototypeOf(users.getRange(1, 1)), get = proto.getValues, set = proto.setValues;
let capture = null;
proto.getValues = function() { if (capture && this.sheet === users) {capture.userReads++; capture.userCells += this.rowCount * this.columnCount;} return get.call(this); };
proto.setValues = function(value) {if (capture && this.row === 1) capture.headerWrites++; return set.call(this, value);};
function measure(name, fn) {capture = {userReads: 0, userCells: 0, headerWrites: 0}; try {fn(); measurements[name] = capture;} finally {capture = null;} }
const key = id => 'LK_USER_ROW_V1_' + context.sha256Hex_(String(id));
const request = (body = {}) => {
  const reply = JSON.parse(context.doPost({postData: {contents: JSON.stringify({action: 'api', method: 'GET', path: '/api/workspace', token: cadet.token, body, writtenProtocol: 1, choiceProtocol: 2, deliveryProtocol: 1})}}).text);
  assert.equal(reply.ok, true, reply.error); return reply;
};
try {
  cache.remove(key(cadet.user.id));
  measure('coldAuthentication', () => assert.equal(String(context.requireSession_(cadet.token).id), String(cadet.user.id)));
  measure('warmAuthentication', () => assert.equal(String(context.requireSession_(cadet.token).id), String(cadet.user.id)));
  measure('coldLoginLookup', () => assert.equal(String(context.findUserByUsername_(cadet.user.username, '').id), String(cadet.user.id)));
  measure('warmLoginLookup', () => assert.equal(String(context.findUserByUsername_(cadet.user.username, '').id), String(cadet.user.id)));
  const first = request();
  measure('fourUnchangedWorkspaces', () => {for (let i = 0; i < 4; i++) assert.deepEqual(request({known: first.revisions}).changes, {});});
  const cached = new Map(cache.values); cache.values.clear();
  measure('coldSchema', () => context.ensureSchema_(false));
  cache.values = new Map([...cached, ...cache.values]);
  if (!process.argv.includes('--benchmark-only')) {
    check('Warm authentication reads one current identity row instead of every account', () => {
      assert.equal(measurements.warmAuthentication.userCells, 9);
      assert.equal(measurements.warmLoginLookup.userCells, 9);
      assert.ok(measurements.coldAuthentication.userCells < users.getLastRow() + 20);
      assert.ok(measurements.fourUnchangedWorkspaces.userCells < 100);
      const hint = JSON.parse(cache.get(key(cadet.user.id))); assert.deepEqual(Object.keys(hint), ['row']);
    });
    check('A cold schema verifies existing headers without rewriting them', () => assert.equal(measurements.coldSchema.headerWrites, 0));
    check('Stale, foreign and out-of-bounds row hints cannot select another account', () => {
      for (const hint of [{row: 2}, {row: users.getLastRow() + 100}, {row: -1}, {row: '2'}, null]) {
        cache.put(key(cadet.user.id), JSON.stringify(hint));
        assert.equal(String(context.requireSession_(cadet.token).id), String(cadet.user.id));
      }
      users.insertRowsAfter(users.getMaxRows(), 1);
      users.rows.splice(1, 0, ['synthetic-temporary-row', 'temporary', 'Temporary', '', 'cadet', '', '', true, '']);
      const owner = context.findUserById_(cadet.user.id), row = users.rows[owner.rowNumber - 1];
      users.deleteRow(2);
      assert.equal(String(context.requireSession_(cadet.token).id), String(cadet.user.id));
      assert.equal(context.findUserById_(cadet.user.id).fullName, row[2]);
    });
    check('Name, disabled status, role and credentials are always read from the live row', () => {
      const owner = context.findUserById_(cadet.user.id), row = users.rows[owner.rowNumber - 1], before = row.slice();
      row[2] = 'Новий актуальний ПІБ'; assert.equal(context.requireSession_(cadet.token).fullName, row[2]);
      for (const [column, value] of [[7, false], [4, 'instructor'], [5, 'Changed credential']]) {
        row[column] = value; assert.throws(() => context.requireSession_(cadet.token), error => error.code === 'SESSION_EXPIRED'); row.splice(0, row.length, ...before);
      }
      assert.equal(String(context.requireSession_(cadet.token).id), String(cadet.user.id));
    });
    check('Cache read/write failures preserve authentication and no missing identity is cached', () => {
      const read = cache.get, write = cache.put;
      cache.get = function(k) {if (k.startsWith('LK_USER_')) throw Error('Synthetic cache unavailable'); return read.call(this, k);};
      cache.put = function(k, ...rest) {if (k.startsWith('LK_USER_')) throw Error('Synthetic cache unavailable'); return write.call(this, k, ...rest);};
      try {assert.equal(String(context.requireSession_(cadet.token).id), String(cadet.user.id)); assert.equal(String(context.findUserByUsername_(cadet.user.username, '').id), String(cadet.user.id)); assert.equal(context.findUserById_('not-an-account'), null);}
      finally {cache.get = read; cache.put = write;}
    });
    check('A row move between the narrow index scan and identity read uses a fresh atomic fallback', () => {
      const owner = context.findUserById_(cadet.user.id), before = owner.rowNumber - 1;
      cache.put(key(cadet.user.id), JSON.stringify({row: 2}));
      const read = proto.getValues; let moved = false;
      proto.getValues = function() {
        const value = read.call(this);
        if (!moved && this.sheet === users && this.column === 1 && this.columnCount === 1 && this.rowCount > 1) {
          moved = true; [users.rows[before], users.rows[before + 1]] = [users.rows[before + 1], users.rows[before]];
        }
        return value;
      };
      try {assert.equal(String(context.requireSession_(cadet.token).id), String(cadet.user.id)); assert.equal(moved, true);}
      finally {proto.getValues = read;}
    });
    check('Login hints validate current spelling, group, password salt and row position', () => {
      const owner = context.findUserById_(cadet.user.id), row = users.rows[owner.rowNumber - 1], old = row.slice();
      const loginKey = 'LK_USER_LOGIN_V1_' + context.sha256Hex_(JSON.stringify([context.normalize_(cadet.user.username), '']));
      cache.put(loginKey, JSON.stringify({row: 2})); assert.equal(String(context.findUserByUsername_(cadet.user.username, '').id), String(cadet.user.id));
      row[6] = 'CURRENT_SALT'; assert.equal(context.findUserByUsername_(cadet.user.username, '').passwordSalt, 'CURRENT_SALT');
      assert.equal(context.findUserByUsername_(cadet.user.username, 'Not the current group'), null);
      row[1] = 'renamed-login'; assert.equal(context.findUserByUsername_(cadet.user.username, ''), null);
      assert.equal(String(context.findUserByUsername_('RENAMED-LOGIN', '').id), String(cadet.user.id)); row.splice(0, row.length, ...old);
    });
    check('Missing and damaged private headers are repaired, with explicit maintenance still available', () => {
      const target = context.sheet_('answerChanges'), header = target.rows[0].slice();
      target.rows[0][0] = 'Synthetic damaged header'; cache.values.clear(); context.ensureSchema_(false); assert.deepEqual(target.rows[0], header);
      measure('forcedSchema', () => context.ensureSchema_(true, true)); assert.ok(measurements.forcedSchema.headerWrites > 0);
    });
  }
} finally {proto.getValues = get; proto.setValues = set;}
const report = {status: 'passed', benchmarkOnly: process.argv.includes('--benchmark-only'), syntheticAdditionalUsers: 3000, passed: checks.length, checks, measurements,
  sourceSHA256: crypto.createHash('sha256').update(fs.readFileSync(process.env.LITAKOVA_SERVER_SOURCE)).digest('hex'), productionRequests: 0, liveGoogleTimingMeasured: false};
fs.writeFileSync(process.env.LITAKOVA_OPT_REPORT || new URL('../verification/global-optimization.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
