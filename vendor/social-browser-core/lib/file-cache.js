'use strict';

const fs=require('fs');
const path=require('path');
const zlib=require('zlib');
const {EventEmitter}=require('events');

function byteLength(value){
  if(Buffer.isBuffer(value))return value.length;
  if(typeof value==='string')return Buffer.byteLength(value);
  return 0;
}

class FileCacheEngine extends EventEmitter{
  constructor(options={}){
    super();
    this.enabled=options.enabled!==false;
    this.mode=String(options.mode||process.env.NODE_ENV||'production').toLowerCase();
    this.validation=String(options.validation||options.validationMode||(this.mode==='production'?'manual':'mtime')).toLowerCase();
    this.validateIntervalMs=Math.max(0,Number(options.validateIntervalMs??(this.mode==='production'?0:250)));
    this.maxEntries=Math.max(16,Number(options.maxEntries||(this.mode==='production'?20000:15000)));
    this.maxBytes=Math.max(1024*1024,Number(options.maxBytes||(this.mode==='production'?512*1024*1024:256*1024*1024)));
    this.maxEntryBytes=Math.max(1024,Number(options.maxEntryBytes||8*1024*1024));
    this.maxCompiledEntries=Math.max(16,Number(options.maxCompiledEntries||(this.mode==='production'?8000:5000)));
    this.maxCompiledBytes=Math.max(1024*1024,Number(options.maxCompiledBytes||(this.mode==='production'?256*1024*1024:128*1024*1024)));
    this.entries=new Map();this.compiled=new Map();this.fileToCompiled=new Map();
    this.dependencies=new Map();this.reverseDependencies=new Map();this.resolutionCache=new Map();
    this.realpaths=new Map();
    this.compressed=new Map();
    this.compressedByFile=new Map();
    this.compressedBytes=0;
    this.maxCompressedBytes=Math.max(1024*1024,Number(options.maxCompressedBytes||(this.mode==='production'?128*1024*1024:64*1024*1024)));
    this.missing=new Map();
    this.missingTtlMs=Math.max(0,Number(options.missingTtlMs??(this.mode==='production'?30000:1000)));
    this.realpathHits=0;
    this.realpathMisses=0;this.watchers=new Set();
    this.bytes=0;this.compiledBytes=0;
    this.pressureFactor=1;
    this.counters={hits:0,misses:0,loads:0,statHits:0,statMisses:0,revalidations:0,invalidations:0,evictions:0,compiledHits:0,compiledMisses:0,compiledSets:0,compiledEvictions:0,compressedHits:0,compressedMisses:0,compressedSets:0,compressedEvictions:0,prewarmed:0};
  }
  normalize(file){return path.resolve(String(file))}
  _touch(map,key,row){map.delete(key);map.set(key,row);row.lastAccess=Date.now();return row}
  _snapshotStat(stat){return {size:stat.size,mtimeMs:stat.mtimeMs,ctimeMs:stat.ctimeMs,ino:stat.ino,mode:stat.mode,isFile:stat.isFile(),isDirectory:stat.isDirectory(),mtime:stat.mtime}}
  _sameStat(a,b){return !!a&&!!b&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs&&String(a.ino??'')===String(b.ino??'')}
  _shouldValidate(row){return this.validation==='mtime'&&(!this.validateIntervalMs||Date.now()-(row.validatedAt||0)>=this.validateIntervalMs)}
  _validateRow(file,row){
    if(!this._shouldValidate(row))return row;
    this.counters.revalidations++;
    let stat;try{stat=fs.statSync(file)}catch{this.invalidate(file);return null}
    const snap=this._snapshotStat(stat);
    if(!this._sameStat(row.stat,snap)){this.invalidate(file);return null}
    row.stat=snap;row.validatedAt=Date.now();return row;
  }
  _entryBytes(row){let n=Buffer.isBuffer(row.buffer)?row.buffer.length:0;for(const v of row.text?.values?.()||[])n+=byteLength(v);return n}
  _statFacade(s){return {...s,isFile:()=>!!s.isFile,isDirectory:()=>!!s.isDirectory}}
  _effective(value,min=1){return Math.max(min,Math.floor(Number(value||0)*this.pressureFactor))}
  _trimMap(map,max){
    while(map.size>max){const key=map.keys().next().value;if(key===undefined)break;map.delete(key)}
  }
  _evict(){
    const maxEntries=this._effective(this.maxEntries,16),maxBytes=this._effective(this.maxBytes,1024*1024);
    const maxCompiledEntries=this._effective(this.maxCompiledEntries,16),maxCompiledBytes=this._effective(this.maxCompiledBytes,1024*1024);
    const maxCompressedBytes=this._effective(this.maxCompressedBytes,1024*1024);
    while(this.entries.size>maxEntries||this.bytes>maxBytes){const key=this.entries.keys().next().value;if(key===undefined)break;const row=this.entries.get(key);this.entries.delete(key);this.bytes-=row?.bytes||0;this.counters.evictions++}
    while(this.compiled.size>maxCompiledEntries||this.compiledBytes>maxCompiledBytes){const key=this.compiled.keys().next().value;if(key===undefined)break;this._deleteCompiled(key);this.counters.compiledEvictions++}
    while(this.compressedBytes>maxCompressedBytes){const key=this.compressed.keys().next().value;if(key===undefined)break;this._deleteCompressedKey(key);this.counters.compressedEvictions++}
    this._trimMap(this.resolutionCache,maxEntries);this._trimMap(this.realpaths,maxEntries);this._trimMap(this.missing,maxEntries);
  }
  setPressureFactor(factor=1){
    this.pressureFactor=Math.max(0.2,Math.min(1,Number(factor)||1));this._evict();return this.pressureFactor;
  }
  statSync(file){
    file=this.normalize(file);if(!this.enabled){this.counters.statMisses++;return fs.statSync(file)}
    const missingAt=this.missing.get(file);
    if(missingAt && (!this.missingTtlMs || Date.now()-missingAt<this.missingTtlMs)){this.counters.statHits++;const e=new Error(`ENOENT: no such file or directory, stat '${file}'`);e.code='ENOENT';throw e}
    if(missingAt)this.missing.delete(file);
    let row=this.entries.get(file);if(row){row=this._validateRow(file,row);if(row){this.counters.statHits++;this._touch(this.entries,file,row);return this._statFacade(row.stat)}}
    this.counters.statMisses++;let stat;try{stat=fs.statSync(file)}catch(e){if(e?.code==='ENOENT'){this.missing.set(file,Date.now());if(this.missing.size>this._effective(this.maxEntries,16))this.missing.delete(this.missing.keys().next().value)}throw e}
    const snap=this._snapshotStat(stat);
    this.missing.delete(file);row={file,stat:snap,buffer:null,text:new Map(),bytes:0,validatedAt:Date.now(),lastAccess:Date.now()};this.entries.set(file,row);this._evict();return this._statFacade(snap);
  }
  realpathSync(file){
    const key=this.normalize(file);
    if(this.mode==='production'&&this.realpaths.has(key)){
      const value=this.realpaths.get(key);
      this.realpaths.delete(key);this.realpaths.set(key,value);
      this.realpathHits++;
      return value;
    }
    this.realpathMisses++;
    const value=fs.realpathSync(key);
    if(this.mode==='production'){
      this.realpaths.set(key,value);
      while(this.realpaths.size>this._effective(this.maxEntries,16)){
        const first=this.realpaths.keys().next().value;
        if(first===undefined)break;
        this.realpaths.delete(first);
      }
    }
    return value;
  }

