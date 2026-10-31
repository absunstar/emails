'use strict';
// Exact public language registry and URL-prefix convention used by Social Browser.
const languages = Object.freeze({
 en:{id:'En',name:'en',title:'English',dir:'ltr',text:'left',urlPrefix:''},
 ar:{id:'Ar',name:'ar',title:'العربية',dir:'rtl',text:'right',urlPrefix:'/ar'},
 es:{id:'Es',name:'es',title:'Español',dir:'ltr',text:'left',urlPrefix:'/es'},
 pt:{id:'Pt',name:'pt',title:'Português',dir:'ltr',text:'left',urlPrefix:'/pt'},
 de:{id:'De',name:'de',title:'Deutsch',dir:'ltr',text:'left',urlPrefix:'/de'},
 fr:{id:'Fr',name:'fr',title:'Français',dir:'ltr',text:'left',urlPrefix:'/fr'},
 hi:{id:'Hi',name:'hi',title:'हिन्दी',dir:'ltr',text:'left',urlPrefix:'/hi'},
 ru:{id:'Ru',name:'ru',title:'Русский',dir:'ltr',text:'left',urlPrefix:'/ru'},
 id:{id:'Id',name:'id',title:'Bahasa Indonesia',dir:'ltr',text:'left',urlPrefix:'/id'},
 tr:{id:'Tr',name:'tr',title:'Türkçe',dir:'ltr',text:'left',urlPrefix:'/tr'},
 vi:{id:'Vi',name:'vi',title:'Tiếng Việt',dir:'ltr',text:'left',urlPrefix:'/vi'}
});
const codes = Object.keys(languages);
const publicPages=['/','/login','/embed-builder','/embed-examples','/free','/vip','/open','/o','/privacy','/temporary-email','/disposable-email','/verification-code-email','/temp-email-for-testing','/multiple-temporary-inboxes','/developer-temp-mail'];
function fromPath(pathname) {const first=String(pathname||'').split(/[?#]/)[0].split('/').filter(Boolean)[0];return languages[first] ? first : null;}
function prefix(code){return languages[code]?.urlPrefix || '';}
function translatedPath(pathname, code){const old=fromPath(pathname),base=old?pathname.slice(old.length+1)||'/':pathname;return prefix(code)+(base==='/'?'/':base);}
module.exports={languages,codes,publicPages,fromPath,prefix,translatedPath};
