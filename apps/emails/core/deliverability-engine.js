'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

function boundedNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.round(parsed)));
}

function booleanValue(value, fallback) {
    return typeof value === 'boolean' ? value : fallback;
}

function normalizeEmail(value) {
    const match = String(value || '').trim().toLowerCase().match(/[a-z0-9._%+-]+@(?:[a-z0-9.-]+\.[a-z]{2,}|localhost)/i);
    return match ? match[0] : '';
}

function normalizeEmails(value) {
    const input = Array.isArray(value) ? value : [value];
    const result = [];
    for (const item of input) {
        const matches = String(item || '').match(/[a-z0-9._%+-]+@(?:[a-z0-9.-]+\.[a-z]{2,}|localhost)/gi) || [];
        for (const match of matches) {
            const email = match.toLowerCase();
            if (!result.includes(email)) result.push(email);
        }
    }
    return result;
}

function domainOf(email) {
    const normalized = normalizeEmail(email);
    const index = normalized.lastIndexOf('@');
    return index >= 0 ? normalized.slice(index + 1) : '';
}

function hourKey(now) {
    return new Date(now).toISOString().slice(0, 13);
}

function dayKey(now) {
    return new Date(now).toISOString().slice(0, 10);
}

function defaultConfig() {
    return {
        version: 1,
        enabled: true,
        global: {
            perHour: 500,
            perDay: 10000,
        },
        domain: {
            perHour: 30,
            perDay: 200,
            minSecondsBetweenMessages: 5,
        },
        providers: {
            google: { enabled: true, domains: ['gmail.com', 'googlemail.com'], perHour: 100, perDay: 1000, minSecondsBetweenMessages: 3 },
            microsoft: { enabled: true, domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'], perHour: 60, perDay: 500, minSecondsBetweenMessages: 5 },
            yahoo: { enabled: true, domains: ['yahoo.com', 'ymail.com', 'rocketmail.com', 'aol.com'], perHour: 60, perDay: 500, minSecondsBetweenMessages: 5 },
            apple: { enabled: true, domains: ['icloud.com', 'me.com', 'mac.com'], perHour: 40, perDay: 300, minSecondsBetweenMessages: 8 },
        },
        warmup: {
            enabled: true,
            startPerDay: 250,
            growthPercentPerDay: 25,
            maxPerDay: 10000,
        },
        circuitBreaker: {
            enabled: true,
            minSample: 50,
            hardBounceRatePercent: 5,
            complaintRatePercent: 0.3,
            failureRatePercent: 20,
            pauseMinutes: 120,
        },
        suppression: {
            enabled: true,
            blockTypes: ['unsubscribe', 'complaint', 'hard_bounce', 'manual'],
        },
        updatedAt: new Date().toISOString(),
    };
}

function sanitizeProvider(input, fallback) {
    const source = input && typeof input === 'object' ? input : {};
    const base = clone(fallback);
    base.enabled = booleanValue(source.enabled, base.enabled);
    if (Array.isArray(source.domains)) {
        base.domains = Array.from(new Set(source.domains.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))).slice(0, 100);
    }
    base.perHour = boundedNumber(source.perHour, base.perHour, 1, 100000);
    base.perDay = boundedNumber(source.perDay, base.perDay, 1, 1000000);
    base.minSecondsBetweenMessages = boundedNumber(source.minSecondsBetweenMessages, base.minSecondsBetweenMessages, 0, 3600);
    return base;
}

