'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
const {allowed,parse,FROM}=require('../apps/emails/core/chat-transactional-auth');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'chat-transactional-'));
try{
 const keyPath=path.join(dir,'localStorage','keys','chat-live.key');
 fs.mkdirSync(path.dirname(keyPath),{recursive:true});
 const key=crypto.randomBytes(48).toString('hex');fs.writeFileSync(keyPath,key,{mode:0o600});
 assert.equal(allowed({headers:{authorization:'Bearer '+key}},dir),true);
 for(const value of ['',key+'1','wrong',key.slice(0,-1)]){
  assert.equal(allowed({headers:{authorization:'Bearer '+value}},dir),false);
 }
 assert.equal(parse({to:'valid@example.test',subject:'Verify',text:'Hello'}).from,FROM);
 for(const bad of [{to:'foo',subject:'Hi',text:'Hi'},{to:'a@example.org',subject:'Bad\nheader',text:'Hi'},{to:'a@example.org',subject:'Hi',text:'Hi',from:'admin@example.org'}]){
  assert.throws(()=>parse(bad));
 }
 assert.equal(parse({to:'valid@example.test',subject:'Verify',text:'Hello'}).listUnsubscribe,false);
 assert.equal(parse({to:'valid@example.test',subject:'Verify',text:'Hello',html:'<div style="color:#123">Hello</div>'}).html.includes('<div'),true);
 for(const payload of ['<script>alert(1)</script>','<img src="x" onerror="alert(1)">','<a href="javascript:bad()">Click</a>']){
  assert.throws(()=>parse({to:'valid@example.test',subject:'Verify',text:'Hello',html:payload}),/UNSAFE_HTML/);
 }
 assert.throws(()=>parse({to:'valid@example.test',subject:'Verify',text:'Hello',html:'x'.repeat(55001)}),/INVALID_HTML/);
 console.log('CHAT_TRANSACTIONAL_AUTH_PASS');
}finally{fs.rmSync(dir,{recursive:true,force:true})}
