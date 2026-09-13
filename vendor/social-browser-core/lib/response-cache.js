'use strict';
const crypto=require('crypto');
const v8=require('v8');

function byteLength(value){
  if(Buffer.isBuffer(value))return value.length;
  if(typeof value==='string')return Buffer.byteLength(value);
  try{return v8.serialize(value).length}
  catch{try{return Buffer.byteLength(JSON.stringify(value))}catch{return 0}}
}

function canonical(value,seen=new WeakSet()){
  if(value===null||value===undefined||typeof value==='string'||typeof value==='number'||typeof value==='boolean')return value;
  if(Buffer.isBuffer(value))return {$buffer:value.toString('base64')};
  if(value instanceof Date)return {$date:value.toISOString()};
  if(Array.isArray(value))return value.map(v=>canonical(v,seen));
  if(typeof value==='object'){
    if(seen.has(value))throw Object.assign(new Error('Response cache key cannot contain circular structures'),{code:'RESPONSE_CACHE_KEY_CIRCULAR'});
    seen.add(value);
    const out={};
    for(const key of Object.keys(value).sort())out[key]=canonical(value[key],seen);
    seen.delete(value);return out;
  }
  return String(value);
}
function cloneValue(value){
  if(value===null||value===undefined||typeof value==='string'||typeof value==='number'||typeof value==='boolean')return value;
  if(Buffer.isBuffer(value))return Buffer.from(value);
  if(typeof structuredClone==='function'){try{return structuredClone(value)}catch{}}
  try{return v8.deserialize(v8.serialize(value))}
  catch(error){throw Object.assign(new Error('Response cache values must be cloneable/serializable unless cloneValues=false'),{code:'RESPONSE_CACHE_VALUE_UNCLONEABLE',cause:error})}
}
function requestIdentity(req={}){
  const userId=req.user?.id??req.user?._id??req.session?.user_id??req.session?.user?.id??req.session?.user?._id??null;
  const sessionId=req._sessionState?.id??req.session?.id??req.session?.sessionId??null;
  return{userId:userId==null?null:String(userId),sessionId:sessionId==null?null:String(sessionId)};
}

