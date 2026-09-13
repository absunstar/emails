'use strict';

const fs=require('fs');
const path=require('path');
const crypto=require('crypto');
const {performance}=require('perf_hooks');
const {ensureDir,atomicWrite,atomicWriteDurable,getPath,matches,clone}=require('./utils');
const {SlotTable}=require('./slot-table');
const {AdaptiveStoragePlanner}=require('./adaptive-storage-planner');

class PageCache {
  constructor(maxPages=128){this.maxPages=Math.max(4,Number(maxPages)||128);this.map=new Map()}
  get(k){const v=this.map.get(k);if(v===undefined)return null;this.map.delete(k);this.map.set(k,v);return v}
  set(k,v){if(this.map.has(k))this.map.delete(k);this.map.set(k,v);while(this.map.size>this.maxPages)this.map.delete(this.map.keys().next().value)}
  clear(){this.map.clear()}
  get size(){return this.map.size}
}

class PagedStorageEngine {
  constructor(name,options={}){
    this.name=name;
    this.dir=ensureDir(options.dir||path.join(process.cwd(),'.aisite','paged'));
    this.dataFile=path.join(this.dir,`${name}.pages`);
    this.indexFile=path.join(this.dir,`${name}.pidx`);
    this.metaFile=path.join(this.dir,`${name}.pmeta.json`);
    this.walFile=path.join(this.dir,`${name}.pwal`);
    this.pageSize=Math.max(64*1024,Number(options.pageSize||1024*1024));
    this.maxPagesInMemory=Math.max(4,Number(options.maxPagesInMemory||64));
    this.cache=new PageCache(this.maxPagesInMemory);
    this.identity=options.identity!==false;
    this.objectIdStrategy=options.objectIdStrategy||'sequential';
    this.seq=0;
    this.countLive=0;
    this.slots=new SlotTable(options.slotChunkSize||1_000_000);
    this.hashIndexes=new Map(); // field -> Map(stableString -> slot)
    this.versionOffsets=new Map(); // slot -> latest appended offset
    this.versionLengths=new Map();
    this._writeQueue=Promise.resolve();
    this.writeDurability=options.writeDurability||'sync'; // sync | group
    this.crashSafe=options.crashSafe!==false;
    this.walSync=options.walSync!==false;
    this.dataEnd=0;
    this.groupCommitMs=Math.max(1,Number(options.groupCommitMs||10));
    this._groupDirty=false;
    this._groupTimer=null;
    this._txDepth=0;
    this.adaptivePlanner=new AdaptiveStoragePlanner(options.adaptiveStorage||{});
    this.adaptiveStorage=options.adaptiveStorage!==false;
    this.autoIndex=options.autoIndex===true;
    this.autoTuneEvery=Math.max(100,Number(options.autoTuneEvery||1000));
    this._adaptiveOps=0;
    this.garbageBytes=0;
    this.rangeIndexes=new Map(); // field -> {file,count,fd}
    this.indexSpecs=new Map();
    this.fd=null;
    this.bulkDepth=0;
    this.bulkDirty=false;
    this._open();
    this._loadMeta();
    this._loadIndex();
    this._recoverWal();
    for(const idx of options.indexes||[])this.createIndex(idx.fields||idx.field||idx,idx);
  }

