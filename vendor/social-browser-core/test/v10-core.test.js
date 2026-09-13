'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v10-core-'))}

test('core identity provider loads users without iSite compatibility',async()=>{
  const site=aisite({cwd:tmp()});
  site.identity.register('json',{load:async id=>({id,name:'User '+id})});
  const ref={provider:'json',id:'42'};
  const u=await site.identity.load(ref);
  assert.deepEqual(u,{id:'42',name:'User 42'});
  assert.equal(site.compatibility.isite,undefined);
});

test('core session identityRef hydrates user',async()=>{
  const site=aisite({cwd:tmp()});
  site.identity.register('json',{load:async id=>({id,email:id+'@x.test'})});
  const req={session:{identityRef:{provider:'json',id:'a'}}};
  await site.sessionStore.hydrateIdentity(req);
  assert.equal(req.user.email,'a@x.test');
});

test('core async retry succeeds',async()=>{
  const site=aisite();
  let n=0;
  const v=await site.async.retry(async()=>{if(++n<3)throw new Error('x');return 7},{retries:3,delayMs:0});
  assert.equal(v,7);
  assert.equal(n,3);
});

test('core async timeout rejects',async()=>{
  const site=aisite();
  await assert.rejects(()=>site.async.timeout(new Promise(()=>{}),5),e=>e.code==='ETIMEDOUT');
});
