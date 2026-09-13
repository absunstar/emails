'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('..');

const make=compat=>core({...(compat?{compatibility:'isite'}:{}),fileCache:{prewarm:false},session:{enabled:false},memoryPressure:{enabled:false}});

test('native numericBase64 codec round-trips strings and objects without iSite compatibility',()=>{
  const site=make(false);
  assert.equal(site.compatibility.isite,undefined);
  for(const value of ['hello','مرحبا','',JSON.stringify({a:1})]){
    assert.equal(site.codecs.numericBase64.decode(site.codecs.numericBase64.encode(value)),value);
  }
  const obj={name:'Social Browser',list:[1,2,3],nested:{ok:true}};
  assert.deepEqual(site.codecs.hiddenObject.decode(site.codecs.hiddenObject.encode(obj)),obj);
  site.memoryPressure?.stop?.();
});

test('iSite aliases and native codec produce identical persisted/wire bytes',()=>{
  const site=make(true);
  const values=['hello','https://youtube.com/',{a:1,b:['x',2]}];
  for(const value of values){
    assert.equal(site.to123(value),site.codecs.numericBase64.encode(value));
    assert.equal(site.from123(site.to123(value)),site.codecs.numericBase64.decode(site.codecs.numericBase64.encode(value)));
  }
  const obj={list:[{x:1}],enabled:true};
  const encoded=site.hideObject(obj);
  assert.equal(encoded,site.codecs.hiddenObject.encode(obj));
  assert.deepEqual(site.showObject(encoded),site.codecs.hiddenObject.decode(encoded));
  site.memoryPressure?.stop?.();
});
