'use strict';
const {assertQueryComplexity}=require('./utils');

class OrmProviderRegistry {
  constructor(site, options={}) {
    this.site=site;
    this.options=options;
    this.providers=new Map();
    this.resources=new Map();
    this.defaultProvider=String(options.provider||'core');
  }


resource(key,create){
  key=String(key);
  if(this.resources.has(key))return this.resources.get(key).value;
  const value=create();
  this.resources.set(key,{value,closed:false});
  return value;
}

async close(){
  const tasks=[];
  for(const row of this.resources.values()){
    if(row.closed)continue;
    row.closed=true;
    const value=row.value;
    if(value && typeof value.close==='function')tasks.push(Promise.resolve().then(()=>value.close()));
    else if(value && typeof value.end==='function')tasks.push(Promise.resolve().then(()=>value.end()));
  }
  await Promise.allSettled(tasks);
  this.resources.clear();
  return true;
}

  register(name, factory, meta={}) {
    name=String(name||'').trim().toLowerCase();
    if(!name)throw new Error('ORM provider name is required');
    if(typeof factory!=='function')throw new TypeError(`ORM provider "${name}" factory must be a function`);
    this.providers.set(name,{name,factory,meta:{...meta}});
    return this;
  }

  has(name){return this.providers.has(String(name||'').toLowerCase())}
  names(){return [...this.providers.keys()]}

  info(name){
    const row=this.providers.get(String(name||'').toLowerCase());
    return row?{name:row.name,...row.meta}:null;
  }

  driverStatus(name){
    const info=this.info(name);
    if(!info)return null;
    if(!info.driver)return {...info,driverInstalled:true,driverPath:null};
    let driverPath=null;
    try{driverPath=require.resolve(info.driver,{paths:[this.site.cwd,process.cwd()]})}catch{}
    return {...info,driverInstalled:!!driverPath,driverPath};
  }

  statuses(){return this.names().map(name=>this.driverStatus(name))}

  createCollection(name, options={}) {
    const providerName=String(options.provider||this.defaultProvider||'core').toLowerCase();
    const row=this.providers.get(providerName);
    if(!row){
      const e=new Error(`Unknown ORM provider: ${providerName}`);
      e.code='ORM_PROVIDER_NOT_FOUND';
      e.provider=providerName;
      throw e;
    }
    const adapter=row.factory({
      site:this.site,
      name,
      options,
      providerOptions:{
        ...(this.options.providers?.[providerName]||{}),
        ...(options.providerOptions||{})
      }
    });
    return new OrmCollection(name,providerName,adapter,options);
  }
}

class OrmCollection {
  constructor(name, provider, adapter, options={}) {
    this.name=name;
    this.provider=provider;
    this.adapter=adapter;
    this.options=options;
    this.engine=adapter.engine || null;
    this.mongodb=adapter.mongodb || null;

    // Provider-specific methods are projected onto the ORM collection without
    // overwriting provider-neutral ORM methods.
    for(const [key,value] of Object.entries(adapter)){
      if(typeof value==='function' && key.startsWith('mongo') && typeof this[key]!=='function'){
        Object.defineProperty(this,key,{value:value.bind(adapter),configurable:true,enumerable:false});
      }
    }
  }

  _raw(){return typeof this.adapter.raw==='function'?this.adapter.raw():this.adapter.raw}
  native(){return this._raw()}
  providerCall(method,...args){
    if(typeof this.adapter.native==='function')return this.adapter.native(method,...args);
    return this._cap(method,args);
  }
  providerGet(property){
    if(typeof this.adapter.nativeGet==='function')return this.adapter.nativeGet(property);
    const raw=this._raw();
    return Promise.resolve(raw).then(value=>value?.[property]);
  }
  supports(name){return typeof this.adapter[name]==='function' || typeof this._raw()?.[name]==='function'}
  _cap(name,args=[]){
    if(typeof this.adapter[name]==='function')return this.adapter[name](...args);
    const raw=this._raw();
    if(raw && typeof raw[name]==='function')return raw[name](...args);
    const e=new Error(`ORM capability "${name}" is not supported by provider "${this.provider}"`);
    e.code='ORM_CAPABILITY_UNSUPPORTED';e.provider=this.provider;e.capability=name;throw e;
  }

  _cb(value,cb){
    const p=Promise.resolve(value);
    if(typeof cb==='function'){p.then(v=>cb(null,v),e=>cb(e));return}
    return p;
  }