function sanitizeConfig(input, fallback) {
    const base = clone(fallback || defaultConfig());
    const source = input && typeof input === 'object' ? input : {};
    base.enabled = booleanValue(source.enabled, base.enabled);
    const global = source.global && typeof source.global === 'object' ? source.global : {};
    base.global.perHour = boundedNumber(global.perHour, base.global.perHour, 1, 100000);
    base.global.perDay = boundedNumber(global.perDay, base.global.perDay, 1, 1000000);
    const domain = source.domain && typeof source.domain === 'object' ? source.domain : {};
    base.domain.perHour = boundedNumber(domain.perHour, base.domain.perHour, 1, 100000);
    base.domain.perDay = boundedNumber(domain.perDay, base.domain.perDay, 1, 1000000);
    base.domain.minSecondsBetweenMessages = boundedNumber(domain.minSecondsBetweenMessages, base.domain.minSecondsBetweenMessages, 0, 3600);
    const providers = source.providers && typeof source.providers === 'object' ? source.providers : {};
    for (const name of Object.keys(base.providers)) base.providers[name] = sanitizeProvider(providers[name], base.providers[name]);
    const warmup = source.warmup && typeof source.warmup === 'object' ? source.warmup : {};
    base.warmup.enabled = booleanValue(warmup.enabled, base.warmup.enabled);
    base.warmup.startPerDay = boundedNumber(warmup.startPerDay, base.warmup.startPerDay, 1, 1000000);
    base.warmup.growthPercentPerDay = boundedNumber(warmup.growthPercentPerDay, base.warmup.growthPercentPerDay, 0, 500);
    base.warmup.maxPerDay = boundedNumber(warmup.maxPerDay, base.warmup.maxPerDay, 1, 1000000);
    const circuit = source.circuitBreaker && typeof source.circuitBreaker === 'object' ? source.circuitBreaker : {};
    base.circuitBreaker.enabled = booleanValue(circuit.enabled, base.circuitBreaker.enabled);
    base.circuitBreaker.minSample = boundedNumber(circuit.minSample, base.circuitBreaker.minSample, 10, 1000000);
    base.circuitBreaker.hardBounceRatePercent = Math.max(0.01, Math.min(100, Number.isFinite(Number(circuit.hardBounceRatePercent)) ? Number(circuit.hardBounceRatePercent) : base.circuitBreaker.hardBounceRatePercent));
    base.circuitBreaker.complaintRatePercent = Math.max(0.01, Math.min(100, Number.isFinite(Number(circuit.complaintRatePercent)) ? Number(circuit.complaintRatePercent) : base.circuitBreaker.complaintRatePercent));
    base.circuitBreaker.failureRatePercent = Math.max(0.01, Math.min(100, Number.isFinite(Number(circuit.failureRatePercent)) ? Number(circuit.failureRatePercent) : base.circuitBreaker.failureRatePercent));
    base.circuitBreaker.pauseMinutes = boundedNumber(circuit.pauseMinutes, base.circuitBreaker.pauseMinutes, 1, 10080);
    const suppression = source.suppression && typeof source.suppression === 'object' ? source.suppression : {};
    base.suppression.enabled = booleanValue(suppression.enabled, base.suppression.enabled);
    if (Array.isArray(suppression.blockTypes)) {
        const allowed = new Set(['unsubscribe', 'complaint', 'hard_bounce', 'manual']);
        base.suppression.blockTypes = Array.from(new Set(suppression.blockTypes.map((x) => String(x || '').trim().toLowerCase()).filter((x) => allowed.has(x))));
    }
    base.version = 1;
    base.updatedAt = new Date().toISOString();
    return base;
}

function blankCounter() {
    return { hourKey: '', hourAttempts: 0, dayKey: '', dayAttempts: 0, sent: 0, failed: 0, hardBounces: 0, softBounces: 0, complaints: 0, unsubscribes: 0, lastAttemptAt: null, lastSentAt: null, circuitOpenUntil: null, circuitReason: '' };
}

function defaultState() {
    return {
        version: 1,
        startedAt: new Date().toISOString(),
        global: blankCounter(),
        domains: {},
        providers: {},
        updatedAt: new Date().toISOString(),
    };
}

