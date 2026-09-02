'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'apps/emails/app.js'), 'utf8');
const free = fs.readFileSync(path.join(root, 'apps/emails/site_files/html/free.html'), 'utf8');
const sitemap = fs.readFileSync(path.join(root, 'sitemap.xml'), 'utf8');
const robots = fs.readFileSync(path.join(root, 'robots.txt'), 'utf8');
const slugs = ['temporary-email', 'disposable-email', 'verification-code-email', 'temp-email-for-testing', 'multiple-temporary-inboxes', 'developer-temp-mail'];

assert.ok(free.includes('rel="canonical" href="https://emails.social-browser.com/"'));
assert.ok(free.includes('seo-guide-links'));
assert.ok(robots.includes('Sitemap: https://emails.social-browser.com/sitemap.xml'));
for (const slug of slugs) {
    assert.ok(app.includes("name: '" + slug + "'"), 'route missing: ' + slug);
    assert.ok(sitemap.includes('https://emails.social-browser.com/' + slug), 'sitemap missing: ' + slug);
    const file = path.join(root, 'apps/emails/site_files/html/seo', slug + '.html');
    const html = fs.readFileSync(file, 'utf8');
    assert.ok(html.includes('<h1>'), slug + ' H1 missing');
    assert.ok(html.includes('rel="canonical" href="https://emails.social-browser.com/' + slug + '"'), slug + ' canonical missing');
    assert.ok(html.includes('application/ld+json'), slug + ' structured data missing');
    assert.ok(html.includes('Temporary email guides'), slug + ' internal related links missing');
}
console.log('SEO landing pages, canonical metadata and sitemap checks passed');
