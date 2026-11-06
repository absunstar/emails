'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); }
function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function atomicWrite(file, value) {
    ensureDir(path.dirname(file));
    const tmp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
}
function id(prefix) {
    const value = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    return prefix + value.replace(/[^a-zA-Z0-9_-]/g, '');
}
function email(value) {
    const v = String(value || '').trim().toLowerCase();
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) ? v : '';
}
function template(value, vars) {
    return String(value || '').replace(/\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g, (_, key) => {
        const parts = key.split('.');
        let cursor = vars;
        for (const part of parts) cursor = cursor && typeof cursor === 'object' ? cursor[part] : undefined;
        return cursor == null ? '' : String(cursor);
    });
}
function normalizeRecipient(input) {
    if (typeof input === 'string') return { email: email(input), variables: {} };
    const obj = input && typeof input === 'object' ? input : {};
    const address = email(obj.email || obj.to || '');
    const variables = Object.assign({}, obj.variables && typeof obj.variables === 'object' ? obj.variables : {});
    for (const [key, value] of Object.entries(obj)) {
        if (!['email', 'to', 'variables'].includes(key) && typeof value !== 'object') variables[key] = value;
    }
    variables.email = address;
    return { email: address, variables };
}
function normalizeMessage(input, index) {
    const msg = input && typeof input === 'object' ? input : {};
    return {
        id: String(msg.id || 'message_' + (index + 1)),
        name: String(msg.name || 'Message ' + (index + 1)).slice(0, 120),
        subject: String(msg.subject || '').slice(0, 998),
        text: typeof msg.text === 'string' ? msg.text : '',
        html: typeof msg.html === 'string' ? msg.html : '',
        replyTo: String(msg.replyTo || '').trim(),
    };
}
function parseStartAt(input) {
    if (!input || input === 'now') return new Date().toISOString();
    const ms = Date.parse(String(input));
    if (!Number.isFinite(ms)) throw new Error('Invalid campaign start time');
    return new Date(ms).toISOString();
}
function normalizePacing(input) {
    const p = input && typeof input === 'object' ? input : {};
    const mode = ['fixed', 'random', 'rate', 'batch'].includes(String(p.mode)) ? String(p.mode) : 'fixed';
    return {
        mode,
        intervalSeconds: Math.max(0, Number(p.intervalSeconds ?? 30)),
        minSeconds: Math.max(0, Number(p.minSeconds ?? 30)),
        maxSeconds: Math.max(0, Number(p.maxSeconds ?? 60)),
        perHour: Math.max(1, Number(p.perHour ?? 100)),
        batchSize: Math.max(1, Math.floor(Number(p.batchSize ?? 100))),
        batchPauseSeconds: Math.max(0, Number(p.batchPauseSeconds ?? 600)),
    };
}
function nextDelayMs(campaign) {
    const p = campaign.pacing || {};
    if (p.mode === 'random') {
        const min = Math.min(Number(p.minSeconds || 0), Number(p.maxSeconds || 0));
        const max = Math.max(Number(p.minSeconds || 0), Number(p.maxSeconds || 0));
        return Math.max(0, (min + Math.random() * Math.max(0, max - min)) * 1000);
    }
    if (p.mode === 'rate') return Math.max(0, 3600000 / Math.max(1, Number(p.perHour || 1)));
    if (p.mode === 'batch') {
        const sent = Number(campaign.stats?.sent || 0) + Number(campaign.stats?.failed || 0) + Number(campaign.stats?.unknown || 0);
        if (sent > 0 && sent % Math.max(1, Number(p.batchSize || 1)) === 0) return Math.max(0, Number(p.batchPauseSeconds || 0) * 1000);
    }
    return Math.max(0, Number(p.intervalSeconds || 0) * 1000);
}
function publicCampaign(c, detail) {
    const out = clone(c);
    if (!detail) {
        delete out.queue;
        if (Array.isArray(out.recipients)) out.recipients = { count: out.recipients.length };
        out.messages = (out.messages || []).map(m => ({ id: m.id, name: m.name, subject: m.subject }));
    }
    return out;
}

