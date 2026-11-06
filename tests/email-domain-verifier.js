'use strict';
const assert = require('assert');
const { verifyMailDomain } = require('../apps/emails/core/domain-verifier');

(async()=>{
  const good = await verifyMailDomain('example.test',{
    selector:'mail',
    resolveMx:async()=>[{exchange:'mx.example.test',priority:10}],
    resolveTxt:async(host)=>{
      if(host==='example.test') return [['v=spf1 ip4:203.0.113.10 -all']];
      if(host==='mail._domainkey.example.test') return [['v=DKIM1; k=rsa; p=ABC123']];
      if(host==='_dmarc.example.test') return [['v=DMARC1; p=quarantine; rua=mailto:dmarc@example.test']];
      throw Object.assign(new Error('not found'),{code:'ENOTFOUND'});
    }
  });
  assert.equal(good.verified,true);
  assert.equal(good.status,'verified');
  assert.equal(good.checks.spf.status,'pass');
  assert.equal(good.checks.dkim.status,'pass');
  assert.equal(good.checks.dmarc.status,'pass');

  const bad = await verifyMailDomain('bad.test',{
    selector:'mail',
    resolveMx:async()=>[],
    resolveTxt:async(host)=>{
      if(host==='bad.test') return [['v=spf1 -all'],['v=spf1 include:_spf.example -all']];
      throw Object.assign(new Error('not found'),{code:'ENOTFOUND'});
    }
  });
  assert.equal(bad.verified,false);
  assert.equal(bad.checks.mx.status,'fail');
  assert.equal(bad.checks.spf.status,'fail');
  assert.equal(bad.checks.dkim.status,'fail');
  assert.equal(bad.checks.dmarc.status,'fail');
  assert(bad.recommendations.some(x=>/Merge multiple SPF/.test(x)));
  console.log('mail domain verifier tests passed');
})().catch(e=>{console.error(e);process.exit(1)});