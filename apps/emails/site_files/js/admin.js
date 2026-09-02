(function () {
    'use strict';

    const root = document.querySelector('[data-email-admin-app]');
    if (!root) return;
    const ui = window.SBUI;
    const state = {
        items: [],
        count: 0,
        offset: 0,
        limit: 50,
        selected: new Set(),
        stats: { total: 0, unread: 0, favorite: 0, attachments: 0, failed: 0, folders: {}, maxMessages: 10000 },
        folders: [],
        customFolders: [],
        current: null,
        remoteImages: false,
        vipEmails: new Set(),
        loading: false,
        filterTimer: null,
        sortBy: 'date',
        sortDir: 'desc',
        autoRefresh: false,
        autoTimer: null,
        autoTick: 0,
        columns: { from: true, to: true, subject: true, folder: true, date: true },
        policy: null,
        policyDefaults: null,
        policyStatus: null,
        policyTab: 'rules',
    };

    const q = (selector, base) => (base || document).querySelector(selector);
    const qa = (selector, base) => Array.from((base || document).querySelectorAll(selector));
    const escape = (value) => ui ? ui.escape(value) : String(value == null ? '' : value);
    const toast = (message, type, title, options) => ui && ui.toast ? ui.toast(message, { type: type || 'info', title: title || '', duration: options?.duration }) : null;

    function readLocal(key, fallback) {
        try {
            const value = localStorage.getItem(key);
            return value == null ? fallback : JSON.parse(value);
        } catch (_) {
            return fallback;
        }
    }

    function writeLocal(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) {}
    }

    function svg(name) {
        const icons = {
            view: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"></path><circle cx="12" cy="12" r="2.5"></circle></svg>',
            star: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z"></path></svg>',
            paperclip: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="m8 12 5.5-5.5a3 3 0 1 1 4.2 4.2L10 18.4a5 5 0 1 1-7.1-7.1l8.2-8.2"></path></svg>',
            trash: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"></path></svg>',
            check: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"></path></svg>',
            spinner: '<svg class="ui-icon" viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66"></path><path d="M20 4v6h-6"></path></svg>',
        };
        return icons[name] || '';
    }

    function setBusy(button, busy, label) {
        if (!button) return;
        if (busy) {
            if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
            button.disabled = true;
            button.classList.add('is-busy');
            if (label) button.innerHTML = svg('spinner') + '<span>' + escape(label) + '</span>';
        } else {
            button.disabled = false;
            button.classList.remove('is-busy');
            if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
            delete button.dataset.originalHtml;
        }
    }

    async function post(url, data) {
        const response = await ui.post(url, data || {});
        if (!response || response.done === false) throw new Error(response?.error || 'Request failed');
        return response;
    }

    function dateTime(value) {
        if (!value) return '—';
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return String(value);
        return date.toLocaleString();
    }

    function relativeTime(value) {
        if (!value) return '';
        const time = new Date(value).getTime();
        if (!time) return '';
        const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
        if (seconds < 30) return 'just now';
        if (seconds < 60) return seconds + 's ago';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + 'm ago';
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return hours + 'h ago';
        const days = Math.floor(hours / 24);
        return days + 'd ago';
    }

    function formatBytes(value) {
        const bytes = Math.max(0, Number(value || 0));
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function firstEmail(value) {
        const match = String(value || '').match(/[A-Z0-9._%+-]+@(?:[A-Z0-9.-]+\.[A-Z]{2,}|localhost)/i);
        return match ? match[0].toLowerCase() : '';
    }

    function isVipEmail(value) {
        const emails = String(value || '').match(/[A-Z0-9._%+-]+@(?:[A-Z0-9.-]+\.[A-Z]{2,}|localhost)/gi) || [];
        return emails.some((email) => state.vipEmails.has(email.toLowerCase()));
    }

    function activeFilterCount() {
        const data = readFilters();
        let count = 0;
        if (data.query) count += 1;
        if (data.from) count += 1;
        if (data.to) count += 1;
        if (data.subject) count += 1;
        if (data.folder && data.folder !== 'all') count += 1;
        if (data.read && data.read !== 'all') count += 1;
        if (data.status && data.status !== 'all') count += 1;
        if (data.after) count += 1;
        if (data.before) count += 1;
        if (data.favorite) count += 1;
        if (data.hasAttachments) count += 1;
        return count;
    }

    function updateFilterBadge() {
        const badge = q('[data-admin-filter-count]');
        if (!badge) return;
        const count = activeFilterCount();
        badge.textContent = count;
        badge.hidden = count === 0;
        const reset = q('[data-admin-reset-filters]');
        if (reset) reset.hidden = count === 0;
    }

    function readFilters() {
        const value = (name) => q('[data-admin-filter="' + name + '"]')?.value || '';
        return {
            query: value('query').trim(),
            from: value('from').trim(),
            to: value('to').trim(),
            subject: value('subject').trim(),
            folder: value('folder') || 'all',
            read: value('read') || 'all',
            status: value('status') || 'all',
            after: value('after'),
            before: value('before'),
            favorite: !!q('[data-admin-filter="favorite"]')?.checked,
            hasAttachments: !!q('[data-admin-filter="hasAttachments"]')?.checked,
        };
    }

    function clearFilters() {
        qa('[data-admin-filter]').forEach((input) => {
            if (input.type === 'checkbox') input.checked = false;
            else if (input.tagName === 'SELECT') input.value = 'all';
            else input.value = '';
        });
        state.offset = 0;
        updateFilterBadge();
        renderFolders();
        return loadMessages();
    }

    function renderStats() {
        const stats = state.stats || {};
        ['total', 'unread', 'favorite', 'attachments', 'failed'].forEach((key) => {
            const value = Math.max(0, Number(stats[key] || 0));
            qa('[data-admin-stat="' + key + '"]').forEach((el) => { el.textContent = value.toLocaleString(); });
            qa('[data-admin-side-count="' + key + '"]').forEach((el) => { el.textContent = value.toLocaleString(); });
        });
        const max = Math.max(1, Number(stats.maxMessages || 10000));
        const stored = Math.max(0, Number(stats.storedTotal || stats.total || 0));
        const storageText = q('[data-admin-storage-text]');
        const storageBar = q('[data-admin-storage-bar]');
        if (storageText) storageText.textContent = stored.toLocaleString() + ' / ' + max.toLocaleString();
        if (storageBar) storageBar.style.width = Math.min(100, stored / max * 100) + '%';
    }

    function folderEntries() {
        const counts = new Map();
        const system = ['inbox', 'send', 'sending', 'failed'];
        system.forEach((name) => counts.set(name, 0));
        (state.customFolders || []).forEach((name) => {
            const value = String(name || '').trim();
            if (value && !counts.has(value)) counts.set(value, 0);
        });
        Object.entries(state.stats.folders || {}).forEach(([name, count]) => counts.set(name, Number(count || 0)));
        const entries = Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
        entries.sort((a, b) => {
            const ai = system.indexOf(a.name);
            const bi = system.indexOf(b.name);
            if (ai >= 0 || bi >= 0) return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
            return a.name.localeCompare(b.name);
        });
        return entries;
    }

    function renderFolders() {
        const host = q('[data-admin-folders]');
        if (!host) return;
        const selected = q('[data-admin-filter="folder"]')?.value || 'all';
        const entries = folderEntries();
        state.folders = entries.map((item) => item.name);
        const labels = { inbox: 'Inbox', send: 'Sent', sending: 'Sending', failed: 'Failed' };
        const icons = { inbox: '↓', send: '↑', sending: '↻', failed: '!' };
        host.innerHTML = '<button type="button" class="mail-admin-folder' + (selected === 'all' ? ' is-active' : '') + '" data-admin-folder="all"><span class="mail-admin-folder-icon">▣</span><span>All mail</span><strong>' + Number(state.stats.total || 0).toLocaleString() + '</strong></button>' + entries.map((item) => '<button type="button" class="mail-admin-folder' + (selected === item.name ? ' is-active' : '') + '" data-admin-folder="' + escape(item.name) + '"><span class="mail-admin-folder-icon">' + escape(icons[item.name] || '□') + '</span><span>' + escape(labels[item.name] || item.name) + '</span><strong>' + item.count.toLocaleString() + '</strong></button>').join('');
        const select = q('[data-admin-filter="folder"]');
        if (select) {
            const current = select.value || 'all';
            select.innerHTML = '<option value="all">All folders</option>' + entries.map((item) => '<option value="' + escape(item.name) + '">' + escape(item.name) + ' (' + item.count + ')</option>').join('');
            if (Array.from(select.options).some((option) => option.value === current)) select.value = current;
        }
    }

    async function loadAdminSummary() {
        const response = await post('/api/emails/admin/summary', {});
        state.stats = response.stats || state.stats;
        state.customFolders = Array.isArray(response.folders) ? response.folders : state.customFolders;
        state.vipEmails = new Set((response.vip || []).map((item) => String(item.email || '').toLowerCase()).filter(Boolean));
        renderStats();
        renderFolders();
        return response;
    }

    function applyColumnVisibility() {
        Object.keys(state.columns).forEach((name) => {
            const visible = state.columns[name] !== false;
            qa('[data-admin-col="' + name + '"]').forEach((el) => { el.hidden = !visible; });
            const toggle = q('[data-admin-column-toggle="' + name + '"]');
            if (toggle) toggle.checked = visible;
        });
    }

    function updateSortIndicators() {
        qa('[data-admin-sort]').forEach((button) => {
            const active = button.dataset.adminSort === state.sortBy;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-sort', active ? (state.sortDir === 'asc' ? 'ascending' : 'descending') : 'none');
        });
        qa('[data-admin-sort-indicator]').forEach((indicator) => {
            indicator.textContent = indicator.dataset.adminSortIndicator === state.sortBy ? (state.sortDir === 'asc' ? '↑' : '↓') : '';
        });
    }

    function updateAutoRefreshUI() {
        const button = q('[data-admin-action="toggle-auto-refresh"]');
        const label = q('[data-admin-auto-refresh-label]');
        const status = q('[data-admin-auto-status]');
        if (button) button.setAttribute('aria-pressed', state.autoRefresh ? 'true' : 'false');
        if (button) button.classList.toggle('is-active', state.autoRefresh);
        if (label) label.textContent = state.autoRefresh ? 'Auto refresh: 15s' : 'Auto refresh: Off';
        if (status) status.textContent = state.autoRefresh ? 'Live list updates enabled' : 'Manual refresh';
    }

    function setAutoRefresh(enabled, notify) {
        state.autoRefresh = !!enabled;
        writeLocal('socialTempMail.admin.autoRefresh', state.autoRefresh);
        if (state.autoTimer) clearInterval(state.autoTimer);
        state.autoTimer = null;
        state.autoTick = 0;
        if (state.autoRefresh) {
            state.autoTimer = setInterval(async () => {
                if (document.hidden || state.loading) return;
                state.autoTick += 1;
                await loadMessages({ silent: true });
                if (state.autoTick % 4 === 0) await loadAdminSummary();
            }, 15000);
        }
        updateAutoRefreshUI();
        if (notify) toast(state.autoRefresh ? 'The message list will refresh every 15 seconds.' : 'Automatic refresh is off.', 'info', state.autoRefresh ? 'Auto refresh enabled' : 'Auto refresh disabled', { duration: 2200 });
    }

    async function createFolder(button) {
        const input = q('[data-admin-new-folder-name]');
        const name = String(input?.value || '').trim();
        if (!name) return toast('Enter a folder name.', 'warning', 'Folder required');
        setBusy(button, true, 'Creating…');
        try {
            const response = await post('/api/emails/admin/folder/create', { name });
            state.customFolders = Array.isArray(response.folders) ? response.folders : state.customFolders;
            if (input) input.value = '';
            const panel = q('[data-admin-new-folder]');
            if (panel) panel.hidden = true;
            renderFolders();
            toast('Folder “' + name + '” is ready.', 'success', 'Folder created');
        } catch (error) {
            toast(error.message || 'Unable to create the folder.', 'error', 'Folder creation failed');
        } finally {
            setBusy(button, false);
        }
    }

    function rowStatus(doc) {
        if (doc.status === 'failed') return '<span class="mail-admin-badge danger">Failed</span>';
        if (doc.folder === 'send' || doc.status === 'sent') return '<span class="mail-admin-badge info">Sent</span>';
        if (!doc.read) return '<span class="mail-admin-badge unread">Unread</span>';
        return '<span class="mail-admin-badge">Read</span>';
    }

    function renderRows() {
        const host = q('[data-admin-list]');
        const empty = q('[data-admin-empty]');
        if (!host) return;
        const wrap = q('.mail-admin-table-wrap');
        if (!state.items.length) {
            host.innerHTML = '';
            if (empty) empty.hidden = false;
            if (wrap) wrap.classList.add('is-empty');
        } else {
            if (empty) empty.hidden = true;
            if (wrap) wrap.classList.remove('is-empty');
            host.innerHTML = state.items.map((doc) => {
                const selected = state.selected.has(String(doc.guid));
                const attachments = Array.isArray(doc.attachments) ? doc.attachments.length : 0;
                const vip = isVipEmail(doc.to) || isVipEmail(doc.cc);
                return '<tr class="' + (!doc.read ? 'is-unread ' : '') + (selected ? 'is-selected' : '') + '" data-admin-row="' + escape(doc.guid) + '">' +
                    '<td class="select-col"><input type="checkbox" data-admin-select="' + escape(doc.guid) + '" ' + (selected ? 'checked' : '') + ' aria-label="Select message"></td>' +
                    '<td class="star-col"><button type="button" class="mail-admin-star' + (doc.favorite ? ' is-active' : '') + '" data-admin-action="toggle-favorite" data-guid="' + escape(doc.guid) + '" aria-label="Toggle favorite">' + svg('star') + '</button></td>' +
                    '<td data-admin-col="from"><div class="mail-admin-cell-primary">' + escape(doc.from || 'Unknown sender') + '</div><div class="mail-admin-cell-secondary">' + rowStatus(doc) + (vip ? '<span class="mail-admin-badge vip">VIP</span>' : '') + '</div></td>' +
                    '<td data-admin-col="to"><div class="mail-admin-cell-primary">' + escape(doc.to || '—') + '</div><div class="mail-admin-cell-secondary">' + (doc.cc ? 'Cc: ' + escape(doc.cc) : '') + '</div></td>' +
                    '<td data-admin-col="subject"><button type="button" class="mail-admin-subject" data-admin-action="open-message" data-guid="' + escape(doc.guid) + '">' + escape(doc.subject || '(No subject)') + '</button><div class="mail-admin-cell-secondary">' + (attachments ? '<span class="mail-admin-attachment-chip">' + svg('paperclip') + attachments + '</span>' : '') + '</div></td>' +
                    '<td data-admin-col="folder"><span class="mail-admin-folder-chip">' + escape(doc.folder || 'inbox') + '</span></td>' +
                    '<td data-admin-col="date"><div class="mail-admin-date">' + escape(relativeTime(doc.date) || dateTime(doc.date)) + '</div><small>' + escape(dateTime(doc.date)) + '</small></td>' +
                    '<td class="action-col"><div class="mail-admin-row-actions"><button type="button" data-admin-action="open-message" data-guid="' + escape(doc.guid) + '" title="Open message">' + svg('view') + '</button><a href="/api/emails/eml?guid=' + encodeURIComponent(doc.guid) + '" download title="Download EML"><svg viewBox="0 0 24 24"><path d="M12 3v12M7 10l5 5 5-5M5 20h14"></path></svg></a><button type="button" data-admin-action="delete-one" data-guid="' + escape(doc.guid) + '" class="danger" title="Delete message">' + svg('trash') + '</button></div></td>' +
                    '</tr>';
            }).join('');
        }
        applyColumnVisibility();
        updateSelectionUI();
    }

    function updatePagination() {
        const page = Math.floor(state.offset / state.limit) + 1;
        const pages = Math.max(1, Math.ceil(state.count / state.limit));
        const pageNumber = q('[data-admin-page-number]');
        const pageTotal = q('[data-admin-page-total]');
        const prev = q('[data-admin-action="prev-page"]');
        const next = q('[data-admin-action="next-page"]');
        const footer = q('[data-admin-pagination]');
        const range = q('[data-admin-result-range]');
        const first = state.count ? state.offset + 1 : 0;
        const last = state.count ? Math.min(state.offset + state.items.length, state.count) : 0;
        if (range) range.textContent = state.count ? first.toLocaleString() + '–' + last.toLocaleString() : '0';
        if (pageNumber) pageNumber.textContent = page;
        if (pageTotal) pageTotal.textContent = pages;
        if (prev) prev.disabled = page <= 1;
        if (next) next.disabled = page >= pages;
        if (footer) footer.hidden = state.count <= state.limit;
    }

    function updateSelectionUI() {
        const bar = q('[data-admin-bulkbar]');
        const count = q('[data-admin-selected-count]');
        const selectAll = q('[data-admin-select-all]');
        const visible = state.items.map((item) => String(item.guid));
        const visibleSelected = visible.filter((guid) => state.selected.has(guid)).length;
        if (bar) bar.hidden = state.selected.size === 0;
        if (count) count.textContent = state.selected.size;
        if (selectAll) {
            selectAll.checked = visible.length > 0 && visibleSelected === visible.length;
            selectAll.indeterminate = visibleSelected > 0 && visibleSelected < visible.length;
        }
    }

    async function loadMessages(options) {
        if (state.loading) return;
        state.loading = true;
        const refreshButton = q('[data-admin-action="refresh"]');
        if (options?.button) setBusy(options.button, true, 'Loading…');
        else if (!options?.silent && refreshButton) refreshButton.classList.add('is-busy');
        try {
            updateFilterBadge();
            const filters = readFilters();
            const response = await post('/api/emails/admin/list', Object.assign({}, filters, { offset: state.offset, limit: state.limit, sortBy: state.sortBy, sortDir: state.sortDir }));
            state.items = response.list || [];
            state.count = Number(response.count || 0);
            const resultCount = q('[data-admin-result-count]');
            if (resultCount) resultCount.textContent = state.count.toLocaleString();
            const last = q('[data-admin-last-refresh]');
            if (last) last.textContent = 'Updated ' + new Date().toLocaleTimeString() + (Number.isFinite(Number(response.durationMs)) ? ' · ' + Number(response.durationMs).toLocaleString() + ' ms' : '');
            renderRows();
            updatePagination();
            updateSortIndicators();
        } catch (error) {
            toast(error.message || 'Unable to load messages.', 'error', 'Load failed');
        } finally {
            state.loading = false;
            if (options?.button) setBusy(options.button, false);
            else if (!options?.silent && refreshButton) refreshButton.classList.remove('is-busy');
        }
    }

    async function refreshAll(button) {
        if (button) setBusy(button, true, 'Refreshing…');
        try {
            await loadAdminSummary();
            await loadMessages();
            toast('Dashboard data is up to date.', 'success', 'Refreshed', { duration: 1800 });
        } catch (error) {
            toast(error.message || 'Unable to refresh the dashboard.', 'error', 'Refresh failed');
        } finally {
            if (button) setBusy(button, false);
        }
    }

    async function updateOne(guid, patch, options) {
        const response = await post('/api/emails/admin/update', Object.assign({ guid }, patch || {}));
        const index = state.items.findIndex((item) => String(item.guid) === String(guid));
        if (index >= 0 && response.doc) state.items[index] = Object.assign({}, state.items[index], response.doc);
        if (state.current && String(state.current.guid) === String(guid) && response.doc) state.current = Object.assign({}, state.current, response.doc);
        if (options?.reload !== false) await loadAdminSummary();
        renderRows();
        return response.doc;
    }

    async function toggleFavorite(guid, button) {
        const doc = state.items.find((item) => String(item.guid) === String(guid));
        if (!doc) return;
        setBusy(button, true);
        try {
            await updateOne(guid, { favorite: !doc.favorite });
            toast(doc.favorite ? 'Removed from favorites.' : 'Added to favorites.', 'success', 'Favorite updated', { duration: 1500 });
        } catch (error) {
            toast(error.message || 'Unable to update favorite.', 'error', 'Update failed');
        } finally {
            setBusy(button, false);
        }
    }

    function privacyHtml(privacy) {
        privacy = privacy || {};
        return '<span class="mail-admin-privacy-chip"><strong>' + Number(privacy.trackingPixels || 0) + '</strong> tracking pixels</span><span class="mail-admin-privacy-chip"><strong>' + Number(privacy.remoteImages || 0) + '</strong> remote images</span><span class="mail-admin-privacy-chip"><strong>' + Number(privacy.externalLinks || 0) + '</strong> external links</span>';
    }

    function renderAttachments(doc) {
        const section = q('[data-admin-attachments]');
        const list = q('[data-admin-attachment-list]');
        const count = q('[data-admin-attachment-count]');
        const items = Array.isArray(doc.attachments) ? doc.attachments : [];
        if (!section || !list) return;
        section.hidden = items.length === 0;
        if (count) count.textContent = items.length + ' file' + (items.length === 1 ? '' : 's');
        list.innerHTML = items.map((item) => '<div class="mail-admin-attachment-row"><span class="mail-admin-attachment-icon">' + svg('paperclip') + '</span><div><strong>' + escape(item.filename || 'Attachment') + '</strong><small>' + escape(item.contentType || 'file') + ' · ' + formatBytes(item.size) + '</small></div><a class="sb-btn sb-btn-ghost sb-btn-small" href="/api/emails/attachment?guid=' + encodeURIComponent(doc.guid) + '&id=' + encodeURIComponent(item.id) + '" download data-admin-download="attachment">Download</a></div>').join('');
    }

    function updateMessageActionLabels() {
        const doc = state.current;
        if (!doc) return;
        const favorite = q('[data-admin-action="message-favorite"]');
        const read = q('[data-admin-action="message-read"]');
        const images = q('[data-admin-action="message-images"]');
        const vip = q('[data-admin-action="message-vip"]');
        if (favorite) favorite.textContent = doc.favorite ? '★ Favorited' : '☆ Favorite';
        if (read) read.textContent = doc.read ? 'Mark unread' : 'Mark read';
        if (images) images.textContent = state.remoteImages ? 'Block images' : 'Show images';
        if (vip) vip.textContent = doc.vip ? 'Remove mailbox VIP' : 'Set mailbox VIP';
    }

    function updateMessageFrame() {
        const frame = q('[data-admin-message-frame]');
        if (!frame || !state.current) return;
        frame.src = '/viewEmail?guid=' + encodeURIComponent(state.current.guid) + '&remote=' + (state.remoteImages ? '1' : '0');
    }

    async function openMessage(guid) {
        try {
            const response = await post('/api/emails/admin/message', { guid });
            state.current = response.doc;
            state.remoteImages = false;
            const doc = state.current;
            q('[data-admin-message-subject]').textContent = doc.subject || '(No subject)';
            q('[data-admin-message-folder]').textContent = (doc.folder || 'inbox').toUpperCase();
            q('[data-admin-message-from]').textContent = doc.from || '—';
            q('[data-admin-message-to]').textContent = doc.to || '—';
            q('[data-admin-message-date]').textContent = dateTime(doc.date);
            q('[data-admin-message-status]').textContent = doc.status || (doc.read ? 'read' : 'unread');
            q('[data-admin-message-folder-input]').value = doc.folder || 'inbox';
            q('[data-admin-privacy-strip]').innerHTML = privacyHtml(doc.privacy);
            q('[data-admin-message-eml]').href = '/api/emails/eml?guid=' + encodeURIComponent(doc.guid);
            const defaultFrom = firstEmail(doc.to);
            q('[data-admin-reply-from]').value = defaultFrom;
            q('[data-admin-forward-from]').value = defaultFrom;
            q('[data-admin-reply-text]').value = '';
            q('[data-admin-forward-to]').value = '';
            q('[data-admin-forward-text]').value = '';
            q('[data-admin-reply-panel]').hidden = true;
            q('[data-admin-forward-panel]').hidden = true;
            renderAttachments(doc);
            updateMessageFrame();
            updateMessageActionLabels();
            ui.show('#adminMessageModal');
            if (!doc.read) {
                await updateOne(doc.guid, { read: true }, { reload: false });
                state.current.read = true;
                updateMessageActionLabels();
                loadAdminSummary().then(() => renderStats()).catch(() => {});
            }
        } catch (error) {
            toast(error.message || 'Unable to open this message.', 'error', 'Message unavailable');
        }
    }

    async function deleteOne(guid, fromModal) {
        if (!window.confirm('Delete this email permanently? Attachments stored with it will also be deleted.')) return;
        try {
            await post('/api/emails/admin/delete', { guid });
            state.selected.delete(String(guid));
            if (fromModal) ui.hide('#adminMessageModal');
            await loadAdminSummary();
            await loadMessages();
            toast('The email and its stored attachments were deleted.', 'success', 'Email deleted');
        } catch (error) {
            toast(error.message || 'Unable to delete this email.', 'error', 'Delete failed');
        }
    }

    async function bulkUpdate(patch, successMessage) {
        const guids = Array.from(state.selected);
        if (!guids.length) return;
        try {
            const response = await post('/api/emails/admin/bulk-update', Object.assign({ guids }, patch));
            state.selected.clear();
            await loadAdminSummary();
            await loadMessages();
            toast(successMessage || (response.updatedCount + ' messages updated.'), 'success', 'Bulk action complete');
        } catch (error) {
            toast(error.message || 'Unable to update selected messages.', 'error', 'Bulk update failed');
        }
    }

    async function bulkDelete() {
        const guids = Array.from(state.selected);
        if (!guids.length) return;
        if (!window.confirm('Permanently delete ' + guids.length + ' selected email' + (guids.length === 1 ? '' : 's') + '?')) return;
        try {
            const response = await post('/api/emails/admin/bulk-delete', { guids });
            state.selected.clear();
            await loadAdminSummary();
            await loadMessages();
            toast((response.result?.deletedCount || 0) + ' messages deleted.', 'success', 'Bulk delete complete');
        } catch (error) {
            toast(error.message || 'Unable to delete selected messages.', 'error', 'Bulk delete failed');
        }
    }

    function composePayload() {
        const form = q('[data-admin-compose-form]');
        const data = Object.fromEntries(new FormData(form).entries());
        return data;
    }

    async function sendMail(button) {
        const data = composePayload();
        if (!data.from || !data.to || (!data.text && !data.html)) return toast('From, To and message content are required.', 'warning', 'Complete the message');
        setBusy(button, true, 'Sending…');
        try {
            await post('/api/emails/admin/send', data);
            q('[data-admin-compose-form]').reset();
            ui.hide('#adminComposeModal');
            await loadAdminSummary();
            await loadMessages();
            toast('The email was sent and saved in the sent folder.', 'success', 'Mail sent');
        } catch (error) {
            toast(error.message || 'Unable to send this email.', 'error', 'Send failed');
        } finally {
            setBusy(button, false);
        }
    }

    async function sendReply(button) {
        if (!state.current) return;
        const from = q('[data-admin-reply-from]').value.trim();
        const text = q('[data-admin-reply-text]').value.trim();
        if (!from || !text) return toast('From and reply text are required.', 'warning', 'Complete the reply');
        setBusy(button, true, 'Sending…');
        try {
            await post('/api/emails/admin/reply', { guid: state.current.guid, from, text });
            q('[data-admin-reply-text]').value = '';
            q('[data-admin-reply-panel]').hidden = true;
            await loadAdminSummary();
            toast('Reply sent successfully.', 'success', 'Reply sent');
        } catch (error) {
            toast(error.message || 'Unable to send the reply.', 'error', 'Reply failed');
        } finally {
            setBusy(button, false);
        }
    }

    async function sendForward(button) {
        if (!state.current) return;
        const from = q('[data-admin-forward-from]').value.trim();
        const to = q('[data-admin-forward-to]').value.trim();
        const text = q('[data-admin-forward-text]').value.trim();
        if (!from || !to) return toast('From and destination email are required.', 'warning', 'Complete the forward');
        setBusy(button, true, 'Forwarding…');
        try {
            await post('/api/emails/admin/forward', { guid: state.current.guid, from, to, text });
            q('[data-admin-forward-to]').value = '';
            q('[data-admin-forward-text]').value = '';
            q('[data-admin-forward-panel]').hidden = true;
            await loadAdminSummary();
            toast('Message forwarded successfully.', 'success', 'Message forwarded');
        } catch (error) {
            toast(error.message || 'Unable to forward the message.', 'error', 'Forward failed');
        } finally {
            setBusy(button, false);
        }
    }

    async function toggleMessageVip(button) {
        if (!state.current) return;
        const email = firstEmail(state.current.to);
        if (!email) return toast('No recipient mailbox was found on this message.', 'warning', 'Mailbox unavailable');
        setBusy(button, true, 'Updating…');
        try {
            const next = !state.current.vip;
            await post('/api/emails/admin/vip', { email, vip: next });
            state.current.vip = next;
            if (next) state.vipEmails.add(email);
            else state.vipEmails.delete(email);
            updateMessageActionLabels();
            renderRows();
            toast(next ? 'Mailbox protection enabled.' : 'Mailbox protection removed.', 'success', next ? 'VIP enabled' : 'VIP removed');
        } catch (error) {
            toast(error.message || 'Unable to update VIP status.', 'error', 'VIP update failed');
        } finally {
            setBusy(button, false);
        }
    }

    function setQuickFilter(name) {
        qa('[data-admin-quick-filter]').forEach((button) => button.classList.toggle('is-active', button.dataset.adminQuickFilter === name));
        if (name === 'all') return clearFilters();
        const favorite = q('[data-admin-filter="favorite"]');
        const attachments = q('[data-admin-filter="hasAttachments"]');
        const read = q('[data-admin-filter="read"]');
        const status = q('[data-admin-filter="status"]');
        if (favorite) favorite.checked = false;
        if (attachments) attachments.checked = false;
        if (read) read.value = 'all';
        if (status) status.value = 'all';
        if (name === 'favorite' && favorite) favorite.checked = true;
        if (name === 'attachments' && attachments) attachments.checked = true;
        if (name === 'unread' && read) read.value = 'unread';
        if (name === 'failed' && status) status.value = 'failed';
        state.offset = 0;
        updateFilterBadge();
        loadMessages();
    }


    const policyDefinitions = [
        { group: 'Incoming sender', name: 'blockFrom', title: 'Block From emails / patterns', help: 'Reject SMTP senders matching any entry.', placeholder: 'bad@example.com\n*@spam-domain.com' },
        { group: 'Incoming sender', name: 'allowFrom', title: 'Allow From emails / patterns', help: 'When enabled with entries, only matching SMTP senders are accepted.', placeholder: 'trusted@example.com\n*@partner.com' },
        { group: 'Incoming sender', name: 'blockFromDomains', title: 'Block From domains', help: 'Reject every sender from these domains.', placeholder: 'spam.example\nbad-mail.net' },
        { group: 'Incoming sender', name: 'allowFromDomains', title: 'Allow From domains', help: 'Optional domain whitelist for SMTP senders.', placeholder: 'gmail.com\noutlook.com' },
        { group: 'Incoming recipient', name: 'blockTo', title: 'Block To emails / patterns', help: 'Reject mail addressed to matching inboxes.', placeholder: 'blocked@your-domain.com\ntest*@your-domain.com' },
        { group: 'Incoming recipient', name: 'allowTo', title: 'Allow To emails / patterns', help: 'Optional recipient whitelist.', placeholder: '*@your-domain.com' },
        { group: 'Incoming recipient', name: 'blockToDomains', title: 'Block To domains', help: 'Reject SMTP recipients on these domains.', placeholder: 'old-domain.com' },
        { group: 'Incoming recipient', name: 'allowToDomains', title: 'Allow To domains', help: 'Optional recipient-domain whitelist.', placeholder: 'domain.com\ndomain.co.uk' },
        { group: 'Network', name: 'blockIPs', title: 'Block IP addresses', help: 'Reject SMTP and public HTTP requests from these IPs.', placeholder: '203.0.113.7\n203.0.113.*\n10.0.0.0/8' },
        { group: 'Network', name: 'allowIPs', title: 'Allow IP addresses', help: 'Optional IP whitelist. Admin API access can still recover a blocked policy.', placeholder: '198.51.100.*\n192.0.2.0/24' },
        { group: 'Content', name: 'blockSubject', title: 'Block subjects', help: 'Reject a message after parsing if its subject matches.', placeholder: '*malware*\n*lottery winner*' },
        { group: 'Content', name: 'ignoreFrom', title: 'Ignore senders', help: 'Accept SMTP delivery but do not store matching messages.', placeholder: 'notifications@example.com\n*@noisy.example' },
        { group: 'Content', name: 'ignoreSubject', title: 'Ignore subjects', help: 'Accept delivery but skip storage for matching subjects.', placeholder: '*daily digest*' },
        { group: 'Outgoing mail', name: 'blockOutboundFrom', title: 'Block outbound From', help: 'Prevent Send, Reply, Forward and MCP sending from matching addresses.', placeholder: 'blocked@domain.com' },
        { group: 'Outgoing mail', name: 'allowOutboundFrom', title: 'Allow outbound From', help: 'Optional whitelist for outgoing sender addresses.', placeholder: '*@domain.com' },
        { group: 'Outgoing mail', name: 'blockOutboundTo', title: 'Block outbound To', help: 'Prevent sending to matching recipient addresses.', placeholder: 'blocked@example.com' },
        { group: 'Outgoing mail', name: 'allowOutboundTo', title: 'Allow outbound To', help: 'Optional whitelist for outgoing recipient addresses.', placeholder: '*@example.com' },
        { group: 'Outgoing mail', name: 'blockOutboundDomains', title: 'Block outbound domains', help: 'Prevent outgoing delivery to these domains.', placeholder: 'blocked-domain.com' },
        { group: 'Outgoing mail', name: 'allowOutboundDomains', title: 'Allow outbound domains', help: 'Optional whitelist for outgoing recipient domains.', placeholder: 'gmail.com\noutlook.com' },
    ];

    function policyClone(value) {
        return value == null ? value : JSON.parse(JSON.stringify(value));
    }

    function policyGet(obj, path) {
        return String(path || '').split('.').reduce((value, key) => value == null ? undefined : value[key], obj);
    }

    function policySet(obj, path, value) {
        const parts = String(path || '').split('.');
        let target = obj;
        parts.forEach((key, index) => {
            if (index === parts.length - 1) target[key] = value;
            else {
                if (!target[key] || typeof target[key] !== 'object') target[key] = {};
                target = target[key];
            }
        });
    }

    function policyLines(value) {
        return String(value || '').split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    }

    function renderPolicyLists() {
        const host = q('[data-policy-list-groups]');
        if (!host || !state.policy) return;
        const search = String(q('[data-policy-search]')?.value || '').trim().toLowerCase();
        const groups = [];
        policyDefinitions.forEach((definition) => {
            if (search && ![definition.group, definition.title, definition.help, definition.name].join(' ').toLowerCase().includes(search)) return;
            let group = groups.find((item) => item.name === definition.group);
            if (!group) {
                group = { name: definition.group, items: [] };
                groups.push(group);
            }
            group.items.push(definition);
        });
        host.innerHTML = groups.map((group) => '<section class="mail-policy-group"><header><h4>' + escape(group.name) + '</h4><span>' + group.items.length + ' lists</span></header><div class="mail-policy-list-grid">' + group.items.map((definition) => {
            const list = state.policy.lists?.[definition.name] || { enabled: false, values: [] };
            const values = Array.isArray(list.values) ? list.values : [];
            return '<article class="mail-policy-list-card" data-policy-list-card="' + escape(definition.name) + '"><div class="mail-policy-list-head"><div><h5>' + escape(definition.title) + '</h5><p>' + escape(definition.help) + '</p></div><label class="mail-policy-switch"><input type="checkbox" data-policy-list-enabled="' + escape(definition.name) + '" ' + (list.enabled ? 'checked' : '') + '><span></span></label></div><div class="mail-policy-list-meta"><span>' + values.length.toLocaleString() + ' entries</span><button type="button" data-admin-action="policy-clear-list" data-policy-list-name="' + escape(definition.name) + '" ' + (!values.length ? 'disabled' : '') + '>Clear</button></div><textarea data-policy-list-values="' + escape(definition.name) + '" spellcheck="false" placeholder="' + escape(definition.placeholder) + '">' + escape(values.join('\n')) + '</textarea><small>One entry per line. Wildcards use <code>*</code>.</small></article>';
        }).join('') + '</div></section>').join('');
        if (!groups.length) host.innerHTML = '<div class="mail-policy-no-results">No policy lists match this search.</div>';
    }

    function renderPolicyLimits() {
        if (!state.policy) return;
        const master = q('[data-policy-master]');
        if (master) master.checked = state.policy.enabled !== false;
        qa('[data-policy-limit]').forEach((input) => {
            let value = policyGet(state.policy, input.dataset.policyLimit);
            if (input.dataset.policyKind === 'boolean') input.checked = !!value;
            else {
                if (input.dataset.policyUnit === 'mb') value = Number(value || 0) / (1024 * 1024);
                if (input.dataset.policyUnit === 'kb') value = Number(value || 0) / 1024;
                input.value = Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) / 100 : '';
            }
        });
    }

    function readPolicyForm() {
        const config = policyClone(state.policy || {});
        const master = q('[data-policy-master]');
        if (master) config.enabled = !!master.checked;
        policyDefinitions.forEach((definition) => {
            if (!config.lists) config.lists = {};
            const enabled = q('[data-policy-list-enabled="' + definition.name + '"]');
            const values = q('[data-policy-list-values="' + definition.name + '"]');
            if (!config.lists[definition.name]) config.lists[definition.name] = { enabled: false, values: [] };
            if (enabled) config.lists[definition.name].enabled = !!enabled.checked;
            if (values) config.lists[definition.name].values = policyLines(values.value);
        });
        qa('[data-policy-limit]').forEach((input) => {
            let value;
            if (input.dataset.policyKind === 'boolean') value = !!input.checked;
            else {
                value = Number(input.value || 0);
                if (input.dataset.policyUnit === 'mb') value *= 1024 * 1024;
                if (input.dataset.policyUnit === 'kb') value *= 1024;
            }
            policySet(config, input.dataset.policyLimit, value);
        });
        return config;
    }

    function policyMetricLabel(key) {
        const labels = {
            smtpConnectionsAccepted: 'SMTP accepted',
            smtpConnectionsRejected: 'SMTP rejected',
            smtpMessagesRejected: 'Messages rejected',
            smtpMessagesIgnored: 'Messages ignored',
            httpRateLimited: 'HTTP rate limited',
            httpPolicyBlocked: 'HTTP policy blocked',
            outboundRateLimited: 'Outgoing rate limited',
            policyChanges: 'Policy changes',
        };
        return labels[key] || key;
    }

    function renderPolicyActivity() {
        const metricsHost = q('[data-policy-metrics]');
        const eventsHost = q('[data-policy-events]');
        const status = state.policyStatus || {};
        const metrics = status.metrics || {};
        if (metricsHost) {
            const runtime = [
                ['Active SMTP', Number(status.activeSmtpConnections || 0)],
                ['Active SMTP IPs', Number(status.activeSmtpIps || 0)],
                ['Rate buckets', Number(status.limiterBuckets || 0)],
            ];
            const counters = Object.keys(metrics).map((key) => [policyMetricLabel(key), Number(metrics[key] || 0)]);
            metricsHost.innerHTML = runtime.concat(counters).map((item) => '<div><small>' + escape(item[0]) + '</small><strong>' + item[1].toLocaleString() + '</strong></div>').join('');
        }
        if (eventsHost) {
            const events = Array.isArray(status.recentEvents) ? status.recentEvents : [];
            eventsHost.innerHTML = events.length ? events.map((event) => '<div class="mail-policy-event"><div><strong>' + escape(String(event.type || '').replace(/_/g, ' ')) + '</strong><span>' + escape(dateTime(event.date)) + '</span></div><code>' + escape(JSON.stringify(event.data || {})) + '</code></div>').join('') : '<div class="mail-policy-no-events">No protection events recorded in this process yet.</div>';
        }
    }

    function showPolicyTab(name) {
        state.policyTab = name || 'rules';
        qa('[data-policy-tab]').forEach((button) => button.classList.toggle('is-active', button.dataset.policyTab === state.policyTab));
        qa('[data-policy-pane]').forEach((pane) => { pane.hidden = pane.dataset.policyPane !== state.policyTab; });
        if (state.policyTab === 'activity') renderPolicyActivity();
    }

    async function loadPolicy(options) {
        const response = await post('/api/emails/admin/policy/get', {});
        state.policy = response.config || null;
        state.policyDefaults = response.defaults || null;
        state.policyStatus = response.status || null;
        renderPolicyLists();
        renderPolicyLimits();
        renderPolicyActivity();
        if (!options?.silent) showPolicyTab(state.policyTab || 'rules');
        return response;
    }

    async function openPolicy(button) {
        setBusy(button, true, 'Loading…');
        try {
            await loadPolicy();
            ui.show('#adminPolicyModal');
        } catch (error) {
            toast(error.message || 'Unable to load security policy.', 'error', 'Policy unavailable');
        } finally {
            setBusy(button, false);
        }
    }

    async function savePolicy(button) {
        if (!state.policy) return;
        setBusy(button, true, 'Saving…');
        try {
            const response = await post('/api/emails/admin/policy/update', { config: readPolicyForm() });
            state.policy = response.config;
            state.policyStatus = response.status || state.policyStatus;
            renderPolicyLists();
            renderPolicyLimits();
            renderPolicyActivity();
            toast('Allow/block rules and abuse limits are active immediately.', 'success', 'Security policy saved');
        } catch (error) {
            toast(error.message || 'Unable to save policy.', 'error', 'Save failed');
        } finally {
            setBusy(button, false);
        }
    }

    async function resetPolicy(button) {
        if (!window.confirm('Reset all security lists and abuse limits to the project defaults?')) return;
        setBusy(button, true, 'Resetting…');
        try {
            const response = await post('/api/emails/admin/policy/reset', {});
            state.policy = response.config;
            state.policyStatus = response.status || state.policyStatus;
            renderPolicyLists();
            renderPolicyLimits();
            renderPolicyActivity();
            toast('Default protection settings were restored.', 'success', 'Policy reset');
        } catch (error) {
            toast(error.message || 'Unable to reset policy.', 'error', 'Reset failed');
        } finally {
            setBusy(button, false);
        }
    }

    function exportPolicy() {
        if (!state.policy) return;
        const blob = new Blob([JSON.stringify(readPolicyForm(), null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = 'social-temp-mail-security-policy.json';
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        toast('Policy JSON download started.', 'success', 'Policy exported');
    }

    async function importPolicyFile(file) {
        if (!file) return;
        try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            if (!parsed || typeof parsed !== 'object' || !parsed.lists || !parsed.limits) throw new Error('This file is not a valid security policy.');
            state.policy = parsed;
            renderPolicyLists();
            renderPolicyLimits();
            showPolicyTab('rules');
            toast('Imported values are ready. Click Save changes to activate them.', 'info', 'Policy imported');
        } catch (error) {
            toast(error.message || 'Unable to import policy.', 'error', 'Import failed');
        }
    }

    async function testPolicy(button) {
        const type = q('[data-policy-test-type]')?.value || 'from';
        const value = String(q('[data-policy-test-value]')?.value || '').trim();
        if (!value) return toast('Enter a value to test.', 'warning', 'Test value required');
        setBusy(button, true, 'Testing…');
        try {
            const response = await post('/api/emails/admin/policy/test', { type, value });
            const result = response.result || {};
            const host = q('[data-policy-test-result]');
            if (host) {
                host.hidden = false;
                const allowed = result.allowed !== false && result.ignore !== true;
                const title = result.ignore ? 'Ignored' : (allowed ? 'Allowed' : 'Blocked');
                host.className = 'mail-policy-test-result ' + (result.ignore ? 'is-warning' : allowed ? 'is-allowed' : 'is-blocked');
                host.innerHTML = '<strong>' + escape(title) + '</strong><span>' + escape(result.reason || result.rule || 'No blocking rule matched.') + '</span>';
            }
        } catch (error) {
            toast(error.message || 'Unable to test the rule.', 'error', 'Test failed');
        } finally {
            setBusy(button, false);
        }
    }

    document.addEventListener('click', async function (event) {
        const sort = event.target.closest('[data-admin-sort]');
        if (sort) {
            const field = sort.dataset.adminSort || 'date';
            if (state.sortBy === field) state.sortDir = state.sortDir === 'asc' ? 'desc' : 'asc';
            else {
                state.sortBy = field;
                state.sortDir = field === 'date' ? 'desc' : 'asc';
            }
            state.offset = 0;
            updateSortIndicators();
            return loadMessages();
        }
        const folder = event.target.closest('[data-admin-folder]');
        if (folder) {
            qa('[data-admin-quick-filter]').forEach((item) => item.classList.remove('is-active'));
            const select = q('[data-admin-filter="folder"]');
            if (select) select.value = folder.dataset.adminFolder || 'all';
            state.offset = 0;
            renderFolders();
            updateFilterBadge();
            return loadMessages();
        }
        const quick = event.target.closest('[data-admin-quick-filter]');
        if (quick) return setQuickFilter(quick.dataset.adminQuickFilter || 'all');
        const button = event.target.closest('[data-admin-action]');
        if (!button) return;
        const action = button.dataset.adminAction;
        const guid = button.dataset.guid || '';
        if (action === 'refresh' || action === 'refresh-folders') return refreshAll(button);
        if (action === 'open-policy') return openPolicy(button);
        if (action === 'policy-save') return savePolicy(button);
        if (action === 'policy-reset') return resetPolicy(button);
        if (action === 'policy-export') return exportPolicy();
        if (action === 'policy-import') { const input = q('[data-policy-import-file]'); if (input) input.click(); return; }
        if (action === 'policy-refresh') { try { await loadPolicy({ silent: true }); toast('Protection activity refreshed.', 'success', 'Activity updated', { duration: 1600 }); } catch (error) { toast(error.message || 'Unable to refresh policy activity.', 'error', 'Refresh failed'); } return; }
        if (action === 'policy-tab') return showPolicyTab(button.dataset.policyTab || 'rules');
        if (action === 'policy-test') return testPolicy(button);
        if (action === 'policy-clear-list') { const name = button.dataset.policyListName; const textarea = q('[data-policy-list-values= + name + ]'); if (textarea) textarea.value = ''; button.disabled = true; return; }
        if (action === 'compose') return ui.show('#adminComposeModal');
        if (action === 'new-folder') {
            const panel = q('[data-admin-new-folder]');
            if (panel) panel.hidden = false;
            const input = q('[data-admin-new-folder-name]');
            if (input) input.focus();
            return;
        }
        if (action === 'cancel-folder') {
            const panel = q('[data-admin-new-folder]');
            if (panel) panel.hidden = true;
            return;
        }
        if (action === 'create-folder') return createFolder(button);
        if (action === 'toggle-auto-refresh') return setAutoRefresh(!state.autoRefresh, true);
        if (action === 'reset-filters') return clearFilters();
        if (action === 'toggle-columns') {
            const panel = q('[data-admin-columns-panel]');
            if (panel) panel.hidden = !panel.hidden;
            button.setAttribute('aria-expanded', panel && !panel.hidden ? 'true' : 'false');
            return;
        }
        if (action === 'toggle-filters') {
            const panel = q('[data-admin-filter-panel]');
            panel.hidden = !panel.hidden;
            button.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
            return;
        }
        if (action === 'apply-filters') { state.offset = 0; updateFilterBadge(); renderFolders(); return loadMessages({ button }); }
        if (action === 'clear-filters') return clearFilters();
        if (action === 'toggle-favorite') return toggleFavorite(guid, button);
        if (action === 'open-message') return openMessage(guid);
        if (action === 'delete-one') return deleteOne(guid, false);
        if (action === 'clear-selection') { state.selected.clear(); renderRows(); return; }
        if (action === 'bulk-read') return bulkUpdate({ read: true }, 'Selected messages marked as read.');
        if (action === 'bulk-unread') return bulkUpdate({ read: false }, 'Selected messages marked as unread.');
        if (action === 'bulk-favorite') return bulkUpdate({ favorite: true }, 'Selected messages added to favorites.');
        if (action === 'bulk-unfavorite') return bulkUpdate({ favorite: false }, 'Selected messages removed from favorites.');
        if (action === 'bulk-move') {
            const folderName = q('[data-admin-bulk-folder]').value.trim();
            if (!folderName) return toast('Enter a folder name first.', 'warning', 'Folder required');
            return bulkUpdate({ folder: folderName }, 'Selected messages moved to ' + folderName + '.');
        }
        if (action === 'bulk-delete') return bulkDelete();
        if (action === 'prev-page') { state.offset = Math.max(0, state.offset - state.limit); return loadMessages(); }
        if (action === 'next-page') { if (state.offset + state.limit < state.count) state.offset += state.limit; return loadMessages(); }
        if (action === 'send-mail') return sendMail(button);
        if (action === 'message-favorite' && state.current) {
            const next = !state.current.favorite;
            await updateOne(state.current.guid, { favorite: next });
            state.current.favorite = next;
            updateMessageActionLabels();
            return toast(next ? 'Added to favorites.' : 'Removed from favorites.', 'success', 'Favorite updated');
        }
        if (action === 'message-read' && state.current) {
            const next = !state.current.read;
            await updateOne(state.current.guid, { read: next });
            state.current.read = next;
            updateMessageActionLabels();
            return toast(next ? 'Message marked as read.' : 'Message marked as unread.', 'success', 'Read state updated');
        }
        if (action === 'message-images' && state.current) {
            state.remoteImages = !state.remoteImages;
            updateMessageFrame();
            updateMessageActionLabels();
            return toast(state.remoteImages ? 'Remote images are now allowed for this view.' : 'Remote images are blocked again.', 'info', state.remoteImages ? 'Images shown' : 'Images blocked');
        }
        if (action === 'message-save-folder' && state.current) {
            const folderName = q('[data-admin-message-folder-input]').value.trim();
            if (!folderName) return toast('Enter a folder name.', 'warning', 'Folder required');
            await updateOne(state.current.guid, { folder: folderName });
            state.current.folder = folderName;
            q('[data-admin-message-folder]').textContent = folderName.toUpperCase();
            return toast('Message moved to ' + folderName + '.', 'success', 'Folder updated');
        }
        if (action === 'message-vip') return toggleMessageVip(button);
        if (action === 'message-delete' && state.current) return deleteOne(state.current.guid, true);
        if (action === 'message-reply') { q('[data-admin-reply-panel]').hidden = false; q('[data-admin-forward-panel]').hidden = true; return; }
        if (action === 'message-forward') { q('[data-admin-forward-panel]').hidden = false; q('[data-admin-reply-panel]').hidden = true; return; }
        if (action === 'close-inline-compose') { q('[data-admin-reply-panel]').hidden = true; q('[data-admin-forward-panel]').hidden = true; return; }
        if (action === 'send-reply') return sendReply(button);
        if (action === 'send-forward') return sendForward(button);
    });

    document.addEventListener('change', function (event) {
        const checkbox = event.target.closest('[data-admin-select]');
        if (checkbox) {
            const guid = checkbox.dataset.adminSelect;
            if (checkbox.checked) state.selected.add(guid);
            else state.selected.delete(guid);
            renderRows();
            return;
        }
        const selectAll = event.target.closest('[data-admin-select-all]');
        if (selectAll) {
            state.items.forEach((item) => {
                const guid = String(item.guid);
                if (selectAll.checked) state.selected.add(guid);
                else state.selected.delete(guid);
            });
            renderRows();
            return;
        }
        const columnToggle = event.target.closest('[data-admin-column-toggle]');
        if (columnToggle) {
            state.columns[columnToggle.dataset.adminColumnToggle] = !!columnToggle.checked;
            writeLocal('socialTempMail.admin.columns', state.columns);
            applyColumnVisibility();
            return;
        }
        const pageSize = event.target.closest('[data-admin-page-size]');
        if (pageSize) {
            state.limit = Math.max(1, Math.min(Number(pageSize.value || 50), 250));
            state.offset = 0;
            loadMessages();
            return;
        }
        const importFile = event.target.closest('[data-policy-import-file]');
        if (importFile) {
            const file = importFile.files && importFile.files[0];
            importPolicyFile(file);
            importFile.value = '';
            return;
        }
    });

    const policySearchInput = q('[data-policy-search]');
    if (policySearchInput) policySearchInput.addEventListener('input', function () { renderPolicyLists(); });

    document.addEventListener('input', function (event) {
        const textarea = event.target.closest('[data-policy-list-values]');
        if (!textarea) return;
        const card = textarea.closest('.mail-policy-list-card');
        const meta = card && card.querySelector('.mail-policy-list-meta span');
        if (meta) meta.textContent = policyLines(textarea.value).length.toLocaleString() + ' entries';
        const clear = card && card.querySelector('[data-admin-action="policy-clear-list"]');
        if (clear) clear.disabled = policyLines(textarea.value).length === 0;
    });

    const queryInput = q('[data-admin-filter="query"]');
    if (queryInput) queryInput.addEventListener('input', function () {
        clearTimeout(state.filterTimer);
        state.filterTimer = setTimeout(() => {
            state.offset = 0;
            updateFilterBadge();
            loadMessages();
        }, 350);
    });

    qa('[data-admin-filter]').filter((input) => input !== queryInput).forEach((input) => {
        input.addEventListener('change', updateFilterBadge);
    });

    document.addEventListener('click', function (event) {
        const download = event.target.closest('[data-admin-download]');
        if (download) toast('Attachment download started.', 'success', 'Download');
        if (!event.target.closest('.mail-admin-columns-wrap')) {
            const panel = q('[data-admin-columns-panel]');
            const button = q('[data-admin-action="toggle-columns"]');
            if (panel && !panel.hidden) panel.hidden = true;
            if (button) button.setAttribute('aria-expanded', 'false');
        }
    });

    const newFolderInput = q('[data-admin-new-folder-name]');
    if (newFolderInput) newFolderInput.addEventListener('keydown', function (event) {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        const button = q('[data-admin-action="create-folder"]');
        if (button) createFolder(button);
    });

    async function init() {
        try {
            const savedColumns = readLocal('socialTempMail.admin.columns', null);
            if (savedColumns && typeof savedColumns === 'object') state.columns = Object.assign({}, state.columns, savedColumns);
            state.autoRefresh = readLocal('socialTempMail.admin.autoRefresh', false) === true;
            applyColumnVisibility();
            updateSortIndicators();
            setAutoRefresh(state.autoRefresh, false);
            await loadAdminSummary();
            await loadMessages();
        } catch (error) {
            toast(error.message || 'Unable to initialize the admin console.', 'error', 'Admin console unavailable', { duration: 5200 });
        }
    }

    init();
})();
