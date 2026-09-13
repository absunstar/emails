'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const core=require('..');

test('JSON file helpers round-trip objects without changing raw writeFile semantics',async()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'social-core-json-'));
  const site=core({cwd,fileCache:{prewarm:false},session:{enabled:false}});
  const syncFile=path.join(cwd,'sync.json');
  const asyncFile=path.join(cwd,'async.json');
  const value={density:'compact',nested:{enabled:true},items:[1,2,3]};

  assert.equal(site.writeJSONSync(syncFile,value),true);
  assert.deepEqual(site.readJSONSync(syncFile),value);
  assert.equal(await site.writeJSON(asyncFile,value,0),true);
  assert.deepEqual(await site.readJSON(asyncFile),value);

  assert.throws(()=>site.writeFileSync(path.join(cwd,'raw.txt'),value),{code:'ERR_INVALID_ARG_TYPE'});
});