  ready(){return this._cb(this.adapter.ready?.() ?? true)}
  close(){return this._cb(this.adapter.close?.() ?? true)}

  findMany(options={},cb){assertQueryComplexity(options);return this._cb(this.adapter.findMany(options),cb)}
  find(options={},cb){return this.findMany(options,cb)}
  findAll(options={},cb){return this.findMany(options,cb)}
  get(options={},cb){return this.findMany(options,cb)}
  findOne(options={},cb){assertQueryComplexity(options);return this._cb(this.adapter.findOne(options),cb)}

  add(doc,cb){return this._cb(this.adapter.add(doc),cb)}
  addOne(doc,cb){return this.add(doc,cb)}
  insertMany(docs,cb){return this._cb(this.adapter.insertMany(docs),cb)}

  async bulkWrite(operations=[],options={}){
    if(typeof this.adapter.bulkWrite==='function')return this.adapter.bulkWrite(operations,options);
    const out=[];
    for(const op of operations||[]){
      if(op.insertOne)out.push(await this.add(op.insertOne.document));
      else if(op.updateOne)out.push(await this.updateOne({
        where:op.updateOne.filter||{},
        ...(op.updateOne.update?.$set?{set:op.updateOne.update.$set}:{set:op.updateOne.update}),
        upsert:!!op.updateOne.upsert
      }));
      else if(op.updateMany)out.push(await this.updateMany({
        where:op.updateMany.filter||{},
        ...(op.updateMany.update?.$set?{set:op.updateMany.update.$set}:{set:op.updateMany.update}),
        upsert:!!op.updateMany.upsert
      }));
      else if(op.deleteOne)out.push(await this.deleteOne({where:op.deleteOne.filter||{}}));
      else if(op.deleteMany)out.push(await this.deleteMany({where:op.deleteMany.filter||{}}));
      else if(op.replaceOne)out.push(await this.replaceOne(op.replaceOne.filter||{},op.replaceOne.replacement||{},op.replaceOne));
      else throw Object.assign(new Error('Unsupported bulkWrite operation'),{code:'ORM_BULK_OPERATION_UNSUPPORTED',operation:op});
    }
    return {ok:true,results:out};
  }

  async replaceOne(filter,replacement,options={}){
    if(typeof this.adapter.replaceOne==='function')return this.adapter.replaceOne(filter,replacement,options);
    const existing=await this.findOne({where:filter});
    if(existing){
      const id=existing._id??existing.id;
      const next={...replacement};
      if(next._id==null&&existing._id!=null)next._id=existing._id;
      if(next.id==null&&existing.id!=null)next.id=existing.id;
      await this.updateOne({where:existing._id!=null?{_id:existing._id}:existing.id!=null?{id:existing.id}:filter,set:next});
      return {matchedCount:1,modifiedCount:1,upsertedId:null};
    }
    if(options.upsert){
      const doc={...filter,...replacement};
      const created=await this.add(doc);
      return {matchedCount:0,modifiedCount:0,upsertedId:created._id??created.id??null};
    }
    return {matchedCount:0,modifiedCount:0,upsertedId:null};
  }

  async upsert(where,set,options={}){
    if(typeof this.adapter.upsert==='function')return this.adapter.upsert(where,set,options);
    const result=await this.updateOne({where,set,upsert:true});
    if(result?.matchedCount||result?.upsertedId)return result;
    const existing=await this.findOne({where});
    if(existing)return result;
    const created=await this.add({...where,...set});
    return {matchedCount:0,modifiedCount:0,upsertedId:created._id??created.id??null};
  }

  update(options={},cb){assertQueryComplexity(options);return this._cb(this.adapter.update(options),cb)}
  updateOne(options={},cb){return this._cb(this.adapter.updateOne?.(options) ?? this.adapter.update({...options,multi:false}),cb)}
  updateMany(options={},cb){return this._cb(this.adapter.updateMany?.(options) ?? this.adapter.update({...options,multi:true}),cb)}
  updateAll(options={},cb){return this.updateMany(options,cb)}
  edit(options={},cb){return this.update(options,cb)}

  delete(options={},cb){assertQueryComplexity(options);return this._cb(this.adapter.delete(options),cb)}
  deleteOne(options={},cb){return this._cb(this.adapter.deleteOne?.(options) ?? this.adapter.delete({...options,multi:false}),cb)}
  deleteMany(options={},cb){return this._cb(this.adapter.deleteMany?.(options) ?? this.adapter.delete({...options,multi:true}),cb)}
  removeMany(options={},cb){return this.deleteMany(options,cb)}
  deleteAll(cb){return this.deleteMany({where:{}},cb)}

