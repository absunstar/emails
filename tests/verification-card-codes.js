'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectVerificationCode } = require('../apps/emails/core/verification-code');
const { createEmailService } = require('../apps/emails/core/email-service');
const apiSource = fs.readFileSync('apps/emails/app.js','utf8');
const front = fs.readFileSync('apps/emails/site_files/js/index.js','utf8');
assert(apiSource.includes('includeVerificationCodes: data.includeVerificationCodes === true && data.exactTo === true'));
assert(front.includes("includeVerificationCodes: mode === 'free' && !!requestWhere.to"));
assert(front.includes('mail.verificationCode || matchOtpCode(mail.subject)'));
assert.equal(detectVerificationCode({ subject:'Your verification code',text:'Please use 648291 to log in.' }), '648291');
assert.equal(detectVerificationCode({ subject:'Login',html:'<p>Security code: <strong>729105</strong></p>' }), '729105');
assert.equal(detectVerificationCode({ subject:'Receipt',text:'Invoice 648291, total 20 USD' }), '');
assert.equal(detectVerificationCode({ subject:'Verification',html:'<script>code: 124578</script><p>Code: 842196</p>' }), '842196');
(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'egytag-otp-preview-'));
    try {
        const s = createEmailService({sendmail:(message,cb)=>cb(null,'queued'),dataDir:path.join(dir,'data'),vipPath:path.join(dir,'vip.json')});
        await s.ingestIncoming({guid:'public-code',from:'robot@example.com',to:'inbox@egytag.com',subject:'Login',text:'Your verification code is 516394',date:'2026-10-31T00:00:00Z'});
        await s.ingestIncoming({guid:'private-code',from:'robot@example.com',to:'private@egytag.com',subject:'Login',text:'Your verification code is 999888',date:'2026-10-31T00:01:00Z'});
        await s.setVip({email:'private@egytag.com',vip:true});
        const scope={domain:'egytag.com',isAdmin:false,maxLimit:500};
        const result=await s.search({toExact:'inbox@egytag.com',limit:100,includeVerificationCodes:true},scope);
        assert.equal(result.messages.length,1);
        assert.equal(result.messages[0].verificationCode,'516394');
        assert.equal(result.messages[0].text,undefined);
        assert.equal(result.messages[0].html,undefined);
        // Simulate an old index that did not persist the code, ensure bounded
        // on-demand body lookup restores the card without shipping message text.
        s.store.messages.get('public-code').verificationCode = '';
        const legacy = await s.search({toExact:'inbox@egytag.com',includeVerificationCodes:true},scope);
        assert.equal(legacy.messages[0].verificationCode,'516394');
        assert.equal(legacy.messages[0].text,undefined);
        const blocked=await s.search({toExact:'private@egytag.com',includeVerificationCodes:true},scope);
        assert.equal(blocked.messages.length,0);
        console.log('Verification card code preview: HTML/text extraction, indexing, public-only projection and VIP isolation PASS');
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