  _open(){
    this.fd=fs.openSync(this.dataFile,'a+');
    try{this.dataEnd=fs.fstatSync(this.fd).size}catch{this.dataEnd=0}
  }
  close(){
    if(this._groupTimer){clearTimeout(this._groupTimer);this._groupTimer=null}
    if((this._groupDirty||this.bulkDirty)&&this.fd!=null)try{this.flush()}catch{}
    if(this.fd!=null){fs.closeSync(this.fd);this.fd=null}
  }
  _loadMeta(){
    try{
      const m=JSON.parse(fs.readFileSync(this.metaFile,'utf8'));
      this.seq=Number(m.seq||0);this.countLive=Number(m.countLive||0);
    }catch{}
  }
  _persistMeta(){
    (this.crashSafe?atomicWriteDurable:atomicWrite)(this.metaFile,JSON.stringify({seq:this.seq,countLive:this.countLive,pageSize:this.pageSize,slots:this.slots.length}));
  }
  _loadIndex(){
    try{this.slots=SlotTable.deserialize(fs.readFileSync(this.indexFile));this.countLive=this.slots.length-this.slots.deletedCount}catch{}
  }
  _persistIndex(){
    (this.crashSafe?atomicWriteDurable:atomicWrite)(this.indexFile,this.slots.serialize());
  }
  _appendWal(row){fs.appendFileSync(this.walFile,JSON.stringify(row)+'\n')}
  _syncWal(){
    if(!this.crashSafe||!this.walSync)return;
    let fd=null;try{fd=fs.openSync(this.walFile,'r+');fs.fsyncSync(fd)}finally{if(fd!=null)try{fs.closeSync(fd)}catch{}}
  }
  _clearWal(){
    try{
      fs.truncateSync(this.walFile,0);
      if(this.crashSafe&&this.walSync){
        let fd=null;try{fd=fs.openSync(this.walFile,'r+');fs.fsyncSync(fd)}finally{if(fd!=null)try{fs.closeSync(fd)}catch{}}
      }
    }catch{}
  }
  _recoverWal(){
    let lines=[];try{lines=fs.readFileSync(this.walFile,'utf8').split(/\r?\n/).filter(Boolean)}catch{return}
    if(!lines.length)return;
    // Data appends are already durable; WAL is used for metadata/index reconciliation.
    let changed=false;
    for(const line of lines){
      let r;try{r=JSON.parse(line)}catch{continue}
      if(r.type==='add'&&Number.isInteger(r.slot)){
        if(r.slot>=this.slots.length){this.slots.set(r.slot,r.offset,r.length);changed=true}
      }else if(r.type==='batch-add'&&Array.isArray(r.rows)){
        for(const row of r.rows||[]){
          if(!Number.isInteger(row.slot))continue;
          if(row.slot>=this.slots.length){this.slots.set(row.slot,row.offset,row.length);changed=true}
        }
      }else if(r.type==='delete'&&Number.isInteger(r.slot)){if(this.slots.markDeleted(r.slot))changed=true}
      else if(r.type==='update'&&Number.isInteger(r.slot)){
        this.slots.set(r.slot,r.offset,r.length);changed=true;
      }
    }
    if(changed){this.countLive=this.slots.length-this.slots.deletedCount;this._persistIndex();this._persistMeta()}
    this._clearWal();
  }

  _encode(doc){return Buffer.from(JSON.stringify(doc)+'\n')}
  _appendDoc(doc){
    const buf=this._encode(doc);
    const offset=this.dataEnd;
    fs.writeSync(this.fd,buf,0,buf.length,offset);
    this.dataEnd+=buf.length;
    if(this.writeDurability==='sync' && this.bulkDepth===0 && this._txDepth===0)fs.fsyncSync(this.fd);
    return {offset,length:buf.length};
  }
  _readSlot(slot){
    if(slot<0||slot>=this.slots.length||this.slots.isDeleted(slot))return null;
    const cached=this.cache.get(slot);if(cached)return clone(cached);
    const len=this.slots.getLength(slot);if(!len)return null;
    const b=Buffer.allocUnsafe(len);
    fs.readSync(this.fd,b,0,len,this.slots.getOffset(slot));
    let doc=null;try{doc=JSON.parse(b.toString('utf8').trim())}catch{return null}
    this.cache.set(slot,doc);
    return clone(doc);
  }



  _scheduleGroupCommit(){
    if(this.writeDurability!=='group')return;
    this._groupDirty=true;
    if(this._groupTimer)return;
    this._groupTimer=setTimeout(()=>{
      this._groupTimer=null;
      try{this.flush()}catch{}
    },this.groupCommitMs);
    this._groupTimer.unref?.();
  }

