'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const core=require('..');

const manifest=JSON.parse(fs.readFileSync(path.join(__dirname,'..','compat','isite','contracts','isite-v30-documented-surface.json'),'utf8'));

function makeSite(){
  return core({
    compatibility:'isite',
    fileCache:{prewarm:false},
    session:{enabled:false},
    memoryPressure:{enabled:false}
  });
}

test('official documented iSite site-level methods are present',()=>{
  const site=makeSite();
  const missing=manifest.siteMethods.filter(name=>typeof site[name]!=='function');
  assert.deepEqual(missing,[]);
  site.memoryPressure?.stop?.();
});

test('official iSite utility aliases from object-options/lib/fn.js are present',()=>{
  const site=makeSite();
  const missing=manifest.sourceAliases.filter(name=>name==='fn'?typeof site.fn!=='object':typeof site[name]!=='function');
  assert.deepEqual(missing,[]);
  site.memoryPressure?.stop?.();
});

test('documented nested iSite method surfaces are present',()=>{
  const site=makeSite();
  const missing={};
  for(const [namespace,names] of Object.entries(manifest.nested)){
    const rows=names.filter(name=>typeof site[namespace]?.[name]!=='function');
    if(rows.length)missing[namespace]=rows;
  }
  assert.deepEqual(missing,{});
  site.memoryPressure?.stop?.();
});

test('to123/from123/f1 aliases preserve the official round-trip contract',()=>{
  const site=makeSite();
  for(const value of ['hello','مرحبا','',JSON.stringify({a:1})]){
    const encoded=site.to123(value);
    assert.equal(site.from123(encoded),value);
    assert.equal(site.f1(encoded),value);
    assert.equal(site._x0f1xo(encoded),value);
  }
  assert.equal(site.f1,site.from123);
  site.memoryPressure?.stop?.();
});

test('md5/hash/x0md50x aliases use MD5 hex output',()=>{
  const site=makeSite();
  const expected=crypto.createHash('md5').update('hello').digest('hex');
  assert.equal(site.md5('hello'),expected);
  assert.equal(site.hash('hello'),expected);
  assert.equal(site.x0md50x('hello'),expected);
  site.memoryPressure?.stop?.();
});

test('legacy numeric and JSON aliases preserve iSite utility behavior',()=>{
  const site=makeSite();
  assert.equal(site.toNumber('1.23456'),1.235);
  assert.equal(site.to_number('1.23456'),1.235);
  assert.equal(site.toInt('12.9'),12);
  assert.equal(site.toFloat('12.9'),12.9);
  assert.deepEqual(site.fromJSON('{"a":1}'),{a:1});
  assert.equal(site.toJSON({a:1}),'{"a":1}');
  assert.equal(site.typeof([]),'Array');
  assert.equal(site.typeOf([]),'Array');
  site.memoryPressure?.stop?.();
});

test('hide/show/ul are compatible reversible object helpers',()=>{
  const site=makeSite();
  const input={name:'Core',nested:{ok:true}};
  const hidden=site.hide(input);
  assert.equal(typeof hidden,'string');
  assert.deepEqual(site.show(hidden),input);
  assert.deepEqual(site.showObject(hidden),input);
  assert.deepEqual(site.ul(hidden),input);
  site.memoryPressure?.stop?.();
});

test('legacy date aliases and content/file helpers exist and are coherent',()=>{
  const site=makeSite();
  const d=site.toDateOnly('2026-09-06T11:22:33');
  assert.ok(d instanceof Date);
  assert.equal(site.getContentType('x.css'),'text/css');
  assert.equal(site.getFileEncode('x.png'),'binary');
  assert.equal(site.getFileEncode('x.html'),'UTF8');
  assert.equal(site.getExtension('a.tar.gz'),'.gz');
  assert.ok(site.getRegExp('abc') instanceof RegExp);
  site.memoryPressure?.stop?.();
});

test('compatibility utility overrides are removed/restored cleanly',()=>{
  const site=core({fileCache:{prewarm:false},session:{enabled:false},memoryPressure:{enabled:false}});
  const nativeToNumber=site.toNumber;
  const nativeMd5=site.md5;
  site.useCompatibility('isite');
  assert.notEqual(site.toNumber,nativeToNumber);
  assert.equal(typeof site.f1,'function');
  site.removeCompatibility('isite');
  assert.equal(site.toNumber,nativeToNumber);
  assert.equal(site.md5,nativeMd5);
  assert.equal(site.f1,undefined);
  site.memoryPressure?.stop?.();
});

test('optional integration methods remain callable surfaces and fail explicitly when adapters are absent',async()=>{
  const site=makeSite();
  assert.equal(typeof site.sendMail,'function');
  assert.equal(typeof site.connectTelegramClient,'function');
  assert.equal(typeof site.initFontKit,'function');
  assert.equal(typeof site.loadPDF,'function');
  await assert.rejects(site.sendMail({to:'x@example.test'}),e=>e.code==='ISITE_OPTIONAL_INTEGRATION_MISSING');
  assert.throws(()=>site.connectTelegramClient('',1,'x'),e=>e.code==='ISITE_OPTIONAL_TELEGRAM_CLIENT');
  site.memoryPressure?.stop?.();
});
