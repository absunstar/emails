'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-email-env-'));
const envFile = path.join(temp, '.env');
fs.writeFileSync(envFile, [
    'SMTP_HOSTNAME=mail.test.example',
    'DKIM_ENABLED=true',
    'DKIM_REQUIRE_SIGNING=true',
    'DKIM_SELECTOR=mail77',
    'DKIM_BASE_PATH=/tmp/dkim-test',
].join('\n'));

const script = `
process.env.EMAIL_ENV_FILE = ${JSON.stringify(envFile)};
delete process.env.SMTP_HOSTNAME;
delete process.env.DKIM_ENABLED;
delete process.env.DKIM_REQUIRE_SIGNING;
delete process.env.DKIM_SELECTOR;
delete process.env.DKIM_BASE_PATH;
const { loadProjectEnv } = require(${JSON.stringify(path.join(root, 'apps/emails/core/env-loader.js'))});
const result = loadProjectEnv();
if (!result.loaded) throw new Error('env not loaded');
if (process.env.SMTP_HOSTNAME !== 'mail.test.example') throw new Error('hostname not loaded');
if (process.env.DKIM_ENABLED !== 'true') throw new Error('dkim enabled not loaded');
if (process.env.DKIM_REQUIRE_SIGNING !== 'true') throw new Error('require signing not loaded');
if (process.env.DKIM_SELECTOR !== 'mail77') throw new Error('selector not loaded');
if (process.env.DKIM_BASE_PATH !== '/tmp/dkim-test') throw new Error('base path not loaded');
console.log('ok');
`;
const run = spawnSync(process.execPath, ['-e', script], { cwd: root, encoding: 'utf8' });
assert.strictEqual(run.status, 0, run.stderr || run.stdout);
assert.match(run.stdout, /ok/);
fs.rmSync(temp, { recursive: true, force: true });
console.log('env-loader-smtp-config: ok');
