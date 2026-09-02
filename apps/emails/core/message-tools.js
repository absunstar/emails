'use strict';

const crypto = require('crypto');

function htmlAttr(tag, name) {
    const pattern = new RegExp(`\\b${name}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, 'i');
    const match = String(tag || '').match(pattern);
    return match ? (match[1] || match[2] || match[3] || '') : '';
}

function analyzeEmailHtml(html) {
    const source = String(html || '');
    const imageTags = source.match(/<img\b[^>]*>/gi) || [];
    let remoteImages = 0;
    let trackingPixels = 0;
    for (const tag of imageTags) {
        const src = htmlAttr(tag, 'src');
        if (!/^https?:\/\//i.test(src)) continue;
        remoteImages += 1;
        const width = htmlAttr(tag, 'width');
        const height = htmlAttr(tag, 'height');
        const style = htmlAttr(tag, 'style');
        const tiny = /^(?:0|1)(?:px)?$/i.test(width) || /^(?:0|1)(?:px)?$/i.test(height) || /(?:width|height)\s*:\s*(?:0|1)px/i.test(style);
        const trackerName = /(?:track|pixel|open|beacon|analytics|transparent|spacer|collect|event)/i.test(src);
        if (tiny || trackerName) trackingPixels += 1;
    }
    const externalLinks = (source.match(/<a\b[^>]*\bhref\s*=\s*["']?https?:\/\//gi) || []).length;
    return { remoteImages, trackingPixels, externalLinks };
}

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function sanitizeEmailHtml(html, options) {
    options = options || {};
    const allowRemoteImages = options.allowRemoteImages === true;
    const attachments = Array.isArray(options.attachments) ? options.attachments : [];
    const guid = String(options.guid || '');
    const mailbox = String(options.mailbox || '');
    let source = String(html || '');
    source = source.replace(/<script\b[\s\S]*?<\/script\s*>/gi, '');
    source = source.replace(/<(?:iframe|object|embed|form|video|audio|source|track|base|link|meta)\b[\s\S]*?(?:<\/\s*(?:iframe|object|embed|form|video|audio)\s*>|\/?>)/gi, '');
    source = source.replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    source = source.replace(/\s+srcdoc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    source = source.replace(/\s+srcset\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    source = source.replace(/\s+background\s*=\s*(?:"https?:\/\/[^"]*"|'https?:\/\/[^']*'|https?:\/\/[^\s>]+)/gi, '');
    source = source.replace(/url\(\s*(['"]?)https?:\/\/[^)]*\1\s*\)/gi, 'none');
    source = source.replace(/<img\b[^>]*>/gi, (tag) => {
        const src = htmlAttr(tag, 'src');
        if (/^cid:/i.test(src)) {
            const cid = src.slice(4).replace(/[<>]/g, '').trim().toLowerCase();
            const attachment = attachments.find((item) => String(item.contentId || '').replace(/[<>]/g, '').trim().toLowerCase() === cid);
            if (attachment && guid) {
                const url = '/api/emails/attachment?guid=' + encodeURIComponent(guid) + '&id=' + encodeURIComponent(attachment.id) + '&email=' + encodeURIComponent(mailbox);
                return tag.replace(/\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, 'src="' + escapeHtml(url) + '"').replace(/\s*\/?\s*>$/, ' referrerpolicy="no-referrer">');
            }
        }
        if (!/^https?:\/\//i.test(src)) return tag;
        if (allowRemoteImages) {
            return tag.replace(/\s*\/?\s*>$/, ' referrerpolicy="no-referrer" loading="lazy">');
        }
        const alt = htmlAttr(tag, 'alt') || 'Remote image blocked';
        return '<span class="sb-remote-image-blocked" title="Remote image blocked">[' + escapeHtml(alt) + ']</span>';
    });
    source = source.replace(/<a\b([^>]*)>/gi, (tag) => {
        let next = tag.replace(/\s+target\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '').replace(/\s+rel\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
        next = next.replace(/>$/, ' target="_blank" rel="noopener noreferrer">');
        return next;
    });
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><style>html{color-scheme:light}body{font-family:Arial,sans-serif;line-height:1.55;padding:16px;margin:0;overflow-wrap:anywhere}img{max-width:100%;height:auto}.sb-remote-image-blocked{display:inline-block;padding:6px 9px;margin:3px;border:1px dashed #94a3b8;border-radius:6px;background:#f8fafc;color:#64748b;font-size:12px}a{word-break:break-all}</style></head><body>' + source + '</body></html>';
}

function headerLine(value) {
    return String(value || '').replace(/[\r\n]+/g, ' ').trim();
}

function wrapBase64(buffer) {
    return Buffer.from(buffer || Buffer.alloc(0)).toString('base64').replace(/.{1,76}/g, '$&\r\n').trimEnd();
}

async function buildEml(doc, attachmentReader) {
    const boundaryAlt = 'sb-alt-' + crypto.randomBytes(12).toString('hex');
    const boundaryMixed = 'sb-mixed-' + crypto.randomBytes(12).toString('hex');
    const attachments = Array.isArray(doc.attachments) ? doc.attachments : [];
    const lines = [];
    lines.push('From: ' + headerLine(doc.from));
    lines.push('To: ' + headerLine(doc.to));
    if (doc.cc) lines.push('Cc: ' + headerLine(doc.cc));
    if (doc.replyTo) lines.push('Reply-To: ' + headerLine(doc.replyTo));
    if (doc.subject) lines.push('Subject: ' + headerLine(doc.subject));
    if (doc.messageId) lines.push('Message-ID: ' + headerLine(doc.messageId));
    if (doc.inReplyTo) lines.push('In-Reply-To: ' + headerLine(doc.inReplyTo));
    lines.push('Date: ' + new Date(doc.date || Date.now()).toUTCString());
    lines.push('MIME-Version: 1.0');
    if (attachments.length) lines.push('Content-Type: multipart/mixed; boundary="' + boundaryMixed + '"');
    else lines.push('Content-Type: multipart/alternative; boundary="' + boundaryAlt + '"');
    lines.push('');
    if (attachments.length) {
        lines.push('--' + boundaryMixed);
        lines.push('Content-Type: multipart/alternative; boundary="' + boundaryAlt + '"');
        lines.push('');
    }
    lines.push('--' + boundaryAlt);
    lines.push('Content-Type: text/plain; charset=utf-8');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(String(doc.text || '').replace(/\r?\n/g, '\r\n'));
    lines.push('--' + boundaryAlt);
    lines.push('Content-Type: text/html; charset=utf-8');
    lines.push('Content-Transfer-Encoding: 8bit');
    lines.push('');
    lines.push(String(doc.html || '').replace(/\r?\n/g, '\r\n'));
    lines.push('--' + boundaryAlt + '--');
    if (attachments.length) {
        for (const attachment of attachments) {
            const buffer = await attachmentReader(attachment.id);
            if (!buffer) continue;
            const filename = headerLine(attachment.filename || 'attachment.bin').replace(/"/g, '');
            lines.push('--' + boundaryMixed);
            lines.push('Content-Type: ' + headerLine(attachment.contentType || 'application/octet-stream') + '; name="' + filename + '"');
            lines.push('Content-Disposition: ' + headerLine(attachment.contentDisposition || 'attachment') + '; filename="' + filename + '"');
            if (attachment.contentId) lines.push('Content-ID: <' + headerLine(String(attachment.contentId).replace(/[<>]/g, '')) + '>');
            lines.push('Content-Transfer-Encoding: base64');
            lines.push('');
            lines.push(wrapBase64(buffer));
        }
        lines.push('--' + boundaryMixed + '--');
    }
    return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
}

function gfMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i -= 1) {
        z = (z << 1) ^ ((z >>> 7) * 0x11d);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
}

function rsDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i += 1) {
        for (let j = 0; j < degree; j += 1) {
            result[j] = gfMultiply(result[j], root);
            if (j + 1 < degree) result[j] ^= result[j + 1];
        }
        root = gfMultiply(root, 0x02);
    }
    return result;
}

function rsRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const byte of data) {
        const factor = byte ^ result.shift();
        result.push(0);
        for (let i = 0; i < divisor.length; i += 1) result[i] ^= gfMultiply(divisor[i], factor);
    }
    return result;
}

function qrSvg(text) {
    const bytes = Array.from(Buffer.from(String(text || ''), 'utf8'));
    if (!bytes.length || bytes.length > 106) throw new Error('QR value is too long');
    const version = 5;
    const size = 37;
    const dataCodewords = 108;
    const eccCodewords = 26;
    const bits = [];
    const append = (value, length) => {
        for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
    };
    append(0x4, 4);
    append(bytes.length, 8);
    for (const byte of bytes) append(byte, 8);
    const capacity = dataCodewords * 8;
    for (let i = 0; i < Math.min(4, capacity - bits.length); i += 1) bits.push(0);
    while (bits.length % 8) bits.push(0);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
        let value = 0;
        for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
        data.push(value);
    }
    for (let pad = 0; data.length < dataCodewords; pad += 1) data.push(pad % 2 === 0 ? 0xec : 0x11);
    const ecc = rsRemainder(data, rsDivisor(eccCodewords));
    const all = data.concat(ecc);
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const functionModules = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFunction = (x, y, dark) => {
        if (x < 0 || y < 0 || x >= size || y >= size) return;
        modules[y][x] = !!dark;
        functionModules[y][x] = true;
    };
    const finder = (cx, cy) => {
        for (let dy = -4; dy <= 4; dy += 1) {
            for (let dx = -4; dx <= 4; dx += 1) {
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                setFunction(cx + dx, cy + dy, dist !== 2 && dist !== 4);
            }
        }
    };
    finder(3, 3);
    finder(size - 4, 3);
    finder(3, size - 4);
    for (let i = 8; i < size - 8; i += 1) {
        setFunction(6, i, i % 2 === 0);
        setFunction(i, 6, i % 2 === 0);
    }
    const align = (cx, cy) => {
        for (let dy = -2; dy <= 2; dy += 1) {
            for (let dx = -2; dx <= 2; dx += 1) setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
    };
    align(30, 30);
    for (let i = 0; i <= 5; i += 1) setFunction(8, i, false);
    setFunction(8, 7, false);
    setFunction(8, 8, false);
    setFunction(7, 8, false);
    for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, false);
    for (let i = 0; i < 8; i += 1) setFunction(size - 1 - i, 8, false);
    for (let i = 8; i < 15; i += 1) setFunction(8, size - 15 + i, false);
    setFunction(8, size - 8, true);
    const dataBits = [];
    for (const byte of all) for (let i = 7; i >= 0; i -= 1) dataBits.push((byte >>> i) & 1);
    let bitIndex = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert += 1) {
            const upward = ((right + 1) & 2) === 0;
            const y = upward ? size - 1 - vert : vert;
            for (let j = 0; j < 2; j += 1) {
                const x = right - j;
                if (functionModules[y][x]) continue;
                let dark = bitIndex < dataBits.length ? dataBits[bitIndex] === 1 : false;
                bitIndex += 1;
                if ((x + y) % 2 === 0) dark = !dark;
                modules[y][x] = dark;
            }
        }
    }
    const mask = 0;
    const formatData = (1 << 3) | mask;
    let rem = formatData;
    for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const formatBits = ((formatData << 10) | rem) ^ 0x5412;
    const formatBit = (i) => ((formatBits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i += 1) setFunction(8, i, formatBit(i));
    setFunction(8, 7, formatBit(6));
    setFunction(8, 8, formatBit(7));
    setFunction(7, 8, formatBit(8));
    for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, formatBit(i));
    for (let i = 0; i < 8; i += 1) setFunction(size - 1 - i, 8, formatBit(i));
    for (let i = 8; i < 15; i += 1) setFunction(8, size - 15 + i, formatBit(i));
    setFunction(8, size - 8, true);
    const border = 4;
    const dimension = size + border * 2;
    let path = '';
    for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
            if (modules[y][x]) path += 'M' + (x + border) + ',' + (y + border) + 'h1v1h-1z';
        }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dimension + ' ' + dimension + '" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="' + path + '" fill="#000"/></svg>';
}

module.exports = {
    analyzeEmailHtml,
    sanitizeEmailHtml,
    buildEml,
    qrSvg,
};
