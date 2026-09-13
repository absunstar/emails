'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const Module=require('module');
const {
  MONGO_COLLECTION_METHODS,
  MONGO_COLLECTION_ACCESSORS
}=require('../lib/orm-mongodb-provider');

const OFFICIAL_V6_COLLECTION_METHODS=[
  'aggregate','bulkWrite','count','countDocuments','createIndex','createIndexes',
  'createSearchIndex','createSearchIndexes','deleteMany','deleteOne','distinct','drop',
  'dropIndex','dropIndexes','dropSearchIndex','estimatedDocumentCount','find','findOne',
  'findOneAndDelete','findOneAndReplace','findOneAndUpdate','indexExists','indexInformation',
  'indexes','initializeOrderedBulkOp','initializeUnorderedBulkOp','insertMany','insertOne',
  'isCapped','listIndexes','listSearchIndexes','options','rename','replaceOne',
  'updateMany','updateOne','updateSearchIndex','watch'
];

test('MongoDB provider tracks the complete current Collection method surface',()=>{
  assert.deepEqual([...MONGO_COLLECTION_METHODS].sort(),[...OFFICIAL_V6_COLLECTION_METHODS].sort());
  assert.deepEqual([...MONGO_COLLECTION_ACCESSORS].sort(),[
    'bsonOptions','collectionName','dbName','hint','namespace',
    'readConcern','readPreference','writeConcern'
  ].sort());
});

test('MongoDB ORM exposes explicit wrappers plus future-proof native passthrough',async()=>{
  class ObjectId{constructor(v){this.value=v||'id'}}

  class FakeCollection{
    constructor(name){
      this.collectionName=name;
      this.dbName='testdb';
      this.bsonOptions={};
      this.hint=null;
      this.namespace={db:'testdb',collection:name};
      this.readConcern={level:'local'};
      this.readPreference={mode:'primary'};
      this.writeConcern={w:1};
    }
  }
  for(const method of OFFICIAL_V6_COLLECTION_METHODS){
    FakeCollection.prototype[method]=function(...args){
      if(method==='find')return {kind:'cursor',method,args,toArray:async()=>[]};
      if(method==='aggregate')return {kind:'cursor',method,args,toArray:async()=>[]};
      if(method==='listIndexes'||method==='listSearchIndexes')return {kind:'cursor',method,args,toArray:async()=>[]};
      if(method==='watch')return {kind:'changeStream',method,args};
      if(method==='initializeOrderedBulkOp'||method==='initializeUnorderedBulkOp')return {kind:'bulk',method,args};
      if(method==='findOne')return Promise.resolve(null);
      if(method==='countDocuments'||method==='estimatedDocumentCount'||method==='count')return Promise.resolve(0);
      if(method==='insertOne')return Promise.resolve({insertedId:new ObjectId()});
      if(method==='insertMany')return Promise.resolve({insertedIds:{}});
      if(method==='deleteOne'||method==='deleteMany')return Promise.resolve({deletedCount:0});
      if(method==='updateOne'||method==='updateMany'||method==='replaceOne')return Promise.resolve({matchedCount:0,modifiedCount:0});
      return Promise.resolve({method,args});
    };
  }
  FakeCollection.prototype.futureCollectionMethod=function(value){return {future:true,value}};

  class FakeDb{
    collection(name){return new FakeCollection(name)}
    futureDbMethod(value){return {dbFuture:true,value}}
  }
  class FakeSession{
    async withTransaction(fn){return fn()}
    async endSession(){}
  }
  class FakeMongoClient{
    constructor(){this._db=new FakeDb()}
    async connect(){return this}
    db(){return this._db}
    startSession(){return new FakeSession()}
    async close(){}
    futureClientMethod(value){return {clientFuture:true,value}}
  }
  const fakeMongo={MongoClient:FakeMongoClient,ObjectId,Decimal128:class Decimal128{}};

  const originalLoad=Module._load;
  Module._load=function(request,parent,isMain){
    if(request==='mongodb')return fakeMongo;
    return originalLoad.call(this,request,parent,isMain);
  };

  try{
    delete require.cache[require.resolve('../lib/orm-mongodb-provider')];
    delete require.cache[require.resolve('../lib/site')];
    delete require.cache[require.resolve('..')];
    const core=require('..');
    const site=core({database:{provider:'mongodb',mongodb:{url:'mongodb://fake',database:'testdb'}}});
    const col=site.connectCollection('users');

    assert.equal(col.provider,'mongodb');
    assert.ok(col.mongodb);

    // Every current Mongo Collection API has a mongoX wrapper.
    for(const method of OFFICIAL_V6_COLLECTION_METHODS){
      const wrapper='mongo'+method[0].toUpperCase()+method.slice(1);
      assert.equal(typeof col[wrapper],'function',wrapper);
    }

    // Exact native collection remains available.
    const native=await col.mongoCollection();
    assert.ok(native instanceof FakeCollection);
    assert.deepEqual(native.futureCollectionMethod(7),{future:true,value:7});

    // Future methods can be invoked without waiting for a Core release.
    assert.deepEqual(await col.mongodb.call('futureCollectionMethod',9),{future:true,value:9});
    assert.deepEqual(await col.providerCall('futureCollectionMethod',11),{future:true,value:11});

    // Accessors are reachable.
    assert.equal(await col.mongodb.get('collectionName'),'users');
    assert.equal(await col.providerGet('dbName'),'testdb');

    // Driver/Db/Client/session are intentionally exposed for 100% native escape-hatch coverage.
    assert.equal(col.mongoDriver(),fakeMongo);
    assert.equal(col.mongodb.driver(),fakeMongo);
    const db=await col.mongoDb();
    assert.deepEqual(db.futureDbMethod(1),{dbFuture:true,value:1});
    const client=col.mongoClient();
    assert.deepEqual(client.futureClientMethod(2),{clientFuture:true,value:2});
    assert.ok(col.mongoStartSession());

    // Cursor-returning APIs stay cursor-capable through native wrappers.
    const cursor=await col.mongoFind({a:1});
    assert.equal(cursor.kind,'cursor');
    const stream=await col.mongoWatch([]);
    assert.equal(stream.kind,'changeStream');

    await site.stop();
  } finally {
    Module._load=originalLoad;
  }
});
