'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {languages,publicPages,translatedPath}=require('../apps/emails/core/languages');
const {createNativeTemplateRenderer}=require('../apps/emails/core/native-template');
const site={cwd:path.resolve('.'),dir:path.resolve('site_files'),options:{lang:'En'}};
const renderer=createNativeTemplateRenderer(site);
const entries=fs.readFileSync('apps/emails/app.js','utf8');
const words=require('../apps/emails/site_files/json/words-localized.json');
const langs=Object.keys(languages);
assert.deepEqual(langs,['en','ar','es','pt','de','fr','hi','ru','id','tr','vi']);
assert(publicPages.includes('/open')&&publicPages.includes('/temporary-email'));
assert.match(entries,/Object\.keys\(emailLanguages\)\.forEach/);
assert(words.length>=350);
assert(words.every(row=>langs.every(code=>!!row[languages[code].id])),'Each word must have translations for all supported languages');
for(const [code,language] of Object.entries(languages)){
 for(const [page,file] of [['/','free.html'],['/temporary-email','seo/temporary-email.html'],['/open','open.html']]){
  const url='/'+code+(page==='/'?'/':page);
  const html=renderer.render(path.join(site.cwd,'apps/emails/site_files/html',file),{url,headers:{host:'emails.egytag.com'}});
  assert(html.includes('<html lang="'+code+'" dir="'+language.dir+'"'),code+page+' lang/dir incorrect');
  assert(html.includes('data-email-language-switch'),code+page+' needs language menu');
  assert(html.includes('value="'+code+'" selected'),code+page+' should highlight selected language');
  assert(!html.includes('##word.'),code+page+' contains unresolved words');
  assert(html.includes('rel="canonical" href="https://emails.egytag.com'+(language.urlPrefix+(page==='/'?'/':page))+'"'),code+page+' canonical');
  assert(html.includes('hreflang="ar"')&&html.includes('hreflang="vi"'),code+page+' hreflang coverage');
  assert(!html.includes('href="'+language.urlPrefix+'/api/'), 'Never prefix API');
  if(code==='ar')assert(html.includes('البريد')||html.includes('بريد'),page+' Arabic text missing');
 }
}
assert.equal(translatedPath('/ar/temporary-email','es'),'/es/temporary-email');
assert.equal(translatedPath('/ar/temporary-email','en'),'/temporary-email');
assert.equal(translatedPath('/ar','en'),'/');
assert.match(fs.readFileSync('apps/emails/site_files/js/index.js','utf8'),/window\.emailLocalizedPath/);
console.log('Social Browser-compatible 11-language routing, translated HTML/SEO, RTL, switcher, deep links and dictionary PASS');
