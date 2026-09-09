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

function hash(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function atomicWriteJson(filePath, value) {
    ensureDir(path.dirname(filePath));
    const tmpPath = filePath + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    const data = JSON.stringify(value, null, 2) + '\n';
    fs.writeFileSync(tmpPath, data, { encoding: 'utf8', mode: 0o600 });
    try {
        fs.renameSync(tmpPath, filePath);
    } catch (error) {
        // Windows rename does not always replace an existing file atomically.
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
            fs.renameSync(tmpPath, filePath);
        } catch (replaceError) {
            try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
            throw replaceError;
        }
    }
}

function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath)) return clone(fallback);
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return clone(fallback);
    }
}

function walkJsonFiles(dir, out) {
    if (!fs.existsSync(dir)) return out;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walkJsonFiles(full, out);
        else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
    }
    return out;
}

class EmailFileStore {
    constructor(options) {
        options = options || {};
        this.baseDir = path.resolve(options.baseDir || path.join(process.cwd(), 'localStorage', 'email-files'));
        this.messagesDir = path.join(this.baseDir, 'messages');
        this.attachmentsDir = path.join(this.baseDir, 'attachments');
        this.trackingDir = path.join(this.baseDir, 'tracking');
        this.auditDir = path.join(this.baseDir, 'audit');
        this.metaPath = path.join(this.baseDir, 'meta.json');
        this.adminFoldersPath = path.join(this.baseDir, 'admin-folders.json');
        this.vipPath = path.resolve(options.vipPath || path.join(process.cwd(), 'localStorage', 'vip-email-list.json'));
        this.configuredMaxMessages = Math.max(1, Number(options.maxMessages || 100000));
        this.maxMessages = this.configuredMaxMessages;
        this.maxMessagesManaged = false;
        this.logger = typeof options.logger === 'function' ? options.logger : () => {};
        this.isProtectedMessage = typeof options.isProtectedMessage === 'function' ? options.isProtectedMessage : () => false;
        this.messages = new Map();
        this.messagesById = new Map();
        this.vipEntries = [];
        this.adminFolders = [];
        this._mutationQueue = Promise.resolve();

        ensureDir(this.messagesDir);
        ensureDir(this.attachmentsDir);
        ensureDir(this.trackingDir);
        ensureDir(this.auditDir);
        ensureDir(path.dirname(this.vipPath));
        const persistedMeta = readJson(this.metaPath, {});
        const persistedLimit = Number(persistedMeta?.maxMessages);
        if (persistedMeta?.maxMessagesManaged === true && Number.isFinite(persistedLimit) && persistedLimit >= 1) {
            this.maxMessages = Math.floor(persistedLimit);
            this.maxMessagesManaged = true;
        }
        this._loadMessages();
        this._loadVip();
        this._loadAdminFolders();
        this._syncMeta();
    }

    _messagePath(guid) {
        const key = hash(guid);
        return path.join(this.messagesDir, key.slice(0, 2), key + '.json');
    }

    _attachmentDir(guid) {
        const key = hash(guid);
        return path.join(this.attachmentsDir, key.slice(0, 2), key);
    }

    _attachmentPath(guid, id) {
        return path.join(this._attachmentDir(guid), hash(id) + '.bin');
    }

    _trackingPath(name) {
        const key = hash(String(name || '').toLowerCase());
        return path.join(this.trackingDir, key.slice(0, 2), key + '.json');
    }

    _loadMessages() {
        this.messages.clear();
        this.messagesById.clear();
        let maxId = 0;
        const files = walkJsonFiles(this.messagesDir, []);
        for (const filePath of files) {
            try {
                const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (!doc || !doc.guid) continue;
                this.messages.set(String(doc.guid), doc);
                const id = Number(doc.id || 0);
                if (Number.isFinite(id) && id > 0) {
                    this.messagesById.set(String(id), doc);
                    if (id > maxId) maxId = id;
                }
            } catch (error) {
                this.logger('Skipped invalid email JSON ' + filePath + ': ' + (error.message || error));
            }
        }
        const meta = this.readMeta();
        this.nextId = Math.max(maxId + 1, Number(meta.nextId || 1));
    }

