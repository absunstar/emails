'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');

test('database certification distinguishes PASS from unavailable optional infrastructure',()=>{
  const root=path.resolve(__dirname,'..');
  const r=spawnSync(process.execPath,['scripts/certify-databases.js'],{cwd:root,encoding:'utf8',env:{...process.env,MONGODB_URL:'',POSTGRES_URL:'',MYSQL_URL:''},timeout:30000});
  assert.equal(r.status,0,r.stderr||r.stdout);
  const out=JSON.parse(r.stdout);
  assert.equal(out.providers.core.status,'PASS');
  assert.equal(out.providers.sqlite.status,'PASS');
  for(const name of ['mongodb','postgres','mysql']){
    assert.ok(['UNAVAILABLE','DRIVER_ONLY'].includes(out.providers[name].status),`${name}: ${out.providers[name].status}`);
  }
  assert.equal(out.providers.sqlite.realEngine,true);
});

test('Core does not bundle optional DB drivers',()=>{
  const pkg=require('../package.json');
  const deps=pkg.dependencies||{};
  for(const name of ['mongodb','pg','mysql2','better-sqlite3'])assert.equal(deps[name],undefined,name);
});
