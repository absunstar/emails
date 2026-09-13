'use strict';

const fs = require('fs');
const path = require('path');
const { ensureDir, atomicWrite, atomicWriteDurable, clone, getPath, setPath, matches, sortDocs, projectDoc, randomId, sha256 } = require('./utils');
const { validate, assertValid } = require('./schema');

function stableKey(v) {
  if (v === undefined) return 'u:';
  if (v === null) return 'n:';
  if (typeof v === 'string') return 's:' + v;
  if (typeof v === 'number') return 'd:' + v;
  if (typeof v === 'boolean') return 'b:' + (v ? 1 : 0);
  return 'j:' + JSON.stringify(v);
}

function comparePrimitive(a,b) {
  if (a === b) return 0;
  if (a === undefined) return -1;
  if (b === undefined) return 1;
  if (a === null) return -1;
  if (b === null) return 1;
  return a < b ? -1 : 1;
}

function compareBySort(a,b,sort){
  const entries=Array.isArray(sort)?sort:Object.entries(sort||{}).map(([key,dir])=>[key,Number(dir)<0?-1:1]);
  for(const [key,dirRaw] of entries){
    const dir=Number(dirRaw)<0?-1:1;
    const c=comparePrimitive(getPath(a,key),getPath(b,key));
    if(c)return c*dir;
  }
  return 0;
}

class StorageEngine {
  constructor(name, options = {}) {
    this.name = name;
    this.cwd = path.resolve(options.cwd || process.cwd());
    const requestedDir=options.dir
      ? (path.isAbsolute(options.dir)?path.resolve(options.dir):path.resolve(this.cwd,options.dir))
      : path.join(this.cwd,'.social-browser','data');
    this.dir = ensureDir(requestedDir);
    this.file = path.join(this.dir, `${name}.json`);
    this.walFile = path.join(this.dir, `${name}.wal`);
    this.backupDir = ensureDir(path.join(this.dir, '_backup'));
    this.identity = options.identity !== false;
    this.docs = [];
    this.seq = 0;
    this.indexSpecs = new Map();
    this.indexes = new Map();
    this._queue = Promise.resolve();
    this._dirtyOps = 0;
    this.compactEvery = Number(options.compactEvery || 500);
    this.durability = options.durability || 'snapshot'; // snapshot | wal
    this.crashSafe = options.crashSafe !== false;
    this.walSync = options.walSync !== false;
    this.walSeq = 0;
    this.checkpointSeq = 0;
    this.walCompactEvery = Math.max(1,Number(options.walCompactEvery || this.compactEvery || 500));
    this.tombstones = 0;
    this.tombstoneMode = options.tombstoneMode !== false;
    this.tombstoneCompactRatio = Math.max(0.01,Number(options.tombstoneCompactRatio || 0.20));
    this.schema = options.schema || null;
    this.schemaVersion = Number(options.schemaVersion || 1);
    this.migrations = Array.isArray(options.migrations) ? options.migrations : [];
    this.ttlIndexes = new Map();
    this.textIndexes = new Map();
    this.metaFile = path.join(this.dir, `${name}.meta.json`);
    this.indexSnapshotFile = path.join(this.dir, `${name}.indexes.json`);
    this.persistIndexes = options.persistIndexes === true;
    this.highScale = options.highScale === true;
    this.lazyIndexes = options.lazyIndexes === true || this.highScale;
    this.indexLoaded = new Set();
    this.compactIndexes = options.compactIndexes === true || this.highScale;
    this.lazySortedIndexes = options.lazySortedIndexes === true || this.compactIndexes || this.highScale;
    this.packedSortedIndexes = options.packedSortedIndexes === true || this.highScale;
    this.typedSortedPositions = options.typedSortedPositions === true || this.highScale;

    this._load();
    this._recoverWal();
    for (const idx of options.indexes || []) this.createIndex(idx.fields || idx.field || idx, idx);
    for (const idx of options.ttlIndexes || []) this.createTTLIndex(idx.field || idx, idx);
    for (const idx of options.textIndexes || []) this.createTextIndex(idx.fields || idx.field || idx, idx);
    this._runMigrations();

  }

