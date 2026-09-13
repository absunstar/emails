'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');

test('iSite compatibility is opt-in and not loaded in native Core mode',()=>{
  const root=path.resolve(__dirname,'..');
  const script=`
    const assert=require('node:assert/strict');
    const core=require(${JSON.stringify(root)});
    const compatNeedle=path=>path.replace(/\\\\/g,'/').includes('/compat/isite/');
    const before=Object.keys(require.cache).filter(compatNeedle);
    assert.deepEqual(before,[]);

    const site=core({cwd:process.cwd()});
    const after=Object.keys(require.cache).filter(compatNeedle);
    assert.deepEqual(after,[]);

    // Core exposes the compatibility manager, but none of the legacy runtime surfaces.
    assert.equal(typeof site.useCompatibility,'function');
    assert.equal(typeof site.removeCompatibility,'function');
    for(const name of ['onGET','onPOST','onPUT','onPATCH','onDELETE','onALL','onANY','onWS']) assert.equal(typeof site[name],'function',name);
    for(const name of ['parser','routing','sessions','callRoute']){
      assert.equal(Object.prototype.hasOwnProperty.call(site,name),false,name);
    }

    assert.equal(site.sessionStore.cookieName,'sb.sid');
    assert.match(site.sessionStore.dir,/\.social-browser[\\/]sessions$/);
    assert.equal(site.compatibility.isite,undefined);
    assert.equal(core.version,'6.10.2');

    // Native Core ORM remains available and is not an iSite feature.
    const c=site.connectCollection('native_optional_'+Date.now());
    assert.equal(c.provider,'core');

    console.log(JSON.stringify({
      ok:true,
      compatibilityLoaded:false,
      cookieName:site.sessionStore.cookieName,
      nativeProvider:c.provider
    }));
  `;
  const r=spawnSync(process.execPath,['-e',script],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr||r.stdout);
  const out=JSON.parse(r.stdout.trim());
  assert.equal(out.compatibilityLoaded,false);
  assert.equal(out.cookieName,'sb.sid');
});

test('iSite can be enabled and removed at runtime without making it the Core default',()=>{
  const core=require('..');
  const site=core();
  assert.equal(site.compatibility.isite,undefined);
  assert.equal(Object.prototype.hasOwnProperty.call(site,'parser'),false);

  site.useCompatibility('isite');
  assert.equal(site.compatibility.isite.enabled,true);
  assert.ok(site.parser);
  assert.ok(site.routing);
  assert.equal(site.sessionStore.cookieName,'aisite.sid');
  assert.match(site.sessionStore.dir,/\.aisite[\\/]sessions$/);

  const nativeGet=site.compatibility.isite.nativeRouteMethods.get;
  site.removeCompatibility('isite');
  assert.equal(site.compatibility.isite,undefined);
  assert.equal(site.sessionStore.cookieName,'sb.sid');
  assert.match(site.sessionStore.dir,/\.social-browser[\\/]sessions$/);
  assert.equal(site.get,nativeGet);
  assert.equal(Object.prototype.hasOwnProperty.call(site,'parser'),false);
  assert.equal(Object.prototype.hasOwnProperty.call(site,'routing'),false);
  assert.equal(site.middlewares.length,0);
  assert.equal(typeof site.security.getUser,'undefined');
});

test('database provider status checks optional drivers without making them dependencies',()=>{
  const core=require('..');
  const site=core();
  const statuses=Object.fromEntries(site.databaseProviderStatuses().map(x=>[x.name,x]));
  assert.equal(statuses.core.driverInstalled,true);
  for(const name of ['mongodb','postgres','mysql','sqlite']){
    assert.equal(typeof statuses[name].driverInstalled,'boolean');
    assert.ok(statuses[name].driver);
  }
});