  _commitWriteNow(){
    fs.fsyncSync(this.fd);
    this._syncWal();
    this._persistIndex();
    this._persistMeta();
    this._clearWal();
    this._groupDirty=false;
  }

  beginBulk(){
    this.bulkDepth++;
    return this;
  }
  endBulk(){
    if(this.bulkDepth>0)this.bulkDepth--;
    if(this.bulkDepth===0&&this.bulkDirty){
      fs.fsyncSync(this.fd);
      this._syncWal();
      this._persistIndex();
      this._persistMeta();
      this._clearWal();
      this.bulkDirty=false;
    }
    return this;
  }
  flush(){
    this._commitWriteNow();
    this.bulkDirty=false;
    return this;
  }


  _enqueueWrite(fn){
    const p=this._writeQueue.then(()=>fn());
    this._writeQueue=p.catch(()=>{});
    return p;
  }

  _appendVersion(slot,doc){
    const oldLen=this.slots.getLength(slot)||0;
    const buf=this._encode(doc);
    const offset=this.dataEnd;
    fs.writeSync(this.fd,buf,0,buf.length,offset);
    this.dataEnd+=buf.length;
    if(this.writeDurability==='sync' && this._txDepth===0)fs.fsyncSync(this.fd);
    this._appendWal({type:'update',slot,offset,length:buf.length});
    this.slots.set(slot,offset,buf.length);
    this.garbageBytes+=oldLen;
    this.versionOffsets.set(slot,offset);
    this.versionLengths.set(slot,buf.length);
    this.cache.set(slot,doc);
    return {offset,length:buf.length};
  }

  addSync(doc){
    const __t0=performance.now();
    this.adaptivePlanner.observe('write',{count:this.countLive});
    this._adaptiveTick({});
    const adaptiveWrite=this.adaptiveStorage?this.explainAdaptive('write',{},{}):null;
    const previousDurability=this.writeDurability;
    if(adaptiveWrite?.durability)this.writeDurability=adaptiveWrite.durability;
    const x=clone(doc||{});
    if(x.id==null&&this.identity)x.id=++this.seq;
    if(x._id==null)x._id=this.objectIdStrategy==='random'?crypto.randomBytes(12).toString('hex'):String(this.seq).padStart(24,'0');
    const {offset,length}=this._appendDoc(x);
    const slot=this.slots.length;
    this._appendWal({type:'add',slot,offset,length});
    this.slots.set(slot,offset,length);this.countLive++;
    for(const [field,map] of this.hashIndexes){const v=getPath(x,field);if(v!==undefined)map.set(JSON.stringify(v),slot)}
    if(this.bulkDepth>0)this.bulkDirty=true;
    else if(this._txDepth>0||this.writeDurability==='group'){this._groupDirty=true;this._scheduleGroupCommit();}
    else {this._syncWal();this._persistIndex();this._persistMeta();this._clearWal();}
    const out=clone(x);
    this.adaptivePlanner.recordLatency('write',adaptiveWrite?.strategy||'sync-write',performance.now()-__t0);
    this.writeDurability=previousDurability;return out;
  }
  async add(doc){return this.addSync(doc)}

