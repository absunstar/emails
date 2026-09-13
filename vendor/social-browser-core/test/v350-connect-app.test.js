'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const core=require('..');

test('iSite connectApp exposes memoryList and CRUD manager',async()=>{
  const site=core({compatibility:'isite'});
  const app=site.connectApp({name:'hosts_'+Date.now()+'_'+Math.random(),allowMemory:true,sort:{id:1}});
  assert.ok(Array.isArray(app.memoryList));
  assert.equal(app.memoryList.length,0);
  await app.add({id:1,domain:'example.com',filter:'x'});
  assert.equal(app.memoryList.length,1);
  assert.equal(app.memoryList.find(x=>x.domain==='example.com').filter,'x');
  const one=app.findOne({id:1});
  assert.equal(one.domain,'example.com');
});

test('iSite compatibility does not mutate the site listener ceiling',()=>{
  const site=core();
  const before=site.getMaxListeners();
  site.useCompatibility('isite');
  assert.equal(site.getMaxListeners(),before);
  site.removeCompatibility('isite');
  assert.equal(site.getMaxListeners(),before);
});