class ResponseCache {
  constructor(options={}){
    this.max=Math.max(1,Number(options.max||5000));
    this.maxBytes=Math.max(1024*1024,Number(options.maxBytes||128*1024*1024));
    this.defaultTtlMs=Math.max(0,Number(options.ttlMs||0));
    this.cloneValues=options.cloneValues!==false;
    this.defaultScope=String(options.defaultScope||'auto');
    this.map=new Map();
    this.tags=new Map();
    this.dependencies=new Map();
    this.inflight=new Map();
    this.globalEpoch=0;
    this.keyEpoch=new Map();
    this.tagEpoch=new Map();
    this.dependencyEpoch=new Map();
    this.bytes=0;
    this.pressureFactor=1;
    this.hits=0;this.misses=0;this.sets=0;this.evictions=0;
    this.invalidations=0;this.inflightHits=0;this.staleInflightDrops=0;this.scopedKeys=0;this.cloneReads=0;this.cloneWrites=0;
  }
  key(parts){return crypto.createHash('sha256').update(typeof parts==='string'?parts:JSON.stringify(canonical(parts))).digest('hex')}
  scopedKey(req,key,options={}){
    const identity=requestIdentity(req),requested=String(options.scope||this.defaultScope||'auto').toLowerCase();
    let scope=requested;
    if(scope==='auto')scope=identity.userId!=null?'user':identity.sessionId!=null?'session':'public';
    if(!['public','session','user'].includes(scope))throw Object.assign(new Error(`Invalid response cache scope: ${scope}`),{code:'RESPONSE_CACHE_SCOPE_INVALID'});
    if(scope==='user'&&identity.userId==null)throw Object.assign(new Error('User-scoped response cache requires an authenticated user'),{code:'RESPONSE_CACHE_USER_SCOPE_REQUIRED'});
    if(scope==='session'&&identity.sessionId==null)throw Object.assign(new Error('Session-scoped response cache requires a session id'),{code:'RESPONSE_CACHE_SESSION_SCOPE_REQUIRED'});
    const vary={};
    const varyList=options.vary===false?[]:[].concat(options.vary??['language','theme']);
    for(const name of varyList){
      if(name==='language')vary.language=req.session?.language?.id??req.language??req.headers?.['accept-language']??null;
      else if(name==='theme')vary.theme=req.session?.theme??req.theme??null;
      else if(name==='host')vary.host=req.headers?.host??req.hostname??null;
      else if(name==='method')vary.method=req.method??null;
      else if(name==='path')vary.path=req.path??req.url??null;
      else if(String(name).startsWith('header:'))vary[name]=req.headers?.[String(name).slice(7).toLowerCase()]??null;
      else vary[name]=req[name]??null;
    }
    const routeIsolation=options.routeIsolation!==false?{
      method:req.method||null,
      path:req.path||String(req.url||'').split('?')[0]||null,
      host:req.headers?.host||req.hostname||null
    }:null;
    this.scopedKeys++;
    return this.key({
      namespace:options.namespace||'response',
      scope,
      subject:scope==='user'?identity.userId:scope==='session'?identity.sessionId:'public',
      route:routeIsolation,
      vary,
      key
    });
  }
  _snapshot(value,kind){
    if(!this.cloneValues)return value;
    if(value&&typeof value==='object'){
      if(kind==='read')this.cloneReads++;else this.cloneWrites++;
      return cloneValue(value);
    }
    return value;
  }
  _touch(key,row){this.map.delete(key);this.map.set(key,row);row.lastAccess=Date.now();return row}
  _unlink(key,row){
    if(!row)return;
    for(const tag of row.tags||[]){
      const set=this.tags.get(tag);set?.delete(key);if(set?.size===0)this.tags.delete(tag);
    }
    for(const dep of row.dependencies||[]){
      const set=this.dependencies.get(dep);set?.delete(key);if(set?.size===0)this.dependencies.delete(dep);
    }
  }
  _delete(key){
    const row=this.map.get(key);if(!row)return false;
    this.map.delete(key);this.bytes-=row.bytes||0;this._unlink(key,row);return true;
  }
  _evict(){
    const max=Math.max(1,Math.floor(this.max*this.pressureFactor));
    const maxBytes=Math.max(1024*1024,Math.floor(this.maxBytes*this.pressureFactor));
    while(this.map.size>max||this.bytes>maxBytes){
      const key=this.map.keys().next().value;if(key===undefined)break;
      if(this._delete(key))this.evictions++;
    }
  }
  setPressureFactor(factor=1){this.pressureFactor=Math.max(0.2,Math.min(1,Number(factor)||1));this._evict();return this.pressureFactor}
  get(key){
    const row=this.map.get(key);
    if(!row){this.misses++;return null}
    if(row.expiresAt&&row.expiresAt<=Date.now()){this._delete(key);this.misses++;return null}
    this.hits++;this._touch(key,row);return this._snapshot(row.value,'read');
  }
  set(key,value,ttlOrOptions=this.defaultTtlMs){
    const options=typeof ttlOrOptions==='object'&&ttlOrOptions!==null?ttlOrOptions:{ttlMs:ttlOrOptions};
    const ttlMs=Math.max(0,Number(options.ttlMs??this.defaultTtlMs));
    const tags=[...new Set([].concat(options.tags||[]).filter(Boolean).map(String))];
    const dependencies=[...new Set([].concat(options.dependencies||options.files||[]).filter(Boolean).map(String))];
    const stored=this._snapshot(value,'write');
    const bytes=Math.max(0,Number(options.bytes??byteLength(stored)));
    if(bytes>this.maxBytes)return value;

    const old=this.map.get(key);if(old){this.bytes-=old.bytes||0;this._unlink(key,old);this.map.delete(key)}
    const row={value:stored,bytes,tags:new Set(tags),dependencies:new Set(dependencies),expiresAt:ttlMs?Date.now()+ttlMs:0,createdAt:Date.now(),lastAccess:Date.now()};
    this.map.set(key,row);this.bytes+=bytes;this.sets++;
    for(const tag of tags){let set=this.tags.get(tag);if(!set)this.tags.set(tag,(set=new Set()));set.add(key)}
    for(const dep of dependencies){let set=this.dependencies.get(dep);if(!set)this.dependencies.set(dep,(set=new Set()));set.add(key)}
    this._evict();return value;
  }
  _epochSnapshot(key,options={}){
    const tags=[...new Set([].concat(options.tags||[]).filter(Boolean).map(String))];
    const dependencies=[...new Set([].concat(options.dependencies||options.files||[]).filter(Boolean).map(String))];
    return{
      global:this.globalEpoch,
      key:Number(this.keyEpoch.get(key)||0),
      tags:tags.map(tag=>[tag,Number(this.tagEpoch.get(tag)||0)]),
      dependencies:dependencies.map(dep=>[dep,Number(this.dependencyEpoch.get(dep)||0)])
    };
  }
  _epochValid(key,snapshot){
    if(!snapshot||snapshot.global!==this.globalEpoch)return false;
    if(snapshot.key!==Number(this.keyEpoch.get(key)||0))return false;
    for(const [tag,epoch] of snapshot.tags)if(epoch!==Number(this.tagEpoch.get(tag)||0))return false;
    for(const [dep,epoch] of snapshot.dependencies)if(epoch!==Number(this.dependencyEpoch.get(dep)||0))return false;
    return true;
  }
  _bump(map,key){map.set(key,Number(map.get(key)||0)+1)}

