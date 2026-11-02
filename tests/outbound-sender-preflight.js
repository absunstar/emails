'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkSenderDkim } = require('../apps/emails/core/outbound-sender-preflight');

(async function run() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sender-dkim-'));
    try {
        const domain = 'example.test';
        fs.mkdirSync(path.join(temp,domain), { recursive: true });
        const privateKey = crypto.generateKeyPairSync('rsa', {
            modulusLength: 2048,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        }).privateKey;
        fs.writeFileSync(path.join(temp,domain,'mail1.private'),privateKey,{mode:0o600});
        const pub = crypto.createPublicKey(privateKey).export({type:'spki',format:'der'}).toString('base64');
        const env = { DKIM_ENABLED:'true', DKIM_REQUIRE_SIGNING:'true', DKIM_SELECTOR:'mail1', DKIM_BASE_PATH:temp };
        const good=await checkSenderDkim('info@'+domain,{env,resolveTxt:async()=>[['v=DKIM1; k=rsa; p='+pub]]});
        assert.equal(good.ready,true);
        assert.equal(good.reason,'dkim_key_matches_dns');
        const missing=await checkSenderDkim('info@missing.test',{env,resolveTxt:async()=>{throw Error('not found')}});
        assert.equal(missing.reason,'dkim_private_key_unavailable');
        const bad=await checkSenderDkim('info@'+domain,{env,resolveTxt:async()=>[['v=DKIM1; k=rsa; p=different-key']]});
        assert.equal(bad.ready,false);
        assert.equal(bad.reason,'dkim_dns_key_mismatch');
        const unpub=await checkSenderDkim('info@'+domain,{env,resolveTxt:async()=>[['v=spf1 -all']]});
        assert.equal(unpub.reason,'dkim_dns_record_missing');
        const noDns=await checkSenderDkim('info@'+domain,{env,resolveTxt:async()=>{throw Error('DNS timeout')}});
        assert.equal(noDns.reason,'dkim_dns_record_unavailable');
        const notSigned=await checkSenderDkim('info@'+domain,{env:{DKIM_ENABLED:'false',DKIM_REQUIRE_SIGNING:'true'}});
        assert.equal(notSigned.reason,'dkim_required_but_disabled');
        console.log('OUTBOUND_DKIM_PREFLIGHT_PASS', JSON.stringify({
            matchingDns:true,missingKeyBlocked:true,mismatchedKeyBlocked:true,
            missingRecordBlocked:true,dnsUnavailableBlocked:true,signatureRequiredEnforced:true
        }));
    }finally{fs.rmSync(temp,{recursive:true,force:true})}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
