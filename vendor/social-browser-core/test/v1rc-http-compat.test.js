'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const aisite=require('..');

test('iSite v14 HTTP surface and aliases are exact for tracked manifest',async()=>{
 const site=aisite({compatibility:'isite'});
 const responseFunctions=['set','_setContentType','writeHead','ending','end','status','error','sendStatus','download2','download','html','render','txt','css','js','jsonFile','htmlContent','send','sendHTML','textContent','sendTEXT','json','redirect','remove','delete'];
 const requestFunctions=['appendBody','addFeature','hasFeature','removeFeature','getUserFinger','word'];
 site.get('/surface',(req,res)=>{
   const missingResponse=responseFunctions.filter(n=>typeof res[n]!=='function');
   const missingRequest=requestFunctions.filter(n=>typeof req[n]!=='function');
   const aliases=[
     ['delete','remove'],['html','render'],['htmlContent','send','sendHTML'],['textContent','sendTEXT']
   ].filter(g=>!g.every(n=>res[n]===res[g[0]]));
   res.json({missingResponse,missingRequest,aliases});
 });
 const server=site.createServer();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 try{
   const r=await fetch(`http://127.0.0.1:${server.address().port}/surface`);
   const x=await r.json();
   assert.deepEqual(x.missingResponse,[]);
   assert.deepEqual(x.missingRequest,[]);
   assert.deepEqual(x.aliases,[]);
 }finally{await new Promise(r=>server.close(r))}
});

test('iSite prototype helpers are removable relative to prior process state',()=>{
 const before=Object.getOwnPropertyDescriptor(String.prototype,'like');
 const site=aisite({compatibility:'isite'});
 assert.equal('Hello'.like('*ell*'),true);assert.equal('Hello'.like('ell'),false);assert.equal('Hello'.contains('llo'),true);assert.equal('abc'.test('^a'),true);
 site.removeCompatibility('isite');
 const after=Object.getOwnPropertyDescriptor(String.prototype,'like');
 assert.equal(!!after,!!before);
 if(before&&after)assert.strictEqual(after.value,before.value);
});
