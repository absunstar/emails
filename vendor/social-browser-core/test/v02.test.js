'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MemoryCache } = require('../lib/cache');
const { RateLimiter } = require('../lib/rate-limit');
const { acceptKey, encodeFrame, decodeFrames } = require('../lib/websocket');
const aisite = require('..');

test('cache remember works', async () => {
  const c = new MemoryCache();
  let n=0;
  assert.equal(await c.remember('x',1000,async()=>++n),1);
  assert.equal(await c.remember('x',1000,async()=>++n),1);
});

test('rate limiter blocks over max', () => {
  const r = new RateLimiter({max:2,windowMs:1000});
  assert.equal(r.hit('a').allowed,true);
  assert.equal(r.hit('a').allowed,true);
  assert.equal(r.hit('a').allowed,false);
});

test('websocket RFC accept key example', () => {
  assert.equal(
    acceptKey('dGhlIHNhbXBsZSBub25jZQ=='),
    's3pPLMBiTxaQ9kYGzzhZRbK+xOo='
  );
});

test('websocket encode/decode server frame', () => {
  const f = encodeFrame('hello');
  const p = decodeFrames(f);
  assert.equal(p.frames[0].payload.toString(),'hello');
  assert.equal(p.frames[0].opcode,1);
});

test('template if/each work', () => {
  const site = aisite();
  assert.equal(site.renderString('{{#if ok}}yes{{/if}}',{ok:true}),'yes');
  assert.equal(site.renderString('{{#each xs}}{{item}}{{/each}}',{xs:['a','b']}),'ab');
});

test('v0.2 public features exist', () => {
  const site = aisite();
  for (const name of ['onWS','websocket','rateLimit','rateLimitMiddleware']) {
    assert.equal(typeof site[name],'function',name);
  }
  assert.equal(typeof site.cache.remember,'function');
});
