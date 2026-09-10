const assert = require('assert');
const fs = require('fs');
const path = require('path');

const adminPath = path.join(__dirname, '..', 'apps', 'emails', 'site_files', 'js', 'admin.js');
const js = fs.readFileSync(adminPath, 'utf8');
const start = js.indexOf('function setQuickFilter(name)');
const end = js.indexOf('\n    function ', start + 20);
const block = js.slice(start, end > start ? end : undefined);

assert(start >= 0, 'setQuickFilter must exist');
assert(/data-admin-filter=\\?['\"]folder\\?['\"]/.test(block), 'Quick view must resolve the folder filter');
assert(/folder\.value\s*=\s*['\"]all['\"]/.test(block), 'Quick views must reset folder to All mail');
assert(/renderFolders\(\)/.test(block), 'Folder active UI must refresh after Quick View selection');
assert(/name\s*===\s*['\"]attachments['\"]/.test(block), 'Attachments Quick View must remain supported');
console.log('Admin global Quick View checks passed');
