'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createEmailService}=require('../apps/emails/core/email-service');
const {parse}=require('../apps/emails/core/chat-transactional-auth');
(async()=>{
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'email-otp-inbox-'));const sent=[];
 try{
  const s=createEmailService({dataDir:path.join(d,'mail'),vipPath:path.join(d,'vip.json'),sendmail:(m,cb)=>{sent.push(m);cb(null,'ok')}});
  const msg=parse({to:'test@egytag.com',subject:'Chat Live code',text:'123456',html:'<h1>123456</h1>'});
  await s.send(msg);
  assert.equal(sent.length,1);assert.equal(sent[0].html,'<h1>123456</h1>');
  const find=()=>s.search({toExact:'test@egytag.com',folder:'inbox'},{domain:'egytag.com'});
  const unified=()=>s.unifiedMailboxMessages(['test@egytag.com'],{domain:'egytag.com'});
  const status=()=>s.mailboxStatuses(['test@egytag.com'],{domain:'egytag.com'});
  assert.equal((await find()).messages.length,0);
  assert.equal((await unified()).count,0);
  assert.equal((await status()).items[0].count,0);
  await s.ingestIncoming({guid:'incoming',from:'chat@egytag.com',to:'test@egytag.com',subject:msg.subject,text:msg.text,html:msg.html});
  assert.equal((await find()).messages.length,1);
  assert.equal((await unified()).count,1);
  assert.equal((await status()).items[0].count,1);
  console.log('CHAT_OTP_INBOX_FILTER_PASS');
 }finally{fs.rmSync(d,{recursive:true,force:true})}
})().catch(e=>{console.error(e);process.exitCode=1});
