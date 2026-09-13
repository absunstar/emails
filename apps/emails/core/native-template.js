'use strict';

const fs = require('fs');
const path = require('path');
const { createLegacyHtmlParser } = require('../../../vendor/social-browser-core/compat/isite/html-parser');

function readWords(file) {
    try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch (_) {
        return [];
    }
}

function createNativeTemplateRenderer(site, options = {}) {
    const wordRows = [
        ...readWords(path.join(site.cwd, 'site_files', 'json', 'words.json')),
        ...readWords(path.join(site.cwd, 'apps', 'emails', 'site_files', 'json', 'words.json')),
    ];
    const wordMap = new Map();
    for (const row of wordRows) {
        if (!row || !row.name) continue;
        wordMap.set(String(row.name), row);
    }

    site.word = function word(name, lang) {
        const row = wordMap.get(String(name));
        const language = String(lang || 'En');
        return row?.[language] ?? row?.En ?? row?.name ?? String(name);
    };

    const parser = createLegacyHtmlParser(site, {
        maxImportDepth: Number(options.maxImportDepth || 48),
        maxTemplatePasses: Number(options.maxTemplatePasses || 8),
    });

    function hostFeatures(req) {
        const host = String(req?.headers?.host || '').split(':')[0].toLowerCase();
        return {
            host,
            has(name) {
                name = String(name || '').toLowerCase();
                if (name === 'host.social-browser') return host.includes('social-browser.com');
                if (name === 'host.egytag') return host.includes('egytag.com');
                if (name === 'host.mama-services') return host.includes('mama-services.net');
                if (name === 'host.kids-browser') return host.includes('kids-browser.com');
                return false;
            },
        };
    }

    function prepareRequest(req) {
        req = req || {};
        const cookie = String(req.headers?.cookie || '');
        const cookieLang = /(?:^|;\s*)sb\.lang=([^;]+)/i.exec(cookie)?.[1];
        const queryLang = req.query?.lang || req.queryRaw?.lang;
        const raw = decodeURIComponent(String(queryLang || cookieLang || 'En'));
        const lang = /^ar$/i.test(raw) ? 'Ar' : 'En';
        req.session = req.session || {};
        req.session.lang = lang;
        req.session.language = req.session.language || {
            id: lang,
            dir: lang === 'Ar' ? 'rtl' : 'ltr',
            text: lang === 'Ar' ? 'right' : 'left',
        };
        req.word = (name) => site.word(name, lang);
        const features = hostFeatures(req);
        const priorHasFeature = typeof req.hasFeature === 'function' ? req.hasFeature.bind(req) : null;
        req.hasFeature = (name) => features.has(name) || !!priorHasFeature?.(name);
        return req;
    }

    function render(file, req, data = {}) {
        req = prepareRequest(req);
        return parser.renderFile(path.resolve(file), req, data, {
            parserDir: path.dirname(path.resolve(file)),
            data,
        });
    }

    function send(res, html, status = 200) {
        if (typeof res.status === 'function') res.status(status);
        if (typeof res.set === 'function') res.set('Content-Type', 'text/html; charset=utf-8');
        else if (typeof res.setHeader === 'function') res.setHeader('Content-Type', 'text/html; charset=utf-8');
        if (typeof res.sendHTML === 'function') return res.sendHTML(html);
        if (typeof res.htmlContent === 'function') return res.htmlContent(html);
        return res.end(html);
    }

    function renderResponse(req, res, file, data = {}) {
        return send(res, render(file, req, data));
    }

    return { parser, render, renderResponse, prepareRequest };
}

module.exports = { createNativeTemplateRenderer };