  count(options={},cb){assertQueryComplexity(options);return this._cb(this.adapter.count(options),cb)}
  aggregate(pipeline=[],cb){assertQueryComplexity(pipeline);return this._cb(this.adapter.aggregate(pipeline),cb)}
  distinct(field,options={},cb){return this._cb(this.adapter.distinct?.(field,options) ?? [],cb)}

  createIndex(fields,options={}){return this._cap('createIndex',[fields,options])}
  createCompoundIndex(fields,options={}){return this.createIndex(fields,options)}
  createUnique(fields,cb){return this._cb(this.adapter.createIndex?.(fields,{unique:true}) ?? false,cb)}
  dropIndex(name){return this._cap('dropIndex',[name])}
  listIndexes(){return this._cap('listIndexes')}

  transaction(fnOrOps){return this._cb(this.adapter.transaction?.(fnOrOps) ?? Promise.reject(Object.assign(new Error(`Transactions are not supported by provider ${this.provider}`),{code:'ORM_TRANSACTION_UNSUPPORTED'})))}
  stats(){return this.adapter.stats?.() ?? this._raw()?.stats?.() ?? {provider:this.provider,name:this.name}}

relations(){return this.adapter.relations?.() ?? this.options.relations ?? {}}
relation(name){
  const rels=this.relations()||{};
  const rel=rels[name];
  if(!rel){const e=new Error(`Unknown ORM relation "${name}" on "${this.name}"`);e.code='ORM_RELATION_NOT_FOUND';throw e}
  return rel;
}
include(rows,relations,options={}){
  if(typeof this.adapter.include==='function')return this._cb(this.adapter.include(rows,relations,options));
  const e=new Error(`ORM include/join is not supported by provider "${this.provider}"`);
  e.code='ORM_RELATION_UNSUPPORTED';throw e;
}
migrate(options={}){return this._cb(this._cap('migrate',[options]))}
migrationVersion(){return this._cb(this._cap('migrationVersion'))}
health(options={}){return this.adapter.health?this._cb(this.adapter.health(options)):Promise.resolve({provider:this.provider,status:'UNKNOWN',ok:null})}

  backup(label){return this._cap('backup',[label])}
  restore(file){return this._cap('restore',[file])}
  setSchema(schema){this._cap('setSchema',[schema]);return this}
  validate(doc){return this._cap('validate',[doc])}
  createTTLIndex(field,options={}){return this._cap('createTTLIndex',[field,options])}
  purgeExpired(now){return this._cap('purgeExpired',[now])}
  createTextIndex(fields,options={}){return this._cap('createTextIndex',[fields,options])}
  searchText(query,options={}){return this._cap('searchText',[query,options])}
  integrityCheck(options={}){return this._cap('integrityCheck',[options])}
  repair(options={}){return this._cap('repair',[options])}
  checksum(){return this._cap('checksum')}
  compact(){return this._cap('compact')}
  compactTombstones(force=false){return this._cap('compactTombstones',[force])}
  deleteDuplicate(fieldOrFields,cb){return this._cb(this._cap('deleteDuplicate',[fieldOrFields]),cb)}
  explain(options={}){return this.adapter.explain?.(options) ?? this._raw()?.explain?.(options) ?? {provider:this.provider}}
  streamFast(options={}){
    if(this.adapter.streamFast)return this.adapter.streamFast(options);
    const self=this;
    return (async function*(){for(const row of await self.findMany(options))yield row})();
  }

  findManyAsync(options={}){return this.findMany(options)}
  findOneAsync(options={}){return this.findOne(options)}
  findManyParallel(options={}){return this.findMany(options)}
  findManyFast(options={}){return this.findMany(options)}
  findPageFast(options={}){
    if(this.adapter.findPageFast)return this._cb(this.adapter.findPageFast(options));
    return this.findMany(options);
  }
  findPageFastCached(options={}){return this.findPageFast(options)}

  newCode(prefix=''){return this.adapter.newCode?.(prefix) ?? `${prefix}${Date.now()}`}
  ObjectId(value){return this.adapter.ObjectId?.(value) ?? value}
}

module.exports={OrmProviderRegistry,OrmCollection};
