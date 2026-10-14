'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {createEmailService} = require('../apps/emails/core/email-service');
const {createEmailBackupStorageManager} = require('../apps/emails/core/backup-storage-manager');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'email-seven-day-'));
  const storage = path.join(root,'localStorage');
  try {
    fs.mkdirSync(storage,{recursive:true});
    const service = createEmailService({ dataDir:path.join(storage,'email-files'),vipPath:path.join(storage,'vip-email-list.json'),maxMessages:2000,sendmail(m,cb){cb(null,'250 okay')} });
    const old='2026-09-01T12:00:00Z';
    async function add(guid,to,folder,status,favorite,date=old) {
      await service.ingestIncoming({guid,from:'person@example.com',to,subject:guid,text:'test',date});
      await service.store.updateMessage(guid,{folder:folder||'inbox',status:status||'received',favorite:!!favorite,date});
    }
    await add('old-temp','random@egytag.com');
    await add('old-temp-2','temp@social-browser.com');
    await add('old-official','info@social-browser.com');
    await add('old-official-spam','info@social-browser.com','spam');
    await add('old-important','temp@egytag.com','Important');
    await add('old-reports','temp@egytag.com','Reports');
    await add('old-reviewed','temp@egytag.com','Reviewed');
    await add('old-sent','temp@egytag.com','send','sent');
    await add('old-favorite','temp@egytag.com','inbox','received',true);
    await add('new-temp','temp@egytag.com','inbox','received',false,new Date().toISOString());
    await add('old-vip','vip@example.com');
    await service.store.setVip({email:'vip@example.com',vip:true});
    const manager=createEmailBackupStorageManager({emailService:service,rootDir:storage});
    manager.updateConfig({retention:{messagesDays:7,autoCleanup:true,intervalHours:24,maxMessagesPerRun:100}});
    const preview=manager.cleanupPreview({maxMessages:1});
    assert.equal(preview.candidates.messages,1);
    assert.equal(preview.moreCandidates,true);
    // Protection changed after preview must be respected at deletion time.
    const firstGuid=manager.state.previewTokens[preview.confirmToken].messageGuids[0];
    await service.store.updateMessage(firstGuid,{favorite:true});
    const check=await manager.cleanupExecute({confirm:true,confirmToken:preview.confirmToken});
    assert.equal(check.messages.deleted.length,0);
    await service.store.updateMessage(firstGuid,{favorite:false});
    const outcome=await manager.runMaintenance({skipBackup:true});
    assert.ok(outcome.cleanup);
    assert.ok(outcome.cleanup.messages.deleted.includes('old-temp'));
    assert.ok(outcome.cleanup.messages.deleted.includes('old-temp-2'));
    assert.ok(outcome.cleanup.messages.deleted.includes('old-official-spam'));
    for (const key of ['old-temp','old-temp-2','old-official-spam']) assert.equal(await service.store.getMessage(key),null,key);
    for (const key of ['old-official','old-important','old-reports','old-reviewed','old-sent','old-favorite','old-vip','new-temp']) assert.ok(await service.store.getMessage(key),key);
    assert.equal(manager.status().retentionCatchupPending,false);
    assert.ok(manager.status().lastRetentionSweepAt);
    const next=await manager.runMaintenance({skipBackup:true});
    assert.equal(next.cleanup,null);
    console.log('Seven-day automatic retention and protection regression test passed');
  } finally {fs.rmSync(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e.stack||e);process.exitCode=1});
