'use strict';
const {EventEmitter}=require('events');
const PLUGIN_SCOPE=Symbol.for('@social-browser/core.pluginScope');

function invokePluginHook(fn,args=[]){
  if(typeof fn!=='function')return Promise.resolve();
  if(fn.length>args.length)return new Promise((resolve,reject)=>{let done=false;const next=(err,value)=>{if(done)return;done=true;err?reject(err):resolve(value)};try{const out=fn(...args,next);if(out&&typeof out.then==='function')out.then(v=>next(null,v),next)}catch(e){next(e)}});
  return Promise.resolve().then(()=>fn(...args));
}

function pluginError(message, code, extra={}) {
  return Object.assign(new Error(message), {code, ...extra});
}

function normalizePrefix(prefix=''){
  prefix=String(prefix||'').trim();
  if(!prefix)return '';
  if(!prefix.startsWith('/'))prefix='/'+prefix;
  return prefix.length>1?prefix.replace(/\/+$/,''):prefix;
}
function joinRoutePrefix(prefix, route){
  prefix=normalizePrefix(prefix);
  route=String(route==null?'':route);
  if(!prefix)return route||'/';
  if(!route||route==='/')return prefix;
  return prefix + (route.startsWith('/')?'':'/') + route;
}
function scopedRouteInput(prefix,input,scope=null){
  if(typeof input==='string' || input instanceof RegExp)return typeof input==='string'?joinRoutePrefix(prefix,input):input;
  if(Array.isArray(input))return input.map(x=>scopedRouteInput(prefix,x,scope));
  if(!input || typeof input!=='object')return input;
  const out={...input};
  if(scope)Object.defineProperty(out,PLUGIN_SCOPE,{value:scope,enumerable:false,configurable:true});
  // Static descriptor routes normally use `name` as the URL and `path` as the
  // file-system target. Fastify/Hapi route objects use url/route/path + handler.
  if(out.url!=null)out.url=joinRoutePrefix(prefix,out.url);
  else if(out.route!=null)out.route=joinRoutePrefix(prefix,out.route);
  else if(out.name!=null)out.name=joinRoutePrefix(prefix,out.name);
  else if((out.handler||out.handle) && out.path!=null)out.path=joinRoutePrefix(prefix,out.path);
  return out;
}
function createPluginScope(site,row,parentScope=null){
  const parentPrefix=parentScope?.prefix||'';
  const ownPrefix=normalizePrefix(row.options.prefix||row.options.routePrefix||'');
  const prefix=joinRoutePrefix(parentPrefix,ownPrefix||'/');
  const effectivePrefix=(parentPrefix||ownPrefix)?(prefix==='/'?'':prefix):'';
  const scope=Object.create(site);
  Object.defineProperties(scope,{
    root:{value:site,enumerable:false},
    parent:{value:parentScope||site,enumerable:false},
    pluginName:{value:row.name,enumerable:true},
    prefix:{value:effectivePrefix,enumerable:true},
    encapsulated:{value:true,enumerable:true},
    _pluginRow:{value:row,enumerable:false}
  });
  const bindHandler=(handler)=>{
    if(typeof handler!=='function')return handler;
    const wrapped=function(...args){return handler.apply(this,args)};
    Object.defineProperty(wrapped,PLUGIN_SCOPE,{value:scope,enumerable:false,configurable:true});
    return wrapped;
  };
  const routeMethods=['get','post','put','patch','delete','head','all','onGET','onPOST','onPUT','onPATCH','onDELETE','onHEAD','onOPTIONS','onALL','onANY'];
  for(const name of routeMethods){
    if(typeof site[name]!=='function')continue;
    Object.defineProperty(scope,name,{configurable:true,writable:true,value:function(route,handler){
      return site[name](scopedRouteInput(effectivePrefix,route,scope),bindHandler(handler)),scope;
    }});
  }
  if(typeof site.routeOptions==='function')scope.routeOptions=(route,handler)=>(site.routeOptions(scopedRouteInput(effectivePrefix,route,scope),bindHandler(handler)),scope);
  if(typeof site.optionsRoute==='function')scope.optionsRoute=scope.routeOptions;
  if(typeof site.onWS==='function'){
    scope.onWS=(route,handler)=>(site.onWS(scopedRouteInput(effectivePrefix,route,scope),bindHandler(handler)),scope);
    scope.websocket=scope.onWS;
  }
  if(typeof site.route==='function')scope.route=function(definition){
    if(typeof definition==='string' || definition instanceof RegExp){
      const pattern=scopedRouteInput(effectivePrefix,definition,scope);
      const chain={};
      for(const verb of ['get','post','put','patch','delete','head','options','all']){
        chain[verb]=(...handlers)=>{
          const registrar=verb==='options'?site.routeOptions:site[verb];
          for(const handler of handlers.flat())if(typeof handler==='function')registrar(pattern,bindHandler(handler));
          return chain;
        };
      }
      chain.onGET=chain.get;chain.onPOST=chain.post;chain.onPUT=chain.put;chain.onPATCH=chain.patch;
      chain.onDELETE=chain.delete;chain.onHEAD=chain.head;chain.onOPTIONS=chain.options;chain.onALL=chain.all;chain.onANY=chain.all;
      return chain;
    }
    if(Array.isArray(definition)){for(const item of definition)scope.route(item);return scope}
    if(definition&&typeof definition==='object'&&(definition.handler||definition.handle)){
      const copy={...definition,handler:bindHandler(definition.handler||definition.handle)};
      site.route(scopedRouteInput(effectivePrefix,copy,scope));return scope;
    }
    site.route(scopedRouteInput(effectivePrefix,definition,scope));return scope;
  };
  scope.addRoute=scope.route;scope.registerRoute=scope.route;
  scope.decorate=(name,value)=>{
    if(!name)throw pluginError('Decorator name is required','PLUGIN_DECORATOR_NAME_REQUIRED',{plugin:row.name});
    if(Object.prototype.hasOwnProperty.call(scope,name))throw pluginError(`Decorator already exists in plugin scope: ${name}`,'PLUGIN_DECORATOR_EXISTS',{plugin:row.name,name});
    Object.defineProperty(scope,name,{value,writable:true,configurable:true,enumerable:true});return scope;
  };
  scope.hasDecorator=name=>Object.prototype.hasOwnProperty.call(scope,String(name)) || (row.options.inheritDecorators!==false && typeof site.hasDecorator==='function' && site.hasDecorator(name));
  const ensureScopedDecorators=()=>{
    if(row._decoratorMiddlewareInstalled)return;
    row._decoratorMiddlewareInstalled=true;
    const guard=(req,res,next)=>{
      const pathname=String(req?.pathname||req?.path||req?.url||'').split('?')[0];
      if(!effectivePrefix || pathname===effectivePrefix || pathname.startsWith(effectivePrefix+'/')){
        for(const [name,value] of row.requestDecorators)if(!(name in req))req[name]=value;
        for(const [name,value] of row.replyDecorators)if(!(name in res))res[name]=value;
      }
      return next();
    };
    row.middleware.push(guard);site.use(guard);
  };
  scope.decorateRequest=(name,value)=>{if(!name)throw pluginError('Request decorator name is required','PLUGIN_DECORATOR_NAME_REQUIRED',{plugin:row.name});row.requestDecorators.set(String(name),value);ensureScopedDecorators();return scope};
  scope.decorateReply=(name,value)=>{if(!name)throw pluginError('Reply decorator name is required','PLUGIN_DECORATOR_NAME_REQUIRED',{plugin:row.name});row.replyDecorators.set(String(name),value);ensureScopedDecorators();return scope};
  scope.hasRequestDecorator=name=>row.requestDecorators.has(String(name)) || (row.options.inheritDecorators!==false && site.hasRequestDecorator?.(name));
  scope.hasReplyDecorator=name=>row.replyDecorators.has(String(name)) || (row.options.inheritDecorators!==false && site.hasReplyDecorator?.(name));
  scope.use=(fn)=>{
    if(typeof fn!=='function')throw pluginError('Plugin middleware must be a function','PLUGIN_MIDDLEWARE_INVALID',{plugin:row.name});
    const guard=(req,res,next)=>{
      const pathname=String(req?.pathname||req?.path||req?.url||'').split('?')[0];
      if(!effectivePrefix || pathname===effectivePrefix || pathname.startsWith(effectivePrefix+'/'))return fn(req,res,next);
      return next();
    };
    row.middleware.push(guard);site.use(guard);return scope;
  };
  scope.middleware=scope.use;scope.addMiddleware=scope.use;
  scope.addHook=(name,fn)=>{
    name=String(name||'');
    if(!name||typeof fn!=='function')throw pluginError('Plugin hook name and function are required','PLUGIN_HOOK_INVALID',{plugin:row.name,name});
    if(!row.hooks.has(name))row.hooks.set(name,[]);
    row.hooks.get(name).push(fn);return scope;
  };
  scope.hook=scope.addHook;scope.onHook=scope.addHook;
  scope.removeHook=(name,fn)=>{const list=row.hooks.get(String(name))||[];const i=list.indexOf(fn);if(i>=0)list.splice(i,1);if(!list.length)row.hooks.delete(String(name));return scope};
  scope.hasHook=name=>(row.hooks.get(String(name))||[]).length>0 || (row.options.inheritHooks!==false && typeof (parentScope||site).hasHook==='function' && (parentScope||site).hasHook(name));
  scope.register=(plugin,options={})=>{site.register(plugin,{...options,_parentScope:scope});return scope};
  scope.registerPlugin=scope.register;scope.addPlugin=scope.register;
  return scope;
}

