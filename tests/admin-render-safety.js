const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'apps/emails/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'apps/emails/site_files/html/index.html'), 'utf8');
const admin = fs.readFileSync(path.join(root, 'apps/emails/site_files/js/admin.js'), 'utf8');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

assert(/name:\s*'admin'[\s\S]*?res\.render\(__dirname \+ '\/site_files\/html\/index\.html',[\s\S]*?compress:\s*false/.test(app), 'Admin route must render without compression to prevent parser/minifier corruption.');
assert(!/googletagmanager|gtag\s*\(/i.test(html), 'Admin HTML must not include third-party analytics.');
assert(/<script x-import="emails\/admin\.js"><\/script>/.test(html), 'Admin first-party script import is missing.');

// Source syntax must remain independently valid before template rendering.
new Function(admin);
console.log('Admin render safety checks passed');
