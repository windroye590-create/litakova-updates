// A locked account keeps its persisted work, but no unlocked screen data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const app=fs.readFileSync(new URL('../web/app.js',import.meta.url),'utf8');
const start=app.indexOf('function resetSessionViews('),end=app.indexOf('\nfunction ',start);assert.ok(start>=0&&end>start);
const privateAccount={draft:{title:'Keep the persisted work'},pending:[{answer:'Keep this answer'}]};
const box={bank:[{question:'Private bank'}],audit:[{name:'Private actor'}],analytics:{attempts:17},preview:{answer:'Private preview'},lastResult:{answer:'Previous cadet'},grading:{answer:'Previous instructor'},filter:'Private search',menuOpen:true,reviewQueue:[{answer:'Private review'}],examRecoveryQueue:[{answer:'Private recovery'}],reviewQueueFlight:{},reviewQueueToken:'previous',reviewQueueUpdatedAt:1,reviewQueueAt:1,reviewQueueRevision:'old',reviewQueueError:'Private message',loadAnalytics:{flight:{},error:'Private message'},instructorRequests:new Map([['token',{name:'Private actor'}]]),listPages:{bank:5,cadets:2},materials:{reset(){box.pdfReset=true;}},modal:{innerHTML:'Private modal',close(){box.modalClosed=true;}},S:{accounts:{owner:privateAccount}}};
vm.createContext(box);vm.runInContext(app.slice(start,end),box);box.resetSessionViews();
for(const field of ['bank','audit','reviewQueue','examRecoveryQueue'])assert.equal(box[field].length,0,field);
for(const field of ['analytics','preview','lastResult','grading','reviewQueueFlight','reviewQueueRevision'])assert.equal(box[field],null,field);
for(const field of ['filter','reviewQueueToken','reviewQueueError'])assert.equal(box[field],'',field);
assert.equal(box.loadAnalytics.flight,null);assert.equal(box.loadAnalytics.error,'');assert.equal(box.instructorRequests.size,0);assert.equal(Object.keys(box.listPages).length,0);
assert.equal(box.pdfReset,true);assert.equal(box.modalClosed,true);assert.equal(box.modal.innerHTML,'');assert.equal(box.menuOpen,false);
assert.equal(box.S.accounts.owner,privateAccount);assert.equal(privateAccount.draft.title,'Keep the persisted work');assert.equal(privateAccount.pending[0].answer,'Keep this answer');
console.log('PASS Locking a session clears every transient private screen and cancels stale view requests');
console.log('PASS Clearing session views preserves persisted drafts and unsent answers');
fs.mkdirSync(new URL('../verification/',import.meta.url),{recursive:true});fs.writeFileSync(new URL('../verification/session-views.json',import.meta.url),JSON.stringify({status:'passed',passed:2,actualApplicationFunction:true,productionRequests:0},null,2));
