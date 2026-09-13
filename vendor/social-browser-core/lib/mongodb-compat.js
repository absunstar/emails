'use strict';
const {randomId}=require('./utils');
function createMongoCompat(site){
  const api={
    connection:'aisite-json',
    collections_indexed:[], collectionIndex:Object.create(null), databaseIndex:Object.create(null),
    collectionInflight:Object.create(null), databaseInflight:Object.create(null),
    connectCollectionBusy:false,connectDBBusy:false,closeDbBusy:false,
    callback(){},
    ObjectID(v){return v||randomId(12)},
    get ObjectId(){return api.ObjectID},
    connectCollection:(name,opts)=>site.connectCollection(name,opts),
    connectDB:async()=>api,
    find:(c,o,cb)=>wrap(c.findMany(o),cb),
    findMany:(c,o,cb)=>wrap(c.findMany(o),cb),
    findManyFast:(c,o,cb)=>wrap(c.findManyFast(o),cb),
    findManyConcurrent:(c,o,cb)=>wrap(c.findManyParallel(o),cb),
    findOne:(c,o,cb)=>wrap(c.findOne(o),cb),
    findPageFast:(c,o,cb)=>wrap(c.findPageFast(o),cb),
    findByIdsFast:(c,ids,cb)=>wrap(c.findMany({where:{id:{$in:ids}}}),cb),
    findCursorFast:(c,o)=>c.streamFast(o),
    insert:(c,d,cb)=>wrap(c.insertMany([].concat(d)),cb),
    insertMany:(c,d,cb)=>wrap(c.insertMany(d),cb),
    insertOne:(c,d,cb)=>wrap(c.add(d),cb),
    update:(c,o,cb)=>wrap(c.update({...o,multi:true}),cb),
    updateMany:(c,o,cb)=>wrap(c.update({...o,multi:true}),cb),
    updateOne:(c,o,cb)=>wrap(c.update({...o,multi:false}),cb),
    delete:(c,o,cb)=>wrap(c.deleteMany(o),cb),
    deleteMany:(c,o,cb)=>wrap(c.deleteMany(o),cb),
    deleteOne:(c,o,cb)=>wrap(c.delete({...o,multi:false}),cb),
    count:(c,o,cb)=>wrap(c.count(o),cb),
    aggregate:(c,p,cb)=>wrap(c.aggregate(p),cb),
    createIndex:(c,f,opts)=>c.createIndex(f,opts),
    dropIndex:(c,f)=>c.dropIndex(f),
    dropIndexes:(c)=>{for(const i of c.listIndexes())c.dropIndex(i.fields||i.field);return true},
    dropCollection:async(c)=>{await c.deleteAll();return true},
    distinct:async(c,field,o={})=>[...new Set((await c.findMany(o)).map(x=>field.split('.').reduce((a,k)=>a?.[k],x)))],
    explainQuery:(c,o)=>c.explain(o),
    bulkWriteFast:async(c,ops=[])=>c.transaction(ops),
    handleDoc:d=>d,
    invalidateQueryCache:()=>true,invalidateWriteCaches:()=>true,
    observeQuery:()=>null,telemetryStart:()=>performance.now(),telemetryEnd:()=>0
  };
  function wrap(p,cb){p=Promise.resolve(p);if(typeof cb==='function'){p.then(x=>cb(null,x),e=>cb(e));return}return p}
  return api;
}
module.exports={createMongoCompat};