  insertManySync(docs,options={}){
    const list=[].concat(docs||[]);
    const startSlot=this.slots.length;
    const writes=[];
    let current=this.dataEnd;
    const chunks=[];
    for(const input of list){
      const x=clone(input||{});
      if(x.id==null&&this.identity)x.id=++this.seq;
      if(x._id==null)x._id=this.objectIdStrategy==='random'?crypto.randomBytes(12).toString('hex'):String(this.seq).padStart(24,'0');
      const buf=this._encode(x);
      writes.push({doc:x,offset:current,length:buf.length});
      chunks.push(buf);current+=buf.length;
    }
    if(chunks.length){
      const all=Buffer.concat(chunks);
      fs.writeSync(this.fd,all,0,all.length,this.dataEnd);
      this.dataEnd+=all.length;
      if(this.writeDurability==='sync'&&this.bulkDepth===0&&this._txDepth===0&&!options.deferPersist)fs.fsyncSync(this.fd);
    }
    if(writes.length){
      this._appendWal({type:'batch-add',rows:writes.map((w,i)=>({slot:startSlot+i,offset:w.offset,length:w.length}))});
    }
    for(let i=0;i<writes.length;i++){
      const w=writes[i],slot=startSlot+i;
      this.slots.set(slot,w.offset,w.length);
      for(const [field,map] of this.hashIndexes){const v=getPath(w.doc,field);if(v!==undefined)map.set(JSON.stringify(v),slot)}
    }
    this.countLive+=writes.length;
    if(this.bulkDepth>0||options.deferPersist)this.bulkDirty=true;
    else if(this._txDepth>0||this.writeDurability==='group'){this._groupDirty=true;this._scheduleGroupCommit();}
    else {this._syncWal();this._persistIndex();this._persistMeta();this._clearWal();}
    return options.returnDocs===false ? {done:true,count:writes.length} : writes.map(w=>clone(w.doc));
  }
  async insertMany(docs,options={}){return this.insertManySync(docs,options)}

  createIndex(field,options={}){
    const fields=[].concat(field).filter(Boolean);
    if(fields.length!==1)return {done:false,reason:'paged-engine-v1-single-field-only',fields};
    const f=fields[0];
    const map=new Map();
    for(let slot=0;slot<this.slots.length;slot++){
      if(this.slots.isDeleted(slot))continue;
      const doc=this._readSlot(slot);if(!doc)continue;
      const v=getPath(doc,f);if(v===undefined)continue;
      const key=JSON.stringify(v);
      if(options.unique&&map.has(key))throw new Error(`Unique index violation on ${f}`);
      if(options.unique)map.set(key,slot);
      else{
        let a=map.get(key);if(!a){a=[];map.set(key,a)}a.push(slot);
      }
    }
    this.hashIndexes.set(f,map);
    this.indexSpecs.set(f,{field:f,unique:!!options.unique});
    return {done:true,field:f,unique:!!options.unique};
  }
  listIndexes(){return [...this.indexSpecs.values()].map(clone)}


  _isDirectId(where){
    return Object.hasOwn(where||{},'id') && Number.isInteger(where.id) && where.id>0;
  }
  _hasHashIndex(where){
    for(const [k,v] of Object.entries(where||{})){
      if(v&&typeof v==='object')continue;
      if(this.hashIndexes.has(k))return true;
    }
    return false;
  }
  _hasRangeIndex(where){
    for(const [k,v] of Object.entries(where||{})){
      if(v&&typeof v==='object'&&['$gt','$gte','$lt','$lte'].some(op=>Object.hasOwn(v,op))){
        if(this.rangeIndexes.has(k))return true;
      }
    }
    return false;
  }

  _adaptiveTick(where={}){
    if(!this.adaptiveStorage)return;
    this._adaptiveOps++;
    this.adaptivePlanner.observeQueryFields(where);
    if(this._adaptiveOps%this.autoTuneEvery===0){
      this.adaptivePlanner.tune({count:this.countLive});
      if(this.autoIndex)this.applyAdaptiveIndexRecommendations();
    }
  }

  adaptiveIndexRecommendations(){
    return this.adaptivePlanner.recommendIndexes(new Set(this.hashIndexes.keys()),new Set(this.rangeIndexes.keys()));
  }

  applyAdaptiveIndexRecommendations(){
    const actions=[];
    for(const r of this.adaptiveIndexRecommendations()){
      try{
        if(r.type==='hash'){this.createIndex(r.field,{unique:false});actions.push({...r,applied:true})}
        else if(r.type==='range'){this.createRangeIndex(r.field);actions.push({...r,applied:true})}
      }catch(e){actions.push({...r,applied:false,error:e.message})}
    }
    return actions;
  }

