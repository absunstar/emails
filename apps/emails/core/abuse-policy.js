'use strict';

const fs = require('fs');
const path = require('path');

function clone(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
    ensureDir(path.dirname(filePath));
    const tmp = filePath + '.' + process.pid + '.' + Math.random().toString(16).slice(2) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
        fs.renameSync(tmp, filePath);
    } catch (error) {
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            fs.renameSync(tmp, filePath);
        } catch (replaceError) {
            try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) {}
            throw replaceError;
        }
    }
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return clone(fallback);
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : clone(fallback);
    } catch (_) {
        return clone(fallback);
    }
}

function splitLegacy(value) {
    if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
    return String(value || '').split('|').map((item) => item.trim()).filter(Boolean);
}

function defaultConfig(initial) {
    initial = initial || {};
    return {
        version: 1,
        enabled: true,
        lists: {
            blockFrom: { enabled: true, values: splitLegacy(initial.blockFrom || '*contaboserver.net*') },
            allowFrom: { enabled: false, values: splitLegacy(initial.allowFrom || '') },
            blockFromDomains: { enabled: false, values: splitLegacy(initial.blockFromDomains || '') },
            allowFromDomains: { enabled: false, values: splitLegacy(initial.allowFromDomains || '') },
            blockTo: { enabled: false, values: splitLegacy(initial.blockTo || '') },
            allowTo: { enabled: false, values: splitLegacy(initial.allowTo || '') },
            blockToDomains: { enabled: false, values: splitLegacy(initial.blockToDomains || '') },
            allowToDomains: { enabled: false, values: splitLegacy(initial.allowToDomains || '') },
            blockIPs: { enabled: false, values: splitLegacy(initial.blockIPs || '') },
            allowIPs: { enabled: false, values: splitLegacy(initial.allowIPs || '') },
            blockSubject: { enabled: false, values: splitLegacy(initial.blockSubject || '') },
            blockOutboundFrom: { enabled: false, values: splitLegacy(initial.blockOutboundFrom || '') },
            allowOutboundFrom: { enabled: false, values: splitLegacy(initial.allowOutboundFrom || '') },
            blockOutboundTo: { enabled: false, values: splitLegacy(initial.blockOutboundTo || '') },
            allowOutboundTo: { enabled: false, values: splitLegacy(initial.allowOutboundTo || '') },
            blockOutboundDomains: { enabled: false, values: splitLegacy(initial.blockOutboundDomains || '') },
            allowOutboundDomains: { enabled: false, values: splitLegacy(initial.allowOutboundDomains || '') },
            ignoreFrom: {
                enabled: true,
                values: splitLegacy(initial.ignoreFrom || '*friendupdates@facebookmail.com*|*suggestions*|*posts-recap*|*friendsuggestion@facebookmail.com*|*friends@facebookmail.com*|*notification@facebookmail.com*|*pageupdates@facebookmail.com*|*groupupdates@facebookmail.com*|*reminders@facebookmail.com*|*advertise-noreply@support.facebook.com*'),
            },
            ignoreSubject: { enabled: true, values: splitLegacy(initial.ignoreSubject || '*just went live on Kick!*') },
        },
        limits: {
            smtp: {
                enabled: true,
                connectionsPerMinute: 60,
                concurrentPerIp: 8,
                maxMessageBytes: 25 * 1024 * 1024,
                maxAttachmentBytes: 15 * 1024 * 1024,
                maxAttachments: 20,
            },
            http: {
                enabled: true,
                apiPerMinute: 180,
                inboxPollPerMinute: 60,
                adminPerMinute: 240,
                expensivePerMinute: 30,
                maxBodyBytes: 1024 * 1024,
            },
            outbound: {
                enabled: true,
                perHour: 60,
                adminPerHour: 500,
                apiPerHour: 120,
                mcpPerHour: 500,
                bulkMaxMessages: 100,
            },
        },
        updatedAt: new Date().toISOString(),
    };
}

function wildcardToRegExp(pattern) {
    let escaped = String(pattern || '').trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    escaped = escaped.replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$', 'i');
}

function wildcardMatch(value, pattern) {
    try {
        return wildcardToRegExp(pattern).test(String(value || ''));
    } catch (_) {
        return false;
    }
}

function normalizeIp(value) {
    let ip = String(value || '').trim().toLowerCase();
    if (ip.startsWith('::ffff:')) ip = ip.slice(7);
    if (ip === '::1') return '127.0.0.1';
    return ip;
}

