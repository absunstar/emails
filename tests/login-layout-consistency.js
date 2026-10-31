'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {parseDocument,DomUtils}=require('htmlparser2');
const source=fs.readFileSync('apps/emails/site_files/html/login.html','utf8');
const doc=parseDocument(source);
const nodes=(cls)=>DomUtils.findAll(n=>n.type==='tag'&&(n.attribs?.class||'').split(/\s+/).includes(cls),doc.children);
for(const cls of ['browser-login-layout','browser-login-main','browser-login-side','browser-login-actions','browser-login-checkline','browser-login-unlock'])assert.equal(nodes(cls).length,1,cls+' needs one instance');
assert.equal(nodes('browser-login-benefit').length,3);
assert.equal(nodes('browser-login-help').length,0,'Avoid repeating install/copy instructions in both panels');
const layout=nodes('browser-login-layout')[0],benefits=nodes('browser-login-unlock')[0];
assert.equal(layout.parent,benefits.parent,'Benefits must be full width below the 2-column layout');
assert.equal(nodes('browser-login-main')[0].parent,layout,'Primary panel belongs to layout');
assert.equal(nodes('browser-login-side')[0].parent,layout,'Help panel belongs to layout');
assert(!nodes('browser-login-main')[0].children.includes(benefits),'Benefits cannot be nested in primary card');
const styleCount=(source.match(/<style>/g)||[]).length;
assert.equal(styleCount,1,'Login must have a single design-system stylesheet');
assert(source.includes('grid-template-columns:minmax(0,1.15fr) minmax(350px,.85fr)'));
assert(source.includes('@media(max-width:850px)'));
assert(source.includes('grid-template-columns:1fr;gap:8px'), 'Very narrow mobile needs one-column action rows');
for(const [key,parent] of [['data-browser-download','browser-login-actions'],['data-browser-download-linux','browser-login-actions'],['data-copy-page-link','browser-login-actions'],['data-browser-login','browser-login-checkline']]){
 const found=DomUtils.findAll(n=>n.type==='tag'&&n.attribs?.[key]!==undefined,doc.children);
 assert.equal(found.length,1,key+' missing');
 assert(found[0].parent.attribs.class.includes(parent),key+' should be in '+parent);
}
console.log('Login visual hierarchy, equal design system and responsive structure PASS');
