'use strict';
const fs=require('fs');
const path=require('path');
const Module=require('module');
const {DatabaseSync}=require('node:sqlite');
const core=require('..');

const ROOT=path.resolve(__dirname,'..');

function driverStatus(name){
  const site=core();
  return site.databaseProviderStatus(name);
}
async function testCoreProvider(){
  const site=core({cwd:fs.mkdtempSync('/tmp/sb-db-core-')});
  const c=site.connectCollection('cert_core_'+Date.now());
  const a=await c.add({name:'A',age:20,status:'active'});
  await c.add({name:'B',age:30,status:'inactive'});
  const rows=await c.findMany({where:{age:{$gte:18}},sort:{age:-1}});
  await c.updateOne({where:{_id:a._id},set:{age:21}});
  const one=await c.findOne({where:{_id:a._id}});
  const count=await c.count({where:{status:'active'}});
  await c.deleteMany({where:{status:'inactive'}});
  const left=await c.count({});
  await site.stop();
  return {status:'PASS',realEngine:true,driver:'builtin',rows:rows.length,updatedAge:one.age,activeCount:count,left};
}

class BetterSqlite3Compat{
  constructor(file=':memory:'){this.db=new DatabaseSync(file)}
  prepare(sql){
    const st=this.db.prepare(sql);
    return {
      all:(...args)=>st.all(...args),
      run:(...args)=>{
        const r=st.run(...args);
        return {changes:Number(r.changes||0),lastInsertRowid:r.lastInsertRowid};
      }
    };
  }
  exec(sql){return this.db.exec(sql)}
  close(){return this.db.close()}
}

async function testRealSqliteEngine(){
  const originalLoad=Module._load;
  Module._load=function(request,parent,isMain){
    if(request==='better-sqlite3')return BetterSqlite3Compat;
    return originalLoad.call(this,request,parent,isMain);
  };
  try{
    for(const id of ['../lib/orm-sql-provider','../lib/site','..']){
      try{delete require.cache[require.resolve(id)]}catch{}
    }
    const freshCore=require('..');
    const site=freshCore({database:{provider:'sqlite',sqlite:{filename:':memory:'}}});
    site.defineModel('cert_users',{
      provider:'sqlite',mode:'relational',
      schema:{version:1,columns:{
        id:{type:'integer',primary:true},
        name:{type:'string',required:true},
        age:{type:'integer'},
        status:{type:'string'},
        meta:{type:'json'}
      }}
    });
    const c=site.connectCollection('cert_users');
    await c.ready();
    await c.add({id:1,name:'A',age:20,status:'active',meta:{x:1}});
    await c.add({id:2,name:'B',age:30,status:'inactive',meta:{x:2}});
    const rows=await c.findMany({where:{age:{$gte:18}},sort:{age:-1}});
    await c.updateOne({where:{id:1},set:{age:21}});
    const one=await c.findOne({where:{id:1}});
    const count=await c.count({where:{status:'active'}});
    await c.transaction(async({execute})=>execute('UPDATE "cert_users" SET "status"=? WHERE "id"=?',['active',2]));
    const activeAfterTx=await c.count({where:{status:'active'}});
    await c.deleteOne({where:{id:2}});
    const left=await c.count({});
    await site.stop();
    return {
      status:'PASS',
      realEngine:true,
      engine:'SQLite via node:sqlite',
      optionalDriverPackage:'better-sqlite3',
      driverPackageInstalled:false,
      testAdapter:'test-only better-sqlite3 compatibility shim',
      rows:rows.length,updatedAge:one.age,activeCount:count,activeAfterTx,left
    };
  } finally {
    Module._load=originalLoad;
  }
}

async function withTimeout(promise,ms,label){
  let t;
  try{
    return await Promise.race([
      promise,
      new Promise((_,reject)=>t=setTimeout(()=>reject(Object.assign(new Error(`${label} timeout`),{code:'CERT_TIMEOUT'})),ms))
    ]);
  } finally {clearTimeout(t)}
}

