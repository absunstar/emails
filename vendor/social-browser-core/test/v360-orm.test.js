'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const core=require('..');
const {compileWhere}=require('../lib/orm-sql-provider');

test('connectCollection is an ORM facade and defaults to core provider',async()=>{
  const site=core();
  const name='orm_'+Date.now()+'_'+Math.random();
  const col=site.connectCollection(name);
  assert.equal(col.provider,'core');
  const doc=await col.add({name:'Amr',age:30});
  const one=await col.findOne({where:{_id:doc._id}});
  assert.equal(one.name,'Amr');
  await col.updateOne({where:{_id:doc._id},set:{age:31}});
  assert.equal((await col.findOne({where:{_id:doc._id}})).age,31);
  assert.equal(await col.count({where:{age:31}}),1);
  await col.deleteOne({where:{_id:doc._id}});
  assert.equal(await col.count({}),0);
});

test('custom database providers can be registered without modifying core',async()=>{
  const site=core();
  const rows=[];
  site.registerDatabaseProvider('memory-test',({name})=>({
    findMany:async()=>rows,
    findOne:async()=>rows[0]||null,
    add:async d=>{rows.push(d);return d},
    insertMany:async ds=>{rows.push(...ds);return ds},
    update:async()=>({matchedCount:0,modifiedCount:0}),
    delete:async()=>({count:0,deletedCount:0}),
    count:async()=>rows.length,
    aggregate:async()=>rows,
    stats:()=>({provider:'memory-test',name})
  }),{custom:true});
  const col=site.connectCollection('custom',{provider:'memory-test'});
  await col.add({x:1});
  assert.equal(col.provider,'memory-test');
  assert.equal(await col.count(),1);
  assert.equal((await col.findOne()).x,1);
});

test('built-in provider registry advertises optional database adapters',()=>{
  const site=core();
  const names=site.databaseProviders().map(x=>x.name);
  for(const name of ['core','mongodb','postgres','mysql','sqlite'])assert.ok(names.includes(name));
});

test('missing optional database driver fails explicitly and never falls back to core',()=>{
  const site=core();
  let hasMongo=true;
  try{require.resolve('mongodb')}catch{hasMongo=false}
  if(!hasMongo){
    assert.throws(()=>site.connectCollection('mongo_missing',{provider:'mongodb'}),e=>e.code==='ORM_DRIVER_MISSING'&&e.package==='mongodb');
  }
});

test('SQL where compiler parameterizes values',()=>{
  const q=compileWhere('postgres',{status:'active',age:{$gte:18,$lt:65},id:{$in:[1,2,3]}});
  assert.match(q.sql,/\$1/);
  assert.deepEqual(q.params,['active',18,65,1,2,3]);
  assert.equal(q.sql.includes('active'),false);
});

test('same collection name cannot silently switch providers',()=>{
  const site=core();
  site.connectCollection('users_conflict');
  assert.throws(()=>site.connectCollection('users_conflict',{provider:'sqlite'}),e=>e.code==='ORM_COLLECTION_PROVIDER_CONFLICT');
});


test('SQL compiler supports nested fields, logical operators and numeric casts',()=>{
  const q=compileWhere('postgres',{
    $or:[
      {'profile.age':{$gte:18}},
      {status:{$in:['vip','staff']}}
    ],
    score:{$lt:100}
  });
  assert.match(q.sql,/ OR /);
  assert.match(q.sql,/double precision/);
  assert.deepEqual(q.params,[18,'vip','staff',100]);
});

test('SQL compiler rejects unsupported SQLite regex instead of silently changing semantics',()=>{
  assert.throws(()=>compileWhere('sqlite',{name:{$regex:'^A'}}),e=>e.code==='ORM_QUERY_UNSUPPORTED');
});


test('site.model and connectDatabase are ORM conveniences',()=>{
  const site=core();
  assert.equal(site.model,site.connectCollection);
  const db=site.connectDatabase('core');
  const col=db.collection('via_db_'+Date.now());
  assert.equal(col.provider,'core');
});
