'use strict';

const fs=require('fs');
const path=require('path');
const {randomId,ensureDir,atomicWrite}=require('./utils');

const INTERNAL=new Set(['$id','$save','id','destroy','regenerate','expiresAt']);

class SessionStore{
  constructor(options={},identity=null){
    this.enabled=options.enabled!==false;
    this.cwd=path.resolve(options.cwd||process.cwd());
    this.cookieName=options.cookieName||'sb.sid';
    this.cookieAliases=[...new Set([].concat(options.cookieAliases||[]).filter(Boolean).map(String))];
    this.cookieOptions={httpOnly:true,sameSite:'Lax',...(options.cookieOptions||{})};
    this.timeout=Number(options.timeout||60*24*30);
    this.persistence=String(options.persistence||options.persistenceMode||'sync').toLowerCase();
    this.fallbackToMemory=options.fallbackToMemory===true||String(options.onStorageError||'').toLowerCase()==='memory';
    this.storageError=null;
    const requestedDir=options.dir
      ? (path.isAbsolute(options.dir)?path.resolve(options.dir):path.resolve(this.cwd,options.dir))
      : path.join(this.cwd,'.social-browser','sessions');
    this.dir=requestedDir;
    if(this.enabled&&this.persistence!=='memory'&&this.persistence!=='none'){
      try{this.dir=ensureDir(requestedDir)}catch(error){
        this.storageError=error;
        if(this.fallbackToMemory){this.persistence='memory'}else throw error;
      }
    }
    this.userInvalidationsFile=options.userInvalidationsFile||path.join(this.dir,'.user-invalidations');
    this.userInvalidations=new Map();
    this.userInvalidationTtlMs=Math.max(1000,Number(options.userInvalidationTtlMs||((this.timeout||60*24*30)*60*1000+60*60*1000)));
    this.memory=new Map();
    this.byUserId=new Map();
    this.dirty=new Set();
    this.identity=identity;
    this.identityHydration=String(options.identityHydration||options.hydrateIdentity||'session-first').toLowerCase();
    this.lazy=options.lazy!==false;
    this.flushIntervalMs=Math.max(10,Number(options.flushIntervalMs||100));
    this.maxDirty=Math.max(1,Number(options.maxDirty||128));
    this.maxMemorySessions=Math.max(100,Number(options.maxMemorySessions||100000));
    this.pressureFactor=1;
    this.cleanupIntervalMs=Math.max(1000,Number(options.cleanupIntervalMs||60000));
    this._flushTimer=null;
    this._cleanupTimer=null;
    if(this.enabled){
      this._cleanupTimer=setInterval(()=>{try{this.cleanupExpired()}catch{}},this.cleanupIntervalMs);
      this._cleanupTimer.unref?.();
    }
    this.metrics={memoryHits:0,diskLoads:0,diskWrites:0,queuedWrites:0,flushes:0,commits:0,skippedCommits:0,memoryEvictions:0,expired:0,userInvalidations:0,identityRefreshes:0};
    if(this.enabled&&this.persistence!=='memory'&&this.persistence!=='none')this._loadUserInvalidations();
  }
  _loadUserInvalidations(){
    try{
      const raw=JSON.parse(fs.readFileSync(this.userInvalidationsFile,'utf8'));
      const now=Date.now();
      for(const [uid,at] of Object.entries(raw||{})){
        const ts=Number(at||0);if(ts>0&&now-ts<=this.userInvalidationTtlMs)this.userInvalidations.set(String(uid),ts);
      }
    }catch{}
  }
  _pruneUserInvalidations(now=Date.now()){
    let changed=false;
    for(const [uid,at] of [...this.userInvalidations]){
      if(now-Number(at||0)>this.userInvalidationTtlMs){this.userInvalidations.delete(uid);changed=true}
    }
    return changed;
  }
  _saveUserInvalidations(){
    if(!this.enabled||this.persistence==='memory'||this.persistence==='none')return true;
    this._pruneUserInvalidations();
    const data=Object.fromEntries(this.userInvalidations);
    if(Object.keys(data).length===0){try{fs.unlinkSync(this.userInvalidationsFile)}catch{};return true}
    atomicWrite(this.userInvalidationsFile,JSON.stringify(data));return true;
  }
  userInvalidationEpoch(userId){return Number(this.userInvalidations.get(String(userId))||0)}
  _applyUserInvalidation(data){
    if(!data)return data;
    const uid=this._userId(data);if(uid==null)return data;
    const invalidatedAt=this.userInvalidationEpoch(uid);
    if(!invalidatedAt)return data;
    const loadedAt=Number(data.$userLoadedAt||0);
    if(data.user&&loadedAt<=invalidatedAt){
      delete data.user;data.$userLoadedAt=0;
    }
    return data;
  }
  _freshUserLoadedAt(userId){
    const invalidatedAt=this.userInvalidationEpoch(userId);
    return Math.max(Date.now(),invalidatedAt?invalidatedAt+1:0);
  }
  file(id){return path.join(this.dir,`${id}.json`)}
  _userId(data){return data?.user_id??data?.user?.id??null}
  _unindex(id,data){const uid=this._userId(data);if(uid==null)return;const set=this.byUserId.get(String(uid));set?.delete(String(id));if(set?.size===0)this.byUserId.delete(String(uid))}
  _index(id,data){const uid=this._userId(data);if(uid==null)return data;const key=String(uid);let set=this.byUserId.get(key);if(!set)this.byUserId.set(key,(set=new Set()));set.add(String(id));return data}
  _touchMemory(id,data){
    if(this.memory.has(id))this.memory.delete(id);
    this.memory.set(id,data);
    this._enforceMemoryLimit();
    return data;
  }
  _enforceMemoryLimit(){
    if(this.persistence==='memory'||this.persistence==='none')return;
    const limit=Math.max(100,Math.floor(this.maxMemorySessions*this.pressureFactor));
    while(this.memory.size>limit){
      const id=this.memory.keys().next().value;if(id===undefined)break;
      const data=this.memory.get(id);
      if(this.dirty.has(id)){this._writeOne(id)}
      this._unindex(id,data);this.memory.delete(id);this.metrics.memoryEvictions++;
    }
  }
  setPressureFactor(factor=1){
    this.pressureFactor=Math.max(0.2,Math.min(1,Number(factor)||1));
    this._enforceMemoryLimit();return this.pressureFactor;
  }
  cleanupExpired(now=Date.now()){
    let n=0;
    for(const [id,data] of [...this.memory]){
      if(data?.expiresAt&&data.expiresAt<=now){
        this._unindex(id,data);this.memory.delete(id);this.dirty.delete(id);n++;this.metrics.expired++;
        try{fs.unlinkSync(this.file(id))}catch{}
      }
    }
    return n;
  }
  invalidateUser(userId){
    const key=String(userId),now=Date.now();
    this.userInvalidations.set(key,now);this._saveUserInvalidations();this.metrics.userInvalidations++;
    const ids=[...(this.byUserId.get(key)||[])];
    for(const id of ids){const data=this.memory.get(id);if(data){delete data.user;data.$userLoadedAt=0}}
    return ids.length;
  }
  _plain(data){
    const plain={};for(const [k,v] of Object.entries(data||{}))if(!INTERNAL.has(k))plain[k]=v;
    if(plain.user&&!Number(plain.$userLoadedAt||0))plain.$userLoadedAt=this._freshUserLoadedAt(this._userId(plain));
    plain.expiresAt=Date.now()+this.timeout*60*1000;return plain;
  }
  _writeOne(id){
    const data=this.memory.get(id);if(!data){this.dirty.delete(id);return false}
    atomicWrite(this.file(id),JSON.stringify(data));this.dirty.delete(id);this.metrics.diskWrites++;return true;
  }
  _scheduleFlush(){
    if(this.persistence==='memory'||this.persistence==='none'||this._flushTimer)return;
    this._flushTimer=setTimeout(()=>{this._flushTimer=null;try{this.flushSync()}catch{}},this.flushIntervalMs);this._flushTimer.unref?.();
  }
  load(id){
    if(!id)return null;
    if(this.memory.has(id)){
      const data=this.memory.get(id);
      if(data?.expiresAt&&data.expiresAt<=Date.now()){
        this._unindex(id,data);this.memory.delete(id);this.dirty.delete(id);this.metrics.expired++;try{fs.unlinkSync(this.file(id))}catch{}return null;
      }
      this._applyUserInvalidation(data);
      this.metrics.memoryHits++;return this._touchMemory(id,data);
    }
    try{
      const data=JSON.parse(fs.readFileSync(this.file(id),'utf8'));this.metrics.diskLoads++;
      if(data.expiresAt&&data.expiresAt<Date.now()){try{fs.unlinkSync(this.file(id))}catch{}this.metrics.expired++;return null}
      this._applyUserInvalidation(data);this._touchMemory(id,data);this._index(id,data);return data;
    }catch{return null}
  }
  save(id,data,options={}){
    if(!id)return false;
    const plain=this._plain(data);const old=this.memory.get(id);if(old)this._unindex(id,old);this._touchMemory(id,plain);this._index(id,plain);
    const immediate=options.immediate===true||this.persistence==='sync';
    if(this.persistence==='memory'||this.persistence==='none')return true;
    if(immediate){this._writeOne(id);return true}
    this.dirty.add(id);this.metrics.queuedWrites++;
    if(this.dirty.size>=this.maxDirty)this.flushSync();else this._scheduleFlush();
    return true;
  }
  flushSync(id=null){
    if(this.persistence==='memory'||this.persistence==='none')return 0;
    const ids=id?[id]:[...this.dirty];let n=0;
    for(const sid of ids)if(this.dirty.has(sid)&&this._writeOne(sid))n++;
    if(n)this.metrics.flushes++;return n;
  }
  async flush(id=null){return this.flushSync(id)}
  close(){if(this._flushTimer){clearTimeout(this._flushTimer);this._flushTimer=null}if(this._cleanupTimer){clearInterval(this._cleanupTimer);this._cleanupTimer=null}return this.flushSync()}

