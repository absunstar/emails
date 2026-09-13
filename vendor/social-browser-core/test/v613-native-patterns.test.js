'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('..');
const make=compat=>core({...(compat?{compatibility:'isite'}:{}),fileCache:{prewarm:false},session:{enabled:false},memoryPressure:{enabled:false}});
test('native patterns preserve Social Browser URL matching without compatibility',()=>{
 const site=make(false);
 assert.equal(site.patterns.like('https://www.youtube.com/','http*|browser*'),true);
 assert.equal(site.patterns.like('mailto:x@y.com','http*|browser*'),false);
 assert.equal(site.patterns.contains('Social Browser','browser|chrome'),true);
 assert.equal(site.patterns.test('ABC','^abc$','i'),true);
 site.memoryPressure?.stop?.();
});
test('iSite String helpers delegate to identical native pattern semantics',()=>{
 const site=make(true);
 const cases=[['https://www.youtube.com/','http*|browser*'],['browser://local/x','browser*'],['abc','a*c|z*']];
 for(const [v,p] of cases) assert.equal(v.like(p),site.patterns.like(v,p));
 assert.equal('Hello Browser'.contain('browser'),site.patterns.contains('Hello Browser','browser'));
 site.memoryPressure?.stop?.();
});