function ipv4ToInt(ip) {
    const parts = String(ip || '').split('.');
    if (parts.length !== 4) return null;
    let result = 0;
    for (const part of parts) {
        if (!/^\d+$/.test(part)) return null;
        const value = Number(part);
        if (value < 0 || value > 255) return null;
        result = ((result << 8) | value) >>> 0;
    }
    return result >>> 0;
}

function ipMatches(ipValue, patternValue) {
    const ip = normalizeIp(ipValue);
    const pattern = normalizeIp(patternValue);
    if (!ip || !pattern) return false;
    if (pattern.includes('/')) {
        const [networkText, prefixText] = pattern.split('/');
        const network = ipv4ToInt(networkText);
        const target = ipv4ToInt(ip);
        const prefix = Number(prefixText);
        if (network == null || target == null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
        const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
        return (network & mask) === (target & mask);
    }
    return wildcardMatch(ip, pattern);
}

function addressDomain(address) {
    const text = String(address || '').trim().toLowerCase();
    const match = text.match(/[a-z0-9._%+-]+@([^>\s,;]+)/i);
    return match ? String(match[1] || '').replace(/[)>]+$/g, '').toLowerCase() : '';
}

function sanitizeValues(values, maxItems) {
    const source = Array.isArray(values) ? values : splitLegacy(values);
    const result = [];
    for (const item of source) {
        const value = String(item || '').trim().slice(0, 320);
        if (!value) continue;
        if (!result.some((entry) => entry.toLowerCase() === value.toLowerCase())) result.push(value);
        if (result.length >= maxItems) break;
    }
    return result;
}

function booleanValue(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

function boundedNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
}

function sanitizeConfig(input, fallback) {
    const base = clone(fallback || defaultConfig());
    const source = input && typeof input === 'object' ? input : {};
    base.enabled = booleanValue(source.enabled, base.enabled);
    const sourceLists = source.lists && typeof source.lists === 'object' ? source.lists : {};
    for (const name of Object.keys(base.lists)) {
        const current = base.lists[name];
        const next = sourceLists[name] && typeof sourceLists[name] === 'object' ? sourceLists[name] : {};
        current.enabled = booleanValue(next.enabled, current.enabled);
        current.values = sanitizeValues(next.values === undefined ? current.values : next.values, 5000);
    }
    const limits = source.limits && typeof source.limits === 'object' ? source.limits : {};
    const smtp = limits.smtp && typeof limits.smtp === 'object' ? limits.smtp : {};
    const http = limits.http && typeof limits.http === 'object' ? limits.http : {};
    const outbound = limits.outbound && typeof limits.outbound === 'object' ? limits.outbound : {};
    base.limits.smtp.enabled = booleanValue(smtp.enabled, base.limits.smtp.enabled);
    base.limits.smtp.connectionsPerMinute = boundedNumber(smtp.connectionsPerMinute, base.limits.smtp.connectionsPerMinute, 1, 10000);
    base.limits.smtp.concurrentPerIp = boundedNumber(smtp.concurrentPerIp, base.limits.smtp.concurrentPerIp, 1, 1000);
    base.limits.smtp.maxMessageBytes = boundedNumber(smtp.maxMessageBytes, base.limits.smtp.maxMessageBytes, 64 * 1024, 200 * 1024 * 1024);
    base.limits.smtp.maxAttachmentBytes = boundedNumber(smtp.maxAttachmentBytes, base.limits.smtp.maxAttachmentBytes, 16 * 1024, 100 * 1024 * 1024);
    base.limits.smtp.maxAttachments = boundedNumber(smtp.maxAttachments, base.limits.smtp.maxAttachments, 0, 200);
    base.limits.http.enabled = booleanValue(http.enabled, base.limits.http.enabled);
    base.limits.http.apiPerMinute = boundedNumber(http.apiPerMinute, base.limits.http.apiPerMinute, 1, 100000);
    base.limits.http.inboxPollPerMinute = boundedNumber(http.inboxPollPerMinute, base.limits.http.inboxPollPerMinute, 1, 100000);
    base.limits.http.adminPerMinute = boundedNumber(http.adminPerMinute, base.limits.http.adminPerMinute, 1, 100000);
    base.limits.http.expensivePerMinute = boundedNumber(http.expensivePerMinute, base.limits.http.expensivePerMinute, 1, 100000);
    base.limits.http.maxBodyBytes = boundedNumber(http.maxBodyBytes, base.limits.http.maxBodyBytes, 16 * 1024, 20 * 1024 * 1024);
    base.limits.outbound.enabled = booleanValue(outbound.enabled, base.limits.outbound.enabled);
    const legacyVersion = Number(source.version || 1);
    const perHourInput = legacyVersion < 2 && Number(outbound.perHour) === 20 ? 60 : outbound.perHour;
    const adminPerHourInput = legacyVersion < 2 && Number(outbound.adminPerHour) === 200 ? 500 : outbound.adminPerHour;
    base.limits.outbound.perHour = boundedNumber(perHourInput, base.limits.outbound.perHour, 1, 10000);
    base.limits.outbound.adminPerHour = boundedNumber(adminPerHourInput, base.limits.outbound.adminPerHour, 1, 100000);
    base.limits.outbound.apiPerHour = boundedNumber(outbound.apiPerHour, base.limits.outbound.apiPerHour, 1, 100000);
    base.limits.outbound.mcpPerHour = boundedNumber(outbound.mcpPerHour, base.limits.outbound.mcpPerHour, 1, 100000);
    base.limits.outbound.bulkMaxMessages = boundedNumber(outbound.bulkMaxMessages, base.limits.outbound.bulkMaxMessages, 1, 1000);
    base.version = 2;
    base.updatedAt = new Date().toISOString();
    return base;
}

