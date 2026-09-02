'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createEmailService } = require('../apps/emails/core/email-service');
const { analyzeEmailHtml, sanitizeEmailHtml, qrSvg } = require('../apps/emails/core/message-tools');

(async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-email-features-'));
    const sends = [];
    const service = createEmailService({
        dataDir: path.join(root, 'email-files'),
        vipPath: path.join(root, 'vip.json'),
        maxMessages: 100,
        sendmail(message, callback) {
            sends.push(message);
            callback(null, '250 queued');
        },
    });

    const stored = await service.ingestIncoming({
        guid: 'feature-message-1',
        messageId: '<feature-message-1@test>',
        from: 'Example <sender@example.net>',
        to: 'user@example.com',
        subject: 'Your verification code is 482193',
        text: 'Use code 482193 to verify your account.',
        html: '<p>Use code <b>482193</b></p><img src="https://tracker.example/open.gif" width="1" height="1"><a href="https://example.net/verify">Verify account</a>',
        attachments: [{ id: 'a1', filename: 'hello.txt', contentType: 'text/plain', contentDisposition: 'attachment', content: Buffer.from('hello attachment') }],
    });

    assert.strictEqual(stored.hasAttachments, true);
    assert.strictEqual(stored.attachments.length, 1);

    const statuses = await service.mailboxStatuses(['user@example.com', 'empty@example.com'], {});
    assert.strictEqual(statuses.items[0].count, 1);
    assert.strictEqual(statuses.items[0].latest.guid, 'feature-message-1');
    assert.strictEqual(statuses.items[1].count, 0);

    const attachment = await service.readAttachment('feature-message-1', 'a1', { domain: 'example.com', allowVip: true });
    assert.strictEqual(attachment.meta.filename, 'hello.txt');
    assert.strictEqual(attachment.content.toString(), 'hello attachment');

    const reloaded = createEmailService({
        dataDir: path.join(root, 'email-files'),
        vipPath: path.join(root, 'vip.json'),
        maxMessages: 100,
        sendmail(message, callback) { callback(null, '250 queued'); },
    });
    const persistedAttachment = await reloaded.readAttachment('feature-message-1', 'a1', { domain: 'example.com', allowVip: true });
    assert.strictEqual(persistedAttachment.content.toString(), 'hello attachment');

    const eml = await service.exportEml('feature-message-1', { domain: 'example.com', allowVip: true });
    const emlText = eml.content.toString('utf8');
    assert(emlText.includes('Subject: Your verification code is 482193'));
    assert(emlText.includes('hello.txt'));
    assert(emlText.includes(Buffer.from('hello attachment').toString('base64')));

    const privacy = analyzeEmailHtml((await service.read('feature-message-1', { domain: 'example.com', allowVip: true })).message.html);
    assert.strictEqual(privacy.remoteImages, 1);
    assert.strictEqual(privacy.trackingPixels, 1);
    const protectedHtml = sanitizeEmailHtml('<img src="https://tracker.example/open.gif" width="1" height="1"><script>alert(1)</script>');
    assert(!protectedHtml.includes('https://tracker.example/open.gif'));
    assert(!protectedHtml.includes('<script'));

    const svg = qrSvg('user@example.com');
    assert(svg.startsWith('<svg'));
    assert(svg.includes('shape-rendering="crispEdges"'));

    await service.reply({ guid: 'feature-message-1', from: 'user@example.com', text: 'Thanks' }, { domain: 'example.com', allowVip: true });
    await service.forward({ guid: 'feature-message-1', from: 'user@example.com', to: 'forward@example.org', text: 'FYI' }, { domain: 'example.com', allowVip: true });
    assert.strictEqual(sends.length, 2);
    assert.strictEqual(sends[0].to, 'sender@example.net');
    assert.strictEqual(sends[1].to, 'forward@example.org');

    const attachmentDir = service.store._attachmentDir('feature-message-1');
    assert.strictEqual(fs.existsSync(attachmentDir), true);
    await service.delete('feature-message-1', { isAdmin: true, domain: 'example.com', allowVip: true });
    assert.strictEqual(fs.existsSync(attachmentDir), false);

    const frontend = fs.readFileSync(path.join(__dirname, '..', 'apps', 'emails', 'site_files', 'js', 'index.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '..', 'apps', 'emails', 'site_files', 'html', 'free.html'), 'utf8');
    const app = fs.readFileSync(path.join(__dirname, '..', 'apps', 'emails', 'app.js'), 'utf8');
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

    assert(/LIVE_POLL_MS\s*=\s*10000/.test(frontend));
    assert(/\/api\/emails\/inboxes\/status/.test(frontend + app));
    assert(/unreadCount/.test(frontend));
    assert(/extractVerification/.test(frontend));
    assert(/Notification\.requestPermission/.test(frontend));
    assert(/data-address-search/.test(html));
    assert(/data-address-sort/.test(html));
    assert(/data-action="open-data-tools"/.test(html));
    assert(/Backup &amp; Restore/.test(html));
    assert(/Export a backup/.test(html));
    assert(/Import saved emails/.test(html));
    assert.strictEqual((html.match(/data-action="import-addresses"/g) || []).length, 1);
    assert.strictEqual((html.match(/data-action="export-addresses"/g) || []).length, 1);
    assert(/data-address-progress/.test(html));
    assert(/prefers-reduced-motion/.test(html));
    assert(/data-action="show-qr"/.test(html));
    assert(/\/api\/emails\/eml/.test(frontend + app));
    assert(/\/api\/emails\/attachment/.test(frontend + app));
    assert(/data-privacy-summary/.test(fs.readFileSync(path.join(__dirname, '..', 'apps', 'emails', 'site_files', 'html', 'view.html'), 'utf8')));
    assert(/parsed\.attachments/.test(server));
    assert(/\/api\/emails\/reply/.test(app));
    assert(/\/api\/emails\/forward/.test(app));
    assert(/Powerful features, without a complicated inbox/.test(html));
    assert(/Tracking Pixel Scan/.test(html));
    assert(/Remote Image Protection/.test(html));
    assert(/OTP Detection/.test(html));
    assert(/Verification Links/.test(html));
    assert(/Attachments &amp; EML/.test(html));
    assert(/Complete Message Download/.test(html));
    assert(/QR Transfer/.test(html));
    assert(/Reply &amp; Forward <span class="feature-badge sb">SB<\/span>/.test(html));
    assert(/Up to 100 Saved Inboxes <span class="feature-badge sb">SB<\/span>/.test(html));

    fs.rmSync(root, { recursive: true, force: true });
    console.log('Competitive temp-mail feature tests passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
