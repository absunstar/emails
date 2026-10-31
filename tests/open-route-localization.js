'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {createNativeTemplateRenderer}=require('../apps/emails/core/native-template');
const root=path.join(__dirname,'..');const template=path.join(root,'apps/emails/site_files/html/open.html');
const renderer=createNativeTemplateRenderer({cwd:root,dir:path.join(root,'site_files'),options:{lang:'En'}});
const langs=['en','ar','es','pt','de','fr','hi','ru','id','tr','vi'];
for(const code of langs){
 const url=(code==='en'?'/open':'/'+code+'/open')+'#email=pubg%40egytag.com';
 const html=renderer.render(template,{url,headers:{host:'emails.egytag.com'}});
 assert(!html.includes('##word.'), 'Untranslated keys on '+code);
 assert(html.includes('lang="'+code+'"'), 'Incorrect language on '+code);
 assert(html.includes('data-email-language-switch'), 'Missing language selector on '+code);
 assert(html.includes('value="'+code+'" selected'), 'Selected language not displayed on '+code);
 assert(html.includes('id="web"'), 'Web inbox path is required');
 assert(html.includes('id="openApp"'), 'Existing Android app deep link must be preserved');
 assert(html.includes('id="play"')&&html.includes('id="apk"'), 'Mobile install options must remain');
 assert(html.includes('data-copy-failed='), 'Copy feedback translation missing');
 assert(html.includes('inbox.searchParams.set(\'email\',email)'), 'Public address must be passed to web inbox');
 assert(html.includes('location.hash'), 'Existing mobile QR hash format must remain supported');
 for(const [,script] of html.matchAll(/<script(?:[^>]*)>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(()=>new Function(script),'Malformed inline script for '+code);
}
const app=fs.readFileSync(path.join(root,'apps/emails/app.js'),'utf8');
assert(app.includes("name: 'open', path: __dirname + '/site_files/html/open.html', parser: 'html css js'"));
assert(app.includes("name: 'o', path: __dirname + '/site_files/html/open.html', parser: 'html css js'"));
assert(fs.readFileSync(template,'utf8').includes('navigator.clipboard?.writeText'));
console.log('Open route: 11 languages, direct alias renderer, Android/web alternatives and copy feedback PASS');
