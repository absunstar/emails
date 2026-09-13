'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const Module=require('node:module');
const {DatabaseSync}=require('node:sqlite');

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

function withSqliteDriver(fn){
  const original=Module._load;
  Module._load=function(request,parent,isMain){
    if(request==='better-sqlite3')return BetterSqlite3Compat;
    return original.call(this,request,parent,isMain);
  };
  for(const id of ['../lib/orm-sql-provider','../lib/site','..']){try{delete require.cache[require.resolve(id)]}catch{}}
  return Promise.resolve().then(()=>fn(require('..'))).finally(()=>{Module._load=original});
}

test('native filesystem defaults are Social Browser Core, not iSite',()=>{
  const core=require('..');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sb-native-paths-'));
  const site=core({cwd:dir});
  const c=site.connectCollection('native_paths');
  assert.match(c.engine.dir,/\.social-browser[\\/]data$/);
  assert.doesNotMatch(c.engine.dir,/\.aisite/);
  assert.match(site.sessionStore.dir,/\.social-browser[\\/]sessions$/);

  site.useCompatibility('isite');
  const legacy=site.connectCollection('legacy_paths');
  assert.match(legacy.engine.dir,/\.aisite[\\/]data$/);
  assert.match(site.options.request.uploadDir,/\.aisite[\\/]uploads$/);
  site.removeCompatibility('isite');
  assert.equal(site.options.request,undefined);
});

test('Core query contract supports top-level and field-level $not/$nor',async()=>{
  const core=require('..');
  const site=core();
  const c=site.connectCollection('not_nor_'+Date.now());
  await c.insertMany([
    {id:1,name:'A',age:17,status:'active'},
    {id:2,name:'B',age:20,status:'active'},
    {id:3,name:'C',age:30,status:'pending'},
    {id:4,name:'D',age:40,status:'inactive'}
  ]);
  assert.deepEqual((await c.findMany({where:{$not:{status:'inactive'}},sort:{id:1}})).map(x=>x.name),['A','B','C']);
  assert.deepEqual((await c.findMany({where:{$nor:[{status:'inactive'},{age:{$lt:18}}]},sort:{id:1}})).map(x=>x.name),['B','C']);
  assert.deepEqual((await c.findMany({where:{age:{$not:{$gte:30}}},sort:{id:1}})).map(x=>x.name),['A','B']);
});

test('projection, group aggregation, bulkWrite, replaceOne and upsert are portable on Core',async()=>{
  const core=require('..');
  const site=core();
  const c=site.connectCollection('portable_ops_'+Date.now());
  await c.bulkWrite([
    {insertOne:{document:{id:1,name:'A',team:'x',score:2}}},
    {insertOne:{document:{id:2,name:'B',team:'x',score:3}}},
    {insertOne:{document:{id:3,name:'C',team:'y',score:4}}}
  ]);
  const projected=await c.findMany({where:{id:1},projection:{name:1,_id:0}});
  assert.deepEqual(projected,[{name:'A'}]);

  const grouped=await c.aggregate([
    {$group:{_id:'$team',total:{$sum:'$score'},names:{$push:'$name'}}},
    {$sort:{_id:1}}
  ]);
  assert.deepEqual(grouped,[
    {_id:'x',total:5,names:['A','B']},
    {_id:'y',total:4,names:['C']}
  ]);

  const replaced=await c.replaceOne({id:1},{id:1,name:'AA',team:'z',score:9});
  assert.equal(replaced.matchedCount,1);
  assert.equal((await c.findOne({where:{id:1}})).name,'AA');

  const up=await c.upsert({id:9},{name:'N',team:'n',score:1});
  assert.ok(up.upsertedId);
  assert.equal((await c.findOne({where:{id:9}})).name,'N');

  const bulk=await c.bulkWrite([
    {updateOne:{filter:{id:2},update:{$set:{score:7}}}},
    {deleteOne:{filter:{id:3}}}
  ]);
  assert.equal(bulk.ok,true);
  assert.equal((await c.findOne({where:{id:2}})).score,7);
  assert.equal(await c.findOne({where:{id:3}}),null);
});