function classifyFailure(error) {
    const text = String(error?.message || error || '').toLowerCase();
    if (/\b(?:550|551|552|553|554)\b|\b5\.\d\.\d\b|user unknown|no such user|recipient address rejected|mailbox unavailable|unknown recipient|does not exist/.test(text)) return 'hard_bounce';
    if (/\b(?:421|450|451|452)\b|\b4\.\d\.\d\b|temporar|try again|greylist|rate limit|too many/.test(text)) return 'soft_bounce';
    return 'failure';
}

class EmailDeliverabilityEngine {
    constructor(options) {
        options = options || {};
        this.baseDir = path.resolve(options.baseDir || path.join(process.cwd(), 'localStorage', 'email-deliverability'));
        this.configPath = options.configPath || path.join(this.baseDir, 'config.json');
        this.statePath = options.statePath || path.join(this.baseDir, 'state.json');
        this.suppressionsDir = options.suppressionsDir || path.join(this.baseDir, 'suppressions');
        this.logger = typeof options.logger === 'function' ? options.logger : () => {};
        ensureDir(this.baseDir);
        ensureDir(this.suppressionsDir);
        const defaults = defaultConfig();
        this.config = sanitizeConfig(readJson(this.configPath, defaults), defaults);
        this.state = readJson(this.statePath, defaultState());
        if (!this.state.startedAt) this.state.startedAt = new Date().toISOString();
        writeJsonAtomic(this.configPath, this.config);
        this._saveState();
    }

    _saveState() {
        this.state.updatedAt = new Date().toISOString();
        writeJsonAtomic(this.statePath, this.state);
    }

    _suppressionPath(email) {
        const normalized = normalizeEmail(email);
        if (!normalized) throw new Error('Valid email is required');
        const hash = crypto.createHash('sha256').update(normalized).digest('hex');
        return path.join(this.suppressionsDir, hash.slice(0, 2), hash + '.json');
    }

    _counter(container, key) {
        if (!container[key] || typeof container[key] !== 'object') container[key] = blankCounter();
        return container[key];
    }

    _resetCounter(counter, now) {
        const h = hourKey(now);
        const d = dayKey(now);
        if (counter.hourKey !== h) {
            counter.hourKey = h;
            counter.hourAttempts = 0;
        }
        if (counter.dayKey !== d) {
            counter.dayKey = d;
            counter.dayAttempts = 0;
            counter.sent = 0;
            counter.failed = 0;
            counter.hardBounces = 0;
            counter.softBounces = 0;
            counter.complaints = 0;
            counter.unsubscribes = 0;
        }
    }

    _providerForDomain(domain) {
        const value = String(domain || '').toLowerCase();
        for (const [name, provider] of Object.entries(this.config.providers || {})) {
            if (provider.enabled && Array.isArray(provider.domains) && provider.domains.includes(value)) return name;
        }
        return 'other';
    }

    _providerConfig(name) {
        if (name !== 'other' && this.config.providers[name]) return this.config.providers[name];
        return { enabled: true, domains: [], perHour: this.config.domain.perHour, perDay: this.config.domain.perDay, minSecondsBetweenMessages: this.config.domain.minSecondsBetweenMessages };
    }

    _warmupDailyLimit(now) {
        const maxConfigured = Math.min(this.config.global.perDay, this.config.warmup.maxPerDay);
        if (!this.config.warmup.enabled) return maxConfigured;
        const started = Date.parse(this.state.startedAt || '') || now;
        const days = Math.max(0, Math.floor((now - started) / 86400000));
        const multiplier = Math.pow(1 + this.config.warmup.growthPercentPerDay / 100, days);
        return Math.max(1, Math.min(maxConfigured, Math.floor(this.config.warmup.startPerDay * multiplier)));
    }

    _ratePercent(value, attempts) {
        if (!attempts) return 0;
        return (Number(value || 0) / Number(attempts || 1)) * 100;
    }