class EmailCampaignEngine {
    constructor(options = {}) {
        if (!options.emailService) throw new Error('emailService is required');
        this.emailService = options.emailService;
        this.baseDir = path.resolve(options.baseDir || path.join(process.cwd(), 'localStorage', 'email-campaigns'));
        this.dir = path.join(this.baseDir, 'campaigns');
        this.logger = typeof options.logger === 'function' ? options.logger : () => {};
        this.intervalMs = Math.max(500, Math.min(10000, Number(options.intervalMs || 1000)));
        this.timer = null;
        this.busy = false;
        ensureDir(this.dir);
        this._recover();
    }
    _path(cid) {
        const safe = String(cid || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!safe || safe !== String(cid || '')) throw new Error('Invalid campaign id');
        return path.join(this.dir, safe + '.json');
    }
    _save(c) { c.updatedAt = new Date().toISOString(); atomicWrite(this._path(c.id), c); return clone(c); }
    _read(cid) { return readJson(this._path(cid)); }
    _all() {
        return fs.readdirSync(this.dir).filter(n => n.endsWith('.json')).map(n => readJson(path.join(this.dir, n))).filter(Boolean);
    }
    _recover() {
        for (const c of this._all()) {
            let dirty = false;
            for (const item of c.queue || []) {
                if (item.status === 'sending') {
                    item.status = 'delivery_unknown';
                    item.error = 'Server stopped while this message was sending; delivery was not retried automatically.';
                    item.finishedAt = new Date().toISOString();
                    dirty = true;
                }
            }
            if (c.status === 'running') { c.status = 'paused'; c.pauseReason = 'Recovered after server restart'; dirty = true; }
            if (dirty) { this._recount(c); this._save(c); }
        }
    }
    _recount(c) {
        const stats = { total: (c.queue || []).length, pending: 0, sending: 0, sent: 0, failed: 0, unknown: 0, skipped: 0 };
        for (const item of c.queue || []) {
            if (item.status === 'delivery_unknown') stats.unknown++;
            else if (Object.prototype.hasOwnProperty.call(stats, item.status)) stats[item.status]++;
        }
        c.stats = stats;
        c.progress = stats.total ? Math.round(((stats.sent + stats.failed + stats.unknown + stats.skipped) / stats.total) * 10000) / 100 : 0;
        return stats;
    }
    _buildQueue(recipients, messages, mode) {
        const queue = [];
        if (mode === 'sequence') {
            for (const recipient of recipients) for (let i = 0; i < messages.length; i++) queue.push({
                id: id('job_'), recipient: recipient.email, variables: recipient.variables, messageIndex: i, status: 'pending', attempts: 0,
            });
        } else {
            recipients.forEach((recipient, i) => queue.push({
                id: id('job_'), recipient: recipient.email, variables: recipient.variables, messageIndex: i % messages.length, status: 'pending', attempts: 0,
            }));
        }
        return queue;
    }
    create(input = {}) {
        const name = String(input.name || '').trim();
        const from = email(input.from || '');
        if (!name) throw new Error('Campaign name is required');
        if (!from) throw new Error('A valid From address is required');
        const recipients = (Array.isArray(input.recipients) ? input.recipients : []).map(normalizeRecipient).filter(r => r.email);
        const unique = []; const seen = new Set();
        for (const r of recipients) if (!seen.has(r.email)) { seen.add(r.email); unique.push(r); }
        if (!unique.length) throw new Error('At least one valid recipient is required');
        const messages = (Array.isArray(input.messages) ? input.messages : []).map(normalizeMessage).filter(m => m.text || m.html);
        if (!messages.length) throw new Error('At least one message with text or HTML content is required');
        const messageMode = input.messageMode === 'sequence' ? 'sequence' : 'rotate';
        const startAt = parseStartAt(input.startAt || 'now');
        const c = {
            id: id('campaign_'), name, description: String(input.description || '').slice(0, 1000), from,
            replyTo: String(input.replyTo || '').trim(), recipients: unique, messages, messageMode,
            pacing: normalizePacing(input.pacing), startAt, status: 'draft',
            createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), startedAt: null, completedAt: null,
            nextSendAt: startAt, queue: this._buildQueue(unique, messages, messageMode), events: [],
        };
        this._recount(c);
        c.events.push({ at: c.createdAt, type: 'created', message: 'Campaign created' });
        return publicCampaign(this._save(c), true);
    }
    update(cid, patch = {}) {
        const c = this._read(cid); if (!c) throw new Error('Campaign not found');
        if (!['draft', 'paused', 'scheduled'].includes(c.status)) throw new Error('Pause or stop the campaign before editing');
        if (patch.name != null) c.name = String(patch.name).trim() || c.name;
        if (patch.pacing) c.pacing = normalizePacing(patch.pacing);
        if (patch.startAt) { c.startAt = parseStartAt(patch.startAt); c.nextSendAt = c.startAt; }
        c.events.push({ at: new Date().toISOString(), type: 'updated', message: 'Campaign settings updated' });
        return publicCampaign(this._save(c), true);
    }
    list(input = {}) {
        const status = String(input.status || '').trim();
        const items = this._all().filter(c => !status || c.status === status).sort((a,b) => Date.parse(b.createdAt)-Date.parse(a.createdAt));
        return { count: items.length, campaigns: items.slice(0, Math.max(1, Math.min(500, Number(input.limit || 100)))).map(c => publicCampaign(c, false)) };
    }
    get(cid) { const c = this._read(cid); if (!c) throw new Error('Campaign not found'); return publicCampaign(c, true); }
    start(cid) {
        const c = this._read(cid); if (!c) throw new Error('Campaign not found');
        if (['completed', 'stopped'].includes(c.status)) throw new Error('Campaign is already finished');
        const now = Date.now(); const start = Date.parse(c.startAt);
        c.status = start > now ? 'scheduled' : 'running';
        c.startedAt = c.startedAt || new Date().toISOString(); c.nextSendAt = start > now ? c.startAt : new Date().toISOString(); c.pauseReason = '';
        c.events.push({ at: new Date().toISOString(), type: 'start', message: c.status === 'scheduled' ? 'Campaign scheduled' : 'Campaign started' });
        return publicCampaign(this._save(c), true);
    }
    pause(cid) { const c=this._read(cid); if(!c) throw new Error('Campaign not found'); if(!['running','scheduled'].includes(c.status)) return publicCampaign(c,true); c.status='paused'; c.pauseReason='Paused by user'; c.events.push({at:new Date().toISOString(),type:'pause',message:'Campaign paused'}); return publicCampaign(this._save(c),true); }
    resume(cid) { const c=this._read(cid); if(!c) throw new Error('Campaign not found'); if(c.status!=='paused') throw new Error('Campaign is not paused'); c.status='running'; c.nextSendAt=new Date().toISOString(); c.pauseReason=''; c.events.push({at:new Date().toISOString(),type:'resume',message:'Campaign resumed'}); return publicCampaign(this._save(c),true); }
    stop(cid) { const c=this._read(cid); if(!c) throw new Error('Campaign not found'); if(['completed','stopped'].includes(c.status)) return publicCampaign(c,true); c.status='stopped'; c.completedAt=new Date().toISOString(); c.events.push({at:c.completedAt,type:'stop',message:'Campaign stopped'}); return publicCampaign(this._save(c),true); }
    remove(cid) { const c=this._read(cid); if(!c) throw new Error('Campaign not found'); if(['running','scheduled'].includes(c.status)) throw new Error('Stop the campaign before deleting'); fs.rmSync(this._path(cid),{force:true}); return {id:cid,deleted:true}; }
    report(cid) {
        const c = this.get(cid);
        const failures = (c.queue || []).filter(i => ['failed','delivery_unknown'].includes(i.status)).map(i => ({ recipient:i.recipient,status:i.status,error:i.error||'',messageIndex:i.messageIndex,finishedAt:i.finishedAt||'' }));
        return { id:c.id, name:c.name, status:c.status, progress:c.progress, stats:c.stats, startedAt:c.startedAt, completedAt:c.completedAt, nextSendAt:c.nextSendAt, failures, events:c.events || [] };
    }
    async _sendOne(c) {
        const item = (c.queue || []).find(i => i.status === 'pending');
        if (!item) {
            c.status = 'completed'; c.completedAt = new Date().toISOString(); this._recount(c);
            c.events.push({ at: c.completedAt, type: 'complete', message: 'Campaign completed' }); this._save(c); return;
        }
        const msg = c.messages[item.messageIndex] || c.messages[0];
        item.status = 'sending'; item.attempts = Number(item.attempts || 0) + 1; item.startedAt = new Date().toISOString();
        this._recount(c); this._save(c);
        const vars = Object.assign({}, item.variables || {}, { email: item.recipient, campaign: { id: c.id, name: c.name } });
        try {
            const result = await this.emailService.send({
                from: c.from, to: item.recipient, replyTo: c.replyTo || msg.replyTo || '',
                subject: template(msg.subject, vars), text: template(msg.text, vars), html: template(msg.html, vars),
            });
            item.status = 'sent'; item.guid = result?.guid || ''; item.error = ''; item.finishedAt = new Date().toISOString();
        } catch (error) {
            item.status = 'failed'; item.error = error?.message || String(error); item.finishedAt = new Date().toISOString();
        }
        this._recount(c);
        if (!c.stats.pending) {
            c.status = 'completed'; c.completedAt = new Date().toISOString();
            c.events.push({ at: c.completedAt, type: 'complete', message: 'Campaign completed' });
        } else c.nextSendAt = new Date(Date.now() + nextDelayMs(c)).toISOString();
        this._save(c);
    }
    async tick() {
        if (this.busy) return; this.busy = true;
        try {
            const now = Date.now();
            const active = this._all().filter(c => ['scheduled','running'].includes(c.status)).sort((a,b)=>Date.parse(a.nextSendAt||a.startAt)-Date.parse(b.nextSendAt||b.startAt));
            for (const c of active) {
                if (c.status === 'scheduled' && Date.parse(c.startAt) <= now) { c.status='running'; c.nextSendAt=new Date().toISOString(); this._save(c); }
                if (c.status === 'running' && Date.parse(c.nextSendAt || 0) <= Date.now()) await this._sendOne(c);
            }
        } catch (error) { this.logger('Email campaign tick error: ' + (error?.message || error)); }
        finally { this.busy = false; }
    }
    status() {
        const all=this._all(); const counts={};
        for(const c of all) counts[c.status]=(counts[c.status]||0)+1;
        return { enabled:true, total:all.length, counts, intervalMs:this.intervalMs, storage:this.dir };
    }
    startEngine() { if(this.timer) return this; this.tick().catch(()=>{}); this.timer=setInterval(()=>this.tick().catch(()=>{}),this.intervalMs); if(this.timer.unref) this.timer.unref(); return this; }
    stopEngine() { if(this.timer) clearInterval(this.timer); this.timer=null; return this; }
}
function createEmailCampaignEngine(options) { return new EmailCampaignEngine(options); }
module.exports = { EmailCampaignEngine, createEmailCampaignEngine };
