'use strict';

const fs = require('fs');
const path = require('path');
const { createLegacyHtmlParser } = require('../../../vendor/social-browser-core/compat/isite/html-parser');
const { languages, fromPath, prefix, translatedPath, publicPages } = require('./languages');

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
        ...readWords(path.join(site.cwd, 'apps', 'emails', 'site_files', 'json', 'words-localized.json')),
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
        const pathLang = fromPath(req.path || req.pathname || req.url || req.originalUrl);
        let raw = String(queryLang || cookieLang || 'en');
        try { raw = decodeURIComponent(raw); } catch (_) { raw = 'en'; }
        const wanted = pathLang || raw.trim().toLowerCase();
        const langCode = Object.prototype.hasOwnProperty.call(languages,wanted) ? wanted : 'en';
        const language = languages[langCode];
        req.session = req.session || {};
        req.session.lang = language.id;
        req.session.language = language;
        req.session.langDir = language.dir;
        req.word = (name) => site.word(name, language.id);
        const features = hostFeatures(req);
        const priorHasFeature = typeof req.hasFeature === 'function' ? req.hasFeature.bind(req) : null;
        req.hasFeature = (name) => features.has(name) || !!priorHasFeature?.(name);
        return req;
    }

    const languageSwitcherScript = fs.readFileSync(path.join(__dirname, '../site_files/js/language-switch.js'), 'utf8');
    const languageStyles = fs.readFileSync(path.join(__dirname, '../site_files/css/language-switch.css'), 'utf8');
    function languageSwitcher(code) {
        return '<div class="email-language-switch"><label for="emailLanguageSelect" aria-label="Website language">🌐</label><select id="emailLanguageSelect" data-email-language-switch aria-label="Website language">'+Object.entries(languages).map(([key,language])=>'<option value="'+key+'"'+(code===key?' selected':'')+'>'+language.title+'</option>').join('')+'</select></div>';
    }

    function render(file, req, data = {}) {
        req = prepareRequest(req);
        let html = parser.renderFile(path.resolve(file), req, data, {
            parserDir: path.dirname(path.resolve(file)),
            data,
        });
        const langCode = req.session.language.name;
        const current = String(req.path || req.pathname || req.url || '/').split(/[?#]/)[0] || '/';
        const base = fromPath(current) ? current.slice(fromPath(current).length+1) || '/' : current;
        const canonical = 'https://emails.egytag.com' + (prefix(langCode) + (base === '/' ? '/' : base));
        // Match Social Browser's per-language URL, lang/dir and canonical conventions.
        html = html.replace(/<html\b[^>]*>/i, (tag) => {
            let v = tag.replace(/\blang="[^"]*"/i, 'lang="'+langCode+'"');
            if (!/\blang=/.test(v)) v = v.replace(/>$/, ' lang="'+langCode+'">');
            v = v.replace(/\bdir="[^"]*"/i, 'dir="'+req.session.language.dir+'"');
            if (!/\bdir=/.test(v)) v = v.replace(/>$/, ' dir="'+req.session.language.dir+'">');
            return v;
        });
        html = html.replace(/<link\s+rel="canonical"\s+href="[^"]*"\s*\/?>(?:\s*)/i, '');
        html = html.replace(/<link\s+rel="alternate"\s+hreflang="[^"]*"\s+href="[^"]*"\s*\/?>(?:\s*)/gi, '');
        if (publicPages.includes(base)) {
            const alternate = Object.entries(languages).map(([code,entry]) => '<link rel="alternate" hreflang="'+code+'" href="https://emails.egytag.com'+(prefix(code)+(base==='/'?'/':base))+'">').join('');
            html = html.replace('</head>', '<link rel="canonical" href="'+canonical+'">'+alternate+'<link rel="alternate" hreflang="x-default" href="https://emails.egytag.com'+(base==='/'?'/':base)+'"></head>');
        }
        html = html.replace(/\bhref="\/(?:temporary-email|disposable-email|verification-code-email|temp-email-for-testing|multiple-temporary-inboxes|developer-temp-mail|privacy)(?=["?#])/g, value => 'href="'+prefix(langCode)+value.slice(6));
        if (langCode !== 'en') html=html.replace(/\bhref="\/(?=["?#])/g, 'href="'+prefix(langCode)+'/');
        html=html.replace(/(<meta\s+property="og:url"\s+content=")[^"]*(")/i,(_,a,b)=>a+canonical+b);
        // Embed the same dictionary mechanism for JS-created interface labels.
        if (publicPages.includes(base)) {
            const switcher = languageSwitcher(langCode);
            if (html.includes('class="sb-navbar-actions"')) html = html.replace('class="sb-navbar-actions"', 'class="sb-navbar-actions" data-language-host') .replace('data-language-host>', 'data-language-host>'+switcher);
            else if (html.includes('class="browser-login-nav"')) html = html.replace('class="browser-login-nav"','class="browser-login-nav" data-language-host').replace('data-language-host>','data-language-host>'+switcher);
            else if (html.includes('class="embed-builder-head"')) html = html.replace('class="embed-builder-head"', 'class="embed-builder-head" data-language-host').replace('data-language-host>', 'data-language-host>'+switcher);
            else if (html.includes('class="seo-landing-header"')) html = html.replace('</header>',switcher+'</header>');
            else html = html.replace(/<body([^>]*)>/i, '<body$1>'+switcher);
            const words = {};
            for (const [name,row] of wordMap) if (name.startsWith('email_l_')) words[row.En]=row[req.session.language.id]||row.En;
            const dictionary = JSON.stringify(words).replace(/</g,'\\u003c');
            if (base === '/login' && !html.includes('</head>')) {
                const bootstrap = '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,follow"><script>document.documentElement.lang='+JSON.stringify(langCode)+';document.documentElement.dir='+JSON.stringify(req.session.language.dir)+';window.__emailUITranslation='+dictionary+';</script><style>'+languageStyles+'</style>';
                html = bootstrap + html + '<script>'+languageSwitcherScript+'</script>';
            } else {
                html = html.replace('</head>', '<style>'+languageStyles+'</style></head>');
                html = html.replace('</body>', '<script>window.__emailUITranslation='+dictionary+';</script><script>'+languageSwitcherScript+'</script></body>');
            }
        }
        // The route is already localized by the server. Never rewrite /api URLs or external links.
        return html;
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
