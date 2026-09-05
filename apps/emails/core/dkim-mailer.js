'use strict';

const fs = require('fs');
const path = require('path');

function booleanEnv(value, fallback) {
    if (value === undefined || value === null || value === '') return !!fallback;
    return String(value).trim().toLowerCase() === 'true';
}

function normalizeDomain(value) {
    return String(value || '').trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
}

function extractFirstAddress(value) {
    const text = Array.isArray(value) ? value.join(',') : String(value || '');
    const angle = text.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/);
    if (angle) return angle[1].trim().toLowerCase();
    const plain = text.match(/(?:^|[\s,;])([^\s,;<>]+@[^\s,;<>]+)(?=$|[\s,;])/);
    if (plain) return plain[1].trim().toLowerCase();
    const fallback = text.match(/([^\s,;<>]+@[^\s,;<>]+)/);
    return fallback ? fallback[1].trim().toLowerCase() : '';
}

function domainFromAddress(value) {
    const address = extractFirstAddress(value);
    const at = address.lastIndexOf('@');
    return at > 0 ? normalizeDomain(address.slice(at + 1)) : '';
}

function parseList(value) {
    return String(value || '')
        .split(/[\s,;|]+/)
        .map(normalizeDomain)
        .filter(Boolean);
}

function parseMap(value) {
    if (!value) return {};
    const text = String(value).trim();
    if (!text) return {};
    if (text.startsWith('{')) {
        try {
            const obj = JSON.parse(text);
            return Object.fromEntries(Object.entries(obj || {}).map(([key, val]) => [normalizeDomain(key), String(val || '').trim()]).filter(([, val]) => val));
        } catch (error) {
            throw new Error('Invalid DKIM map JSON: ' + error.message);
        }
    }
    const result = {};
    for (const item of text.split(/[;,]+/)) {
        const index = item.indexOf('=');
        if (index <= 0) continue;
        const key = normalizeDomain(item.slice(0, index));
        const val = item.slice(index + 1).trim();
        if (key && val) result[key] = val;
    }
    return result;
}

function createDkimConfig(options) {
    options = options || {};
    const env = options.env || process.env;
    const enabled = options.enabled !== undefined ? !!options.enabled : booleanEnv(env.DKIM_ENABLED, true);
    const requireSigning = options.requireSigning !== undefined ? !!options.requireSigning : booleanEnv(env.DKIM_REQUIRE_SIGNING, false);
    const basePath = path.resolve(options.basePath || env.DKIM_BASE_PATH || '/etc/mail/dkim');
    const defaultSelector = String(options.selector || env.DKIM_SELECTOR || 'mail').trim() || 'mail';
    const selectorMap = options.selectorMap || parseMap(env.DKIM_SELECTOR_MAP);
    const keyPathMap = options.keyPathMap || parseMap(env.DKIM_KEY_PATH_MAP);
    const allowedDomains = new Set(options.allowedDomains || parseList(env.DKIM_ALLOWED_DOMAINS || env.LOCAL_MAIL_DOMAINS));

    return {
        enabled,
        requireSigning,
        basePath,
        defaultSelector,
        selectorMap,
        keyPathMap,
        allowedDomains,
    };
}

function createDkimResolver(options) {
    const config = createDkimConfig(options);
    const cache = new Map();
    const logger = typeof options?.logger === 'function' ? options.logger : () => {};

    function resolve(from) {
        if (!config.enabled) return null;
        const domainName = domainFromAddress(from);
        if (!domainName) {
            if (config.requireSigning) throw new Error('DKIM signing requires a valid From address');
            return null;
        }
        if (config.allowedDomains.size && !config.allowedDomains.has(domainName)) {
            const message = 'DKIM From domain is not allowed on this server: ' + domainName;
            if (config.requireSigning) throw new Error(message);
            logger(message);
            return null;
        }

        const keySelector = String(config.selectorMap[domainName] || config.defaultSelector).trim();
        const privateKeyPath = path.resolve(config.keyPathMap[domainName] || path.join(config.basePath, domainName, keySelector + '.private'));
        let stat;
        try {
            stat = fs.statSync(privateKeyPath);
        } catch (error) {
            const message = `DKIM private key not found for ${domainName}: ${privateKeyPath}`;
            if (config.requireSigning) throw new Error(message);
            logger(message);
            return null;
        }

        const cached = cache.get(privateKeyPath);
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.value;

        const privateKey = fs.readFileSync(privateKeyPath, 'utf8');
        const value = { domainName, keySelector, privateKey, privateKeyPath };
        cache.set(privateKeyPath, { mtimeMs: stat.mtimeMs, size: stat.size, value });
        return value;
    }

    return { config, resolve, domainFromAddress };
}

function createDkimSendmail(options) {
    options = options || {};
    const logger = typeof options.logger === 'function' ? options.logger : () => {};
    const resolver = createDkimResolver(options);
    const sendmailPath = String(options.sendmailPath || process.env.SENDMAIL_PATH || '/usr/sbin/sendmail');
    const transportCache = new Map();
    let nodemailer = options.nodemailer;

    function getNodemailer() {
        if (!nodemailer) nodemailer = require('nodemailer');
        return nodemailer;
    }

    function transportFor(dkim) {
        const key = dkim ? `${dkim.domainName}|${dkim.keySelector}|${dkim.privateKeyPath}` : 'unsigned';
        if (transportCache.has(key)) return transportCache.get(key);
        const transportOptions = {
            sendmail: true,
            newline: 'unix',
            path: sendmailPath,
        };
        if (dkim) {
            transportOptions.dkim = {
                domainName: dkim.domainName,
                keySelector: dkim.keySelector,
                privateKey: dkim.privateKey,
            };
        }
        const transporter = getNodemailer().createTransport(transportOptions);
        transportCache.set(key, transporter);
        return transporter;
    }

    function sendmail(message, callback) {
        callback = typeof callback === 'function' ? callback : () => {};
        Promise.resolve().then(async () => {
            const dkim = resolver.resolve(message?.from);
            const transporter = transportFor(dkim);
            const info = await transporter.sendMail(message || {});
            logger(`Outbound mail accepted by sendmail${dkim ? ` with DKIM d=${dkim.domainName}; s=${dkim.keySelector}` : ' without DKIM'}`);
            return info?.response || info?.messageId || info;
        }).then((reply) => callback(null, reply)).catch((error) => callback(error));
    }

    sendmail.dkim = resolver;
    return sendmail;
}

module.exports = {
    booleanEnv,
    normalizeDomain,
    extractFirstAddress,
    domainFromAddress,
    parseList,
    parseMap,
    createDkimConfig,
    createDkimResolver,
    createDkimSendmail,
};