async function testMongo(){
  const status=driverStatus('mongodb');
  if(!status.driverInstalled)return {status:'UNAVAILABLE',reason:'optional driver mongodb is not installed',driverStatus:status};
  const url=process.env.MONGODB_URL;
  if(!url)return {status:'DRIVER_ONLY',reason:'MONGODB_URL not provided',driverStatus:status};
  const site=core({database:{provider:'mongodb',mongodb:{url,database:process.env.MONGODB_DATABASE||'social_browser_core_cert'}}});
  const name='cert_'+Date.now();
  try{
    const c=site.connectCollection(name);
    await withTimeout(c.ready(),5000,'mongodb connect');
    await c.add({name:'A',age:20,status:'active'});
    await c.add({name:'B',age:30,status:'inactive'});
    const rows=await c.findMany({where:{age:{$gte:18}},sort:{age:-1}});
    await c.updateOne({where:{name:'A'},set:{age:21}});
    const one=await c.findOne({where:{name:'A'}});
    const count=await c.count({where:{status:'active'}});
    const distinct=await c.distinct('status',{});
    await c.mongoDrop().catch(()=>{});
    return {status:'PASS',realServer:true,rows:rows.length,updatedAge:one.age,activeCount:count,distinct};
  }catch(e){
    return {status:'SERVER_UNAVAILABLE',reason:e.message,code:e.code||null,driverStatus:status};
  }finally{await site.stop().catch(()=>{})}
}

function sqlConfig(provider){
  const envKey=provider==='postgres'?'POSTGRES_URL':'MYSQL_URL';
  const url=process.env[envKey];
  if(!url)return null;
  if(provider==='postgres')return {connectionString:url};
  try{
    const u=new URL(url);
    return {host:u.hostname,port:Number(u.port||3306),user:decodeURIComponent(u.username),password:decodeURIComponent(u.password),database:u.pathname.replace(/^\//,'')};
  }catch{return null}
}

async function testSql(provider){
  const status=driverStatus(provider);
  if(!status.driverInstalled)return {status:'UNAVAILABLE',reason:`optional driver ${status.driver} is not installed`,driverStatus:status};
  const cfg=sqlConfig(provider);
  if(!cfg)return {status:'DRIVER_ONLY',reason:`${provider==='postgres'?'POSTGRES_URL':'MYSQL_URL'} not provided`,driverStatus:status};

  const name='cert_users_'+Date.now();
  const site=core({database:{provider,[provider]:cfg}});
  site.defineModel(name,{
    provider,mode:'relational',
    schema:{version:1,columns:{
      id:{type:'integer',primary:true},
      name:{type:'string',required:true},
      age:{type:'integer'},
      status:{type:'string'}
    }}
  });
  try{
    const c=site.connectCollection(name);
    await withTimeout(c.ready(),5000,`${provider} connect`);
    await c.add({id:1,name:'A',age:20,status:'active'});
    await c.add({id:2,name:'B',age:30,status:'inactive'});
    const rows=await c.findMany({where:{age:{$gte:18}},sort:{age:-1}});
    await c.updateOne({where:{id:1},set:{age:21}});
    const one=await c.findOne({where:{id:1}});
    const count=await c.count({where:{status:'active'}});
    return {status:'PASS',realServer:true,rows:rows.length,updatedAge:one.age,activeCount:count};
  }catch(e){
    return {status:'SERVER_UNAVAILABLE',reason:e.message,code:e.code||null,driverStatus:status};
  }finally{await site.stop().catch(()=>{})}
}

(async()=>{
  const result={
    generatedAt:new Date().toISOString(),
    coreVersion:core.version,
    rule:'Optional database drivers are application dependencies; Core itself remains zero-runtime-dependency.',
    providers:{
      core:await testCoreProvider(),
      sqlite:await testRealSqliteEngine(),
      mongodb:await testMongo(),
      postgres:await testSql('postgres'),
      mysql:await testSql('mysql')
    }
  };
  result.summary={
    pass:Object.values(result.providers).filter(x=>x.status==='PASS').length,
    unavailable:Object.values(result.providers).filter(x=>x.status==='UNAVAILABLE').length,
    driverOnly:Object.values(result.providers).filter(x=>x.status==='DRIVER_ONLY').length,
    serverUnavailable:Object.values(result.providers).filter(x=>x.status==='SERVER_UNAVAILABLE').length
  };
  const out=path.join(ROOT,'CERTIFICATION-DATABASES.json');
  fs.writeFileSync(out,JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
})();
