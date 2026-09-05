'use strict';

const fs = require('fs');
const path = require('path');

function stripInlineComment(value) {
    let quote = '';
    for (let i = 0; i < value.length; i++) {
        const ch = value[i];
        if ((ch === '"' || ch === "'") && value[i - 1] !== '\\') {
            if (!quote) quote = ch;
            else if (quote === ch) quote = '';
            continue;
        }
        if (ch === '#' && !quote && (i === 0 || /\s/.test(value[i - 1]))) return value.slice(0, i).trimEnd();
    }
    return value;
}

function decodeValue(raw) {
    let value = stripInlineComment(String(raw || '').trim());
    if (value.length >= 2 && ((value[0] === '"' && value[value.length - 1] === '"') || (value[0] === "'" && value[value.length - 1] === "'"))) {
        const quote = value[0];
        value = value.slice(1, -1);
        if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return value;
}

function parseEnv(text) {
    const result = {};
    for (const rawLine of String(text || '').split(/\r?\n/)) {
        let line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        if (line.startsWith('export ')) line = line.slice(7).trim();
        const index = line.indexOf('=');
        if (index <= 0) continue;
        const key = line.slice(0, index).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
        result[key] = decodeValue(line.slice(index + 1));
    }
    return result;
}

function candidateFiles(options) {
    options = options || {};
    const explicit = options.file || process.env.EMAIL_ENV_FILE || '';
    const candidates = [];
    if (explicit) candidates.push(path.resolve(explicit));
    candidates.push(path.resolve(process.cwd(), '.env'));
    candidates.push(path.resolve(__dirname, '..', '..', '..', '.env'));
    return [...new Set(candidates)];
}

function loadProjectEnv(options) {
    options = options || {};
    const logger = typeof options.logger === 'function' ? options.logger : null;
    for (const file of candidateFiles(options)) {
        if (!fs.existsSync(file)) continue;
        const parsed = parseEnv(fs.readFileSync(file, 'utf8'));
        let loaded = 0;
        for (const [key, value] of Object.entries(parsed)) {
            if (process.env[key] !== undefined) continue;
            process.env[key] = value;
            loaded++;
        }
        if (logger) logger('Loaded environment file ' + file + ' (' + loaded + ' values applied)');
        return { loaded: true, file, applied: loaded, keys: Object.keys(parsed) };
    }
    if (logger) logger('No .env file found; using process environment only');
    return { loaded: false, file: '', applied: 0, keys: [] };
}

module.exports = {
    parseEnv,
    loadProjectEnv,
};
