'use strict';

const { StorageEngine } = require('./storage-engine');
const { PagedStorageEngine } = require('./paged-storage-engine');

class JsonCollection {
  constructor(name, options = {}) {
    this.name = name;
    this.observeQuery = typeof options.observeQuery === 'function' ? options.observeQuery : null;
    this.engine = options.storageMode==='paged' ? new PagedStorageEngine(name,options) : new StorageEngine(name, options);
  }

  _cb(p, callback) {
    if (typeof callback === 'function') {
      p.then(r=>callback(null,r),e=>callback(e));
      return;
    }
    return p;
  }

  findMany(options={}, callback) {
    this.observeQuery?.(options,{op:'findMany',collection:this.name});
    return this._cb(Promise.resolve(this.engine.query(options)),callback);
  }
  find(options={}, cb){ return this.findMany(options,cb); }
  findAll(options={}, cb){ return this.findMany(options,cb); }
  get(options={}, cb){ return this.findMany(options,cb); }

  findOne(options={}, callback) {
    this.observeQuery?.(options,{op:'findOne',collection:this.name});
    return this._cb(Promise.resolve(this.engine.query({...options,limit:1})[0] || null),callback);
  }

  add(doc, callback){ return this._cb(this.engine.add(doc),callback); }
  addOne(doc, cb){ return this.add(doc,cb); }
  insertMany(docs, callback){
    const p=this.engine.insertMany ? this.engine.insertMany(docs) : this.engine.transaction((tx)=>Promise.resolve((docs||[]).map(d=>tx.add(d))));
    return this._cb(Promise.resolve(p),callback);
  }

  update(options={}, callback){
    const where = options.where || (options._id ? {_id:options._id} : options.id!=null ? {id:options.id} : {});
    const patch = options.set || options.data || options.doc || Object.fromEntries(Object.entries(options).filter(([k])=>!['where','_id','id','set','data','doc','multi'].includes(k)));
    return this._cb(this.engine.update(where,patch,!!options.multi),callback);
  }
  updateOne(o={},cb){ return this.update({...o,multi:false},cb); }
  updateAll(o={},cb){ return this.update({...o,multi:true},cb); }
  edit(o={},cb){ return this.update(o,cb); }

  delete(options={}, callback){
    const where = options.where || Object.fromEntries(Object.entries(options).filter(([k])=>k!=='multi'));
    return this._cb(this.engine.delete(where,!!options.multi),callback);
  }
  deleteMany(o={},cb){ return this.delete({...o,multi:true},cb); }
  removeMany(o={},cb){ return this.deleteMany(o,cb); }
  deleteAll(callback){ return this.deleteMany({where:{}},callback); }
  async deleteDuplicate(fieldOrFields, callback){
    const fields=[].concat(fieldOrFields || '_id');
    const seen=new Set();
    const dupIds=[];
    for(const doc of this.engine.docs){
      const key=JSON.stringify(fields.map(f=>require('./utils').getPath(doc,f)));
      if(seen.has(key)) dupIds.push(doc._id);
      else seen.add(key);
    }
    const p=this.engine.transaction(async tx=>{
      let count=0;
      for(const _id of dupIds){ const r=tx.delete({_id},false); count+=r.count; }
      return {done:true,count};
    });
    return this._cb(Promise.resolve(p),callback);
  }

  count(options={}){ return Promise.resolve(this.engine.count(options.where || options)); }

  aggregate(pipeline=[], callback){
    const p=Promise.resolve().then(()=>require('./utils').aggregateDocs(this.engine.query({}),pipeline));
    return this._cb(p,callback);
  }

  createIndex(field, options={}){ return this.engine.createIndex(field,options); }
  createCompoundIndex(fields, options={}){ return this.engine.createIndex(fields,options); }
  createUnique(field, callback){
    const p = Promise.resolve(this.engine.createIndex(field,{unique:true}));
    return this._cb(p,callback);
  }
  dropIndex(field){ return this.engine.dropIndex(field); }
  listIndexes(){ return this.engine.listIndexes(); }
  explain(options={}){ return this.engine.explain(options.where || options); }

  backup(label){ return this.engine.backup(label); }
  restore(file){ return this.engine.restore(file); }
  stats(){ return this.engine.stats(); }
  setSchema(schema){ this.engine.setSchema(schema); return this; }
  validate(doc){ return this.engine.validate(doc); }
  createTTLIndex(field,options={}){ return this.engine.createTTLIndex(field,options); }
  purgeExpired(now){ return this.engine.purgeExpired(now); }
  createTextIndex(fields,options={}){ return this.engine.createTextIndex(fields,options); }
  searchText(query,options={}){ return this.engine.searchText(query,options); }
  integrityCheck(options={}){ return this.engine.integrityCheck(options); }
  repair(options={}){ return this.engine.repair(options); }
  checksum(){ return this.engine.checksum(); }
  compact(){ return this.engine.compact(); }
  compactTombstones(force=false){ return this.engine.compactTombstones(force); }
  transaction(fnOrOps){ if(!this.engine.transaction) throw new Error('Transactions are not yet available in paged storage mode'); return this.engine.transaction(fnOrOps); }
  streamFast(options={}){ if(this.engine.stream)return this.engine.stream(options); const self=this; return (async function*(){for(const x of self.engine.query(options))yield x})(); }

  newCode(prefix=''){
    this.engine.seq++;
    this.engine._persist();
    return `${prefix}${this.engine.seq}`;
  }
  ObjectId(value){ return value || require('./utils').randomId(12); }


  findManyAsync(options={}){ return this.findMany(options); }
  findOneAsync(options={}){ return this.findOne(options); }
  findManyParallel(options={}){ return this.findMany(options); }
  findManyFast(options={}){ return this.findMany(options); }
  async findPageFast(options={}){ return this.engine.queryPage(options); }
  findPageFastCached(options={}){ return this.findPageFast(options); }
}

module.exports = { JsonCollection };