class PluginManager extends EventEmitter{
  constructor(site){
    super();
    this.site=site;
    this.registry=new Map();
    this.activationOrder=[];
    // Avoid EventEmitter's special unhandled `error` semantics when a caller
    // does not subscribe. Plugin failures are still thrown to the caller.
    this.on('error',()=>{});
  }

  _normalize(plugin, options={}){
    // Hapi-like: site.register({ plugin: { name, register }, options: {...} })
    if(plugin && typeof plugin==='object' && plugin.plugin && !plugin.setup && !plugin.register){
      options={...(plugin.options||{}),...options};
      plugin=plugin.plugin;
    }
    if(typeof plugin==='function'){
      plugin={name:options.name||plugin.pluginName||plugin.name||`plugin_${this.registry.size+1}`,setup:plugin};
    }
    if(!plugin || typeof plugin!=='object')throw pluginError('Plugin must be a function or object','PLUGIN_INVALID');
    const setup=plugin.setup||plugin.register||plugin.plugin;
    const name=String(options.name||plugin.name||setup?.pluginName||setup?.name||'').trim();
    if(!name)throw pluginError('Plugin name required','PLUGIN_NAME_REQUIRED');
    if(typeof setup!=='function' && typeof plugin!=='object')throw pluginError(`Plugin setup function required: ${name}`,'PLUGIN_SETUP_REQUIRED',{plugin:name});
    const dependencies=[...(options.dependencies||options.dependsOn||plugin.dependencies||plugin.dependsOn||plugin.requires||[])].map(String);
    return {
      name,
      version:String(options.version||plugin.version||'0.0.0'),
      setup:typeof setup==='function'?setup:null,
      teardown:plugin.teardown||plugin.unregister||null,
      capabilities:[...(options.capabilities||plugin.capabilities||[])],
      dependencies,
      plugin,
      options:{...options}
    };
  }

