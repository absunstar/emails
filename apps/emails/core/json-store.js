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

function atomicWriteCompactJson(filePath, value) {
    ensureDir(path.dirname(filePath));
    const tmpPath = filePath + '.' + process.pid + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(value) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
        fs.renameSync(tmpPath, filePath);
    } catch (error) {
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

function recipientAddresses(values) {
    const source = Array.isArray(values) ? values : [values];
    const result = new Set();
    for (const value of source) {
        const matches = String(value || '').match(/[A-Z0-9._%+-]+@(?:[A-Z0-9.-]+\.[A-Z]{2,}|localhost)/gi) || [];
        for (const email of matches) result.add(String(email).toLowerCase());
    }
    return Array.from(result);
}

function idLike(leftValue, rightValue) {
    const left = String(leftValue ?? '').trim();
    const right = String(rightValue ?? '').trim();
    if (!left || !right) return false;
    try {
        if (typeof left.like === 'function' && left.like(right)) return true;
        if (typeof right.like === 'function' && right.like(left)) return true;
    } catch (_) {}
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber) && leftNumber === rightNumber) return true;
    return left.toLowerCase() === right.toLowerCase();
}

function messageMetadata(doc) {
    if (!doc || !doc.guid) return null;
    const attachments = Array.isArray(doc.attachments) ? doc.attachments.map((item) => ({
        id: item?.id,
        filename: item?.filename || '',
        contentType: item?.contentType || 'application/octet-stream',
        contentDisposition: item?.contentDisposition || 'attachment',
        contentId: item?.contentId || '',
        size: Number(item?.size || 0),
        checksum: item?.checksum || '',
        related: !!item?.related,
    })) : [];
    return {
        id: doc.id,
        guid: String(doc.guid),
        messageId: doc.messageId || '',
        from: doc.from || '',
        to: doc.to || '',
        cc: doc.cc || '',
        subject: doc.subject || '',
        date: doc.date || null,
        folder: doc.folder || '',
        status: doc.status || '',
        read: !!doc.read,
        favorite: !!doc.favorite,
        replyTo: doc.replyTo || '',
        inReplyTo: doc.inReplyTo || '',
        attachments,
        _fileStore: doc._fileStore ? {
            version: doc._fileStore.version,
            createdAt: doc._fileStore.createdAt,
            updatedAt: doc._fileStore.updatedAt,
        } : undefined,
    };
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
        this.messageIndexPath = path.join(this.baseDir, 'message-index.json');
        this.messageIndexJournalDir = path.join(this.baseDir, 'message-index-journal');
        this.messageIndexDirtyPath = path.join(this.baseDir, 'message-index.dirty.json');
        this.messageIndexVersion = 1;
        this.messageIndexSequence = 0;
        this.messageIndexSnapshotSequence = 0;
        this.messageIndexJournalEntries = 0;
        this.messageIndexLoadMode = 'unknown';
        this.messageIndexLastError = '';
        this.adminFoldersPath = path.join(this.baseDir, 'admin-folders.json');
        this.vipPath = path.resolve(options.vipPath || path.join(process.cwd(), 'localStorage', 'vip-email-list.json'));
        this.mailboxTiersPath = path.resolve(options.mailboxTiersPath || path.join(process.cwd(), 'localStorage', 'mailbox-tier-list.json'));
        this.configuredMaxMessages = Math.max(1, Number(options.maxMessages || 100000));
        this.maxMessages = this.configuredMaxMessages;
        this.maxMessagesManaged = false;
        this.logger = typeof options.logger === 'function' ? options.logger : () => {};
        this.isProtectedMessage = typeof options.isProtectedMessage === 'function' ? options.isProtectedMessage : () => false;
        this.messages = new Map();
        // id -> Map<guid, doc>. Legacy installations can contain duplicate numeric
        // ids after migrations/imports or multi-domain consolidation, so a single
        // id must be allowed to resolve to more than one stored message.
        this.messagesById = new Map();
        // recipient -> Map<guid, metadata>. This keeps mailbox reads bounded to
        // the selected inbox instead of scanning every stored message.
        this.messagesByRecipient = new Map();
        this.vipEntries = [];
        this.mailboxTierEntries = [];
        this.adminFolders = [];
        this._mutationQueue = Promise.resolve();

        ensureDir(this.messagesDir);
        ensureDir(this.attachmentsDir);
        ensureDir(this.trackingDir);
        ensureDir(this.auditDir);
        ensureDir(this.messageIndexJournalDir);
        ensureDir(path.dirname(this.vipPath));
        ensureDir(path.dirname(this.mailboxTiersPath));
        const persistedMeta = readJson(this.metaPath, {});
        const persistedLimit = Number(persistedMeta?.maxMessages);
        if (persistedMeta?.maxMessagesManaged === true && Number.isFinite(persistedLimit) && persistedLimit >= 1) {
            this.maxMessages = Math.floor(persistedLimit);
            this.maxMessagesManaged = true;
        }
        this._loadMessages(persistedMeta);
        this._loadVip();
        this._loadMailboxTiers();
        this._loadAdminFolders();
        this._syncMeta();
        // A dirty marker is only removed after the metadata/index state has been
        // durably synchronized. If the process dies earlier, the next startup
        // intentionally falls back to a full scan.
        this._clearMessageIndexDirty();
    }


    _indexMessageById(doc) {
        if (!doc || doc.id === undefined || doc.id === null || doc.id === '') return;
        const id = String(doc.id);
        const guid = String(doc.guid || '');
        if (!guid) return;
        let bucket = this.messagesById.get(id);
        if (!(bucket instanceof Map)) {
            bucket = new Map();
            this.messagesById.set(id, bucket);
        }
        bucket.set(guid, doc);
    }

    _unindexMessageById(doc) {
        if (!doc || doc.id === undefined || doc.id === null || doc.id === '') return;
        const id = String(doc.id);
        const guid = String(doc.guid || '');
        const bucket = this.messagesById.get(id);
        if (!(bucket instanceof Map)) {
            this.messagesById.delete(id);
            return;
        }
        if (guid) bucket.delete(guid);
        if (!bucket.size) this.messagesById.delete(id);
    }

    _indexMessageRecipients(doc) {
        if (!doc || !doc.guid) return;
        const guid = String(doc.guid);
        for (const email of recipientAddresses([doc.to, doc.cc])) {
            let bucket = this.messagesByRecipient.get(email);
            if (!(bucket instanceof Map)) {
                bucket = new Map();
                this.messagesByRecipient.set(email, bucket);
            }
            bucket.set(guid, doc);
        }
    }

    _unindexMessageRecipients(doc) {
        if (!doc || !doc.guid) return;
        const guid = String(doc.guid);
        for (const email of recipientAddresses([doc.to, doc.cc])) {
            const bucket = this.messagesByRecipient.get(email);
            if (!(bucket instanceof Map)) continue;
            bucket.delete(guid);
            if (!bucket.size) this.messagesByRecipient.delete(email);
        }
    }

    _applyIndexedMetadata(doc) {
        const metaDoc = messageMetadata(doc);
        if (!metaDoc) return null;
        const key = String(metaDoc.guid);
        const previous = this.messages.get(key);
        if (previous) {
            this._unindexMessageById(previous);
            this._unindexMessageRecipients(previous);
        }
        this.messages.set(key, metaDoc);
        this._indexMessageById(metaDoc);
        this._indexMessageRecipients(metaDoc);
        return metaDoc;
    }

    _removeIndexedMetadata(guid) {
        const key = String(guid || '');
        const existing = this.messages.get(key);
        if (!existing) return null;
        this.messages.delete(key);
        this._unindexMessageById(existing);
        this._unindexMessageRecipients(existing);
        return existing;
    }

    _beginMessageIndexMutation(reason) {
        atomicWriteJson(this.messageIndexDirtyPath, {
            format: 'social-browser-email-message-index-dirty-v1',
            version: this.messageIndexVersion,
            startedAt: new Date().toISOString(),
            reason: String(reason || 'message-mutation').slice(0, 160),
            pid: process.pid,
            baseSequence: this.messageIndexSequence,
        });
    }

    _clearMessageIndexDirty() {
        try { if (fs.existsSync(this.messageIndexDirtyPath)) fs.unlinkSync(this.messageIndexDirtyPath); } catch (_) {}
    }

    _appendMessageIndexOperation(operation) {
        const record = Object.assign({}, operation || {});
        record.version = this.messageIndexVersion;
        record.sequence = ++this.messageIndexSequence;
        record.date = new Date().toISOString();
        const journalPath = path.join(this.messageIndexJournalDir, String(record.sequence).padStart(16, '0') + '.json');
        atomicWriteCompactJson(journalPath, record);
        this.messageIndexJournalEntries += 1;
        return record.sequence;
    }

    _writeMessageIndexSnapshot() {
        const snapshot = {
            format: 'social-browser-email-message-index-v1',
            version: this.messageIndexVersion,
            generatedAt: new Date().toISOString(),
            sequence: this.messageIndexSequence,
            messageCount: this.messages.size,
            nextId: this.nextId || 1,
            messages: Array.from(this.messages.values()),
        };
        atomicWriteCompactJson(this.messageIndexPath, snapshot);
        // A snapshot with sequence N supersedes all journal records <= N.
        try { fs.rmSync(this.messageIndexJournalDir, { recursive: true, force: true }); } catch (_) {}
        ensureDir(this.messageIndexJournalDir);
        this.messageIndexSnapshotSequence = this.messageIndexSequence;
        this.messageIndexJournalEntries = 0;
        return snapshot;
    }

    _maybeCompactMessageIndex() {
        if (this.messageIndexJournalEntries >= 5000) this._writeMessageIndexSnapshot();
    }

    _readMessageIndexSnapshot() {
        const raw = fs.readFileSync(this.messageIndexPath, 'utf8');
        const snapshot = JSON.parse(raw);
        if (!snapshot || snapshot.format !== 'social-browser-email-message-index-v1' || Number(snapshot.version) !== this.messageIndexVersion) {
            throw new Error('Unsupported message index snapshot format');
        }
        if (!Array.isArray(snapshot.messages)) throw new Error('Message index snapshot has no messages array');
        if (Number(snapshot.messageCount) !== snapshot.messages.length) throw new Error('Message index snapshot count mismatch');
        return snapshot;
    }

    _tryLoadMessageIndex(persistedMeta) {
        if (fs.existsSync(this.messageIndexDirtyPath)) {
            this.messageIndexLastError = 'dirty-marker';
            return false;
        }
        if (!fs.existsSync(this.messageIndexPath)) {
            this.messageIndexLastError = 'snapshot-missing';
            return false;
        }

        try {
            const snapshot = this._readMessageIndexSnapshot();
            this.messages.clear();
            this.messagesById.clear();
            this.messagesByRecipient.clear();
            let maxId = 0;
            for (const doc of snapshot.messages) {
                const metaDoc = this._applyIndexedMetadata(doc);
                const id = Number(metaDoc?.id || 0);
                if (Number.isFinite(id) && id > maxId) maxId = id;
            }

            this.messageIndexSnapshotSequence = Math.max(0, Number(snapshot.sequence || 0));
            this.messageIndexSequence = this.messageIndexSnapshotSequence;
            this.messageIndexJournalEntries = 0;

            if (fs.existsSync(this.messageIndexJournalDir)) {
                const files = fs.readdirSync(this.messageIndexJournalDir)
                    .filter((name) => name.endsWith('.json'))
                    .sort();
                let expected = this.messageIndexSequence + 1;
                for (const name of files) {
                    const item = JSON.parse(fs.readFileSync(path.join(this.messageIndexJournalDir, name), 'utf8'));
                    const sequence = Number(item.sequence || 0);
                    if (sequence <= this.messageIndexSnapshotSequence) continue;
                    if (sequence !== expected) throw new Error('Message index journal sequence gap at ' + expected + ', got ' + sequence);
                    expected += 1;
                    if (item.op === 'upsert' && item.meta?.guid) {
                        const metaDoc = this._applyIndexedMetadata(item.meta);
                        const id = Number(metaDoc?.id || 0);
                        if (Number.isFinite(id) && id > maxId) maxId = id;
                    } else if (item.op === 'delete' && item.guid) {
                        this._removeIndexedMetadata(item.guid);
                    } else {
                        throw new Error('Invalid message index journal operation');
                    }
                    this.messageIndexSequence = sequence;
                    this.messageIndexJournalEntries += 1;
                }
            }

            const expectedSequence = Number(persistedMeta?.messageIndexSequence);
            if (Number.isFinite(expectedSequence) && expectedSequence >= 0 && expectedSequence !== this.messageIndexSequence) {
                throw new Error('Message index sequence mismatch');
            }
            const expectedCount = Number(persistedMeta?.messageCount);
            if (Number.isFinite(expectedCount) && expectedCount >= 0 && expectedCount !== this.messages.size) {
                throw new Error('Message index message count mismatch');
            }

            this.nextId = Math.max(maxId + 1, Number(snapshot.nextId || 1), Number(persistedMeta?.nextId || 1));
            this.messageIndexLoadMode = 'persistent-index';
            this.messageIndexLastError = '';
            return true;
        } catch (error) {
            this.messageIndexLastError = String(error?.message || error);
            this.logger('Persistent message index ignored: ' + this.messageIndexLastError);
            return false;
        }
    }

    invalidatePersistentIndex(reason) {
        try { if (fs.existsSync(this.messageIndexPath)) fs.unlinkSync(this.messageIndexPath); } catch (_) {}
        try { fs.rmSync(this.messageIndexJournalDir, { recursive: true, force: true }); } catch (_) {}
        ensureDir(this.messageIndexJournalDir);
        this._beginMessageIndexMutation(reason || 'manual-invalidation');
        this.messageIndexLoadMode = 'invalidated';
        return { invalidated: true, reason: String(reason || 'manual-invalidation') };
    }

    messageIndexStatus() {
        let snapshotBytes = 0;
        let journalBytes = 0;
        try { snapshotBytes = fs.statSync(this.messageIndexPath).size; } catch (_) {}
        try {
            for (const name of fs.readdirSync(this.messageIndexJournalDir)) {
                if (!name.endsWith('.json')) continue;
                journalBytes += fs.statSync(path.join(this.messageIndexJournalDir, name)).size;
            }
        } catch (_) {}
        return {
            version: this.messageIndexVersion,
            loadMode: this.messageIndexLoadMode,
            sequence: this.messageIndexSequence,
            snapshotSequence: this.messageIndexSnapshotSequence,
            journalEntries: this.messageIndexJournalEntries,
            snapshotBytes,
            journalBytes,
            dirty: fs.existsSync(this.messageIndexDirtyPath),
            lastError: this.messageIndexLastError || '',
            messageCount: this.messages.size,
        };
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

    _loadMessages(persistedMeta) {
        persistedMeta = persistedMeta || this.readMeta();
        if (this._tryLoadMessageIndex(persistedMeta)) return;

        this.messages.clear();
        this.messagesById.clear();
        this.messagesByRecipient.clear();
        let maxId = 0;
        const files = walkJsonFiles(this.messagesDir, []);
        for (const filePath of files) {
            try {
                const doc = JSON.parse(fs.readFileSync(filePath, 'utf8'));
                if (!doc || !doc.guid) continue;
                const metaDoc = this._applyIndexedMetadata(doc);
                const id = Number(metaDoc?.id || 0);
                if (Number.isFinite(id) && id > maxId) maxId = id;
            } catch (error) {
                this.logger('Skipped invalid email JSON ' + filePath + ': ' + (error.message || error));
            }
        }
        this.messageIndexSequence = Math.max(0, Number(persistedMeta?.messageIndexSequence || 0));
        this.nextId = Math.max(maxId + 1, Number(persistedMeta?.nextId || 1));
        this.messageIndexLoadMode = 'full-scan';
        this._writeMessageIndexSnapshot();
    }

    _loadVip() {
        const list = readJson(this.vipPath, []);
        this.vipEntries = Array.isArray(list) ? list.filter((item) => item && item.email) : [];
        if (!fs.existsSync(this.vipPath)) atomicWriteJson(this.vipPath, this.vipEntries);
    }

    _loadMailboxTiers() {
        const list = readJson(this.mailboxTiersPath, []);
        this.mailboxTierEntries = Array.isArray(list) ? list.filter((item) => item && item.email) : [];
        if (!fs.existsSync(this.mailboxTiersPath)) atomicWriteJson(this.mailboxTiersPath, this.mailboxTierEntries);
    }

    _loadAdminFolders() {
        const list = readJson(this.adminFoldersPath, []);
        this.adminFolders = Array.isArray(list) ? Array.from(new Set(list.map((item) => String(item || '').trim()).filter(Boolean))).slice(0, 200) : [];
        if (!fs.existsSync(this.adminFoldersPath)) atomicWriteJson(this.adminFoldersPath, this.adminFolders);
    }

    messageValues() {
        return this.messages.values();
    }

    messageValuesForRecipient(value) {
        const email = recipientAddresses(value)[0] || '';
        const bucket = email ? this.messagesByRecipient.get(email) : null;
        return bucket instanceof Map ? bucket.values() : [][Symbol.iterator]();
    }

    recipientIndexStats() {
        let references = 0;
        for (const bucket of this.messagesByRecipient.values()) references += bucket.size;
        return { recipients: this.messagesByRecipient.size, references };
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
            messageIndexVersion: this.messageIndexVersion,
            messageIndexSequence: this.messageIndexSequence,
            messageIndexSnapshotSequence: this.messageIndexSnapshotSequence,
            messageIndexJournalEntries: this.messageIndexJournalEntries,
            messageIndexLoadMode: this.messageIndexLoadMode,
            updatedAt: now,
        });
        if (!next.createdAt) next.createdAt = now;
        atomicWriteJson(this.metaPath, next);
    }

    async saveMessage(doc) {
        if (!doc || !doc.guid) throw new Error('Message guid is required');
        return this._queueMutation(async () => {
            this._beginMessageIndexMutation('save-message');
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
            const metaDoc = this._applyIndexedMetadata(copy);
            this._appendMessageIndexOperation({ op: 'upsert', guid: key, meta: metaDoc });
            const cleanup = await this._cleanupUnlocked();
            this._maybeCompactMessageIndex();
            this._syncMeta(cleanup.deleted.length ? { lastCleanupAt: now, lastCleanupDeleted: cleanup.deleted.length } : {});
            this._clearMessageIndexDirty();
            return { message: clone(copy), cleanup };
        });
    }

    async getMessage(guid) {
        const key = String(guid);
        if (!this.messages.has(key)) return null;
        const doc = readJson(this._messagePath(key), null);
        return doc && doc.guid ? doc : null;
    }

    async getMessagesById(id) {
        const requested = String(id ?? '').trim();
        const exactBucket = this.messagesById.get(requested);
        if (exactBucket instanceof Map) {
            const docs = [];
            for (const meta of exactBucket.values()) {
                const doc = await this.getMessage(meta.guid);
                if (doc) docs.push(doc);
            }
            return docs;
        }
        if (exactBucket) {
            const doc = await this.getMessage(exactBucket.guid);
            return doc ? [doc] : [];
        }

        // Legacy compatibility: ids may have crossed API/storage boundaries as
        // Number/String or with harmless numeric formatting. Resolve buckets using
        // like-compatible comparison instead of requiring an exact Map key.
        const matches = [];
        for (const [storedId, bucket] of this.messagesById.entries()) {
            if (!idLike(storedId, requested)) continue;
            if (bucket instanceof Map) {
                for (const meta of bucket.values()) { const doc = await this.getMessage(meta.guid); if (doc) matches.push(doc); }
            } else if (bucket) {
                { const doc = await this.getMessage(bucket.guid); if (doc) matches.push(doc); }
            }
        }
        return matches;
    }

    async getMessageById(id) {
        const list = await this.getMessagesById(id);
        return list.length ? list[0] : null;
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
            this._beginMessageIndexMutation('update-message');
            const key = String(guid);
            const previousMeta = this.messages.get(key);
            if (!previousMeta) {
                this._clearMessageIndexDirty();
                return null;
            }
            const previous = readJson(this._messagePath(key), null);
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
            const nextMeta = this._applyIndexedMetadata(next);
            this._appendMessageIndexOperation({ op: 'upsert', guid: key, meta: nextMeta });
            this._maybeCompactMessageIndex();
            this._syncMeta();
            this._clearMessageIndexDirty();
            return clone(next);
        });
    }

    async deleteMessage(guid) {
        return this._queueMutation(async () => {
            this._beginMessageIndexMutation('delete-message');
            const result = this._deleteUnlocked(String(guid), true);
            this._maybeCompactMessageIndex();
            this._clearMessageIndexDirty();
            return result;
        });
    }

    _deleteUnlocked(key, syncMeta, updatePersistentIndex = true) {
        const existing = this.messages.get(key);
        if (!existing) return { deleted: false, guid: key, notFound: true };
        const filePath = this._messagePath(key);
        try { if (fs.existsSync(filePath)) fs.unlinkSync(filePath); } catch (error) { throw error; }
        try { fs.rmSync(this._attachmentDir(key), { recursive: true, force: true }); } catch (_) {}
        this._removeIndexedMetadata(key);
        if (updatePersistentIndex) this._appendMessageIndexOperation({ op: 'delete', guid: key });
        if (syncMeta) this._syncMeta();
        return { deleted: true, guid: key, message: clone(existing) };
    }

    async deleteMessages(guids) {
        return this._queueMutation(async () => {
            this._beginMessageIndexMutation('delete-messages');
            const unique = Array.from(new Set((guids || []).map(String)));
            const deleted = [];
            const notFound = [];
            for (const key of unique) {
                const result = this._deleteUnlocked(key, false);
                if (result.deleted) deleted.push(key);
                else notFound.push(key);
            }
            this._maybeCompactMessageIndex();
            this._syncMeta();
            this._clearMessageIndexDirty();
            return { deleted, notFound };
        });
    }

    async cleanupIfNeeded() {
        return this._queueMutation(async () => {
            this._beginMessageIndexMutation('cleanup-messages');
            const result = await this._cleanupUnlocked();
            if (result.deleted.length) {
                this._maybeCompactMessageIndex();
                this._syncMeta({ lastCleanupAt: new Date().toISOString(), lastCleanupDeleted: result.deleted.length });
            }
            this._clearMessageIndexDirty();
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
            if (options.cleanupNow === true) this._beginMessageIndexMutation('message-limit-cleanup');
            const previous = this.maxMessages;
            this.maxMessages = next;
            this.maxMessagesManaged = options.managed !== false;
            this._syncMeta({
                maxMessagesChangedAt: new Date().toISOString(),
                maxMessagesChangedBy: String(options.source || 'runtime'),
            });
            let cleanup = null;
            if (options.cleanupNow === true && this.messages.size > this.maxMessages) cleanup = await this._cleanupUnlocked();
            if (cleanup?.deleted?.length) {
                this._maybeCompactMessageIndex();
                this._syncMeta({ lastCleanupAt: new Date().toISOString(), lastCleanupDeleted: cleanup.deleted.length });
            }
            if (options.cleanupNow === true) this._clearMessageIndexDirty();
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

    listMailboxTiers() {
        return clone(this.mailboxTierEntries);
    }

    getMailboxTier(email) {
        const normalized = String(email || '').trim().toLowerCase();
        if (!normalized) return 'normal';
        const found = this.mailboxTierEntries.find((item) => String(item.email || '').toLowerCase() === normalized);
        return found && ['pro', 'vip'].includes(String(found.tier || '').toLowerCase()) ? String(found.tier).toLowerCase() : 'normal';
    }

    async setMailboxTier(email, tier, source) {
        return this._queueMutation(async () => {
            const normalized = String(email || '').trim().toLowerCase();
            const normalizedTier = String(tier || 'normal').trim().toLowerCase();
            if (!normalized) throw new Error('Mailbox email is required');
            if (!['normal', 'pro', 'vip'].includes(normalizedTier)) throw new Error('Invalid mailbox tier');
            this.mailboxTierEntries = this.mailboxTierEntries.filter((item) => String(item.email || '').toLowerCase() !== normalized);
            if (normalizedTier !== 'normal') {
                this.mailboxTierEntries.push({ email: normalized, tier: normalizedTier, source: source || 'admin-dashboard', updatedAt: new Date().toISOString() });
            }
            atomicWriteJson(this.mailboxTiersPath, this.mailboxTierEntries);
            return { email: normalized, tier: normalizedTier };
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
    messageMetadata,
};
