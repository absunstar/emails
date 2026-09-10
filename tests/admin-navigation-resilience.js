const fs = require('fs');
const assert = require('assert');

const admin = fs.readFileSync('apps/emails/site_files/js/admin.js', 'utf8');
const html = fs.readFileSync('apps/emails/site_files/html/index.html', 'utf8');

assert(admin.includes('pendingLoad: null'), 'admin load queue state missing');
assert(admin.includes('state.pendingLoad = Object.assign({}, options || {})'), 'in-flight navigation should queue latest reload');
assert(admin.includes('if (pending)'), 'queued reload should be drained');
assert(admin.includes('resetQuickViewFields();'), 'folder/quick-view filter reset helper missing');
assert(!html.includes('x-import="scripts.html"'), 'admin must not import shared analytics bundle');
assert(html.includes('x-import="app.js"') && html.includes('x-import="browser-auth.js"') && html.includes('x-import="navbar.js"'), 'admin first-party imports missing');
assert(!html.includes('googletagmanager.com'), 'admin must not load Google Tag Manager');
console.log('Admin navigation resilience checks passed');
