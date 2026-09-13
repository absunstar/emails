'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('module');
const {DatabaseSync}=require('node:sqlite');
const core=require('..');

class BetterSqlite3Compat{
  constructor(file=':memory:'){this.db=new DatabaseSync(file)}
  prepare(sql){
    const st=this.db.prepare(sql);
    return {
      all:(...args)=>st.all(...args),
      run:(...args)=>{const r=st.run(...args);return{changes:Number(r.changes||0),lastInsertRowid:r.lastInsertRowid}}
    };
  }
  exec(sql){return this.db.exec(sql)}
  close(){return this.db.close()}
}

async function seedAndQuery(collection,docs){
  for(const doc of docs)await collection.add(doc);
  return {
    adults:(await collection.findMany({where:{age:{$gte:18}},sort:{age:-1}})).map(x=>x.name),
    active:(await collection.findMany({where:{status:'active'},sort:{id:1}})).map(x=>x.name),
    range:(await collection.findMany({where:{age:{$gt:18,$lte:30}},sort:{age:1}})).map(x=>x.name),
    inSet:(await collection.findMany({where:{status:{$in:['active','pending']}},sort:{id:1}})).map(x=>x.name),
    logical:(await collection.findMany({where:{$or:[{status:'pending'},{age:{$lt:18}}]},sort:{id:1}})).map(x=>x.name),
    count:await collection.count({where:{age:{$gte:18}}})
  };
}

test('portable ORM query contract matches Core storage and a real SQLite engine',async()=>{
  const docs=[
    {id:1,name:'A',age:17,status:'active'},
    {id:2,name:'B',age:20,status:'active'},
    {id:3,name:'C',age:30,status:'pending'},
    {id:4,name:'D',age:40,status:'inactive'}
  ];

  const coreSite=core();
  const coreCol=coreSite.connectCollection('parity_core_'+Date.now());
  const coreResult=await seedAndQuery(coreCol,docs);

  const originalLoad=Module._load;
  Module._load=function(request,parent,isMain){
    if(request==='better-sqlite3')return BetterSqlite3Compat;
    return originalLoad.call(this,request,parent,isMain);
  };
  try{
    delete require.cache[require.resolve('../lib/orm-sql-provider')];
    delete require.cache[require.resolve('../lib/site')];
    delete require.cache[require.resolve('..')];
    const freshCore=require('..');
    const sqliteSite=freshCore({database:{provider:'sqlite',sqlite:{filename:':memory:'}}});
    sqliteSite.defineModel('parity_sqlite',{
      provider:'sqlite',mode:'relational',
      schema:{columns:{
        id:{type:'integer',primary:true},
        name:{type:'string'},
        age:{type:'integer'},
        status:{type:'string'}
      }}
    });
    const sqliteCol=sqliteSite.connectCollection('parity_sqlite');
    await sqliteCol.ready();
    const sqliteResult=await seedAndQuery(sqliteCol,docs);

    assert.deepEqual(sqliteResult,coreResult);
    await sqliteSite.stop();
  } finally {
    Module._load=originalLoad;
  }
  await coreSite.stop();
});
