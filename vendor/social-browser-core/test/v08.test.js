'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'aisite-v08-'))}

test('legacy HTTP verbs exist',()=>{
 const s=aisite({compatibility:'isite'});
 for(const n of ['onPUT','onPATCH','onDELETE','onOPTIONS','onHEAD','onCOPY','onLOCK','onMKCOL','onMOVE','onPROPFIND','onPURGE','onVIEW','onALL','onANY'])assert.equal(typeof s[n],'function',n);
});

test('fsm namespace aliases work',async()=>{
 const cwd=tmp(),s=aisite({cwd,compatibility:'isite'}),f=path.join(cwd,'x.txt');
 s.fsm.createDirSync(cwd); s.fsm.writeFileSync(f,'abc');
 assert.equal(s.fsm.readFileSync(f),'abc');
 assert.equal(s.fsm.isFileExistsSync(f),true);
 assert.equal(s.fsm.removeFileSync(f),true);
});

test('mongodb compatibility facade delegates to aisite collection',async()=>{
 const s=aisite({cwd:tmp(),compatibility:'isite'}),c=s.connectCollection('u');
 await s.mongodb.insertOne(c,{name:'A'});
 assert.equal((await s.mongodb.findOne(c,{where:{name:'A'}})).name,'A');
 await s.mongodb.updateOne(c,{where:{name:'A'},set:{name:'B'}});
 assert.equal(await s.mongodb.count(c,{name:'B'}),1);
});

test('collection legacy aliases work',async()=>{
 const s=aisite({cwd:tmp(),compatibility:'isite'}),c=s.connectCollection('u');
 await c.insertMany([{group:'a',n:1},{group:'a',n:2},{group:'b',n:3}]);
 assert.deepEqual((await c.distinct('group')).sort(),['a','b']);
 assert.equal((await c.findByIdsFast([1,3])).length,2);
 await c.updateMany({where:{group:'a'},set:{x:true}});
 assert.equal(await c.count({x:true}),2);
});

test('words namespace works',()=>{
 const s=aisite({compatibility:'isite'});s.words.add({name:'hello',value:'Hello'});
 assert.equal(s.words.word('hello'),'Hello');
});

test('features and vars work',()=>{
 const s=aisite({compatibility:'isite'});s.addFeature('x',true);s.addVars({a:1});
 assert.equal(s.hasFeature('x'),true);assert.equal(s.vars.a,1);
});