    _maybeOpenCircuit(counter, label, now) {
        const cfg = this.config.circuitBreaker;
        if (!cfg.enabled) return;
        const attempts = Number(counter.dayAttempts || 0);
        if (attempts < cfg.minSample) return;
        const hardBounceRate = this._ratePercent(counter.hardBounces, attempts);
        const complaintRate = this._ratePercent(counter.complaints, attempts);
        const failureRate = this._ratePercent(counter.failed, attempts);
        let reason = '';
        if (complaintRate >= cfg.complaintRatePercent) reason = label + ' complaint rate reached ' + complaintRate.toFixed(2) + '%';
        else if (hardBounceRate >= cfg.hardBounceRatePercent) reason = label + ' hard-bounce rate reached ' + hardBounceRate.toFixed(2) + '%';
        else if (failureRate >= cfg.failureRatePercent) reason = label + ' failure rate reached ' + failureRate.toFixed(2) + '%';
        if (reason) {
            counter.circuitOpenUntil = new Date(now + cfg.pauseMinutes * 60000).toISOString();
            counter.circuitReason = reason;
        }
    }

    _circuitDecision(counter, label, now) {
        if (!this.config.circuitBreaker.enabled || !counter.circuitOpenUntil) return null;
        const until = Date.parse(counter.circuitOpenUntil);
        if (!Number.isFinite(until) || until <= now) {
            counter.circuitOpenUntil = null;
            counter.circuitReason = '';
            return null;
        }
        return { allowed: false, code: 'DELIVERABILITY_CIRCUIT_OPEN', reason: counter.circuitReason || (label + ' delivery circuit is paused'), retryAfterMs: until - now, permanent: false };
    }

    getConfig() {
        return clone(this.config);
    }

    updateConfig(next) {
        this.config = sanitizeConfig(next, this.config);
        writeJsonAtomic(this.configPath, this.config);
        return this.getConfig();
    }

    resetConfig() {
        this.config = defaultConfig();
        writeJsonAtomic(this.configPath, this.config);
        return this.getConfig();
    }

    getSuppression(email) {
        const normalized = normalizeEmail(email);
        if (!normalized) return null;
        const item = readJson(this._suppressionPath(normalized), null);
        return item && item.email === normalized ? item : null;
    }

    addSuppression(email, type, reason, source) {
        const normalized = normalizeEmail(email);
        if (!normalized) throw new Error('Valid email is required');
        const normalizedType = String(type || 'manual').trim().toLowerCase();
        const allowedTypes = new Set(['unsubscribe', 'complaint', 'hard_bounce', 'manual']);
        if (!allowedTypes.has(normalizedType)) throw new Error('Suppression type must be unsubscribe, complaint, hard_bounce, or manual');
        const item = {
            email: normalized,
            domain: domainOf(normalized),
            type: normalizedType,
            reason: String(reason || '').slice(0, 1000),
            source: String(source || 'manual').slice(0, 160),
            createdAt: new Date().toISOString(),
        };
        writeJsonAtomic(this._suppressionPath(normalized), item);
        return clone(item);
    }

    removeSuppression(email) {
        const normalized = normalizeEmail(email);
        if (!normalized) throw new Error('Valid email is required');
        const filePath = this._suppressionPath(normalized);
        const existed = fs.existsSync(filePath);
        if (existed) fs.unlinkSync(filePath);
        return { removed: existed, email: normalized };
    }

    listSuppressions(args) {
        args = args || {};
        const type = String(args.type || '').trim().toLowerCase();
        const query = String(args.query || '').trim().toLowerCase();
        const limit = Math.max(1, Math.min(Number(args.limit || 100), 1000));
        const offset = Math.max(0, Number(args.offset || 0));
        const all = [];
        if (!fs.existsSync(this.suppressionsDir)) return { count: 0, total: 0, offset, limit, items: [] };
        const prefixes = fs.readdirSync(this.suppressionsDir);
        for (const prefix of prefixes) {
            const dir = path.join(this.suppressionsDir, prefix);
            let names = [];
            try { names = fs.readdirSync(dir); } catch (_) { continue; }
            for (const name of names) {
                if (!name.endsWith('.json')) continue;
                const item = readJson(path.join(dir, name), null);
                if (!item || !item.email) continue;
                if (type && item.type !== type) continue;
                if (query && ![item.email, item.domain, item.type, item.reason, item.source].some((value) => String(value || '').toLowerCase().includes(query))) continue;
                all.push(item);
            }
        }
        all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
        const items = all.slice(offset, offset + limit);
        return { count: items.length, total: all.length, offset, limit, items };
    }

