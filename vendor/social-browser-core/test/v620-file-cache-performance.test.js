'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const core=require('..');

function tmp(){return fs.mkdtempSync(path.join(os.tmpdir(),'sb-file-cache-'))}
function get(port,pathName,headers={}){return new Promise((resolve,reject)=>{const r=http.get({host:'127.0.0.1',port,path:pathName,headers},res=>{const chunks=[];res.on('data',d=>chunks.push(d));res.on('end',()=>resolve({status:res.statusCode,body:Buffer.concat(chunks),headers:res.headers}))});r.on('error',reject)})}
async function start(site){const server=site.createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});site.servers.push(server);return server.address().port}

test('Native Core FileCacheEngine caches text/buffers in memory',()=>{
  const dir=tmp(),file=path.join(dir,'a.txt');fs.writeFileSync(file,'hello');
  const site=core({fileCache:{mode:'production'}});
  assert.equal(site.fileCache.getTextSync(file),'hello');
  const before=site.fileCache.stats();
  assert.equal(site.fileCache.getTextSync(file),'hello');
  const after=site.fileCache.stats();
  assert.ok(after.hits>before.hits);
  assert.equal(after.entries,1);
  assert.ok(after.bytes>=5);
});

test('Core write/delete helpers invalidate cached files automatically',async()=>{
  const dir=tmp(),file=path.join(dir,'a.txt');fs.writeFileSync(file,'one');
  const site=core({fileCache:{mode:'production'}});
  assert.equal(site.readFileCachedSync(file),'one');
  site.writeFileSync(file,'two');
  assert.equal(site.readFileCachedSync(file),'two');
  await site.writeFile(file,'three');
  assert.equal(await site.readFileCached(file),'three');
  assert.equal(site.deleteFileSync(file),true);
  assert.equal(site.fileCache.existsSync(file),false);
});

test('development mtime validation observes external file edits',async()=>{
  const dir=tmp(),file=path.join(dir,'a.txt');fs.writeFileSync(file,'one');
  const site=core({fileCache:{mode:'development',validation:'mtime',validateIntervalMs:5}});
  assert.equal(site.fileCache.getTextSync(file),'one');
  await new Promise(r=>setTimeout(r,10));
  fs.writeFileSync(file,'external-change');
  await new Promise(r=>setTimeout(r,10));
  assert.equal(site.fileCache.getTextSync(file),'external-change');
  assert.ok(site.fileCache.stats().revalidations>=1);
});

test('compiled cache is dependency-aware and invalidates parent templates',()=>{
  const dir=tmp(),parent=path.join(dir,'page.html'),child=path.join(dir,'header.html');
  fs.writeFileSync(parent,'page');fs.writeFileSync(child,'header');
  const site=core({fileCache:{mode:'production'}}),fc=site.fileCache;
  fc.trackDependency(parent,child);
  let compiled=0;
  const key='template:'+parent;
  assert.equal(fc.getCompiledSync(key,()=>{compiled++;return {v:1}},{files:[parent],source:'page'}).v,1);
  fc.getCompiledSync(key,()=>{compiled++;return {v:2}},{files:[parent],source:'page'});
  assert.equal(compiled,1);
  fc.invalidate(child);
  assert.equal(fc.getCompiledSync(key,()=>{compiled++;return {v:3}},{files:[parent],source:'page'}).v,3);
  assert.equal(compiled,2);
});

test('prewarm loads selected files and respects extension filtering',()=>{
  const dir=tmp();fs.mkdirSync(path.join(dir,'sub'));fs.writeFileSync(path.join(dir,'a.html'),'<b>A</b>');fs.writeFileSync(path.join(dir,'sub','b.css'),'x{}');fs.writeFileSync(path.join(dir,'x.bin'),Buffer.alloc(32));
  const site=core({fileCache:{mode:'production'}});
  const out=site.prewarmFiles(dir,{text:true,extensions:['.html','.css']});
  assert.equal(out.count,2);assert.equal(out.errors,0);assert.equal(site.fileCache.stats().prewarmed,2);
});

test('Native site.render uses Core file memory cache',()=>{
  const dir=tmp(),siteDir=path.join(dir,'site_files');fs.mkdirSync(siteDir);fs.writeFileSync(path.join(siteDir,'hello.html'),'Hello {{name}}');
  const site=core({cwd:dir,dir:siteDir,fileCache:{mode:'production'}});
  assert.equal(site.render('hello.html',{name:'A'}),'Hello A');
  const first=site.fileCache.stats();
  assert.equal(site.render('hello.html',{name:'B'}),'Hello B');
  const second=site.fileCache.stats();
  assert.ok(second.hits>first.hits);
});

test('Native static server serves cached buffers with range/etag semantics',async()=>{
  const dir=tmp();fs.writeFileSync(path.join(dir,'asset.txt'),'0123456789');
  const site=core({fileCache:{mode:'production'}});site.static('/assets',dir);
  const port=await start(site);
  try{
    const a=await get(port,'/assets/asset.txt');assert.equal(a.status,200);assert.equal(a.body.toString(),'0123456789');
    const before=site.fileCache.stats();
    const b=await get(port,'/assets/asset.txt',{Range:'bytes=2-5'});assert.equal(b.status,206);assert.equal(b.body.toString(),'2345');
    const after=site.fileCache.stats();assert.ok(after.hits>before.hits);assert.ok(a.headers.etag);
  }finally{await site.stop({forceAfterMs:200})}
});

test('iSite compatibility parser uses the same Core cache for files, imports and compiled ASTs',()=>{
  const dir=tmp(),siteFiles=path.join(dir,'site_files'),html=path.join(siteFiles,'html');fs.mkdirSync(html,{recursive:true});
  const page=path.join(html,'page.html'),part=path.join(html,'part.html');
  fs.writeFileSync(part,'<span>##data.name##</span>');
  fs.writeFileSync(page,'<main><div x-import="part.html"></div></main>');
  const site=core({cwd:dir,dir:siteFiles,fileCache:{mode:'development',validation:'mtime',validateIntervalMs:5},compatibility:'isite'});
  const req={data:{name:'One'},session:{},features:[]};
  const one=site.parser.renderFile(page,req,req.data);assert.match(one,/One/);
  const first=site.fileCache.stats();
  req.data.name='Two';const two=site.parser.renderFile(page,req,req.data);assert.match(two,/Two/);
  const second=site.fileCache.stats();assert.ok(second.compiledHits>first.compiledHits);assert.ok(second.hits>first.hits);
});

test('file cache LRU enforces memory/entry bounds',()=>{
  const dir=tmp();
  const site=core({fileCache:{mode:'production',maxEntries:16,maxBytes:1024*1024,maxEntryBytes:128*1024}});
  for(let i=0;i<40;i++){const f=path.join(dir,`${i}.txt`);fs.writeFileSync(f,'x'.repeat(64*1024));site.fileCache.getBufferSync(f)}
  const st=site.fileCache.stats();assert.ok(st.entries<=16);assert.ok(st.bytes<=1024*1024);assert.ok(st.evictions>0);
});
