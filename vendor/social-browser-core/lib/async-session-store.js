'use strict';
const {randomId}=require('./utils');
const INTERNAL=new Set(['$id','$save','id','destroy','regenerate','expiresAt']);

class AsyncSessionStore{
  constructor(backend,options={},identity=null){
    if(!backend||typeof backend.load!=='function'||typeof backend.save!=='function'||typeof backend.destroy!=='function')
      throw Object.assign(new Error('Async session backend requires load/save/destroy'),{code:'SESSION_BACKEND_INVALID'});
    this.backend=backend;this.enabled=options.enabled!==false;this.cookieName=options.cookieName||'sb.sid';
    this.cookieAliases=[...new Set([].concat(options.cookieAliases||[]).filter(Boolean))];
    this.cookieOptions={httpOnly:true,sameSite:'Lax',...(options.cookieOptions||{})};
    this.timeout=Number(options.timeout||60*24*30);this.identity=identity;this.identityHydration=String(options.identityHydration||options.hydrateIdentity||'session-first').toLowerCase();this.distributed=true;
    this.userInvalidationPrefix=String(options.userInvalidationPrefix||'__sb_user_invalidation__:');
    this.userInvalidationTtlMs=Math.max(1000,Number(options.userInvalidationTtlMs||this.timeout*60*1000+60*60*1000));
    this.userInvalidationCheckIntervalMs=Math.max(0,Number(options.userInvalidationCheckIntervalMs??5000));
    this.userInvalidationCache=new Map();
    this.metrics={invalidationChecks:0,invalidationCacheHits:0,userInvalidations:0,identityRefreshes:0,commits:0,skippedCommits:0};
  }
  _invalidationId(userId){return this.userInvalidationPrefix+String(userId)}
  _userId(data){return data?.user_id??data?.user?.id??data?.user?._id??null}
  async userInvalidationEpoch(userId,{force=false}={}){
    if(userId==null)return 0;
    const key=String(userId),now=Date.now(),cached=this.userInvalidationCache.get(key);
    if(!force&&cached&&now-cached.checkedAt<=this.userInvalidationCheckIntervalMs){
      this.metrics.invalidationCacheHits++;return cached.epoch;
    }
    this.metrics.invalidationChecks++;
    let row=null;try{row=await this.backend.load(this._invalidationId(key))}catch{}
    const epoch=Number(row?.epoch||row||0);
    this.userInvalidationCache.set(key,{epoch,checkedAt:now});
    return epoch;
  }
  async invalidateUser(userId){
    if(userId==null)return 0;
    const key=String(userId),epoch=Date.now();
    await this.backend.save(this._invalidationId(key),{epoch},{ttlMs:this.userInvalidationTtlMs});
    this.userInvalidationCache.set(key,{epoch,checkedAt:Date.now()});
    this.metrics.userInvalidations++;return 0;
  }
  async _applyUserInvalidation(data){
    if(!data)return data;
    const uid=this._userId(data);if(uid==null||!data.user)return data;
    const epoch=await this.userInvalidationEpoch(uid);
    if(epoch&&Number(data.$userLoadedAt||0)<=epoch){
      delete data.user;data.$userLoadedAt=0;
    }
    return data;
  }
  _freshUserLoadedAt(userId){
    const epoch=Number(this.userInvalidationCache.get(String(userId))?.epoch||0);
    return Math.max(Date.now(),epoch?epoch+1:0);
  }
  async attachAsync(req,res){
    if(!this.enabled){req.session={};req._sessionDirty=false;return}
    const incomingCookieName=[this.cookieName,...this.cookieAliases].find(name=>req.cookies?.[name]);
    const incomingId=incomingCookieName?req.cookies[incomingCookieName]:null;
    let loaded=incomingId?await this.backend.load(incomingId):null;
    if(loaded?.expiresAt&&loaded.expiresAt<Date.now()){await this.backend.destroy(incomingId);loaded=null}
    if(loaded)await this._applyUserInvalidation(loaded);
    let id=loaded?incomingId:null,dirty=false,destroyed=false,sessionTarget=loaded?{...loaded}:{};
    if(loaded&&incomingCookieName!==this.cookieName)res.cookie(this.cookieName,incomingId,this.cookieOptions);
    const ensureId=()=>{if(!id){id=randomId();res.cookie(this.cookieName,id,this.cookieOptions)}return id};
    const markDirty=()=>{dirty=true;req._sessionDirty=true;return ensureId()};
    const proxy=new Proxy(sessionTarget,{
      set(target,key,value){if(typeof key==='string'&&!INTERNAL.has(key))markDirty();target[key]=value;return true},
      deleteProperty(target,key){if(Object.hasOwn(target,key)&&typeof key==='string'&&!INTERNAL.has(key))markDirty();delete target[key];return true}
    });
    Object.defineProperties(proxy,{
      $id:{get:()=>id,enumerable:false,configurable:true},
      id:{get:()=>id,enumerable:false,configurable:true},
      $save:{value:async()=>{markDirty();await this.save(id,proxy);dirty=false;req._sessionDirty=false;return proxy},enumerable:false,configurable:true},
      destroy:{value:async()=>{
        destroyed=true;dirty=false;req._sessionDirty=false;if(id)await this.backend.destroy(id);
        for(const name of [this.cookieName,...this.cookieAliases])res.cookie(name,'',{...this.cookieOptions,expires:new Date(0),maxAge:0});
        for(const k of Object.keys(sessionTarget))delete sessionTarget[k];id=null;
      },enumerable:false,configurable:true},
      regenerate:{value:async()=>{if(id)await this.backend.destroy(id);id=null;markDirty();return id},enumerable:false,configurable:true}
    });
    req.session=proxy;Object.defineProperty(req,'sessionID',{get:()=>id,configurable:true});
    req._sessionState={get id(){return id},get dirty(){return dirty},get destroyed(){return destroyed},ensureId,markDirty,setSilent:(key,value)=>{sessionTarget[key]=value;return value},deleteSilent:(key)=>{delete sessionTarget[key];return true},markClean:()=>{dirty=false;req._sessionDirty=false}};
  }
  async save(id,data){
    const plain={};for(const [k,v] of Object.entries(data||{}))if(!INTERNAL.has(k))plain[k]=v;
    if(plain.user&&!Number(plain.$userLoadedAt||0))plain.$userLoadedAt=this._freshUserLoadedAt(this._userId(plain));
    plain.expiresAt=Date.now()+this.timeout*60*1000;
    return this.backend.save(id,plain,{ttlMs:this.timeout*60*1000});
  }
  async commitAsync(req){
    if(!this.enabled||!req.session||req._sessionState?.destroyed||!req._sessionState?.dirty){this.metrics.skippedCommits++;return false}
    const id=req._sessionState.ensureId();await this.save(id,req.session);req._sessionState?.markClean?.();this.metrics.commits++;return true;
  }
  async hydrateIdentity(req,context={}){
    const existing=req.session?.user||null,ref=req.session?.identityRef;
    if(existing&&this.identityHydration!=='always'){req.user=existing;return req.user}
    if(!ref||!this.identity){req.user=existing;return req.user}
    const user=await this.identity.load(ref,{req,session:req.session,...context});
    const uid=user?.id??user?._id??req.session?.user_id??ref?.id??null,loadedAt=this._freshUserLoadedAt(uid);
    if(user){
      if(req._sessionState?.setSilent){req._sessionState.setSilent('user',user);req._sessionState.setSilent('$userLoadedAt',loadedAt);req._sessionState.markDirty?.()}
      else{req.session.user=user;req.session.$userLoadedAt=loadedAt}
      req.user=user;
    }else{
      if(req._sessionState?.deleteSilent){req._sessionState.deleteSilent('user');req._sessionState.setSilent('$userLoadedAt',loadedAt);req._sessionState.markDirty?.()}
      else{delete req.session.user;req.session.$userLoadedAt=loadedAt}
      req.user=null;
    }
    this.metrics.identityRefreshes++;return req.user;
  }
  async setIdentity(req,ref,user=null,context={}){
    req.session.identityRef=ref||null;if(user){req.session.user=user;req.user=user;if(this.identity&&ref)await this.identity.save(ref,user,{req,session:req.session,...context})}return req.user||null;
  }
  async clearIdentity(req,context={}){
    const ref=req.session?.identityRef;if(this.identity&&ref)await this.identity.clear(ref,{req,session:req.session,...context});
    delete req.session.identityRef;delete req.session.user;req.user=null;return true;
  }
  touch(req){if(!this.enabled||!req.session)return false;req._sessionState?.markDirty?.();return true}
  stats(){return{...this.metrics,enabled:this.enabled,distributed:true,userInvalidationCache:this.userInvalidationCache.size,userInvalidationCheckIntervalMs:this.userInvalidationCheckIntervalMs,userInvalidationTtlMs:this.userInvalidationTtlMs}}
}

module.exports={AsyncSessionStore};