    preflight(from, recipients) {
        const now = Date.now();
        const list = normalizeEmails(recipients);
        if (!list.length) return { allowed: false, code: 'DELIVERABILITY_INVALID_RECIPIENT', reason: 'No valid recipient address found', permanent: true };
        if (!this.config.enabled) return { allowed: true, recipients: list, warmupDailyLimit: null };
        if (this.config.suppression.enabled) {
            const blockedTypes = new Set(this.config.suppression.blockTypes || []);
            for (const email of list) {
                const suppression = this.getSuppression(email);
                if (suppression && blockedTypes.has(suppression.type)) {
                    return { allowed: false, code: 'DELIVERABILITY_SUPPRESSED', reason: 'Recipient is suppressed: ' + suppression.type, permanent: true, recipient: email, suppression };
                }
            }
        }
        const global = this.state.global;
        this._resetCounter(global, now);
        const globalCircuit = this._circuitDecision(global, 'Global', now);
        if (globalCircuit) return globalCircuit;
        const cost = list.length;
        const warmupDailyLimit = this._warmupDailyLimit(now);
        if (global.hourAttempts + cost > this.config.global.perHour) {
            const nextHour = Date.parse(new Date(now).toISOString().slice(0, 13) + ':00:00.000Z') + 3600000;
            return { allowed: false, code: 'DELIVERABILITY_GLOBAL_HOURLY_LIMIT', reason: 'Global deliverability hourly limit reached', retryAfterMs: Math.max(1000, nextHour - now), permanent: false };
        }
        if (global.dayAttempts + cost > warmupDailyLimit) {
            const nextDay = Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z') + 86400000;
            return { allowed: false, code: 'DELIVERABILITY_WARMUP_LIMIT', reason: 'Current safe daily warm-up limit reached (' + warmupDailyLimit + ')', retryAfterMs: Math.max(1000, nextDay - now), permanent: false, warmupDailyLimit };
        }
        const byDomain = new Map();
        for (const email of list) {
            const domain = domainOf(email);
            if (!byDomain.has(domain)) byDomain.set(domain, []);
            byDomain.get(domain).push(email);
        }
        for (const [domain, emails] of byDomain.entries()) {
            const domainCounter = this._counter(this.state.domains, domain || 'unknown');
            this._resetCounter(domainCounter, now);
            const domainCircuit = this._circuitDecision(domainCounter, 'Domain ' + domain, now);
            if (domainCircuit) return Object.assign({ domain }, domainCircuit);
            const providerName = this._providerForDomain(domain);
            const providerCfg = this._providerConfig(providerName);
            const providerCounter = this._counter(this.state.providers, providerName);
            this._resetCounter(providerCounter, now);
            const providerCircuit = this._circuitDecision(providerCounter, 'Provider ' + providerName, now);
            if (providerCircuit) return Object.assign({ provider: providerName }, providerCircuit);
            const domainCost = emails.length;
            if (domainCounter.hourAttempts + domainCost > this.config.domain.perHour) {
                return { allowed: false, code: 'DELIVERABILITY_DOMAIN_HOURLY_LIMIT', reason: 'Per-domain hourly limit reached for ' + domain, retryAfterMs: 3600000, permanent: false, domain };
            }
            if (domainCounter.dayAttempts + domainCost > this.config.domain.perDay) {
                return { allowed: false, code: 'DELIVERABILITY_DOMAIN_DAILY_LIMIT', reason: 'Per-domain daily limit reached for ' + domain, retryAfterMs: 86400000, permanent: false, domain };
            }
            if (providerCounter.hourAttempts + domainCost > providerCfg.perHour) {
                return { allowed: false, code: 'DELIVERABILITY_PROVIDER_HOURLY_LIMIT', reason: 'Provider hourly limit reached for ' + providerName, retryAfterMs: 3600000, permanent: false, provider: providerName };
            }
            if (providerCounter.dayAttempts + domainCost > providerCfg.perDay) {
                return { allowed: false, code: 'DELIVERABILITY_PROVIDER_DAILY_LIMIT', reason: 'Provider daily limit reached for ' + providerName, retryAfterMs: 86400000, permanent: false, provider: providerName };
            }
            const minSeconds = Math.max(this.config.domain.minSecondsBetweenMessages, providerCfg.minSecondsBetweenMessages || 0);
            if (minSeconds > 0 && domainCounter.lastAttemptAt) {
                const wait = minSeconds * 1000 - (now - Date.parse(domainCounter.lastAttemptAt));
                if (wait > 0) return { allowed: false, code: 'DELIVERABILITY_DOMAIN_PACING', reason: 'Per-domain pacing is active for ' + domain, retryAfterMs: wait, permanent: false, domain };
            }
        }
        global.hourAttempts += cost;
        global.dayAttempts += cost;
        global.lastAttemptAt = new Date(now).toISOString();
        for (const [domain, emails] of byDomain.entries()) {
            const providerName = this._providerForDomain(domain);
            const domainCounter = this._counter(this.state.domains, domain || 'unknown');
            const providerCounter = this._counter(this.state.providers, providerName);
            domainCounter.hourAttempts += emails.length;
            domainCounter.dayAttempts += emails.length;
            domainCounter.lastAttemptAt = new Date(now).toISOString();
            providerCounter.hourAttempts += emails.length;
            providerCounter.dayAttempts += emails.length;
            providerCounter.lastAttemptAt = new Date(now).toISOString();
        }
        this._saveState();
        return { allowed: true, recipients: list, warmupDailyLimit, globalDayAttempts: global.dayAttempts, globalHourAttempts: global.hourAttempts };
    }

