import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {chromium} from 'playwright';

const parser = fs.readFileSync(new URL('../web/office-import.js', import.meta.url));
const samples = ['sample.docx', 'sample.xlsx'].map(name => ({name, bytes: [...fs.readFileSync(new URL('fixtures/office/' + name, import.meta.url))]}));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; connect-src 'self'");
  if (req.url === '/office-import.js') {res.setHeader('Content-Type', 'text/javascript'); res.end(parser);}
  else res.end('<!doctype html><meta charset="utf-8"><title>Isolated Office fuzz</title>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
  browser = await chromium.launch({headless: true, args: ['--no-sandbox'], executablePath: process.env.LITAKOVA_CHROMIUM_EXECUTABLE});
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + server.address().port);
  const report = await page.evaluate(async samples => {
    const {importOffice} = await import('/office-import.js');
    let seed = 20261125, rejected = 0, acceptedMutations = 0, maxMs = 0, variants = 0;
    const random = n => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n);
    const check = async (sample, input, mustReject) => {
      const started = performance.now(); let result;
      try { result = await importOffice(sample.name, input); }
      catch (error) { if (!error.message) throw Error('Missing import error'); rejected++; }
      if (result) {
        if (mustReject) throw Error('A truncated or random file was accepted');
        if (!Array.isArray(result.questions) || result.questions.length < 1 || result.questions.length > 200) throw Error('Invalid imported question count');
        if (result.questions.some(q => typeof q.text !== 'string' || !Array.isArray(q.answers) || q.answers.length > 6)) throw Error('Invalid imported structure');
        if (JSON.stringify(result.questions) !== sample.expectedQuestions) throw Error('A damaged file silently changed questions');
        acceptedMutations++;
      }
      variants++; maxMs = Math.max(maxMs, performance.now() - started);
    };
    for (const sample of samples) {
      const original = Uint8Array.from(sample.bytes);
      sample.expectedQuestions = JSON.stringify((await importOffice(sample.name, original)).questions);
      for (let i = 0; i < 300; i++) await check(sample, original.slice(0, random(original.length)), true);
      for (let i = 0; i < 300; i++) {
        const damaged = original.slice();
        for (let j = 0, n = 1 + random(8); j < n; j++) damaged[random(damaged.length)] ^= 1 + random(255);
        await check(sample, damaged, false);
      }
      for (let i = 0; i < 200; i++) await check(sample, Uint8Array.from({length: random(3000)}, () => random(256)), true);
      const clean = await importOffice(sample.name, original);
      if (clean.questions.length !== 3) throw Error('Valid import failed after damaged inputs');
    }
    return {status: 'passed', kind: 'actual_chromium_office_parser_mutations', seed: 20261125,
      variants, rejected, acceptedMutations, acceptedMutationsPreserveQuestions: true, validFilesRetested: samples.length, maxVariantMs: Math.round(maxMs), productionWrites: false};
  }, samples);
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.equal(report.variants, 1600); assert.equal(report.rejected + report.acceptedMutations, report.variants);
  fs.mkdirSync(new URL('../verification/stress/', import.meta.url), {recursive: true});
  fs.writeFileSync(new URL('../verification/stress/global-office-fuzz.json', import.meta.url), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
