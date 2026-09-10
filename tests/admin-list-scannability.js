const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const adminJs = fs.readFileSync(path.join(root, 'apps/emails/site_files/js/admin.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'site_files/css/zero-ui.css'), 'utf8');
function assert(value, message) { if (!value) throw new Error(message); }
assert(adminJs.includes('function parseMailbox('), 'Mailbox parsing helper is missing');
assert(adminJs.includes('function renderAddressCard('), 'Sender/recipient rendering helper is missing');
assert(adminJs.includes('mail-admin-address-name') && adminJs.includes('mail-admin-address-email'), 'Sender/recipient semantic markup is missing');
assert(adminJs.includes('mail-admin-subject-text') && adminJs.includes('mail-admin-subject-source'), 'Subject emphasis/meta markup is missing');
assert(css.includes('.mail-admin-address-avatar') && css.includes('.mail-admin-address-domain'), 'Address avatar/domain styles are missing');
assert(css.includes('.mail-admin-address-email') && css.includes('.mail-admin-subject-text'), 'Readable sender/recipient/subject colors are missing');
console.log('Admin message-list scannability checks passed');
