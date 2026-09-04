'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailService } = require('../apps/emails/core/email-service');

function assert(value, message) {
    if (!value) throw new Error(message);
}

async function run() {
    const root = path.join(__dirname, '..');
    const appJs = fs.readFileSync(path.join(root, 'apps/emails/app.js'), 'utf8');
    const serviceJs = fs.readFileSync(path.join(root, 'apps/emails/core/email-service.js'), 'utf8');
    const html = fs.readFileSync(path.join(root, 'apps/emails/site_files/html/index.html'), 'utf8');
    const adminJs = fs.readFileSync(path.join(root, 'apps/emails/site_files/js/admin.js'), 'utf8');
    const css = fs.readFileSync(path.join(root, 'site_files/css/zero-ui.css'), 'utf8');

    assert(appJs.includes("'*test*|*admin*|*dev*'"), 'Admin browser patterns must include test, admin and dev');
    assert(appJs.includes('function adminBrowser(req)'), 'Dedicated x-browser admin gate is missing');
    assert(appJs.includes("site.onGET({ name: 'admin', overwrite: true }"), 'Admin page must use a guarded route');
    assert(appJs.includes('if (!adminBrowser(req))'), 'Admin HTML route is not guarded by the browser header rule');
    assert(appJs.includes("'/api/emails/admin/summary'"), 'Admin bootstrap API is missing');
    assert(appJs.includes("'/api/emails/admin/list'"), 'Admin list API is missing');
    assert(appJs.includes("'/api/emails/admin/send'"), 'Admin send API is missing');
    assert(appJs.includes("'/api/emails/admin/reply'"), 'Admin reply API is missing');
    assert(appJs.includes("'/api/emails/admin/forward'"), 'Admin forward API is missing');
    assert(appJs.includes("'/api/emails/admin/bulk-update'"), 'Admin bulk update API is missing');
    assert(appJs.includes("'/api/emails/admin/bulk-delete'"), 'Admin bulk delete API is missing');
    assert(appJs.includes("'/api/emails/admin/vip'"), 'Admin VIP API is missing');
    assert(appJs.includes("'/api/emails/admin/folder/create'"), 'Admin folder creation API is missing');
    assert(appJs.includes('sortBy:'), 'Admin server-side sorting is missing');
    assert(appJs.includes('admin(req) ? adminGlobalContext'), 'Admin assets must bypass public domain scoping');
    assert(serviceJs.includes('favorite: !!doc.favorite'), 'Favorite state is not exposed by the email service');
    assert(serviceJs.includes('args.hasAttachments'), 'Attachment filtering is missing');
    assert(serviceJs.includes('store.messageValues()'), '10k-scale search must scan message references without cloning all stored messages');
    assert(serviceJs.includes("new Set(['date', 'id', 'from', 'to', 'subject', 'folder', 'status'])"), 'Server-side sortable fields are missing');
    assert(serviceJs.includes("'favorite'"), 'Favorite update support is missing');
    assert(html.includes('Mail Admin Console'), 'Admin dashboard redesign is missing');
    assert(html.includes('data-admin-folders') && html.includes('data-admin-filter="query"'), 'Folders/search UI is incomplete');
    assert(html.includes('data-admin-action="compose"') && html.includes('data-admin-action="message-reply"'), 'Send/reply UI is incomplete');
    assert(html.includes('data-admin-action="message-images"') && html.includes('data-admin-attachments'), 'Image/attachment controls are incomplete');
    assert(html.includes('data-admin-sort="date"') && html.includes('data-admin-action="toggle-auto-refresh"'), 'Sortable columns or auto refresh controls are missing');
    assert(html.includes('data-admin-action="new-folder"') && html.includes('data-admin-columns-panel'), 'Folder creation or column controls are missing');
    assert(html.includes('emails/admin.js') && !html.includes('emails/index.js'), 'Admin dashboard must use its own frontend controller');
    assert(adminJs.includes('/api/emails/admin/list') && adminJs.includes('/api/emails/admin/message'), 'Admin frontend is not connected to admin APIs');
    assert(adminJs.includes('toggleFavorite') && adminJs.includes('bulkUpdate'), 'Favorite and bulk actions are missing');
    assert(adminJs.includes('sendReply') && adminJs.includes('sendForward'), 'Reply/forward logic is missing');
    assert(adminJs.includes("sortBy: 'date'") && adminJs.includes('setAutoRefresh'), 'Admin 10k list preferences are missing');
    assert(adminJs.includes("socialTempMail.admin.columns") && adminJs.includes("socialTempMail.admin.autoRefresh"), 'Admin local view preferences are not persisted');
    assert(css.includes('.mail-admin-workspace') && css.includes('.mail-admin-stat') && css.includes('.mail-admin-table'), 'Admin dashboard styles are missing');
    assert(css.includes('.sb-btn .ui-icon{display:block;flex:0 0 18px;width:18px;height:18px'), 'Action SVG icons must have explicit dimensions');
    assert(css.includes('[data-admin-action=\"toggle-filters\"]{min-width:112px;height:44px'), 'Admin filters button sizing regression protection is missing');
    assert(css.includes('.mail-admin-sort') && css.includes('.mail-admin-columns-panel') && css.includes('.mail-admin-table-wrap.is-empty'), 'Admin table polish styles are missing');
    assert(css.includes('.mail-admin-shell{width:calc(100% - 24px);max-width:none'), 'Admin dashboard must use the full page width');
    assert(css.includes('td[data-admin-col=\"from\"] .mail-admin-cell-primary') && css.includes('font-size:14px'), 'Sender/recipient email text must be readable');
    const navbarHtml = fs.readFileSync(path.join(root, 'site_files/html/navbar/index.html'), 'utf8');
    const navbarJs = fs.readFileSync(path.join(root, 'site_files/js/navbar.js'), 'utf8');
    assert(navbarHtml.includes('data-browser-account-version') && navbarHtml.includes('data-browser-account-id'), 'Browser version/id must be visible in the navbar');
    assert(navbarHtml.includes('data-browser-signout') && navbarJs.includes('SBBrowserAuth.signOut'), 'Navbar sign-out control is missing');

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-email-admin-'));
    const service = createEmailService({
        dataDir: path.join(temp, 'email-files'),
        vipPath: path.join(temp, 'vip.json'),
        maxMessages: 100,
        sendmail: (message, callback) => callback(null, 'ok'),
        logger: () => {},
    });
    const saved = await service.ingestIncoming({ from: 'sender@example.net', to: 'admin-test@example.com', subject: 'Admin dashboard', text: 'hello', html: '<p>hello</p>', date: new Date().toISOString(), attachments: [] });
    await service.update(saved.guid, { favorite: true, folder: 'follow-up', read: false }, { allowVip: true });
    const favorite = await service.search({ favorite: true, folder: 'follow-up', limit: 10 }, { allowVip: true, maxLimit: 100 });
    assert(favorite.totalMatches === 1 && favorite.messages[0].favorite === true, 'Favorite/folder persistence failed');
    const stats = await service.stats({ allowVip: true });
    assert(stats.favorite === 1 && stats.folders['follow-up'] === 1, 'Admin stats do not include favorite/folder state');
    const folderResult = await service.addAdminFolder('Support Queue');
    assert(folderResult.folder === 'Support Queue' && service.listAdminFolders().includes('Support Queue'), 'Persistent admin folders failed');

    service.store.messages.clear();
    const base = Date.now() - 10000 * 1000;
    for (let index = 1; index <= 10000; index += 1) {
        const guid = 'scale-' + index;
        service.store.messages.set(guid, {
            guid,
            id: index,
            folder: index % 3 === 0 ? 'send' : 'inbox',
            status: index % 997 === 0 ? 'failed' : 'received',
            read: index % 4 !== 0,
            favorite: index % 101 === 0,
            from: 'sender' + index + '@example.net',
            to: 'mailbox' + (index % 100) + '@example.com',
            cc: '',
            subject: 'Scale message ' + String(index).padStart(5, '0'),
            text: 'Synthetic admin scale body ' + index,
            html: '<p>Synthetic admin scale body ' + index + '</p>',
            date: new Date(base + index * 1000).toISOString(),
            attachments: index % 250 === 0 ? [{ id: 'a-' + index, filename: 'file.txt', size: 5 }] : [],
        });
    }
    const page = await service.search({ limit: 50, offset: 9950, sortBy: 'id', sortDir: 'asc' }, { allowVip: true, maxLimit: 250 });
    assert(page.totalMatches === 10000, '10k search total is incorrect');
    assert(page.messages.length === 50 && page.messages[0].id === 9951 && page.messages[49].id === 10000, '10k server-side pagination/sorting failed');
    assert(page.scannedCount === 10000 && Number.isFinite(page.durationMs), '10k search diagnostics are missing');
    const scaleStats = await service.stats({ allowVip: true });
    assert(scaleStats.total === 10000 && scaleStats.storedTotal === 10000, '10k stats scan failed');
    fs.rmSync(temp, { recursive: true, force: true });
    console.log('Admin dashboard and 10k-scale checks passed');
}

run().catch((error) => {
    console.error(error.stack || error);
    process.exit(1);
});
