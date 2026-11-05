'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createNativeTemplateRenderer } = require('../apps/emails/core/native-template');
const { languages } = require('../apps/emails/core/languages');

const root = path.join(__dirname, '..');
const template = path.join(root, 'apps/emails/site_files/html/privacy.html');
const app = fs.readFileSync(path.join(root, 'apps/emails/app.js'), 'utf8');
const route = app.match(/site\.onGET\(\{\s*name:\s*\['privacy'\][\s\S]*?\}\);/);
assert(route, 'Default /privacy route must exist');
assert.match(route[0], /parser:\s*'html css js'/, 'Default /privacy must enable native translation');
assert.match(route[0], /overwrite:\s*true/, 'Default /privacy must use the localized route');
const renderer = createNativeTemplateRenderer({ cwd: root, dir: path.join(root, 'site_files'), options: { lang: 'En' } });
for (const [code, language] of Object.entries(languages)) {
  const url = code === 'en' ? '/privacy' : '/' + code + '/privacy';
  const html = renderer.render(template, { url, headers: { host: 'emails.egytag.com' } });
  assert(!html.includes('##word.'), 'Unresolved translation placeholders: ' + url);
  assert(html.includes('<html lang="' + code + '" dir="' + language.dir + '">'), 'Wrong html language/direction: ' + url);
  assert(html.includes('data-email-language-switch'), 'Missing language selector: ' + url);
  assert(html.includes('rel="canonical" href="https://emails.egytag.com' + url + '"'), 'Canonical mismatch: ' + url);
  assert(/<h1>[^<#]+<\/h1>/.test(html), 'Missing translated privacy heading: ' + url);
  assert(html.includes('mailto:absunstar@gmail.com'), 'Privacy contact is missing: ' + url);
  if (code === 'ar') assert(html.includes('سياسة الخصوصية'), 'Arabic privacy translation missing');
  if (code === 'en') assert(html.includes('Privacy Policy'), 'English privacy translation missing');
}
console.log('Privacy route: default + 10 localized URLs, resolved translations, semantic content, SEO and RTL PASS');
