/// <reference types="node" />
import { EventEmitter } from 'events';

export interface FileCacheOptions {
  enabled?: boolean;
  mode?: 'development'|'production'|string;
  validation?: 'mtime'|'manual'|string;
  validateIntervalMs?: number;
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
  maxCompiledEntries?: number;
  maxCompiledBytes?: number;
  maxCompressedBytes?: number;
  precompress?: boolean;
  missingTtlMs?: number;
  prewarm?: boolean|string|string[];
  prewarmExtensions?: string[];
  watch?: boolean|string|string[];
  watchRecursive?: boolean;
}
export interface FileCacheStats {
  enabled:boolean; mode:string; validation:string; entries:number; bytes:number; hits:number; misses:number; hitRate:number;
  compiledEntries:number; compiledBytes:number; compiledHits:number; compiledMisses:number; compiledHitRate:number;
  invalidations:number; evictions:number; prewarmed:number; pressureFactor?:number; compressedEntries?:number; compressedBytes?:number; missingEntries?:number; missingTtlMs?:number; realpathEntries?:number;
}

export type ProviderName = 'core'|'mongodb'|'postgres'|'postgresql'|'mysql'|'sqlite'|string;
export interface CoreOptions {
  compatibility?: 'isite';
  cwd?: string;
  dir?: string;
  port?: number;
  fileCache?: FileCacheOptions;
  mode?: 'production'|'development'|string;
  session?: { enabled?:boolean; dir?:string; persistence?:'sync'|'write-behind'|'memory'|string; flushIntervalMs?:number; maxDirty?:number; maxMemorySessions?:number; cleanupIntervalMs?:number; userInvalidationTtlMs?:number; identityHydration?:string; [key:string]:any };
  memoryPressure?: { enabled?:boolean; intervalMs?:number; memoryBudgetBytes?:number; elevated?:number; high?:number; critical?:number; recover?:number; hysteresis?:number; elevatedFactor?:number; highFactor?:number; criticalFactor?:number; [key:string]:any };
  memoryCache?: { max?:number; maxEntries?:number; maxBytes?:number };
  queryCache?: { max?:number; maxEntries?:number };
  queryPlan?: { max?:number; maxEntries?:number };
  responseCache?: { max?:number; maxBytes?:number; ttlMs?:number; cloneValues?:boolean; defaultScope?:'auto'|'public'|'session'|'user'|string };
  storage?: { dir?:string; durability?:'snapshot'|'wal'|string; crashSafe?:boolean; walSync?:boolean; walCompactEvery?:number; compactEvery?:number; [key:string]:any };
  cache?: { enabled?:boolean; html?:number; txt?:number; js?:number; css?:number; fonts?:number; images?:number; json?:number; xml?:number; [key:string]:any };
  observability?: { endpoints?: boolean; prefix?: string; diagnostics?: boolean; tracing?: { enabled?: boolean; max?: number } };
  resilience?: { retries?: number; baseDelayMs?: number; maxDelayMs?: number; factor?: number; jitter?: number; databaseReadRetries?: number };
  distributed?: Record<string, any>;
  jobs?: { concurrency?: number; stallMs?: number; autoStart?: boolean };
  cluster?: { enabled?: boolean; workers?: number; respawn?: boolean; heartbeatMs?: number };
  config?: { file?: string; profile?: string; envPrefix?: string };
  openapi?: Record<string, any>;
  [key: string]: any;
}

export type RoutePattern = string | RegExp;
export interface NativeRouteDescriptor {
  name?: RoutePattern | RoutePattern[];
  url?: RoutePattern | RoutePattern[];
  route?: RoutePattern | RoutePattern[];
  path?: string | string[];
  content?: any | ((req:any,res:any)=>any);
  headers?: Record<string,string|number>;
  parser?: string;
  overwrite?: boolean;
  [key:string]: any;
}
export type RouteInput = RoutePattern | RoutePattern[] | NativeRouteDescriptor;
export type RouteHandler = (req:any,res:any)=>any;
export type WebSocketHandler = (ws:any,req:any)=>any;

