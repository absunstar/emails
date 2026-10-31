'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const { createEmbedMetrics, publicHost, loadOrCreateEmbedSigningKey } = require('../apps/emails/core/embed-metrics');
const { createNativeTemplateRenderer } = require('../apps/emails/core/native-template');
(async()=>{
  assert.equal(publicHost('https://example.com/abc?email=something'), 'example.com');
  assert.equal(publicHost('http://news.example.com'), 'news.example.com');
  assert.equal(publicHost('javascript:alert(1)'), '');
  assert.equal(publicHost('https://localhost/foo'), '');
  assert.equal(publicHost('https://user:pass@example.com'), '');
  assert.equal(publicHost('https://emails.egytag.com/ar/embed-builder'), '');
  const work=fs.mkdtempSync(path.join(os.tmpdir(),'egytag-embed-metrics-'));
  try{
    const signingFile = path.join(work, 'key', 'embed.key');
    const firstSecret = loadOrCreateEmbedSigningKey(signingFile);
    assert.equal(firstSecret.length, 32);
    assert.deepEqual(loadOrCreateEmbedSigningKey(signingFile), firstSecret, 'Signed sessions must survive restarts');
    let current=Date.UTC(2026,9,31),cfg={file:path.join(work,'metrics.json'),secret:firstSecret,now:()=>current};
    const m=createEmbedMetrics(cfg);const token=m.issue('example.com');
    assert.equal(m.verify(token),'example.com');
    assert.equal(createEmbedMetrics({...cfg, secret:loadOrCreateEmbedSigningKey(signingFile)}).verify(token),'example.com', 'Token must survive a server restart');
    assert.equal(m.verify(token+'tampered'),null);
    assert.equal(m.verify('random'),null);
    assert.equal(m.track('example.com','view'),true);
    assert.equal(m.track(m.verify(token),'copied'),true);
    assert.equal(m.track('example.com','open'),true);
    assert.equal(m.track('example.com','invalid'),false);
    assert.equal(m.stats('example.com').views,1);
    assert.equal(m.stats('example.com').copied,1);
    assert.equal(m.stats('example.com').open,1);
    assert.equal(m.stats('another.com').views,0);
    await m.flush();
    assert.equal(createEmbedMetrics(cfg).stats('example.com').views,1);
    current+=86401000;assert.equal(m.verify(token),null,'Expired tokens must be rejected');
  }finally{fs.rmSync(work,{recursive:true,force:true})}
  const root=path.resolve(__dirname,'..');const renderer=createNativeTemplateRenderer({cwd:root,dir:path.join(root,'site_files'),options:{lang:'En'}});
  for(const lang of ['en','ar','es','pt','de','fr','hi','ru','id','tr','vi']){
    for(const page of ['embed.html','embed-builder.html']){
      const route=(lang==='en'?'':'/'+lang)+'/'+page.replace('.html','');
      const html=renderer.render(path.join(root,'apps/emails/site_files/html',page),{url:route,headers:{host:'emails.egytag.com'}});
      assert(!html.includes('##word.'),'No unresolved translations: '+lang+' '+page);
      assert(html.includes('lang="'+lang+'"'), 'Language tag missing');
      const scripts=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
      for(const script of scripts) assert.doesNotThrow(()=>new Function(script[1]),'Inline JS syntax: '+lang+' '+page);
      assert(html.includes('egytag.com'), 'Brand required');
      if(page==='embed.html'){
        assert(html.includes('crypto.getRandomValues'), 'Use browser random for temporary email');
        assert(html.includes('new Uint8Array(8)'), 'Generated addresses need to remain short enough for compact widgets while retaining 64-bit randomness');
        assert(html.includes("new URL(path,'https://emails.egytag.com')"), 'Open real main inbox, not private iframe');
        assert(!html.includes('/api/emails/all'), 'Embed cannot read user messages');
        assert(html.includes('/*__EMBED_CONTEXT__*/'), 'Server must inject signed source');
      }else{
        assert(html.includes('referrerpolicy='), 'Origin attribution iframe required');
        assert(html.includes('data-email-language-switch'), 'Shared language system required');
        assert(html.includes('/api/embed/stats'), 'Partner metrics required');
      }
    }
  }
  const app=fs.readFileSync(path.join(root,'apps/emails/app.js'),'utf8');
  assert(app.includes("res.removeHeader('X-Frame-Options')"), 'Frame opening scoped to embed page');
  assert(app.includes("frame-ancestors *"), 'Explicit embed CSP policy');
  assert(app.includes("/api/embed/event"),'Partner analytics endpoint');
  const free=fs.readFileSync(path.join(root,'apps/emails/site_files/html/free.html'),'utf8');
  assert(free.includes('href="/embed-builder"'),'Discoverable from homepage');
  console.log('Embed widget: 11 locales, iframe isolation, builder, signing, aggregate stats, no mailbox leakage PASS');
})().catch(err=>{console.error(err);process.exitCode=1});