  adaptiveStatus(){
    return {
      planner:this.adaptivePlanner.report(),
      recommendations:this.adaptiveIndexRecommendations(),
      operations:this._adaptiveOps,
      autoIndex:this.autoIndex
    };
  }

  explainAdaptive(op,where={},extra={}){
    const ctx={count:this.countLive,directId:this._isDirectId(where),hashIndexed:this._hasHashIndex(where),rangeIndexed:this._hasRangeIndex(where),...extra};
    if(op==='read')return this.adaptivePlanner.chooseRead(ctx);
    if(op==='write')return this.adaptivePlanner.chooseWrite(ctx);
    if(op==='update')return this.adaptivePlanner.chooseUpdate(ctx);
    if(op==='delete')return this.adaptivePlanner.chooseDelete(ctx);
    return {strategy:'unknown'};
  }

  _candidateSlots(where){
    // Dense identity shortcut: default auto IDs map directly to slot=id-1.
    if(Object.hasOwn(where,'id') && Number.isInteger(where.id) && where.id>0){
      const slot=where.id-1;
      if(slot>=0&&slot<this.slots.length&&!this.slots.isDeleted(slot))return [slot];
      return [];
    }
    const keys=Object.keys(where||{});
    for(const f of keys){
      const cond=where[f];
      if(cond&&typeof cond==='object')continue;
      const map=this.hashIndexes.get(f);
      if(!map)continue;
      const hit=map.get(JSON.stringify(cond));
      if(hit===undefined)return [];
      return Array.isArray(hit)?hit:[hit];
    }
    return null;
  }

  query(options={}){
    const where=options.where||options.filter||{};
    const __t0=performance.now();
    this.adaptivePlanner.observe('read',{count:this.countLive});
    this._adaptiveTick(where);
    if(this.adaptiveStorage){
      const plan=this.explainAdaptive('read',where);
      if(plan.strategy==='disk-range-index'){
        for(const [field,cond] of Object.entries(where)){
          if(cond&&typeof cond==='object'&&this.rangeIndexes.has(field)){
            const __out=this.queryRange(field,cond,options);
            this.adaptivePlanner.recordLatency('read','disk-range-index',performance.now()-__t0);
            return __out;
          }
        }
      }
    }
    const skip=Math.max(0,Number(options.skip||0));
    const limit=Math.max(0,Number(options.limit||0));
    const candidates=this._candidateSlots(where);
    const out=[];let seen=0;
    const iterable=candidates===null?null:candidates;
    if(iterable){
      for(const slot of iterable){
        const doc=this._readSlot(slot);if(!doc||!matches(doc,where))continue;
        if(seen++<skip)continue;out.push(doc);if(limit&&out.length>=limit)break;
      }
      const __strategy=this._isDirectId(where)?'direct-slot':this._hasHashIndex(where)?'hash-index':'bounded-scan';
      this.adaptivePlanner.recordLatency('read',__strategy,performance.now()-__t0);
      return out;
    }
    for(let slot=0;slot<this.slots.length;slot++){
      if(this.slots.isDeleted(slot))continue;
      const doc=this._readSlot(slot);if(!doc||!matches(doc,where))continue;
      if(seen++<skip)continue;out.push(doc);if(limit&&out.length>=limit)break;
    }
    this.adaptivePlanner.recordLatency('read','paged-scan',performance.now()-__t0);
    return out;
  }
  count(where={}){
    const candidates=this._candidateSlots(where);
    if(candidates!==null){
      let n=0;for(const slot of candidates){const d=this._readSlot(slot);if(d&&matches(d,where))n++}return n;
    }
    let n=0;for(let slot=0;slot<this.slots.length;slot++){if(this.slots.isDeleted(slot))continue;const d=this._readSlot(slot);if(d&&matches(d,where))n++}return n;
  }
  delete(where={},multi=false){
    const __t0=performance.now();
    this.adaptivePlanner.observe('delete',{count:this.countLive});
    this._adaptiveTick(where);
    const previousDurability=this.writeDurability;
    if(this.adaptiveStorage){
      const wp=this.adaptivePlanner.chooseWrite({count:this.countLive});
      if(wp?.durability)this.writeDurability=wp.durability;
    }
    let count=0;
    const candidates=this._candidateSlots(where);
    const iterable=candidates===null?Array.from({length:this.slots.length},(_,i)=>i):candidates;
    for(const slot of iterable){
      if(this.slots.isDeleted(slot))continue;
      const doc=this._readSlot(slot);if(!doc||!matches(doc,where))continue;
      if(this.slots.markDeleted(slot)){this.garbageBytes+=this.slots.getLength(slot)||0;}this.cache.map.delete(slot);count++;
      this._appendWal({type:'delete',slot});
      if(!multi)break;
    }
    if(count){
      this.countLive-=count;this._rebuildHashIndexes();
      if(this._txDepth>0||this.writeDurability==='group'){this._groupDirty=true;this._scheduleGroupCommit();}
      else {this._syncWal();this._persistIndex();this._persistMeta();this._clearWal();}
    }
    return {done:true,count};
  }

