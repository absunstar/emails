'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const core=require('..');
const {InvalidationCoordinator}=require('../lib/invalidation');

test('invalidation coordinator fans out through one ordered dispatcher',()=>{
  const bus=new InvalidationCoordinator();
  const rows=[];
  bus.subscribe('low',{priority:1,invalidate:f=>rows.push('low:'+f),clear:()=>rows.push('low:clear')});
  bus.subscribe('high',{priority:10,invalidate:f=>rows.push('high:'+f),clear:()=>rows.push('high:clear')});
  bus.invalidate('/x');
  bus.clear();
  assert.deepEqual(rows,['high:/x','low:/x','high:clear','low:clear']);
  assert.equal(bus.stats().handlers,2);
});

test('Core keeps exactly one file-cache invalidate and clear listener pair',()=>{
  const site=core({fileCache:{prewarm:false},session:{enabled:false}});
  assert.equal(site.fileCache.listenerCount('invalidate'),1);
  assert.equal(site.fileCache.listenerCount('clear'),1);
  assert.ok(site.invalidation.stats().handlers>=1);
});

test('iSite compatibility adds coordinator subscribers without adding file-cache listeners',()=>{
  const site=core({compatibility:'isite',fileCache:{prewarm:false},session:{enabled:false}});
  assert.equal(site.fileCache.listenerCount('invalidate'),1);
  assert.equal(site.fileCache.listenerCount('clear'),1);
  const names=site.invalidation.stats().names;
  assert.ok(names.includes('response-cache'));
  assert.ok(names.includes('isite-shared-render-cache'));
  assert.ok(names.includes('isite-words'));
  assert.ok(names.includes('isite-static-resolution'));
});

test('compatibility uninstall removes coordinator subscribers cleanly',()=>{
  const site=core({compatibility:'isite',fileCache:{prewarm:false},session:{enabled:false}});
  site.removeCompatibility('isite');
  const names=site.invalidation.stats().names;
  assert.ok(names.includes('response-cache'));
  assert.ok(!names.includes('isite-shared-render-cache'));
  assert.ok(!names.includes('isite-words'));
  assert.ok(!names.includes('isite-static-resolution'));
  assert.equal(site.fileCache.listenerCount('invalidate'),1);
  assert.equal(site.fileCache.listenerCount('clear'),1);
});

test('file invalidation clears dependent response, word and static caches via coordinator',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-invalid-'));
  const site=core({cwd:dir,dir,compatibility:'isite',fileCache:{prewarm:false},session:{enabled:false}});
  const file=path.join(dir,'x.txt');
  fs.writeFileSync(file,'a');
  site.responseCache.set('x','cached',{dependencies:[path.resolve(file)]});
  assert.equal(site.responseCache.get('x'),'cached');
  site.fileCache.invalidate(file);
  assert.equal(site.responseCache.get('x'),null);
  assert.ok(site.invalidation.stats().invalidateEvents>=1);
  fs.rmSync(dir,{recursive:true,force:true});
});

test('many compatibility install/uninstall cycles never trigger listener growth',()=>{
  const site=core({fileCache:{prewarm:false},session:{enabled:false}});
  for(let i=0;i<100;i++){
    site.useCompatibility('isite');
    assert.equal(site.fileCache.listenerCount('invalidate'),1);
    assert.equal(site.fileCache.listenerCount('clear'),1);
    site.removeCompatibility('isite');
  }
  assert.equal(site.fileCache.listenerCount('invalidate'),1);
  assert.equal(site.fileCache.listenerCount('clear'),1);
  assert.equal(site.invalidation.stats().handlers,1);
});


test('iSite parser caches repeated permission/role/feature checks per render',()=>{
  const site=core({compatibility:'isite',fileCache:{prewarm:false},session:{enabled:false}});
  let permissionCalls=0,roleCalls=0,featureCalls=0;
  site.security.isUserHasPermission=()=>{permissionCalls++;return true};
  site.security.isUserHasRole=()=>{roleCalls++;return true};
  const req={
    data:{},session:{language:{id:'En'}},features:[],
    hasFeature(){featureCalls++;return true}
  };
  const row='<div x-permission="read"></div><span x-role="admin"></span><i x-feature="x"></i>';
  const html=row.repeat(200);
  const out=site.parser.html(html,{req});
  assert.ok(out.includes('<div'));
  assert.equal(permissionCalls,1);
  assert.equal(roleCalls,1);
  assert.equal(featureCalls,1);
});


test('protocol/network modules stay lazy until their surface is accessed',()=>{
  const root=path.resolve(__dirname,'..');
  const names=['protocol-runtime.js','ftp-client.js','smtp-client.js','mqtt-client.js','protocol-factory.js'];
  for(const name of names){
    const full=path.join(root,'lib',name);
    delete require.cache[require.resolve(full)];
  }
  const site=core({fileCache:{prewarm:false},session:{enabled:false}});
  for(const name of names){
    const full=path.join(root,'lib',name);
    assert.equal(!!require.cache[require.resolve(full)],false,name+' should remain unloaded');
  }
  assert.equal(typeof site.FtpClient,'function');
  assert.equal(!!require.cache[require.resolve(path.join(root,'lib','ftp-client.js'))],true);
});

test('lazy protocol surface remains API-compatible',()=>{
  const site=core({fileCache:{prewarm:false},session:{enabled:false}});
  assert.ok(site.protocols);
  assert.equal(typeof site.ProtocolRuntime,'function');
  assert.equal(typeof site.createMqttBroker,'function');
  assert.equal(typeof site.SecurityShield,'function');
  assert.ok(site.securityShield);
  assert.ok(site.protocolFactory);
});
