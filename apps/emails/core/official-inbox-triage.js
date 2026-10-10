'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROLE_MAILBOXES = new Set([
  'info@social-browser.com', 'support@social-browser.com',
  'info@egytag.com', 'support@egytag.com',
  'info@kids-browser.com', 'support@kids-browser.com',
]);
const AUTOMATED_SENDER = /(?:^|[<@._-])(no-?reply|mailer-daemon|postmaster|bounce|notification|verify|security|otp)(?:[>@._-]|$)/i;
const NONACTIONABLE_SUBJECT = /\b(verification code|one.time password|your code|welcome to|dm[ao]rc|delivery status|undeliverable)\b/i;
const PRIORITY_SUBJECT = /\b(support|urgent|error|bug|issue|problem|billing|refund|payment|partnership|collaboration|integration)\b/i;
function atomicWrite(file, value) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const tmp=file+'.'+process.pid+'.'+crypto.randomBytes(4).toString('hex')+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  fs.renameSync(tmp,file);
}
function emails(value) {
  return [...new Set((String(value||'').match(/[\w.%+-]+@[\w.-]+\.[a-z]{2,}/gi)||[]).map(x=>x.toLowerCase()))];
}
function classify(message) {
  const recipients=emails([message.to,message.cc].join(',')).filter(x=>ROLE_MAILBOXES.has(x));
  if (!recipients.length) return null;
  const sender=emails(message.from)[0]||'';
  const subject=String(message.subject||'');
  const result={recipient:recipients[0],sender,category:'general',priority:'normal',reason:'official_mailbox'};
  if (!sender || sender===recipients[0] || AUTOMATED_SENDER.test(message.from) || NONACTIONABLE_SUBJECT.test(subject) || /auto.submitted|out.of.office/i.test(subject)) {
    return {...result,category:'automated',priority:'low',reason:'automatic_or_nonactionable'};
  }
  if (message.folder==='spam' || message.hasAttachments && /inheritance|loan funding|compensation/i.test(subject)) {
    return {...result,category:'suspected_spam',priority:'low',reason:'spam_signal'};
  }
  if (PRIORITY_SUBJECT.test(subject)) {
    return {...result,category:/partnership|collaboration|integration/i.test(subject)?'partnership':'support',priority:'high',reason:'actionable_subject'};
  }
  return result;
}
class OfficialInboxTriage {
  constructor({emailService, baseDir,logger}={}) {
    if (!emailService) throw new Error('emailService required');
    this.emailService=emailService;
    this.baseDir=path.resolve(baseDir||path.join(process.cwd(),'localStorage','official-inbox-queue'));
    this.logger=logger||(()=>{});
    this.unsubscribe=null;
  }
  file(guid) {
    const hash=crypto.createHash('sha256').update(String(guid)).digest('hex');
    return path.join(this.baseDir,hash+'.json');
  }
  async accept(message) {
    if (!message||!message.guid) return null;
    const kind=classify(message);
    if (!kind) return null;
    const file=this.file(message.guid);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file,'utf8'));
    const status=kind.category==='automated'||kind.category==='suspected_spam'?'ignored':'needs_reply';
    const item={id:crypto.createHash('sha256').update(message.guid).digest('hex'),guid:message.guid,
      status,...kind,subject:String(message.subject||'').slice(0,500),
      createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
      deliveryState:'not_queued',source:'official_inbox'};
    atomicWrite(file,item);
    return item;
  }
  start() {
    if(this.unsubscribe) return this;
    this.unsubscribe=this.emailService.subscribe(evt=>{
      if(evt?.type!=='incoming'||!evt.message) return;
      this.accept(evt.message).catch(error=>this.logger('Official inbox triage failed: '+(error?.message||error)));
    });
    return this;
  }
  stop(){if(this.unsubscribe)this.unsubscribe();this.unsubscribe=null;return this;}
  list({status,limit=100}={}) {
    if(!fs.existsSync(this.baseDir))return {total:0,items:[]};
    const names=fs.readdirSync(this.baseDir).filter(x=>x.endsWith('.json'));
    const rows=[];
    for(const name of names) {
      try {const item=JSON.parse(fs.readFileSync(path.join(this.baseDir,name),'utf8'));if(!status||item.status===status)rows.push(item);}catch(_){}
    }
    rows.sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    return {total:rows.length,items:rows.slice(0,Math.max(1,Math.min(Number(limit)||100,500)))};
  }
}
module.exports={OfficialInboxTriage,classify};
