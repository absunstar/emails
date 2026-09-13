'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
(async()=>{
 const cwd=fs.mkdtempSync(path.join(os.tmpdir(),'aisite-prod-smoke-'));
 const site=aisite({cwd});
 const c=site.connectCollection('records',{
   schema:{required:['email'],properties:{email:{type:'string'},createdAt:{type:'number'}}}
 });
 c.createIndex('email',{unique:true});
 c.createTextIndex('email');
 c.createTTLIndex('createdAt',{expireAfterMs:86400000});
 const t0=performance.now();
 await c.insertMany(Array.from({length:10000},(_,i)=>({email:`u${i}@x.test`,createdAt:Date.now()})));
 const insertMs=performance.now()-t0;
 const t1=performance.now();
 for(let i=0;i<1000;i++) await c.findOne({where:{email:`u${i}@x.test`}});
 const lookupMs=performance.now()-t1;
 console.log(JSON.stringify({insertMs:+insertMs.toFixed(2),lookup1000Ms:+lookupMs.toFixed(2),integrity:c.integrityCheck(),stats:c.stats()},null,2));
})();
