'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createEmailScheduler}=require('../apps/emails/core/email-scheduler');
(async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'queue-policy-'));
  const scheduler=createEmailScheduler({baseDir:dir,emailService:{send:async()=>{let e=new Error('Policy blocked');e.code='POLICY_BLOCKED';throw e;}}});
  try {
    const task=await scheduler.schedule({from:'test@social-browser.com',to:'example@example.com',text:'test',sendAt:new Date(Date.now()+60000).toISOString()});
    const failed=await scheduler.sendNow(task.id);
    assert.equal(failed.status,'failed');
    assert.equal(failed.failureCategory,'policy_blocked');
    assert.equal(failed.nextAttemptAt,null);
    await assert.rejects(scheduler.retry(task.id),/cannot be retried/);
    assert.equal(scheduler.get(task.id).attempts,1);
    console.log('Queue policy failure classification passed');
  } finally {scheduler.stop();fs.rmSync(dir,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1});
