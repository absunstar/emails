'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { normalizeHostname, mailDomainFromHostname } = require('./domain');
const { verifyMailDomain } = require('./domain-verifier');

function ensureDir(dir){ fs.mkdirSync(dir,{recursive:true}); }
function clone(v){ return JSON.parse(JSON.stringify(v)); }
function now(){ return new Date().toISOString(); }
function id(prefix){ return prefix + (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex')).replace(/[^a-zA-Z0-9_-]/g,''); }
function atomicWrite(file,data){ ensureDir(path.dirname(file)); const tmp=file+'.'+process.pid+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(data,null,2)+'\n',{mode:0o600}); fs.renameSync(tmp,file); }
function read(file){ try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(_){return null;} }
function email(v){ const s=String(v||'').trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)?s:''; }
function domain(v){ return normalizeHostname(v); }

class MailTenantRegistry{
  constructor(options={}){
    this.file=path.resolve(options.filePath||path.join(process.cwd(),'localStorage','email-tenants','registry.json'));
    this.instanceConfig=options.instanceConfig||null;
    this.data=read(this.file)||{schemaVersion:1,organizations:[],domains:[],senders:[],senderPools:[],updatedAt:''};
    if(!Array.isArray(this.data.senderPools)) this.data.senderPools=[];
    this._ensureDefault();
    this._save();
  }
  _save(){ this.data.updatedAt=now(); atomicWrite(this.file,this.data); }
  _ensureDefault(){
    let org=this.data.organizations.find(x=>x.isDefault);
    if(!org){
      const name=this.instanceConfig?.get?.().instance?.name||'Default Organization';
      org={id:id('org_'),name,slug:'default',status:'active',isDefault:true,createdAt:now(),updatedAt:now()};
      this.data.organizations.push(org);
    }
    const configured = this.instanceConfig?.get?.().network?.mailDomains || [];
    const envDomains = [process.env.DKIM_ALLOWED_DOMAINS, process.env.LOCAL_MAIL_DOMAINS]
      .filter(Boolean).flatMap(value => String(value).split(/[\s,]+/)).filter(Boolean);
    const smtpHost = this.instanceConfig?.get?.().network?.smtpHostname || '';
    const domains=[...new Set([...configured, ...envDomains, mailDomainFromHostname(smtpHost)].map(domain).filter(Boolean))];
    for(const d0 of domains){
      const d=domain(d0); if(!d)continue;
      if(!this.data.domains.some(x=>x.domain===d)){
        this.data.domains.push({id:id('domain_'),organizationId:org.id,domain:d,status:'pending',verification:{mx:'unknown',spf:'unknown',dkim:'unknown',dmarc:'unknown'},createdAt:now(),updatedAt:now()});
      }
    }
  }
  status(){ return {organizations:this.data.organizations.length,domains:this.data.domains.length,senders:this.data.senders.length,senderPools:this.data.senderPools.length,file:this.file,updatedAt:this.data.updatedAt}; }
  listOrganizations(){ return clone(this.data.organizations); }
  createOrganization(input={}){
    const name=String(input.name||'').trim(); if(!name) throw new Error('Organization name is required');
    const slug=String(input.slug||name).toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80)||'org';
    if(this.data.organizations.some(x=>x.slug===slug)) throw new Error('Organization slug already exists');
    const row={id:id('org_'),name,slug,status:'active',isDefault:false,createdAt:now(),updatedAt:now()};
    this.data.organizations.push(row); this._save(); return clone(row);
  }
  updateOrganization(idv,patch={}){
    const row=this.data.organizations.find(x=>x.id===idv); if(!row) throw new Error('Organization not found');
    if(patch.name!=null) row.name=String(patch.name).trim()||row.name;
    if(patch.status!=null) row.status=['active','disabled'].includes(String(patch.status))?String(patch.status):row.status;
    row.updatedAt=now(); this._save(); return clone(row);
  }
  listDomains(input={}){
    let rows=this.data.domains;
    if(input.organizationId) rows=rows.filter(x=>x.organizationId===input.organizationId);
    if(input.status) rows=rows.filter(x=>x.status===input.status);
    return clone(rows);
  }
  addDomain(input={}){
    const orgId=String(input.organizationId||'').trim()||this.data.organizations.find(x=>x.isDefault)?.id;
    if(!this.data.organizations.some(x=>x.id===orgId)) throw new Error('Organization not found');
    const d=domain(input.domain); if(!d) throw new Error('Valid domain is required');
    if(this.data.domains.some(x=>x.domain===d)) throw new Error('Domain already exists');
    const row={id:id('domain_'),organizationId:orgId,domain:d,status:'pending',dkimSelector:String(input.dkimSelector||process.env.DKIM_SELECTOR||'mail').trim()||'mail',verification:{mx:'unknown',spf:'unknown',dkim:'unknown',dmarc:'unknown'},notes:String(input.notes||''),createdAt:now(),updatedAt:now()};
    this.data.domains.push(row); this._save(); return clone(row);
  }
  async verifyDomain(idv, options={}){
    const row=this.data.domains.find(x=>x.id===idv); if(!row) throw new Error('Domain not found');
    const result=await verifyMailDomain(row.domain,{selector:row.dkimSelector||'default',...options});
    row.status=result.status;
    row.verification={
      mx:result.checks.mx.status, spf:result.checks.spf.status, dkim:result.checks.dkim.status, dmarc:result.checks.dmarc.status,
      checkedAt:result.checkedAt, recommendations:result.recommendations, details:result.checks
    };
    row.updatedAt=now(); this._save(); return {domain:clone(row),verification:result};
  }
  senderReadiness(idv){
    const sender=this.data.senders.find(x=>x.id===idv); if(!sender) throw new Error('Sender identity not found');
    const d=this.data.domains.find(x=>x.id===sender.domainId);
    const reasons=[];
    if(sender.status==='disabled') reasons.push('sender_disabled');
    if(sender.status==='warming') reasons.push('sender_warming');
    if(!d) reasons.push('domain_missing');
    else {
      if(d.status!=='verified') reasons.push('domain_not_verified');
      for(const key of ['spf','dkim','dmarc']) if(d.verification?.[key]!=='pass') reasons.push(key+'_not_ready');
    }
    return {ready:reasons.length===0,sender:clone(sender),domain:d?clone(d):null,reasons};
  }
  updateDomain(idv,patch={}){
    const row=this.data.domains.find(x=>x.id===idv); if(!row) throw new Error('Domain not found');
    if(patch.status!=null && ['pending','verified','warning','disabled'].includes(String(patch.status))) row.status=String(patch.status);
    if(patch.verification&&typeof patch.verification==='object') row.verification=Object.assign({},row.verification,patch.verification);
    if(patch.dkimSelector!=null) row.dkimSelector=String(patch.dkimSelector).trim()||row.dkimSelector;
    if(patch.notes!=null) row.notes=String(patch.notes);
    row.updatedAt=now(); this._save(); return clone(row);
  }
  removeDomain(idv){
    const row=this.data.domains.find(x=>x.id===idv); if(!row) throw new Error('Domain not found');
    if(this.data.senders.some(x=>x.domainId===idv)) throw new Error('Remove sender identities for this domain first');
    this.data.domains=this.data.domains.filter(x=>x.id!==idv); this._save(); return {id:idv,deleted:true};
  }
  listSenders(input={}){
    let rows=this.data.senders;
    if(input.organizationId) rows=rows.filter(x=>x.organizationId===input.organizationId);
    if(input.domainId) rows=rows.filter(x=>x.domainId===input.domainId);
    if(input.status) rows=rows.filter(x=>x.status===input.status);
    return clone(rows);
  }
  addSender(input={}){
    const addr=email(input.email); if(!addr) throw new Error('Valid sender email is required');
    if(this.data.senders.some(x=>x.email===addr)) throw new Error('Sender identity already exists');
    const d=addr.split('@')[1];
    const domainRow=this.data.domains.find(x=>x.id===input.domainId)||this.data.domains.find(x=>x.domain===d);
    if(!domainRow) throw new Error('Sender domain is not registered');
    if(domainRow.domain!==d) throw new Error('Sender email does not match selected domain');
    const row={id:id('sender_'),organizationId:domainRow.organizationId,domainId:domainRow.id,email:addr,displayName:String(input.displayName||'').trim(),replyTo:email(input.replyTo)||'',status:['active','disabled','warming'].includes(String(input.status))?String(input.status):'active',tags:Array.isArray(input.tags)?[...new Set(input.tags.map(x=>String(x).trim()).filter(Boolean))]:[],createdAt:now(),updatedAt:now()};
    this.data.senders.push(row); this._save(); return clone(row);
  }
  updateSender(idv,patch={}){
    const row=this.data.senders.find(x=>x.id===idv); if(!row) throw new Error('Sender identity not found');
    if(patch.displayName!=null) row.displayName=String(patch.displayName).trim();
    if(patch.replyTo!=null) row.replyTo=email(patch.replyTo)||'';
    if(patch.status!=null && ['active','disabled','warming'].includes(String(patch.status))) row.status=String(patch.status);
    if(Array.isArray(patch.tags)) row.tags=[...new Set(patch.tags.map(x=>String(x).trim()).filter(Boolean))];
    row.updatedAt=now(); this._save(); return clone(row);
  }
  removeSender(idv){ const row=this.data.senders.find(x=>x.id===idv); if(!row) throw new Error('Sender identity not found'); if(this.data.senderPools.some(x=>(x.senderIds||[]).includes(idv))) throw new Error('Remove sender identity from sender pools first'); this.data.senders=this.data.senders.filter(x=>x.id!==idv); this._save(); return {id:idv,deleted:true}; }
  listSenderPools(input={}){
    let rows=this.data.senderPools;
    if(input.organizationId) rows=rows.filter(x=>x.organizationId===input.organizationId);
    if(input.status) rows=rows.filter(x=>x.status===input.status);
    return clone(rows);
  }
  addSenderPool(input={}){
    const orgId=String(input.organizationId||'').trim()||this.data.organizations.find(x=>x.isDefault)?.id;
    if(!this.data.organizations.some(x=>x.id===orgId)) throw new Error('Organization not found');
    const name=String(input.name||'').trim(); if(!name) throw new Error('Sender pool name is required');
    const senderIds=[...new Set((Array.isArray(input.senderIds)?input.senderIds:[]).map(x=>String(x).trim()).filter(Boolean))];
    if(!senderIds.length) throw new Error('Sender pool requires at least one sender identity');
    const senders=senderIds.map(id=>this.data.senders.find(x=>x.id===id));
    if(senders.some(x=>!x)) throw new Error('One or more sender identities were not found');
    if(senders.some(x=>x.organizationId!==orgId)) throw new Error('All sender identities must belong to the selected organization');
    const row={id:id('pool_'),organizationId:orgId,name,description:String(input.description||''),senderIds,mode:['rotate','single'].includes(String(input.mode))?String(input.mode):'rotate',status:['active','disabled'].includes(String(input.status))?String(input.status):'active',createdAt:now(),updatedAt:now()};
    this.data.senderPools.push(row); this._save(); return clone(row);
  }
  updateSenderPool(idv,patch={}){
    const row=this.data.senderPools.find(x=>x.id===idv); if(!row) throw new Error('Sender pool not found');
    if(patch.name!=null) row.name=String(patch.name).trim()||row.name;
    if(patch.description!=null) row.description=String(patch.description);
    if(patch.mode!=null && ['rotate','single'].includes(String(patch.mode))) row.mode=String(patch.mode);
    if(patch.status!=null && ['active','disabled'].includes(String(patch.status))) row.status=String(patch.status);
    if(Array.isArray(patch.senderIds)){
      const ids=[...new Set(patch.senderIds.map(x=>String(x).trim()).filter(Boolean))];
      if(!ids.length) throw new Error('Sender pool requires at least one sender identity');
      const senders=ids.map(id=>this.data.senders.find(x=>x.id===id));
      if(senders.some(x=>!x)) throw new Error('One or more sender identities were not found');
      if(senders.some(x=>x.organizationId!==row.organizationId)) throw new Error('All sender identities must belong to the pool organization');
      row.senderIds=ids;
    }
    row.updatedAt=now(); this._save(); return clone(row);
  }
  removeSenderPool(idv){ const row=this.data.senderPools.find(x=>x.id===idv); if(!row) throw new Error('Sender pool not found'); this.data.senderPools=this.data.senderPools.filter(x=>x.id!==idv); this._save(); return {id:idv,deleted:true}; }
  senderPoolReadiness(idv){
    const pool=this.data.senderPools.find(x=>x.id===idv); if(!pool) throw new Error('Sender pool not found');
    const members=pool.senderIds.map(id=>this.senderReadiness(id));
    const readyMembers=members.filter(x=>x.ready);
    return {ready:pool.status==='active'&&readyMembers.length===pool.senderIds.length,pool:clone(pool),members,readyCount:readyMembers.length,total:members.length};
  }
  organizationDomains(organizationId){ return this.data.domains.filter(x=>x.organizationId===organizationId).map(x=>x.domain); }
  organizationSenders(organizationId){ return this.data.senders.filter(x=>x.organizationId===organizationId).map(x=>x.email); }
  getOrganization(idv){ return clone(this.data.organizations.find(x=>x.id===idv)||null); }
  resolveOrganizationByDomain(d){ const row=this.data.domains.find(x=>x.domain===domain(d)); return row?clone(this.data.organizations.find(x=>x.id===row.organizationId)||null):null; }
  resolveSender(addr){ const a=email(addr); const row=this.data.senders.find(x=>x.email===a); return clone(row||null); }
}
function createMailTenantRegistry(options){ return new MailTenantRegistry(options); }
module.exports={MailTenantRegistry,createMailTenantRegistry};
