'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');

test('Smart Code required iSite site.require(filePath) initializer semantics',()=>{
  const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-smart-code-'));
  const mod=path.join(cwd,'feature.js');
  fs.writeFileSync(mod,"module.exports=site=>{site.smartCodeRequireWorked=true;return {ok:true}}");
  const site=aisite({cwd,compatibility:'isite'});
  const out=site.require(mod);
  assert.deepEqual(out,{ok:true});
  assert.equal(site.smartCodeRequireWorked,true);
});

test('site.require remains outside aisite Core',()=>{
  const core=aisite();
  assert.equal(core.require,undefined);
});