class SlidingWindowLimiter {
    constructor() {
        this.buckets = new Map();
        this.lastSweep = 0;
    }

    hit(bucket, key, limit, windowMs) {
        const now = Date.now();
        const bucketName = String(bucket || 'default');
        const bucketKey = bucketName + ':' + String(key || 'unknown');
        const max = Math.max(1, Number(limit || 1));
        const duration = Math.max(1000, Number(windowMs || 60000));
        const list = (this.buckets.get(bucketKey) || []).filter((time) => now - time < duration);
        if (list.length >= max) {
            this.buckets.set(bucketKey, list);
            return { allowed: false, limit: max, remaining: 0, retryAfterMs: Math.max(1, duration - (now - list[0])) };
        }
        list.push(now);
        this.buckets.set(bucketKey, list);
        if (now - this.lastSweep > 5 * 60 * 1000) this.sweep(now);
        if (this.buckets.size > 50000) {
            let remove = this.buckets.size - 45000;
            for (const keyName of this.buckets.keys()) {
                if (remove <= 0) break;
                if (keyName !== bucketKey) {
                    this.buckets.delete(keyName);
                    remove -= 1;
                }
            }
        }
        return { allowed: true, limit: max, remaining: Math.max(0, max - list.length), retryAfterMs: 0 };
    }

    sweep(now) {
        now = now || Date.now();
        this.lastSweep = now;
        for (const [key, list] of this.buckets.entries()) {
            const recent = list.filter((time) => now - time < 60 * 60 * 1000);
            if (!recent.length) this.buckets.delete(key);
            else this.buckets.set(key, recent);
        }
    }

    size() {
        return this.buckets.size;
    }
}

class EmailAbusePolicy {
    constructor(options) {
        options = options || {};
        this.filePath = path.resolve(options.filePath || path.join(process.cwd(), 'localStorage', 'email-abuse-policy.json'));
        this.initial = options.initial || {};
        this.defaults = defaultConfig(this.initial);
        this.rateLimiter = new SlidingWindowLimiter();
        this.activeSmtpByIp = new Map();
        this.metrics = {
            smtpConnectionsAccepted: 0,
            smtpConnectionsRejected: 0,
            smtpMessagesRejected: 0,
            smtpMessagesIgnored: 0,
            httpRateLimited: 0,
            httpPolicyBlocked: 0,
            outboundRateLimited: 0,
            policyChanges: 0,
        };
        this.events = [];
        ensureDir(path.dirname(this.filePath));
        if (!fs.existsSync(this.filePath)) writeJsonAtomic(this.filePath, this.defaults);
        this.config = sanitizeConfig(readJson(this.filePath, this.defaults), this.defaults);
        writeJsonAtomic(this.filePath, this.config);
    }

    getConfig() {
        return clone(this.config);
    }

    getDefaults() {
        return clone(this.defaults);
    }

    update(next) {
        this.config = sanitizeConfig(next, this.config);
        writeJsonAtomic(this.filePath, this.config);
        this.metrics.policyChanges += 1;
        this.record('policy_updated', { updatedAt: this.config.updatedAt });
        return this.getConfig();
    }

