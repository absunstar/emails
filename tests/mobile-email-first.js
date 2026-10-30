'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const html = fs.readFileSync('apps/emails/site_files/html/free.html', 'utf8');
const workspace = html.indexOf('<div class="mail-workspace">');
const main = html.indexOf('<div class="mailbox-main">', workspace);
const sidebar = html.indexOf('<aside class="mailbox-sidebar"', workspace);
assert(workspace !== -1 && main > workspace && sidebar > main, 'Primary email creation UI must precede saved email sidebar in mobile reading order');
// Both desktop grid columns MUST be direct children of .mail-workspace.
// An extra closing </div> previously stranded the sidebar outside the grid.
const workspaceEnd = html.indexOf('<div class="mail-limit-alert"', sidebar);
assert(workspaceEnd > sidebar, 'Workspace closing boundary must exist');
const mailTool = html.lastIndexOf('<div class="mail-tool">', workspace);
assert(mailTool !== -1, 'Mail tool parent must exist');
const structure = html.slice(mailTool, workspaceEnd);
const stack = [];
const childParents = new Map();
for (const token of structure.matchAll(/<\/?(?:div|aside)\b[^>]*>/g)) {
  const tag = token[0];
  if (tag.startsWith('</')) {
    assert(stack.length, 'Workspace has an unexpected closing tag');
    const expected = stack.pop().tag;
    assert.equal(tag.match(/^<\/(\w+)/)[1], expected, 'Workspace has mismatched container tags');
  } else {
    const type = tag.match(/^<(\w+)/)[1];
    const klass = (tag.match(/class="([^"]*)"/) || [,''])[1];
    for (const relevant of ['mailbox-main', 'mailbox-sidebar']) {
      if (klass.split(/\s+/).includes(relevant)) {
        childParents.set(relevant, stack.at(-1)?.klass);
      }
    }
    stack.push({tag:type, klass});
  }
}
assert.equal(stack.length, 0, 'Workspace and mail-tool must close after both columns');
assert.equal(childParents.get('mailbox-main'), 'mail-workspace', 'Main must be a direct grid child');
assert.equal(childParents.get('mailbox-sidebar'), 'mail-workspace', 'Sidebar must be a direct grid child');
assert.match(html, /@media \(min-width:821px\)[\s\S]*?\.mail-workspace > \.mailbox-sidebar \{ order:0;/, 'Desktop must still start with the inbox sidebar');
assert.match(html, /@media \(max-width:820px\)[\s\S]*?\.mail-workspace > \.mailbox-main \{ order:0;display:flex;flex-direction:column;/, 'Mobile must display email creation before inbox management');
assert.match(html, /\.mailbox-main-heading \{ order:-3;/, 'Mobile heading must appear first');
assert.match(html, /\.mail-address-grid \{ order:-2;/, 'Mobile email generation controls must appear immediately after heading');
assert.match(html, /\.mobile-download-actions \{ order:1;/, 'Promotional download links must not block the primary email workflow');
assert.match(html, /data-action="generate-email"/);
assert.match(html, /data-action="copy-email"/);
console.log('Mobile email-first layout contract passed');
