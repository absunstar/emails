'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const html = fs.readFileSync('apps/emails/site_files/html/free.html','utf8');
const src = fs.readFileSync('apps/emails/site_files/js/index.js','utf8');
for (const [label, fragment] of [
 ['Social Browser alternative', 'data-limit-alert-cta data-quick-mail-link="social_browser"'],
 ['Google Play alternative', 'data-quick-mail-link="android_play" href="https://play.google.com/store/apps/details?id=com.egytag.mails"'],
 ['APK download alternative', 'data-quick-mail-link="android_apk" href="/downloads/VIP-Temp-Mail-5.2.6+18-play-signed.apk"'],
 ['Free replacement path', 'Or continue free on this website']
]) assert(html.includes(fragment), label + ' not offered in full-inbox dialog');
for(const value of ['data-manage-full-inbox','data-replace-address','data-action="replace-saved-address"','data-action="remove-address"']) {
 if(value === 'data-action="remove-address"') assert(src.includes(value));
 else assert(html.includes(value),'Missing full inbox UI '+value);
}
function extract(name, async) { const start = src.indexOf('    '+(async?'async ':'')+'function '+name+'('); const end = src.indexOf('\n    }\n',start); assert(start>=0&&end>start,name+' missing');return src.slice(start,end+6).trim(); }
const emails = Array.from({length:10},(_,i)=>({email:'mail'+i+'@egytag.com',createdAt:100+i,unreadCount:i===0?2:0,messageCount:i===1?5:0,lastMessageAt:i===1?500:0}));
const state = {addressBook:{addresses:emails,active:emails[9].email},client:{addressLimit:10,isSocialBrowser:false},pendingAddressAction:{type:'generate'},pollReady:false};
const options = {innerHTML:'',value:''}, action={textContent:''}, input={value:''};
const q = k=> k==='[data-replace-address]'?options:k==='[data-replace-action]'?action:k==='[data-mail-address]'?input:{};
let confirmation = false,generated=0,checked=0,saved=0,rendered=0,alertClosed=0;
const ctx={mode:'free',state,q,escape:x=>x,normalizeMailbox:x=>x,confirm:()=>confirmation,hideLimitAlert:()=>{alertClosed++;state.pendingAddressAction=null},saveAddressBook:()=>saved++,renderAddressSidebar:()=>rendered++,scheduleLiveReconnect:()=>{},generateEmail:async()=>generated++,checkInbox:async()=>checked++};
vm.createContext(ctx);
vm.runInContext(extract('renderLimitReplacementOptions',false)+'\n'+extract('replaceSavedAddress',true)+'\nthis.runOptions=renderLimitReplacementOptions; this.runReplacement=replaceSavedAddress;',ctx);
(async()=>{
 ctx.runOptions();
 assert(options.innerHTML.includes('mail0@egytag.com'));
 assert(action.textContent.includes('create'));
 options.value='mail1@egytag.com';
 await ctx.runReplacement();
 assert.equal(state.addressBook.addresses.length,10,'Cancellation must preserve saved addresses');
 confirmation=true;
 await ctx.runReplacement();
 assert.equal(state.addressBook.addresses.length,9,'Replacement frees exactly one local slot');
 assert(!state.addressBook.addresses.some(x=>x.email==='mail1@egytag.com'));
 assert.equal(generated,1);assert.equal(saved,1);assert.equal(alertClosed,1);
 state.addressBook.addresses.push({email:'extra@egytag.com',createdAt:200,unreadCount:0});
 state.pendingAddressAction={type:'typed',email:'typed@egytag.com'};
 options.value='mail2@egytag.com';ctx.runOptions();assert(action.textContent.includes('view'));
 await ctx.runReplacement();assert.equal(checked,1);assert.equal(input.value,'typed@egytag.com');
 assert(src.includes('if (!confirm(\'Remove \' + normalized'), 'Manual remove must confirm');
 assert(src.includes('state.client.canRemoveAddress = true;'), 'Guest may free slots');
 assert(!src.includes("Use Social Browser to unlock 100 saved emails and address removal"));
 console.log('Full inbox management: guest removal, replacement, pending typed inbox and cancel checks PASS');
})().catch(e=>{console.error(e);process.exitCode=1});