export interface OrmCollection<T=any> {
  provider: ProviderName;
  engine?: any;
  ready(): Promise<any>;
  add(doc:T): Promise<T>;
  insertMany(docs:T[]): Promise<T[]>;
  findOne(options?:any): Promise<T|null>;
  findMany(options?:any): Promise<T[]>;
  updateOne(options:any): Promise<any>;
  updateMany(options:any): Promise<any>;
  deleteOne(options:any): Promise<any>;
  deleteMany(options:any): Promise<any>;
  count(options?:any): Promise<number>;
  aggregate(pipeline:any[]): Promise<any[]>;
  distinct(field:string,options?:any): Promise<any[]>;
  bulkWrite(ops:any[],options?:any): Promise<any>;
  replaceOne(filter:any,replacement:T,options?:any): Promise<any>;
  upsert(where:any,set:any,options?:any): Promise<any>;
  transaction<TOut>(fn:(ctx:any)=>Promise<TOut>,options?:any):Promise<TOut>;
}
export interface CacheAdapter {
  get(key:string):Promise<any>;
  set(key:string,value:any,options?:any):Promise<any>;
  delete(key:string):Promise<boolean>;
  increment?(key:string,amount?:number,options?:any):Promise<number>;
}
export interface PluginOptions {
  name?:string;
  version?:string;
  dependencies?:string[];
  dependsOn?:string[];
  capabilities?:string[];
  autoEnable?:boolean;
  replace?:boolean;
  encapsulate?:boolean;
  scoped?:boolean;
  scope?:boolean;
  prefix?:string;
  routePrefix?:string;
  inheritDecorators?:boolean;
  inheritHooks?:boolean;
  [key:string]:any;
}
export type CorePluginFunction = (site:Site|PluginScope,options:PluginOptions,done?:(err?:any,value?:any)=>void)=>any;
export interface CorePlugin {
  name:string;
  version?:string;
  dependencies?:string[];
  dependsOn?:string[];
  requires?:string[];
  capabilities?:string[];
  setup?:CorePluginFunction;
  register?:CorePluginFunction;
  teardown?:(site:Site,instance:any,options:PluginOptions)=>any;
  unregister?:(site:Site,instance:any,options:PluginOptions)=>any;
  [key:string]:any;
}
export interface HapiPluginWrapper { plugin:CorePlugin; options?:PluginOptions; }
export type HttpLifecycleHookName='onRequest'|'preValidation'|'preHandler'|'preSerialization'|'onSend'|'onResponse'|'onError';
export type PluginLifecycleHookName='onClose';
export type LifecycleHookName=HttpLifecycleHookName|PluginLifecycleHookName|string;
export type HttpLifecycleHook=(req:any,res:any,done?:(err?:any)=>void)=>any;
export type PayloadLifecycleHook=(req:any,res:any,payload:any,done?:(err?:any,payload?:any)=>void)=>any;
export type ErrorLifecycleHook=(error:any,req:any,res:any,done?:(err?:any)=>void)=>any;
export type CloseLifecycleHook=(site:Site|PluginScope,done?:(err?:any)=>void)=>any;
export interface PluginScope extends Site {
  readonly root:Site;
  readonly parent:Site|PluginScope;
  readonly pluginName:string;
  readonly prefix:string;
  readonly encapsulated:true;
}

