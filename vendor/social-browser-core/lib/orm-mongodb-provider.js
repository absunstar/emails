'use strict';

function missingDriver(name, install){
  const e=new Error(`ORM provider "${name}" requires optional package "${install}". Install it in your application; @social-browser/core keeps zero runtime dependencies.`);
  e.code='ORM_DRIVER_MISSING';e.provider=name;e.package=install;return e;
}
function requireMongo(){
  try{return require('mongodb')}catch(e){if(e?.code==='MODULE_NOT_FOUND')throw missingDriver('mongodb','mongodb');throw e}
}
function filterOf(options={}){
  if(options.where)return options.where;
  const ignore=new Set(['sort','skip','limit','projection','select','fields','multi','set','data','doc','upsert']);
  return Object.fromEntries(Object.entries(options||{}).filter(([k])=>!ignore.has(k)));
}
function patchOf(options={}){
  const patch=options.set||options.data||options.doc||Object.fromEntries(Object.entries(options).filter(([k])=>!['where','sort','skip','limit','projection','select','fields','multi','upsert'].includes(k)));
  if(patch && Object.keys(patch).some(k=>k.startsWith('$')))return patch;
  return {$set:patch||{}};
}


const MONGO_COLLECTION_METHODS=[
  'aggregate','bulkWrite','count','countDocuments','createIndex','createIndexes',
  'createSearchIndex','createSearchIndexes','deleteMany','deleteOne','distinct','drop',
  'dropIndex','dropIndexes','dropSearchIndex','estimatedDocumentCount','find','findOne',
  'findOneAndDelete','findOneAndReplace','findOneAndUpdate','indexExists','indexInformation',
  'indexes','initializeOrderedBulkOp','initializeUnorderedBulkOp','insertMany','insertOne',
  'isCapped','listIndexes','listSearchIndexes','options','rename','replaceOne',
  'updateMany','updateOne','updateSearchIndex','watch'
];

const MONGO_COLLECTION_ACCESSORS=[
  'bsonOptions','collectionName','dbName','hint','namespace','readConcern',
  'readPreference','writeConcern'
];