  register(plugin,options={}){
    const normalized=this._normalize(plugin,options);
    const existing=this.registry.get(normalized.name);
    if(existing&&!options.replace)throw pluginError(`Plugin already registered: ${normalized.name}`,'PLUGIN_EXISTS',{plugin:normalized.name});
    if(existing&&options.replace && existing.state==='enabled')throw pluginError(`Cannot replace enabled plugin: ${normalized.name}`,'PLUGIN_ENABLED',{plugin:normalized.name});
    const row={
      name:normalized.name,
      version:normalized.version,
      plugin:normalized.plugin,
      setup:normalized.setup,
      teardown:normalized.teardown,
      options:normalized.options,
      state:'registered',
      capabilities:normalized.capabilities,
      dependencies:normalized.dependencies,
      instance:null,error:null,registeredAt:Date.now(),enabledAt:null,disabledAt:null,
      scope:null,middleware:[],requestDecorators:new Map(),replyDecorators:new Map(),hooks:new Map()
    };
    this.registry.set(row.name,row);
    this.emit('registered',row);
    return row;
  }

  async _invokeSetup(row){
    if(typeof row.setup!=='function')return row.plugin;
    const fn=row.setup;
    const encapsulated=row.options.encapsulate===true||row.options.scoped===true||row.options.scope===true||Boolean(row.options.prefix||row.options.routePrefix||row.options._parentScope);
    const target=encapsulated?(row.scope||(row.scope=createPluginScope(this.site,row,row.options._parentScope||null))):this.site;
    // Fastify-style callback plugin: (site, options, done)
    if(fn.length>=3){
      return await new Promise((resolve,reject)=>{
        let settled=false;
        const done=(err,value)=>{if(settled)return;settled=true;err?reject(err):resolve(value)};
        try{
          const result=fn(target,row.options,done);
          if(result && typeof result.then==='function')result.then(v=>done(null,v),done);
        }catch(e){done(e)}
      });
    }
    return await fn(target,row.options);
  }