    reset() {
        this.config = sanitizeConfig(this.defaults, this.defaults);
        writeJsonAtomic(this.filePath, this.config);
        this.metrics.policyChanges += 1;
        this.record('policy_reset', { updatedAt: this.config.updatedAt });
        return this.getConfig();
    }

    list(name) {
        return this.config.lists[name] || { enabled: false, values: [] };
    }

    listMatches(name, value, ipMode) {
        const list = this.list(name);
        if (!this.config.enabled || !list.enabled || !list.values.length) return false;
        return list.values.some((pattern) => ipMode ? ipMatches(value, pattern) : wildcardMatch(value, pattern));
    }

    allowListPasses(name, value, ipMode) {
        const list = this.list(name);
        if (!this.config.enabled || !list.enabled || !list.values.length) return true;
        return list.values.some((pattern) => ipMode ? ipMatches(value, pattern) : wildcardMatch(value, pattern));
    }

    checkIp(ip) {
        const normalized = normalizeIp(ip);
        if (!this.config.enabled) return { allowed: true };
        if (this.listMatches('blockIPs', normalized, true)) return { allowed: false, reason: 'IP is blocked', rule: 'blockIPs', value: normalized };
        if (!this.allowListPasses('allowIPs', normalized, true)) return { allowed: false, reason: 'IP is not in the allow list', rule: 'allowIPs', value: normalized };
        return { allowed: true, value: normalized };
    }

    checkAddress(direction, address) {
        const value = String(address || '').trim().toLowerCase();
        const domain = addressDomain(value);
        const prefix = direction === 'to' ? 'To' : 'From';
        if (!this.config.enabled) return { allowed: true, value, domain };
        if (this.listMatches('block' + prefix, value, false)) return { allowed: false, reason: direction + ' address is blocked', rule: 'block' + prefix, value, domain };
        if (domain && this.listMatches('block' + prefix + 'Domains', domain, false)) return { allowed: false, reason: direction + ' domain is blocked', rule: 'block' + prefix + 'Domains', value, domain };
        if (!this.allowListPasses('allow' + prefix, value, false)) return { allowed: false, reason: direction + ' address is not in the allow list', rule: 'allow' + prefix, value, domain };
        if (domain && !this.allowListPasses('allow' + prefix + 'Domains', domain, false)) return { allowed: false, reason: direction + ' domain is not in the allow list', rule: 'allow' + prefix + 'Domains', value, domain };
        return { allowed: true, value, domain };
    }

    checkSubject(subject) {
        const value = String(subject || '');
        if (this.listMatches('blockSubject', value, false)) return { allowed: false, reason: 'Subject is blocked', rule: 'blockSubject', value };
        return { allowed: true, value };
    }

    checkOutbound(from, to) {
        const sender = String(from || '').trim().toLowerCase();
        const recipient = String(to || '').trim().toLowerCase();
        const domain = addressDomain(recipient);
        if (!this.config.enabled) return { allowed: true, sender, recipient, domain };
        if (this.listMatches('blockOutboundFrom', sender, false)) return { allowed: false, reason: 'Outbound sender is blocked', rule: 'blockOutboundFrom', value: sender };
        if (!this.allowListPasses('allowOutboundFrom', sender, false)) return { allowed: false, reason: 'Outbound sender is not in the allow list', rule: 'allowOutboundFrom', value: sender };
        if (this.listMatches('blockOutboundTo', recipient, false)) return { allowed: false, reason: 'Outbound recipient is blocked', rule: 'blockOutboundTo', value: recipient, domain };
        if (domain && this.listMatches('blockOutboundDomains', domain, false)) return { allowed: false, reason: 'Outbound recipient domain is blocked', rule: 'blockOutboundDomains', value: recipient, domain };
        if (!this.allowListPasses('allowOutboundTo', recipient, false)) return { allowed: false, reason: 'Outbound recipient is not in the allow list', rule: 'allowOutboundTo', value: recipient, domain };
        if (domain && !this.allowListPasses('allowOutboundDomains', domain, false)) return { allowed: false, reason: 'Outbound recipient domain is not in the allow list', rule: 'allowOutboundDomains', value: recipient, domain };
        return { allowed: true, sender, recipient, domain };
    }

    shouldIgnore(from, subject) {
        if (!this.config.enabled) return { ignore: false };
        if (this.listMatches('ignoreFrom', String(from || '').toLowerCase(), false)) return { ignore: true, reason: 'Sender matches ignore list', rule: 'ignoreFrom' };
        if (this.listMatches('ignoreSubject', String(subject || ''), false)) return { ignore: true, reason: 'Subject matches ignore list', rule: 'ignoreSubject' };
        return { ignore: false };
    }

