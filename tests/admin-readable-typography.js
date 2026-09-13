const fs = require('fs');
const path = require('path');
const css = fs.readFileSync(path.join(__dirname, '..', 'site_files', 'css', 'zero-ui.css'), 'utf8');
const must = [
  '.mail-admin-body{font-size:16px',
  '.mail-admin-body .mail-admin-table{font-size:13px',
  '.mail-admin-body .mail-admin-table th{font-size:11.5px',
  '.mail-admin-body .mail-admin-identity-name{font-size:14px',
  '.mail-admin-body .mail-admin-identity-email{font-size:11px',
  '.mail-admin-body .mail-admin-subject{font-size:14px',
  '.mail-admin-body .mail-admin-folder,.mail-admin-body .mail-admin-quick-list button{font-size:13px',
  '.mail-admin-body .mail-admin-searchbox input{font-size:14px',
  '.mail-admin-body .mail-admin-message-header h2{font-size:22px'
];
for (const needle of must) {
  if (!css.includes(needle)) throw new Error('Missing readable typography rule: ' + needle);
}
console.log('admin-readable-typography: PASS');
