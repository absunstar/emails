(function(){'use strict';
const codes=['en','ar','es','pt','de','fr','hi','ru','id','tr','vi'];
const pick=document.querySelector('[data-email-language-switch]');
const getCode=()=>{const first=location.pathname.split('/').filter(Boolean)[0];return codes.includes(first)?first:'en'};
function localizedPath(code){
 const current=getCode();let path=location.pathname;
 if(path==='/'+current||path==='/'+current+'/')path='/';
 else if(path.startsWith('/'+current+'/'))path=path.slice(current.length+1)||'/';
 if(code==='en')return path||'/';return '/'+code+(path==='/'?'/':path);
}
window.emailLocalizedPath=function(path){const code=getCode();return code==='en'?path:'/'+code+path};
if(pick){pick.value=getCode();pick.addEventListener('change',function(){if(!codes.includes(this.value))return;location.assign(localizedPath(this.value)+location.search+location.hash)});}
const dictionary=window.__emailUITranslation||{};
window.emailTranslate=function(text){return dictionary[String(text)]||String(text)};
function translateNodes(host){
 if(!host||getCode()==='en')return;
 const walker=document.createTreeWalker(host,NodeFilter.SHOW_TEXT);let node;
 while((node=walker.nextNode())){if(node.parentElement?.closest('.mail-message-copy,.mail-sender-name,.mail-sender-email,.mail-message-subject,.mailbox-address-copy,.qr-email,.mail-address,.sb-mail-meta,.sb-mail-subject'))continue;
 const raw=node.nodeValue||'';const key=raw.trim();if(key&&dictionary[key]&&dictionary[key]!==key)node.nodeValue=raw.replace(key,dictionary[key]);
 }
}

if(getCode()!=='en'){
 const allowed='.smart-inbox-empty,.empty-inbox,.mail-new-badge,.mail-attachment-badge,.otp-copy-label,.otp-copy-action,.mail-message-view-btn,.sb-toast,.mailbox-limit,.mailbox-secondary-tools,.mailbox-address-empty';
 const observer=new MutationObserver(mutations=>{for(const m of mutations){for(const n of m.addedNodes||[]){if(n.nodeType!==1)continue;if(n.matches?.(allowed))translateNodes(n);for(const el of n.querySelectorAll?.(allowed)||[])translateNodes(el);} if(m.type==='characterData'&&m.target.parentElement?.closest(allowed))translateNodes(m.target.parentElement);}});
 observer.observe(document.body,{subtree:true,childList:true,characterData:true});
 document.querySelectorAll(allowed).forEach(translateNodes);
}
})();
