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

function atomicWriteJson(filePath, value) {
    ensureDir(path.dirname(filePath));
    const tmp = filePath + '.' + process.pid + '.' + crypto.randomBytes(5).toString('hex') + '.tmp';
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

function readJson(filePath) {
    try {
        const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch (_) {
        return null;
    }
}

function makeId() {
    const value = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    return 'schedule_' + value.replace(/[^a-zA-Z0-9_-]/g, '');
}

function normalizeOffset(value) {
    const text = String(value || '').trim();
    if (/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/.test(text)) return text;
    if (/^Z$/i.test(text)) return 'Z';
    return '';
}

function parseWhen(input, nowMs) {
    input = input || {};
    let original = '';
    let offset = normalizeOffset(input.timezoneOffset);
    if (input.sendAt) {
        original = String(input.sendAt).trim();
        if (!/[zZ]|[+-]\d{2}:\d{2}$/.test(original)) {
            if (!offset) throw new Error('sendAt must include a timezone offset such as +03:00 or Z');
            original += offset;
        }
    } else {
        const date = String(input.date || '').trim();
        const time = String(input.time || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must use YYYY-MM-DD');
        if (!/^\d{2}:\d{2}(?::\d{2})?$/.test(time)) throw new Error('time must use HH:mm or HH:mm:ss');
        if (!offset) throw new Error('timezoneOffset is required with date/time, for example +03:00');
        original = date + 'T' + (time.length === 5 ? time + ':00' : time) + offset;
    }
    const ms = Date.parse(original);
    if (!Number.isFinite(ms)) throw new Error('Invalid schedule date/time');
    const now = Number(nowMs || Date.now());
    if (ms < now - 1000) throw new Error('Scheduled time must be in the future');
    const maxFutureMs = 5 * 365 * 24 * 60 * 60 * 1000;
    if (ms > now + maxFutureMs) throw new Error('Scheduled time is too far in the future');
    if (!offset) {
        const match = original.match(/(Z|[+-]\d{2}:\d{2})$/i);
        offset = match ? match[1].toUpperCase() : 'Z';
    }
    return {
        input: original,
        utc: new Date(ms).toISOString(),
        timestamp: ms,
        timezoneOffset: offset,
        timezone: String(input.timezone || offset || 'UTC').trim().slice(0, 100) || 'UTC',
    };
}

function normalizeMessage(message) {
    message = message && typeof message === 'object' && !Array.isArray(message) ? message : {};
    return {
        from: String(message.from || '').trim(),
        to: Array.isArray(message.to) ? message.to.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50) : String(message.to || '').trim(),
        cc: Array.isArray(message.cc) ? message.cc.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 50) : String(message.cc || '').trim(),
        subject: String(message.subject || '').slice(0, 998),
        text: typeof message.text === 'string' ? message.text : '',
        html: typeof message.html === 'string' ? message.html : '',
        replyTo: String(message.replyTo || '').trim(),
        inReplyTo: String(message.inReplyTo || '').trim(),
    };
}

function publicTask(task, includeBody) {
    const copy = clone(task);
    if (!includeBody && copy && copy.message) {
        copy.message = Object.assign({}, copy.message, {
            text: copy.message.text ? '[stored ' + Buffer.byteLength(copy.message.text, 'utf8') + ' bytes]' : '',
            html: copy.message.html ? '[stored ' + Buffer.byteLength(copy.message.html, 'utf8') + ' bytes]' : '',
        });
    }
    return copy;
}

class EmailScheduler {
    constructor(options) {
        options = options || {};
        if (!options.emailService) throw new Error('emailService is required');
        this.emailService = options.emailService;
        this.abusePolicy = options.abusePolicy || null;
        this.baseDir = path.resolve(options.baseDir || path.join(process.cwd(), 'localStorage', 'email-schedules'));
        this.tasksDir = path.join(this.baseDir, 'tasks');
        this.logger = typeof options.logger === 'function' ? options.logger : () => {};
        this.intervalMs = Math.max(1000, Math.min(Number(options.intervalMs || 5000), 60000));
        this.timer = null;
        this.running = false;
        ensureDir(this.tasksDir);
        this._recoverInterrupted();
    }

    _recoverInterrupted() {
        const now = new Date().toISOString();
        for (const task of this._all()) {
            if (task.status !== 'sending') continue;
            task.status = 'failed';
            task.failedAt = now;
            task.nextAttemptAt = null;
            task.lastError = 'Scheduler process stopped while this message was sending. Delivery state is unknown; review before retrying to avoid a duplicate.';
            this._save(task);
        }
    }

    _taskPath(id) {
        const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
        if (!safe || safe !== String(id || '')) throw new Error('Invalid schedule id');
        return path.join(this.tasksDir, safe + '.json');
    }

    _lockPath(id) {
        return this._taskPath(id) + '.lock';
    }

    _save(task) {
        task.updatedAt = new Date().toISOString();
        atomicWriteJson(this._taskPath(task.id), task);
        return clone(task);
    }

    _read(id) {
        return readJson(this._taskPath(id));
    }

    _all() {
        if (!fs.existsSync(this.tasksDir)) return [];
        const tasks = [];
        for (const name of fs.readdirSync(this.tasksDir)) {
            if (!name.endsWith('.json')) continue;
            const task = readJson(path.join(this.tasksDir, name));
            if (task && task.id) tasks.push(task);
        }
        return tasks;
    }

    _acquire(id) {
        const lockPath = this._lockPath(id);
        try {
            const fd = fs.openSync(lockPath, 'wx', 0o600);
            fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
            fs.closeSync(fd);
            return true;
        } catch (_) {
            try {
                const stat = fs.statSync(lockPath);
                if (Date.now() - stat.mtimeMs > 15 * 60 * 1000) {
                    fs.unlinkSync(lockPath);
                    const fd = fs.openSync(lockPath, 'wx', 0o600);
                    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
                    fs.closeSync(fd);
                    return true;
                }
            } catch (_) {}
            return false;
        }
    }

    _release(id) {
        try { fs.unlinkSync(this._lockPath(id)); } catch (_) {}
    }

    _rateHit() {
        if (!this.abusePolicy || typeof this.abusePolicy.outboundHit !== 'function') return { allowed: true };
        return this.abusePolicy.outboundHit('mcp:SOCIALBROWERMANAGER', 'mcp');
    }

    async _execute(id, force) {
        if (!this._acquire(id)) return { busy: true, id };
        try {
            let task = this._read(id);
            if (!task) throw new Error('Scheduled email not found');
            const allowedStatuses = force ? ['scheduled', 'failed'] : ['scheduled'];
            if (!allowedStatuses.includes(task.status)) return publicTask(task, true);
            if (!force && Date.parse(task.nextAttemptAt || task.sendAtUtc) > Date.now()) return publicTask(task, true);

            const rate = this._rateHit();
            if (!rate.allowed) {
                const retryMs = Math.max(1000, Number(rate.retryAfterMs || 60000));
                task.status = 'scheduled';
                task.lastError = 'Outbound rate limit reached; send deferred automatically.';
                task.nextAttemptAt = new Date(Date.now() + retryMs).toISOString();
                task.rateLimitedAt = new Date().toISOString();
                this._save(task);
                return publicTask(task, true);
            }

            task.status = 'sending';
            task.lastAttemptAt = new Date().toISOString();
            task.attempts = Number(task.attempts || 0) + 1;
            this._save(task);
            try {
                const result = await this.emailService.send(task.message);
                task = this._read(id) || task;
                task.status = 'sent';
                task.sentAt = new Date().toISOString();
                task.sentGuid = result?.guid || '';
                task.result = result || null;
                task.lastError = '';
                task.nextAttemptAt = null;
                this._save(task);
                if (this.emailService.store?.audit) await this.emailService.store.audit('email_schedule_sent', { scheduleId: task.id, guid: task.sentGuid, sendAtUtc: task.sendAtUtc, attempts: task.attempts });
                return publicTask(task, true);
            } catch (error) {
                task = this._read(id) || task;
                task.lastError = error?.message || String(error);
                if (Number(error?.retryAfterMs || 0) > 0 && error?.permanent !== true) {
                    task.attempts = Math.max(0, Number(task.attempts || 1) - 1);
                    task.status = 'scheduled';
                    task.nextAttemptAt = new Date(Date.now() + Math.max(1000, Number(error.retryAfterMs))).toISOString();
                    task.deliverabilityDeferredAt = new Date().toISOString();
                    task.deliverabilityCode = String(error?.code || 'DELIVERABILITY_DEFERRED');
                } else {
                    const retries = Number(task.maxRetries || 0);
                    if (error?.permanent === true || task.attempts > retries) {
                        task.status = 'failed';
                        task.failedAt = new Date().toISOString();
                        task.nextAttemptAt = null;
                    } else {
                        const delay = Math.max(30, Number(task.retryDelaySeconds || 300)) * Math.max(1, Math.pow(2, task.attempts - 1));
                        task.status = 'scheduled';
                        task.nextAttemptAt = new Date(Date.now() + delay * 1000).toISOString();
                    }
                }
                this._save(task);
                if (this.emailService.store?.audit) await this.emailService.store.audit('email_schedule_failed', { scheduleId: task.id, sendAtUtc: task.sendAtUtc, attempts: task.attempts, status: task.status, error: task.lastError });
                return publicTask(task, true);
            }
        } finally {
            this._release(id);
        }
    }

    async schedule(args, scope) {
        args = args || {};
        const when = parseWhen(args);
        const message = normalizeMessage(args.message || args);
        if (!message.from) throw new Error('from is required');
        if (!(Array.isArray(message.to) ? message.to.length : message.to)) throw new Error('to is required');
        if (!message.text && !message.html) throw new Error('text or html is required');
        const retriesValue = Number(args.maxRetries === undefined ? 3 : args.maxRetries);
        const delayValue = Number(args.retryDelaySeconds === undefined ? 300 : args.retryDelaySeconds);
        const maxRetries = Number.isFinite(retriesValue) ? Math.max(0, Math.min(Math.round(retriesValue), 10)) : 3;
        const retryDelaySeconds = Number.isFinite(delayValue) ? Math.max(30, Math.min(Math.round(delayValue), 86400)) : 300;
        const now = new Date().toISOString();
        const task = {
            version: 1,
            id: makeId(),
            status: 'scheduled',
            message,
            sendAt: when.input,
            sendAtUtc: when.utc,
            timezone: when.timezone,
            timezoneOffset: when.timezoneOffset,
            nextAttemptAt: when.utc,
            attempts: 0,
            maxRetries,
            retryDelaySeconds,
            createdAt: now,
            updatedAt: now,
            createdBy: String(scope?.client || 'mcp-agent').slice(0, 160),
            lastAttemptAt: null,
            sentAt: null,
            failedAt: null,
            cancelledAt: null,
            sentGuid: '',
            lastError: '',
        };
        this._save(task);
        if (this.emailService.store?.audit) await this.emailService.store.audit('email_schedule_created', { scheduleId: task.id, from: message.from, to: message.to, subject: message.subject, sendAtUtc: task.sendAtUtc });
        return publicTask(task, true);
    }

    async scheduleBulk(args, scope) {
        args = args || {};
        const messages = Array.isArray(args.messages) ? args.messages : [];
        const maxItems = this.abusePolicy?.getConfig?.()?.limits?.outbound?.bulkMaxMessages || 100;
        if (!messages.length || messages.length > maxItems) throw new Error('messages must contain 1 to ' + maxItems + ' items');
        const base = parseWhen(args);
        const spacing = Math.max(0, Math.min(Number(args.spacingSeconds || 0), 86400));
        const tasks = [];
        for (let index = 0; index < messages.length; index += 1) {
            const ms = base.timestamp + index * spacing * 1000;
            const item = await this.schedule({
                message: messages[index],
                sendAt: new Date(ms).toISOString(),
                timezone: base.timezone,
                maxRetries: args.maxRetries,
                retryDelaySeconds: args.retryDelaySeconds,
            }, scope);
            tasks.push(item);
        }
        return { scheduled: tasks.length, firstSendAtUtc: tasks[0]?.sendAtUtc || null, lastSendAtUtc: tasks[tasks.length - 1]?.sendAtUtc || null, tasks };
    }

    list(args) {
        args = args || {};
        const status = String(args.status || '').trim().toLowerCase();
        const after = args.after ? Date.parse(args.after) : NaN;
        const before = args.before ? Date.parse(args.before) : NaN;
        const limit = Math.max(1, Math.min(Number(args.limit || 100), 500));
        const includeBody = !!args.includeBody;
        let tasks = this._all();
        if (status) tasks = tasks.filter((task) => task.status === status);
        if (Number.isFinite(after)) tasks = tasks.filter((task) => Date.parse(task.sendAtUtc) >= after);
        if (Number.isFinite(before)) tasks = tasks.filter((task) => Date.parse(task.sendAtUtc) <= before);
        tasks.sort((a, b) => Date.parse(a.sendAtUtc) - Date.parse(b.sendAtUtc));
        const total = tasks.length;
        tasks = tasks.slice(0, limit).map((task) => publicTask(task, includeBody));
        return { count: tasks.length, total, tasks };
    }

    get(id, includeBody) {
        const task = this._read(id);
        if (!task) throw new Error('Scheduled email not found');
        return publicTask(task, includeBody !== false);
    }

    async update(id, args) {
        if (!this._acquire(id)) throw new Error('Scheduled email is busy. Try again.');
        try {
            let task = this._read(id);
            if (!task) throw new Error('Scheduled email not found');
            if (task.status === 'sent' || task.status === 'sending') throw new Error('A sent or currently sending schedule cannot be edited');
            if (args.message) {
                const next = normalizeMessage(Object.assign({}, task.message, args.message));
                if (!next.from || !(Array.isArray(next.to) ? next.to.length : next.to) || (!next.text && !next.html)) throw new Error('Updated message is incomplete');
                task.message = next;
            }
            if (args.sendAt || args.date || args.time || args.timezoneOffset) {
                const when = parseWhen(args);
                task.sendAt = when.input;
                task.sendAtUtc = when.utc;
                task.timezone = when.timezone;
                task.timezoneOffset = when.timezoneOffset;
                task.nextAttemptAt = when.utc;
            }
            if (args.maxRetries !== undefined) {
                const value = Number(args.maxRetries);
                if (!Number.isFinite(value)) throw new Error('maxRetries must be numeric');
                task.maxRetries = Math.max(0, Math.min(Math.round(value), 10));
            }
            if (args.retryDelaySeconds !== undefined) {
                const value = Number(args.retryDelaySeconds);
                if (!Number.isFinite(value)) throw new Error('retryDelaySeconds must be numeric');
                task.retryDelaySeconds = Math.max(30, Math.min(Math.round(value), 86400));
            }
            task.status = 'scheduled';
            task.cancelledAt = null;
            task.failedAt = null;
            task.lastError = '';
            this._save(task);
            if (this.emailService.store?.audit) await this.emailService.store.audit('email_schedule_updated', { scheduleId: task.id, sendAtUtc: task.sendAtUtc });
            return publicTask(task, true);
        } finally {
            this._release(id);
        }
    }

    async cancel(id) {
        if (!this._acquire(id)) throw new Error('Scheduled email is busy. Try again.');
        try {
            const task = this._read(id);
            if (!task) throw new Error('Scheduled email not found');
            if (task.status === 'sent') throw new Error('A sent schedule cannot be cancelled');
            if (task.status === 'sending') throw new Error('This schedule is currently sending');
            task.status = 'cancelled';
            task.cancelledAt = new Date().toISOString();
            task.nextAttemptAt = null;
            this._save(task);
            if (this.emailService.store?.audit) await this.emailService.store.audit('email_schedule_cancelled', { scheduleId: task.id });
            return publicTask(task, true);
        } finally {
            this._release(id);
        }
    }

    async sendNow(id) {
        return this._execute(id, true);
    }

    async retry(id, args) {
        if (!this._acquire(id)) throw new Error('Scheduled email is busy. Try again.');
        try {
            const task = this._read(id);
            if (!task) throw new Error('Scheduled email not found');
            if (!['failed', 'cancelled'].includes(task.status)) throw new Error('Only failed or cancelled schedules can be retried');
            const immediate = new Date(Date.now() + 1000).toISOString();
            const when = args && (args.sendAt || args.date || args.time) ? parseWhen(args) : { input: immediate, utc: immediate, timezone: 'UTC', timezoneOffset: 'Z' };
            task.status = 'scheduled';
            task.sendAt = when.input;
            task.sendAtUtc = when.utc;
            task.timezone = when.timezone;
            task.timezoneOffset = when.timezoneOffset;
            task.nextAttemptAt = when.utc;
            task.failedAt = null;
            task.cancelledAt = null;
            task.lastError = '';
            if (args?.resetAttempts !== false) task.attempts = 0;
            this._save(task);
            if (this.emailService.store?.audit) await this.emailService.store.audit('email_schedule_retried', { scheduleId: task.id, sendAtUtc: task.sendAtUtc });
            return publicTask(task, true);
        } finally {
            this._release(id);
        }
    }

    prunePreview(args) {
        args = args || {};
        const completedCutoff = Date.now() - Math.max(1, Number(args.completedDays || 30)) * 86400000;
        const cancelledCutoff = Date.now() - Math.max(1, Number(args.cancelledDays || 7)) * 86400000;
        const ids = [];
        let bytes = 0;
        for (const task of this._all()) {
            const status = String(task.status || '');
            let remove = false;
            if (status === 'sent' || status === 'failed') {
                const value = Date.parse(task.sentAt || task.failedAt || task.updatedAt || task.createdAt || 0);
                remove = Number.isFinite(value) && value < completedCutoff;
            } else if (status === 'cancelled') {
                const value = Date.parse(task.cancelledAt || task.updatedAt || task.createdAt || 0);
                remove = Number.isFinite(value) && value < cancelledCutoff;
            }
            if (!remove) continue;
            ids.push(task.id);
            try { bytes += fs.statSync(this._taskPath(task.id)).size; } catch (_) {}
        }
        return { count: ids.length, ids, bytes };
    }

    pruneByIds(ids) {
        const unique = Array.from(new Set((ids || []).map((id) => String(id || '')).filter(Boolean)));
        const deleted = [];
        const skipped = [];
        for (const id of unique) {
            let task;
            try { task = this._read(id); } catch (_) { task = null; }
            if (!task) { skipped.push(id); continue; }
            if (!['sent', 'failed', 'cancelled'].includes(String(task.status || ''))) { skipped.push(id); continue; }
            try {
                fs.rmSync(this._taskPath(id), { force: true });
                try { fs.rmSync(this._lockPath(id), { force: true }); } catch (_) {}
                deleted.push(id);
            } catch (_) { skipped.push(id); }
        }
        return { deleted, skipped, count: deleted.length };
    }

    status() {
        const tasks = this._all();
        const counts = {};
        for (const task of tasks) counts[task.status] = Number(counts[task.status] || 0) + 1;
        const scheduled = tasks.filter((task) => task.status === 'scheduled').sort((a, b) => Date.parse(a.nextAttemptAt || a.sendAtUtc) - Date.parse(b.nextAttemptAt || b.sendAtUtc));
        return { enabled: true, storage: this.tasksDir, intervalMs: this.intervalMs, total: tasks.length, counts, next: scheduled.length ? publicTask(scheduled[0], false) : null };
    }

    async tick() {
        if (this.running) return;
        this.running = true;
        try {
            const now = Date.now();
            const due = this._all().filter((task) => task.status === 'scheduled' && Date.parse(task.nextAttemptAt || task.sendAtUtc) <= now).sort((a, b) => Date.parse(a.nextAttemptAt || a.sendAtUtc) - Date.parse(b.nextAttemptAt || b.sendAtUtc)).slice(0, 20);
            for (const task of due) await this._execute(task.id, false);
        } catch (error) {
            this.logger('Email scheduler tick error: ' + (error?.message || error));
        } finally {
            this.running = false;
        }
    }

    start() {
        if (this.timer) return this;
        this.tick().catch(() => {});
        this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
        if (typeof this.timer.unref === 'function') this.timer.unref();
        return this;
    }

    stop() {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        return this;
    }
}

function createEmailScheduler(options) {
    return new EmailScheduler(options);
}

module.exports = {
    EmailScheduler,
    createEmailScheduler,
    parseWhen,
};