  attach(req,res){
    if(!this.enabled){req.session={};req._sessionDirty=false;return}
    const incomingCookieName=[this.cookieName,...this.cookieAliases].find(name=>req.cookies?.[name]);
    const incomingId=incomingCookieName?req.cookies?.[incomingCookieName]:null;
    const loaded=incomingId?this.load(incomingId):null;
    let id=loaded?incomingId:null,dirty=false,destroyed=false;
    const sessionTarget=loaded||{};
    if(loaded&&incomingCookieName&&incomingCookieName!==this.cookieName){try{res.cookie(this.cookieName,incomingId,this.cookieOptions)}catch{}}
    const ensureId=()=>{if(!id){id=randomId();res.cookie(this.cookieName,id,this.cookieOptions)}return id};
    const markDirty=()=>{dirty=true;req._sessionDirty=true;return ensureId()};
    const proxy=new Proxy(sessionTarget,{
      set(target,key,value){if(typeof key==='string'&&!INTERNAL.has(key)&&target[key]!==value)markDirty();target[key]=value;return true},
      deleteProperty(target,key){if(Object.prototype.hasOwnProperty.call(target,key)&&typeof key==='string'&&!INTERNAL.has(key))markDirty();delete target[key];return true}
    });
    Object.defineProperties(proxy,{
      $id:{get:()=>id,enumerable:false,configurable:true},
      $save:{value:()=>{markDirty();this.save(id,proxy,{immediate:true});dirty=false;req._sessionDirty=false;return proxy},enumerable:false,configurable:true},
      id:{get:()=>id,enumerable:false,configurable:true},
      destroy:{value:()=>{destroyed=true;dirty=false;req._sessionDirty=false;if(id){const old=this.memory.get(id);if(old)this._unindex(id,old);this.memory.delete(id);this.dirty.delete(id);try{fs.unlinkSync(this.file(id))}catch{}}for(const name of [this.cookieName,...this.cookieAliases])try{res.cookie(name,'',{...this.cookieOptions,expires:new Date(0),maxAge:0})}catch{}for(const k of Object.keys(sessionTarget))delete sessionTarget[k];id=null},enumerable:false,configurable:true},
      regenerate:{value:()=>{if(id){const old=this.memory.get(id);if(old)this._unindex(id,old);this.memory.delete(id);this.dirty.delete(id);try{fs.unlinkSync(this.file(id))}catch{}}id=null;markDirty();return id},enumerable:false,configurable:true}
    });
    req.session=proxy;Object.defineProperty(req,'sessionID',{get:()=>id,configurable:true});
    req._sessionState={get id(){return id},get dirty(){return dirty},get destroyed(){return destroyed},ensureId,markDirty,setSilent:(key,value)=>{sessionTarget[key]=value;return value},deleteSilent:(key)=>{delete sessionTarget[key];return true},markClean:()=>{dirty=false;req._sessionDirty=false}};
    if(!this.lazy&&!id)markDirty();
  }