    _recordResult(recipients, kind) {
        const now = Date.now();
        const list = normalizeEmails(recipients);
        const global = this.state.global;
        this._resetCounter(global, now);
        const grouped = new Map();
        const providerCounts = new Map();
        for (const email of list) {
            const domain = domainOf(email);
            if (!grouped.has(domain)) grouped.set(domain, []);
            grouped.get(domain).push(email);
            const providerName = this._providerForDomain(domain);
            providerCounts.set(providerName, Number(providerCounts.get(providerName) || 0) + 1);
        }
        const apply = (counter, amount) => {
            this._resetCounter(counter, now);
            if (kind === 'sent') {
                counter.sent += amount;
                counter.lastSentAt = new Date(now).toISOString();
            } else {
                counter.failed += amount;
                if (kind === 'hard_bounce') counter.hardBounces += amount;
                if (kind === 'soft_bounce') counter.softBounces += amount;
            }
        };
        apply(global, Math.max(1, list.length));
        for (const [domain, emails] of grouped.entries()) apply(this._counter(this.state.domains, domain || 'unknown'), emails.length);
        for (const [providerName, amount] of providerCounts.entries()) apply(this._counter(this.state.providers, providerName), amount);
        this._maybeOpenCircuit(global, 'Global', now);
        for (const [domain] of grouped.entries()) this._maybeOpenCircuit(this._counter(this.state.domains, domain || 'unknown'), 'Domain ' + domain, now);
        for (const [providerName] of providerCounts.entries()) this._maybeOpenCircuit(this._counter(this.state.providers, providerName), 'Provider ' + providerName, now);
        this._saveState();
    }

    recordSuccess(recipients) {
        this._recordResult(recipients, 'sent');
        return { recorded: true, type: 'sent' };
    }