  async getOrSet(key,producer,options={}){
    const hit=this.get(key);if(hit!==null)return hit;
    const existing=this.inflight.get(key);
    if(existing){
      this.inflightHits++;
      const value=await existing.promise;
      return this._snapshot(value,'read');
    }
    const epoch=this._epochSnapshot(key,options);
    const token={
      promise:null,
      tags:new Set(epoch.tags.map(([tag])=>tag)),
      dependencies:new Set(epoch.dependencies.map(([dep])=>dep))
    };
    token.promise=(async()=>{
      try{
        const value=await producer();
        if(value!==undefined&&value!==null&&this._epochValid(key,epoch)){
          this.set(key,value,options);
          const row=this.map.get(key);
          return row?row.value:this._snapshot(value,'write');
        }
        if(value!==undefined&&value!==null&&!this._epochValid(key,epoch))this.staleInflightDrops++;
        return this._snapshot(value,'write');
      }finally{
        if(this.inflight.get(key)===token)this.inflight.delete(key);
      }
    })();
    this.inflight.set(key,token);
    const value=await token.promise;
    return this._snapshot(value,'read');
  }

  delete(key){this._bump(this.keyEpoch,key);this.inflight.delete(key);return this._delete(key)}
  invalidateTag(tag){
    tag=String(tag);this._bump(this.tagEpoch,tag);
    const keys=new Set([...(this.tags.get(tag)||[])]);
    for(const [key,token] of this.inflight)if(token?.tags?.has(tag))keys.add(key);
    for(const key of keys){this._bump(this.keyEpoch,key);this.inflight.delete(key);this._delete(key)}
    if(keys.size)this.invalidations+=keys.size;return keys.size;
  }
  invalidateDependency(dep){
    dep=String(dep);this._bump(this.dependencyEpoch,dep);
    const keys=new Set([...(this.dependencies.get(dep)||[])]);
    for(const [key,token] of this.inflight)if(token?.dependencies?.has(dep))keys.add(key);
    for(const key of keys){this._bump(this.keyEpoch,key);this.inflight.delete(key);this._delete(key)}
    if(keys.size)this.invalidations+=keys.size;return keys.size;
  }
  clear(){
    this.globalEpoch++;
    this.map.clear();this.tags.clear();this.dependencies.clear();this.inflight.clear();this.bytes=0;
  }
  stats(){
    return{
      size:this.map.size,max:this.max,bytes:this.bytes,maxBytes:this.maxBytes,pressureFactor:this.pressureFactor,
      tags:this.tags.size,dependencies:this.dependencies.size,inflight:this.inflight.size,
      hits:this.hits,misses:this.misses,sets:this.sets,evictions:this.evictions,
      invalidations:this.invalidations,inflightHits:this.inflightHits,staleInflightDrops:this.staleInflightDrops,globalEpoch:this.globalEpoch,
      hitRate:(this.hits+this.misses)?this.hits/(this.hits+this.misses):0,
      cloneValues:this.cloneValues,defaultScope:this.defaultScope,scopedKeys:this.scopedKeys,cloneReads:this.cloneReads,cloneWrites:this.cloneWrites
    };
  }
}
module.exports={ResponseCache};