  async update(where={},patch={},multi=false){
    const __t0=performance.now();
    this.adaptivePlanner.observe('update',{count:this.countLive});
    this._adaptiveTick(where);
    return this._enqueueWrite(async()=>{
      const previousDurability=this.writeDurability;
      if(this.adaptiveStorage){
        const wp=this.adaptivePlanner.chooseWrite({count:this.countLive});
        if(wp?.durability)this.writeDurability=wp.durability;
      }
      const candidates=this._candidateSlots(where);
      const iterable=candidates===null?Array.from({length:this.slots.length},(_,i)=>i):candidates;
      let count=0;
      for(const slot of iterable){
        if(this.slots.isDeleted(slot))continue;
        const doc=this._readSlot(slot);if(!doc||!matches(doc,where))continue;
        const next=clone(doc);
        for(const [k,v] of Object.entries(patch||{})){
          const parts=k.split('.');let cur=next;
          for(let i=0;i<parts.length-1;i++){cur[parts[i]]??={};cur=cur[parts[i]]}
          cur[parts.at(-1)]=clone(v);
        }
        this._appendVersion(slot,next);
        count++;if(!multi)break;
      }
      if(count){
        this._rebuildHashIndexes();
        if(this._txDepth>0||this.writeDurability==='group'){this._groupDirty=true;this._scheduleGroupCommit();}
        else {this._syncWal();this._persistIndex();this._persistMeta();this._clearWal();}
      }
      const out={done:true,count};
      const __plan=this.explainAdaptive('update',where);
      this.adaptivePlanner.recordLatency('update',__plan.strategy,performance.now()-__t0);
      this.writeDurability=previousDurability;
      return out;
    });
  }

  async transaction(fnOrOps){
    const txSize=Array.isArray(fnOrOps)?fnOrOps.length:2;
    this.adaptivePlanner.observe('write',{count:this.countLive,transactionSize:txSize});
    return this._enqueueWrite(async()=>{
      this._txDepth++;
      try{
        const ops=typeof fnOrOps==='function'?null:[].concat(fnOrOps||[]);
        let result;
        if(typeof fnOrOps==='function'){
          const staged=[];
          const api={
            add:doc=>{staged.push({type:'add',doc});return doc},
            update:(where,patch,multi=false)=>{staged.push({type:'update',where,patch,multi});return {done:true}},
            delete:(where,multi=false)=>{staged.push({type:'delete',where,multi});return {done:true}}
          };
          result=await fnOrOps(api);
          for(const op of staged)await this._applyTxOp(op);
        }else{
          result=[];
          for(const op of ops)result.push(await this._applyTxOp(op));
        }
        this._txDepth--;
        this._commitWriteNow();
        return result;
      }catch(e){
        this._txDepth=Math.max(0,this._txDepth-1);
        throw e;
      }
    });
  }

