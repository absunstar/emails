'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(
  path.join(__dirname, '..', 'apps', 'emails', 'site_files', 'html', 'free.html'),
  'utf8'
);

assert(html.includes('mobile-download-actions'), 'Android download action group is missing');
assert(
  html.includes('https://play.google.com/store/apps/details?id=com.egytag.mails'),
  'Google Play link is missing'
);
assert(
  html.includes('/downloads/vip-temp-mail-latest.apk'),
  'stable direct APK download link is missing'
);
assert(html.includes('Download APK'), 'direct APK button label is missing');
assert(html.includes('Latest version'), 'latest-version label is missing');

console.log('Direct Android download CTA contract passed');
