'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const core=require('..');

test('iSite compatibility String.like preserves wildcard and pipe semantics',()=>{
  const site=core({compatibility:'isite',session:{enabled:false},fileCache:{prewarm:false}});
  try{
    assert.equal('https://www.youtube.com/'.like('http*|data*|about*|browser*|file*|chrome*|blob*|ws*|wss*'),true);
    assert.equal('http://google.com'.like('http*'),true);
    assert.equal('browser://local/social-new-tab'.like('browser*'),true);
    assert.equal('HTTPS://EXAMPLE.COM'.like('https*'),true);
    assert.equal('https://www.youtube.com/'.like('*youtube*'),true);
    assert.equal('mailto:test@example.com'.like('http*|browser*'),false);
    assert.equal('abc'.like(123),false);
  } finally { site.removeCompatibility?.('isite'); }
});

test('iSite compatibility String.contains remains case-insensitive legacy matching',()=>{
  const site=core({compatibility:'isite',session:{enabled:false},fileCache:{prewarm:false}});
  try{
    assert.equal('Hello YouTube'.contains('youtube'),true);
    assert.equal('Hello YouTube'.contains('missing|YOUTUBE'),true);
    assert.equal('Hello'.contains('world'),false);
  } finally { site.removeCompatibility?.('isite'); }
});
