'use strict';
const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const EventEmitter=require('events');
const {OfficialInboxTriage,classify}=require('../apps/emails/core/official-inbox-triage');
(async()=>{
const root=fs.mkdtempSync(path.join(os.tmpdir(),'official-inbox-'));
const events=new EventEmitter();
const mock={subscribe(fn){events.on('event',fn);return()=>events.off('event',fn);}};
const triage=new OfficialInboxTriage({emailService:mock,baseDir:root}).start();
try {
assert.equal(classify({to:'random@social-browser.com',from:'x@example.com',subject:'hello'}),null);
assert.equal(classify({to:'info@social-browser.com',from:'noreply@example.com',subject:'verification code'}).category,'automated');
assert.equal(classify({to:'support@social-browser.com',from:'client@example.com',subject:'Urgent support issue'}).priority,'high');
events.emit('event',{type:'incoming',message:{guid:'a',to:'support@social-browser.com',from:'client@example.com',subject:'Urgent support issue'}});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(triage.list().total,1);
assert.equal(triage.list().items[0].status,'needs_reply');
events.emit('event',{type:'incoming',message:{guid:'a',to:'support@social-browser.com',from:'client@example.com',subject:'Urgent support issue'}});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(triage.list().total,1);
events.emit('event',{type:'incoming',message:{guid:'b',to:'info@egytag.com',from:'no-reply@system.com',subject:'Verification code'}});
await new Promise(resolve=>setImmediate(resolve));
assert.equal(triage.list().total,2);
assert.equal(triage.list({status:'ignored'}).total,1);
triage.stop();
console.log('Official inbox triage passed');
}finally{fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