  async enable(name, stack=[]){
    const row=this.registry.get(name);
    if(!row)throw pluginError(`Plugin not found: ${name}`,'PLUGIN_NOT_FOUND',{plugin:name});
    if(row.state==='enabled')return row;
    if(row.state==='enabling'){
      if(stack.includes(name))throw pluginError(`Circular plugin dependency: ${[...stack,name].join(' -> ')}`,'PLUGIN_DEPENDENCY_CYCLE',{chain:[...stack,name]});
      return row._enablePromise;
    }
    const nextStack=[...stack,name];
    row.state='enabling';row.error=null;
    row._enablePromise=(async()=>{
      try{
        for(const dependency of row.dependencies){
          if(!this.registry.has(dependency))throw pluginError(`Missing plugin dependency: ${row.name} -> ${dependency}`,'PLUGIN_DEPENDENCY_MISSING',{plugin:row.name,dependency});
          if(nextStack.includes(dependency))throw pluginError(`Circular plugin dependency: ${[...nextStack,dependency].join(' -> ')}`,'PLUGIN_DEPENDENCY_CYCLE',{chain:[...nextStack,dependency]});
          await this.enable(dependency,nextStack);
        }
        row.instance=await this._invokeSetup(row);
        row.state='enabled';row.enabledAt=Date.now();row.disabledAt=null;
        if(!this.activationOrder.includes(row.name))this.activationOrder.push(row.name);
        this.emit('enabled',row);return row;
      }catch(e){
        row.state='error';row.error=e;this.emit('error',e,row);throw e;
      }finally{row._enablePromise=null}
    })();
    return row._enablePromise;
  }

  async disable(name){
    const row=this.registry.get(name);if(!row)return false;
    // Prevent disabling a dependency while an enabled plugin still needs it.
    const dependents=[...this.registry.values()].filter(x=>x.state==='enabled'&&x.dependencies.includes(name));
    if(dependents.length && !row.options.forceDisable){
      throw pluginError(`Plugin is required by: ${dependents.map(x=>x.name).join(', ')}`,'PLUGIN_DEPENDENTS_ACTIVE',{plugin:name,dependents:dependents.map(x=>x.name)});
    }
    if(row.state==='enabled'){
      const target=row.scope||this.site;
      const hooks=[...(row.hooks?.get('onClose')||[])].reverse();
      for(const hook of hooks)await invokePluginHook(hook,[target]);
      if(typeof row.teardown==='function')await row.teardown(target,row.instance,row.options);
    }
    if(row.middleware?.length){this.site.middlewares=this.site.middlewares.filter(fn=>!row.middleware.includes(fn));row.middleware.length=0}
    row.state='disabled';row.instance=null;row.disabledAt=Date.now();
    this.activationOrder=this.activationOrder.filter(x=>x!==name);
    this.emit('disabled',row);return true;
  }

  async enableAll(){
    for(const row of this.registry.values())if(row.options.autoEnable!==false)await this.enable(row.name);
    return this.list();
  }
  async disableAll(){
    for(const name of [...this.activationOrder].reverse()){
      const row=this.registry.get(name);
      if(!row)continue;
      const original=row.options.forceDisable;row.options.forceDisable=true;
      try{await this.disable(name)}finally{row.options.forceDisable=original}
    }
    return true;
  }
  get(name){return this.registry.get(name)||null}
  has(name){return this.registry.has(name)}
  list(){return [...this.registry.values()].map(({plugin,setup,teardown,error,_enablePromise,scope,middleware,requestDecorators,replyDecorators,hooks,...x})=>({...x,encapsulated:Boolean(scope),prefix:scope?.prefix||'',error:error?{message:error.message,code:error.code||null}:null}))}
  hasCapability(capability){return [...this.registry.values()].some(x=>x.state==='enabled'&&x.capabilities.includes(capability))}
}

module.exports={PluginManager};
