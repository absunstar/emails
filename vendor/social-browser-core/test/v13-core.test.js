'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');

test('core download supports ETag and byte ranges',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-download-'));
 const file=path.join(dir,'x.txt');fs.writeFileSync(file,'0123456789');
 const site=aisite({cwd:dir});
 site.get('/d',(req,res)=>res.download(file));
 const server=site.createServer();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 const base=`http://127.0.0.1:${server.address().port}/d`;
 try{
   let r=await fetch(base);
   assert.equal(r.status,200);
   assert.equal(await r.text(),'0123456789');
   assert.equal(r.headers.get('accept-ranges'),'bytes');
   const etag=r.headers.get('etag');assert.ok(etag);
   assert.ok(r.headers.get('last-modified'));

   r=await fetch(base,{headers:{'if-none-match':etag}});
   assert.equal(r.status,304);
   assert.equal((await r.arrayBuffer()).byteLength,0);

   r=await fetch(base,{headers:{range:'bytes=2-5'}});
   assert.equal(r.status,206);
   assert.equal(r.headers.get('content-range'),'bytes 2-5/10');
   assert.equal(await r.text(),'2345');

   r=await fetch(base,{headers:{range:'bytes=100-120'}});
   assert.equal(r.status,416);
   assert.equal(r.headers.get('content-range'),'bytes */10');

   r=await fetch(base,{headers:{range:'bytes=2-5','if-range':'W/"wrong"'}});
   assert.equal(r.status,200);
   assert.equal(await r.text(),'0123456789');
 }finally{
   await new Promise(r=>server.close(r));
   fs.rmSync(dir,{recursive:true,force:true});
 }
});

test('core metrics expose get()',()=>{
 const site=aisite();
 site.metrics.inc('x',2);
 assert.equal(site.metrics.get('x'),2);
});
