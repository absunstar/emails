'use strict';




const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Router } = require('./router');
const { enhanceRequest, readBody } = require('./request');
const { enhanceResponse, mime } = require('./response');
const { SessionStore } = require('./session');
const { JsonCollection } = require('./collection');
const {OrmProviderRegistry}=require('./orm');
const {createCoreProvider}=require('./orm-core-provider');
const { renderFile, renderString } = require('./template');
const { MemoryCache } = require('./cache');
const { FileCacheEngine } = require('./file-cache');
const { createFiles } = require('./files');
const { AsyncPool,BackpressureQueue,AdaptiveCache } = require('./core-compat');
const { IdentityProviders } = require('./identity');
const asyncUtils = require('./async-utils');
const { RequestTelemetry } = require('./request-telemetry');
const valueTools = require('./value-tools');
const { Scheduler } = require('./scheduler');
const { Hooks } = require('./hooks');
const { ResponseCache } = require('./response-cache');
const { CompressionCache } = require('./compression-cache');
const { InvalidationCoordinator, connectFileCache } = require('./invalidation');
const { MemoryPressureController } = require('./memory-pressure');
const { QueryShapes } = require('./query-shapes');
const { Inflight } = require('./inflight');
const { FeatureRegistry } = require('./feature-registry');
const streamTools = require('./stream-tools');
const { QueryCache,QueryPlan } = require('./query-cache');
const httpCacheTools = require('./http-cache');
const { RateLimiter } = require('./rate-limit');
const { Logger } = require('./logger');
const { handleUpgrade } = require('./websocket');
const { Metrics } = require('./metrics');
const {ConfigManager}=require('./config');
const schemaTools = require('./schema');
const securityTools = require('./security');
const { createSecurity } = require('./security');
const { AppLoader } = require('./app-loader');
const compatAudit = require('./compat-audit');
const utils = require('./utils');

const PLUGIN_SCOPE=Symbol.for('@social-browser/core.pluginScope');
function invokeLifecycleHook(fn,args=[]){
  if(typeof fn!=='function')return Promise.resolve();
  if(fn.length>args.length)return new Promise((resolve,reject)=>{
    let settled=false;
    const done=(err,value)=>{if(settled)return;settled=true;err?reject(err):resolve(value)};
    try{const out=fn(...args,done);if(out&&typeof out.then==='function')out.then(v=>done(null,v),done)}catch(e){done(e)}
  });
  return Promise.resolve().then(()=>fn(...args));
}
function pluginScopeChain(scope){
  const chain=[];let current=scope;
  while(current&&current.encapsulated){chain.push(current);current=current.parent}
  return chain.reverse();
}
function lifecycleHookList(site,name,scope=null,{includeGlobal=true}={}){
  const list=[];
  if(includeGlobal)list.push(...(site.hooks?.map?.get(name)||[]));
  for(const item of pluginScopeChain(scope)){
    const row=item._pluginRow;
    list.push(...(row?.hooks?.get(name)||[]));
  }
  return list;
}
function hasHttpLifecycleHooks(site,name,scope=null,{includeGlobal=true}={}){
  return lifecycleHookList(site,name,scope,{includeGlobal}).length>0;
}
async function runHttpLifecycleHooks(site,name,req,res,scope=null,{includeGlobal=true,allowEnded=false,args=null}={}){
  const hookArgs=args||[req,res];
  for(const fn of lifecycleHookList(site,name,scope,{includeGlobal})){
    await invokeLifecycleHook(fn,hookArgs);
    if((!allowEnded&&res.writableEnded)||req.__coreStopLifecycle)return false;
  }
  return true;
}
async function runHttpPayloadHooks(site,name,req,res,payload,scope=null,{includeGlobal=true}={}){
  let value=payload;
  for(const fn of lifecycleHookList(site,name,scope,{includeGlobal})){
    const out=await invokeLifecycleHook(fn,[req,res,value]);
    if(out!==undefined)value=out;
    if(req.__coreStopLifecycle)break;
  }
  return value;
}


const PRODUCTION_FILE_CACHE_DEFAULTS=Object.freeze({
  enabled:true,
  mode:'production',
  validation:'manual',
  validateIntervalMs:0,
  maxEntries:20000,
  maxBytes:512*1024*1024,
  maxEntryBytes:8*1024*1024,
  maxCompiledEntries:8000,
  maxCompiledBytes:256*1024*1024,
  maxCompressedBytes:128*1024*1024,
  precompress:true,
  prewarm:true,
  prewarmExtensions:['.html','.htm','.css','.js','.mjs','.cjs','.json','.xml','.txt','.svg','.woff','.woff2']
});

function resolveRuntimeOptions(input={}){
  const raw={...(input||{})};
  const explicitMode=raw.mode||raw.environment||raw.env||process.env.NODE_ENV;
  const mode=String(explicitMode||'production').toLowerCase();
  const development=mode==='development'||mode==='dev';

  const fileInput=raw.fileCache||raw.filesCache||{};
  const fileCache=development
    ? {
        enabled:true,
        mode:'development',
        validation:'mtime',
        validateIntervalMs:200,
        maxEntries:15000,
        maxBytes:256*1024*1024,
        maxEntryBytes:8*1024*1024,
        maxCompiledEntries:5000,
        maxCompiledBytes:128*1024*1024,
        prewarm:false,
        ...fileInput
      }
    : {...PRODUCTION_FILE_CACHE_DEFAULTS,...fileInput,mode:fileInput.mode||'production'};

  const tracingInput=raw.tracing||raw.observability?.tracing||{};
  const loggerInput=raw.logger||{};
  const responseCacheInput=raw.responseCache||{};
  const securityShieldInput=raw.securityShield||{};

  return {
    ...raw,
    mode,
    environment:raw.environment||mode,
    fileCache,
    responseCache:{
      max:5000,
      maxBytes:128*1024*1024,
      ttlMs:0,
      ...responseCacheInput
    },
    cache:{
      enabled:true,
      html:0,
      txt:60*24*30*12,
      js:60*24*30*12,
      css:60*24*30*12,
      fonts:60*24*30*12,
      images:60*24*30*12,
      json:60*24*30*12,
      xml:60*24*30*12,
      ...(raw.cache||{})
    },
    tracing:{
      enabled:development ? (tracingInput.enabled!==false) : (tracingInput.enabled===true),
      max:development?2000:500,
      ...tracingInput
    },
    logger:{
      level:development?'info':'warn',
      json:development?false:true,
      ...loggerInput
    },
    events:{
      maxListeners:256,
      ...(raw.events||{})
    },
    securityShield:{
      maxHeadersCount:100,
      maxHeaderBytes:32768,
      headersTimeoutMs:60000,
      requestTimeoutMs:60000,
      keepAliveTimeoutMs:65000,
      socketIdleTimeoutMs:70000,
      maxRequestsPerSocket:10000,
      ...securityShieldInput
    },
    session:{
      identityHydration:'session-first',
      lazy:true,
      persistence:'sync',
      flushIntervalMs:100,
      maxDirty:128,
      maxMemorySessions:100000,
      cleanupIntervalMs:60000,
      ...(raw.session||{})
    },
    memoryPressure:{
      enabled:development ? raw.memoryPressure?.enabled===true : raw.memoryPressure?.enabled!==false,
      intervalMs:15000,
      ...(raw.memoryPressure||{})
    },
    runtimeProfile:development?'development':'production'
  };
}


function defineLazySiteValue(site,name,loader){
  site._lazyValues ||= new Map();
  const state={name,loader,loading:false,loaded:false,value:undefined,loadedAt:0};
  site._lazyValues.set(name,state);
  Object.defineProperty(site,name,{
    configurable:true,enumerable:true,
    get(){
      if(state.loaded)return state.value;
      if(state.loading)return state.value;
      state.loading=true;
      try{
        state.value=loader();
        state.loaded=true;state.loadedAt=Date.now();
        Object.defineProperty(site,name,{configurable:true,enumerable:true,writable:true,value:state.value});
        return state.value;
      }finally{state.loading=false}
    },
    set(next){
      state.value=next;state.loaded=true;state.loadedAt=Date.now();
      Object.defineProperty(site,name,{configurable:true,enumerable:true,writable:true,value:next});
    }
  });
  return state;
}
function lazySiteValue(site,name){
  const state=site._lazyValues?.get(name);
  return state?.loaded?state.value:undefined;
}
function lazySiteStatus(site){
  return Object.fromEntries([...(site._lazyValues||[])].map(([name,state])=>[name,{loaded:state.loaded,loadedAt:state.loadedAt||null}]));
}

