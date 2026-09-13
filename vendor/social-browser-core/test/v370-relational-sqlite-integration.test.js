'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('module');
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

test('relational SQLite provider supports schema, CRUD, migrations, relations and async transaction',async()=>{
  const originalLoad=Module._load;
  Module._load=function(request,parent,isMain){
    if(request==='better-sqlite3')return BetterSqlite3Compat;
    return originalLoad.call(this,request,parent,isMain);
  };
  try{
    delete require.cache[require.resolve('../lib/orm-sql-provider')];
    delete require.cache[require.resolve('../lib/site')];
    delete require.cache[require.resolve('..')];
    const core=require('..');

    const site=core({database:{provider:'sqlite',sqlite:{filename:':memory:'}}});

    site.defineModel('companies',{
      provider:'sqlite',mode:'relational',
      schema:{version:1,columns:{
        id:{type:'integer',primary:true},
        name:{type:'string',required:true,unique:true}
      }}
    });

    site.defineModel('users',{
      provider:'sqlite',mode:'relational',
      schema:{
        version:2,
        columns:{
          id:{type:'integer',primary:true},
          companyId:{type:'integer',index:true},
          email:{type:'string',required:true,unique:true},
          age:{type:'integer'},
          active:{type:'boolean',default:true},
          meta:{type:'json'}
        },
        relations:{
          company:{type:'belongsTo',model:'companies',localKey:'companyId',foreignKey:'id'}
        }
      },
      migrations:[
        {version:2,up:async({execute})=>execute('CREATE INDEX IF NOT EXISTS "idx_users_age_mig" ON "users" ("age")')}
      ]
    });

    const companies=site.connectCollection('companies');
    const users=site.connectCollection('users');
    await companies.ready(); await users.ready();

    await companies.add({id:1,name:'OpenAI'});
    await users.add({id:10,companyId:1,email:'a@example.com',age:30,active:true,meta:{role:'admin'}});
    await users.add({id:11,companyId:1,email:'b@example.com',age:20,active:false,meta:{role:'user'}});

    assert.equal(await users.count({where:{companyId:1}}),2);
    assert.equal((await users.findMany({where:{age:{$gte:21}}})).length,1);

    await users.updateOne({where:{id:10},set:{age:31}});
    assert.equal((await users.findOne({where:{id:10}})).age,31);

    const included=await users.include(await users.findMany({where:{id:10}}),['company']);
    assert.equal(included[0].company.name,'OpenAI');

    assert.equal((await users.migrate()).version,2);

    await users.transaction(async({execute})=>{
      await execute('UPDATE "users" SET "age"=? WHERE "id"=?',[32,10]);
    });
    assert.equal((await users.findOne({where:{id:10}})).age,32);

    await users.deleteOne({where:{id:11}});
    assert.equal(await users.count({}),1);

    await site.stop();
  } finally {
    Module._load=originalLoad;
  }
});
