'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('fs');
const os=require('os');
const path=require('path');
const core=require('../index');
const {SessionStore}=require('../lib/session');
const {StorageEngine}=require('../lib/storage-engine');

function tmp(name){return fs.mkdtempSync(path.join(os.tmpdir(),`sb-core-${name}-`))}

test('disabled sessions perform zero filesystem initialization',()=>{
  const root=tmp('disabled');
  const blocked=path.join(root,'blocked');
  fs.writeFileSync(blocked,'not-a-directory');
  const site=core({cwd:blocked,session:{enabled:false},memoryPressure:{enabled:false},fileCache:{prewarm:false}});
  assert.equal(site.sessionStore.enabled,false);
  assert.equal(site.sessionStore.dir,path.join(blocked,'.social-browser','sessions'));
  assert.equal(fs.existsSync(path.join(blocked,'.social-browser')),false);
  site.sessionStore.close();
});

test('site cwd is the canonical default root for sessions',()=>{
  const root=tmp('cwd');
  const site=core({cwd:root,session:{enabled:true},memoryPressure:{enabled:false},fileCache:{prewarm:false}});
  assert.equal(site.cwd,path.resolve(root));
  assert.equal(site.options.cwd,path.resolve(root));
  assert.equal(site.sessionStore.cwd,path.resolve(root));
  assert.equal(site.sessionStore.dir,path.join(path.resolve(root),'.social-browser','sessions'));
  assert.equal(fs.existsSync(site.sessionStore.dir),true);
  site.sessionStore.close();
});

test('SessionStore can explicitly fail open to memory on storage errors',()=>{
  const root=tmp('memory-fallback');
  const blocked=path.join(root,'blocked');
  fs.writeFileSync(blocked,'not-a-directory');
  const store=new SessionStore({cwd:blocked,enabled:true,onStorageError:'memory'});
  assert.equal(store.persistence,'memory');
  assert.ok(store.storageError);
  assert.equal(fs.existsSync(path.join(blocked,'.social-browser')),false);
  assert.equal(store.save('x',{hello:'world'}),true);
  assert.equal(store.load('x').hello,'world');
  store.close();
});

test('SessionStore preserves fail-fast semantics unless memory fallback is requested',()=>{
  const root=tmp('fail-fast');
  const blocked=path.join(root,'blocked');
  fs.writeFileSync(blocked,'not-a-directory');
  assert.throws(()=>new SessionStore({cwd:blocked,enabled:true}),/ENOTDIR|not a directory/i);
});

test('standalone StorageEngine honors cwd instead of process.cwd',()=>{
  const root=tmp('storage');
  const engine=new StorageEngine('users',{cwd:root});
  assert.equal(engine.cwd,path.resolve(root));
  assert.equal(engine.dir,path.join(path.resolve(root),'.social-browser','data'));
  assert.equal(fs.existsSync(engine.dir),true);
});