  existsSync(file){try{this.statSync(file);return true}catch{return false}}
  isFileSync(file){try{return this.statSync(file).isFile()}catch{return false}}
  isDirectorySync(file){try{return this.statSync(file).isDirectory()}catch{return false}}
  getBufferSync(file){
    file=this.normalize(file);if(!this.enabled)return fs.readFileSync(file);
    let row=this.entries.get(file);if(row)row=this._validateRow(file,row);
    if(row?.buffer){this.counters.hits++;this._touch(this.entries,file,row);return row.buffer}
    this.counters.misses++;
    if(!row){const stat=fs.statSync(file),snap=this._snapshotStat(stat);if(!snap.isFile)throw Object.assign(new Error(`Not a file: ${file}`),{code:'EISDIR'});row={file,stat:snap,buffer:null,text:new Map(),bytes:0,validatedAt:Date.now(),lastAccess:Date.now()}}
    if(row.stat.size>this.maxEntryBytes)return fs.readFileSync(file);
    const old=row.bytes||0;row.buffer=fs.readFileSync(file);row.bytes=this._entryBytes(row);this.entries.set(file,row);this.bytes+=row.bytes-old;this.counters.loads++;this._touch(this.entries,file,row);this._evict();return row.buffer;
  }
  getTextSync(file,encoding='utf8'){
    file=this.normalize(file);encoding=String(encoding||'utf8');if(!this.enabled)return fs.readFileSync(file,encoding);
    let row=this.entries.get(file);if(row)row=this._validateRow(file,row);
    if(row?.text?.has(encoding)){this.counters.hits++;this._touch(this.entries,file,row);return row.text.get(encoding)}
    this.counters.misses++;const buffer=this.getBufferSync(file);if(buffer.length>this.maxEntryBytes)return buffer.toString(encoding);
    row=this.entries.get(file);const old=row.bytes||0,text=buffer.toString(encoding);row.text.set(encoding,text);row.bytes=this._entryBytes(row);this.bytes+=row.bytes-old;this._touch(this.entries,file,row);this._evict();return text;
  }
  async getBuffer(file){return this.getBufferSync(file)}
  async getText(file,encoding='utf8'){return this.getTextSync(file,encoding)}

_deleteCompressedKey(key){
  const row=this.compressed.get(key);if(!row)return false;
  this.compressed.delete(key);this.compressedBytes-=row.bytes||0;
  const set=this.compressedByFile.get(row.file);set?.delete(key);if(set?.size===0)this.compressedByFile.delete(row.file);
  return true;
}
getCompressedSync(file,encoding='br'){
  file=this.normalize(file);encoding=String(encoding||'br').toLowerCase();
  if(!['br','gzip','deflate'].includes(encoding))return null;
  const key=file+'\u0000'+encoding;
  const cached=this.compressed.get(key);
  if(cached){this.counters.compressedHits++;this._touch(this.compressed,key,cached);return cached.buffer}
  this.counters.compressedMisses++;
  const source=this.getBufferSync(file);
  if(source.length>this.maxEntryBytes)return null;
  let buffer;
  if(encoding==='br')buffer=zlib.brotliCompressSync(source,{params:{[zlib.constants.BROTLI_PARAM_QUALITY]:4}});
  else if(encoding==='gzip')buffer=zlib.gzipSync(source,{level:6});
  else buffer=zlib.deflateSync(source,{level:6});
  const row={file,encoding,buffer,bytes:buffer.length,lastAccess:Date.now(),createdAt:Date.now()};
  this.compressed.set(key,row);this.compressedBytes+=row.bytes;let set=this.compressedByFile.get(file);if(!set)this.compressedByFile.set(file,(set=new Set()));set.add(key);
  this.counters.compressedSets++;this._evict();return buffer;
}
selectCompressedSync(file,acceptEncoding=''){
  const accept=String(acceptEncoding||'').toLowerCase();
  if(accept.includes('br'))return {encoding:'br',buffer:this.getCompressedSync(file,'br')};
  if(accept.includes('gzip'))return {encoding:'gzip',buffer:this.getCompressedSync(file,'gzip')};
  if(accept.includes('deflate'))return {encoding:'deflate',buffer:this.getCompressedSync(file,'deflate')};
  return null;
}