  async hydrateIdentity(req,context={}){
    const existing=req.session?.user||null,ref=req.session?.identityRef;
    if(existing&&this.identityHydration!=='always'){req.user=existing;return existing}
    if(!ref||!this.identity){req.user=existing;return existing}
    const user=await this.identity.load(ref,{req,session:req.session,...context});
    const uid=user?.id??user?._id??req.session?.user_id??ref?.id??null;
    if(user){
      const loadedAt=this._freshUserLoadedAt(uid);
      if(req._sessionState?.setSilent){req._sessionState.setSilent('user',user);req._sessionState.setSilent('$userLoadedAt',loadedAt);req._sessionState.markDirty?.()}
      else{req.session.user=user;req.session.$userLoadedAt=loadedAt}
      req.user=user;this.metrics.identityRefreshes++;
    }else{
      if(req._sessionState?.deleteSilent){req._sessionState.deleteSilent('user');req._sessionState.setSilent('$userLoadedAt',this._freshUserLoadedAt(uid));req._sessionState.markDirty?.()}
      else{delete req.session.user;req.session.$userLoadedAt=this._freshUserLoadedAt(uid)}
      req.user=null;this.metrics.identityRefreshes++;
    }
    return req.user;
  }
  async setIdentity(req,ref,user=null,context={}){req.session.identityRef=ref||null;if(user){req.session.user=user;req.user=user;if(this.identity&&ref)await this.identity.save(ref,user,{req,session:req.session,...context})}return req.user||null}
  async clearIdentity(req,context={}){const ref=req.session?.identityRef;if(this.identity&&ref)await this.identity.clear(ref,{req,session:req.session,...context});delete req.session.identityRef;delete req.session.user;req.user=null;return true}
  touch(req){if(!this.enabled||!req.session)return false;req._sessionState?.markDirty?.();return true}
  destroy(id){if(!id)return false;const old=this.memory.get(id);if(old)this._unindex(id,old);this.memory.delete(id);this.dirty.delete(id);try{fs.unlinkSync(this.file(id))}catch{}return true}
  commit(req){
    if(!this.enabled||!req.session||req._sessionState?.destroyed)return false;
    if(!req._sessionState?.dirty){this.metrics.skippedCommits++;return false}
    const id=req._sessionState.ensureId();this.save(id,req.session);req._sessionState?.markClean?.();this.metrics.commits++;return true;
  }
  stats(){return {...this.metrics,enabled:this.enabled,cwd:this.cwd,dir:this.dir,storageError:this.storageError?{code:this.storageError.code||'',message:this.storageError.message||String(this.storageError)}:null,memory:this.memory.size,maxMemorySessions:this.maxMemorySessions,pressureFactor:this.pressureFactor,indexedUsers:this.byUserId.size,dirty:this.dirty.size,persistence:this.persistence,flushIntervalMs:this.flushIntervalMs,cleanupIntervalMs:this.cleanupIntervalMs,maxDirty:this.maxDirty,userInvalidationMarkers:this.userInvalidations.size,userInvalidationTtlMs:this.userInvalidationTtlMs}}
}
module.exports={SessionStore};