function nativeInvoke(ready,method,args=[]){
  return ready().then(col=>{
    const fn=col?.[method];
    if(typeof fn!=='function'){
      const e=new Error(`MongoDB Collection method "${method}" is not available in the installed driver`);
      e.code='ORM_MONGO_METHOD_UNAVAILABLE';e.method=method;throw e;
    }
    return fn.apply(col,args);
  });
}
function nativeGet(ready,property){
  return ready().then(col=>{
    if(!(property in col)){
      const e=new Error(`MongoDB Collection property "${property}" is not available in the installed driver`);
      e.code='ORM_MONGO_PROPERTY_UNAVAILABLE';e.property=property;throw e;
    }
    return col[property];
  });
}
function createMongoProvider({site,name,options,providerOptions}) {
  const cfg={...(site.options?.database?.mongodb||{}),...(site.options?.orm?.providers?.mongodb||{}),...providerOptions};
  const Mongo=requireMongo();
  const url=cfg.url||cfg.uri||'mongodb://127.0.0.1:27017';
  const database=cfg.database||cfg.dbName||site.options?.database?.name||site.name||'app';

  const key='mongodb:'+JSON.stringify([url,database,cfg.clientOptions||{}]);
  const state=site.orm.resource(key,()=>{
    const client=new Mongo.MongoClient(url,cfg.clientOptions||{});
    const state={client,db:null,promise:null,close:()=>client.close()};
    state.promise=client.connect().then(()=>{state.db=client.db(database);return state});
    return state;
  });
  const ready=()=>state.promise.then(()=>state.db.collection(options.collectionName||name,options.mongoCollectionOptions||options.collectionOptions||{}));
  const withCol=fn=>ready().then(fn);

  const adapter={
    ready,
    raw:()=>ready(),
    mongoCollection:()=>ready(),
    mongoDb:()=>state.promise.then(()=>state.db),
    mongoClient:()=>state.client,
    mongoDriver:()=>Mongo,
    mongoStartSession:(opts={})=>state.client.startSession(opts),
    startSession:(opts={})=>state.client.startSession(opts),
    native:(method,...args)=>nativeInvoke(ready,method,args),
    nativeGet:(property)=>nativeGet(ready,property),
    findMany:o=>withCol(async col=>{
      o=o||{};let cur=col.find(filterOf(o),o.projection?{projection:o.projection}:{});
      if(o.sort)cur=cur.sort(o.sort);if(o.skip)cur=cur.skip(Number(o.skip));if(o.limit)cur=cur.limit(Number(o.limit));
      return cur.toArray();
    }),
    findOne:o=>withCol(col=>col.findOne(filterOf(o||{}),o?.projection?{projection:o.projection}:{})),
    add:doc=>withCol(async col=>{const value={...(doc||{})};const r=await col.insertOne(value);if(value._id==null)value._id=r.insertedId;return value}),
    insertMany:docs=>withCol(async col=>{const list=(docs||[]).map(x=>({...x}));const r=await col.insertMany(list);for(const [i,id] of Object.entries(r.insertedIds||{}))if(list[Number(i)]?._id==null)list[Number(i)]._id=id;return list}),
    bulkWrite:(operations,opts={})=>withCol(col=>col.bulkWrite(operations,opts)),
    replaceOne:(filter,replacement,opts={})=>withCol(col=>col.replaceOne(filter,replacement,opts)),
    upsert:(where,set,opts={})=>withCol(async col=>{
      const r=await col.updateOne(where,{$set:set}, {...opts,upsert:true});
      return {matchedCount:r.matchedCount||0,modifiedCount:r.modifiedCount||0,upsertedId:r.upsertedId||null};
    }),
    update:o=>withCol(async col=>{
      const filter=filterOf(o||{}),update=patchOf(o||{}),opts={upsert:!!o?.upsert};
      const r=o?.multi?await col.updateMany(filter,update,opts):await col.updateOne(filter,update,opts);
      return {matchedCount:r.matchedCount||0,modifiedCount:r.modifiedCount||0,upsertedId:r.upsertedId||null};
    }),
    updateOne:o=>withCol(async col=>{const r=await col.updateOne(filterOf(o||{}),patchOf(o||{}),{upsert:!!o?.upsert});return {matchedCount:r.matchedCount||0,modifiedCount:r.modifiedCount||0,upsertedId:r.upsertedId||null}}),
    updateMany:o=>withCol(async col=>{const r=await col.updateMany(filterOf(o||{}),patchOf(o||{}),{upsert:!!o?.upsert});return {matchedCount:r.matchedCount||0,modifiedCount:r.modifiedCount||0,upsertedId:r.upsertedId||null}}),
    delete:o=>withCol(async col=>{const r=o?.multi?await col.deleteMany(filterOf(o||{})):await col.deleteOne(filterOf(o||{}));return {count:r.deletedCount||0,deletedCount:r.deletedCount||0}}),
    deleteOne:o=>withCol(async col=>{const r=await col.deleteOne(filterOf(o||{}));return {count:r.deletedCount||0,deletedCount:r.deletedCount||0}}),
    deleteMany:o=>withCol(async col=>{const r=await col.deleteMany(filterOf(o||{}));return {count:r.deletedCount||0,deletedCount:r.deletedCount||0}}),
    count:o=>withCol(col=>col.countDocuments(filterOf(o||{}))),
    aggregate:p=>withCol(col=>col.aggregate(p||[]).toArray()),
    distinct:(field,o)=>withCol(col=>col.distinct(field,filterOf(o||{}))),
    createIndex:(fields,o={})=>withCol(col=>col.createIndex(fields,o)),
    dropIndex:n=>withCol(col=>col.dropIndex(n)),
    listIndexes:()=>withCol(col=>col.listIndexes().toArray()),
    explain:o=>withCol(col=>col.find(filterOf(o||{})).explain()),
    migrationVersion:async()=>{
      await state.promise;
      const row=await state.db.collection('__sb_orm_migrations').findOne({_id:String(name)});
      return Number(row?.version||0);
    },
    migrate:async(opts={})=>{
      await state.promise;
      const meta=state.db.collection('__sb_orm_migrations');
      let current=Number((await meta.findOne({_id:String(name)}))?.version||0);
      const migrations=[...(opts.migrations||options.migrations||[])].sort((a,b)=>Number(a.version)-Number(b.version));
      const direction=opts.direction||'up';
      if(direction==='down'){
        const target=opts.target==null?Math.max(0,current-1):Number(opts.target);
        for(const m of [...migrations].sort((a,b)=>Number(b.version)-Number(a.version))){
          const v=Number(m.version||0);if(v>current||v<=target)continue;
          if(typeof m.down!=='function')throw Object.assign(new Error(`Migration ${v} has no down()`),{code:'ORM_MIGRATION_DOWN_MISSING',version:v});
          await m.down({db:state.db,collection:state.db.collection(options.collectionName||name),client:state.client,from:current,to:target});
          const previous=[...migrations].filter(x=>Number(x.version)<v).map(x=>Number(x.version)).sort((a,b)=>b-a)[0]||0;
          current=Math.max(target,previous);
          await meta.updateOne({_id:String(name)},{$set:{version:current,updatedAt:new Date()}},{upsert:true});
        }
        return {version:current,direction:'down'};
      }
      const target=opts.target==null?Infinity:Number(opts.target);
      for(const m of migrations){
        const v=Number(m.version||0);if(v<=current||v>target)continue;
        if(typeof m.up!=='function')throw Object.assign(new Error(`Mongo migration ${v} requires up()`),{code:'ORM_MIGRATION_INVALID',version:v});
        await m.up({db:state.db,collection:state.db.collection(options.collectionName||name),client:state.client,from:current,to:v});
        current=v;
        await meta.updateOne({_id:String(name)},{$set:{version:current,updatedAt:new Date()}},{upsert:true});
      }
      return {version:current,direction:'up'};
    },
    health:async()=>{await state.promise;await state.db.command({ping:1});return {provider:'mongodb',status:'UP',ok:true}},
    transaction:async (fn,transactionOptions={})=>{
      await state.promise;
      const session=state.client.startSession(transactionOptions.sessionOptions||{});
      try{
        let value;
        await session.withTransaction(async()=>{value=await fn({session,db:state.db,collection:state.db.collection(options.collectionName||name,options.mongoCollectionOptions||options.collectionOptions||{}),client:state.client})},transactionOptions.transactionOptions||transactionOptions);
        return value;
      }finally{await session.endSession()}
    },

    // Explicit native MongoDB Collection API wrappers.
    mongoAggregate:(pipeline=[],opts={})=>nativeInvoke(ready,'aggregate',[pipeline,opts]),
    mongoBulkWrite:(operations,opts={})=>nativeInvoke(ready,'bulkWrite',[operations,opts]),
    mongoCount:(filter={},opts={})=>nativeInvoke(ready,'count',[filter,opts]),
    mongoCountDocuments:(filter={},opts={})=>nativeInvoke(ready,'countDocuments',[filter,opts]),
    mongoCreateIndex:(indexSpec,opts={})=>nativeInvoke(ready,'createIndex',[indexSpec,opts]),
    mongoCreateIndexes:(indexSpecs,opts={})=>nativeInvoke(ready,'createIndexes',[indexSpecs,opts]),
    mongoCreateSearchIndex:(description)=>nativeInvoke(ready,'createSearchIndex',[description]),
    mongoCreateSearchIndexes:(descriptions)=>nativeInvoke(ready,'createSearchIndexes',[descriptions]),
    mongoDeleteMany:(filter={},opts={})=>nativeInvoke(ready,'deleteMany',[filter,opts]),
    mongoDeleteOne:(filter={},opts={})=>nativeInvoke(ready,'deleteOne',[filter,opts]),
    mongoDistinct:(field,filter={},opts={})=>nativeInvoke(ready,'distinct',[field,filter,opts]),
    mongoDrop:(opts={})=>nativeInvoke(ready,'drop',[opts]),
    mongoDropIndex:(indexName,opts={})=>nativeInvoke(ready,'dropIndex',[indexName,opts]),
    mongoDropIndexes:(opts={})=>nativeInvoke(ready,'dropIndexes',[opts]),
    mongoDropSearchIndex:(indexName)=>nativeInvoke(ready,'dropSearchIndex',[indexName]),
    mongoEstimatedDocumentCount:(opts={})=>nativeInvoke(ready,'estimatedDocumentCount',[opts]),
    mongoFind:(filter={},opts={})=>nativeInvoke(ready,'find',[filter,opts]),
    mongoFindOne:(filter={},opts={})=>nativeInvoke(ready,'findOne',[filter,opts]),
    mongoFindOneAndDelete:(filter={},opts={})=>nativeInvoke(ready,'findOneAndDelete',[filter,opts]),
    mongoFindOneAndReplace:(filter,replacement,opts={})=>nativeInvoke(ready,'findOneAndReplace',[filter,replacement,opts]),
    mongoFindOneAndUpdate:(filter,update,opts={})=>nativeInvoke(ready,'findOneAndUpdate',[filter,update,opts]),
    mongoIndexExists:(indexes)=>nativeInvoke(ready,'indexExists',[indexes]),
    mongoIndexInformation:(opts={})=>nativeInvoke(ready,'indexInformation',[opts]),
    mongoIndexes:(opts={})=>nativeInvoke(ready,'indexes',[opts]),
    mongoInitializeOrderedBulkOp:(opts={})=>nativeInvoke(ready,'initializeOrderedBulkOp',[opts]),
    mongoInitializeUnorderedBulkOp:(opts={})=>nativeInvoke(ready,'initializeUnorderedBulkOp',[opts]),
    mongoInsertMany:(docs,opts={})=>nativeInvoke(ready,'insertMany',[docs,opts]),
    mongoInsertOne:(doc,opts={})=>nativeInvoke(ready,'insertOne',[doc,opts]),
    mongoIsCapped:(opts={})=>nativeInvoke(ready,'isCapped',[opts]),
    mongoListIndexes:(opts={})=>nativeInvoke(ready,'listIndexes',[opts]),
    mongoListSearchIndexes:(...args)=>nativeInvoke(ready,'listSearchIndexes',args),
    mongoOptions:(opts={})=>nativeInvoke(ready,'options',[opts]),
    mongoRename:(newName,opts={})=>nativeInvoke(ready,'rename',[newName,opts]),
    mongoReplaceOne:(filter,replacement,opts={})=>nativeInvoke(ready,'replaceOne',[filter,replacement,opts]),
    mongoUpdateMany:(filter,update,opts={})=>nativeInvoke(ready,'updateMany',[filter,update,opts]),
    mongoUpdateOne:(filter,update,opts={})=>nativeInvoke(ready,'updateOne',[filter,update,opts]),
    mongoUpdateSearchIndex:(name,definition)=>nativeInvoke(ready,'updateSearchIndex',[name,definition]),
    mongoWatch:(pipeline=[],opts={})=>nativeInvoke(ready,'watch',[pipeline,opts]),

    ObjectId:v=>v instanceof Mongo.ObjectId?v:new Mongo.ObjectId(v),
    stats:()=>({provider:'mongodb',name,database,url:url.replace(/\/\/([^:@/]+):([^@/]+)@/,'//$1:***@'),nativeCollectionMethods:[...MONGO_COLLECTION_METHODS]})
  };

  // A future-proof Mongo namespace: any installed-driver Collection method can be called
  // through collection.mongodb.call(name, ...args), even if Core does not know that method yet.
  adapter.mongodb={
    collection:()=>ready(),
    db:()=>state.promise.then(()=>state.db),
    client:()=>state.client,
    driver:()=>Mongo,
    startSession:(opts={})=>state.client.startSession(opts),
    call:(method,...args)=>nativeInvoke(ready,method,args),
    get:(property)=>nativeGet(ready,property),
    methods:()=>[...MONGO_COLLECTION_METHODS],
    accessors:()=>[...MONGO_COLLECTION_ACCESSORS]
  };
  return adapter;
}
module.exports={createMongoProvider,filterOf,patchOf,missingDriver,MONGO_COLLECTION_METHODS,MONGO_COLLECTION_ACCESSORS,nativeInvoke,nativeGet};