  getCompiledSync(key,compiler,options={}){
    if(!this.enabled)return compiler();let row=this.compiled.get(key);
    if(row){this.counters.compiledHits++;this._touch(this.compiled,key,row);return row.value}
    this.counters.compiledMisses++;const value=compiler(),files=[...(options.files||[])].map(f=>this.normalize(f)),bytes=Math.max(0,Number(options.bytes??byteLength(options.source||'')));
    row={key,value,files:new Set(files),bytes,lastAccess:Date.now(),createdAt:Date.now()};this.compiled.set(key,row);this.compiledBytes+=bytes;this.counters.compiledSets++;
    for(const file of files){if(!this.fileToCompiled.has(file))this.fileToCompiled.set(file,new Set());this.fileToCompiled.get(file).add(key)}this._evict();return value;
  }
  _deleteCompiled(key){const row=this.compiled.get(key);if(!row)return false;this.compiled.delete(key);this.compiledBytes-=row.bytes||0;for(const file of row.files||[]){const keys=this.fileToCompiled.get(file);keys?.delete(key);if(keys?.size===0)this.fileToCompiled.delete(file)}return true}
  trackDependency(parent,child){parent=this.normalize(parent);child=this.normalize(child);if(parent===child)return;this.dependencies.get(parent)?.add(child)||(this.dependencies.set(parent,new Set([child])));this.reverseDependencies.get(child)?.add(parent)||(this.reverseDependencies.set(child,new Set([parent])))}
  invalidate(file,options={}){
    file=this.normalize(file);const visited=options._visited||new Set();if(visited.has(file))return false;visited.add(file);
    const row=this.entries.get(file);if(row){this.entries.delete(file);this.bytes-=row.bytes||0}
    for(const key of [...(this.compressedByFile.get(file)||[])])this._deleteCompressedKey(key);
    for(const key of [...(this.fileToCompiled.get(file)||[])])this._deleteCompiled(key);
    this.resolutionCache.clear();
    this.realpaths.clear();
    this.missing.delete(file);
    if(options.cascade!==false)for(const parent of this.reverseDependencies.get(file)||[]){for(const key of [...(this.fileToCompiled.get(parent)||[])])this._deleteCompiled(key);this.invalidate(parent,{...options,_visited:visited})}
    this.counters.invalidations++;this.emit('invalidate',file);return !!row;
  }
  invalidateMany(files,options={}){for(const f of files||[])this.invalidate(f,options);return this}
  clear(){this.entries.clear();this.compiled.clear();this.fileToCompiled.clear();this.dependencies.clear();this.reverseDependencies.clear();this.resolutionCache.clear();this.realpaths.clear();this.missing.clear();this.compressed.clear();this.compressedByFile.clear();this.bytes=0;this.compiledBytes=0;this.compressedBytes=0;this.emit('clear')}
  resolveExistingFile(candidates){
    const list=[...(candidates||[])].filter(Boolean).map(x=>this.normalize(x)),key=list.join('\u0000'),cached=this.resolutionCache.get(key);
    if(cached&&(!cached.expiresAt||cached.expiresAt>Date.now())){this.counters.statHits++;return cached.file}
    let found=null;for(const file of list){if(this.isFileSync(file)){found=file;break}}
    const ttl=this.validation==='mtime'?Math.max(this.validateIntervalMs,50):0;this.resolutionCache.set(key,{file:found,expiresAt:ttl?Date.now()+ttl:0});if(this.resolutionCache.size>this._effective(this.maxEntries,16))this.resolutionCache.delete(this.resolutionCache.keys().next().value);return found;
  }
  prewarmSync(targets,options={}){
    const roots=[].concat(targets||[]).filter(Boolean),extensions=options.extensions?new Set([].concat(options.extensions).map(x=>String(x).toLowerCase())):null,maxFileBytes=Number(options.maxFileBytes||this.maxEntryBytes);let count=0,bytes=0,errors=0;
    const visit=file=>{let stat;try{stat=fs.statSync(file)}catch{errors++;return}if(stat.isDirectory()){if(options.recursive===false)return;let rows=[];try{rows=fs.readdirSync(file)}catch{errors++;return}for(const name of rows)visit(path.join(file,name));return}if(!stat.isFile()||stat.size>maxFileBytes)return;if(extensions&&!extensions.has(path.extname(file).toLowerCase()))return;try{
      this.getBufferSync(file);
      if(options.text===true)this.getTextSync(file,options.encoding||'utf8');
      if(options.compress===true&&/\.(?:css|js|mjs|cjs|json|xml|svg|txt)$/i.test(file)){
        this.getCompressedSync(file,'br');this.getCompressedSync(file,'gzip');
      }
      count++;bytes+=stat.size
    }catch{errors++}};
    for(const target of roots)visit(this.normalize(target));this.counters.prewarmed+=count;return {count,bytes,errors};
  }
  watch(targets,options={}){for(const target of [].concat(targets||[]).filter(Boolean)){const abs=this.normalize(target);let watcher;try{watcher=fs.watch(abs,{recursive:options.recursive===true},(event,name)=>{const changed=name?path.resolve(abs,String(name)):abs;this.invalidate(changed);this.emit('watch-change',{event,file:changed})})}catch{continue}this.watchers.add(watcher);watcher.on?.('close',()=>this.watchers.delete(watcher))}return this}
  close(){for(const watcher of this.watchers)try{watcher.close()}catch{}this.watchers.clear()}
  stats(){const c={...this.counters},total=c.hits+c.misses,ct=c.compiledHits+c.compiledMisses;return {enabled:this.enabled,mode:this.mode,validation:this.validation,validateIntervalMs:this.validateIntervalMs,pressureFactor:this.pressureFactor,entries:this.entries.size,bytes:this.bytes,maxEntries:this.maxEntries,maxBytes:this.maxBytes,maxEntryBytes:this.maxEntryBytes,compiledEntries:this.compiled.size,compiledBytes:this.compiledBytes,maxCompiledEntries:this.maxCompiledEntries,maxCompiledBytes:this.maxCompiledBytes,dependencies:this.dependencies.size,resolutionEntries:this.resolutionCache.size,
      realpathEntries:this.realpaths.size,
      realpathHits:this.realpathHits,
      realpathMisses:this.realpathMisses,compressedEntries:this.compressed.size,compressedBytes:this.compressedBytes,maxCompressedBytes:this.maxCompressedBytes,missingEntries:this.missing.size,missingTtlMs:this.missingTtlMs,watchers:this.watchers.size,...c,hitRate:total?c.hits/total:0,compiledHitRate:ct?c.compiledHits/ct:0}}
}

module.exports={FileCacheEngine};
