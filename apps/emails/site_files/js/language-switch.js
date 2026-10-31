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
const nav=document.querySelector('.sb-navbar');
if(nav){
 const syncHeight=()=>document.documentElement.style.setProperty('--email-nav-height',Math.ceil(nav.getBoundingClientRect().height)+'px');
 syncHeight();window.addEventListener('resize',syncHeight,{passive:true});
 if(typeof ResizeObserver==='function')new ResizeObserver(syncHeight).observe(nav);
}
const dictionary=window.__emailUITranslation||{};
window.emailTranslate=function(text){return dictionary[String(text)]||String(text)};
function translateNodes(host){
 if(!host||getCode()==='en')return;
 const walker=document.createTreeWalker(host,NodeFilter.SHOW_TEXT);let node;
 while((node=walker.nextNode())){
  const el=node.parentElement;
  if(el?.closest('.mail-message-copy,.mail-sender-name,.mail-sender-email,.mail-message-subject,.qr-email,.mail-address,.sb-mail-meta,.sb-mail-subject'))continue;
  const status=el?.matches('.mailbox-address-copy small');
  if(el?.closest('.mailbox-address-copy')&&!status)continue;
  const raw=node.nodeValue||'',key=raw.trim();if(!key)continue;
  if(status&&!/^[0-9]+ messages?(?:\s|$)/i.test(key))continue;
  let value=dictionary[key]||key;
  if(value===key){
   value=key.replace(/^([0-9]+) (message|messages)(?=\b|\s|$)/i,(_,n,word)=>n+' '+(dictionary[word]||word));
   value=value.replace(/checked now/gi,m=>dictionary[m]||dictionary['checked now']||m);
  }
  if(value!==key)node.nodeValue=raw.replace(key,value);
 }
}

if(getCode()!=='en'){
 const allowed='.smart-inbox-empty,.empty-inbox,.mail-new-badge,.mail-attachment-badge,.otp-copy-label,.otp-copy-action,.mail-message-view-btn,.sb-toast,.mailbox-limit,.mailbox-secondary-tools,.mailbox-address-empty,.mailbox-tier,.mailbox-preference-row,.mailbox-live,.inbox-live-state,[data-inbox-total],.mailbox-address-copy small';
 const observer=new MutationObserver(mutations=>{for(const m of mutations){for(const n of m.addedNodes||[]){if(n.nodeType===3){if(n.parentElement?.closest(allowed))translateNodes(n.parentElement);continue;}if(n.nodeType!==1)continue;if(n.matches?.(allowed))translateNodes(n);for(const el of n.querySelectorAll?.(allowed)||[])translateNodes(el);} if(m.type==='characterData'&&m.target.parentElement?.closest(allowed))translateNodes(m.target.parentElement);}});
 observer.observe(document.body,{subtree:true,childList:true,characterData:true});
 document.querySelectorAll(allowed).forEach(translateNodes);
}
})();
