'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const EVENTS = new Set(['view', 'generated', 'copied', 'open']);
function publicHost(input) {
    try {
        const url = new URL(String(input || '').slice(0, 2048));
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return '';
        let host = url.hostname.toLowerCase().replace(/\.$/, '');
        if (!host || host.length > 190 || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.')) return '';
        if (host === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.endsWith('.invalid') || host === 'egytag.com' || host === 'emails.egytag.com' || host.endsWith('.local')) return '';
        return host;
    } catch (_) { return ''; }
}
function createEmbedMetrics({file, secret = crypto.randomBytes(32), now = () => Date.now()}) {
    const rows = new Map();
    let timer = null, pending = Promise.resolve();
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const [key, row] of Object.entries(data || {})) {
            if (/^\d{4}-\d{2}-\d{2}\|[a-z0-9.-]{3,190}$/.test(key) && row && typeof row === 'object') {
                rows.set(key, Object.fromEntries([...EVENTS].map(e => [e, Math.min(1e9, Math.max(0, Number(row[e] || 0) || 0))])));
            }
        }
    } catch (_) {}
    const key = Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret));
    const sign = payload => crypto.createHmac('sha256', key).update(payload).digest('base64url');
    function issue(domain) {
        const value = Buffer.from(JSON.stringify({ h: domain || '', exp: Math.floor(now() / 1000) + 3600, nonce: crypto.randomBytes(9).toString('base64url') })).toString('base64url');
        return value + '.' + sign(value);
    }
    function verify(token) {
        if (typeof token !== 'string' || token.length > 800) return null;
        const segments = token.split('.');
        if (segments.length !== 2) return null;
        const actual = Buffer.from(segments[1]); const expected = Buffer.from(sign(segments[0]));
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
        try {const value = JSON.parse(Buffer.from(segments[0], 'base64url').toString('utf8'));
            if (value.exp <= now()/1000 || value.exp > now()/1000+3700) return null;
            return value.h === '' || /^[a-z0-9.-]{3,190}$/.test(value.h) ? value.h : null;
        } catch (_) { return null; }
    }
    function flush() {
        const cutoff = new Date(now() - 35*86400000).toISOString().slice(0,10);
        for (const k of rows.keys()) if (k.slice(0,10) < cutoff) rows.delete(k);
        const saved = Object.fromEntries(rows);
        pending = pending.then(async () => {
            await fs.promises.mkdir(path.dirname(file),{recursive:true});
            const tmp = file + '.' + process.pid + '.tmp';
            await fs.promises.writeFile(tmp,JSON.stringify(saved),{mode:0o600});
            await fs.promises.rename(tmp,file);
        }).catch(() => {});
        return pending;
    }
    function track(host, event) {
        if (!host || !EVENTS.has(event)) return false;
        const day = new Date(now()).toISOString().slice(0,10);
        const k = day+'|'+host;
        const item = rows.get(k) || {view:0,generated:0,copied:0,open:0};
        item[event] = Math.min(1e9,(item[event] || 0)+1); rows.set(k,item);
        if (!timer) {
            timer = setTimeout(() => {timer=null;void flush();},20000);
            if (timer.unref) timer.unref();
        }
        return true;
    }
    function stats(domain) {
        const out = {domain,periodDays:30,views:0,generated:0,copied:0,open:0,byDay:[]};
        const since = new Date(now()-29*86400000).toISOString().slice(0,10);
        for (const [key,entry] of rows) {
            if (key.slice(11)!==domain || key.slice(0,10)<since) continue;
            const day = {date:key.slice(0,10),...entry};out.byDay.push(day);
            for (const name of EVENTS) out[name === 'view' ? 'views' : name] += entry[name] || 0;
        }
        out.byDay.sort((a,b)=>a.date.localeCompare(b.date));
        return out;
    }
    return {publicHost, issue, verify,track,stats,flush};
}
module.exports={publicHost,createEmbedMetrics};
