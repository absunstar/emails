'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v2beta-'))}

test('paged update appends new version and survives reload',async()=>{
 const cwd=tmp();
 let site=aisite({cwd});
 let c=site.connectCollection('x',{storageMode:'paged'});
 await c.insertMany([{email:'a',score:1},{email:'b',score:2}]);
 await c.update({where:{email:'a'},set:{score:9}});
 assert.equal((await c.findOne({where:{email:'a'}})).score,9);
 c.engine.close();
 site=aisite({cwd});
 c=site.connectCollection('x',{storageMode:'paged'});
 assert.equal((await c.findOne({where:{email:'a'}})).score,9);
});

test('paged queryPage returns total and page slice',async()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged'});
 await c.insertMany(Array.from({length:105},(_,i)=>({value:i})));
 const p=c.engine.queryPage({page:3,limit:20});
 assert.equal(p.list.length,20);assert.equal(p.total,105);assert.equal(p.pages,6);
 assert.equal(p.list[0].value,40);
});

test('paged transaction applies add/update/delete batch',async()=>{
 const site=aisite({cwd:tmp()});
 const c=site.connectCollection('x',{storageMode:'paged'});
 await c.insertMany([{email:'a',v:1},{email:'b',v:2}]);
 await c.engine.transaction([
   {type:'add',doc:{email:'c',v:3}},
   {type:'update',where:{email:'a'},patch:{v:10}},
   {type:'delete',where:{email:'b'}}
 ]);
 assert.equal((await c.findOne({where:{email:'a'}})).v,10);
 assert.equal((await c.findMany({where:{email:'b'}})).length,0);
 assert.equal((await c.findOne({where:{email:'c'}})).v,3);
});