    recordFailure(recipients, error) {
        const type = classifyFailure(error);
        this._recordResult(recipients, type);
        if (type === 'hard_bounce') {
            for (const email of normalizeEmails(recipients)) this.addSuppression(email, 'hard_bounce', String(error?.message || error || '').slice(0, 1000), 'transport');
        }
        return { recorded: true, type };
    }

    reportFeedback(args) {
        args = args || {};
        const email = normalizeEmail(args.email);
        if (!email) throw new Error('Valid email is required');
        const type = String(args.type || '').trim().toLowerCase();
        const allowed = new Set(['hard_bounce', 'soft_bounce', 'complaint', 'unsubscribe', 'delivered']);
        if (!allowed.has(type)) throw new Error('Feedback type must be delivered, hard_bounce, soft_bounce, complaint, or unsubscribe');
        const now = Date.now();
        const domain = domainOf(email);
        const providerName = this._providerForDomain(domain);
        const global = this.state.global;
        const domainCounter = this._counter(this.state.domains, domain || 'unknown');
        const providerCounter = this._counter(this.state.providers, providerName);
        for (const counter of [global, domainCounter, providerCounter]) this._resetCounter(counter, now);
        for (const counter of [global, domainCounter, providerCounter]) {
            if (type === 'delivered') counter.sent += 1;
            else if (type === 'hard_bounce') { counter.failed += 1; counter.hardBounces += 1; }
            else if (type === 'soft_bounce') { counter.failed += 1; counter.softBounces += 1; }
            else if (type === 'complaint') counter.complaints += 1;
            else if (type === 'unsubscribe') counter.unsubscribes += 1;
        }
        if (type === 'hard_bounce' || type === 'complaint' || type === 'unsubscribe') this.addSuppression(email, type, args.reason || '', args.source || 'feedback');
        this._maybeOpenCircuit(global, 'Global', now);
        this._maybeOpenCircuit(domainCounter, 'Domain ' + domain, now);
        this._maybeOpenCircuit(providerCounter, 'Provider ' + providerName, now);
        this._saveState();
        return { recorded: true, email, domain, provider: providerName, type, suppressed: ['hard_bounce', 'complaint', 'unsubscribe'].includes(type) };
    }

