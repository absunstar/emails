'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('native String pattern helpers install at require-time before createSite()', () => {
  const root = path.resolve(__dirname, '..');
  const script = `
    if (typeof ''.like !== 'undefined') process.exit(10);
    const core = require(${JSON.stringify(root)});
    if (typeof ''.like !== 'function') process.exit(11);
    if (!'Social Browser.exe'.like('*Social Browser.exe*')) process.exit(12);
    if (!'Hello WORLD'.contains('world')) process.exit(13);
    if (!'abc123'.test('^abc\\\\d+$')) process.exit(14);
    if (core.version !== '6.10.2') process.exit(15);
  `;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
