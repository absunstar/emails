const fs = require('fs');
const html = fs.readFileSync('apps/emails/site_files/html/free.html', 'utf8');
function need(pattern, message) { if (!pattern.test(html)) throw new Error(message); }
need(/\.mailbox-address-list\{display:flex;flex:1 1 auto;flex-direction:column/, 'Saved inbox list must be a non-shrinking vertical flex list on desktop');
need(/\.mailbox-address-item\{flex:0 0 auto;min-height:58px\}/, 'Saved inbox rows need a stable readable desktop height');
need(/\.mailbox-address-select\{min-height:56px\}/, 'Saved inbox selector must keep readable height');
need(/overflow-y:auto;overflow-x:hidden/, 'Saved inbox list must scroll internally instead of compressing rows');
console.log('Saved inbox sidebar row layout checks passed');