function createSite(options = {}) {
  options = resolveRuntimeOptions(options);
  const site = new EventEmitter();
  site.setMaxListeners(Math.max(10,Number(options.events?.maxListeners||256)));
  site.version = '6.10.2';
  site.packageName = '@social-browser/core';
  site.mode = options.mode;
  site.runtimeProfile = options.runtimeProfile;
  site.production = site.runtimeProfile === 'production';
  site.development = site.runtimeProfile === 'development';
  site.name = options.name || 'social-browser-core';
  site.options = options;
  site.setting = options;
  site.router = new Router();
  site.cache = new MemoryCache(options.memoryCache||options.runtimeCache||{});
  site.fileCache = new FileCacheEngine(options.fileCache||options.filesCache||{});
  site.config = new ConfigManager(options,options.config||{});

defineLazySiteValue(site,'distributed',()=>{
  const {MemoryCache:DistributedMemoryCache,LockManager,IdempotencyStore,LeaderElection}=require('./distributed');
  const {DistributedSessionStore}=require('./distributed-session');
  const d={};
  d.cache=new DistributedMemoryCache(options.distributed?.cache||{});
  d.locks=new LockManager(d.cache,options.distributed?.locks||{});
  d.idempotency=new IdempotencyStore(d.cache,options.distributed?.idempotency||{});
  d.sessions=new DistributedSessionStore(d.cache,options.distributed?.sessions||{});
  d.leader=new LeaderElection(d.locks,options.distributed?.leader||{});
  d.rateLimit=async(key,limit,windowMs=60000)=>{
    const cache=d.cache;
    if(typeof cache.increment!=='function')throw Object.assign(new Error('Cache adapter requires atomic increment for distributed rate limits'),{code:'DISTRIBUTED_INCREMENT_REQUIRED'});
    const count=await cache.increment(`__rate:${key}`,1,{ttlMs:windowMs});
    return {allowed:count<=limit,count,limit,remaining:Math.max(0,limit-count),windowMs};
  };
  return d;
});
site.useDistributedSessions=(backend=null,sessionOptions={})=>{
  if(site.compatibility?.isite)throw Object.assign(new Error('Distributed Native sessions cannot replace the iSite compatibility SessionStore'),{code:'ISITE_SESSION_STORE_CONFLICT'});
  const {AsyncSessionStore}=require('./async-session-store');
  backend ||= site.distributed.sessions;
  site.sessionStore=new AsyncSessionStore(backend,{...(options.session||{}),...sessionOptions},site.identity);
  return site;
};
site.setDistributedCache=(adapter)=>{
  if(!adapter||typeof adapter.get!=='function'||typeof adapter.set!=='function'||typeof adapter.delete!=='function')
    throw Object.assign(new Error('Distributed cache adapter requires get/set/delete'),{code:'DISTRIBUTED_ADAPTER_INVALID'});
  const {LockManager,IdempotencyStore,LeaderElection}=require('./distributed');
  const {DistributedSessionStore}=require('./distributed-session');
  const d=site.distributed;
  d.cache=adapter;
  d.locks=new LockManager(adapter,options.distributed?.locks||{});
  d.idempotency=new IdempotencyStore(adapter,options.distributed?.idempotency||{});
  d.sessions=new DistributedSessionStore(adapter,options.distributed?.sessions||{});
  d.leader=new LeaderElection(d.locks,options.distributed?.leader||{});
  return site;
};

defineLazySiteValue(site,'eventsBus',()=>{
  const {PlatformEventBus}=require('./platform-events');
  return new PlatformEventBus(options.events||{});
});
site.setEventAdapter=(adapter)=>{site.eventsBus.adapter=adapter;return site};
site.publish=(topic,payload,meta={})=>site.eventsBus.publish(topic,payload,meta);
site.subscribe=(topic,fn)=>site.eventsBus.subscribe(topic,fn);

defineLazySiteValue(site,'plugins',()=>{
  const {PluginManager}=require('./plugins');
  return new PluginManager(site);
});

// Native plugin registration surface. `register()` intentionally has real
// lifecycle semantics (dependency ordering + async boot); it is not a cosmetic
// alias. This keeps the API familiar to Fastify/Hapi users while preserving
// Core's own PluginManager as the implementation.
site.register = (plugin, pluginOptions={}) => {
  site.plugins.register(plugin, pluginOptions);
  site._pluginsDirty = true;
  return site;
};
site.registerPlugin = site.register;
site.addPlugin = site.register;
site.hasPlugin = name => site.plugins.has(name);
site.getPlugin = name => site.plugins.get(name);
site.pluginList = () => site.plugins.list();
site.bootPlugins = async () => {
  if(site._pluginBootPromise)return site._pluginBootPromise;
  site._pluginBootPromise=(async()=>{
    try{return await site.plugins.enableAll()}
    finally{site._pluginsDirty=false;site._pluginBootPromise=null}
  })();
  return site._pluginBootPromise;
};
site.ready = (callback) => {
  const promise=site.bootPlugins().then(()=>site);
  if(typeof callback==='function'){
    promise.then(value=>callback(null,value),err=>callback(err));
    return site;
  }
  return promise;
};
site.after = (callback) => {
  if(typeof callback!=='function')return site;
  site.ready().then(()=>callback(null,site),err=>callback(err));
  return site;
};
defineLazySiteValue(site,'jobs',()=>{
  const {JobQueue}=require('./jobs');
  const queue=new JobQueue(site,options.jobs||{});
  if(options.jobs?.autoStart!==false)queue.start();
  return queue;
});
defineLazySiteValue(site,'openapi',()=>{
  const {OpenApiRegistry}=require('./openapi');
  return new OpenApiRegistry(site,options.openapi||{});
});
defineLazySiteValue(site,'cluster',()=>{
  const {ClusterRuntime}=require('./cluster-runtime');
  return new ClusterRuntime(site,options.cluster||{});
});
  site.identity = new IdentityProviders();
  site.async = asyncUtils;
  site.requestTelemetry = new RequestTelemetry({enabled:options.requestTelemetry?.enabled===true,max:options.requestTelemetry?.max||1000});
  site.values = valueTools;
  site.clone = valueTools.clone;
  site.stableStringify = valueTools.stableStringify;
  site.deepMerge = valueTools.deepMerge;
  site.pick = valueTools.pick;
  site.omit = valueTools.omit;
  site.numberWords = valueTools.numberToArabicWords;
  site.scheduler = new Scheduler();
  site.hooks = new Hooks();
  // Fastify-familiar lifecycle hook surface. The existing Hooks registry remains
  // the single implementation, while addHook/onHook expose HTTP lifecycle names.
  site.addHook=(name,fn)=>{if(!name||typeof fn!=='function')throw new Error('Hook name and function are required');site.hooks.on(String(name),fn);return site};
  site.onHook=site.addHook;site.hook=site.addHook;
  site.removeHook=(name,fn)=>{site.hooks.off(String(name),fn);return site};
  site.hasHook=name=>(site.hooks.map.get(String(name))||[]).length>0;
  site.responseCache = new ResponseCache(options.responseCache||{});
  site.compressionCache = new CompressionCache(options.compressionCache||{});
  site.invalidation = new InvalidationCoordinator({
    onError:(error,meta)=>site.logger?.warn?.('cache invalidation handler failed',{error:error?.message,...meta})
  });
  site._disconnectFileInvalidation = connectFileCache(site.fileCache,site.invalidation);
  site.invalidation.subscribe('response-cache',{
    priority:100,
    invalidate:file=>site.responseCache.invalidateDependency(String(file)),
    clear:()=>site.responseCache.clear()
  });
  site.cachedResponse = (key,producer,cacheOptions={}) => site.responseCache.getOrSet(
    typeof key==='string'?key:site.responseCache.key(key),
    producer,
    cacheOptions
  );
  site.cachedResponseFor = (req,key,producer,cacheOptions={}) => {
    const scoped=site.responseCache.scopedKey(req,key,cacheOptions);
    return site.responseCache.getOrSet(scoped,producer,cacheOptions);
  };
  site.invalidateResponseTag = tag => site.responseCache.invalidateTag(tag);
  site.invalidateResponseDependency = dep => site.responseCache.invalidateDependency(dep);
  site.queryShapes = new QueryShapes();
  site.orm = new OrmProviderRegistry(site,options.orm||options.database||{});
  site.orm.register('core',createCoreProvider,{builtin:true,driver:null,document:true});
  site.orm.register('mongodb',(...args)=>require('./orm-mongodb-provider').createMongoProvider(...args),{builtin:true,driver:'mongodb',optional:true,document:true});
  site.orm.register('postgres',(...args)=>require('./orm-sql-provider').createPostgresProvider(...args),{builtin:true,driver:'pg',optional:true,document:true,sql:true});
  site.orm.register('postgresql',(...args)=>require('./orm-sql-provider').createPostgresProvider(...args),{builtin:true,driver:'pg',optional:true,document:true,sql:true});
  site.orm.register('mysql',(...args)=>require('./orm-sql-provider').createMysqlProvider(...args),{builtin:true,driver:'mysql2',optional:true,document:true,sql:true});
  site.orm.register('sqlite',(...args)=>require('./orm-sql-provider').createSqliteProvider(...args),{builtin:true,driver:'better-sqlite3',optional:true,document:true,sql:true});
  site.registerDatabaseProvider=(name,factory,meta={})=>{site.orm.register(name,factory,meta);return site};
  site.databaseProviders=()=>site.orm.names().map(name=>site.orm.info(name));
  site.databaseProviderStatus=(name)=>site.orm.driverStatus(name);
  site.databaseProviderStatuses=()=>site.orm.statuses();
  defineLazySiteValue(site,'migrations',()=>new (require('./migrations').MigrationManager)(site));
  site.schema={diff:(...args)=>require('./migrations').diffSchemas(...args)};
  site.databaseHealth=async(name,opts={})=>{
    const provider=String(name||site.orm.defaultProvider||'core').toLowerCase();
    const status=site.databaseProviderStatus(provider);
    const started=Date.now();
    if(!status)return {provider,status:'UNKNOWN',ok:false,latencyMs:0};
    if(!status.driverInstalled)return {provider,status:'DRIVER_UNAVAILABLE',ok:false,latencyMs:0,driver:status.driver};
    const probe=opts.collection||`__sb_health_${provider}`;
    try{
      const col=site.connectCollection(probe,{provider,...(opts.collectionOptions||{})});
      await Promise.race([
        Promise.resolve(col.ready()),
        new Promise((_,reject)=>setTimeout(()=>reject(Object.assign(new Error('health timeout'),{code:'DB_HEALTH_TIMEOUT'})),Number(opts.timeout||3000)))
      ]);
      return {provider,status:'UP',ok:true,latencyMs:Date.now()-started,driver:status.driver||'builtin'};
    }catch(e){
      return {provider,status:'DOWN',ok:false,latencyMs:Date.now()-started,driver:status.driver||'builtin',code:e.code||null,error:e.message};
    }
  };

  site.models=new Map();
  site.defineModel=(name,definition={})=>{
    if(!name)throw new Error('Model name is required');
    const def={...definition,name:String(name)};
    site.models.set(String(name),def);
    return {
      name:String(name),
      definition:def,
      collection:(overrides={})=>site.connectCollection(String(name),{...def,...overrides})
    };
  };
  site.getModel=(name)=>site.models.get(String(name))||null;

  site.connectDatabase=(provider,providerOptions={})=>({
    provider:String(provider||site.orm.defaultProvider).toLowerCase(),
    collection:(name,opts={})=>site.connectCollection(name,{...opts,provider,providerOptions:{...providerOptions,...(opts.providerOptions||{})}})
  });


  site.inflight = new Inflight();
  site.features = new FeatureRegistry();
  site.queryCache = new QueryCache(options.queryCache||{});
  site.queryPlan = new QueryPlan(options.queryPlan||{});
  site.eventBus = new EventEmitter();
  site.streamTools = streamTools;
  site.httpCacheTools = httpCacheTools;
  site.files = createFiles(site);
  site.AsyncPool = AsyncPool;
  site.BackpressureQueue = BackpressureQueue;
  site.AdaptiveCache = AdaptiveCache;
  site.context = {
    create(seed={}){ return Object.assign(Object.create(null),seed,{site}); },
    run(seed,fn){ return fn(site.context.create(seed)); }
  };
  site.compatibility = {};
  site.useCompatibility = (name,opts={}) => {
    if(name !== 'isite') throw new Error(`Unknown compatibility layer: ${name}`);
    return require('../compat/isite').install(site,opts);
  };
  site.removeCompatibility = (name) => {
    if(name !== 'isite') throw new Error(`Unknown compatibility layer: ${name}`);
    return require('../compat/isite').uninstall(site);
  };
  site.metrics = new Metrics();
  defineLazySiteValue(site,'tracer',()=>{
    const {Tracer}=require('./observability');
    return new Tracer(options.tracing||options.observability?.tracing||{});
  });
  defineLazySiteValue(site,'resilience',()=>{
    const {ResilienceRegistry}=require('./resilience');
    return new ResilienceRegistry(options.resilience||{});
  });
  site._draining=false;
  site._stopping=false;
  site._connections=new Set();
  site._startedAt=Date.now();
  site.lifecycle={state:'created',startedAt:null,drainingAt:null,stoppedAt:null};
  site.shutdownHooks=[];
  site.onShutdown=(fn)=>{if(typeof fn==='function')site.shutdownHooks.push(fn);return site};
  site.installSignalHandlers=(signalOptions={})=>{
    if(site._signalHandlersInstalled)return site;
    site._signalHandlersInstalled=true;
    const signals=Array.isArray(signalOptions.signals)&&signalOptions.signals.length
      ? signalOptions.signals
      : ['SIGTERM','SIGINT'];
    site._signalHandlers=[];
    for(const signal of signals){
      const handler=async()=>{
        try{await site.stop({forceAfterMs:signalOptions.forceAfterMs||5000})}
        finally{if(signalOptions.exit!==false)process.exit(0)}
      };
      process.once(signal,handler);
      site._signalHandlers.push([signal,handler]);
    }
    return site;
  };
  site.removeSignalHandlers=()=>{
    for(const [signal,handler] of site._signalHandlers||[])process.removeListener(signal,handler);
    site._signalHandlers=[];site._signalHandlersInstalled=false;return site;
  };
  site.withRetry=(name,fn,opts={})=>site.resilience.execute(name,fn,opts);
  site.databaseOperation=(provider,kind,fn,opts={})=>{
    const safeRead=['read','health','metadata'].includes(String(kind));
    return site.withRetry(`db.${provider}.${kind}`,fn,{
      retries:safeRead?(opts.retries??options.resilience?.databaseReadRetries??2):(opts.retries??0),
      ...opts
    });
  };
  site.trace=(name,attributes={},parent=null)=>site.tracer.start(name,attributes,parent);
  site.prometheusMetrics=()=>{
    const fc=site.fileCache.stats();
    const {prometheus}=require('./observability');
    return prometheus(site.metrics,{
      core_draining:site._draining,
      core_connections:site._connections.size,
      core_servers:site.servers.length,
      core_collections:site.collections.size,
      core_file_cache_entries:fc.entries,
      core_file_cache_bytes:fc.bytes,
      core_file_cache_hits:fc.hits,
      core_file_cache_misses:fc.misses,
      core_file_cache_compiled_entries:fc.compiledEntries,
      core_file_cache_compiled_hits:fc.compiledHits,
      core_file_cache_compiled_misses:fc.compiledMisses
    });
  };
  site.schema = {...schemaTools,diff:(...args)=>require('./migrations').diffSchemas(...args)};
  site.security = createSecurity(options.security||{});
  site.securityTools = securityTools;
  site.compatAudit = compatAudit;
  site.logger = new Logger(options.log === false ? {enabled:false,prefix:'social-browser-core'} : {prefix:'social-browser-core',...(options.logger || {})});
  site.log = (...args) => site.logger.info(...args);
  site.rateLimiters = new Map();
  site.wsRoutes = [];
  site.servers = [];
  site.apps = [];
  site.appLoader = new AppLoader(site);

  site.collectionList = [];
  site.collections = new Map();
  site.storage = { engines: site.collections };
  site.cwd = path.resolve(options.cwd || process.cwd());
  options.cwd = site.cwd;
  site.dir = options.dir || path.join(site.cwd, 'site_files');
  site.fs = fs; site.path = path; site.http = http; site.https = https;
  site.crypto = require('crypto');
  site.url = require('url');
  site.nodeEvents = require('events');
  site.nodeStream = require('stream');
  site.zlib = require('zlib');
  site.util = require('util');

  site.toNumber = utils.toNumber;
  site.toDate = utils.toDate;
  site.getDate = () => new Date();
  site.getDateTime = () => new Date().toISOString();
  site.fromJson = utils.fromJson;
  site.fromBase64 = v => Buffer.from(String(v), 'base64').toString('utf8');
  site.toBase64 = v => Buffer.from(String(v)).toString('base64');

  // Stable native codec namespace used by Social Browser persisted state and IPC.
  // This preserves the historical numeric-Base64 wire/storage format without
  // requiring the iSite compatibility layer or its legacy global aliases.
  const numericBase64Letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const numericBase64Numbers = [];
  for (let i = 11; i < 99; i++) if (i % 10 !== 0 && i % 11 !== 0) numericBase64Numbers.push(i);
  const encodeNumericBase64 = value => {
    if (value === undefined) return '';
    let data = value;
    if (typeof data === 'object') data = JSON.stringify(data);
    const base64 = Buffer.from(String(data)).toString('base64');
    let out = '';
    for (const ch of base64) {
      const idx = numericBase64Letters.indexOf(ch);
      if (idx < 0 || idx >= numericBase64Numbers.length) return '';
      out += String(numericBase64Numbers[idx]);
    }
    return out;
  };
  const decodeNumericBase64 = value => {
    if (!value) return '';
    if (typeof value !== 'string') value = String(value);
    if (value.length % 2 !== 0) return '';
    let base64 = '';
    for (let i = 0; i < value.length; i += 2) {
      const n = Number(value.slice(i, i + 2));
      const idx = numericBase64Numbers.indexOf(n);
      if (idx < 0 || idx >= numericBase64Letters.length) return '';
      base64 += numericBase64Letters[idx];
    }
    try { return Buffer.from(base64, 'base64').toString(); } catch { return ''; }
  };
  const decodeHiddenObject = value => {
    const text = decodeNumericBase64(value);
    if (!text) return {};
    try { return JSON.parse(text); } catch { return {}; }
  };
  site.codecs = Object.freeze({
    numericBase64: Object.freeze({ encode: encodeNumericBase64, decode: decodeNumericBase64 }),
    hiddenObject: Object.freeze({ encode: encodeNumericBase64, decode: decodeHiddenObject }),
  });
  const patternEscape = value => String(value ?? '').replace(/[\/\\^$*+?.()\[\]{}]/g, '\\$&');
  const patternTest = (input, pattern, flags='gium') => {
    try { return new RegExp(pattern, flags).test(String(input)); } catch { return false; }
  };
  const patternLike = (input, value) => {
    if (typeof value === 'number') value = String(value);
    else if (typeof value !== 'string') return false;
    input = String(input);
    return value.split('|').some(part => {
      const pattern = part.split('*').map(patternEscape).join('.*');
      try { return new RegExp('^' + pattern + '$', 'ium').test(input); } catch { return false; }
    });
  };
  const patternContains = (input, value='') => {
    if (typeof value === 'number') value = String(value);
    else if (typeof value !== 'string') return false;
    input = String(input);
    return value.split('|').some(part => {
      if (!part) return false;
      try { return new RegExp('^.*' + patternEscape(part) + '.*$', 'ium').test(input); } catch { return false; }
    });
  };
  site.patterns = Object.freeze({ test: patternTest, like: patternLike, contains: patternContains, contain: patternContains });

  // Native String pattern helpers. These are part of the Core public runtime, not
  // the optional iSite compatibility layer. Keep them non-enumerable so normal
  // object/string iteration is unaffected, while legacy and extension code can use
  // the concise String API directly. All helpers delegate to the same Native
  // pattern engine above, so there is one source of matching semantics.
  const defineNativeStringPatternHelper = (name, fn) => {
    if (!Object.getOwnPropertyDescriptor(String.prototype, name)) {
      Object.defineProperty(String.prototype, name, {
        value: fn, writable: true, configurable: true, enumerable: false
      });
    }
  };
  defineNativeStringPatternHelper('test', function(pattern, flags='gium') {
    return patternTest(this, pattern, flags);
  });
  defineNativeStringPatternHelper('like', function(value) {
    return patternLike(this, value);
  });
  defineNativeStringPatternHelper('contains', function(value='') {
    return patternContains(this, value);
  });
  defineNativeStringPatternHelper('contain', function(value='') {
    return patternContains(this, value);
  });
  site.md5 = utils.md5;
  site.sha256 = utils.sha256;
  site.random = (n=16) => utils.randomId(Math.ceil(n/2)).slice(0,n);
  site.escapeHtml = utils.escapeHtml;
  site.escapeXML = utils.escapeHtml;
  site.removeHtml = v => String(v ?? '').replace(/<[^>]*>/g, '');
  site.typeOf = site.typeof;
  site.regex = (text, flags='gium') => {
    try { return new RegExp(text, flags); } catch { return null; }
  };
  site.fetch = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;
  site.request = async (url, options={}) => {
    if(!site.fetch) throw new Error('fetch unavailable');
    return site.fetch(url,options);
  };
  site.escapeRegx = v => String(v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  site.typeof = v => Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
  site.objectDiff = (a,b) => {
    const out = {};
    for (const k of new Set([...Object.keys(a||{}),...Object.keys(b||{})]))
      if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) out[k] = {old:a?.[k],new:b?.[k]};
    return out;
  };

  // Production high-level reads are cache-first by default. Raw disk access remains
  // explicitly available for callers that intentionally need to bypass the cache.
  site.readFileRaw = (file, enc='utf8') => fs.promises.readFile(file, enc);
  site.readFileRawSync = (file, enc='utf8') => fs.readFileSync(file, enc);
  site.readBufferRaw = file => fs.promises.readFile(file);
  site.readBufferRawSync = file => fs.readFileSync(file);
  site.readFile = (file, enc='utf8') => site.fileCache.getText(file,enc);
  site.readFileSync = (file, enc='utf8') => site.fileCache.getTextSync(file,enc);
  site.readFileCached = site.readFile;
  site.readFileCachedSync = site.readFileSync;
  site.readBuffer = file => site.fileCache.getBuffer(file);
  site.readBufferSync = file => site.fileCache.getBufferSync(file);
  site.readBufferCached = site.readBuffer;
  site.readBufferCachedSync = site.readBufferSync;
  site.invalidateFileCache = (file,opts={}) => site.fileCache.invalidate(file,opts);
  site.prewarmFiles = (targets,opts={}) => site.fileCache.prewarmSync(targets,opts);
  site.productionPrewarmTargets = () => {
    const out=new Set();
    const add=dir=>{try{if(dir&&site.fileCache.isDirectorySync(dir))out.add(path.resolve(dir))}catch{}};
    add(site.dir);add(path.join(site.cwd,'site_files'));
    for(const app of site.apps||[])add(path.join(app.path||'', 'site_files'));
    try{for(const row of fs.readdirSync(path.join(site.cwd,'apps'),{withFileTypes:true}))if(row.isDirectory())add(path.join(site.cwd,'apps',row.name,'site_files'))}catch{}
    return [...out];
  };
  site.writeFile = async (file, data, enc='utf8') => {
    utils.ensureDir(path.dirname(file)); await fs.promises.writeFile(file, data, enc); site.fileCache.invalidate(file); return true;
  };
  site.writeFileSync = (file, data, enc='utf8') => {
    utils.ensureDir(path.dirname(file)); fs.writeFileSync(file, data, enc); site.fileCache.invalidate(file); return true;
  };
  site.writeJSON = (file, value, space=2) => site.files.writeJSON(file,value,space);
  site.writeJSONSync = (file, value, space=2) => site.files.writeJSONSync(file,value,space);
  site.readJSON = file => site.files.readJSON(file);
  site.readJSONSync = file => site.files.readJSONSync(file);
  site.createDir = utils.ensureDir;
  site.isFileExistsSync = file => site.fileCache.existsSync(file);
  site.statSync = file => site.fileCache.statSync(file);
  site.stat = async file => site.fileCache.statSync(file);
  site.deleteFileSync = file => { try { fs.unlinkSync(file); site.fileCache.invalidate(file); return true; } catch { return false; } };

  site.sessionStore = new SessionStore({
    ...(options.session || {}),
    cwd: site.cwd,
    dir: options.session?.dir || path.join(site.cwd, '.social-browser', 'sessions')
  }, site.identity);
  site.memoryPressure = new MemoryPressureController(site,options.memoryPressure||{});
  site.invalidateUserSessions = userId => site.sessionStore.invalidateUser?.(userId)||0;
  site.invalidateUserSessionsAsync = async userId => await (site.sessionStore.invalidateUser?.(userId)||0);

  const add = (method, pattern, handler) => {
    site.router.add(method, pattern, handler);
    return site;
  };
  // Raw route registrars. Public verb methods are wrapped below so both
  // Express-style (path, handler) and Core descriptor-style ({name,path,...})
  // use exactly the same normalization path.
  const rawGet = (p,h) => add('GET',p,h);
  const rawPost = (p,h) => add('POST',p,h);
  const rawPut = (p,h) => add('PUT',p,h);
  const rawPatch = (p,h) => add('PATCH',p,h);
  const rawDelete = (p,h) => add('DELETE',p,h);
  const rawHead = (p,h) => add('HEAD',p,h);
  const rawOptions = (p,h) => add('OPTIONS',p,h);
  const rawAll = (p,h) => add('ALL',p,h);

  // Explicit onVERB route APIs are first-class Native Core APIs. They are not
  // tied to iSite compatibility and intentionally coexist with get/post/etc.
  // In addition to the normal (pattern, handler) form, the onVERB family
  // accepts the compact descriptor form historically used by Social Browser
  // extensions, e.g. onGET({name:'/tool', path:'/abs/index.html'}).
  const nativeRouteDescriptorPatterns = descriptor => {
    if (typeof descriptor === 'string' || descriptor instanceof RegExp) return [descriptor];
    if (Array.isArray(descriptor)) return descriptor;
    if (descriptor && typeof descriptor === 'object') {
      const names = descriptor.name ?? descriptor.url ?? descriptor.route;
      return Array.isArray(names) ? names : (names == null ? [] : [names]);
    }
    return [];
  };
  const nativeRouteDescriptorHandler = descriptor => {
    if (!descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor)) return null;
    if (descriptor.content !== undefined) {
      return (_req,res) => {
        if (descriptor.headers) for (const [k,v] of Object.entries(descriptor.headers)) res.setHeader(k,v);
        const value = typeof descriptor.content === 'function' ? descriptor.content(_req,res) : descriptor.content;
        if (value && typeof value.then === 'function') return value.then(v => {
          if (res.writableEnded || v === undefined) return res;
          if (v && typeof v === 'object' && !Buffer.isBuffer(v)) return res.json(v);
          return res.end(v == null ? '' : v);
        });
        if (res.writableEnded || value === undefined) return res;
        if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return res.json(value);
        return res.end(value == null ? '' : value);
      };
    }
    if (!descriptor.path) return null;
    if (Array.isArray(descriptor.path)) {
      const files = descriptor.path.map(file => path.resolve(String(file)));
      return (_req,res) => {
        try {
          if (descriptor.headers) for (const [k,v] of Object.entries(descriptor.headers)) res.setHeader(k,v);
          const chunks = files.map(file => site.fileCache?.getBufferSync ? site.fileCache.getBufferSync(file) : fs.readFileSync(file));
          return res.end(Buffer.concat(chunks.map(x => Buffer.isBuffer(x) ? x : Buffer.from(x))));
        } catch { return res.status(404).end('Not Found'); }
      };
    }
    const target = path.resolve(String(descriptor.path));
    let directory = false;
    try { directory = (site.fileCache?.statSync ? site.fileCache.statSync(target) : fs.statSync(target)).isDirectory(); } catch {}
    if (!directory) {
      return (_req,res) => {
        try {
          if (descriptor.headers) for (const [k,v] of Object.entries(descriptor.headers)) res.setHeader(k,v);
          return res.file(target);
        } catch { return res.status(404).end('Not Found'); }
      };
    }
    const bases = nativeRouteDescriptorPatterns(descriptor).map(base => String(base).replace(/\/+$/,'') || '/');
    return (req,res) => {
      try {
        let rel = '';
        for (const base of bases) {
          if (req.path === base || req.path.startsWith(base + '/')) { rel = req.path.slice(base.length).replace(/^\/+/, ''); break; }
        }
        const file = path.resolve(target, rel || 'index.html');
        if (file !== target && !file.startsWith(target + path.sep)) return res.status(403).end('Forbidden');
        if (descriptor.headers) for (const [k,v] of Object.entries(descriptor.headers)) res.setHeader(k,v);
        return res.file(file);
      } catch { return res.status(404).end('Not Found'); }
    };
  };
  const nativeOnRoute = register => (descriptor, handler) => {
    const actualHandler = typeof handler === 'function' ? handler : nativeRouteDescriptorHandler(descriptor);
    if (typeof actualHandler !== 'function') return site;
    const descriptorScope=descriptor&&typeof descriptor==='object'?descriptor[PLUGIN_SCOPE]:null;
    if(descriptorScope && !actualHandler[PLUGIN_SCOPE])try{Object.defineProperty(actualHandler,PLUGIN_SCOPE,{value:descriptorScope,enumerable:false,configurable:true})}catch{}
    const patterns = nativeRouteDescriptorPatterns(descriptor);
    for (const pattern of patterns) {
      register(pattern, actualHandler);
      if (descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor) && descriptor.path) {
        let isDir = false;
        try { isDir = (site.fileCache?.statSync ? site.fileCache.statSync(path.resolve(String(descriptor.path))) : fs.statSync(path.resolve(String(descriptor.path)))).isDirectory(); } catch {}
        if (isDir && typeof pattern === 'string') {
          const base = pattern.replace(/\/+$/,'') || '/';
          register(base === '/' ? '/*' : base + '/*', actualHandler);
        }
      }
    }
    return site;
  };
  // Public HTTP verb APIs are intentionally dual-form:
  //   site.get('/path', handler)                 // Express-compatible
  //   site.get({ name:'/path', path:'file' })    // Core descriptor
  // The explicit onVERB names are aliases to the same implementation.
  site.get = nativeOnRoute(rawGet);
  site.post = nativeOnRoute(rawPost);
  site.put = nativeOnRoute(rawPut);
  site.patch = nativeOnRoute(rawPatch);
  site.delete = nativeOnRoute(rawDelete);
  site.head = nativeOnRoute(rawHead);
  // `site.options` is the normalized Core configuration object, so using the
  // Express verb name here would destroy configuration state. Keep the route
  // registrar explicit instead of creating a dangerous alias.
  site.routeOptions = nativeOnRoute(rawOptions);
  site.optionsRoute = site.routeOptions;
  site.all = nativeOnRoute(rawAll);
  site.onGET = site.get;
  site.onPOST = site.post;
  site.onPUT = site.put;
  site.onPATCH = site.patch;
  site.onDELETE = site.delete;
  site.onHEAD = site.head;
  site.onOPTIONS = site.routeOptions;
  site.onALL = site.all;
  site.onANY = site.all;


  // Framework-familiar route surface. One implementation accepts:
  //   site.route('/users').get(handler).post(handler)     // Express style
  //   site.route({method:'GET', url:'/users', handler})   // Fastify style
  //   site.route({method:'GET', path:'/users', handler})  // Hapi style
  // Core static-file descriptors remain handled by site.get/onGET directly.
  site.route = (definition) => {
    if (typeof definition === 'string' || definition instanceof RegExp) {
      const pattern = definition;
      const chain = {};
      for (const verb of ['get','post','put','patch','delete','head','options','all']) {
        chain[verb] = (...handlers) => {
          const registrar = verb === 'options' ? site.routeOptions : site[verb];
          for (const handler of handlers.flat()) if (typeof handler === 'function') registrar(pattern, handler);
          return chain;
        };
      }
      chain.onGET = chain.get; chain.onPOST = chain.post; chain.onPUT = chain.put;
      chain.onPATCH = chain.patch; chain.onDELETE = chain.delete; chain.onHEAD = chain.head;
      chain.onOPTIONS = chain.options; chain.onALL = chain.all; chain.onANY = chain.all;
      return chain;
    }
    if (Array.isArray(definition)) { for (const item of definition) site.route(item); return site; }
    if (!definition || typeof definition !== 'object') return site;
    const methods = Array.isArray(definition.method) ? definition.method : [definition.method || definition.methods || 'GET'];
    const routePath = definition.url ?? definition.route ?? definition.name ?? definition.path;
    const handler = definition.handler ?? definition.handle;
    if (routePath == null || typeof handler !== 'function') return site;
    for (const method of methods.flat()) {
      const key = String(method || 'GET').toUpperCase();
      const verb = key === '*' || key === 'ANY' || key === 'ALL' ? 'all' : key.toLowerCase();
      const register = verb === 'options' ? site.routeOptions : site[verb];
      if (typeof register !== 'function') throw new Error(`Unsupported route method: ${key}`);
      register(routePath, handler);
    }
    return site;
  };
  site.addRoute = site.route;
  site.registerRoute = site.route;

  // Fastify-style decorators backed by simple Core-owned registries. They are
  // available natively and do not require a compatibility mode.
  site._requestDecorators = new Map();
  site._replyDecorators = new Map();
  site.decorate = (name, value) => {
    if (!name) throw new Error('Decorator name is required');
    if (Object.prototype.hasOwnProperty.call(site, name)) throw new Error(`Decorator already exists: ${name}`);
    Object.defineProperty(site, name, {value, writable:true, configurable:true, enumerable:true});
    return site;
  };
  site.hasDecorator = name => Object.prototype.hasOwnProperty.call(site, String(name));
  site.decorateRequest = (name, value) => { if (!name) throw new Error('Request decorator name is required'); site._requestDecorators.set(String(name), value); return site; };
  site.decorateReply = (name, value) => { if (!name) throw new Error('Reply decorator name is required'); site._replyDecorators.set(String(name), value); return site; };
  site.hasRequestDecorator = name => site._requestDecorators.has(String(name));
  site.hasReplyDecorator = name => site._replyDecorators.has(String(name));

  site.middlewares = [];
  site.rateLimit = (name='default', opts={}) => {
    if (!site.rateLimiters.has(name)) site.rateLimiters.set(name, new RateLimiter(opts));
    return site.rateLimiters.get(name);
  };
  site.rateLimitMiddleware = (opts={}) => {
    const limiter = site.rateLimit(opts.name || 'http', opts);
    return (req,res,next) => {
      const key = typeof opts.key === 'function' ? opts.key(req) : (req.ip || 'unknown');
      const hit = limiter.hit(key);
      res.setHeader('X-RateLimit-Limit', limiter.max);
      res.setHeader('X-RateLimit-Remaining', hit.remaining);
      res.setHeader('X-RateLimit-Reset', Math.ceil(hit.resetAt / 1000));
      if (!hit.allowed) return res.status(429).json({error:'Too Many Requests'});
      return next();
    };
  };

  site.use = fn => { site.middlewares.push(fn); return site; };
  site.middleware = site.use;
  site.addMiddleware = site.use;

  site.apiRoute=(method,routePath,contract,handler)=>{
    if(typeof contract==='function'){handler=contract;contract={}}
    contract=contract||{};
    site.openapi.route(method,routePath,contract);
    const verb=String(method||'GET').toLowerCase();
    const register=site[verb]||site.all;
    if(typeof register!=='function')throw new Error(`Unsupported API method: ${method}`);
    return register(routePath,async(req,res)=>{
      const checks=[
        ['body',req.body,contract.body],
        ['query',req.query,contract.query],
        ['params',req.params,contract.params]
      ];
      for(const [where,value,schema] of checks){
        if(!schema)continue;
        const result=site.openapi.validate(value,schema);
        if(!result.ok)return res.status(400).json({error:'VALIDATION_ERROR',where,details:result.errors});
      }
      const result=await handler(req,res);
      if(contract.response&&result!==undefined&&!res.writableEnded){
        const valid=site.openapi.validate(result,contract.response);
        if(!valid.ok)throw Object.assign(new Error('Response validation failed'),{code:'RESPONSE_VALIDATION_ERROR',details:valid.errors});
        return res.json(result);
      }
      return result;
    });
  };
  site.openapiDocument=(extra={})=>site.openapi.document(extra);
  site.enableOpenApiEndpoint=(endpoint='/openapi.json')=>{site.get(endpoint,(q,r)=>r.json(site.openapi.document()));return site};


  site.connectCollection = (name, opts={}) => {
    if(!name)throw new Error('Collection name is required');
    const modelDef=site.models?.get(String(name))||null;
    if(modelDef)opts={...modelDef,...opts};
    const provider=String(opts.provider||options.orm?.provider||options.database?.provider||'core').toLowerCase();
    const existing=site.collections.get(name);
    if(existing){
      if(existing.provider && existing.provider!==provider){
        const e=new Error(`Collection "${name}" is already connected with provider "${existing.provider}", cannot reconnect with "${provider}"`);
        e.code='ORM_COLLECTION_PROVIDER_CONFLICT';throw e;
      }
      return existing;
    }
    const col=site.orm.createCollection(name,{
      ...opts,
      provider,
      observeQuery:opts.observeQuery || ((query,meta)=>site.queryShapes.observe(query,meta))
    });
    site.collections.set(name,col);
    site.collectionList.push(col);
    return col;
  };
  site.model=site.connectCollection;

  site.renderString = renderString;
  site.render = (file, data={}, res) => {
    const resolved = path.isAbsolute(file) ? file : path.join(site.dir, file);
    const html = renderFile(resolved, data, {fileCache:site.fileCache});
    if (res) {
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(html);
      return res;
    }
    return html;
  };

  site.staticCacheControl = (file,routeCache=true) => {
    const cfg=options.cache||{};
    if(cfg.enabled===false||routeCache===false)return null;
    const ext=path.extname(String(file||'')).toLowerCase();
    let minutes=0;
    if(ext==='.html'||ext==='.htm')minutes=Number(cfg.html||0);
    else if(ext==='.css')minutes=Number(cfg.css||0);
    else if(ext==='.js'||ext==='.mjs'||ext==='.cjs')minutes=Number(cfg.js||0);
    else if(['.woff','.woff2','.ttf','.otf','.eot'].includes(ext))minutes=Number(cfg.fonts||0);
    else if(['.png','.jpg','.jpeg','.gif','.webp','.avif','.ico','.bmp','.svg'].includes(ext))minutes=Number(cfg.images||0);
    else if(ext==='.json')minutes=Number(cfg.json||0);
    else if(ext==='.xml')minutes=Number(cfg.xml||0);
    else if(ext==='.txt')minutes=Number(cfg.txt||0);
    if(minutes<=0)return 'no-cache';
    return `public, max-age=${Math.floor(minutes*60)}`;
  };

  site.static = (prefix='/', dir=site.dir, staticOptions={}) => {
    const root = path.resolve(dir);
    let rootReal=root;try{rootReal=site.fileCache.realpathSync(root)}catch{}
    site.get(prefix === '/' ? '*' : `${prefix.replace(/\/$/,'')}/*`, (req,res) => {
      const rel = prefix === '/' ? req.path : req.path.slice(prefix.length);
      let decoded;
      try{decoded=decodeURIComponent(rel || '/').replace(/^\/+/, '')}catch{return res.status(400).end('Bad Request')}
      const target = path.resolve(root, decoded || 'index.html');
      if (!target.startsWith(root + path.sep) && target !== root) return res.status(403).end('Forbidden');
      let file = target;
      try {
        if (site.fileCache.isDirectorySync(file)) file = path.join(file, 'index.html');
        const real=site.fileCache.realpathSync(file);
        if(real!==rootReal&&!real.startsWith(rootReal+path.sep))return res.status(403).end('Forbidden');
        file=real;
        const stat = site.fileCache.statSync(file);
        const ext = path.extname(file).toLowerCase();
        const etag = httpCacheTools.etagForStat(stat);
        const lastModified = stat.mtime.toUTCString();
        res.setHeader('Content-Type', mime[ext] || 'application/octet-stream');
        res.setHeader('ETag',etag);
        res.setHeader('Last-Modified',lastModified);
        res.setHeader('Accept-Ranges','bytes');
        const cacheControl=staticOptions.cacheControl??site.staticCacheControl(file,staticOptions.cache!==false);
        if(cacheControl)res.setHeader('Cache-Control',cacheControl);
        if (httpCacheTools.isFresh(req.headers,etag,lastModified)) {
          res.statusCode=304; res.removeHeader('Content-Length');res.end(); return;
        }

        const range=req.headers.range;
        const ifRange=req.headers['if-range'];
        const canRange=!ifRange||ifRange===etag||ifRange===lastModified;
        if(range&&canRange){
          const m=/^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
          if(m){
            let start=0,end=stat.size-1;
            if(m[1]===''&&m[2]!==''){
              const suffix=Number(m[2]);
              if(suffix<=0)return res.status(416).set('Content-Range',`bytes */${stat.size}`).end();
              start=Math.max(0,stat.size-suffix);
            }else{
              start=m[1]===''?0:Number(m[1]);
              end=m[2]===''?stat.size-1:Number(m[2]);
              if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<start||start>=stat.size){
                res.statusCode=416;res.setHeader('Content-Range',`bytes */${stat.size}`);res.setHeader('Content-Length','0');res.end();return;
              }
              end=Math.min(end,stat.size-1);
            }
            res.statusCode=206;
            res.setHeader('Content-Range',`bytes ${start}-${end}/${stat.size}`);
            res.setHeader('Content-Length',String(end-start+1));
            if(req.method==='HEAD')return res.end();
            const cached=stat.size<=site.fileCache.maxEntryBytes?site.fileCache.getBufferSync(file):null;
            if(cached){res.end(cached.subarray(start,end+1));return}
            fs.createReadStream(file,{start,end}).pipe(res);return;
          }
        }

        const compressible=/\.(?:css|js|mjs|cjs|json|xml|svg|txt)$/i.test(file);
        if(compressible&&stat.size<=site.fileCache.maxEntryBytes){
          const packed=site.fileCache.selectCompressedSync(file,req.headers['accept-encoding']);
          if(packed?.buffer){
            res.setHeader('Content-Encoding',packed.encoding);
            res.setHeader('Vary','Accept-Encoding');
            res.setHeader('Content-Length',packed.buffer.length);
            if(req.method==='HEAD')return res.end();
            res.end(packed.buffer);return;
          }
        }
        res.setHeader('Content-Length', stat.size);
        if(req.method==='HEAD')return res.end();
        if(stat.size<=site.fileCache.maxEntryBytes){res.end(site.fileCache.getBufferSync(file));return}
        fs.createReadStream(file).pipe(res);
      } catch { res.statusCode=404; res.end('Not Found'); }
    });
    return site;
  };

  site.loadLocalApp = (nameOrPath, opts={}) => site.appLoader.load(nameOrPath,opts)?.module || null;
  site.importApp = site.loadLocalApp;
  site.importApps = (dir=path.join(site.cwd,'apps'),opts={}) => site.appLoader.loadAll(dir,opts);
  site.reloadApp = (nameOrPath,opts={}) => site.appLoader.load(nameOrPath,{...opts,reload:true})?.module || null;
  site.unloadApp = (nameOrPath) => site.appLoader.unload(nameOrPath);




  site.onWS = (pattern, handler) => {
    const { compilePattern } = require('./router');
    site.wsRoutes.push({ pattern, handler, ...compilePattern(pattern) });
    return site;
  };
  site.websocket = site.onWS;

  site._attachUpgrade = (server) => {
    server.on('upgrade', async (req, socket, head) => {
      try {
        if(!site.securityShield.wsConnection(socket,req)) return;
        if(typeof site._isitePrepareWebSocketRequest==='function')await site._isitePrepareWebSocketRequest(req);
        const proto = req.socket.encrypted ? 'https:' : 'http:';
        const host = req.headers.host || 'localhost';
        const u = new URL(req.url || '/', `${proto}//${host}`);
        let found = null;
        const wsMatchPath=typeof site._isiteWebSocketMatchPath==='function'
          ? site._isiteWebSocketMatchPath(req,u)
          : u.pathname;
        for (const route of site.wsRoutes) {
          const m = route.regex.exec(wsMatchPath);
          if (m) { found = {route,m}; break; }
        }
        if (!found) {
        site.metrics.inc('http.notFound'); socket.destroy(); return; }
        req.params = {};
        found.route.keys.forEach((k,i)=> req.params[k] = decodeURIComponent(found.m[i+1] || ''));
        if(typeof site._isitePrepareWebSocketRequest!=='function')
          req.query = Object.fromEntries(u.searchParams.entries());
        handleUpgrade(req, socket, head, found.route.handler, options.webSocket||options.websocket||{});
      } catch (e) {
        site.logger.error(e);
        try { socket.destroy(); } catch {}
      }
    });
    return server;
  };


  async function dispatch(req, res) {
    if(site._pluginsDirty || site._pluginBootPromise) await site.bootPlugins();
    const requestStarted = performance.now();
    const span=site.trace('http.request',{method:req.method,url:req.url});
    if(site._draining){
      res.statusCode=503;res.setHeader('Connection','close');res.setHeader('Retry-After','1');
      res.end('Service Unavailable');
      span.setAttribute('draining',true).end();
      return;
    }
    site.metrics.inc('http.requests');
    site.metrics.inc('http.inflight');
    enhanceRequest(req, options.request || {});
    site.requestTelemetry.begin(req);
    enhanceResponse(res, site);
    for (const [name,value] of site._requestDecorators) if (!(name in req)) req[name] = value;
    for (const [name,value] of site._replyDecorators) if (!(name in res)) res[name] = value;
    if (!site.securityShield.checkRequest(req,res)) return;

    // Run global onRequest before body/session parsing. For native routes we can
    // also resolve the plugin scope at this point; compatibility runtimes may
    // remap paths later, so scoped onRequest is retried after final matching.
    let earlyFound=null;
    try{earlyFound=site.router.match(req.method,req.path)}catch{}
    const earlyScope=earlyFound?.route?.handler?.[PLUGIN_SCOPE]||null;
    if(!await runHttpLifecycleHooks(site,'onRequest',req,res,earlyScope,{includeGlobal:true}))return;
    req.__coreOnRequestScope=earlyScope||null;

    const runMiddleware = async (i) => {
      const fn = site.middlewares[i];
      if (!fn) return;
      let nextCalled = false;
      await fn(req, res, async () => { nextCalled = true; await runMiddleware(i+1); });
      return nextCalled;
    };

    try {
      await runMiddleware(0);
      if (res.writableEnded || req.__isiteStopRequest) return;

      if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
        req.body = await readBody(req, {cwd:site.cwd,...(options.request||{}),maxBodyBytes:Math.min(Number(options.request?.maxBodyBytes||Infinity),site.securityShield.maxBodyBytes)});
      } else req.body = {};

      if(typeof site.sessionStore.attachAsync==='function')await site.sessionStore.attachAsync(req,res);
      else site.sessionStore.attach(req, res);
      await site.sessionStore.hydrateIdentity(req);
      req.data = req.body;
      req.user = req.user || req.session?.user || null;
      if(typeof site._isiteFinalizeRequest==='function') await site._isiteFinalizeRequest(req,res);
      req.isAuthenticated = () => !!req.user;
      req.login = (user) => { req.session.user = user; req.user = user; return user; };
      req.logout = () => { delete req.session.user; delete req.session.identityRef; req.user = null; };
      req.setIdentity = (ref,user=null) => site.sessionStore.setIdentity(req,ref,user);
      req.clearIdentity = () => site.sessionStore.clearIdentity(req);
      req.can = (rule) => site.security.can(req.user, rule);

      if(typeof site._isitePreRoute==='function' && await site._isitePreRoute(req,res)) return;

      const routeMatchPath=typeof site._isiteMatchPath==='function'?site._isiteMatchPath(req):req.path;
      const found = site.router.match(req.method, routeMatchPath);
      if (!found) {
        site.metrics.inc('http.notFound');
        if (site.listenerCount('notRoute')) {
          site.emit('notRoute', req, res);
          if (!res.writableEnded) res.status(404).json({error:'Not Found'});
        } else res.status(404).json({error:'Not Found'});
        return;
      }
      req.params = found.params;
      const routeScope=found.route.handler?.[PLUGIN_SCOPE]||null;
      req.__coreRouteScope=routeScope;
      req.__coreRouteMatched=true;
      if(routeScope && routeScope!==req.__coreOnRequestScope){
        if(!await runHttpLifecycleHooks(site,'onRequest',req,res,routeScope,{includeGlobal:false}))return;
      }
      if(!await runHttpLifecycleHooks(site,'preValidation',req,res,routeScope,{includeGlobal:true}))return;
      if(!await runHttpLifecycleHooks(site,'preHandler',req,res,routeScope,{includeGlobal:true}))return;

      // Install a payload lifecycle only when the route actually has payload hooks.
      // With no preSerialization/onSend hooks, response helpers remain fully
      // synchronous and retain their historical Core/Social Browser semantics.
      const needsPayloadLifecycle=hasHttpLifecycleHooks(site,'preSerialization',routeScope,{includeGlobal:true}) || hasHttpLifecycleHooks(site,'onSend',routeScope,{includeGlobal:true});
      let rawSend=null,rawJson=null,rawTxt=null;
      if(needsPayloadLifecycle){
        rawSend=res.send;rawJson=res.json;rawTxt=res.txt;
        const schedule=(kind,payload)=>{
          if(req.__coreResponsePromise)return res;
          req.__coreResponsePromise=(async()=>{
            let value=payload;
            if(kind==='json' || (kind==='send' && value!==null && typeof value==='object' && !Buffer.isBuffer(value))){
              value=await runHttpPayloadHooks(site,'preSerialization',req,res,value,routeScope,{includeGlobal:true});
            }
            if(kind==='json'){
              if(!res.headersSent)res.setHeader('Content-Type','application/json; charset=utf-8');
              value=JSON.stringify(value);
            }else if(kind==='txt'){
              if(!res.headersSent)res.setHeader('Content-Type','text/plain; charset=utf-8');
              value=String(value??'');
            }else if(kind==='send'){
              if(value!==null && typeof value==='object' && !Buffer.isBuffer(value)){
                if(!res.headersSent)res.setHeader('Content-Type','application/json; charset=utf-8');
                value=JSON.stringify(value);
              }else if(!Buffer.isBuffer(value)){
                if(!res.headersSent)res.setHeader('Content-Type','text/html; charset=utf-8');
                value=String(value??'');
              }
            }
            value=await runHttpPayloadHooks(site,'onSend',req,res,value,routeScope,{includeGlobal:true});
            if(!res.writableEnded)res.end(value);
            return res;
          })();
          return res;
        };
        res.send=data=>schedule('send',data);
        res.json=data=>schedule('json',data);
        res.txt=data=>schedule('txt',data);
      }

      const out = await found.route.handler(req, res);
      // Response helpers return the ServerResponse itself. Never auto-send it again,
      // especially while a file/stream is still piping asynchronously.
      if (!res.writableEnded && out !== undefined && out !== res && !req.__coreResponsePromise) res.send(out);
      if(req.__coreResponsePromise)await req.__coreResponsePromise;
    } catch (err) {
      span.error(err);
      site.metrics.inc('http.errors');
      site.securityShield.recordServerError();
      const status = err.statusCode || (err.code === 'SCHEMA_VALIDATION_FAILED' ? 400 : 500);
      if (site.listenerCount('error')) site.emit('error', err, req, res);
      try{await runHttpLifecycleHooks(site,'onError',req,res,req.__coreRouteScope||null,{includeGlobal:true,allowEnded:true,args:[err,req,res]})}
      catch(hookError){site.logger?.error?.({event:'http_onError_hook_error',message:hookError.message,code:hookError.code||null})}
      if (!res.writableEnded) res.status(status).json({
        error: status >= 500 && options.exposeErrors !== true ? 'Internal Server Error' : err.message
      });
    } finally {
      if(req.__coreRouteMatched){
        try{await runHttpLifecycleHooks(site,'onResponse',req,res,req.__coreRouteScope||null,{includeGlobal:true,allowEnded:true})}
        catch(e){site.logger?.error?.({event:'http_onResponse_hook_error',message:e.message,code:e.code||null})}
      }
      try {
        if(typeof site.sessionStore.commitAsync==='function')await site.sessionStore.commitAsync(req);
        else site.sessionStore.commit(req);
      } catch {}
      site.metrics.observe('http.requestMs', performance.now() - requestStarted);
      site.metrics.inc('http.inflight',-1);
      site.requestTelemetry.end(req,res);
      span.setAttribute('status',res.statusCode||200).setAttribute('durationMs',performance.now()-requestStarted).end();
    }
  }

  site.handler = dispatch;
  site._secureServer = (server) => {
    server.maxHeadersCount = Number(options.securityShield?.maxHeadersCount || 100);
    server.headersTimeout = Number(options.securityShield?.headersTimeoutMs || 10000);
    server.requestTimeout = Number(options.securityShield?.requestTimeoutMs || 30000);
    server.keepAliveTimeout = Number(options.securityShield?.keepAliveTimeoutMs || 5000);
    server.maxRequestsPerSocket = Number(options.securityShield?.maxRequestsPerSocket || 1000);
    server.on('connection', socket => {
      if (!site.securityShield.onConnection(socket)) return;
      site._connections.add(socket);
      socket.once('close',()=>site._connections.delete(socket));
      socket.setTimeout?.(Number(options.securityShield?.socketIdleTimeoutMs || 30000),()=>socket.destroy());
      socket.setNoDelay?.(true);
    });
    return site._attachUpgrade(server);
  };
  site.createServer = () => site._secureServer(http.createServer({maxHeaderSize:Number(options.securityShield?.maxHeaderBytes || 32768)}, dispatch));
  site.createHttpsServer = (tls={}) => site._secureServer(https.createServer({...tls,maxHeaderSize:Number(options.securityShield?.maxHeaderBytes || 32768)}, dispatch));

  site.start = site.run = (ports) => {
    site._draining=false;site._stopping=false;
    site.lifecycle.state='starting';
    // Production work belongs on the startup path, not the first user request.
    // Warm file content/metadata and finalize route indexes before listen().
    if(options.fileCache?.prewarm){
      const targets=options.fileCache.prewarm===true?site.productionPrewarmTargets():options.fileCache.prewarm;
      try{site.fileCache.prewarmSync(targets,{text:true,compress:options.fileCache.precompress!==false,extensions:options.fileCache.prewarmExtensions})}catch(e){site.logger?.warn?.({event:'file_cache_prewarm_error',message:e.message})}
    }
    try{site.router.prepare?.()}catch{}
    try{site.security.prepare?.()}catch{}
    const values = ports == null ? [options.port || 3000] : Array.isArray(ports) ? ports : [ports];
    for (const p of values) {
      const server = site.createServer();
      server.listen(p, options.host || '0.0.0.0');
      site.servers.push(server);
    }
    const h = options.https || {};
    if (h.enabled && (h.key || h.keyFile) && (h.cert || h.certFile)) {
      const tls = {
        key: h.key || fs.readFileSync(h.keyFile),
        cert: h.cert || fs.readFileSync(h.certFile)
      };
      const hp = h.ports?.length ? h.ports : [h.port || 443];
      for (const p of hp) {
        const server = site.createHttpsServer(tls);
        server.listen(p, options.host || '0.0.0.0');
        site.servers.push(server);
      }
    }
    queueMicrotask(async () => {
      try{if(site.plugins.registry.size)await site.bootPlugins()}catch(e){site.lifecycle.state='error';site.emit('startupError',e);return}
      if(options.fileCache?.watch)try{site.fileCache.watch(options.fileCache.watch===true?[site.dir]:options.fileCache.watch,{recursive:options.fileCache.watchRecursive===true})}catch{}
      site.lifecycle.state='ready';site.lifecycle.startedAt=Date.now();
      site.emit('ready', site);
    });
    return site;
  };
  // Express/Koa familiar name; Core run/start/listen are the same registrar.
  site.listen = site.run;

  site.drain = async ({timeoutMs=5000}={}) => {
    site._draining=true;
    site.lifecycle.state='draining';site.lifecycle.drainingAt=Date.now();
    site.emit('draining');
    const deadline=Date.now()+Math.max(0,Number(timeoutMs)||0);
    while(site.metrics.get('http.inflight')>0 && Date.now()<deadline)
      await new Promise(r=>setTimeout(r,20));
    return {draining:true,inflight:site.metrics.get('http.inflight')};
  };

  site.stop = async (stopOptions={}) => {
    if(site._stopping)return site._stopPromise;
    site._stopping=true;
    site._stopPromise=(async()=>{
      const forceAfterMs=Math.max(100,Number(stopOptions.forceAfterMs||5000));
      await site.drain({timeoutMs:stopOptions.drainTimeoutMs??forceAfterMs});
      site.scheduler?.clear?.();
      await lazySiteValue(site,'jobs')?.stop?.();
      await lazySiteValue(site,'distributed')?.leader?.resign?.();
      await lazySiteValue(site,'plugins')?.disableAll?.();
      for(const hook of [...(site.hooks?.map?.get('onClose')||[])].reverse()){
        try{await invokeLifecycleHook(hook,[site])}catch(e){site.logger?.error?.({event:'onClose_hook_error',message:e.message,code:e.code||null})}
      }
      await lazySiteValue(site,'cluster')?.stop?.();
      for(const hook of [...site.shutdownHooks]){
        try{await hook(site)}catch(e){site.logger?.error?.({event:'shutdown_hook_error',message:e.message,code:e.code||null})}
      }
      const servers=site.servers.splice(0);
      await Promise.all(servers.map(server=>new Promise(resolve=>{
        let done=false;
        const finish=()=>{if(done)return;done=true;clearTimeout(timer);resolve()};
        const timer=setTimeout(()=>{
          try{server.closeIdleConnections?.()}catch{}
          try{server.closeAllConnections?.()}catch{}
          for(const socket of [...site._connections])try{socket.destroy()}catch{}
          finish();
        },forceAfterMs);
        timer.unref?.();
        try{server.close(finish)}catch{finish()}
      })));
      await lazySiteValue(site,'protocolSupervisor')?.closeAll?.({forceAfterMs});
      try{await site.sessionStore?.flush?.()}catch{}
      try{site.sessionStore?.close?.()}catch{}
      site.memoryPressure?.stop?.();
      site._disconnectFileInvalidation?.();
      site.invalidation?.close?.();
      site.fileCache?.close?.();
      await site.orm?.close?.();
      site._connections.clear();
      site.removeSignalHandlers();
      site.lifecycle.state='stopped';site.lifecycle.stoppedAt=Date.now();
      site.emit('stopped');
      return true;
    })();
    return site._stopPromise;
  };

  site.liveness = () => ({
    ok:!site._stopping,
    status:site._stopping?'stopping':site._draining?'draining':'alive',
    version:site.version,
    uptimeMs:Date.now()-site._startedAt
  });

  site.readiness = async () => {
    const database=[];
    for(const provider of new Set([...site.collections.values()].map(c=>c.provider))){
      try{database.push(await site.databaseHealth(provider,{timeout:1000}))}
      catch(e){database.push({provider,status:'DOWN',ok:false,error:e.message})}
    }
    const ok=!site._draining&&!site._stopping&&database.every(x=>x.ok!==false);
    return {ok,status:ok?'ready':'not-ready',draining:site._draining,stopping:site._stopping,database};
  };

  site.observabilitySnapshot=async()=>({
    version:site.version,
    liveness:site.liveness(),
    readiness:await site.readiness(),
    metrics:site.metrics.snapshot(),
    fileCache:site.fileCache.stats(),
    router:site.router.stats?.()||null,
    sessions:site.sessionStore.stats?.()||null,
    memoryPressure:site.memoryPressure?.stats?.()||null,
    securityIndex:site.security.stats?.()||null,
    traces:lazySiteValue(site,'tracer')?.recent?.(100)||[],
    resilience:lazySiteValue(site,'resilience')?.snapshot?.()||null,
    distributed:lazySiteValue(site,'distributed')?{
      cache:lazySiteValue(site,'distributed').cache.stats(),
      leader:lazySiteValue(site,'distributed').leader.isLeader(),
      events:lazySiteValue(site,'eventsBus')?.stats?.()||null
    }:null,
    jobs:lazySiteValue(site,'jobs')?.stats?.()||null,
    plugins:lazySiteValue(site,'plugins')?.list?.()||[],
    cluster:lazySiteValue(site,'cluster')?.status?.()||null,
    lazy:lazySiteStatus(site),
    config:site.config.snapshot({masked:true}),
    protocols:site.protocolSupervisor?.health?.()||null,
    security:site.securityStatus?.()||null
  });

  site.enableObservabilityEndpoints=(endpointOptions={})=>{
    const prefix=String(endpointOptions.prefix||'/_core').replace(/\/$/,'');
    site.get(prefix+'/live',(req,res)=>res.json(site.liveness()));
    site.get(prefix+'/ready',async(req,res)=>{
      const ready=await site.readiness();res.status(ready.ok?200:503).json(ready);
    });
    site.get(prefix+'/metrics',(req,res)=>{res.set('Content-Type','text/plain');res.send(site.prometheusMetrics())});
    if(endpointOptions.diagnostics===true)
      site.get(prefix+'/diagnostics',async(req,res)=>res.json(await site.observabilitySnapshot()));
    return site;
  };

  if(options.observability?.endpoints===true)
    site.enableObservabilityEndpoints(options.observability);
  if(options.gracefulShutdown?.signals===true||options.gracefulShutdown?.installSignalHandlers===true)
    site.installSignalHandlers(options.gracefulShutdown);
  if(options.cluster?.enabled===true){
    const clusterState=site.cluster.start(options.cluster);
    if(site.cluster.isWorker){
      process.on('message',async msg=>{
        if(msg?.type==='sb-core:drain')await site.drain({timeoutMs:options.cluster?.drainMs||5000});
      });
      queueMicrotask(()=>{try{process.send?.({type:'sb-core:ready',version:site.version})}catch{}});
      site._clusterHeartbeat=setInterval(()=>{
        try{process.send?.({type:'sb-core:heartbeat',metrics:{rss:process.memoryUsage().rss,heapUsed:process.memoryUsage().heapUsed,inflight:site.metrics.get('http.inflight')}})}catch{}
      },Math.max(500,Number(options.cluster?.heartbeatMs||2000)));
      site._clusterHeartbeat.unref?.();
      site.onShutdown(()=>{if(site._clusterHeartbeat)clearInterval(site._clusterHeartbeat)});
    }
  }

  // Dual-mode ready(): preserve the historical callback/event contract while
  // also providing a Promise form familiar to Fastify users. Without a
  // callback, ready() boots registered plugins and resolves to the site. With
  // a callback, it still fires when the runtime emits its `ready` event.
  site.ready = fn => {
    if (typeof fn === 'function') {
      if (site.lifecycle.state === 'ready') queueMicrotask(() => fn(null, site));
      else site.once('ready', () => fn(null, site));
      site.once('startupError', err => fn(err));
      return site;
    }
    return site.bootPlugins().then(() => site);
  };
  site.call = async (method, url, body, headers={}) => {
    if (!site.fetch) throw new Error('Global fetch is not available in this Node.js version');
    const r = await site.fetch(url, {
      method, headers:{'content-type':'application/json',...headers},
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await r.text();
    let data; try { data=JSON.parse(text); } catch { data=text; }
    return {status:r.status, headers:r.headers, data};
  };

  site.requirePermission = (rule) => site.security.middleware(rule);
  site.hasPermission = site.security.hasPermission;
  site.hasRole = site.security.hasRole;
  site.can = site.security.can;

  site.foundation = {
    snapshot(){return {
      runtimeProfile:site.runtimeProfile,
      fileCache:site.fileCache.stats?.()||null,
      router:site.router.stats?.()||null,
      sessions:site.sessionStore.stats?.()||null,
      security:site.security.stats?.()||null,
      responseCache:site.responseCache.stats?.()||null,
      compressionCache:site.compressionCache.stats?.()||null,
      runtimeCache:site.cache.stats?.()||null,
      queryCache:site.queryCache.stats?.()||null,
      queryPlan:site.queryPlan.stats?.()||null,
      memoryPressure:site.memoryPressure.stats?.()||null,
      invalidation:site.invalidation.stats?.()||null
    }}
  };

  site.diagnostics = {
    snapshot() {
      return {
        version: site.version,
        metrics: site.metrics.snapshot(),
        collections: [...site.collections.entries()].map(([name,c])=>({name,...c.stats()}))
      };
    },
    health() {
      const collections=[...site.collections.values()].map(c=>c.integrityCheck());
      return {ok:collections.every(x=>x.ok),version:site.version,collections};
    }
  };

  site.compat = {
    snapshot(obj, names) { return Object.fromEntries(names.map(n => [n, typeof obj[n]])); },
    assert(snapshot, obj) {
      const missing = [], changed = [];
      for (const [name,type] of Object.entries(snapshot)) {
        if (!(name in obj)) missing.push(name);
        else if (typeof obj[name] !== type) changed.push({name, expected:type, actual:typeof obj[name]});
      }
      if (missing.length || changed.length) {
        const e = new Error('Compatibility assertion failed');
        e.missing=missing; e.changed=changed; throw e;
      }
      return true;
    },
    pin(name, obj, names) {
      site._compatPins ||= new Map();
      site._compatPins.set(name, this.snapshot(obj,names));
      return site._compatPins.get(name);
    }
  };

  if (options.compatibility === 'isite' || options.compatibility?.isite === true || options.compatibility?.includes?.('isite') || options.compatibility?.name === 'isite') {
    const compatOpts=options.compatibility&&typeof options.compatibility==='object'&&!Array.isArray(options.compatibility)?options.compatibility:{};
    site.useCompatibility('isite',compatOpts);
  }



// Protocol and advanced network surfaces are intentionally lazy. A normal HTTP
// application should not parse/initialize FTP/SSH/SMTP/MQTT/proxy/DNS modules
// unless it actually uses them.
defineLazySiteValue(site,'ProtocolRuntime',()=>require('./protocol-runtime').ProtocolRuntime);
defineLazySiteValue(site,'FtpClient',()=>require('./ftp-client').FtpClient);
defineLazySiteValue(site,'SshProtocol',()=>require('./ssh-protocol').SshProtocol);
defineLazySiteValue(site,'SmtpClient',()=>require('./smtp-client').SmtpClient);
defineLazySiteValue(site,'protocolCapabilities',()=>require('./protocol-capabilities').protocolCapabilities);
defineLazySiteValue(site,'Pop3Client',()=>require('./pop3-client').Pop3Client);
defineLazySiteValue(site,'ImapClient',()=>require('./imap-client').ImapClient);
defineLazySiteValue(site,'RedisRespClient',()=>require('./redis-resp').RedisRespClient);
defineLazySiteValue(site,'MqttClient',()=>require('./mqtt-client').MqttClient);
defineLazySiteValue(site,'socks5Connect',()=>require('./proxy-clients').socks5Connect);
defineLazySiteValue(site,'socks4Connect',()=>require('./proxy-clients').socks4Connect);
defineLazySiteValue(site,'httpConnect',()=>require('./proxy-clients').httpConnect);
defineLazySiteValue(site,'createHttpProxyServer',()=>require('./http-proxy-server').createHttpProxyServer);
defineLazySiteValue(site,'createSocks5Server',()=>require('./socks5-server').createSocks5Server);
defineLazySiteValue(site,'createRedisRespServer',()=>require('./redis-resp-server').createRedisRespServer);
defineLazySiteValue(site,'createMqttBroker',()=>require('./mqtt-broker').createMqttBroker);
defineLazySiteValue(site,'createSmtpServer',()=>require('./mail-servers').createSmtpServer);
defineLazySiteValue(site,'createPop3Server',()=>require('./mail-servers').createPop3Server);
defineLazySiteValue(site,'createImapServer',()=>require('./mail-servers').createImapServer);
defineLazySiteValue(site,'WebSocketClient',()=>require('./websocket-client').WebSocketClient);
defineLazySiteValue(site,'Http2Client',()=>require('./http2-client').Http2Client);
defineLazySiteValue(site,'DnsRuntime',()=>require('./dns-runtime').DnsRuntime);
defineLazySiteValue(site,'createFtpServer',()=>require('./ftp-server').createFtpServer);
defineLazySiteValue(site,'SecurityShield',()=>require('./security-shield').SecurityShield);
defineLazySiteValue(site,'assertPublicTarget',()=>require('./security-shield').assertPublicTarget);
defineLazySiteValue(site,'isPrivateIp',()=>require('./security-shield').isPrivateIp);

defineLazySiteValue(site,'protocols',()=>new site.ProtocolRuntime(options.protocols||{}));
defineLazySiteValue(site,'securityShield',()=>new site.SecurityShield(options.securityShield||{}));
defineLazySiteValue(site,'protocolMetrics',()=>{
  const {ProtocolMetrics}=require('./protocol-metrics');
  return new ProtocolMetrics();
});
defineLazySiteValue(site,'protocolSupervisor',()=>{
  const {ProtocolSupervisor}=require('./protocol-supervisor');
  return new ProtocolSupervisor({metrics:site.protocolMetrics});
});
defineLazySiteValue(site,'protocolFactory',()=>{
  const {ProtocolFactory}=require('./protocol-factory');
  return new ProtocolFactory(site);
});

site.securityLimit = (name,keyFn,opts={}) => site.securityShield.middleware(name,keyFn,opts);
site.csrfProtection = (opts={}) => site.securityShield.csrf(opts);
site.originGuard = (origins=[]) => site.securityShield.originGuard(origins);
site.securityProfile = (name,opts={}) => site.securityShield.profile(name,opts);
site.securityStatus = () => ({
  banned:site.securityShield.bans.size,
  activeConnections:Object.fromEntries(site.securityShield.activeByIp),
  activeWebSockets:Object.fromEntries(site.securityShield.wsActiveByIp),
  recentEvents:site.securityShield.recentEvents(100),
  circuitOpen:site.securityShield.circuitOpen()
});
site.connectProtocol = (uri,opts={}) => site.protocolFactory.connect(uri,opts);
site.createProtocolServer = (protocol,opts={}) => site.protocolFactory.createServer(protocol,opts);
  return site;
}

module.exports = { createSite };
