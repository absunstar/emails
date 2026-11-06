'use strict';

const dns = require('node:dns').promises;

function txtJoin(rows){ return (rows||[]).map(parts=>Array.isArray(parts)?parts.join(''):String(parts||'')); }
async function safe(fn){ try{return {ok:true,value:await fn()};}catch(error){return {ok:false,error:error?.code||error?.message||String(error)};} }
function status(ok){ return ok?'pass':'fail'; }

async function verifyMailDomain(domain, options={}){
  const selector=String(options.selector||'default').trim()||'default';
  const resolveMx=options.resolveMx||dns.resolveMx;
  const resolveTxt=options.resolveTxt||dns.resolveTxt;

  const mxRes=await safe(()=>resolveMx(domain));
  const mx=mxRes.ok && Array.isArray(mxRes.value) && mxRes.value.length>0;

  const rootTxtRes=await safe(()=>resolveTxt(domain));
  const rootTxt=rootTxtRes.ok?txtJoin(rootTxtRes.value):[];
  const spfRecords=rootTxt.filter(v=>/^v=spf1\b/i.test(v.trim()));
  const spf=spfRecords.length===1;

  const dkimHost=selector+'._domainkey.'+domain;
  const dkimRes=await safe(()=>resolveTxt(dkimHost));
  const dkimTxt=dkimRes.ok?txtJoin(dkimRes.value):[];
  const dkimRecords=dkimTxt.filter(v=>/(^|;)\s*v\s*=\s*DKIM1\b/i.test(v));
  const dkim=dkimRecords.length>0 && dkimRecords.some(v=>/(^|;)\s*p\s*=\s*[^;\s]+/i.test(v));

  const dmarcHost='_dmarc.'+domain;
  const dmarcRes=await safe(()=>resolveTxt(dmarcHost));
  const dmarcTxt=dmarcRes.ok?txtJoin(dmarcRes.value):[];
  const dmarcRecords=dmarcTxt.filter(v=>/^v=DMARC1\b/i.test(v.trim()));
  const dmarc=dmarcRecords.length===1;

  const checks={
    mx:{status:status(mx),records:mxRes.ok?mxRes.value:[],error:mxRes.ok?'':mxRes.error},
    spf:{status:status(spf),records:spfRecords,error:rootTxtRes.ok?'':rootTxtRes.error},
    dkim:{status:status(dkim),host:dkimHost,records:dkimRecords,error:dkimRes.ok?'':dkimRes.error},
    dmarc:{status:status(dmarc),host:dmarcHost,records:dmarcRecords,error:dmarcRes.ok?'':dmarcRes.error},
  };
  const failures=Object.entries(checks).filter(([,v])=>v.status!=='pass').map(([k])=>k);
  const overall=failures.length===0?'verified':failures.length<=2?'warning':'pending';
  const recommendations=[];
  if(!mx) recommendations.push('Publish at least one MX record for '+domain+'.');
  if(spfRecords.length===0) recommendations.push('Publish one SPF TXT record starting with v=spf1.');
  else if(spfRecords.length>1) recommendations.push('Merge multiple SPF records into a single SPF TXT record.');
  if(!dkim) recommendations.push('Publish a DKIM TXT record at '+dkimHost+' with v=DKIM1 and a non-empty p= value.');
  if(dmarcRecords.length===0) recommendations.push('Publish a DMARC TXT record at '+dmarcHost+' starting with v=DMARC1.');
  else if(dmarcRecords.length>1) recommendations.push('Keep only one DMARC policy record at '+dmarcHost+'.');

  return {domain,selector,status:overall,verified:overall==='verified',checks,recommendations,checkedAt:new Date().toISOString()};
}

module.exports={verifyMailDomain};
