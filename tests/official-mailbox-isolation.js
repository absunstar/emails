'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createEmailService}=require('../apps/emails/core/email-service');
const app=fs.readFileSync('apps/emails/app.js','utf8');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'official-isolation-'));
 try{
  const svc=createEmailService({dataDir:path.join(dir,'mail'),vipPath:path.join(dir,'vip.json'),sendmail:(message,callback)=>callback(null,'queued')});
  await svc.ingestIncoming({guid:'official-fixture',from:'client@example.com',to:'info@egytag.com',subject:'Confidential enquiry',text:'Private official message',date:new Date().toISOString()});
  await svc.ingestIncoming({guid:'normal-fixture',from:'client@example.com',to:'demo@egytag.com',subject:'Hello',text:'Public temporary email',date:new Date().toISOString()});
  assert(svc.isOfficialMessage({to:'info@egytag.com'}));
  assert(svc.isOfficialMessage({to:'support@egytag.com'}));
  assert(!svc.isOfficialMessage({to:'someone@egytag.com'}));
  const publicCtx={domain:'egytag.com',allowVip:true};
  const list=await svc.search({limit:20},publicCtx);
  assert.equal(list.messages.length,1);
  assert.equal(list.messages[0].guid,'normal-fixture');
  const targeted=await svc.search({toExact:'info@egytag.com',limit:10,includeBody:true},publicCtx);
  assert.equal(targeted.messages.length,0);
  await assert.rejects(svc.read('official-fixture',publicCtx),/VIP email access is required/);
  const many=await svc.readMany(['normal-fixture','official-fixture'],publicCtx);
  assert.equal(many.messages.length,1);
  const statuses=await svc.mailboxStatuses(['info@egytag.com','demo@egytag.com'],publicCtx);
  assert.equal(statuses.items[0].count,0);
  assert.equal(statuses.items[0].protected,true);
  assert.equal(statuses.items[1].count,1);
  await assert.rejects(svc.exportEml('official-fixture',publicCtx));
  const adminCtx={domain:'egytag.com',allowVip:true,isAdmin:true};
  const adminList=await svc.search({toExact:'info@egytag.com',limit:10},adminCtx);
  assert.equal(adminList.messages.length,1);
  assert.equal((await svc.read('official-fixture',adminCtx)).message.subject,'Confidential enquiry');
  assert(app.includes('if (service.isOfficialMessage(event.message)) return;'),'SSE must not broadcast official messages');
  assert(app.includes('service.isOfficialMessage(raw) && !admin(req)'),'Legacy numeric message view must enforce official access');
  console.log('Official Egytag mailbox: guest list/read/status/export blocked, admin preserved, SSE and legacy checks PASS');
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
