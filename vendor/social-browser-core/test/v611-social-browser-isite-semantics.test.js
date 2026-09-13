'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('..');

test('Social Browser iSite string helpers preserve legacy semantics',()=>{
  const site=core({compatibility:'isite',apps:false,stdin:false,help:false,session:{enabled:false},mongodb:{enabled:false},proto:{object:false}});
  assert.equal('https://www.youtube.com/'.like('http*|browser*'),true);
  assert.equal('main-profile'.contains('MAIN|address'),true);
  assert.equal('main-profile'.contain('profile|address'),true);
  const re=/YOUTUBE/i;
  assert.equal('youtube'.test(re,'i'),true);
  site.removeCompatibility?.('isite');
});

test('hide/showObject round-trips objects and arrays exactly once',()=>{
  const site=core({compatibility:'isite',apps:false,stdin:false,help:false,session:{enabled:false},mongodb:{enabled:false},proto:{object:false}});
  const obj={a:1,nested:{ok:true}};
  const arr=[{name:'a'},{name:'b'}];
  const objOut=site.showObject(site.hideObject(obj));
  const arrOut=site.showObject(site.hideObject(arr));
  assert.deepEqual(objOut,obj);
  assert.deepEqual(arrOut,arr);
  assert.equal(typeof objOut,'object');
  assert.equal(Array.isArray(arrOut),true);
  site.removeCompatibility?.('isite');
});