export interface Site extends EventEmitter {
  version:string;
  runtimeProfile:'production'|'development'|string;
  production:boolean;
  development:boolean;
  options:CoreOptions;
  compatibility:Record<string,any>;
  fileCache:{ getTextSync(file:string,encoding?:string):string; getBufferSync(file:string):Buffer; statSync(file:string):any; realpathSync(file:string):string; resolveExistingFile(files:string[]):string|null; invalidate(file:string,options?:any):boolean; clear():void; prewarmSync(targets:string|string[],options?:any):any; setPressureFactor(factor:number):number; stats():FileCacheStats };
  memoryPressure:{ enabled:boolean; level:string; factor:number; sample():any; start():any; stop():any; stats():any };
  cache:{ set(key:any,value:any,ttlMs?:number):any; get(key:any):any; has(key:any):boolean; delete(key:any):boolean; clear():void; size():number; remember(key:any,ttlMs:number,fn:()=>any):Promise<any>; setPressureFactor(factor:number):number; stats():any };
  queryCache:{ cached(scope:string,query:any,loader:()=>any,options?:any):Promise<any>; invalidate(scope?:string):number; invalidateAll():boolean; setPressureFactor(factor:number):number; stats():any };
  queryPlan:{ compile(query:any,options?:any):any; instantiate(plan:any):any; clear():void; setPressureFactor(factor:number):number; stats():any };
  readFile(file:string,encoding?:string):Promise<string>;
  readFileSync(file:string,encoding?:string):string;
  readFileRaw(file:string,encoding?:string):Promise<string>;
  readFileRawSync(file:string,encoding?:string):string;
  readFileCached(file:string,encoding?:string):Promise<string>;
  readFileCachedSync(file:string,encoding?:string):string;
  prewarmFiles(targets:string|string[],options?:any):any;
  productionPrewarmTargets():string[];
  staticCacheControl(file:string,routeCache?:boolean):string|null;
  invalidateUserSessions(userId:string|number):number|Promise<number>;
  invalidateUserSessionsAsync(userId:string|number):Promise<number>;
  sessionStore:{ invalidateUser(userId:string|number):number|Promise<number>; userInvalidationEpoch(userId:string|number,options?:any):number|Promise<number>; setPressureFactor?(factor:number):number; stats():any; [key:string]:any };
  responseCache:{
    key(parts:any):string;
    scopedKey(req:any,key:any,options?:any):string;
    get(key:string):any;
    set(key:string,value:any,options?:any):any;
    getOrSet<T=any>(key:string,producer:()=>T|Promise<T>,options?:any):Promise<T>;
    delete(key:string):boolean;
    invalidateTag(tag:string):number;
    invalidateDependency(dependency:string):number;
    clear():void;
    stats():any;
  };
  cachedResponse<T=any>(key:any,producer:()=>T|Promise<T>,options?:any):Promise<T>;
  cachedResponseFor<T=any>(req:any,key:any,producer:()=>T|Promise<T>,options?:{ scope?:'auto'|'public'|'session'|'user'; vary?:false|string[]; routeIsolation?:boolean; namespace?:string; tags?:string[]; dependencies?:string[]; ttlMs?:number; [key:string]:any }):Promise<T>;
  invalidateResponseTag(tag:string):number;
  invalidateResponseDependency(dependency:string):number;
  foundation:{ snapshot():any };
  get(pattern:RoutePattern,handler:RouteHandler):Site;
  post(pattern:RoutePattern,handler:RouteHandler):Site;
  put(pattern:RoutePattern,handler:RouteHandler):Site;
  patch(pattern:RoutePattern,handler:RouteHandler):Site;
  delete(pattern:RoutePattern,handler:RouteHandler):Site;
  head(pattern:RoutePattern,handler:RouteHandler):Site;
  routeOptions(pattern:RoutePattern,handler:RouteHandler):Site;
  optionsRoute(pattern:RoutePattern,handler:RouteHandler):Site;
  all(pattern:RoutePattern,handler:RouteHandler):Site;
  onGET(route:RouteInput,handler?:RouteHandler):Site;
  onPOST(route:RouteInput,handler?:RouteHandler):Site;
  onPUT(route:RouteInput,handler?:RouteHandler):Site;
  onPATCH(route:RouteInput,handler?:RouteHandler):Site;
  onDELETE(route:RouteInput,handler?:RouteHandler):Site;
  onHEAD(route:RouteInput,handler?:RouteHandler):Site;
  onOPTIONS(route:RouteInput,handler?:RouteHandler):Site;
  onALL(route:RouteInput,handler?:RouteHandler):Site;
  onANY(route:RouteInput,handler?:RouteHandler):Site;
  onWS(pattern:RoutePattern,handler:WebSocketHandler):Site;
  websocket(pattern:RoutePattern,handler:WebSocketHandler):Site;
  route(definition:any):any;
  addRoute(definition:any):any;
  registerRoute(definition:any):any;
  use(fn:(req:any,res:any,next:()=>any)=>any):Site;
  middleware(fn:(req:any,res:any,next:()=>any)=>any):Site;
  addMiddleware(fn:(req:any,res:any,next:()=>any)=>any):Site;
  addHook(name:'preSerialization'|'onSend',fn:PayloadLifecycleHook):Site;
  addHook(name:'onError',fn:ErrorLifecycleHook):Site;
  addHook(name:Exclude<HttpLifecycleHookName,'preSerialization'|'onSend'|'onError'>,fn:HttpLifecycleHook):Site;
  addHook(name:'onClose',fn:CloseLifecycleHook):Site;
  addHook(name:string,fn:(...args:any[])=>any):Site;
  onHook(name:string,fn:(...args:any[])=>any):Site;
  hook(name:string,fn:(...args:any[])=>any):Site;
  removeHook(name:string,fn:(...args:any[])=>any):Site;
  hasHook(name:string):boolean;
  decorate(name:string,value:any):Site;
  hasDecorator(name:string):boolean;
  decorateRequest(name:string,value:any):Site;
  decorateReply(name:string,value:any):Site;
  hasRequestDecorator(name:string):boolean;
  hasReplyDecorator(name:string):boolean;
  register(plugin:CorePlugin|CorePluginFunction|HapiPluginWrapper,options?:PluginOptions):Site;
  registerPlugin(plugin:CorePlugin|CorePluginFunction|HapiPluginWrapper,options?:PluginOptions):Site;
  addPlugin(plugin:CorePlugin|CorePluginFunction|HapiPluginWrapper,options?:PluginOptions):Site;
  hasPlugin(name:string):boolean;
  getPlugin(name:string):any;
  pluginList():any[];
  bootPlugins():Promise<any[]>;
  ready():Promise<Site>;
  ready(fn:(err:any,site?:Site)=>void):Site;
  after(fn:(err:any,site?:Site)=>void):Site;
  run(ports?:number|number[]):Site;
  start(ports?:number|number[]):Site;
  listen(ports?:number|number[]):Site;
  connectCollection<T=any>(name:string,options?:any):OrmCollection<T>;
  useCompatibility(name:'isite',options?:any):Site;
  removeCompatibility(name:'isite'):Site;
  withRetry<T>(name:string,fn:(ctx:{attempt:number})=>Promise<T>,options?:any):Promise<T>;
  databaseOperation<T>(provider:string,kind:string,fn:()=>Promise<T>,options?:any):Promise<T>;
  databaseHealth(name:string,options?:any):Promise<any>;
  trace(name:string,attributes?:Record<string,any>,parent?:any):any;
  drain(options?:any):Promise<any>;
  stop(options?:any):Promise<boolean>;
  onShutdown(fn:(site:Site)=>any):Site;
  publish(topic:string,payload:any,meta?:any):Promise<any>;
  subscribe(topic:string,fn:(event:any)=>void):()=>void;
  setDistributedCache(adapter:CacheAdapter):Site;
  setEventAdapter(adapter:any):Site;
  apiRoute(method:string,path:string,contract:any,handler:(req:any,res:any)=>any):Site;
  openapiDocument(extra?:any):any;
  enableOpenApiEndpoint(path?:string):Site;
  [key:string]:any;
}
declare function createCore(options?:CoreOptions):Site;
declare namespace createCore { const version:string; }
export = createCore;
