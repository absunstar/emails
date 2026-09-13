'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const core=require('..');
const {normalizeRelationalSchema,compileRelationalWhere}=require('../lib/orm-sql-provider');

test('relational schema normalizes columns and primary key',()=>{
  const s=normalizeRelationalSchema({
    columns:{
      id:{type:'uuid',primary:true},
      email:{type:'string',required:true,unique:true},
      age:{type:'integer',index:true}
    }
  });
  assert.equal(s.primaryKey,'id');
  assert.equal(s.columns.email.required,true);
  assert.equal(s.columns.age.index,true);
});

test('relational where compiler parameterizes SQL and checks schema',()=>{
  const schema=normalizeRelationalSchema({columns:{
    id:{type:'integer',primary:true},
    status:{type:'string'},
    age:{type:'integer'}
  }});
  const q=compileRelationalWhere('postgres',schema,{
    $or:[{status:'active'},{age:{$gte:18}}],
    id:{$in:[1,2,3]}
  });
  assert.match(q.sql,/ OR /);
  assert.deepEqual(q.params,['active',18,1,2,3]);
  assert.throws(()=>compileRelationalWhere('postgres',schema,{unknown:1}),e=>e.code==='ORM_SCHEMA_COLUMN_UNKNOWN');
});

test('ORM provider registry remains extensible for relational adapters',()=>{
  const site=core();
  site.registerDatabaseProvider('rel-test',({name})=>({
    mode:'relational',
    schema:{columns:{id:{type:'integer'}}},
    findMany:async()=>[],
    findOne:async()=>null,
    add:async d=>d,
    insertMany:async d=>d,
    update:async()=>({matchedCount:0,modifiedCount:0}),
    delete:async()=>({count:0,deletedCount:0}),
    count:async()=>0,
    aggregate:async()=>[],
    stats:()=>({provider:'rel-test',mode:'relational',name})
  }));
  const c=site.connectCollection('r',{provider:'rel-test'});
  assert.equal(c.provider,'rel-test');
  assert.equal(c.stats().mode,'relational');
});


test('relational schema keeps version and relations metadata',()=>{
  const s=normalizeRelationalSchema({
    version:3,
    columns:{id:{type:'integer',primary:true},companyId:{type:'integer'}},
    relations:{company:{type:'belongsTo',model:'companies',localKey:'companyId',foreignKey:'id'}}
  });
  assert.equal(s.version,3);
  assert.equal(s.relations.company.type,'belongsTo');
});

test('collection relation() validates relation names',()=>{
  const site=core();
  site.registerDatabaseProvider('rel-meta',()=>({
    findMany:async()=>[],findOne:async()=>null,add:async d=>d,insertMany:async d=>d,
    update:async()=>({}),delete:async()=>({count:0}),count:async()=>0,aggregate:async()=>[],
    relations:()=>({company:{type:'belongsTo'}}),
    migrate:async()=>({version:1})
  }));
  const c=site.connectCollection('x',{provider:'rel-meta'});
  assert.equal(c.relation('company').type,'belongsTo');
  assert.throws(()=>c.relation('missing'),e=>e.code==='ORM_RELATION_NOT_FOUND');
});


test('defineModel stores reusable ORM definitions',()=>{
  const site=core();
  const model=site.defineModel('users_model',{
    provider:'core',
    schema:{columns:{id:{type:'integer'}}}
  });
  assert.equal(site.getModel('users_model').provider,'core');
  const col=model.collection();
  assert.equal(col.provider,'core');
  assert.equal(site.connectCollection('users_model'),col);
});
