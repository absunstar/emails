
'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-debug-download-'));
 const file=path.join(dir,'x.txt');fs.writeFileSync(file,'0123456789');
 const site=aisite({cwd:dir,log:true});
 site.get('/d',(req,res)=>{
   console.log('handler res.download type',typeof res.download,'res.req?',!!res.req);
   try{
     const out=res.download(file);
     console.log('download returned',!!out,'status',res.statusCode);
   }catch(e){
     console.error('DOWNLOAD THROW',e.stack);
     throw e;
   }
 });
 const server=site.createServer();
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)});
 const url=`http://127.0.0.1:${server.address().port}/d`;
 const r=await fetch(url);
 console.log('FETCH',r.status,await r.text());
 await new Promise(resolve=>server.close(resolve));
})();
