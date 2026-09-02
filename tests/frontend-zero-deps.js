'use strict';

const fs = require('fs');
const path = require('path');

const roots = [
    path.join(__dirname, '..', 'site_files', 'html'),
    path.join(__dirname, '..', 'site_files', 'js'),
    path.join(__dirname, '..', 'apps', 'emails', 'site_files', 'html'),
    path.join(__dirname, '..', 'apps', 'emails', 'site_files', 'js'),
];

const forbidden = [
    [/\bangular\b/i, 'Angular'],
    [/\bng-(?:app|controller|click|model|repeat|show|hide|if|class|submit)\b/i, 'Angular directive'],
    [/\$http\b|\$timeout\b/, 'Angular service'],
    [/\bjQuery\b|\$\s*\(/, 'jQuery'],
    [/bootstrap(?:-5-support)?/i, 'Bootstrap'],
    [/<\s*i-(?:button|control|content)\b/i, 'Angular-era i-component'],
];

function files(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return files(full);
        return /\.(?:html|js)$/i.test(entry.name) ? [full] : [];
    });
}

const failures = [];
for (const file of roots.flatMap(files)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const [pattern, label] of forbidden) {
        if (pattern.test(source)) failures.push(`${label}: ${path.relative(path.join(__dirname, '..'), file)}`);
    }
    if (/\.js$/i.test(file)) {
        if (/(^|[^:])\/\//m.test(source) || /\/\*[\s\S]*?\*\//.test(source)) {
            failures.push(`JavaScript comments are not allowed in x-import frontend files: ${path.relative(path.join(__dirname, '..'), file)}`);
        }
    }
}

const vendorExport = path.join(__dirname, '..', 'site_files', 'js', 'export');
if (fs.existsSync(vendorExport)) failures.push('Legacy frontend vendor bundle still exists: site_files/js/export');

if (failures.length) {
    console.error('Frontend zero-dependency check failed:\n' + failures.map((v) => ' - ' + v).join('\n'));
    process.exit(1);
}
console.log('Frontend zero-dependency check passed');
