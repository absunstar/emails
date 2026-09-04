const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const frontend = fs.readFileSync(path.join(root, 'apps/emails/site_files/js/index.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'apps/emails/app.js'), 'utf8');
function assert(value, message) { if (!value) throw new Error(message); }
assert(frontend.includes('response.doc || response.message || (Array.isArray(response.list) ? response.list[0] : null)'), 'Message viewer must accept doc/message/list API response shapes');
assert(frontend.includes("if (!mail) throw new Error(response.error || 'Email not found')"), 'Message viewer must fail explicitly when no message payload exists');
assert(app.includes('response.doc = doc;') && app.includes('response.message = doc;') && app.includes('response.list = [doc];'), 'View API must expose canonical and compatibility single-message response keys');
console.log('Message view API/UI contract checks passed');