  async _applyTxOp(op){
    if(op.type==='add')return this.addSync(op.doc);
    if(op.type==='update'){
      const candidates=this._candidateSlots(op.where||{});
      const iterable=candidates===null?Array.from({length:this.slots.length},(_,i)=>i):candidates;
      let count=0;
      for(const slot of iterable){
        if(this.slots.isDeleted(slot))continue;
        const doc=this._readSlot(slot);if(!doc||!matches(doc,op.where||{}))continue;
        const next=clone(doc);
        for(const [k,v] of Object.entries(op.patch||{}))next[k]=clone(v);
        this._appendVersion(slot,next);count++;if(!op.multi)break;
      }
      return {done:true,count};
    }
    if(op.type==='delete')return this.delete(op.where||{},!!op.multi);
    throw new Error(`Unknown transaction op: ${op.type}`);
  }

  queryPage(options={}){
    const page=Math.max(1,Number(options.page||1));
    const limit=Math.max(1,Number(options.limit||20));
    const where=options.where||{};
    const list=this.query({where,skip:(page-1)*limit,limit});
    const total=this.count(where);
    return {list,page,limit,total,pages:Math.ceil(total/limit)};
  }

  _rebuildHashIndexes(){
    const specs=[...this.indexSpecs.values()];
    this.hashIndexes.clear();this.indexSpecs.clear();
    for(const s of specs)this.createIndex(s.field,{unique:s.unique});
  }

  createRangeIndex(field,options={}){
    const file=path.join(this.dir,`${this.name}.${String(field).replace(/[^a-zA-Z0-9_.-]/g,'_')}.prange`);
    const pairs=[];
    for(let slot=0;slot<this.slots.length;slot++){
      if(this.slots.isDeleted(slot))continue;
      const doc=this._readSlot(slot);if(!doc)continue;
      const v=Number(getPath(doc,field));
      if(!Number.isFinite(v))continue;
      pairs.push([v,slot]);
    }
    pairs.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
    const b=Buffer.allocUnsafe(8+pairs.length*12);
    b.writeBigUInt64LE(BigInt(pairs.length),0);
    let off=8;
    for(const [v,slot] of pairs){b.writeDoubleLE(v,off);off+=8;b.writeUInt32LE(slot,off);off+=4}
    atomicWrite(file,b);
    const fd=fs.openSync(file,'r');
    this.rangeIndexes.set(field,{file,count:pairs.length,fd});
    return {done:true,field,count:pairs.length,file};
  }

  _rangeReadValue(idx,pos){
    const b=Buffer.allocUnsafe(8);
    fs.readSync(idx.fd,b,0,8,8+pos*12);
    return b.readDoubleLE(0);
  }

  _rangeLowerBound(idx,value,inclusive=true){
    let lo=0,hi=idx.count;
    while(lo<hi){
      const mid=(lo+hi)>>1,v=this._rangeReadValue(idx,mid);
      if(v<value||(!inclusive&&v===value))lo=mid+1;else hi=mid;
    }
    return lo;
  }

  _rangeUpperBound(idx,value,inclusive=true){
    let lo=0,hi=idx.count;
    while(lo<hi){
      const mid=(lo+hi)>>1,v=this._rangeReadValue(idx,mid);
      if(v<value||(inclusive&&v===value))lo=mid+1;else hi=mid;
    }
    return lo;
  }

