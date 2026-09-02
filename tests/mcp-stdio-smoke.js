'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

async function main() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'email-mcp-stdio-'));
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'apps', 'emails', 'mcp-stdio.js')], {
        cwd: path.join(__dirname, '..'),
        env: Object.assign({}, process.env, {
            EMAIL_DATA_DIR: path.join(temp, 'data'),
            EMAIL_VIP_FILE: path.join(temp, 'vip.json'),
            EMAIL_POLICY_FILE: path.join(temp, 'policy.json'),
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buffer = '';
    const replies = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
        buffer += chunk;
        let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim();
            buffer = buffer.slice(index + 1);
            if (line) replies.push(JSON.parse(line));
        }
    });
    const waitFor = async (predicate, timeout = 4000) => {
        const start = Date.now();
        while (Date.now() - start < timeout) {
            const found = replies.find(predicate);
            if (found) return found;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        throw new Error('Timed out waiting for stdio MCP response');
    };
    try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'stdio-test', version: '1' } } }) + '\n');
        const init = await waitFor((item) => item.id === 1);
        assert.equal(init.result.serverInfo.name, 'social-browser-email');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        const tools = await waitFor((item) => item.id === 2);
        assert.ok(tools.result.tools.length >= 34);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'resources/list', params: {} }) + '\n');
        const resources = await waitFor((item) => item.id === 3);
        assert.ok(resources.result.resources.length >= 6);
        console.log('MCP STDIO compatibility passed');
    } finally {
        child.kill('SIGTERM');
        fs.rmSync(temp, { recursive: true, force: true });
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