    _loadVip() {
        const list = readJson(this.vipPath, []);
        this.vipEntries = Array.isArray(list) ? list.filter((item) => item && item.email) : [];
        if (!fs.existsSync(this.vipPath)) atomicWriteJson(this.vipPath, this.vipEntries);
    }

    _loadAdminFolders() {
        const list = readJson(this.adminFoldersPath, []);
        this.adminFolders = Array.isArray(list) ? Array.from(new Set(list.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 200) : [];
        if (!fs.existsSync(this.adminFoldersPath)) atomicWriteJson(this.adminFoldersPath, this.adminFolders);
    }

    messageValues() {
        return this.messages.values();
    }

    listAdminFolders() {
        return clone(this.adminFolders);
    }

    async addAdminFolder(name) {
        return this._queueMutation(async () => {
            const folder = String(name || '').trim().replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').slice(0, 60);
            if (!folder) throw new Error('Folder name is required');
            const exists = this.adminFolders.some((item) => item.toLowerCase() === folder.toLowerCase());
            if (!exists) {
                this.adminFolders.push(folder);
                this.adminFolders.sort((a, b) => a.localeCompare(b));
                atomicWriteJson(this.adminFoldersPath, this.adminFolders);
            }
            return { folder, created: !exists, folders: clone(this.adminFolders) };
        });
    }

    _queueMutation(fn) {
        const next = this._mutationQueue.then(fn, fn);
        this._mutationQueue = next.catch(() => {});
        return next;
    }

    readMeta() {
        const value = readJson(this.metaPath, {});
        return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }

    _syncMeta(extra) {
        const current = this.readMeta();
        const now = new Date().toISOString();
        const next = Object.assign({}, current, extra || {}, {
            format: 'social-browser-email-files-v2',
            storage: 'json-files-only',
            messageCount: this.messages.size,
            maxMessages: this.maxMessages,
            maxMessagesManaged: this.maxMessagesManaged === true,
            maxMessagesSource: this.maxMessagesManaged === true ? 'runtime-mcp' : 'startup-config',
            nextId: this.nextId || 1,
            updatedAt: now,
        });
        if (!next.createdAt) next.createdAt = now;
        atomicWriteJson(this.metaPath, next);
    }

    async saveMessage(doc) {
        if (!doc || !doc.guid) throw new Error('Message guid is required');
        return this._queueMutation(async () => {
            const key = String(doc.guid);
            const previous = this.messages.get(key);
            const now = new Date().toISOString();
            const copy = clone(doc);
            copy.guid = key;
            if (!copy.id) copy.id = previous?.id || this.nextId++;
            copy._fileStore = Object.assign({}, previous?._fileStore || {}, copy._fileStore || {}, {
                version: 2,
                createdAt: previous?._fileStore?.createdAt || copy?._fileStore?.createdAt || now,
                updatedAt: now,
            });
            atomicWriteJson(this._messagePath(key), copy);
            this.messages.set(key, copy);
            if (copy.id) this.messagesById.set(String(copy.id), copy);
            const cleanup = await this._cleanupUnlocked();
            this._syncMeta(cleanup.deleted.length ? { lastCleanupAt: now, lastCleanupDeleted: cleanup.deleted.length } : {});
            return { message: clone(copy), cleanup };
        });
    }

    async getMessage(guid) {
        return clone(this.messages.get(String(guid)) || null);
    }

    async getMessageById(id) {
        return clone(this.messagesById.get(String(id)) || null);
    }

    async saveAttachments(guid, attachments) {
        const list = Array.isArray(attachments) ? attachments : [];
        if (!list.length) return [];
        return this._queueMutation(async () => {
            const result = [];
            let index = 0;
            for (const item of list) {
                index += 1;
                if (!item || item.content == null) continue;
                const content = Buffer.isBuffer(item.content) ? item.content : Buffer.from(item.content);
                const id = String(item.id || item.checksum || ('attachment-' + index));
                const filePath = this._attachmentPath(guid, id);
                ensureDir(path.dirname(filePath));
                fs.writeFileSync(filePath, content, { mode: 0o600 });
                result.push({
                    id,
                    filename: String(item.filename || ('attachment-' + index)),
                    contentType: String(item.contentType || 'application/octet-stream'),
                    contentDisposition: String(item.contentDisposition || 'attachment'),
                    contentId: String(item.contentId || item.cid || '').replace(/[<>]/g, ''),
                    size: content.length,
                    checksum: String(item.checksum || hash(content)),
                    related: String(item.contentDisposition || '').toLowerCase() === 'inline' || !!item.related,
                });
            }
            return result;
        });
    }

    async getAttachment(guid, id) {
        const filePath = this._attachmentPath(guid, id);
        if (!fs.existsSync(filePath)) return null;
        return fs.readFileSync(filePath);
    }

    async listMessages() {
        return Array.from(this.messages.values()).map(clone);
    }

    async updateMessage(guid, patch) {
        return this._queueMutation(async () => {
            const key = String(guid);
            const previous = this.messages.get(key);
            if (!previous) return null;
            const now = new Date().toISOString();
            const next = Object.assign({}, previous, clone(patch || {}));
            next.guid = previous.guid;
            next.id = previous.id;
            next._fileStore = Object.assign({}, previous._fileStore || {}, {
                version: 2,
                createdAt: previous?._fileStore?.createdAt || now,
                updatedAt: now,
            });
            atomicWriteJson(this._messagePath(key), next);
            this.messages.set(key, next);
            if (next.id) this.messagesById.set(String(next.id), next);
            this._syncMeta();
            return clone(next);
        });
    }

    async deleteMessage(guid) {
        return this._queueMutation(async () => this._deleteUnlocked(String(guid), true));
    }

    _deleteUnlocked(key, syncMeta) {
        const existing = this.messages.get(key);
        if (!existing) return { deleted: false, guid: key, notFound: true };
        const filePath = this._messagePath(key);
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (error) { throw error; }
        try { fs.rmSync(this._attachmentDir(key), { recursive: true, force: true }); } catch (_) {}
        this.messages.delete(key);
        if (existing.id) this.messagesById.delete(String(existing.id));
        if (syncMeta) this._syncMeta();
        return { deleted: true, guid: key, message: clone(existing) };
    }

    async deleteMessages(guids) {
        return this._queueMutation(async () => {
            const unique = Array.from(new Set((guids || []).map(String)));
            const deleted = [];
            const notFound = [];
            for (const key of unique) {
                const result = this._deleteUnlocked(key, false);
                if (result.deleted) deleted.push(key);
                else notFound.push(key);
            }
            this._syncMeta();
            return { deleted, notFound };
        });
    }

    async cleanupIfNeeded() {
        return this._queueMutation(async () => {
            const result = await this._cleanupUnlocked();
            if (result.deleted.length) this._syncMeta({ lastCleanupAt: new Date().toISOString(), lastCleanupDeleted: result.deleted.length });
            return result;
        });
    }

    getMessageLimit() {
        return {
            maxMessages: this.maxMessages,
            configuredMaxMessages: this.configuredMaxMessages,
            managedByMcp: this.maxMessagesManaged === true,
            source: this.maxMessagesManaged === true ? 'runtime-mcp' : 'startup-config',
            messageCount: this.messages.size,
            overLimit: Math.max(0, this.messages.size - this.maxMessages),
        };
    }

    async setMessageLimit(value, options) {
        options = options || {};
        const next = Math.floor(Number(value));
        if (!Number.isFinite(next) || next < 1 || next > 1000000) throw new Error('maxMessages must be between 1 and 1000000');
        return this._queueMutation(async () => {
            const previous = this.maxMessages;
            this.maxMessages = next;
            this.maxMessagesManaged = options.managed !== false;
            this._syncMeta({
                maxMessagesChangedAt: new Date().toISOString(),
                maxMessagesChangedBy: String(options.source || 'runtime'),
            });
            let cleanup = null;
            if (options.cleanupNow === true && this.messages.size > this.maxMessages) cleanup = await this._cleanupUnlocked();
            if (cleanup?.deleted?.length) this._syncMeta({ lastCleanupAt: new Date().toISOString(), lastCleanupDeleted: cleanup.deleted.length });
            return Object.assign({ previousMaxMessages: previous, cleanup }, this.getMessageLimit());
        });
    }

    async _cleanupUnlocked() {
        const excess = this.messages.size - this.maxMessages;
        if (excess <= 0) return { triggered: false, deleted: [], protectedCount: 0, remaining: this.messages.size, limit: this.maxMessages };

        // At a 100k cap, deleting exactly one oldest message for every new inbound
        // message would require scanning the full store on every delivery. Keep a
        // small reserve instead: ~1% of the cap, capped at 1,000 messages. This
        // preserves the hard maximum while amortizing cleanup work across many
        // subsequent deliveries.
        const reserve = this.maxMessages >= 10000 ? Math.min(1000, Math.max(1, Math.floor(this.maxMessages * 0.01))) : 0;
        const targetCount = Math.max(1, excess + reserve);
        const candidates = [];
        let protectedCount = 0;
        const timeOf = (doc) => {
            const value = new Date(doc?.date || doc?._fileStore?.createdAt || 0).getTime();
            return Number.isNaN(value) ? 0 : value;
        };
        for (const doc of this.messages.values()) {
            if (this.isProtectedMessage(doc)) {
                protectedCount += 1;
                continue;
            }
            candidates.push({ guid: String(doc.guid), time: timeOf(doc) });
        }
        candidates.sort((a, b) => a.time - b.time);
        const deleted = [];
        for (const item of candidates.slice(0, targetCount)) {
            if (this.messages.size <= Math.max(0, this.maxMessages - reserve)) break;
            const result = this._deleteUnlocked(item.guid, false);
            if (result.deleted) deleted.push(item.guid);
        }
        return {
            triggered: true,
            deleted,
            protectedCount,
            remaining: this.messages.size,
            limit: this.maxMessages,
            cleanupReserve: reserve,
        };
    }

    listVip() {
        return clone(this.vipEntries);
    }

    async setVip(entry) {
        if (!entry || !entry.email) throw new Error('VIP email is required');
        return this._queueMutation(async () => {
            const email = String(entry.email).trim().toLowerCase();
            if (!email) throw new Error('VIP email is required');
            const next = Object.assign({}, clone(entry), { email, vip: entry.vip !== false, updatedAt: new Date().toISOString() });
            const index = this.vipEntries.findIndex((item) => String(item.email || '').toLowerCase() === email);
            if (index === -1) this.vipEntries.push(next);
            else this.vipEntries[index] = Object.assign({}, this.vipEntries[index], next);
            atomicWriteJson(this.vipPath, this.vipEntries);
            return clone(next);
        });
    }

    async removeVip(email) {
        return this._queueMutation(async () => {
            const normalized = String(email || '').trim().toLowerCase();
            const before = this.vipEntries.length;
            this.vipEntries = this.vipEntries.filter((item) => String(item.email || '').toLowerCase() !== normalized);
            atomicWriteJson(this.vipPath, this.vipEntries);
            return { removed: before !== this.vipEntries.length, email: normalized };
        });
    }

    async trackMailboxAccess(name, ip) {
        if (!name || !ip) return null;
        return this._queueMutation(async () => {
            const normalized = String(name).trim().toLowerCase();
            const filePath = this._trackingPath(normalized);
            const doc = readJson(filePath, { name: normalized, ipList: [] }) || { name: normalized, ipList: [] };
            doc.name = normalized;
            doc.ipList = Array.isArray(doc.ipList) ? doc.ipList : [];
            const now = new Date().toISOString();
            const index = doc.ipList.findIndex((item) => item.ip === ip);
            if (index === -1) doc.ipList.push({ ip, date: now });
            else doc.ipList[index].date = now;
            doc.updatedAt = now;
            atomicWriteJson(filePath, doc);
            return clone(doc);
        });
    }

    async audit(action, data) {
        return this._queueMutation(async () => {
            const now = new Date();
            const event = {
                id: crypto.randomUUID(),
                action: String(action || 'unknown'),
                date: now.toISOString(),
                data: clone(data || {}),
            };
            const dayDir = path.join(this.auditDir, now.toISOString().slice(0, 10));
            ensureDir(dayDir);
            atomicWriteJson(path.join(dayDir, event.id + '.json'), event);
            return event;
        });
    }
}

module.exports = {
    EmailFileStore,
    atomicWriteJson,
    readJson,
    hash,
};
