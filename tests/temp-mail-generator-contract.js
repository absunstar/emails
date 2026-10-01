'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.join(__dirname, '..', 'apps', 'emails', 'app.js'), 'utf8');
const generateStart = source.indexOf("onPost({ name: '/generate-new-email' }");
assert(generateStart >= 0, 'generate-new-email route must exist');
const generateBlock = source.slice(generateStart, source.indexOf("\n    });", generateStart) + 7);

assert(!/site\.random\s*\(/.test(generateBlock), 'email generator must not treat site.random() strings as integers');
assert(/crypto\.randomInt\(8, 17\)/.test(generateBlock), 'email generator length must use crypto.randomInt');
assert(/crypto\.randomInt\(4, 7\)/.test(generateBlock), 'email generator segments must use bounded integer random values');

console.log('Temporary mailbox generator contract test passed');