  queryRange(field,cond={},options={}){
    let idx=this.rangeIndexes.get(field);
    if(!idx){
      const file=path.join(this.dir,`${this.name}.${String(field).replace(/[^a-zA-Z0-9_.-]/g,'_')}.prange`);
      try{
        const fd=fs.openSync(file,'r'),head=Buffer.allocUnsafe(8);fs.readSync(fd,head,0,8,0);
        idx={file,fd,count:Number(head.readBigUInt64LE(0))};this.rangeIndexes.set(field,idx);
      }catch{return []}
    }
    let start=0,end=idx.count;
    if(Object.hasOwn(cond,'$gt'))start=this._rangeLowerBound(idx,Number(cond.$gt),false);
    else if(Object.hasOwn(cond,'$gte'))start=this._rangeLowerBound(idx,Number(cond.$gte),true);
    if(Object.hasOwn(cond,'$lt'))end=this._rangeUpperBound(idx,Number(cond.$lt),false);
    else if(Object.hasOwn(cond,'$lte'))end=this._rangeUpperBound(idx,Number(cond.$lte),true);
    const skip=Math.max(0,Number(options.skip||0)),limit=Math.max(0,Number(options.limit||0));
    const out=[];let seen=0;
    const row=Buffer.allocUnsafe(12);
    for(let i=start;i<end;i++){
      fs.readSync(idx.fd,row,0,12,8+i*12);
      const slot=row.readUInt32LE(8);
      if(this.slots.isDeleted(slot))continue;
      if(seen++<skip)continue;
      const doc=this._readSlot(slot);if(doc)out.push(doc);
      if(limit&&out.length>=limit)break;
    }
    return out;
  }

  compactPaged(){
    const tmp=this.dataFile+'.compact.tmp';
    const fd=fs.openSync(tmp,'w');
    let offset=0,live=0;
    const newSlots=new SlotTable(this.slots.chunkSize);
    for(let slot=0;slot<this.slots.length;slot++){
      if(this.slots.isDeleted(slot))continue;
      const doc=this._readSlot(slot);if(!doc)continue;
      const buf=this._encode(doc);
      fs.writeSync(fd,buf,0,buf.length,offset);
      newSlots.set(slot,offset,buf.length);
      offset+=buf.length;live++;
    }
    fs.fsyncSync(fd);fs.closeSync(fd);
    this.close();
    fs.renameSync(tmp,this.dataFile);
    this.fd=fs.openSync(this.dataFile,'a+');
    this.dataEnd=offset;
    // preserve logical slot count/deletions; compacted live slots retain original slot IDs.
    for(let slot=0;slot<this.slots.length;slot++){
      if(this.slots.isDeleted(slot)){
        if(slot>=newSlots.length)newSlots.set(slot,0,0);
        newSlots.markDeleted(slot);
      }
    }
    this.slots=newSlots;
    this.countLive=live;
    this.garbageBytes=0;
    this.cache.clear();
    this.versionOffsets.clear();this.versionLengths.clear();
    this._persistIndex();this._persistMeta();this._clearWal();
    for(const x of this.rangeIndexes.values())try{fs.closeSync(x.fd)}catch{}
    this.rangeIndexes.clear();
    return {done:true,documents:live,dataBytes:offset};
  }

  stats(){
    let dataBytes=0,indexBytes=0,walBytes=0;
    try{dataBytes=fs.statSync(this.dataFile).size}catch{}
    try{indexBytes=fs.statSync(this.indexFile).size}catch{}
    try{walBytes=fs.statSync(this.walFile).size}catch{}
    return {name:this.name,mode:'paged',crashSafe:this.crashSafe,walSync:this.walSync,dataEnd:this.dataEnd,documents:this.countLive,slots:this.slots.length,deleted:this.slots.deletedCount,
      dataBytes,indexBytes,walBytes,pageSize:this.pageSize,cachePages:this.cache.size,maxPagesInMemory:this.maxPagesInMemory,indexes:this.listIndexes(),objectIdStrategy:this.objectIdStrategy,versionedSlots:this.versionOffsets.size,garbageBytes:this.garbageBytes,rangeIndexes:[...this.rangeIndexes.keys()],writeDurability:this.writeDurability,groupCommitMs:this.groupCommitMs,groupDirty:this._groupDirty,adaptiveStorage:this.adaptiveStorage,adaptivePlanner:this.adaptivePlanner.report(),adaptiveStatus:this.adaptiveStatus()};
  }
}

module.exports={PagedStorageEngine};
