'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const core=require('..');

test('Native Core exposes onVERB aliases and onWS without iSite compatibility',()=>{
  const site=core();
  assert.equal(site.compatibility.isite,undefined);
  for(const name of ['onGET','onPOST','onPUT','onPATCH','onDELETE','onALL','onANY','onWS']){
    assert.equal(typeof site[name],'function',name);
  }
  site.onGET('/native-onget',(req,res)=>res.json({ok:true}));
  site.onPOST('/native-onpost',(req,res)=>res.json({ok:true}));
  assert.ok(site.router.match('GET','/native-onget'));
  assert.ok(site.router.match('POST','/native-onpost'));
});

test('Native onGET supports Social Browser static descriptor form',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-core-onget-'));
  const file=path.join(dir,'index.html');
  fs.writeFileSync(file,'<!doctype html><title>native descriptor</title>');
  const site=core({cwd:dir});
  site.onGET({name:'/xlsx',path:file,parser:'html css js'});
  const found=site.router.match('GET','/xlsx');
  assert.ok(found);
  assert.equal(typeof found.route.handler,'function');
});

test('iSite enable/remove preserves Native onVERB APIs',()=>{
  const site=core();
  const nativeOnGET=site.onGET;
  const nativeOnWS=site.onWS;
  site.useCompatibility('isite');
  assert.equal(typeof site.onGET,'function');
  assert.equal(typeof site.onWS,'function');
  site.removeCompatibility('isite');
  assert.equal(site.onGET,nativeOnGET);
  assert.equal(site.onWS,nativeOnWS);
});