  _load() {
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.docs = Array.isArray(data.docs) ? data.docs : [];
      this.tombstones = this.docs.reduce((n,d)=>n+(d&&d.__aisiteDeleted===true?1:0),0);
      this.seq = Number(data.seq || 0);
      this.checkpointSeq = Number(data.checkpointSeq || data.walSeq || 0);
      this.walSeq = this.checkpointSeq;
    } catch { this.docs = []; this.seq = 0; }
  }

  _persist() {
    const payload=JSON.stringify({seq:this.seq,checkpointSeq:this.checkpointSeq,walSeq:this.walSeq,docs:this.docs});
    (this.crashSafe?atomicWriteDurable:atomicWrite)(this.file,payload);
  }

  _appendWal(row) {
    fs.appendFileSync(this.walFile, JSON.stringify(row) + '\n');
  }
  _syncWal(){
    if(!this.crashSafe||!this.walSync)return;
    let fd=null;try{fd=fs.openSync(this.walFile,'r+');fs.fsyncSync(fd)}finally{if(fd!=null)try{fs.closeSync(fd)}catch{}}
  }

  _clearWal() {
    try {
      fs.truncateSync(this.walFile, 0);
      if(this.crashSafe&&this.walSync){
        let fd=null;try{fd=fs.openSync(this.walFile,'r+');fs.fsyncSync(fd)}finally{if(fd!=null)try{fs.closeSync(fd)}catch{}}
      }
    } catch {}
  }

  _applyOp(op) {
    if (op.type === 'add') {
      this.docs.push(clone(op.doc));
      if (op.doc?.id != null) this.seq = Math.max(this.seq, Number(op.doc.id) || 0);
      return;
    }
    if (op.type === 'update') {
      let count=0;
      for (const doc of this.docs) {
        if (!matches(doc, op.where || {})) continue;
        for (const [k,v] of Object.entries(op.patch || {})) setPath(doc,k,clone(v));
        count++;
        if (!op.multi) break;
      }
      return;
    }
    if (op.type === 'delete') {
      let removed=0;
      if(this.tombstoneMode){
        for(const doc of this.docs){
          if(!doc || doc.__aisiteDeleted===true) continue;
          if(matches(doc,op.where||{}) && (op.multi || removed===0)){
            doc.__aisiteDeleted=true; removed++; this.tombstones++;
            if(!op.multi)break;
          }
        }
      }else{
        this.docs = this.docs.filter(doc=>{
          if (matches(doc,op.where||{}) && (op.multi || removed===0)) { removed++; return false; }
          return true;
        });
      }
    }
  }

  _recoverWal() {
    let lines;
    try { lines = fs.readFileSync(this.walFile,'utf8').split(/\r?\n/).filter(Boolean); }
    catch { return; }
    if (!lines.length) return;

    const txs = new Map();
    for (const line of lines) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (!row.txid) continue;
      if (!txs.has(row.txid)) txs.set(row.txid, []);
      txs.get(row.txid).push(row);
    }
    let changed = false,maxApplied=this.checkpointSeq,syntheticSeq=0;
    for (const rows of txs.values()) {
      const committed = rows.some(r=>r.type==='commit');
      if (!committed) continue;
      let txseq=Math.max(0,...rows.map(r=>Number(r.txseq||0)));
      if(!txseq)txseq=++syntheticSeq;
      if(txseq<=this.checkpointSeq)continue;
      for (const row of rows) {
        if (row.type === 'op' && row.op) this._applyOp(row.op);
      }
      changed = true;
      if(txseq>maxApplied)maxApplied=txseq;
    }
    if (changed){
      this.walSeq=Math.max(this.walSeq,maxApplied);
      this.checkpointSeq=Math.max(this.checkpointSeq,maxApplied);
      this._persist();
    }
    this._clearWal();
  }


  setSchema(schema) { this.schema = schema || null; return this; }
  validate(doc) { return validate(this.schema, doc); }

  _runMigrations() {
    let current = 1;
    try {
      const meta = JSON.parse(fs.readFileSync(this.metaFile,'utf8'));
      current = Number(meta.schemaVersion || 1);
    } catch {}
    const target = this.schemaVersion;
    if (current > target) throw new Error(`Storage schema ${current} is newer than supported ${target}`);
    if (current === target) return;

    const ordered = [...this.migrations].sort((a,b)=>Number(a.version)-Number(b.version));
    for (const migration of ordered) {
      const version = Number(migration.version);
      if (version <= current || version > target) continue;
      if (typeof migration.up !== 'function') throw new Error(`Migration ${version} has no up() function`);
      const result = migration.up(this.docs.map(clone));
      if (Array.isArray(result)) this.docs = result;
      current = version;
      this._persist();
    }
    atomicWrite(this.metaFile, JSON.stringify({schemaVersion:current}));
  }

  createTTLIndex(field, options={}) {
    if (!field) throw new Error('TTL field is required');
    const expireAfterMs = Number(options.expireAfterMs || options.ttlMs || 0);
    this.ttlIndexes.set(field,{field,expireAfterMs});
    return {done:true,field,expireAfterMs};
  }

  purgeExpired(now=Date.now()) {
    if (!this.ttlIndexes.size) return {done:true,count:0};
    const before=this.docs.length;
    this.docs=this.docs.filter(doc=>{
      for(const spec of this.ttlIndexes.values()){
        const raw=getPath(doc,spec.field);
        if(raw==null) continue;
        const base = typeof raw === 'number' ? raw : Date.parse(raw);
        if(!Number.isFinite(base)) continue;
        if(base + spec.expireAfterMs <= now) return false;
      }
      return true;
    });
    const count=before-this.docs.length;
    if(count){ this._rebuildIndexes(); this._rebuildTextIndexes(); this._persist(); }
    return {done:true,count};
  }

  createTextIndex(fields, options={}) {
    fields=[].concat(fields).filter(Boolean);
    if(!fields.length) throw new Error('Text index field is required');
    const id=fields.join('|');
    this.textIndexes.set(id,{id,fields,caseSensitive:!!options.caseSensitive,map:new Map()});
    this._buildTextIndex(id);
    return {done:true,id,fields};
  }

  _tokenize(text, caseSensitive=false) {
    const s = caseSensitive ? String(text||'') : String(text||'').toLowerCase();
    return s.normalize('NFKC').split(/[^\p{L}\p{N}_]+/u).filter(Boolean);
  }

  _buildTextIndex(id) {
    const spec=this.textIndexes.get(id);
    if(!spec) return;
    const map=new Map();
    for(let i=0;i<this.docs.length;i++){
      const doc=this.docs[i];
      if(!doc || doc.__aisiteDeleted===true) continue;
      const tokens=new Set();
      for(const field of spec.fields) for(const t of this._tokenize(getPath(doc,field),spec.caseSensitive)) tokens.add(t);
      for(const t of tokens){
        if(!map.has(t)) map.set(t,new Set());
        map.get(t).add(i);
      }
    }
    spec.map=map;
  }

  _rebuildTextIndexes(){ for(const id of this.textIndexes.keys()) this._buildTextIndex(id); }

  searchText(query, options={}) {
    const id = options.index || [...this.textIndexes.keys()][0];
    const spec=this.textIndexes.get(id);
    if(!spec) return [];
    const tokens=this._tokenize(query,spec.caseSensitive);
    if(!tokens.length) return [];
    let positions=null;
    for(const token of tokens){
      const set=spec.map.get(token)||new Set();
      positions = positions===null ? new Set(set) : new Set([...positions].filter(x=>set.has(x)));
    }
    let list=[...(positions||[])].map(i=>this.docs[i]).filter(Boolean).map(clone);
    if(options.limit>0) list=list.slice(0,Number(options.limit));
    return list;
  }

  integrityCheck(options={}) {
    const issues=[];
    const ids=new Set();
    for(let i=0;i<this.docs.length;i++){
      const doc=this.docs[i];
      if(!doc || typeof doc!=='object' || Array.isArray(doc)) issues.push({type:'invalid-document',position:i});
      const id=doc?._id;
      if(id!=null){
        if(ids.has(id)) issues.push({type:'duplicate-_id',_id:id});
        ids.add(id);
      }
      if(this.schema){
        const r=validate(this.schema,doc);
        if(!r.valid) issues.push({type:'schema',position:i,errors:r.errors});
      }
    }
    for(const spec of this.indexSpecs.values()){
      try{ this._buildIndex(spec.id); }catch(e){ issues.push({type:'index',index:spec.id,error:e.message}); }
    }
    return {ok:issues.length===0,issues,documents:this.docs.length,checksum:this.checksum()};
  }

  repair(options={}) {
    let changed=false;
    const seen=new Set();
    this.docs=this.docs.filter(doc=>{
      if(!doc || typeof doc!=='object' || Array.isArray(doc)){ changed=true; return false; }
      if(doc._id==null){ doc._id=randomId(12); changed=true; }
      if(seen.has(doc._id)){ doc._id=randomId(12); changed=true; }
      seen.add(doc._id);
      if(this.schema && options.dropInvalid===true && !validate(this.schema,doc).valid){ changed=true; return false; }
      return true;
    });
    this._rebuildIndexes(); this._rebuildTextIndexes();
    if(changed || options.force) this._persist();
    return {done:true,changed,documents:this.docs.length,integrity:this.integrityCheck()};
  }

  checksum() {
    return sha256(JSON.stringify({seq:this.seq,docs:this.docs}));
  }

  _specId(fields) { return [].concat(fields).join('|'); }

  createIndex(fields, options = {}) {
    fields = [].concat(fields).filter(Boolean);
    if (!fields.length) throw new Error('Index field is required');
    const id = this._specId(fields);
    this.indexSpecs.set(id, {id, fields, unique:!!options.unique, range:options.range !== false});

    if(this.persistIndexes && this._loadIndexSnapshot(id)){
      this.indexLoaded.add(id);
      return clone(this.indexSpecs.get(id));
    }

    if(options.lazy===false || this.lazyIndexes===false){
      this._buildIndex(id);
      this.indexLoaded.add(id);
    }
    return clone(this.indexSpecs.get(id));
  }


  _dataSignature() {
    try{
      const st=fs.statSync(this.file);
      return {size:st.size,mtimeMs:Math.floor(st.mtimeMs),docs:this.docs.length,seq:this.seq};
    }catch{
      return {size:0,mtimeMs:0,docs:this.docs.length,seq:this.seq};
    }
  }

  _readIndexSnapshotFile(){
    if(this._indexSnapshotCache!==undefined)return this._indexSnapshotCache;
    try{
      const raw=JSON.parse(fs.readFileSync(this.indexSnapshotFile,'utf8'));
      const sig=this._dataSignature();
      const x=raw.signature||{};
      if(x.size!==sig.size || x.mtimeMs!==sig.mtimeMs || x.docs!==sig.docs || x.seq!==sig.seq){
        this._indexSnapshotCache=null;
        return null;
      }
      this._indexSnapshotCache=raw;
      return raw;
    }catch{
      this._indexSnapshotCache=null;
      return null;
    }
  }

  _loadIndexSnapshot(id){
    const raw=this._readIndexSnapshotFile();
    const snap=raw?.indexes?.[id];
    if(!snap)return false;
    const spec=this.indexSpecs.get(id);
    if(!spec || JSON.stringify(spec.fields)!==JSON.stringify(snap.fields) || !!spec.unique!==!!snap.unique)return false;
    try{
      const buckets=new Map();
      for(const [key,positions] of snap.buckets||[]){
        buckets.set(key,Array.isArray(positions)?new Set(positions):positions);
      }
      const packed=!!(snap.sorted&&snap.sorted.packed);
      const sorted=packed?(snap.sorted.typed?Uint32Array.from(snap.sorted.positions):snap.sorted.positions):(Array.isArray(snap.sorted)?snap.sorted.map(x=>({values:x[0],pos:x[1]})):null);
      this.indexes.set(id,{buckets,sorted,sortedPacked:packed,sortedTyped:!!(packed&&snap.sorted?.typed)});
      return true;
    }catch{return false}
  }

  _ensureIndex(id){
    if(this.indexes.has(id))return this.indexes.get(id);
    if(this.persistIndexes && this._loadIndexSnapshot(id)){
      this.indexLoaded.add(id);
      return this.indexes.get(id);
    }
    this._buildIndex(id);
    this.indexLoaded.add(id);
    return this.indexes.get(id);
  }

  _saveIndexSnapshots(){
    if(!this.persistIndexes || !this.indexSpecs.size)return false;
    const indexes={};
    for(const spec of this.indexSpecs.values()){
      const idx=this._ensureIndex(spec.id);
      indexes[spec.id]={
        fields:spec.fields,
        unique:spec.unique,
        range:spec.range,
        buckets:[...idx.buckets.entries()].map(([k,setOrPos])=>[k,setOrPos instanceof Set?[...setOrPos]:setOrPos]),
        sorted:idx.sorted?(idx.sortedPacked?{packed:true,typed:idx.sorted instanceof Uint32Array,positions:Array.from(idx.sorted)}:idx.sorted.map(row=>[row.values,row.pos])):null
      };
    }
    const payload={signature:this._dataSignature(),indexes};
    atomicWrite(this.indexSnapshotFile,JSON.stringify(payload));
    this._indexSnapshotCache=payload;
    return true;
  }

  _invalidateIndexSnapshot(){
    this._indexSnapshotCache=undefined;
    try{fs.unlinkSync(this.indexSnapshotFile)}catch{}
  }

  dropIndex(fields) {
    const id = this._specId(fields);
    this.indexSpecs.delete(id); this.indexes.delete(id); this.indexLoaded.delete(id); this._invalidateIndexSnapshot();
    return {done:true,id};
  }

  listIndexes(){ return [...this.indexSpecs.values()].map(clone); }

  _buildIndex(id) {
    const spec = this.indexSpecs.get(id);
    const buckets = new Map();
    const sorted = this.lazySortedIndexes ? null : [];
    for (let i=0;i<this.docs.length;i++) {
      const doc = this.docs[i];
      if(!doc || doc.__aisiteDeleted===true) continue;
      const values = spec.fields.map(f=>getPath(doc,f));
      const key = values.map(stableKey).join('\x1f');

      if(spec.unique && this.compactIndexes){
        if(buckets.has(key)) throw new Error(`Unique index violation on ${spec.fields.join(',')}`);
        buckets.set(key,i);
      }else{
        if (!buckets.has(key)) buckets.set(key,new Set());
        buckets.get(key).add(i);
      }

      if(sorted) sorted.push({values,pos:i});
    }
    if (spec.unique && !this.compactIndexes) {
      for (const set of buckets.values()) if (set.size>1) throw new Error(`Unique index violation on ${spec.fields.join(',')}`);
    }
    if(sorted){
      sorted.sort((a,b)=>{
        for(let i=0;i<a.values.length;i++){ const c=comparePrimitive(a.values[i],b.values[i]); if(c) return c; }
        return a.pos-b.pos;
      });
    }
    this.indexes.set(id,{buckets,sorted});
  }

  _ensureSortedIndex(id){
    const idx=this._ensureIndex(id);
    if(idx.sorted)return idx.sorted;
    const spec=this.indexSpecs.get(id);

    if(this.packedSortedIndexes){
      let live=0;
      for(const doc of this.docs)if(doc && doc.__aisiteDeleted!==true)live++;
      const positions=this.typedSortedPositions ? new Uint32Array(live) : new Array(live);
      let j=0;
      for(let i=0;i<this.docs.length;i++){
        const doc=this.docs[i];
        if(!doc || doc.__aisiteDeleted===true)continue;
        positions[j++]=i;
      }
      positions.sort((pa,pb)=>{
        const a=this.docs[pa],b=this.docs[pb];
        for(const f of spec.fields){
          const c=comparePrimitive(getPath(a,f),getPath(b,f));
          if(c)return c;
        }
        return pa-pb;
      });
      idx.sorted=positions;
      idx.sortedPacked=true;
      idx.sortedTyped=positions instanceof Uint32Array;
      return positions;
    }

    const sorted=[];
    for(let i=0;i<this.docs.length;i++){
      const doc=this.docs[i];
      if(!doc || doc.__aisiteDeleted===true)continue;
      sorted.push({values:spec.fields.map(f=>getPath(doc,f)),pos:i});
    }
    sorted.sort((a,b)=>{
      for(let i=0;i<a.values.length;i++){const c=comparePrimitive(a.values[i],b.values[i]);if(c)return c}
      return a.pos-b.pos;
    });
    idx.sorted=sorted;
    idx.sortedPacked=false;
    return sorted;
  }

  _sortedPos(row){ return typeof row==='number' ? row : row.pos; }
  _sortedValue(row,spec,fieldIndex){
    return typeof row==='number' ? getPath(this.docs[row],spec.fields[fieldIndex]) : row.values[fieldIndex];
  }

  _rebuildIndexes(){ for(const id of this.indexSpecs.keys()){ this._buildIndex(id); this.indexLoaded.add(id); } }


  _lowerBound(sorted, fieldIndex, value, inclusive=true, spec=null) {
    let lo=0,hi=sorted.length;
    while(lo<hi){
      const mid=(lo+hi)>>1;
      const c=comparePrimitive(spec?this._sortedValue(sorted[mid],spec,fieldIndex):sorted[mid].values[fieldIndex],value);
      if(c<0 || (!inclusive && c===0)) lo=mid+1; else hi=mid;
    }
    return lo;
  }

  _upperBound(sorted, fieldIndex, value, inclusive=true, spec=null) {
    let lo=0,hi=sorted.length;
    while(lo<hi){
      const mid=(lo+hi)>>1;
      const c=comparePrimitive(spec?this._sortedValue(sorted[mid],spec,fieldIndex):sorted[mid].values[fieldIndex],value);
      if(c<0 || (inclusive && c===0)) lo=mid+1; else hi=mid;
    }
    return lo;
  }

  _rangeSlice(idx, range, equalityPrefix=[], spec=null) {
    // Binary search is exact only for a range on the first indexed field with no equality prefix.
    if(range.index!==0 || equalityPrefix.length) return null;
    const c=range.cond;
    let start=0,end=idx.sorted.length;
    if(Object.hasOwn(c,'$gt')) start=this._lowerBound(idx.sorted,0,c.$gt,false,spec);
    else if(Object.hasOwn(c,'$gte')) start=this._lowerBound(idx.sorted,0,c.$gte,true,spec);
    if(Object.hasOwn(c,'$lt')) end=this._upperBound(idx.sorted,0,c.$lt,false,spec);
    else if(Object.hasOwn(c,'$lte')) end=this._upperBound(idx.sorted,0,c.$lte,true,spec);
    if(end<start)end=start;
    return idx.sorted.slice(start,end);
  }

  _positionsForWhere(where={}) {
    const plan=this._matchIndex(where);
    if(plan)return [...plan.positions];
    const out=[];
    for(let i=0;i<this.docs.length;i++)if(matches(this.docs[i],where))out.push(i);
    return out;
  }

  _matchIndex(where={}) {
    const plans = [];
    for (const spec of this.indexSpecs.values()) {
      const firstField=spec.fields[0];
      if(!Object.hasOwn(where,firstField)) continue;
      const idx = this._ensureIndex(spec.id);
      if (!idx) continue;
      let equalityPrefix = [];
      let range = null;
      let usable = true;
      for (let i=0;i<spec.fields.length;i++) {
        const f = spec.fields[i];
        if (!Object.hasOwn(where,f)) break;
        const cond = where[f];
        if (cond && typeof cond === 'object' && !Array.isArray(cond)) {
          const rangeKeys = ['$gt','$gte','$lt','$lte'];
          if (rangeKeys.some(k=>Object.hasOwn(cond,k))) {
            range = {field:f,cond,index:i}; break;
          }
          if (Object.hasOwn(cond,'$in') && i===0) {
            const positions = new Set();
            for (const v of cond.$in) {
              const prefix = stableKey(v);
              for (const [key,set] of idx.buckets) {
                if (key === prefix || key.startsWith(prefix+'\x1f')) for (const p of set) positions.add(p);
              }
            }
            plans.push({spec,positions,reason:'$in'}); usable=false;
            break;
          }
          usable = false; break;
        } else equalityPrefix.push(cond);
      }
      if (!usable) continue;

      if (equalityPrefix.length === spec.fields.length) {
        const key = equalityPrefix.map(stableKey).join('\x1f');
        const hit=idx.buckets.get(key);
        const positions=hit===undefined?new Set():hit instanceof Set?new Set(hit):new Set([hit]);
        plans.push({spec,positions,reason:'compound-equality'});
        continue;
      }

      if (equalityPrefix.length || range) {
        const positions = new Set();
        if(!idx.sorted)this._ensureSortedIndex(spec.id);
        const slice = range ? this._rangeSlice(idx,range,equalityPrefix,spec) : null;
        const rows = slice || idx.sorted;
        outer: for (const row of rows) {
          for(let i=0;i<equalityPrefix.length;i++) if(comparePrimitive(this._sortedValue(row,spec,i),equalityPrefix[i])!==0) continue outer;
          if (range && !slice) {
            const v = this._sortedValue(row,spec,range.index), c = range.cond;
            if (Object.hasOwn(c,'$gt') && !(v > c.$gt)) continue;
            if (Object.hasOwn(c,'$gte') && !(v >= c.$gte)) continue;
            if (Object.hasOwn(c,'$lt') && !(v < c.$lt)) continue;
            if (Object.hasOwn(c,'$lte') && !(v <= c.$lte)) continue;
          }
          positions.add(this._sortedPos(row));
        }
        plans.push({spec,positions,reason:range?(slice?'range-binary':'range'):'prefix'});
      }
    }
    return plans.sort((a,b)=>a.positions.size-b.positions.size)[0] || null;
  }

  explain(where={}) {
    const p = this._matchIndex(where);
    return p ? {strategy:'index',index:p.spec.fields.length===1?p.spec.fields[0]:p.spec.fields,reason:p.reason,scanned:p.positions.size}
             : {strategy:'full-scan',index:null,scanned:this.docs.length};
  }

  query(options={}) {
    const where = options.where || options.filter || {};
    const plan = this._matchIndex(where);
    const skip = Math.max(0, Number(options.skip || 0));
    const limit = Number(options.limit || 0);
    const hasSort = !!(options.sort && Object.keys(options.sort).length);

    // Fast path: no sort + bounded result. This applies to both indexed and full
    // scans and avoids cloning every matched document before skip/limit.
    if(!hasSort && limit>0){
      const out=[];let matched=0;
      const positions=plan?plan.positions:null;
      if(positions){
        for(const pos of positions){
          const doc=this.docs[pos];
          if(!doc || doc.__aisiteDeleted===true || !matches(doc,where))continue;
          if(matched++<skip)continue;
          out.push(options.projection?projectDoc(doc,options.projection):clone(doc));
          if(out.length>=limit)break;
        }
      }else{
        for(const doc of this.docs){
          if(!doc || doc.__aisiteDeleted===true || !matches(doc,where))continue;
          if(matched++<skip)continue;
          out.push(options.projection?projectDoc(doc,options.projection):clone(doc));
          if(out.length>=limit)break;
        }
      }
      return out;
    }

    // For small sorted pages, keep only the best skip+limit rows instead of
    // materializing and sorting every match. This is especially important for
    // API list endpoints over large unindexed collections.
    const topK=skip+limit;
    if(hasSort&&limit>0&&topK<=512){
      const best=[];let order=0;
      const consider=doc=>{
        if(!doc||doc.__aisiteDeleted===true||!matches(doc,where))return;
        const row={doc,order:order++};
        let lo=0,hi=best.length;
        while(lo<hi){
          const mid=(lo+hi)>>1,c=compareBySort(best[mid].doc,doc,options.sort);
          if(c<0||(c===0&&best[mid].order<row.order))lo=mid+1;else hi=mid;
        }
        if(lo>=topK&&best.length>=topK)return;
        best.splice(lo,0,row);
        if(best.length>topK)best.pop();
      };
      if(plan)for(const pos of plan.positions)consider(this.docs[pos]);
      else for(const doc of this.docs)consider(doc);
      const slice=best.slice(skip,skip+limit).map(x=>x.doc);
      return options.projection?slice.map(doc=>projectDoc(doc,options.projection)):slice.map(clone);
    }

    const source = plan ? [...plan.positions].map(i=>this.docs[i]).filter(d=>d&&d.__aisiteDeleted!==true) : this.docs.filter(d=>d&&d.__aisiteDeleted!==true);
    let refs = source.filter(d=>matches(d,where));
    refs = sortDocs(refs, options.sort);
    if (skip) refs = refs.slice(skip);
    if (limit>0) refs = refs.slice(0,limit);
    return options.projection?refs.map(doc=>projectDoc(doc,options.projection)):refs.map(clone);
  }

  queryPage(options={}) {
    const where = options.where || {};
    const page = Math.max(1,Number(options.page||1));
    const limit = Math.max(1,Number(options.limit||20));
    const skip = (page-1)*limit;
    const sortEntries = options.sort ? Object.entries(options.sort) : [];

    // Fast path: no filter + one-field sort backed by an index.
    if (Object.keys(where).length===0 && sortEntries.length===1) {
      const [field,dirRaw] = sortEntries[0];
      const dir = Number(dirRaw)<0?-1:1;
      const spec = [...this.indexSpecs.values()].find(x=>x.fields.length===1 && x.fields[0]===field);
      const idx = spec ? this._ensureIndex(spec.id) : null;
      if (idx) {
        const sorted=this._ensureSortedIndex(spec.id);
        let total=0;
        for(let i=0;i<sorted.length;i++){const p=this._sortedPos(sorted[i]);if(this.docs[p]&&this.docs[p].__aisiteDeleted!==true)total++}
        const slice=[];
        let seen=0;
        if(dir===1){
          for(let i=0;i<sorted.length && slice.length<limit;i++){
            const p=this._sortedPos(sorted[i]),doc=this.docs[p];
            if(!doc||doc.__aisiteDeleted===true)continue;
            if(seen++<skip)continue;
            slice.push(clone(doc));
          }
        }else{
          for(let i=sorted.length-1;i>=0 && slice.length<limit;i--){
            const p=this._sortedPos(sorted[i]),doc=this.docs[p];
            if(!doc||doc.__aisiteDeleted===true)continue;
            if(seen++<skip)continue;
            slice.push(clone(doc));
          }
        }
        return {list:slice,total,page,limit,pages:Math.ceil(total/limit),strategy:'index-page',index:field};
      }
    }

    const plan = this._matchIndex(where);
    let total;
    if (plan) {
      total = 0;
      for (const pos of plan.positions) { const d=this.docs[pos]; if (d&&d.__aisiteDeleted!==true&&matches(d,where)) total++; }
    } else total = Object.keys(where).length===0
      ? this.docs.length-this.tombstones
      : this.docs.reduce((n,d)=>n+(d&&d.__aisiteDeleted!==true&&matches(d,where)?1:0),0);

    const list = this.query({...options,skip,limit});
    return {list,total,page,limit,pages:Math.ceil(total/limit),strategy:plan?'index':'scan'};
  }


  _indexedFieldsChanged(patch={}) {
    if(!this.indexSpecs.size && !this.textIndexes.size) return false;
    const keys=Object.keys(patch||{});
    for(const spec of this.indexSpecs.values()){
      for(const field of spec.fields){
        if(keys.some(k=>k===field || k.startsWith(field+'.') || field.startsWith(k+'.'))) return true;
      }
    }
    if(this.textIndexes.size){
      for(const spec of this.textIndexes.values()){
        for(const field of spec.fields){
          if(keys.some(k=>k===field || k.startsWith(field+'.') || field.startsWith(k+'.'))) return true;
        }
      }
    }
    return false;
  }

  _appendToIndexes(doc,pos){
    if(!doc || doc.__aisiteDeleted===true)return;
    for(const spec of this.indexSpecs.values()){
      const idx=this._ensureIndex(spec.id);
      if(!idx)continue;
      const values=spec.fields.map(f=>getPath(doc,f));
      const key=values.map(stableKey).join('\x1f');

      if(spec.unique && this.compactIndexes){
        if(idx.buckets.has(key))throw new Error(`Unique index violation on ${spec.fields.join(',')}`);
        idx.buckets.set(key,pos);
      }else{
        let set=idx.buckets.get(key);
        if(!set){set=new Set();idx.buckets.set(key,set)}
        if(spec.unique && set.size)throw new Error(`Unique index violation on ${spec.fields.join(',')}`);
        set.add(pos);
      }

      if(idx.sorted){
        if(idx.sortedPacked){
          // Preserve compact representation: invalidate and lazily rebuild on next range/sort query.
          idx.sorted=null;
        }else{
          const row={values,pos};
          let lo=0,hi=idx.sorted.length;
          while(lo<hi){
            const mid=(lo+hi)>>1;const other=idx.sorted[mid];
            let c=0;
            for(let i=0;i<values.length;i++){c=comparePrimitive(other.values[i],values[i]);if(c)break}
            if(c<0 || (c===0 && other.pos<pos))lo=mid+1;else hi=mid;
          }
          idx.sorted.splice(lo,0,row);
        }
      }
    }
    for(const spec of this.textIndexes.values()){
      const tokens=new Set();
      for(const field of spec.fields)for(const t of this._tokenize(getPath(doc,field),spec.caseSensitive))tokens.add(t);
      for(const t of tokens){
        if(!spec.map.has(t))spec.map.set(t,new Set());
        spec.map.get(t).add(pos);
      }
    }
  }

  _assertUnique(doc, ignoreId=null) {
    for (const spec of this.indexSpecs.values()) {
      if (!spec.unique) continue;
      const values = spec.fields.map(f=>getPath(doc,f));
      const key=values.map(stableKey).join('\x1f');
      const idx=this._ensureIndex(spec.id);
      if(idx){
        const bucket=idx.buckets.get(key);
        const positions=this.compactIndexes
          ? (bucket===undefined?[]:[bucket])
          : bucket ? [...bucket] : [];
        for(const pos of positions){
          const existing=this.docs[pos];
          if(existing && existing.__aisiteDeleted!==true && (!ignoreId || existing._id!==ignoreId))
            throw new Error(`Unique index violation on ${spec.fields.join(',')}`);
        }
        continue;
      }
      for (const existing of this.docs) {
        if(!existing || existing.__aisiteDeleted===true) continue;
        if (ignoreId && existing._id===ignoreId) continue;
        if (spec.fields.every((f,i)=>getPath(existing,f)===values[i])) throw new Error(`Unique index violation on ${spec.fields.join(',')}`);
      }
    }
  }

  async transaction(fnOrOps) {
    const run = async () => {
      const seqBefore=this.seq;
      const txid = randomId(12);
      const txseq=++this.walSeq;
      const ops = [];
      const undo = [];
      let needsFullIndexRebuild=false;

      const api = {
        add:(doc)=>{
          const x=clone(doc||{});
          if(x.id==null&&this.identity)x.id=++this.seq;
          if(x._id==null)x._id=randomId(12);
          if(this.schema) assertValid(this.schema,x);
          this._assertUnique(x);
          const pos=this.docs.length;
          this.docs.push(x);
          undo.push(()=>{this.docs.pop()});
          ops.push({type:'add',doc:clone(x),_pos:pos});
          return clone(x);
        },
        update:(where,patch,multi=false)=>{
          let count=0;
          const touched=[];
          const plan=this._matchIndex(where||{});
          const positions=plan?[...plan.positions]:this.docs.map((_,i)=>i);
          for(const pos of positions){
            const doc=this.docs[pos];
            if(!doc||doc.__aisiteDeleted===true||!matches(doc,where||{}))continue;
            touched.push([pos,clone(doc)]);
            const candidate=clone(doc);
            for(const [k,v] of Object.entries(patch||{}))setPath(candidate,k,clone(v));
            if(this.schema) assertValid(this.schema,candidate);
            this._assertUnique(candidate,doc._id);
            Object.assign(doc,candidate);
            count++; if(!multi)break;
          }
          if(touched.length)undo.push(()=>{for(const [pos,old] of touched)this.docs[pos]=old});
          const indexedChanged=this._indexedFieldsChanged(patch||{});
          if(indexedChanged)needsFullIndexRebuild=true;
          ops.push({type:'update',where:clone(where||{}),patch:clone(patch||{}),multi,_indexedChanged:indexedChanged});
          return {done:true,count};
        },
        delete:(where,multi=false)=>{
          let count=0;
          if(this.tombstoneMode){
            const plan=this._matchIndex(where||{});
            const positions=plan?[...plan.positions]:this.docs.map((_,i)=>i);
            const changed=[];
            for(const pos of positions){
              const doc=this.docs[pos];
              if(!doc || doc.__aisiteDeleted===true || !matches(doc,where||{}))continue;
              changed.push([pos,doc.__aisiteDeleted]);
              doc.__aisiteDeleted=true;
              this.tombstones++;
              count++;
              if(!multi)break;
            }
            if(changed.length)undo.push(()=>{
              for(const [pos,prev] of changed){
                if(this.docs[pos])this.docs[pos].__aisiteDeleted=prev;
                if(prev!==true)this.tombstones=Math.max(0,this.tombstones-1);
              }
            });
            // Index positions remain stable; query/count filter tombstones.
          }else{
            const removed=[];
            for(let i=0;i<this.docs.length;i++){
              const doc=this.docs[i];
              if(matches(doc,where||{})&&(multi||count===0)){removed.push([i,doc]);count++;if(!multi)break}
            }
            if(removed.length){
              const removeSet=new Set(removed.map(x=>x[0]));
              const before=this.docs;
              this.docs=this.docs.filter((_,i)=>!removeSet.has(i));
              undo.push(()=>{this.docs=before});
              needsFullIndexRebuild=true;
            }
          }
          ops.push({type:'delete',where:clone(where||{}),multi});
          return {done:true,count};
        }
      };

      this._appendWal({type:'begin',txid,txseq,time:Date.now()});
      try {
        let result;
        if(typeof fnOrOps==='function') result=await fnOrOps(api);
        else {
          result=[];
          for(const op of fnOrOps||[]){
            if(op.type==='add') result.push(api.add(op.doc));
            else if(op.type==='update') result.push(api.update(op.where,op.patch,!!op.multi));
            else if(op.type==='delete') result.push(api.delete(op.where,!!op.multi));
            else throw new Error(`Unknown transaction op: ${op.type}`);
          }
        }

        for (const op of ops) {
          const walOp={...op};delete walOp._pos;delete walOp._indexedChanged;
          this._appendWal({type:'op',txid,txseq,op:walOp});
        }
        this._appendWal({type:'commit',txid,txseq,time:Date.now()});
        this._syncWal();

        if(needsFullIndexRebuild){
          this._rebuildIndexes();
          this._rebuildTextIndexes();
        }else{
          // Adds can be appended incrementally; non-indexed updates need no index work.
          for(const op of ops)if(op.type==='add')this._appendToIndexes(op.doc,op._pos);
        }

        this._dirtyOps += ops.length;
        if(ops.length)this._invalidateIndexSnapshot();
        if(this.tombstones>0 && this.tombstones/Math.max(1,this.docs.length)>=this.tombstoneCompactRatio){
          this.compact();
        }
        if(this.durability==='wal'){
          if(this._dirtyOps >= this.walCompactEvery) this.compact();
        }else{
          this.checkpointSeq=txseq;
          this._persist();
          this._invalidateIndexSnapshot();
          if (this._dirtyOps >= this.compactEvery) this.compact();
          else this._clearWal();
        }
        return clone(result);
      } catch(e) {
        for(let i=undo.length-1;i>=0;i--)try{undo[i]()}catch{}
        this.seq=seqBefore;
        this._rebuildIndexes();
        this._rebuildTextIndexes();
        this._appendWal({type:'rollback',txid,txseq,time:Date.now(),error:e.message});
        this._syncWal();
        throw e;
      }
    };
    const p=this._queue.then(run);
    this._queue=p.catch(()=>{});
    return p;
  }

  add(doc){ return this.transaction(tx=>tx.add(doc)); }
  update(where,patch,multi=false){ return this.transaction(tx=>tx.update(where,patch,multi)); }
  delete(where,multi=false){ return this.transaction(tx=>tx.delete(where,multi)); }
  count(where={}) {
    if(!where||Object.keys(where).length===0)return this.docs.length-this.tombstones;
    const plan=this._matchIndex(where);
    if(plan){
      let n=0;
      for(const pos of plan.positions){const d=this.docs[pos];if(d&&d.__aisiteDeleted!==true&&matches(d,where))n++}
      return n;
    }
    let n=0;for(const d of this.docs)if(d&&d.__aisiteDeleted!==true&&matches(d,where))n++;return n;
  }

  async *stream(options={}) {
    const list=this.query(options), batchSize=Math.max(1,Number(options.batchSize||100));
    for(let i=0;i<list.length;i+=batchSize){
      for(const doc of list.slice(i,i+batchSize)) yield doc;
      await new Promise(r=>setImmediate(r));
    }
  }

  compact() {
    if(this.tombstones>0){
      this.docs=this.docs.filter(d=>d&&d.__aisiteDeleted!==true);
      this.tombstones=0;
      this._rebuildIndexes();
      this._rebuildTextIndexes();
    }
    this.checkpointSeq=this.walSeq;
    this._persist();
    this._clearWal();
    this._dirtyOps = 0;
    if(this.indexSpecs.size){
      this._rebuildIndexes();
      this._saveIndexSnapshots();
    }
    return {done:true,documents:this.docs.length,tombstones:this.tombstones};
  }

  compactTombstones(force=false){
    const total=this.docs.length||1;
    const ratio=this.tombstones/total;
    if(!force && ratio<this.tombstoneCompactRatio)return {done:true,compacted:false,tombstones:this.tombstones,ratio};
    const before=this.docs.length;
    this.compact();
    return {done:true,compacted:true,removed:before-this.docs.length,documents:this.docs.length};
  }

  backup(label='manual') {
    const stamp=new Date().toISOString().replace(/[:.]/g,'-');
    const file=path.join(this.backupDir,`${this.name}-${label}-${stamp}.json`);
    atomicWrite(file,JSON.stringify({seq:this.seq,docs:this.docs,indexes:this.listIndexes(),schemaVersion:this.schemaVersion,checksum:this.checksum()}));
    return {done:true,file};
  }

  restore(file) {
    const data=JSON.parse(fs.readFileSync(file,'utf8'));
    this.seq=Number(data.seq||0); this.docs=Array.isArray(data.docs)?data.docs:[];
    if(Array.isArray(data.indexes)){
      this.indexSpecs.clear(); this.indexes.clear();
      for(const spec of data.indexes)this.createIndex(spec.fields||spec.field,spec);
    } else this._rebuildIndexes();
    this._rebuildTextIndexes();
    this.checkpointSeq=this.walSeq;
    this._persist(); this._clearWal();
    if(this.indexSpecs.size)this._saveIndexSnapshots();
    return {done:true,count:this.docs.length};
  }

  stats() {
    let bytes=0,walBytes=0,indexSnapshotBytes=0;
    try{bytes=fs.statSync(this.file).size}catch{}
    try{walBytes=fs.statSync(this.walFile).size}catch{}
    try{indexSnapshotBytes=fs.statSync(this.indexSnapshotFile).size}catch{}
    return {name:this.name,durability:this.durability,crashSafe:this.crashSafe,walSync:this.walSync,walSeq:this.walSeq,checkpointSeq:this.checkpointSeq,documents:this.docs.length-this.tombstones,slots:this.docs.length,tombstones:this.tombstones,seq:this.seq,indexes:this.listIndexes(),ttlIndexes:[...this.ttlIndexes.values()],textIndexes:[...this.textIndexes.values()].map(x=>({id:x.id,fields:x.fields})),schemaVersion:this.schemaVersion,checksum:this.checksum(),bytes,walBytes,indexSnapshotBytes,loadedIndexes:this.indexes.size,compactIndexes:this.compactIndexes,lazySortedIndexes:this.lazySortedIndexes,highScale:this.highScale,packedSortedIndexes:this.packedSortedIndexes,typedSortedPositions:this.typedSortedPositions,dirtyOps:this._dirtyOps};
  }
}

module.exports = { StorageEngine };
