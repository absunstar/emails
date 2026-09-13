'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const http=require('node:http');
const zlib=require('node:zlib');
const core=require('..');

function request(port,url,headers={}){
  return new Promise((resolve,reject)=>{
    const req=http.get({host:'127.0.0.1',port,path:url,headers},res=>{
      const chunks=[];
      res.on('data',c=>chunks.push(c));
      res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));
    });
    req.on('error',reject);
  });
}
async function start(site){
  const server=site.createServer();
  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(0,'127.0.0.1',resolve);
  });
  site.servers.push(server);
  return server.address().port;
}

test('iSite compatibility does not double-compress precompressed Brotli static CSS',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-static-br-'));
  const css='body{background:#123;color:#fff}'.repeat(200);
  fs.writeFileSync(path.join(dir,'app.css'),css);

  const site=core({
    compatibility:'isite',
    cwd:dir,
    fileCache:{prewarm:false},
    session:{enabled:false},
    memoryPressure:{enabled:false}
  });
  site.static('/assets',dir);
  const port=await start(site);

  const res=await request(port,'/assets/app.css',{'Accept-Encoding':'br'});
  assert.equal(res.status,200);
  assert.equal(res.headers['content-encoding'],'br');
  assert.match(res.headers['content-type'],/^text\/css/);

  const decoded=zlib.brotliDecompressSync(res.body).toString('utf8');
  assert.equal(decoded,css);
  assert.equal(Number(res.headers['content-length']),res.body.length);

  await site.stop({forceAfterMs:100});
  fs.rmSync(dir,{recursive:true,force:true});
});

test('iSite compatibility does not double-compress precompressed Gzip static JavaScript',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-static-gzip-'));
  const js='window.__staticCompressionTest=(window.__staticCompressionTest||0)+1;'.repeat(200);
  fs.writeFileSync(path.join(dir,'app.js'),js);

  const site=core({
    compatibility:'isite',
    cwd:dir,
    fileCache:{prewarm:false},
    session:{enabled:false},
    memoryPressure:{enabled:false}
  });
  site.static('/assets',dir);
  const port=await start(site);

  const res=await request(port,'/assets/app.js',{'Accept-Encoding':'gzip'});
  assert.equal(res.status,200);
  assert.equal(res.headers['content-encoding'],'gzip');
  assert.match(res.headers['content-type'],/javascript/);

  const decoded=zlib.gunzipSync(res.body).toString('utf8');
  assert.equal(decoded,js);
  assert.equal(Number(res.headers['content-length']),res.body.length);

  await site.stop({forceAfterMs:100});
  fs.rmSync(dir,{recursive:true,force:true});
});

test('dynamic iSite text responses are still compressed exactly once',async()=>{
  const site=core({
    compatibility:'isite',
    fileCache:{prewarm:false},
    session:{enabled:false},
    memoryPressure:{enabled:false}
  });
  const source='<html><body>'+('compression works '.repeat(200))+'</body></html>';
  site.get('/dynamic',(req,res)=>{
    res.set('Content-Type','text/html');
    res.end(source);
  });
  const port=await start(site);

  const res=await request(port,'/dynamic',{'Accept-Encoding':'br'});
  assert.equal(res.status,200);
  assert.equal(res.headers['content-encoding'],'br');
  assert.equal(zlib.brotliDecompressSync(res.body).toString('utf8'),source);

  await site.stop({forceAfterMs:100});
});

test('res.file precompressed path remains single-encoded under iSite compatibility',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-res-file-'));
  const css='.x{display:grid;gap:8px}'.repeat(200);
  const file=path.join(dir,'x.css');
  fs.writeFileSync(file,css);

  const site=core({
    compatibility:'isite',
    cwd:dir,
    fileCache:{prewarm:false},
    session:{enabled:false},
    memoryPressure:{enabled:false}
  });
  site.get('/file',(req,res)=>res.file(file));
  const port=await start(site);

  const res=await request(port,'/file',{'Accept-Encoding':'br'});
  assert.equal(res.headers['content-encoding'],'br');
  assert.equal(zlib.brotliDecompressSync(res.body).toString('utf8'),css);

  await site.stop({forceAfterMs:100});
  fs.rmSync(dir,{recursive:true,force:true});
});
