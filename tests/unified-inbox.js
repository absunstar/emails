'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createEmailService} = require('../apps/emails/core/email-service');
(async()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),'unified-inbox-'));
 try {
  const service=createEmailService({dataDir:path.join(temp,'emails'),vipPath:path.join(temp,'vip.json'),sendmail:(m,cb)=>cb(null,'ok')});
  const base='2026-10-31T10:';
  for(const [guid,to,subject,time] of [['first','alpha@egytag.com','Welcome','01'],['second','beta@egytag.com','Your verification code is 234567','03'],['both','alpha@egytag.com,beta@egytag.com','Shared','02'],['outside','other@another.test','Other domain','04'],['official','info@egytag.com','Official','05']]){
   await service.ingestIncoming({guid,to,from:'tester@example.net',subject,text:'test only',date:base+time+':00.000Z'});
  }
  await service.setVip({email:'private@egytag.com',vip:true});
  await service.ingestIncoming({guid:'private',to:'private@egytag.com',from:'tester@example.net',subject:'VIP',text:'test',date:base+'06:00.000Z'});
  const result=await service.unifiedMailboxMessages(['alpha@egytag.com','beta@egytag.com','info@egytag.com','private@egytag.com'],{domain:'egytag.com',allowVip:false});
  assert.equal(result.count,3);
  assert.equal(result.messages.map(x=>x.guid).join(','),'second,both,first');
  assert(result.messages.every(x=>['alpha@egytag.com','beta@egytag.com'].includes(x.mailbox)));
  assert(result.messages.every(x=>!x.text&&!x.html));
  assert.equal((await service.unifiedMailboxMessages(['alpha@egytag.com'],{domain:'egytag.com',limit:1})).count,1);
  assert.equal((await service.unifiedMailboxMessages(['alpha@egytag.com'],{domain:'another.test'})).count,0);
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
 const app=fs.readFileSync('apps/emails/app.js','utf8');
 const client=fs.readFileSync('apps/emails/site_files/js/index.js','utf8');
 const html=fs.readFileSync('apps/emails/site_files/html/free.html','utf8');
 assert(app.includes("onPost('/api/emails/inboxes/unified'"),'Dedicated grouped request required');
 assert(app.includes('isProOnlyMailbox(value)'),'Do not include protected mobile Pro mailboxes');
 assert(app.includes("!['info@egytag.com', 'support@egytag.com'].includes(value)"),'Do not include official mailboxes in public aggregated requests');
 assert(app.includes('allowVip: false'),'No VIP message metadata in combined inbox');
 for(const action of ['show-unified-inbox','show-current-inbox','dismiss-unified-tip']) assert(html.includes('data-action="'+action+'"'));
 assert(html.includes('data-unified-tip hidden role="note"'));
 assert(client.includes('state.addressBook.addresses.length >= 2'),'Hint must wait until multiple saved addresses');
 assert(client.includes("localStorage.setItem(unifiedTipKey(), '1')"),'Hint dismissal must persist');
 assert(client.includes("/api/emails/inboxes/unified"));
 assert(client.includes('listed?.mailbox || state.currentWhere?.to'),'Open message with the address receiving it');
 assert(client.includes("trackQuickMailEvent('temp_mail_unified_inbox_opened')"));
 console.log('Unified Inbox indexed aggregation, deduplication, protected-mail isolation, discoverability and active mailbox routing PASS');
})().catch(error=>{console.error(error.stack);process.exitCode=1});
