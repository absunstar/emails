'use strict';
const path=require('path');
const {JsonCollection}=require('./collection');

function createCoreProvider({site,name,options}) {
  const production=site.options?.runtimeProfile!=='development';
  const col=new JsonCollection(name,{
    durability:options.durability ?? (production?'wal':'snapshot'),
    crashSafe:options.crashSafe ?? production,
    walSync:options.walSync ?? production,
    ...options,
    observeQuery:options.observeQuery || ((query,meta)=>site.queryShapes?.observe?.(query,meta)),
    dir:options.dir || site.options?.storage?.dir || path.join(site.cwd,'.social-browser','data')
  });
  const pass=(method,...args)=>col[method](...args);
  return {
    engine:col.engine,
    findMany:o=>pass('findMany',o),
    findOne:o=>pass('findOne',o),
    add:d=>pass('add',d),
    insertMany:d=>pass('insertMany',d),
    update:o=>pass('update',o),
    updateOne:o=>pass('updateOne',o),
    updateMany:o=>pass('updateAll',o),
    delete:o=>pass('delete',o),
    deleteOne:o=>pass('delete',o),
    deleteMany:o=>pass('deleteMany',o),
    count:o=>pass('count',o),
    aggregate:p=>pass('aggregate',p),
    distinct:async(field,o={})=>{
      const rows=await col.findMany(o);
      const vals=rows.map(row=>String(field).split('.').reduce((a,k)=>a?.[k],row));
      return [...new Set(vals)];
    },
    createIndex:(f,o)=>pass('createIndex',f,o),
    dropIndex:n=>pass('dropIndex',n),
    listIndexes:()=>pass('listIndexes'),
    transaction:x=>pass('transaction',x),
    stats:()=>pass('stats'),
    explain:o=>pass('explain',o),
    streamFast:o=>pass('streamFast',o),
    findPageFast:o=>pass('findPageFast',o),
    newCode:p=>pass('newCode',p),
    ObjectId:v=>pass('ObjectId',v),
    raw:col
  };
}
module.exports={createCoreProvider};
