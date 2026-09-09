'use strict';

/**
 * Restricted Email Host Admin tools for the existing Email MCP.
 * Built for the current temp-mail server architecture (smtp-outbound.js + env-loader.js).
 *
 * No arbitrary shell.
 * No arbitrary filesystem.
 * Only the configured mail domain, DKIM root, project .env and one configured
 * process/service may be managed.
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const dns = require('dns').promises;
const crypto = require('crypto');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

function csv(v) {
    return String(v || '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean);
}

const CONFIG = {
    domains: csv(process.env.EMAIL_HOST_ADMIN_DOMAINS || 'egytag.com'),
    publicIp: String(process.env.EMAIL_HOST_ADMIN_PUBLIC_IP || '169.58.4.25').trim(),
    envFile: path.resolve(process.env.EMAIL_HOST_ADMIN_ENV_FILE || '/home/nodes/emails/.env'),
    dkimRoot: path.resolve(process.env.EMAIL_HOST_ADMIN_DKIM_ROOT || '/etc/mail/dkim'),
    restartMode: String(process.env.EMAIL_HOST_ADMIN_RESTART_MODE || 'pm2').trim().toLowerCase(),
    processName: String(process.env.EMAIL_HOST_ADMIN_PROCESS_NAME || 'emails').trim(),
    pm2Path: String(process.env.EMAIL_HOST_ADMIN_PM2_PATH || '/usr/bin/pm2').trim(),
    systemctlPath: String(process.env.EMAIL_HOST_ADMIN_SYSTEMCTL_PATH || '/usr/bin/systemctl').trim(),
};

function allowedDomain(domain) {
    domain = String(domain || 'egytag.com').trim().toLowerCase();
    if (!CONFIG.domains.includes(domain)) throw new Error('Domain not allowed: ' + domain);
    return domain;
}

function selectorValue(selector) {
    selector = String(selector || 'default').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(selector)) throw new Error('Invalid DKIM selector');
    return selector;
}

function mailHostname(domain) {
    return 'mail.' + allowedDomain(domain);
}

function dkimDir(domain) {
    domain = allowedDomain(domain);
    const p = path.resolve(CONFIG.dkimRoot, domain);
    if (!p.startsWith(CONFIG.dkimRoot + path.sep)) throw new Error('Unsafe DKIM directory');
    return p;
}

async function exists(file) {
    try { await fsp.access(file); return true; } catch (_) { return false; }
}

function parseEnv(text) {
    const out = {};
    for (const raw of String(text || '').split(/\r?\n/)) {
        let line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('export ')) line = line.slice(7).trim();
        const i = line.indexOf('=');
        if (i < 1) continue;
        const key = line.slice(0, i).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        let value = line.slice(i + 1).trim();
        if (value.length >= 2 && (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        )) value = value.slice(1, -1);
        out[key] = value;
    }
    return out;
}

async function readEnv() {
    if (!(await exists(CONFIG.envFile))) return { text: '', values: {} };
    const text = await fsp.readFile(CONFIG.envFile, 'utf8');
    return { text, values: parseEnv(text) };
}

function patchEnvText(original, patch) {
    const seen = new Set();
    const rows = String(original || '').split(/\r?\n/).map((line) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const i = trimmed.indexOf('=');
        if (i < 1) return line;
        const key = trimmed.slice(0, i).trim();
        if (!Object.prototype.hasOwnProperty.call(patch, key)) return line;
        seen.add(key);
        return `${key}=${String(patch[key])}`;
    });
    for (const [key, value] of Object.entries(patch)) {
        if (!seen.has(key)) rows.push(`${key}=${String(value)}`);
    }
    return rows.join('\n').replace(/\n*$/, '\n');
}

async function atomicWrite(file, content, mode) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const temp = file + '.tmp-' + process.pid + '-' + Date.now();
    await fsp.writeFile(temp, content, { mode: mode || 0o600 });
    await fsp.rename(temp, file);
    if (mode) await fsp.chmod(file, mode);
}

async function writeEnv(patch) {
    const { text } = await readEnv();
    let backup = null;
    if (await exists(CONFIG.envFile)) {
        backup = CONFIG.envFile + '.bak-' + Date.now();
        await fsp.copyFile(CONFIG.envFile, backup);
    }
    await atomicWrite(CONFIG.envFile, patchEnvText(text, patch), 0o600);
    return { envFile: CONFIG.envFile, backup, changed: Object.keys(patch), restartRequired: true };
}

async function txt(name) {
    try {
        const rows = await dns.resolveTxt(name);
        return rows.map(parts => parts.join(''));
    } catch (_) {
        return [];
    }
}

async function reverse(ip) {
    try { return await dns.reverse(ip); } catch (_) { return []; }
}

function publicDnsValue(publicPem) {
    const p = String(publicPem)
        .replace(/-----BEGIN PUBLIC KEY-----/g, '')
        .replace(/-----END PUBLIC KEY-----/g, '')
        .replace(/\s+/g, '');
    return 'v=DKIM1; k=rsa; p=' + p;
}

function generateKeyPair(bits) {
    return new Promise((resolve, reject) => {
        crypto.generateKeyPair('rsa', {
            modulusLength: bits,
            publicKeyEncoding: { type: 'spki', format: 'pem' },
            privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        }, (error, publicKey, privateKey) => {
            if (error) return reject(error);
            resolve({ publicKey, privateKey });
        });
    });
}

async function getHostStatus() {
    const { values } = await readEnv();
    return {
        ok: true,
        serverHostname: os.hostname(),
        publicIp: CONFIG.publicIp,
        ptr: await reverse(CONFIG.publicIp),
        managedDomains: CONFIG.domains,
        envFile: CONFIG.envFile,
        envFileExists: await exists(CONFIG.envFile),
        dkimRoot: CONFIG.dkimRoot,
        restart: {
            mode: CONFIG.restartMode,
            processName: CONFIG.processName,
        },
        smtpRuntime: {
            SMTP_HOSTNAME: values.SMTP_HOSTNAME || null,
            SMTP_OUTBOUND_IP_FAMILY: values.SMTP_OUTBOUND_IP_FAMILY || null,
            DKIM_ENABLED: values.DKIM_ENABLED || null,
            DKIM_REQUIRE_SIGNING: values.DKIM_REQUIRE_SIGNING || null,
            DKIM_SELECTOR: values.DKIM_SELECTOR || null,
            DKIM_BASE_PATH: values.DKIM_BASE_PATH || null,
            DKIM_ALLOWED_DOMAINS: values.DKIM_ALLOWED_DOMAINS || null,
            EMAIL_PUBLIC_ORIGIN: values.EMAIL_PUBLIC_ORIGIN || null,
        },
    };
}

async function getDnsStatus(args) {
    const domain = allowedDomain(args?.domain);
    const selector = selectorValue(args?.selector);
    const hostname = mailHostname(domain);
    const [a, mx, domainTxt, dmarcTxt, dkimTxt, ptrRows] = await Promise.all([
        dns.resolve4(hostname).catch(() => []),
        dns.resolveMx(domain).catch(() => []),
        txt(domain),
        txt('_dmarc.' + domain),
        txt(selector + '._domainkey.' + domain),
        reverse(CONFIG.publicIp),
    ]);
    const spf = domainTxt.filter(v => /^v=spf1\b/i.test(v));
    const dmarc = dmarcTxt.filter(v => /^v=DMARC1\b/i.test(v));
    const dkim = dkimTxt.filter(v => /^v=DKIM1\b/i.test(v));
    return {
        domain,
        selector,
        publicIp: CONFIG.publicIp,
        hostname,
        a,
        aMatches: a.includes(CONFIG.publicIp),
        mx,
        spf,
        spfMentionsIp: spf.some(v => v.includes('ip4:' + CONFIG.publicIp)),
        dmarc,
        dkim,
        ptr: ptrRows,
        ptrMatches: ptrRows.map(v => v.replace(/\.$/, '').toLowerCase()).includes(hostname),
        expectedDkimName: selector + '._domainkey.' + domain,
    };
}

async function getDkimStatus(args) {
    const domain = allowedDomain(args?.domain);
    const selector = selectorValue(args?.selector);
    const dir = dkimDir(domain);
    const privateKeyPath = path.join(dir, selector + '.private');
    const publicKeyPath = path.join(dir, selector + '.public');
    const privateKeyExists = await exists(privateKeyPath);
    const publicKeyExists = await exists(publicKeyPath);
    let localDnsValue = null;
    if (publicKeyExists) localDnsValue = publicDnsValue(await fsp.readFile(publicKeyPath, 'utf8'));
    const published = await txt(selector + '._domainkey.' + domain);
    return {
        domain,
        selector,
        privateKeyPath,
        privateKeyExists,
        publicKeyPath,
        publicKeyExists,
        dnsName: selector + '._domainkey.' + domain,
        dnsValue: localDnsValue,
        published,
        publishedMatchesLocal: !!localDnsValue && published.includes(localDnsValue),
    };
}

async function setupDkim(args) {
    const domain = allowedDomain(args?.domain);
    const selector = selectorValue(args?.selector);
    const bits = Number(args?.bits || 2048);
    const rotate = !!args?.rotate;
    if (![2048, 3072, 4096].includes(bits)) throw new Error('bits must be 2048, 3072, or 4096');

    const dir = dkimDir(domain);
    const privateKeyPath = path.join(dir, selector + '.private');
    const publicKeyPath = path.join(dir, selector + '.public');
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });

    let generated = false;
    if (!(await exists(privateKeyPath)) || rotate) {
        if (rotate && await exists(privateKeyPath)) {
            await fsp.copyFile(privateKeyPath, privateKeyPath + '.bak-' + Date.now());
        }
        const pair = await generateKeyPair(bits);
        await atomicWrite(privateKeyPath, pair.privateKey, 0o600);
        await atomicWrite(publicKeyPath, pair.publicKey, 0o644);
        generated = true;
    } else if (!(await exists(publicKeyPath))) {
        const privatePem = await fsp.readFile(privateKeyPath, 'utf8');
        const privateKey = crypto.createPrivateKey(privatePem);
        const publicKey = crypto.createPublicKey(privateKey)
            .export({ type: 'spki', format: 'pem' })
            .toString();
        await atomicWrite(publicKeyPath, publicKey, 0o644);
    }

    const publicPem = await fsp.readFile(publicKeyPath, 'utf8');
    const dnsValue = publicDnsValue(publicPem);

    // These are the exact variables consumed by the CURRENT smtp-outbound.js.
    const env = await writeEnv({
        SMTP_HOSTNAME: mailHostname(domain),
        SMTP_OUTBOUND_IP_FAMILY: '4',
        DKIM_ENABLED: 'true',
        DKIM_REQUIRE_SIGNING: 'true',
        DKIM_SELECTOR: selector,
        DKIM_BASE_PATH: CONFIG.dkimRoot,
        DKIM_ALLOWED_DOMAINS: domain,
        EMAIL_PUBLIC_ORIGIN: 'https://emails.' + domain,
    });

    return {
        ok: true,
        domain,
        selector,
        bits,
        generated,
        rotated: rotate,
        privateKeyPath,
        publicKeyPath,
        dns: {
            type: 'TXT',
            name: selector + '._domainkey.' + domain,
            value: dnsValue,
        },
        env,
        restartRequired: true,
    };
}

async function getRuntimeConfig() {
    const { values } = await readEnv();
    const keys = [
        'SMTP_HOSTNAME',
        'SMTP_OUTBOUND_IP_FAMILY',
        'DKIM_ENABLED',
        'DKIM_REQUIRE_SIGNING',
        'DKIM_SELECTOR',
        'DKIM_BASE_PATH',
        'DKIM_ALLOWED_DOMAINS',
        'EMAIL_PUBLIC_ORIGIN',
    ];
    return {
        envFile: CONFIG.envFile,
        config: Object.fromEntries(keys.map(k => [k, values[k] ?? null])),
    };
}

async function setRuntimeConfig(args) {
    const input = args?.config || {};
    const patch = {};
    const domain = allowedDomain(args?.domain);

    if (Object.prototype.hasOwnProperty.call(input, 'smtpHostname')) {
        const v = String(input.smtpHostname || '').trim().toLowerCase();
        if (v !== mailHostname(domain)) throw new Error('smtpHostname must be ' + mailHostname(domain));
        patch.SMTP_HOSTNAME = v;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'dkimEnabled')) patch.DKIM_ENABLED = input.dkimEnabled ? 'true' : 'false';
    if (Object.prototype.hasOwnProperty.call(input, 'dkimRequireSigning')) patch.DKIM_REQUIRE_SIGNING = input.dkimRequireSigning ? 'true' : 'false';
    if (Object.prototype.hasOwnProperty.call(input, 'dkimSelector')) patch.DKIM_SELECTOR = selectorValue(input.dkimSelector);
    if (Object.prototype.hasOwnProperty.call(input, 'emailPublicOrigin')) {
        const u = new URL(String(input.emailPublicOrigin || ''));
        if (u.protocol !== 'https:' || u.hostname !== 'emails.' + domain) {
            throw new Error('emailPublicOrigin must be https://emails.' + domain);
        }
        patch.EMAIL_PUBLIC_ORIGIN = u.origin;
    }
    if (Object.prototype.hasOwnProperty.call(input, 'ipFamily')) {
        const n = Number(input.ipFamily);
        if (![0, 4, 6].includes(n)) throw new Error('ipFamily must be 0, 4 or 6');
        patch.SMTP_OUTBOUND_IP_FAMILY = String(n);
    }

    // Keep path/domain constraints fixed to the configured security boundary.
    patch.DKIM_BASE_PATH = CONFIG.dkimRoot;
    patch.DKIM_ALLOWED_DOMAINS = domain;

    return await writeEnv(patch);
}

async function restartMailService() {
    const env = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };

    if (CONFIG.restartMode === 'pm2') {
        const restart = await execFileAsync(CONFIG.pm2Path, ['restart', CONFIG.processName], {
            timeout: 30000, maxBuffer: 2 * 1024 * 1024, env
        });
        let state = 'unknown';
        try {
            const describe = await execFileAsync(CONFIG.pm2Path, ['jlist'], {
                timeout: 15000, maxBuffer: 5 * 1024 * 1024, env
            });
            const rows = JSON.parse(describe.stdout || '[]');
            const proc = rows.find(p => String(p?.name || p?.pm2_env?.name || '') === CONFIG.processName);
            state = proc?.pm2_env?.status || 'not-found';
        } catch (_) {}
        return { ok: state === 'online', mode: 'pm2', processName: CONFIG.processName, state };
    }

    if (CONFIG.restartMode === 'systemctl') {
        await execFileAsync(CONFIG.systemctlPath, ['restart', CONFIG.processName], {
            timeout: 30000, maxBuffer: 1024 * 1024, env
        });
        let state = 'unknown';
        try {
            const res = await execFileAsync(CONFIG.systemctlPath, ['is-active', CONFIG.processName], {
                timeout: 10000, maxBuffer: 1024 * 1024, env
            });
            state = String(res.stdout || '').trim();
        } catch (error) {
            state = String(error.stdout || error.stderr || '').trim() || 'unknown';
        }
        return { ok: state === 'active', mode: 'systemctl', processName: CONFIG.processName, state };
    }

    throw new Error('Unsupported restart mode. Configure EMAIL_HOST_ADMIN_RESTART_MODE as pm2 or systemctl.');
}

const tools = [
    {
        name: 'email_server_host_status',
        title: 'Mail host status',
        description: 'Read restricted mail-host status, public IP/PTR and current SMTP/DKIM runtime values.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    {
        name: 'email_server_dns_status',
        title: 'Mail DNS status',
        description: 'Check live A, MX, SPF, DKIM, DMARC and PTR alignment for the managed mail domain.',
        inputSchema: {
            type: 'object', additionalProperties: false,
            properties: {
                domain: { type: 'string', enum: CONFIG.domains, default: 'egytag.com' },
                selector: { type: 'string', default: 'default', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$' }
            }
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    {
        name: 'email_server_dkim_status',
        title: 'DKIM status',
        description: 'Inspect the managed local DKIM key and compare it with the published DNS TXT record.',
        inputSchema: {
            type: 'object', additionalProperties: false,
            properties: {
                domain: { type: 'string', enum: CONFIG.domains, default: 'egytag.com' },
                selector: { type: 'string', default: 'default', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$' }
            }
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    {
        name: 'email_server_dkim_setup',
        title: 'Configure DKIM',
        description: 'Create/reuse the DKIM key for the managed domain and write the exact SMTP/DKIM settings consumed by the current smtp-outbound.js. Returns the TXT record to publish. Does not restart automatically.',
        inputSchema: {
            type: 'object', additionalProperties: false,
            properties: {
                domain: { type: 'string', enum: CONFIG.domains, default: 'egytag.com' },
                selector: { type: 'string', default: 'default', pattern: '^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$' },
                bits: { type: 'integer', enum: [2048, 3072, 4096], default: 2048 },
                rotate: { type: 'boolean', default: false }
            }
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    {
        name: 'email_server_runtime_config_get',
        title: 'Get mail runtime config',
        description: 'Read only the restricted SMTP/DKIM/public-origin variables used by the current server.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    {
        name: 'email_server_runtime_config_set',
        title: 'Set mail runtime config',
        description: 'Update only whitelisted SMTP/DKIM/public-origin settings for the managed domain. Arbitrary env variables and paths are rejected.',
        inputSchema: {
            type: 'object', additionalProperties: false,
            required: ['config'],
            properties: {
                domain: { type: 'string', enum: CONFIG.domains, default: 'egytag.com' },
                config: {
                    type: 'object', additionalProperties: false,
                    properties: {
                        smtpHostname: { type: 'string' },
                        dkimEnabled: { type: 'boolean' },
                        dkimRequireSigning: { type: 'boolean' },
                        dkimSelector: { type: 'string' },
                        emailPublicOrigin: { type: 'string' },
                        ipFamily: { type: 'integer', enum: [0, 4, 6] }
                    }
                }
            }
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    {
        name: 'email_server_restart',
        title: 'Restart mail service',
        description: 'Restart only the single configured PM2 process or systemd mail service. No arbitrary process/service name can be supplied.',
        inputSchema: { type: 'object', additionalProperties: false, properties: {} },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
    }
];

async function call(name, args) {
    if (name === 'email_server_host_status') return getHostStatus();
    if (name === 'email_server_dns_status') return getDnsStatus(args || {});
    if (name === 'email_server_dkim_status') return getDkimStatus(args || {});
    if (name === 'email_server_dkim_setup') return setupDkim(args || {});
    if (name === 'email_server_runtime_config_get') return getRuntimeConfig();
    if (name === 'email_server_runtime_config_set') return setRuntimeConfig(args || {});
    if (name === 'email_server_restart') return restartMailService();
    throw new Error('Unknown email host-admin tool: ' + name);
}

module.exports = { CONFIG, tools, call };
