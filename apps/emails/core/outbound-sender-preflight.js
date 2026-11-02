'use strict';
// Independent sender-authentication preflight. No private-key content is
// returned, no DNS is modified, and no message is sent.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const dns = require('node:dns').promises;
const { domainOf } = require('./smtp-outbound');

function affirmative(v) {
    return /^(?:true|1|yes|on)$/i.test(String(v ?? '').trim());
}

function senderOptions(env = process.env) {
    return {
        enabled: affirmative(env.DKIM_ENABLED),
        required: affirmative(env.DKIM_REQUIRE_SIGNING),
        selector: String(env.DKIM_SELECTOR || 'mail1').trim(),
        basePath: String(env.DKIM_BASE_PATH || '/etc/mail/dkim'),
    };
}

async function checkSenderDkim(from, { env = process.env, resolveTxt = dns.resolveTxt } = {}) {
    const opts = senderOptions(env);
    const domain = domainOf(from);
    if (!domain) return { ready: false, reason: 'invalid_from_email', dkimRequired: opts.required };
    if (!opts.enabled) return opts.required ?
        { ready: false, reason: 'dkim_required_but_disabled', domain, dkimRequired: true } :
        { ready: true, reason: 'dkim_not_enabled', domain, dkimRequired: false, warning: 'DKIM is not enabled on this sender' };
    if (!/^[a-z0-9_-]{1,63}$/i.test(opts.selector)) {
        return { ready: false, reason: 'invalid_dkim_selector', domain, dkimRequired: opts.required };
    }
    const host = opts.selector + '._domainkey.' + domain;
    const target = path.join(opts.basePath, domain, opts.selector + '.private');
    let publishedKey;
    try {
        const pem = fs.readFileSync(target);
        const key = crypto.createPrivateKey(pem);
        publishedKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'der' }).toString('base64');
    } catch {
        return { ready: false, reason: 'dkim_private_key_unavailable', domain, selector: opts.selector, dnsHost: host };
    }
    let dnsValues;
    try {
        dnsValues = (await resolveTxt(host)).map(chunks => chunks.join(''));
    } catch {
        return { ready: false, reason: 'dkim_dns_record_unavailable', domain, selector: opts.selector, dnsHost: host };
    }
    const records = dnsValues.filter(txt => /(?:^|;)\s*v\s*=\s*DKIM1\b/i.test(txt));
    if (!records.length) {
        return { ready: false, reason: 'dkim_dns_record_missing', domain, selector: opts.selector, dnsHost: host };
    }
    const dnsKeys = records.map(txt => (txt.match(/(?:^|;)\s*p\s*=\s*([^;]*)/i)?.[1] || '').replace(/\s/g, ''));
    if (!dnsKeys.includes(publishedKey)) {
        return { ready: false, reason: 'dkim_dns_key_mismatch', domain, selector: opts.selector, dnsHost: host };
    }
    return { ready: true, reason: 'dkim_key_matches_dns', domain, selector: opts.selector, dnsHost: host };
}

module.exports = { checkSenderDkim, senderOptions };