test('schema.diff reports added, removed and changed fields',()=>{
  const core=require('..');
  const site=core();
  const diff=site.schema.diff(
    {columns:{id:{type:'integer'},name:{type:'string'},old:{type:'text'}}},
    {columns:{id:{type:'integer'},name:{type:'text'},email:{type:'string'}}}
  );
  assert.deepEqual(diff.added.map(x=>x.name),['email']);
  assert.deepEqual(diff.removed.map(x=>x.name),['old']);
  assert.deepEqual(diff.changed.map(x=>x.name),['name']);
  assert.equal(diff.changedAny,true);
});

test('real SQLite relational provider matches advanced query/projection/aggregate contract',async()=>{
  await withSqliteDriver(async freshCore=>{
    const site=freshCore({database:{provider:'sqlite',sqlite:{filename:':memory:'}}});
    site.defineModel('adv_sqlite',{
      provider:'sqlite',mode:'relational',
      schema:{columns:{
        id:{type:'integer',primary:true},
        name:{type:'string'},
        age:{type:'integer'},
        status:{type:'string'},
        team:{type:'string'},
        score:{type:'integer'}
      }}
    });
    const c=site.connectCollection('adv_sqlite');
    await c.ready();
    await c.insertMany([
      {id:1,name:'A',age:17,status:'active',team:'x',score:2},
      {id:2,name:'B',age:20,status:'active',team:'x',score:3},
      {id:3,name:'C',age:30,status:'pending',team:'y',score:4},
      {id:4,name:'D',age:40,status:'inactive',team:'y',score:5}
    ]);
    assert.deepEqual((await c.findMany({where:{$nor:[{status:'inactive'},{age:{$lt:18}}]},sort:{id:1}})).map(x=>x.name),['B','C']);
    assert.deepEqual(await c.findMany({where:{id:1},projection:{name:1}}),[{name:'A'}]);
    assert.deepEqual(await c.aggregate([
      {$match:{age:{$gte:18}}},
      {$group:{_id:'$team',total:{$sum:'$score'}}},
      {$sort:{_id:1}}
    ]),[{_id:'x',total:3},{_id:'y',total:9}]);
    await site.stop();
  });
});

test('migration manager supports up/down and version tracking on real SQLite engine',async()=>{
  await withSqliteDriver(async freshCore=>{
    const site=freshCore({database:{provider:'sqlite',sqlite:{filename:':memory:'}}});
    const schema={version:1,columns:{id:{type:'integer',primary:true},name:{type:'string'}}};
    site.migrations.create('migr_users',{
      provider:'sqlite',
      collectionOptions:{
        mode:'relational',
        schema,
      },
      migrations:[
        {
          version:2,
          up:async({execute})=>execute('CREATE INDEX IF NOT EXISTS "idx_migr_name" ON "migr_users" ("name")'),
          down:async({execute})=>execute('DROP INDEX IF EXISTS "idx_migr_name"')
        }
      ]
    });
    const up=await site.migrations.up('migr_users','sqlite');
    assert.equal(up.version,2);
    let st=await site.migrations.status('migr_users','sqlite');
    assert.equal(st.current,2);
    const down=await site.migrations.down('migr_users','sqlite',{target:1});
    assert.equal(down.version,1);
    st=await site.migrations.status('migr_users','sqlite');
    assert.equal(st.current,1);
    await site.stop();
  });
});

test('databaseHealth never requires unavailable optional infrastructure from the caller',async()=>{
  const core=require('..');
  const site=core();
  const coreHealth=await site.databaseHealth('core');
  assert.equal(coreHealth.ok,true);
  const mongo=await site.databaseHealth('mongodb');
  assert.ok(['DRIVER_UNAVAILABLE','DOWN','UP'].includes(mongo.status));
  if(!site.databaseProviderStatus('mongodb').driverInstalled)assert.equal(mongo.status,'DRIVER_UNAVAILABLE');
});
