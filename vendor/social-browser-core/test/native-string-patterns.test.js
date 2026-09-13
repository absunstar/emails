'use strict';
const assert = require('assert');
const core = require('../');
const site = core();
assert.strictEqual('https://www.youtube.com/'.like('http*|browser*'), true);
assert.strictEqual('browser://local/social-new-tab'.like('browser*'), true);
assert.strictEqual('mailto:test@example.com'.like('http*|browser*'), false);
assert.strictEqual('Hello WORLD'.contains('world'), true);
assert.strictEqual('Hello WORLD'.contain('hello'), true);
assert.strictEqual('abc123'.test('^abc\\d+$'), true);
for (const name of ['like','contains','contain','test']) {
  const d = Object.getOwnPropertyDescriptor(String.prototype, name);
  assert(d && typeof d.value === 'function');
  assert.strictEqual(d.enumerable, false);
}
const nativeLike = String.prototype.like;
site.installCompatibility?.('isite');
site.removeCompatibility?.('isite');
assert.strictEqual(typeof ''.like, 'function');
assert.strictEqual(String.prototype.like, nativeLike);
console.log('PASS native String pattern helpers');
