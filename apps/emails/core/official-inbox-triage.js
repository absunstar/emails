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
const NONACTIONABLE_SUBJECT = /\b(verification code|one.time password|your code|welcome to|dm[ao]rc|delivery status|undeliverable)\b|رمز التحقق|كود التحقق|رمز التأكيد|كلمة مرور لمرة واحدة/i;
const REPORT_SIGNAL = /\bdmarc\b|aggregate report|report domain:|report domain\b|noreply-dmarc|dmarcreport@/i;
const SPAM_SIGNAL = /luxury (?:watches|timepieces)|timeless luxury|custom (?:caps|lanyards)|eco-friendly custom bags|loan funding\s*\/\s*financing offer|inheritance compensation|(?:private business|my) proposal|investment and loan opportunity/i;
const PROMOTION_SENDER = /@(?:runmonetize\.info|adhoopu-tech\.com|lotex-dev\.com|talentube\.net)$/i;
const ROUTING_FOLDERS = Object.freeze({report:'Reports',suspected_spam:'spam',promotion:'Promotions',automated:'Automated'});
const PRIORITY_SUBJECT = /\b(support|urgent|error|bug|issue|problem|billing|refund|payment|partnership|collaboration|integration)\b|مشكلة|خطأ|دعم|عاجل|فاتورة|اشتراك|استرداد|دفع|شراكة|تعاون|تكامل/i;
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
  if (REPORT_SIGNAL.test(subject+' '+sender)) {
    return {...result,category:'report',priority:'low',reason:'security_aggregate_report'};
  }
  if (message.folder==='spam' || SPAM_SIGNAL.test(subject) || /@photo\.vb2tr\.ru$/i.test(sender)) {
    return {...result,category:'suspected_spam',priority:'low',reason:'spam_signal'};
  }
  if (PROMOTION_SENDER.test(sender)) {
    return {...result,category:'promotion',priority:'low',reason:'unsolicited_promotion'};
  }
  if (!sender || sender===recipients[0] || AUTOMATED_SENDER.test(message.from) || NONACTIONABLE_SUBJECT.test(subject) || /auto.submitted|out.of.office/i.test(subject)) {
    return {...result,category:'automated',priority:'low',reason:'automatic_or_nonactionable'};
  }
  if (PRIORITY_SUBJECT.test(subject)) {
    return {...result,category:/partnership|collaboration|integration|شراكة|تعاون|تكامل/i.test(subject)?'partnership':'support',priority:'high',reason:'actionable_subject'};
  }
  return result;
}
class OfficialInboxTriage {
  constructor({emailService, scheduler, autoAckSupport=false, baseDir,logger}={}) {
    if (!emailService) throw new Error('emailService required');
    this.emailService=emailService;
    this.scheduler=scheduler||null;
    this.autoAckSupport=!!autoAckSupport;
    this.baseDir=path.resolve(baseDir||path.join(process.cwd(),'localStorage','official-inbox-queue'));
    this.logger=logger||(()=>{});
    this.unsubscribe=null;
    this.ackChain=Promise.resolve();
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
    const status=ROUTING_FOLDERS[kind.category]?'ignored':'needs_reply';
    const item={id:crypto.createHash('sha256').update(message.guid).digest('hex'),guid:message.guid,
      status,...kind,subject:String(message.subject||'').slice(0,500),
      createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),
      deliveryState:'not_queued',source:'official_inbox'};
    atomicWrite(file,item);
    const targetFolder=ROUTING_FOLDERS[kind.category];
    if (targetFolder && typeof this.emailService.update==='function' &&
        !(typeof this.emailService.isVipMessage==='function' && this.emailService.isVipMessage(message))) {
      try {
        await this.emailService.update(message.guid,{folder:targetFolder,read:true},{allowVip:false});
      } catch(error) {
        this.logger('Official inbox routing failed: '+(error?.message||error));
      }
    }
    if(this.autoAckSupport && this.scheduler && kind.category==='support' && kind.recipient.startsWith('support@')) {
      const work=this.ackChain.catch(()=>{}).then(()=>this.acknowledge(item,file));
      this.ackChain=work;
      await work;
    }
    return item;
  }
  async acknowledge(item,file) {
    // Limited receipt acknowledgement, not an AI-generated answer or a bypass for blocked mail.
    try {
      const original=(await this.emailService.read(item.guid,{allowVip:true})).message;
      if(!String(original.text||'').trim() || String(original.text||'').trim().length<15) return;
      if(!/\b(support|error|bug|issue|problem|refund|billing)\b|مشكلة|خطأ|دعم|استرداد|فاتورة|اشتراك/i.test(item.subject))return;
      const now=Date.now();
      const recent=this.list({limit:500}).items.filter(row=>row.ackScheduledAt && now-Date.parse(row.ackScheduledAt)<86400000);
      if(recent.length>=10) return;
      if(recent.some(row=>row.sender===item.sender && now-Date.parse(row.ackScheduledAt)<7*86400000)) return;
      const originalId=String(original.messageId||'');
      const sendAt=new Date(now+15000).toISOString();
      const text=item.recipient.endsWith('@egytag.com') ? 'شكرًا لتواصلك مع فريق الدعم. تم استلام رسالتك وسنراجع تفاصيلها. يمكنك إضافة أي معلومات أخرى من خلال الرد على نفس المحادثة.\n\nفريق دعم إيجي تاج' : 'Thank you for contacting our support team. We have received your message and will review the details. Please keep this email thread for any additional information.\n\nSupport Team';
      const task=await this.scheduler.schedule({message:{from:item.recipient,to:item.sender,
        subject:/^re\s*:/i.test(item.subject)?item.subject:'Re: '+item.subject,text,
        inReplyTo:originalId},sendAt,maxRetries:2,retryDelaySeconds:300},{client:'official-support-auto-ack'});
      item.status='ack_queued';
      item.ackScheduledAt=new Date().toISOString();
      item.scheduleId=task.id;
      item.deliveryState='scheduled';
      item.updatedAt=new Date().toISOString();
      atomicWrite(file,item);
    } catch(error) {
      item.ackError=String(error?.message||error).slice(0,500);
      item.updatedAt=new Date().toISOString();
      atomicWrite(file,item);
      this.logger('Official support acknowledgement was not queued: '+item.ackError);
    }
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
    const selected=rows.slice(0,Math.max(1,Math.min(Number(limit)||100,500)));
    for (const item of selected) if(item.scheduleId && this.scheduler) {
      try { const task=this.scheduler.get(item.scheduleId,false); item.deliveryState=task.status; item.deliveryError=task.lastError||''; } catch(_){}
    }
    return {total:rows.length,items:selected};
  }
}
module.exports={OfficialInboxTriage,classify};