    smtpConnect(ip) {
        const normalized = normalizeIp(ip) || 'unknown';
        const ipResult = this.checkIp(normalized);
        if (!ipResult.allowed) return this.reject('smtpConnectionsRejected', 'smtp_connect_blocked', Object.assign({ ip: normalized }, ipResult));
        const limits = this.config.limits.smtp;
        if (limits.enabled) {
            const rate = this.rateLimiter.hit('smtp-connect', normalized, limits.connectionsPerMinute, 60 * 1000);
            if (!rate.allowed) return this.reject('smtpConnectionsRejected', 'smtp_connect_rate', { ip: normalized, reason: 'SMTP connection rate limit reached', rate });
            const active = Number(this.activeSmtpByIp.get(normalized) || 0);
            if (active >= limits.concurrentPerIp) return this.reject('smtpConnectionsRejected', 'smtp_connect_concurrent', { ip: normalized, reason: 'Too many concurrent SMTP connections', active, limit: limits.concurrentPerIp });
        }
        this.activeSmtpByIp.set(normalized, Number(this.activeSmtpByIp.get(normalized) || 0) + 1);
        this.metrics.smtpConnectionsAccepted += 1;
        return { allowed: true, ip: normalized };
    }

    smtpClose(ip) {
        const normalized = normalizeIp(ip) || 'unknown';
        const active = Math.max(0, Number(this.activeSmtpByIp.get(normalized) || 0) - 1);
        if (active) this.activeSmtpByIp.set(normalized, active);
        else this.activeSmtpByIp.delete(normalized);
    }

    httpHit(bucket, key) {
        const limits = this.config.limits.http;
        if (!limits.enabled) return { allowed: true };
        let limit = limits.apiPerMinute;
        if (bucket === 'inbox') limit = limits.inboxPollPerMinute;
        else if (bucket === 'admin') limit = limits.adminPerMinute;
        else if (bucket === 'expensive') limit = limits.expensivePerMinute;
        const rate = this.rateLimiter.hit('http-' + bucket, key || 'unknown', limit, 60 * 1000);
        if (!rate.allowed) {
            this.metrics.httpRateLimited += 1;
            this.record('http_rate_limited', { bucket, key: String(key || 'unknown'), rate });
        }
        return rate;
    }

    outboundHit(key, mode) {
        const limits = this.config.limits.outbound;
        if (!limits.enabled) return { allowed: true };
        const type = mode === 'mcp' ? 'mcp' : (mode === 'admin' || mode === true ? 'admin' : (mode === 'api' ? 'api' : 'browser'));
        const limit = type === 'mcp' ? limits.mcpPerHour : (type === 'admin' ? limits.adminPerHour : (type === 'api' ? limits.apiPerHour : limits.perHour));
        const rate = this.rateLimiter.hit('outbound-' + type, key || 'unknown', limit, 60 * 60 * 1000);
        if (!rate.allowed) {
            this.metrics.outboundRateLimited += 1;
            this.record('outbound_rate_limited', { key: String(key || 'unknown'), rate });
        }
        return rate;
    }

    reject(metric, type, data) {
        if (this.metrics[metric] !== undefined) this.metrics[metric] += 1;
        this.record(type, data);
        return Object.assign({ allowed: false }, data || {});
    }

    record(type, data) {
        this.events.unshift({ type: String(type || 'event'), date: new Date().toISOString(), data: clone(data || {}) });
        if (this.events.length > 100) this.events.length = 100;
    }

    status() {
        let activeSmtpConnections = 0;
        for (const count of this.activeSmtpByIp.values()) activeSmtpConnections += Number(count || 0);
        return {
            metrics: clone(this.metrics),
            activeSmtpConnections,
            activeSmtpIps: this.activeSmtpByIp.size,
            limiterBuckets: this.rateLimiter.size(),
            recentEvents: clone(this.events.slice(0, 40)),
        };
    }
}

function createEmailAbusePolicy(options) {
    return new EmailAbusePolicy(options);
}

module.exports = {
    EmailAbusePolicy,
    SlidingWindowLimiter,
    createEmailAbusePolicy,
    defaultConfig,
    sanitizeConfig,
    wildcardMatch,
    ipMatches,
    addressDomain,
    normalizeIp,
};
