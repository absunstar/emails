'use strict';
const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {createEmailService}=require('../apps/emails/core/email-service');

(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'social-mail-transactional-'));
  const sent=[];
  const service=createEmailService({
    dataDir:path.join(root,'messages'),
    vipPath:path.join(root,'vip.json'),
    unsubscribe:{headersFor(){return{'List-Unsubscribe':'<mailto:unsubscribe@example.test>'}}},
    sendmail(message,callback){sent.push(message);callback(null,'250 accepted')}
  });
  await service.send({from:'sender@example.com',to:'user@example.net',subject:'OTP',text:'code',listUnsubscribe:false});
  await service.send({from:'sender@example.com',to:'user2@example.net',subject:'Marketing',text:'hello'});
  assert.equal(sent[0].headers?.['List-Unsubscribe'],undefined);
  assert.equal(sent[1].headers?.['List-Unsubscribe'],'<mailto:unsubscribe@example.test>');
  const app=fs.readFileSync(path.join(__dirname,'..','apps','emails','app.js'),'utf8');
  assert(app.includes("listUnsubscribe: doc.transactional === true ? false : doc.listUnsubscribe"));
  fs.rmSync(root,{recursive:true,force:true});
  console.log('Transactional HTTP email classification test passed');
})().catch(e=>{console.error(e);process.exit(1)});
