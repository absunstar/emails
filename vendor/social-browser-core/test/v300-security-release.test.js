'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const aisite=require('..');

test('iSite compatibility remains disabled by default',()=>{
  const site=aisite();
  assert.ok(!site.compatibility?.isite?.enabled);
  assert.equal(typeof site.require,'undefined');
});

test('npm release metadata uses a scoped public package and explicit files allowlist',()=>{
  const pkg=require('../package.json');
  assert.equal(pkg.name,'@social-browser/core');
  assert.equal(pkg.publishConfig.access,'public');
  assert.ok(Array.isArray(pkg.files));
  assert.ok(pkg.files.includes('lib/'));
  assert.ok(!pkg.files.includes('test/'));
  assert.ok(!pkg.files.includes('scripts/'));
});

test('FTP server rejects paths outside configured root',async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'sb-core-ftp-root-'));
  const sibling=root+'-escape';
  fs.mkdirSync(sibling,{recursive:true});
  fs.writeFileSync(path.join(sibling,'secret.txt'),'secret');

  const site=aisite();
  const srv=site.createFtpServer({root});
  await new Promise((res,rej)=>{srv.once('error',rej);srv.listen(0,'127.0.0.1',res)});

  const c=new site.FtpClient();
  await c.connect({host:'127.0.0.1',port:srv.address().port});
  await c.login();
  const r=await c.cwd('../'+path.basename(sibling));
  assert.notEqual(r.code,250);
  await c.quit();
  await new Promise(res=>srv.close(res));
});