    ingestFeedback(message) {
        const from = String(message?.from || '').toLowerCase();
        const subject = String(message?.subject || '').toLowerCase();
        const source = [message?.text || '', message?.html || ''].join('\n');
        const recipientMatch = source.match(/(?:Final-Recipient|Original-Recipient|Original-Rcpt-To|Removal-Recipient|Recipient)\s*:\s*(?:rfc822\s*;\s*)?([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i);
        const feedbackType = source.match(/Feedback-Type\s*:\s*([a-z-]+)/i);
        const complaintLike = feedbackType && /^(?:abuse|fraud|virus|other)$/.test(String(feedbackType[1] || '').toLowerCase());
        if (complaintLike && recipientMatch) {
            return Object.assign({ detected: true }, this.reportFeedback({
                email: recipientMatch[1],
                type: 'complaint',
                reason: 'Detected from inbound abuse feedback report',
                source: 'inbound-arf',
            }));
        }
        if (!/(mailer-daemon|postmaster)/.test(from) && !/(delivery status notification|undeliver|returned mail|mail delivery failed|delivery failure)/.test(subject)) return { detected: false };
        if (!recipientMatch) return { detected: false };
        const status = source.match(/Status\s*:\s*([245]\.\d\.\d)/i);
        const type = status && status[1].startsWith('5.') ? 'hard_bounce' : (status && status[1].startsWith('4.') ? 'soft_bounce' : 'soft_bounce');
        return Object.assign({ detected: true }, this.reportFeedback({ email: recipientMatch[1], type, reason: 'Detected from inbound delivery-status notification', source: 'inbound-dsn' }));
    }

    preflightReport(from, recipients) {
        const list = normalizeEmails(recipients);
        if (!list.length) return { allowed: false, reason: 'No valid recipient address found' };
        const snapshot = clone(this.state);
        try {
            const result = this.preflight(from, list);
            this.state = snapshot;
            this._saveState();
            return Object.assign({ dryRun: true }, result);
        } finally {
            this.state = snapshot;
            this._saveState();
        }
    }

    status() {
        const now = Date.now();
        this._resetCounter(this.state.global, now);
        const global = clone(this.state.global);
        const warmupDailyLimit = this._warmupDailyLimit(now);
        const domains = Object.entries(this.state.domains || {}).map(([domain, counter]) => {
            this._resetCounter(counter, now);
            const attempts = Math.max(1, Number(counter.dayAttempts || 0));
            const health = counter.circuitOpenUntil ? 'paused' : (counter.complaints / attempts * 100 >= this.config.circuitBreaker.complaintRatePercent * 0.7 || counter.hardBounces / attempts * 100 >= this.config.circuitBreaker.hardBounceRatePercent * 0.7 ? 'warning' : 'healthy');
            return { domain, provider: this._providerForDomain(domain), health, hourAttempts: counter.hourAttempts, dayAttempts: counter.dayAttempts, sent: counter.sent, failed: counter.failed, hardBounces: counter.hardBounces, softBounces: counter.softBounces, complaints: counter.complaints, unsubscribes: counter.unsubscribes, hardBounceRatePercent: this._ratePercent(counter.hardBounces, counter.dayAttempts), complaintRatePercent: this._ratePercent(counter.complaints, counter.dayAttempts), failureRatePercent: this._ratePercent(counter.failed, counter.dayAttempts), circuitOpenUntil: counter.circuitOpenUntil, circuitReason: counter.circuitReason };
        }).sort((a, b) => b.dayAttempts - a.dayAttempts).slice(0, 100);
        const providers = Object.entries(this.state.providers || {}).map(([provider, counter]) => {
            this._resetCounter(counter, now);
            const attempts = Math.max(1, Number(counter.dayAttempts || 0));
            const health = counter.circuitOpenUntil ? 'paused' : (counter.complaints / attempts * 100 >= this.config.circuitBreaker.complaintRatePercent * 0.7 || counter.hardBounces / attempts * 100 >= this.config.circuitBreaker.hardBounceRatePercent * 0.7 ? 'warning' : 'healthy');
            return { provider, health, hourAttempts: counter.hourAttempts, dayAttempts: counter.dayAttempts, sent: counter.sent, failed: counter.failed, hardBounces: counter.hardBounces, softBounces: counter.softBounces, complaints: counter.complaints, unsubscribes: counter.unsubscribes, hardBounceRatePercent: this._ratePercent(counter.hardBounces, counter.dayAttempts), complaintRatePercent: this._ratePercent(counter.complaints, counter.dayAttempts), failureRatePercent: this._ratePercent(counter.failed, counter.dayAttempts), circuitOpenUntil: counter.circuitOpenUntil, circuitReason: counter.circuitReason };
        }).sort((a, b) => b.dayAttempts - a.dayAttempts);
        this._saveState();
        return {
            enabled: !!this.config.enabled,
            warmup: { enabled: !!this.config.warmup.enabled, startedAt: this.state.startedAt, currentDailyLimit: warmupDailyLimit, configuredMaxDaily: Math.min(this.config.global.perDay, this.config.warmup.maxPerDay) },
            global,
            domains,
            providers,
            configPath: this.configPath,
            statePath: this.statePath,
            suppressionsDir: this.suppressionsDir,
        };
    }
}

function createEmailDeliverabilityEngine(options) {
    return new EmailDeliverabilityEngine(options);
}

module.exports = {
    EmailDeliverabilityEngine,
    createEmailDeliverabilityEngine,
    defaultConfig,
    sanitizeConfig,
    normalizeEmail,
    normalizeEmails,
    domainOf,
    classifyFailure,
};
