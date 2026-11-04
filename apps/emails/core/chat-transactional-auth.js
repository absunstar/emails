'use strict';
const crypto=require('node:crypto'),fs=require('node:fs'),path=require('node:path');
const FROM='chat@egytag.com';
function credentials(root){
 const location=process.env.EMAIL_CHAT_API_KEY_FILE||path.join(root,'localStorage','keys','chat-live.key');
 try{const value=fs.readFileSync(location,'utf8').trim();return value.length>=40?value:''}catch{return ''}
}
function allowed(req,root){
 const secret=credentials(root),auth=String(req?.headers?.authorization||'');
 if(!secret||!auth.startsWith('Bearer '))return false;
 const provided=auth.slice(7).trim();
 const a=Buffer.from(provided),b=Buffer.from(secret);
 return a.length===b.length&&crypto.timingSafeEqual(a,b);
}
function parse(data){
 const to=String(data?.to||'').trim(),subject=String(data?.subject||''),text=String(data?.text||''),html=data?.html===undefined?'':data.html;
 if(typeof data?.to!=='string'||!/^[^\s@<>]+@[^\s@<>]+\.[a-z]{2,}$/i.test(to)||to.length>254)throw Error('INVALID_RECIPIENT');
 if(typeof data?.subject!=='string'||subject.length<1||subject.length>180||/[\r\n]/.test(subject))throw Error('INVALID_SUBJECT');
 if(typeof data?.text!=='string'||text.length<1||text.length>25000)throw Error('INVALID_CONTENT');
 if(data.from&&data.from!==FROM)throw Error('SENDER_NOT_ALLOWED');
 if(typeof html!=='string'||html.length>55000)throw Error('INVALID_HTML');
 // Restricted account-verification HTML only. The API key is not a generic
 // arbitrary-HTML sending authority.
 if(/<(?:script|iframe|object|embed|form|video|audio|svg|math)\b|\bon[a-z]+\s*=|javascript\s*:|data\s*:/i.test(html))throw Error('UNSAFE_HTML');
 return {from:FROM,to,subject,text,html,listUnsubscribe:false};
}
module.exports={allowed,credentials,parse,FROM};
