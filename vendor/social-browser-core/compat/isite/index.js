'use strict';

const fs=require('fs');
const path=require('path');
const httpCompat=require('./http-compat');

function install(site, options={}) {
  const contractVersion=String(options.contractVersion||options.version||'2026.08.31');
  let contract=null;
  try{contract=JSON.parse(fs.readFileSync(path.join(__dirname,'contracts',contractVersion+'.json'),'utf8'))}catch{}
  const strict=options.strict===true||site.options?.compatibilityStrict===true||process.env.SB_CORE_COMPAT_STRICT==='1';
  const assertCompat=(condition,code,message,details={})=>{
    if(condition)return true;
    const row={code,message,details,contractVersion};
    site.emit?.('compatibility-warning',row);
    if(strict)throw Object.assign(new Error(message),{code,details,contractVersion});
    site.logger?.warn?.({event:'compatibility_warning',...row});
    return false;
  };
  if (site.compatibility?.isite?.enabled) return site;
  site.compatibility ||= {};
  const state={
  enabled:true,installedAt:new Date().toISOString(),aliases:[],namespaces:[],
  nativeRouteMethods:Object.fromEntries(['get','post','put','patch','delete','all'].map(name=>[name,site[name]])),
  originalMiddlewareLength:Array.isArray(site.middlewares)?site.middlewares.length:0,
  originalSecurityDescriptors:site.security?Object.getOwnPropertyDescriptors(site.security):null,
  collectionOwnDescriptors:new WeakMap(),
  contractVersion,contract,strict,assert:assertCompat,warnings:[]
};
  site.compatibility.isite=state;
  state.descriptorInvalidationUnsubscribers=new Set();
  state.descriptorInvalidationSeq=0;
  const readText=file=>site.fileCache?.getTextSync?site.fileCache.getTextSync(file,'utf8'):fs.readFileSync(file,'utf8');
  const statSync=file=>site.fileCache?.statSync?site.fileCache.statSync(file):fs.statSync(file);
  const isFile=file=>{try{return statSync(file).isFile()}catch{return false}};
  const isDirectory=file=>{try{return statSync(file).isDirectory()}catch{return false}};
  state.fileCacheInvalidator=()=>{site.sharedCache?.clear?.();if(Array.isArray(site.sharedList))site.sharedList.length=0;state.renderResolutionCache?.clear?.()};
  if(site.invalidation?.subscribe){
    state._sharedCacheUnsubscribe=site.invalidation.subscribe('isite-shared-render-cache',{
      priority:60,
      invalidate:state.fileCacheInvalidator,
      clear:state.fileCacheInvalidator
    });
  }

  // Exact legacy HTTP surface from iSite v14 manifest.
  const originalProtoHelpers = {};
  for (const name of ['like','contains','contain','test']) originalProtoHelpers[name]=Object.getOwnPropertyDescriptor(String.prototype,name);
  const defineProto=(name,fn)=>{
    if(!Object.getOwnPropertyDescriptor(String.prototype,name))
      Object.defineProperty(String.prototype,name,{value:fn,writable:true,configurable:true,enumerable:false});
  };
  const legacyStringEscapeRegExp=(value)=>String(value ?? '').replace(/[\/\\^$*+?.()\[\]{}]/g,'\\$&');
  defineProto('test',function(pattern,flags='gium'){ return site.patterns.test(this,pattern,flags); });
  defineProto('like',function(value){ return site.patterns.like(this,value); });
  const legacyContainsPrototype=function(value=''){ return site.patterns.contains(this,value); };
  defineProto('contains',legacyContainsPrototype);
  defineProto('contain',legacyContainsPrototype);
  state.originalProtoHelpers=originalProtoHelpers;

state.originalValidators={
  validateServerRequest:site.validateServerRequest,
  validateRequest:site.validateRequest,
  validateRoute:site.validateRoute,
  validateSession:site.validateSession
};
site.validateServerRequest=site.validateServerRequest||((req,res,next)=>next(req,res));
site.validateRequest=site.validateRequest||((req,res,next)=>next(req,res));
site.validateRoute=site.validateRoute||((req,res,next)=>next(req,res));
site.validateSession=site.validateSession||((req,res,next)=>next(req,res));

const decorateHttp=(req,res)=>{
  httpCompat.decorateResponse(site,req,res);
  req.features=Array.isArray(req.features)?req.features:[];
  req.setting=req.setting||site.setting;
  req.word=req.word||((name)=>resolveLegacyWord(req,name));
  return req;
};
site.use(async(req,res,next)=>{
  let ok=await httpCompat.runLegacyValidator(site.validateServerRequest,req,res);
  if(!ok){req.__isiteStopRequest=true;return}
  decorateHttp(req,res);

  // Prepare the legacy URL surfaces before validateRequest, without replacing the
  // parsed cookie object that Core's session store still needs later.
  req.host=req.headers.host||'';
  req.origin=req.headers.origin||'';
  req.referer=req.headers.referer||'';
  req.urlRaw=req.url;
  const parsed=httpCompat.lowerQueryFromUrl(req.urlRaw,req.host||'localhost',req.socket?.encrypted?'https:':'http:');
  req.urlParserRaw=parsed.urlParserRaw;
  req.urlParser=parsed.urlParser;
  req.queryRaw=parsed.queryRaw;
  req.query=parsed.query;

  ok=await httpCompat.runLegacyValidator(site.validateRequest,req,res);
  if(!ok){req.__isiteStopRequest=true;return}
  return next();
});
state.decorateHttp=decorateHttp;

state.originalHttpCompatHooks={
  finalizeRequest:site._isiteFinalizeRequest,
  matchPath:site._isiteMatchPath,
  preRoute:site._isitePreRoute
};
site._isiteFinalizeRequest=(req,res)=>{
  httpCompat.finalizeRequest(site,req,res);
  req.setting=site.setting;
  req.context=req.context||site.context?.create?.({
    type:'http',method:req.method,url:req.url,requestId:req.requestId
  })||{type:'http',method:req.method,url:req.url,requestId:req.requestId};
  return req;
};
site._isiteMatchPath=(req)=>req.urlParser?.pathname||String(req.path||'/').toLowerCase();
site._isitePreRoute=async(req,res)=>{
  if(req.method==='HEAD'||req.method==='OPTIONS'){
    // iSite historically writes Content-Length: 50000 for both. Keeping that on OPTIONS
    // can leave modern HTTP clients waiting for bytes that are never sent, so preserve
    // the routing/status behavior and only retain the legacy length on HEAD.
    if(req.method==='HEAD')res.set('Content-Length',50*1000);
    res.status(200).end();
    return true;
  }
  return false;
};

  state.originalCompatOverrides=new Map();
  const define=(name,value)=>{
    if (Object.prototype.hasOwnProperty.call(site,name)) return;
    site[name]=value;
    state.aliases.push(name);
  };
  const override=(name,value)=>{
    if(!state.originalCompatOverrides.has(name))
      state.originalCompatOverrides.set(name,Object.getOwnPropertyDescriptor(site,name)||null);
    Object.defineProperty(site,name,{value,writable:true,configurable:true,enumerable:true});
    return value;
  };
  const alias=(name,target)=>{
    if (Object.prototype.hasOwnProperty.call(site,name)) return;
    site[name]=site[target];
    state.aliases.push(name);
  };

  // Legacy HTTP verbs - compatibility only.
  const verbs=['PUT','PATCH','DELETE','OPTIONS','HEAD','CONNECT','TRACE','COPY','LOCK','MKCOL','MOVE','PROPFIND','PROPPATCH','UNLOCK','REPORT','MKACTIVITY','CHECKOUT','MERGE','M-SEARCH','NOTIFY','SUBSCRIBE','UNSUBSCRIBE','PURGE','LINK','UNLINK','VIEW','TEST'];
  for(const verb of verbs){
    const methodName='on'+verb.replace(/-/g,'');
    define(methodName,(pattern,handler)=>{site.router.add(verb,pattern,handler);return site});
  }
  alias('onGET','get');
  alias('onPOST','post');
  define('onANY',site.all);
  define('onALL',site.all);
  define('onREQUEST',(method,route,callback)=>{
    site.router.add(String(method||'GET').toUpperCase(),route,callback);
    return site;
  });

  // Legacy filesystem namespace maps to generic core `site.files`.
  const f=site.files;
  define('fsm',{
    dir:site.dir,
    createDir:f.createDir,createDirSync:f.createDirSync,mkDir:f.createDir,mkdirSync:f.createDirSync,
    deleteFile:f.delete,removeFile:f.delete,deleteFileSync:f.deleteSync,removeFileSync:f.deleteSync,
    isFileExists:f.exists,isFileExistsSync:f.existsSync,stat:f.stat,statSync:f.statSync,
    readFile:f.read,readFileNow:f.read,readFileRaw:f.readBufferRaw,readFileSync:f.readSync,readFileSyncRaw:f.readBufferRawSync,
    readFileStream:f.stream,writeFile:f.write,writeFileSync:f.writeSync,getFilePath:f.resolve,isImage:f.isImage,
    clearCache(){},off(){},list:[],cache:new Map(),pathCache:new Map(),missingPathCache:new Map()
  });
  state.namespaces.push('fsm');

  const legacyCb=(promise,callback)=>{
    promise=Promise.resolve(promise);
    if(typeof callback==='function'){promise.then(data=>callback(null,data),err=>callback(err));return}
    return promise;
  };
  define('fileStat',(file,callback)=>legacyCb(site.files.stat(file),callback));
  define('fileStatSync',file=>site.files.statSync(file));
  define('isFileExists',(file,callback)=>legacyCb(site.files.exists(file),callback));
  define('readFileStream',file=>site.files.stream(file));
  define('readFiles',(files,callback)=>legacyCb(Promise.all([].concat(files||[]).map(file=>site.files.read(file))),callback));
  define('removeFile',(file,callback)=>legacyCb(site.files.delete(file),callback));
  define('mkDir',(dir,callback)=>legacyCb(site.files.createDir(dir),callback));
  define('downloadFile',(file,req,res)=>{
    if(res?.download)return res.download(file,path.basename(file));
    if(res?.file)return res.file(file);
    return file;
  });
  const legacyReadAsset=(name,callback,kind='txt')=>{
    let file=String(name||'');
    if(!path.isAbsolute(file)){
      const direct=path.join(site.dir,file);
      const byKind=path.join(site.dir,kind,file);
      const bySiteFiles=path.join(site.dir,'site_files',kind,file);
      file=site.fileCache?.resolveExistingFile?.([direct,byKind,bySiteFiles])||direct;
    }
    const promise=site.files.read(file,kind==='json'?'utf8':'utf8').then(text=>kind==='json'?legacyFromJson(text,{}):text);
    return legacyCb(promise,callback);
  };
  define('css',(name,callback)=>legacyReadAsset(name,callback,'css'));
  define('xml',(name,callback)=>legacyReadAsset(name,callback,'xml'));
  define('js',(name,callback)=>legacyReadAsset(name,callback,'js'));
  define('json',(name,callback)=>legacyReadAsset(name,callback,'json'));
  define('html',(name,callback)=>legacyReadAsset(name,callback,'html'));

  // Legacy MongoDB facade maps to aisite collections/storage.
  const wrap=(p,cb)=>{p=Promise.resolve(p);if(typeof cb==='function'){p.then(x=>cb(null,x),e=>cb(e));return}return p};
  define('mongodb',{
    connection:'aisite-storage',
    collections_indexed:[],collectionIndex:Object.create(null),databaseIndex:Object.create(null),
    ObjectID:v=>v||require('crypto').randomBytes(12).toString('hex'),
    connectCollection:(n,o)=>site.connectCollection(n,o),
    connectDB:async()=>site.mongodb,
    find:(c,o,cb)=>wrap(c.findMany(o),cb),findMany:(c,o,cb)=>wrap(c.findMany(o),cb),
    findOne:(c,o,cb)=>wrap(c.findOne(o),cb),findManyFast:(c,o,cb)=>wrap(c.findManyFast(o),cb),
    findManyConcurrent:(c,o,cb)=>wrap(c.findManyParallel(o),cb),
    findPageFast:(c,o,cb)=>wrap(c.findPageFast(o),cb),
    insertOne:(c,d,cb)=>wrap(c.add(d),cb),insertMany:(c,d,cb)=>wrap(c.insertMany(d),cb),
    updateOne:(c,o,cb)=>wrap(c.update({...o,multi:false}),cb),updateMany:(c,o,cb)=>wrap(c.update({...o,multi:true}),cb),
    deleteOne:(c,o,cb)=>wrap(c.delete({...o,multi:false}),cb),deleteMany:(c,o,cb)=>wrap(c.deleteMany(o),cb),
    count:(c,o,cb)=>wrap(c.count(o),cb),aggregate:(c,p,cb)=>wrap(c.aggregate(p),cb),
    createIndex:(c,f,o)=>c.createIndex(f,o),dropIndex:(c,f)=>c.dropIndex(f),
    explainQuery:(c,o)=>c.explain(o),invalidateQueryCache:()=>true,invalidateWriteCaches:()=>true
  });
  state.namespaces.push('mongodb');





state.originalRequestCompat={request:site.options.request?{...site.options.request}:null};
site.options.request={...(site.options.request||{}),uploadDir:site.options.request?.uploadDir||path.join(site.cwd,'.aisite','uploads')};
state.originalStorageCompat={storage:site.options.storage?{...site.options.storage}:null};
site.options.storage={...(site.options.storage||{}),dir:site.options.storage?.dir||path.join(site.cwd,'.aisite','data')};

state.originalSessionCompat={
  cookieName:site.sessionStore?.cookieName,
  cookieAliases:site.sessionStore?.cookieAliases?[...site.sessionStore.cookieAliases]:[],
  cookieOptions:site.sessionStore?.cookieOptions?{...site.sessionStore.cookieOptions}:null,
  dir:site.sessionStore?.dir,
  lazy:site.sessionStore?.lazy
};
if(site.sessionStore){
  site.sessionStore.cookieName=options.session?.cookieName||'aisite.sid';
  site.sessionStore.dir=options.session?.dir||path.join(site.cwd,'.aisite','sessions');
  fs.mkdirSync(site.sessionStore.dir,{recursive:true});
  site.sessionStore.cookieAliases=[...new Set([
    ...(options.session?.cookieAliases||[]),
    state.originalSessionCompat.cookieName,
    'sb.sid'
  ].filter(Boolean))];
  site.sessionStore.cookieOptions={...(site.sessionStore.cookieOptions||{}),...(options.session?.cookieOptions||{})};
}

if(site.security && typeof site.security==='object'){
  const sec=site.security;
  state.originalSecurityCompat={
    users:sec.users,roles:sec.roles,permissions:sec.permissions,
    addUser:sec.addUser,addRole:sec.addRole,addRoles:sec.addRoles,
    hasRole:sec.hasRole,hasPermission:sec.hasPermission,can:sec.can,middleware:sec.middleware
  };

  const $users=site.$users||site.connectCollection('users');
  const $roles=site.$roles||site.connectCollection('roles');
  site.$users=$users;site.$roles=$roles;

  sec.users=Array.isArray(sec.users)?sec.users:[];
  sec.roles=Array.isArray(sec.roles)?sec.roles:[];
  sec.permissions=Array.isArray(sec.permissions)?sec.permissions:[...(sec.permissions||[])];
  sec.permissionByName=sec.permissionByName||Object.create(null);
  sec.roleByName=sec.roleByName||Object.create(null);
  sec.userIndexes=sec.userIndexes||Object.create(null);

  const cleanDoc=(doc)=>{
    const out={...(doc||{})};
    for(const k of Object.keys(out))if(k.startsWith('$'))delete out[k];
    return out;
  };
  const callbackify=(promise,cb,transform=x=>x)=>{
    promise=Promise.resolve(promise).then(transform);
    if(typeof cb==='function'){promise.then(x=>cb(null,x),e=>cb(e));return}
    return promise;
  };
  const userWhere=(input={})=>{
    if(input==null)return {};
    if(typeof input!=='object')return {$or:[{id:input},{_id:input},{email:input},{username:input}]};
    if(input.where)return input.where;
    const out=cleanDoc(input);
    for(const k of ['limit','skip','sort','select','projection','page','$req','$res','password'])delete out[k];
    return out;
  };
  const cacheUser=(user)=>{
    if(!user)return user;
    const key=user.id??user._id??user.email;
    const idx=sec.users.findIndex(x=>(x.id??x._id??x.email)===key);
    if(idx>=0)sec.users[idx]=user;else sec.users.push(user);
    if(key!=null)sec.userIndexes[key]=user;
    if(user.email)sec.userIndexes[user.email]=user;
    return user;
  };
  const uncacheUser=(user)=>{
    if(!user)return;
    const keys=[user.id,user._id,user.email].filter(x=>x!=null);
    sec.users=sec.users.filter(u=>!keys.some(k=>(u.id??u._id??u.email)===k||u.email===k||u._id===k));
    for(const k of keys)delete sec.userIndexes[k];
  };
  const cacheRole=(role)=>{
    if(!role)return role;
    const name=role.name??role.id??role._id;
    const idx=sec.roles.findIndex(x=>(x.name??x.id??x._id)===name);
    if(idx>=0)sec.roles[idx]=role;else sec.roles.push(role);
    if(name!=null)sec.roleByName[name]=role;
    for(const p of [].concat(role.permissions||[]))if(!sec.permissions.includes(p))sec.permissions.push(p);
    return role;
  };

  sec.cacheUser=cacheUser;
  sec.findCachedUser=(id)=>{
    if(id&&typeof id==='object'){
      return sec.users.find(u=>Object.entries(userWhere(id)).every(([k,v])=>u?.[k]===v))||null;
    }
    return sec.userIndexes[id]||sec.users.find(u=>u?.id===id||u?._id===id||u?.email===id||u?.username===id)||null;
  };
  sec.indexUser=cacheUser;
  sec.handleUser=u=>u;
  sec.getUserFinger=(options={})=>{
    const req=options?.$req||options?.req||options;
    const user=req?.session?.user||req?.user||null;
    const out={id:null,email:null,name:null,name_ar:null,name_en:null,date:new Date(),ip:req?.ip||null};
    if(user){
      const profile=user.profile||{};
      out.id=user.id??user._id??null;
      out.email=user.email??null;
      out.name=profile.name||user.name||out.email;
      out.name_ar=profile.name_ar||user.name_ar||out.email;
      out.name_en=profile.name_en||user.name_en||out.email;
    }
    return out;
  };
  sec.addUserPermission=(userId,permission,cb)=>{
    const p=(async()=>{
      const user=await sec.getUser(userId);
      if(!user){const e=new Error('User Not Found');e.code='USER_NOT_FOUND';throw e}
      user.permissions=[...new Set([].concat(user.permissions||[],permission))];
      const result=await sec.updateUser(user);
      return result.doc;
    })();
    return callbackify(p,cb);
  };

  sec.getUser=(where={},cb)=>{
    const cached=sec.findCachedUser(where);
    if(cached){if(cb)queueMicrotask(()=>cb(null,cached));return cb?undefined:Promise.resolve(cached)}
    return callbackify($users.findOne({where:userWhere(where)}),cb,u=>cacheUser(u));
  };
  sec.getUsers=(options={},cb)=>{
    options=options||{};
    const query=options.where||Object.keys(options).some(k=>['limit','skip','sort','select','projection'].includes(k))
      ? {...options}
      : {where:userWhere(options)};
    const p=Promise.all([$users.findMany(query),$users.count({where:query.where||{}})])
      .then(([docs,count])=>[docs.map(cacheUser),count]);
    if(typeof cb==='function'){p.then(([docs,count])=>cb(null,docs,count),e=>cb(e));return}
    return p.then(([docs])=>docs);
  };
  sec.loadAllUsers=(cb)=>sec.getUsers({},cb);

  sec.isUserExists=(user={},cb)=>{
    const ors=[];
    for(const k of ['email','username','mobile','phone'])if(user[k])ors.push({[k]:user[k]});
    const where=ors.length?{$or:ors}:user.id!=null?{id:user.id}:user._id!=null?{_id:user._id}:{};
    const p=$users.findMany({where,limit:10}).then(rows=>{
      const found=(rows||[]).find(doc=>{
        if(user.id!=null&&doc.id===user.id)return false;
        if(user._id!=null&&doc._id===user._id)return false;
        return true;
      });
      return !!found;
    });
    if(typeof cb==='function'){p.then(x=>cb(null,x),e=>cb(e));return}
    return p;
  };

  sec.addUser=(user={},cb)=>{
    const p=(async()=>{
      const doc=cleanDoc(user);
      if(doc.id==null){
        const rows=await $users.findMany({sort:{id:-1},limit:1});
        const max=Number(rows?.[0]?.id||0);doc.id=max+1;
      }
      const created=await $users.add(doc);
      cacheUser(created);
      site.call?.('[user][created]',created);
      return created;
    })();
    return callbackify(p,cb);
  };
  sec.register=(user,cb)=>{
    const p=(async()=>{
      if(await sec.isUserExists(user)){
        const e=new Error('User Is Exist');e.code='USER_EXISTS';throw e;
      }
      return sec.addUser(user);
    })();
    return callbackify(p,cb);
  };
  sec.updateUser=(user={},cb)=>{
    const p=(async()=>{
      const doc=cleanDoc(user);
      const where=doc._id?{_id:doc._id}:doc.id!=null?{id:doc.id}:doc.email?{email:doc.email}:{};
      const existing=await $users.findOne({where});
      if(!existing){const e=new Error('User Not Found');e.code='USER_NOT_FOUND';throw e}
      await $users.updateOne({where,set:doc});
      const merged={...existing,...doc};
      cacheUser(merged);
      site.call?.('[user][updated]',merged);
      return {done:true,count:1,doc:merged};
    })();
    return callbackify(p,cb);
  };
  sec.deleteUser=(where={},cb)=>{
    const p=(async()=>{
      const filter=userWhere(where);
      const existing=await $users.findOne({where:filter});
      if(!existing)return {done:true,count:0,doc:null};
      const result=await $users.deleteOne({where:filter});
      uncacheUser(existing);
      site.call?.('[user][deleted]',existing);
      return {done:true,count:result?.deletedCount??result?.count??1,doc:existing};
    })();
    return callbackify(p,cb);
  };

  sec.login=(credentials={},cb)=>{
    const p=(async()=>{
      const c=cleanDoc(credentials);
      const ors=[];
      for(const k of ['email','username','mobile','phone'])if(c[k]!=null)ors.push({[k]:c[k]});
      const where=ors.length>1?{$or:ors}:ors[0]||{};
      const user=await $users.findOne({where});
      if(!user||String(user.password??'')!==String(c.password??'')){
        const e=new Error('Incorrect login data');e.code='LOGIN_FAILED';throw e;
      }
      cacheUser(user);
      const req=credentials.$req,res=credentials.$res;
      if(req?.session){
        req.session.user=user;req.session.user_id=user.id??user._id;
        req.user=user;req.session.$save?.();
      }
      site.call?.('[user][login]',user,req,res);
      return user;
    })();
    return callbackify(p,cb);
  };
  sec.logout=(req,res,cb)=>{
    const p=Promise.resolve().then(()=>{
      const had=!!req?.session?.user;
      if(req?.session){
        delete req.session.user;delete req.session.user_id;delete req.session.identityRef;
        req.session.$save?.();
      }
      if(req)req.user=null;
      site.call?.('[user][logout]',req,res);
      return had;
    });
    return callbackify(p,cb);
  };
  sec.isUserLogin=req=>!!(req?.user||req?.session?.user);

  sec.getUserPermissions=u=>{
    const direct=[].concat(u?.permissions||[]);
    const roleNames=[].concat(u?.roles||u?.role||[]);
    for(const name of roleNames){
      const role=sec.roleByName[name]||sec.roles.find(r=>r?.name===name);
      if(role)direct.push(...[].concat(role.permissions||[]));
    }
    return [...new Set(direct)];
  };
  sec.getUserRoles=u=>[].concat(u?.roles||u?.role||[]);

  const legacySecurityUser=(req)=>req?.session?.user||req?.user||req;
  const legacyPermission=(req,res,permission)=>{
    const user=legacySecurityUser(req);
    if(Array.isArray(permission))return permission.every(p=>legacyPermission(req,res,p));
    permission=String(permission||'');
    let expected=true;
    if(permission==='*')return true;
    if(permission.startsWith('!')){expected=false;permission=permission.slice(1)}
    if(permission==='login')return expected?!!user:!user;
    const perms=sec.getUserPermissions(user);
    const actual=perms.includes(permission)||perms.includes('*');
    return expected?actual:!actual;
  };
  const legacyRole=(req,res,role)=>{
    const user=legacySecurityUser(req);
    if(Array.isArray(role))return role.every(r=>legacyRole(req,res,r));
    role=String(role||'');let expected=true;
    if(role==='*')return true;
    if(role.startsWith('!')){expected=false;role=role.slice(1)}
    const roles=sec.getUserRoles(user);
    const actual=roles.includes(role)||roles.includes('*');
    return expected?actual:!actual;
  };
  sec.isUserHasPermission=legacyPermission;
  sec.isUserHasPermissions=(req,res,permissions)=>{
    const list=typeof permissions==='string'?permissions.split(/[,|]/).map(x=>x.trim()).filter(Boolean):[].concat(permissions||[]);
    return list.every(p=>legacyPermission(req,res,p));
  };
  sec.isUserHasRole=legacyRole;
  sec.isUserHasRoles=(req,res,roles)=>{
    const list=typeof roles==='string'?roles.split(/[,|]/).map(x=>x.trim()).filter(Boolean):[].concat(roles||[]);
    return list.every(r=>legacyRole(req,res,r));
  };

  sec.addPermissions=(roleName,permissions,cb)=>{
    const p=(async()=>{
      let role=sec.roleByName[roleName]||await $roles.findOne({where:{name:roleName}});
      if(!role)role={name:roleName,permissions:[]};
      role.permissions=[...new Set([].concat(role.permissions||[],permissions||[]))];
      const result=role._id?await sec.updateRole(role):await sec.addRole(role);
      for(const perm of role.permissions)if(!sec.permissions.includes(perm))sec.permissions.push(perm);
      return result?.doc||result;
    })();
    return callbackify(p,cb);
  };
  sec.addRole=(role={},cb)=>{
    const p=(async()=>{
      const doc=typeof role==='string'?{name:role}:cleanDoc(role);
      if(!doc.name)doc.name=doc.id||`role_${Date.now()}`;
      const existing=await $roles.findOne({where:{name:doc.name}});
      const value=existing?{...existing,...doc}:await $roles.add(doc);
      if(existing)await $roles.updateOne({where:{_id:existing._id},set:doc});
      cacheRole(value);site.call?.('[role][created]',value);return value;
    })();
    return callbackify(p,cb);
  };
  sec.addRoles=(list,cb)=>{
    const p=Promise.all([].concat(list||[]).map(x=>sec.addRole(x)));
    return callbackify(p,cb);
  };
  sec.updateRole=(role={},cb)=>{
    const p=(async()=>{
      const doc=typeof role==='string'?{name:role}:cleanDoc(role);
      const where=doc._id?{_id:doc._id}:doc.id!=null?{id:doc.id}:{name:doc.name};
      const existing=await $roles.findOne({where});
      if(!existing)return sec.addRole(doc);
      await $roles.updateOne({where,set:doc});
      const value={...existing,...doc};cacheRole(value);site.call?.('[role][updated]',value);return {done:true,count:1,doc:value};
    })();
    return callbackify(p,cb);
  };
  sec.editeRole=sec.updateRole;
  sec.deleteRole=(role={},cb)=>{
    const p=(async()=>{
      const doc=typeof role==='string'?{name:role}:cleanDoc(role);
      const where=doc._id?{_id:doc._id}:doc.id!=null?{id:doc.id}:{name:doc.name};
      const existing=await $roles.findOne({where});
      if(!existing)return {done:true,count:0,doc:null};
      const r=await $roles.deleteOne({where});
      sec.roles=sec.roles.filter(x=>(x.name??x.id??x._id)!==(existing.name??existing.id??existing._id));
      if(existing.name)delete sec.roleByName[existing.name];
      site.call?.('[role][deleted]',existing);
      return {done:true,count:r?.deletedCount??r?.count??1,doc:existing};
    })();
    return callbackify(p,cb);
  };
  sec.removeRole=sec.deleteRole;
  sec.loadAllRoles=(cb)=>{
    const p=$roles.findMany({}).then(rows=>{rows.forEach(cacheRole);return rows});
    return callbackify(p,cb);
  };
  sec.rebuildRoleIndexes=()=>{sec.roleByName=Object.fromEntries(sec.roles.map(r=>[r.name,r]));return true};
  sec.rebuildUserIndexes=()=>{sec.userIndexes=Object.create(null);sec.users.forEach(cacheUser);return true};
  sec.removeUserFinger=()=>true;
}

  // iSite v36 session user-provider adapter.
  // Core uses `site.identity` + `session.identityRef`; legacy names remain here.
  if (site.security && typeof site.security === 'object') {
    site.security.userProviders = new Map();
    site.security.registerUserProvider = (name, provider) => {
      site.security.userProviders.set(name, provider);
      return site.identity.register(name, {
        load: (id, context) => new Promise((resolve,reject)=>{
          try {
            if (typeof provider === 'function') {
              if (provider.length >= 2) {
              const objectArg={id,user_id:id,user_source:name,context};
              let retried=false;
              const done=(err,user)=>{
                if(err)return reject(err);
                // Legacy providers commonly accept a plain string id and echo it
                // back as user.id. If the object-shaped probe leaks through as the
                // id, retry once with the historical string signature.
                if(!retried && user && user.id===objectArg){
                  retried=true;
                  try{return provider(id,(err2,user2)=>err2?reject(err2):resolve(user2))}catch(e2){return reject(e2)}
                }
                resolve(user);
              };
              try { provider(objectArg,done); } catch (e) {
                retried=true;
                try { provider(id,(err2,user2)=>err2?reject(err2):resolve(user2)); } catch (e2) { reject(e2); }
              }
            }
              else resolve(provider(id,context));
            } else if (provider?.getSessionUser) {
              provider.getSessionUser({user_id:id,user_source:name},(err,user)=>err?reject(err):resolve(user));
            } else if (provider?.load) resolve(provider.load(id,context));
            else resolve(null);
          } catch(e){reject(e)}
        })
      });
    };
    const resolveSessionTarget = target => {
      if (target && target.session && typeof target.session === 'object') return { session: target.session, request: target };
      return { session: target || {}, request: null };
    };
    site.security.getSessionUser = (target, cb) => {
      const {session}=resolveSessionTarget(target);
      const ref={provider:session.user_source,id:session.user_id};
      const p=site.identity.load(ref,{session,request:target?.session?target:null});
      if(typeof cb==='function')p.then(u=>cb(null,u),e=>cb(e));
      else return p;
    };
    site.security.setSessionUser = async (target,user,options='native') => {
      const {session}=resolveSessionTarget(target);
      const opts=(options && typeof options === 'object')?options:{source:options};
      const source=String(opts.source || opts.userSource || 'native');
      const authMethod=opts.authMethod || opts.method || null;
      session.user=user;
      session.user_id=user?.id??user?._id??user?.accountId??null;
      session.user_source=source;
      session.identityRef={provider:source,id:session.user_id};
      if(authMethod!=null) session.user_auth_method=authMethod;
      session.$userLoadedAt=Date.now();
      if(typeof session.$save==='function') await session.$save();
      else if(typeof site.saveSession==='function') await site.saveSession(session);
      assertCompat(session.user===user,'ISITE_SESSION_USER_NOT_SET','setSessionUser() did not persist session.user',{source,authMethod});
      assertCompat(session.user_id!=null,'ISITE_SESSION_USER_ID_MISSING','setSessionUser() completed without session.user_id',{source,authMethod});
      assertCompat(session.user_source===source,'ISITE_SESSION_SOURCE_MISMATCH','setSessionUser() did not preserve the requested user source',{expected:source,actual:session.user_source});
      if(authMethod!=null)assertCompat(session.user_auth_method===authMethod,'ISITE_SESSION_AUTH_METHOD_MISMATCH','setSessionUser() did not preserve authMethod',{expected:authMethod,actual:session.user_auth_method});
      assertCompat(session.identityRef?.provider===source&&session.identityRef?.id===session.user_id,'ISITE_SESSION_IDENTITY_REF_MISMATCH','setSessionUser() did not create the canonical identityRef',{identityRef:session.identityRef});
      if(target&&target.session)assertCompat(target.session===session,'ISITE_SESSION_TARGET_MISMATCH','setSessionUser(req,...) did not write to req.session');
      return user;
    };
    site.security.clearSessionUser = async target => {
      const {session}=resolveSessionTarget(target);
      session.user=null; session.user_id=null; session.user_source=null; session.user_auth_method=null; session.identityRef=null;
      session.$userLoadedAt=0;
      if(typeof session.$save==='function') await session.$save();
      else if(typeof site.saveSession==='function') await site.saveSession(session);
      return true;
    };
  }


  define('events',{
    on:(name,fn)=>{site.on(name,fn);return site.events},
    once:(name,fn)=>{site.once(name,fn);return site.events},
    off:(name,fn)=>{site.off(name,fn);return site.events},
    emit:(name,...args)=>site.emit(name,...args),
    call:(name,...args)=>site.call(name,...args),
    listenerCount:name=>site.listenerCount(name),
    removeAllListeners:name=>site.removeAllListeners(name)
  });

  define('stream',{
    ndjson:(res,iterable)=>site.streamTools.ndjson(res,iterable),
    jsonLines:(res,iterable)=>site.streamTools.ndjson(res,iterable),
    jsonArray:(res,iterable)=>site.streamTools.jsonArray(res,iterable)
  });
  site.stream.jsonLines=site.stream.ndjson;

  define('featuresV3',{
    set:(n,v)=>site.features.set(n,v), get:(n,d)=>site.features.get(n,d),
    enable:n=>site.features.enable(n),disable:n=>site.features.disable(n),
    isEnabled:n=>site.features.isEnabled(n),clear:n=>site.features.clear(n),list:()=>site.features.list()
  });

  define('query',{
    cached:(scope,q,loader,opts)=>site.queryCache.cached(scope,q,loader,opts),
    generation:scope=>site.queryCache.generation(scope),
    invalidate:scope=>site.queryCache.invalidate(scope),
    invalidateAll:()=>site.queryCache.invalidateAll(),
    key:(scope,q,opts)=>site.queryCache.key(scope,q,opts),
    stats:()=>site.queryCache.stats()
  });
  define('queryPlan',{
    clear:()=>site.queryPlan.clear(),compile:(q,o)=>site.queryPlan.compile(q,o),
    instantiate:p=>site.queryPlan.instantiate(p),key:(q,o)=>site.queryPlan.key(q,o),stats:()=>site.queryPlan.stats()
  });


// v14 sessions namespace backed by Core SessionStore.
const sessionList=[];
const attachSessionId=(session,id)=>{
  if(!session||!id)return session;
  try{Object.defineProperty(session,'$id',{value:id,writable:true,configurable:true,enumerable:false})}
  catch{session.$id=id}
  return session;
};
const sessionApi={
  $collection:null,
  byToken:Object.create(null),
  byUserId:Object.create(null),
  list:sessionList,
  path:site.sessionStore.dir,
  attach(req,res){
    site.sessionStore.attach(req,res);
    if(req.session?.$id)sessionApi.indexSession(req.session);
    return req.session;
  },
  handleSessions(){return sessionApi.loadAll()},
  indexSession(session){
    if(!session)return session;
    if(!sessionList.includes(session))sessionList.push(session);
    const id=session.$id||session.id;
    if(id)sessionApi.byToken[id]=session;
    const uid=session.user?.id??session.user_id;
    if(uid!=null)sessionApi.byUserId[uid]=session;
    return session;
  },
  invalidateUser(id){
    for(const x of [...sessionList]){
      const uid=x?.user?.id??x?.user_id;
      if(uid===id){
        delete x.user;delete x.user_id;delete x.identityRef;
        sessionApi.save(x);
      }
    }
    delete sessionApi.byUserId[id];
    return true;
  },
  loadAll(){
    const rows=[];
    try{
      for(const name of fs.readdirSync(site.sessionStore.dir)){
        if(!name.endsWith('.json'))continue;
        const id=name.slice(0,-5);
        const data=site.sessionStore.load(id);
        if(data)rows.push(attachSessionId(data,id));
      }
    }catch{}
    sessionApi.replaceList(rows);
    return sessionList;
  },
  push(session){
    sessionApi.indexSession(session);
    sessionApi.save(session);
    return session;
  },
  rebuildIndexes(){
    sessionApi.byToken=Object.create(null);
    sessionApi.byUserId=Object.create(null);
    for(const x of sessionList){
      const id=x?.$id||x?.id;if(id)sessionApi.byToken[id]=x;
      const uid=x?.user?.id??x?.user_id;if(uid!=null)sessionApi.byUserId[uid]=x;
    }
    return true;
  },
  replaceList(list){
    sessionList.splice(0,sessionList.length,...[].concat(list||[]));
    sessionApi.rebuildIndexes();
    return sessionList;
  },
  save(session){
    const id=session?.$id||session?.id;
    if(id)site.sessionStore.save(id,session);
    sessionApi.indexSession(session);
    return session;
  },
  saveAll(){for(const x of sessionList)sessionApi.save(x);return true},
  removeSession(session){
    const i=sessionList.indexOf(session);if(i>=0)sessionList.splice(i,1);
    const id=session?.$id||session?.id;if(id){delete sessionApi.byToken[id];site.sessionStore.destroy(id)}
    const uid=session?.user?.id??session?.user_id;if(uid!=null)delete sessionApi.byUserId[uid];
    return true;
  },
  getSession(id){
    const cached=sessionApi.byToken[id];
    if(cached)return cached;
    const data=site.sessionStore.load(id);
    return data?sessionApi.indexSession(attachSessionId(data,id)):null;
  },
  saveSession(id,data){
    attachSessionId(data,id);
    site.sessionStore.save(id,data);
    return sessionApi.indexSession(data);
  }
};
define('sessions',sessionApi);
define('getSession',(reqOrId,callback)=>{
  let value=null;
  if(typeof reqOrId==='string')value=sessionApi.getSession(reqOrId);
  else if(reqOrId?.session)value=reqOrId.session;
  else if(reqOrId?.headers){
    const cookie=String(reqOrId.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(site.sessionStore.cookieName+'='));
    const id=cookie?decodeURIComponent(cookie.slice(cookie.indexOf('=')+1)):'';
    value=id?sessionApi.getSession(id):null;
  }
  if(typeof callback==='function'){callback(value);return}
  return value;
});

  // Complete context surface without changing the Core context API.
  if(site.context){
    site.context.get = site.context.get || (()=>null);
    site.context.bind = site.context.bind || (()=>fn=>fn);
  }

  if(site.mongodb){
    const m=site.mongodb;
    m.ObjectId = m.ObjectID;
    m.callback = m.callback || (()=>{});
    m.closeDbBusy=false;m.connectCollectionBusy=false;m.connectDBBusy=false;
    m.collectionInflight=m.collectionInflight||Object.create(null);m.databaseInflight=m.databaseInflight||Object.create(null);
    m.findManyFast=m.findManyFast||m.findMany;
    m.findManyConcurrent=m.findManyConcurrent||m.findMany;
    m.findPageFast=m.findPageFast||((col,o,cb)=>{const p=col.findPageFast(o);if(cb)p.then(x=>cb(null,x),e=>cb(e));else return p});
    m.findByIdsFast=m.findByIdsFast||((col,ids,cb)=>{const p=col.findByIdsFast(ids);if(cb)p.then(x=>cb(null,x),e=>cb(e));else return p});
    m.findCursorFast=m.findCursorFast||((col,o)=>col.findCursorFast(o));
    m.bulkWriteFast=m.bulkWriteFast||((col,ops)=>col.transaction(ops));
    m.dropCollection=m.dropCollection||((col)=>col.deleteAll());
    m.dropIndexes=m.dropIndexes||((col)=>{for(const x of col.listIndexes())col.dropIndex(x.fields||x.field);return true});
    m.distinct=m.distinct||((col,field,o)=>col.distinct(field,o));
    m.handleDoc=m.handleDoc||(x=>x);m.observeQuery=m.observeQuery||(()=>null);
    m.telemetryStart=m.telemetryStart||(()=>performance.now());m.telemetryEnd=m.telemetryEnd||((t)=>performance.now()-t);
    // Exact aliases in v14
    m.deleteMany=m.deleteMany||m.delete;m.delete=m.deleteMany;
    m.findMany=m.findMany||m.find;m.find=m.findMany;
    m.insertMany=m.insertMany||m.insert;m.insert=m.insertMany;
    m.updateMany=m.updateMany||m.update;m.update=m.updateMany;
  }

  // iSite application-loader aliases and descriptor route syntax.
  define('loadApp',(name,opts={})=>site.loadLocalApp(name,opts));
  define('loadApps',(names,opts={})=>[].concat(names||[]).map(name=>site.loadApp(name,opts)));

  const normalizeRouteDescriptor=(input)=>{
    if(typeof input==='string'||input instanceof RegExp)return [input];
    if(Array.isArray(input))return input;
    if(input&&typeof input==='object'){
      const names=input.name??input.url??input.route;
      return Array.isArray(names)?names:[names].filter(Boolean);
    }
    return [];
  };

  const getLegacyValue=(obj,key)=>{
    const parts=String(key||'').split('.');let cur=obj;
    for(const p of parts){if(cur==null)return undefined;cur=cur[p]}
    return cur;
  };
  let legacyWordsCache=null,legacyWordsFiles=null,legacyWordsDirty=true;
  const discoverLegacyWordFiles=()=>{
    if(legacyWordsFiles)return legacyWordsFiles;
    const files=[path.join(site.cwd,'site_files','json','words.json')];
    try{for(const d of fs.readdirSync(path.join(site.cwd,'apps'),{withFileTypes:true}))if(d.isDirectory())files.push(path.join(site.cwd,'apps',d.name,'site_files','json','words.json'))}catch{}
    legacyWordsFiles=files;return files;
  };
  const loadLegacyWords=()=>{
    if(legacyWordsCache&&!legacyWordsDirty)return legacyWordsCache;
    const map=new Map();
    for(const file of discoverLegacyWordFiles()){
      try{
        const text=site.fileCache?.getTextSync?site.fileCache.getTextSync(file,'utf8'):fs.readFileSync(file,'utf8');
        const list=JSON.parse(text);
        for(const row of Array.isArray(list)?list:[])if(row?.name&&!map.has(row.name))map.set(row.name,row);
      }catch{}
    }
    legacyWordsCache=map;legacyWordsDirty=false;return map;
  };
  const invalidateLegacyWords=(file)=>{if(!file||path.basename(String(file)).toLowerCase()==='words.json')legacyWordsDirty=true};
  state.wordCacheInvalidator=invalidateLegacyWords;
  if(site.invalidation?.subscribe){
    state._wordCacheUnsubscribe=site.invalidation.subscribe('isite-words',{
      priority:70,
      invalidate:invalidateLegacyWords,
      clear:()=>{legacyWordsDirty=true}
    });
  }
  const resolveLegacyWord=(req,name)=>{
    const row=loadLegacyWords().get(name);
    const lang=req?.session?.lang||req?.session?.language?.id||site.options?.lang||'En';
    return row?.[lang]||row?.En||row?.name||name;
  };
  site.word=(name,lang)=>{
    const row=loadLegacyWords().get(name);return row?.[lang||site.options?.lang||'En']||row?.En||row?.name||name;
  };
  site.reloadWords=()=>{legacyWordsDirty=true;return loadLegacyWords()};
  if(site.runtimeProfile==='production')try{loadLegacyWords()}catch{}

const {createLegacyHtmlParser}=require('./html-parser');
const legacyHtmlParser=createLegacyHtmlParser(site,options.parser||{});
state.parser=legacyHtmlParser;

const renderLegacyFile=(file,req,data={},seen=new Set())=>{
  file=path.resolve(file);
  // Parser keeps its own bounded import-depth protection; `seen` is retained in the
  // signature for backwards compatibility with previous Core adapters.
  return legacyHtmlParser.renderFile(file,req,data,{
    res:req?.res,
    parserDir:path.dirname(file)
  });
};
state.renderLegacyFile=renderLegacyFile;

// Explicit parser surface mirrors the important iSite parser entry points while
// remaining compatibility-only.
define('parser',legacyHtmlParser);
define('createParser',(req,res,route={})=>{
  const parserDir=route.parserDir||site.dir||site.cwd;
  const ctx={req:req||{},res,parserDir,file:route.file||path.join(parserDir,'index.html'),data:req?.data||{}};
  return {
    html:content=>legacyHtmlParser.html(content,ctx),
    txt:content=>legacyHtmlParser.txt(content,ctx),
    js:content=>legacyHtmlParser.js(content,ctx),
    css:content=>legacyHtmlParser.css(content,ctx),
    handleMatches:content=>legacyHtmlParser.handleMatches(content,ctx),
    renderFile:(file,data={})=>legacyHtmlParser.renderFile(file,req,data,{...ctx,file,parserDir:path.dirname(file)})
  };
});


  // iSite merges static directories registered by multiple apps under the same URL prefix.
  // Keep one routing handler per prefix and search every registered mount for the requested file.
  state.staticMounts = state.staticMounts || new Map();
  state.staticHandlers = state.staticHandlers || new Set();
  state.staticResolvedCache = state.staticResolvedCache || new Map();
  if(!state._staticCacheInvalidator){
    state._staticCacheInvalidator=()=>state.staticResolvedCache.clear();
    if(site.invalidation?.subscribe){
      state._staticCacheUnsubscribe=site.invalidation.subscribe('isite-static-resolution',{
        priority:50,
        invalidate:state._staticCacheInvalidator,
        clear:state._staticCacheInvalidator
      });
    }
  }

  const staticPriority=(target)=>{
    const resolved=path.resolve(target);
    const main=path.resolve(site.dir);
    // Main website assets take precedence when a duplicate exists; app assets remain fallbacks.
    return resolved===main || resolved.startsWith(main+path.sep) ? 1000 : 0;
  };
  const addStaticMount=(base,target,descriptor={})=>{
    base=String(base||'/');
    if(!base.startsWith('/'))base='/'+base;
    if(base.length>1)base=base.replace(/\/+$/,'');
    const list=state.staticMounts.get(base)||[];
    const resolved=path.resolve(target);
    const existing=list.find(x=>x.target===resolved);
    let rootReal=resolved;try{rootReal=site.fileCache?.realpathSync?site.fileCache.realpathSync(resolved):fs.realpathSync(resolved)}catch{}
    if(existing){existing.descriptor=descriptor;existing.rootReal=rootReal}
    else list.push({target:resolved,rootReal,descriptor,order:list.length,priority:staticPriority(resolved)});
    for(const key of [...state.staticResolvedCache.keys()])if(key.startsWith(base+'\u0000'))state.staticResolvedCache.delete(key);
    list.sort((a,b)=>b.priority-a.priority || a.order-b.order);
    state.staticMounts.set(base,list);
    return list;
  };
  const findStaticFile=(base,reqPath)=>{
    const cacheKey=base+'\u0000'+reqPath;
    if(site.fileCache?.mode==='production'&&state.staticResolvedCache.has(cacheKey))
      return state.staticResolvedCache.get(cacheKey);
    const list=state.staticMounts.get(base)||[];
    let rel=base==='/'?reqPath.replace(/^\/+/,''):reqPath.slice(base.length).replace(/^\/+/,'');
    rel=rel||'index.html';
    for(const mount of list){
      const file=path.resolve(mount.target,rel);
      if(!file.startsWith(mount.target+path.sep)&&file!==mount.target)continue;
      try{
        const rootReal=mount.rootReal||mount.target;
        const real=site.fileCache?.realpathSync?site.fileCache.realpathSync(file):fs.realpathSync(file);
        if(real!==rootReal&&!real.startsWith(rootReal+path.sep))continue;
        const stat=statSync(real);
        if(stat.isFile()){
          const hit={file:real,descriptor:mount.descriptor};
          if(site.fileCache?.mode==='production'){
            state.staticResolvedCache.set(cacheKey,hit);
            if(state.staticResolvedCache.size>20000)state.staticResolvedCache.delete(state.staticResolvedCache.keys().next().value);
          }
          return hit;
        }
      }catch{}
    }
    return null;
  };
  const makeStaticMergedHandler=(base)=> (req,res)=>{
    const hit=findStaticFile(base,req.path);
    if(!hit)return res.status(404).end('Not Found');
    const ext=path.extname(hit.file).toLowerCase();
    if(ext==='.html'||String(hit.descriptor?.parser||'').includes('html'))return res.render(hit.file,{},hit.descriptor||{});
    try{
      const stat=statSync(hit.file);
      if(!res.getHeader('Last-Modified'))res.set('Last-Modified',new Date(stat.mtimeMs||Date.now()).toUTCString());
      if(!res.getHeader('Cache-Control')){const cc=site.staticCacheControl?.(hit.file,hit.descriptor?.cache!==false);if(cc)res.set('Cache-Control',cc)}
    }catch{}
    return res.file(hit.file);
  };


// Legacy shared-response cache and master-page surfaces used by route/render options.
site.sharedCache=site.sharedCache||new Map();
site.sharedList=site.sharedList||[];
site.sharedKey=site.sharedKey||((host,filePath,url)=>`${host||''}|${filePath||''}|${url||''}`);
site.getShared=site.getShared||((host,filePath,url)=>site.sharedCache.get(site.sharedKey(host,filePath,url))||null);
site.setShared=site.setShared||((response)=>{
  if(!response)return response;
  const key=site.sharedKey(response.host,response.filePath,response.url);
  site.sharedCache.set(key,response);
  if(!site.sharedList.includes(response))site.sharedList.push(response);
  return response;
});
site.masterPages=site.masterPages||[];
site.addMasterPage=site.addMasterPage||((page)=>{
  site.masterPages.push({name:page.name,header:page.header,footer:page.footer});
  return page;
});
const applyMasterPage=(content,descriptor={})=>{
  if(!descriptor.masterPage)return content;
  const page=site.masterPages.find(p=>p.name===descriptor.masterPage);
  if(!page)return content;
  try{
    if(descriptor.path&&page.header)site.fileCache?.trackDependency?.(descriptor.path,page.header);
    if(descriptor.path&&page.footer)site.fileCache?.trackDependency?.(descriptor.path,page.footer);
    const header=page.header?readText(page.header):'';
    const footer=page.footer?readText(page.footer):'';
    return header+content+footer;
  }catch{return content}
};
const maybeDecrypt123=(content,descriptor={})=>{
  if(descriptor.encript==='123'&&typeof site.f1==='function'){
    try{return site.f1(content)}catch{return content}
  }
  return content;
};

const legacyCompressText=(text,descriptor={})=>{
  if(!(descriptor.compress??descriptor.compres))return text;
  return typeof text==='string'?text.replace(/\r?\n|\r/g,' ').replace(/\s+/g,' '):text;
};
const descriptorContentType=(file,res)=>{
  const ext=path.extname(String(file||'')).toLowerCase();
  const types={
    '.html':'text/html; charset=utf-8','.htm':'text/html; charset=utf-8',
    '.css':'text/css; charset=utf-8','.js':'application/javascript; charset=utf-8',
    '.json':'application/json; charset=utf-8','.xml':'text/xml; charset=utf-8',
    '.txt':'text/plain; charset=utf-8','.svg':'image/svg+xml',
    '.png':'image/png','.jpg':'image/jpg','.jpeg':'image/jpeg','.gif':'image/gif',
    '.webp':'image/webp','.ico':'image/ico','.bmp':'image/bmp','.mp4':'video/mp4',
    '.woff':'application/font-woff','.woff2':'application/font-woff2',
    '.ttf':'application/font-ttf','.otf':'application/font-otf','.eot':'application/font-eot'
  };
  if(types[ext]&&!res.headersSent)res.setHeader('Content-Type',types[ext]);
  if(!res.headersSent&&!res.getHeader?.('Cache-Control')){
    const cc=site.staticCacheControl?.(file,res.req?.route?.cache!==false);
    if(cc)res.setHeader('Cache-Control',cc);
  }
};
const renderDescriptorContent=(descriptor,req,res,content,fileHint='')=>{
  const sharedHit=descriptor.shared?site.getShared(req.host,fileHint||descriptor.path,req.url):null;
  if(sharedHit){
    for(const [k,v] of Object.entries(sharedHit.headers||{}))try{res.set(k,v)}catch{}
    if(sharedHit.code)res.status(sharedHit.code);
    return res.end(sharedHit.content);
  }
  let out=applyMasterPage(maybeDecrypt123(content,descriptor),descriptor);
  const parser=String(descriptor.parser||'static').toLowerCase();
  if(typeof out==='string'){
    if(parser.includes('html'))out=legacyHtmlParser.html(out,{req,res,data:req.data||{},file:fileHint||descriptor.path||'',parserDir:descriptor.parserDir||site.dir,route:descriptor,parser:descriptor.parser});
    else if(parser==='css')out=legacyHtmlParser.css(out,{req,res,data:req.data||{},file:fileHint||'',parserDir:descriptor.parserDir||site.dir,route:descriptor});
    else if(parser==='js')out=legacyHtmlParser.js(out,{req,res,data:req.data||{},file:fileHint||'',parserDir:descriptor.parserDir||site.dir,route:descriptor});
    else if(parser==='txt')out=legacyHtmlParser.txt(out,{req,res,data:req.data||{},file:fileHint||'',parserDir:descriptor.parserDir||site.dir,route:descriptor});
    out=legacyCompressText(out,descriptor);
  }
  if(descriptor.headers)for(const [k,v] of Object.entries(descriptor.headers))res.set(k,v);
  descriptorContentType(fileHint||descriptor.path,res);
  if(descriptor.shared){
    const headers={};
    for(const [k,v] of Object.entries(res.getHeaders?.()||{}))headers[k]=v;
    site.setShared({host:req.host,url:req.url,filePath:fileHint||descriptor.path,content:out,headers,code:res.code||res.statusCode||200});
  }
  if(out&&typeof out==='object'&&!Buffer.isBuffer(out))return res.json(out);
  return res.end(out??'');
};
const makeDescriptorHandler=(descriptor)=>{
  if(!descriptor||typeof descriptor!=='object')return null;
  if(descriptor.content!==undefined){
    return (req,res)=>renderDescriptorContent(descriptor,req,res,descriptor.content,'');
  }
  if(!descriptor.path)return null;
  if(Array.isArray(descriptor.path)){
    const files=descriptor.path.map(x=>path.resolve(String(x)));
    let memoryContent=null;
    const getContent=()=>memoryContent??(memoryContent=files.map(file=>readText(file)).join(''));
    if(site.runtimeProfile==='production')try{getContent()}catch{}
    const invalidate=(file)=>{if(files.includes(path.resolve(String(file))))memoryContent=null};
    if(site.invalidation?.subscribe){
      const off=site.invalidation.subscribe(`isite-descriptor:${++state.descriptorInvalidationSeq}`,{invalidate,clear:()=>{memoryContent=null}});
      state.descriptorInvalidationUnsubscribers.add(off);
    }
    return (req,res)=>{
      try{return renderDescriptorContent(descriptor,req,res,getContent(),files.join('&&'))}
      catch(e){res.status(404);return res.end()}
    };
  }
  const target=path.resolve(String(descriptor.path));
  let isDir=false;try{isDir=isDirectory(target)}catch{}
  if(isDir){
    return (req,res)=>{
      const baseNames=normalizeRouteDescriptor(descriptor);
      let rel='';
      for(const base of baseNames){
        const normalized=String(base).startsWith('/')?String(base):'/'+String(base);
        if(req.path===normalized||req.path.startsWith(normalized+'/')){rel=req.path.slice(normalized.length).replace(/^\/+/, '');break}
      }
      const file=path.resolve(target,rel||'index.html');
      if(!file.startsWith(target+path.sep)&&file!==target)return res.status(403).end('Forbidden');
      try{
        const stat=statSync(file);
        if(!stat.isFile())return res.status(404).end('Not Found');
        if(String(descriptor.parser||'').includes('html'))return res.render(file,{},descriptor);
        if(String(descriptor.parser||'')==='css')return renderDescriptorContent(descriptor,req,res,readText(file),file);
        if(String(descriptor.parser||'')==='js')return renderDescriptorContent(descriptor,req,res,readText(file),file);
        descriptorContentType(file,res);
        return res.file(file);
      }catch{return res.status(404).end('Not Found')}
    };
  }
  let memoryContent=null;
  const getContent=()=>memoryContent??(memoryContent=readText(target));
  if(site.runtimeProfile==='production')try{getContent()}catch{}
  const invalidate=(file)=>{if(path.resolve(String(file))===target)memoryContent=null};
  if(site.invalidation?.subscribe){
    const off=site.invalidation.subscribe(`isite-descriptor:${++state.descriptorInvalidationSeq}`,{invalidate,clear:()=>{memoryContent=null}});
    state.descriptorInvalidationUnsubscribers.add(off);
  }
  return (req,res)=>{
    try{return renderDescriptorContent(descriptor,req,res,getContent(),target)}
    catch(e){return res.status(404).end()}
  };
};


const routeMethodFromName=(methodName)=>methodName==='all'?'ALL':methodName.replace(/^on/,'').toUpperCase();
const finalizeRouteMeta=(meta,rawPattern,internalMethod)=>{
  const raw=String(rawPattern||'/');
  const rawParts=raw.split('/');
  const lowParts=raw.toLowerCase().split('/');
  const map=[];
  for(let i=0;i<lowParts.length;i++){
    if(lowParts[i].startsWith(':')){
      const lowName=lowParts[i].slice(1);
      const rawName=rawParts[i]?.slice(1)||lowName;
      lowParts[i]='*';
      map.push({index:i,name:lowName,isLower:false});
      if(rawName!==lowName)map.push({index:i,name:rawName,isLower:true});
    }
  }
  meta.name=lowParts.join('/').replace('//','/');
  meta.nameRaw=raw.replace('//','/');
  meta.map=map;
  if(internalMethod==='ALL')meta.method='*';
  return meta;
};
const routeDefaults=()=>({
  public:site.options?.public||false,
  require:site.options?.require||{features:[],permissions:[]},
  defaults:site.options?.defaults||{features:[],permissions:[]},
  dir:site.dir
});
const routeConflict=(method,pattern)=>{
  const target=String(pattern);
  return site.router?.routes?.find(r=>r.method===method&&String(r.pattern)===target)||null;
};
const removeRouteConflict=(method,pattern)=>{
  if(!site.router?.routes)return;
  const target=String(pattern);
  site.router.routes=site.router.routes.filter(r=>!(r.method===method&&String(r.pattern)===target));
  site.router.rebuild?.();
};
const wrapRoute=(methodName,original)=>{
  site[methodName]=(descriptor,handler)=>{
    let patterns=normalizeRouteDescriptor(descriptor);
    const method=routeMethodFromName(methodName);
    const rawDescriptor=typeof descriptor==='object'&&descriptor?descriptor:{name:descriptor};

    // iSite expands a directory route into routable files. The merged mount implementation
    // keeps the same URL contract while allowing multiple apps to contribute to one prefix.
    if(typeof handler!=='function'&&rawDescriptor.path&&!Array.isArray(rawDescriptor.path)){
      const target=path.resolve(String(rawDescriptor.path));
      let isDir=false;try{isDir=isDirectory(target)}catch{}
      if(isDir){
        for(const raw of patterns){
          let base=String(raw||'/');
          if(!base.startsWith('/'))base='/'+base;
          if(base.length>1)base=base.replace(/\/+$/,'');
          base=base.toLowerCase();
          addStaticMount(base,target,rawDescriptor);

          const wildcard=base==='/'?'/*':base+'/*';
          const exact=base;
          const handlerKey=`${methodName}:${base}`;
          if(!state.staticHandlers.has(handlerKey)){
            state.staticHandlers.add(handlerKey);
            const mergedBase=makeStaticMergedHandler(base);
            const meta=finalizeRouteMeta(httpCompat.routeMeta({...rawDescriptor,name:exact},method,routeDefaults()),exact,method);
            const merged=async(req,res)=>{
              httpCompat.finalizeParams(req,meta.nameRaw||exact,req.params);
              if(!await httpCompat.enforceRoute(site,req,res,meta))return res;
              return mergedBase(req,res);
            };
            let hasIndex=false;
            for(const m of state.staticMounts.get(base)||[]){
              try{if(isFile(path.join(m.target,'index.html'))){hasIndex=true;break}}catch{}
            }
            if(hasIndex&&!routeConflict(method,exact))original(exact,merged);
            if(!routeConflict(method,wildcard))original(wildcard,merged);
          }else{
            const hasExact=!!routeConflict(method,exact);
            if(!hasExact){
              try{
                if(isFile(path.join(target,'index.html'))){
                  const meta=finalizeRouteMeta(httpCompat.routeMeta({...rawDescriptor,name:exact},method,routeDefaults()),exact,method);
                  original(exact,async(req,res)=>{
                    httpCompat.finalizeParams(req,meta.nameRaw||exact,req.params);
                    if(!await httpCompat.enforceRoute(site,req,res,meta))return res;
                    return makeStaticMergedHandler(base)(req,res);
                  });
                }
              }catch{}
            }
          }
        }
        return site;
      }
    }

    const actualHandler=typeof handler==='function'?handler:makeDescriptorHandler(rawDescriptor);
    if(!patterns.length)return site;
    for(const rawPattern of patterns){
      if(rawPattern instanceof RegExp){
        const meta=httpCompat.routeMeta({...rawDescriptor,name:String(rawPattern)},method,routeDefaults());
        const wrapped=async(req,res)=>{
          req.route=meta;meta.count=(meta.count||0)+1;
          if(!await httpCompat.enforceRoute(site,req,res,{...meta,count:meta.count-1}))return res;
          return actualHandler?.(req,res);
        };
        original(rawPattern,wrapped);
        continue;
      }

      let raw=String(rawPattern||'/');
      if(!raw.startsWith('/'))raw='/'+raw;
      raw=raw.replace('//','/');
      const pattern=raw.toLowerCase();
      const meta=finalizeRouteMeta(httpCompat.routeMeta({...rawDescriptor,name:pattern},method,routeDefaults()),raw,method);
      meta.callback=actualHandler;
      meta.compress=rawDescriptor.compress??rawDescriptor.compres??false;

      const existing=routeConflict(method,pattern);
      if(existing&&!rawDescriptor.overwrite)continue;
      if(existing&&rawDescriptor.overwrite)removeRouteConflict(method,pattern);

      const wrapped=async(req,res)=>{
        httpCompat.finalizeParams(req,raw,req.params);
        if(!await httpCompat.enforceRoute(site,req,res,meta))return res;
        return actualHandler?.(req,res);
      };
      // Attach metadata to the executable function as a convenient diagnostic surface.
      wrapped.isiteRoute=meta;
      original(pattern,wrapped);
    }
    return site;
  };
  state.aliases.push(methodName);
};


// Wrap the normal Core verbs first.
for(const methodName of ['get','post','put','patch','delete','all']){
  if(typeof site[methodName]==='function')wrapRoute(methodName,site[methodName].bind(site));
}
// Native Core already owns the onVERB names. While iSite compatibility is
// active they must point at the wrapped compatibility routes, then uninstall
// restores the original Native Core descriptors.
override('onGET',site.get);override('onPOST',site.post);override('onPUT',site.put);override('onPATCH',site.patch);override('onDELETE',site.delete);
override('onALL',site.all);override('onANY',site.all);

// Rebind the extended iSite HTTP verbs through the same descriptor/metadata path.
const legacyRouteVerbs=['OPTIONS','HEAD','CONNECT','TRACE','COPY','LOCK','MKCOL','MOVE','PROPFIND','PROPPATCH','UNLOCK','REPORT','MKACTIVITY','CHECKOUT','MERGE','M-SEARCH','NOTIFY','SUBSCRIBE','UNSUBSCRIBE','PURGE','LINK','UNLINK','VIEW','TEST'];
for(const verb of legacyRouteVerbs){
  const name='on'+verb.replace(/-/g,'');
  site[name]=(descriptor,handler)=>{
    const register=(pattern,wrapped)=>{site.router.add(verb,pattern,wrapped);return site};
    const tempName='__isite_'+name;
    const prev=site[tempName];
    site[tempName]=(p,h)=>register(p,h);
    // inline route wrapper semantics for the extended verb
    let patterns=normalizeRouteDescriptor(descriptor);
    const rawDescriptor=typeof descriptor==='object'&&descriptor?descriptor:{name:descriptor};
    const actualHandler=typeof handler==='function'?handler:makeDescriptorHandler(rawDescriptor);
    for(const rp of patterns){
      let raw=String(rp||'/');if(!raw.startsWith('/'))raw='/'+raw;raw=raw.replace('//','/');
      const pattern=raw.toLowerCase();
      const meta=finalizeRouteMeta(httpCompat.routeMeta({...rawDescriptor,name:pattern},verb,routeDefaults()),raw,verb);
      const existing=routeConflict(verb,pattern);
      if(existing&&!rawDescriptor.overwrite)continue;
      if(existing&&rawDescriptor.overwrite)removeRouteConflict(verb,pattern);
      const wrapped=async(req,res)=>{
        httpCompat.finalizeParams(req,raw,req.params);
        if(!await httpCompat.enforceRoute(site,req,res,meta))return res;
        return actualHandler?.(req,res);
      };
      wrapped.isiteRoute=meta;
      register(pattern,wrapped);
    }
    if(prev)site[tempName]=prev;else delete site[tempName];
    return site;
  };
  if(!state.aliases.includes(name))state.aliases.push(name);
}



// Public iSite routing namespace. This is an adapter over Core Router; it intentionally
// exposes legacy names and route metadata without changing Core's native Router API.
const routing={
  invalidateIndex(){site.router.rebuild?.();return true},
  rebuildIndex(){site.router.rebuild?.();return true},
  findRoute(pathname,method='GET'){
    const found=site.router.match(String(method).toUpperCase(),String(pathname||'/').toLowerCase());
    return found?.route?.handler?.isiteRoute||found?.route?.isiteRoute||found?.route||null;
  },
  onREQUEST(type,descriptor,callback){
    const method=String(type||'GET').toUpperCase();
    const map={
      GET:'get',POST:'post',PUT:'put',PATCH:'patch',DELETE:'delete','*':'all',ALL:'all'
    };
    const direct=map[method];
    if(direct)return site[direct](descriptor,callback);
    const name='on'+method.replace(/-/g,'');
    if(typeof site[name]==='function')return site[name](descriptor,callback);
    throw new Error(`Unsupported legacy route method: ${method}`);
  },
  add(route,callback){
    if(Array.isArray(route)){for(const r of route)routing.add(r,callback);return routing}
    if(typeof route==='string')return site.get(route,callback);
    if(route?.name&&Array.isArray(route.name)){
      for(const name of route.name)routing.add({...route,name},callback);
      return routing;
    }
    const methods=String(route?.method||'GET').split('|').map(x=>x.trim()).filter(Boolean);
    for(const method of methods)routing.onREQUEST(method,route,callback||route?.callback);
    return routing;
  },
  off(route){
    const r=typeof route==='string'?{name:route}:{...(route||{})};
    let name=r.name?String(r.name):null;
    if(name&&!name.startsWith('/'))name='/'+name;
    if(name)name=name.toLowerCase();
    const method=r.method?String(r.method).toUpperCase():null;
    if(site.router?.routes){
      site.router.routes=site.router.routes.filter(row=>{
        const nameMatch=!name||httpCompat.wildcardLike(String(row.pattern).toLowerCase(),name);
        const methodMatch=!method||httpCompat.wildcardLike(row.method,method);
        return !(nameMatch&&methodMatch);
      });
      site.router.rebuild?.();
    }
    return routing;
  },
  async call(route,req,res,callback){
    const r=typeof route==='string'?{name:route,method:req?.method||'GET'}:route;
    const name=r?.name;
    if(name){
      const target=String(name).startsWith('/')?String(name):'/'+String(name);
      const found=site.router.match(String(r.method||req?.method||'GET').toUpperCase(),target.toLowerCase());
      if(found?.route){
        req.route=found.route.handler?.isiteRoute||found.route;
        req.params={...(req.params||{}),...(found.params||{})};
        return found.route.handler(req,res);
      }
    }
    if(typeof callback==='function')return callback(req,res);
    return undefined;
  },
  handleServer(req,res){return site.handler(req,res)},
  start(ports,callback){
    if(typeof ports==='function')return site.run(ports);
    const result=site.run(ports);
    if(typeof callback==='function')site.once('ready',()=>callback(site.servers));
    return result;
  }
};
Object.defineProperty(routing,'list',{
  enumerable:true,
  get:()=>site.router.routes.map(row=>row.handler?.isiteRoute||row.isiteRoute||{
    name:row.pattern,nameRaw:row.pattern,method:row.method,callback:row.handler,count:0
  })
});
for(const verb of ['GET','POST','PUT','PATCH','DELETE','OPTIONS','HEAD','CONNECT','TRACE','COPY','LOCK','MKCOL','MOVE','PROPFIND','PROPPATCH','UNLOCK','REPORT','MKACTIVITY','CHECKOUT','MERGE','M-SEARCH','NOTIFY','SUBSCRIBE','UNSUBSCRIBE','PURGE','LINK','UNLINK','VIEW','TEST']){
  const key='on'+verb.replace(/-/g,'');
  if(typeof site[key]==='function')routing[key]=site[key];
  else routing[key]=(r,cb)=>routing.onREQUEST(verb,r,cb);
}
routing.onALL=site.onALL||site.all;
routing.onANY=site.onANY||routing.onALL;
define('routing',routing);



  state.renderResolutionCache=state.renderResolutionCache||new Map();
  const resolveLegacyRenderFile=(file,opts={})=>{
    if(!file)return null;
    const resolutionKey=String(opts?.parserDir||'')+'\u0000'+String(file);
    if(site.runtimeProfile==='production'&&state.renderResolutionCache.has(resolutionKey))return state.renderResolutionCache.get(resolutionKey);
    if(path.isAbsolute(file)){
      try{if(isFile(file)){if(site.runtimeProfile==='production')state.renderResolutionCache.set(resolutionKey,file);return file}}catch{}
    }
    const rel=String(file).replace(/^\/+/,'');
    const candidates=[
      path.resolve(site.cwd,rel),
      path.resolve(site.dir,rel),
      path.resolve(site.dir,'html',rel)
    ];
    if(opts?.parserDir){
      const parserDir=path.resolve(String(opts.parserDir));
      const appName=path.basename(parserDir);
      const stripped=rel.startsWith(appName+'/')?rel.slice(appName.length+1):rel;
      candidates.unshift(
        path.resolve(parserDir,rel),
        path.resolve(parserDir,'site_files',rel),
        path.resolve(parserDir,'site_files','html',rel),
        path.resolve(parserDir,'site_files','html',stripped),
        path.resolve(parserDir,'site_files',stripped)
      );
    }
    // Common iSite convention: "app-name/file.html" resolves into apps/app-name/site_files/html/file.html.
    const slash=rel.indexOf('/');
    if(slash>0){
      const appName=rel.slice(0,slash),rest=rel.slice(slash+1);
      candidates.push(
        path.resolve(site.cwd,'apps',appName,'site_files','html',rest),
        path.resolve(site.cwd,'apps',appName,'site_files',rest)
      );
    }
    for(const candidate of candidates){
      if(isFile(candidate)){if(site.runtimeProfile==='production'){state.renderResolutionCache.set(resolutionKey,candidate);if(state.renderResolutionCache.size>20000)state.renderResolutionCache.delete(state.renderResolutionCache.keys().next().value)}return candidate}
    }
    const fallback=path.resolve(site.cwd,rel);if(site.runtimeProfile==='production')state.renderResolutionCache.set(resolutionKey,fallback);return fallback;
  };
  state.resolveLegacyRenderFile=resolveLegacyRenderFile;
  // Render adapter is installed as middleware, after aisite has created res helpers.
  site.use((req,res,next)=>{
    res.render=(file,data={},opts={})=>{
      try{
        if(file&&typeof file==='object'){opts={...opts,...file};file=file.path}
        const resolved=resolveLegacyRenderFile(file,opts);
        const sharedHit=opts.shared?site.getShared(req.host,resolved,req.url):null;
        if(sharedHit){
          for(const [k,v] of Object.entries(sharedHit.headers||{}))try{res.set(k,v)}catch{}
          if(sharedHit.code)res.status(sharedHit.code);
          return res.end(sharedHit.content);
        }
        req.data={...(req.data||{}),...(data||{})};
        let source=readText(resolved);
        source=applyMasterPage(maybeDecrypt123(source,opts),opts);
        let html=legacyHtmlParser.html(source,{
          req,res,data:req.data,file:resolved,
          parserDir:opts.parserDir||path.dirname(resolved),
          route:opts,parser:opts.parser
        });
        html=legacyCompressText(html,opts);
        res.set('Content-Type','text/html');
        if(!res.getHeader('Cache-Control')){const cc=site.staticCacheControl?.(resolved,opts.cache!==false);if(cc)res.set('Cache-Control',cc)}
        res.status(opts.code||200);
        if(opts.shared){
          const headers={};
          for(const [k,v] of Object.entries(res.getHeaders?.()||{}))headers[k]=v;
          site.setShared({host:req.host,url:req.url,filePath:resolved,content:html,headers,code:res.code||200});
        }
        res.end(html);return res;
      }catch(e){
        if(data&&data.html)return res.status(404).htmlContent(data.html);
        e.statusCode=e.code==='ENOENT'?404:500;throw e
      }
    };
    res.html=res.render;

    const renderLegacyAsset=(kind,file,data={})=>{
      try{
        const resolved=resolveLegacyRenderFile(file,{parserDir:req.route?.parserDir||site.dir});
        const content=readText(resolved);
        req.data={...(req.data||{}),...(data||{})};
        const ctx={req,res,data:req.data,file:resolved,parserDir:path.dirname(resolved),route:req.route||{},parser:kind};
        let out=content;
        if(req.route?.encript==='123'&&site.f1)out=site.f1(out);
        if(kind==='txt')out=legacyHtmlParser.txt(out,ctx);
        else if(kind==='css')out=legacyHtmlParser.css(out,ctx);
        else if(kind==='js')out=legacyHtmlParser.js(out,ctx);
        else if(kind==='json')out=legacyHtmlParser.html(out,ctx);
        const ct=kind==='css'?'text/css':kind==='js'?'text/javascript':kind==='json'?'application/json':'text/plain';
        res.set('Content-Type',ct);
        return res.status(200).end(out);
      }catch(e){return res.status(404).end()}
    };
    res.txt=(file,data)=>renderLegacyAsset('txt',file,data);
    res.css=(file,data)=>renderLegacyAsset('css',file,data);
    res.js=(file,data)=>renderLegacyAsset('js',file,data);
    res.jsonFile=(file,data)=>renderLegacyAsset('json',file,data);

    const coreDownload=res.download;
    res.download=(file,arg)=>{
      if(typeof arg==='function'){
        let done=false;const finish=(err)=>{if(done)return;done=true;arg(err)};
        res.once('finish',()=>finish(null));res.once('error',finish);
        return coreDownload(file);
      }
      return coreDownload(file,arg);
    };
    res.download2=res.download;
    return next();
  });
  // Legacy utility semantics required by real iSite applications.

  // Exact legacy date helpers stay in the iSite adapter.
  const legacyDateTime=(value)=>{
    const d=value?new Date(value):new Date();
    return new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate(),d.getHours(),d.getMinutes(),d.getSeconds()));
  };
  state.originalDateHelpers={
    getDate:site.getDate,
    getDateTime:site.getDateTime,
    toDateTime:site.toDateTime
  };
  site.getDate=(value)=>{
    const d=value?new Date(value):new Date();
    return new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate(),12,0,0));
  };
  site.getDateTime=legacyDateTime;
  site.toDateTime=legacyDateTime;
  define('fromJSON',(data,Default={})=>{
    try{
      if(!data)return Default;
      if(typeof data==='string'&&data!=='')return JSON.parse(data);
      if(typeof data==='object')return data;
    }catch{}
    return Default;
  });
  define('toJSON',(obj)=>obj==null?'':JSON.stringify(obj));
  define('getRegExp',(txt,flag='gium')=>{try{return new RegExp(txt,flag)}catch{return txt}});
  define('newURL',(url,base='https://egytag.com')=>{
    try{const u=new URL(url,base);return{protocol:u.protocol,slashes:true,auth:`${u.username}:${u.password}`,host:u.host,port:u.port,hostname:u.hostname,hash:u.hash,search:u.search,query:Object.fromEntries(u.searchParams),pathname:u.pathname,path:u.pathname+u.search,href:u.href}}
    catch{return{href:url,origin:'',protocol:'',username:'',password:'',host:'',hostname:'',port:'',pathname:url,search:'',searchParams:{},hash:'',query:{}}}
  });
  define('randomNumber',(min,max)=>Math.floor(Math.random()*((Number(max)+1)-Number(min))+Number(min)));
  define('saveSession',(session)=>{
    const id=session?.$id||session?.id;
    if(id)site.sessionStore.save(id,session);
    return session;
  });
  define('eval',(script,asFunction=false)=>{
    if(asFunction)return new Function('return ('+String(script)+')')();
    return (0,eval)(String(script));
  });

  // iSite's site.storage(name[,value]) is a small persistent key-value helper.
  // Keep aisite's storage engines reachable through storage.engines.
  if(typeof site.storage!=='function'){
    const coreStorage=site.storage;
    const memoryStore=new Map();
    const storageFn=function(name,value){
      const key=String(name);
      if(arguments.length>1){memoryStore.set(key,value);return value;}
      return memoryStore.get(key);
    };
    storageFn.engines=coreStorage?.engines||coreStorage;
    storageFn.map=memoryStore;
    site.storage=storageFn;
    state.aliases.push('storage');
  }

// Legacy WebSocket lifecycle namespace.
if(!site.ws){
  site.ws={
    clientList:[],supportedClientList:[],
    onNewClient:null,onNewSupportedClient:null,
    sendAll(message){for(const c of [...this.clientList]){try{c.send(message)}catch{}}return true},
    sendSupported(message){for(const c of [...this.supportedClientList]){try{c.send(message)}catch{}}return true},
    stopHeartbeat(){if(this._heartbeat){clearInterval(this._heartbeat);this._heartbeat=null}return true}
  };
  state.aliases.push('ws');
}
site.ws.sendToAll=site.ws.sendToAll||site.ws.sendAll;
site.ws.closeAll=site.ws.closeAll||function(){
  for(const client of [...(this.clientList||[])])try{client.close?.()}catch{}
  this.clientList.length=0;this.supportedClientList.length=0;return true;
};
site.ws.wsSupport=site.ws.wsSupport||(()=>true);
site.ws.start=site.ws.start||((options,callback)=>{
  if(typeof options==='function'){callback=options;options={}}
  callback?.(site.ws);
  return site.ws;
});

state.originalOnWS=site.onWS;
state.originalWebsocket=site.websocket;
const rawOnWS=site.onWS.bind(site);
site.onWS=(pattern,handler)=>{
  return rawOnWS(pattern,(client,req)=>{
    client.path=req.urlParser?.pathname||req.path||String(req.url||'').split('?')[0];
    client.query=req.query||{};
    client.params=req.params||{};
    client.request=req;
    client.session=req.session||{};
    client.user=req.user||req.session?.user||null;
    client.state='open';
    client.supported=false;

    const rawSend=client.send.bind(client);
    client.send=(message)=>{
      if(message&&typeof message==='object'&&!Buffer.isBuffer(message))return rawSend(JSON.stringify(message));
      return rawSend(message);
    };
    client.sendMessage=client.send;
    client.markSupported=(value=true)=>{
      client.supported=!!value;
      const list=site.ws.supportedClientList;
      const i=list.indexOf(client);
      if(client.supported&&i<0){
        list.push(client);
        try{site.ws.onNewSupportedClient?.(client)}catch{}
      }else if(!client.supported&&i>=0)list.splice(i,1);
      return client.supported;
    };

    const originalClose=client.close.bind(client);
    client.close=(...args)=>{client.state='closed';return originalClose(...args)};
    client.on('message',(raw,isBinary)=>{
      let message=raw;
      if(!isBinary&&typeof raw==='string'){
        try{message=JSON.parse(raw)}catch{}
      }
      try{client.onMessage?.(message,isBinary)}catch(e){client.emit('error',e)}
    });
    client.on('close',()=>{
      client.state='closed';
      let i=site.ws.clientList.indexOf(client);if(i>=0)site.ws.clientList.splice(i,1);
      i=site.ws.supportedClientList.indexOf(client);if(i>=0)site.ws.supportedClientList.splice(i,1);
      try{client.onClose?.()}catch{}
    });
    client.on('error',err=>{try{client.onError?.(err)}catch{}});

    site.ws.clientList.push(client);
    try{site.ws.onNewClient?.(client)}catch{}
    return handler?.(client,req);
  });
};
site.websocket=site.onWS;

state.originalWsPrepare=site._isitePrepareWebSocketRequest;
state.originalWsMatchPath=site._isiteWebSocketMatchPath;
site._isiteWebSocketMatchPath=(req,u)=>req.urlParser?.pathname||String(u?.pathname||'/').toLowerCase();
site._isitePrepareWebSocketRequest=async(req)=>{
  const cookieHeader=String(req.headers?.cookie||'');
  req.cookies=Object.fromEntries(cookieHeader.split(';').map(x=>x.trim()).filter(Boolean).map(pair=>{
    const i=pair.indexOf('=');
    const k=i<0?pair:pair.slice(0,i),v=i<0?'':pair.slice(i+1);
    try{return [k,decodeURIComponent(v)]}catch{return [k,v]}
  }));
  const fakeRes={cookie(){return fakeRes}};
  site.sessionStore.attach(req,fakeRes);
  await site.sessionStore.hydrateIdentity(req);
  req.user=req.user||req.session?.user||null;
  const proto=req.socket?.encrypted?'https:':'http:';
  const host=req.headers?.host||'localhost';
  const parsed=httpCompat.lowerQueryFromUrl(req.url||'/',host,proto);
  req.urlRaw=req.url;req.urlParserRaw=parsed.urlParserRaw;req.urlParser=parsed.urlParser;
  req.path=parsed.urlParser.pathname;req.queryRaw=parsed.queryRaw;req.query=parsed.query;
  req.ip=String(req.socket?.remoteAddress||'').replace(/^::ffff:/,'').replace(/^::1$/,'127.0.0.1');
  return req;
};

  define('newTelegramBot',(token)=>{
    const bot={
      token:String(token||''),
      async sendMessage(chatID,message){
        if(options.external===false)return {ok:true,suppressed:true,chatID:String(chatID)};
        const url=`https://api.telegram.org/bot${bot.token}/sendMessage`;
        const r=await fetch(url,{
          method:'POST',
          headers:{'content-type':'application/json'},
          body:JSON.stringify({chat_id:String(chatID),text:String(message??'')})
        });
        if(!r.ok)throw new Error(`Telegram HTTP ${r.status}`);
        return r.json();
      }
    };
    return bot;
  });
  define('sendTelegramMessage',(token,chatID,message)=>{
    const bot=site.newTelegramBot(token);
    // Match iSite's fire-and-return-bot behavior; avoid unhandled rejection noise.
    Promise.resolve(bot.sendMessage(chatID,message)).catch(err=>site.logger?.warn?.('[telegram]',err.message));
    return bot;
  });
  define('telegramInit',(token,onNewMessage,polling=true)=>{
    const bot=site.newTelegramBot(token);
    bot.onNewMessage=typeof onNewMessage==='function'?onNewMessage:null;
    bot.polling=polling!==false;
    return bot;
  });
  define('connectTelegramClient',(session,apiId,apiHash,opts={})=>{
    if(opts?.client)return opts.client;
    const err=Object.assign(new Error('Telegram client integration requires an application-provided Telegram client adapter'),{code:'ISITE_OPTIONAL_TELEGRAM_CLIENT',session,apiId});
    if(opts?.optional===true)return null;
    throw err;
  });

  const optionalIntegrationError=(name,dependency)=>Object.assign(
    new Error(`${name} requires optional integration ${dependency||name}`),
    {code:'ISITE_OPTIONAL_INTEGRATION_MISSING',integration:name,dependency:dependency||name}
  );
  const mailSend=(mail,callback)=>{
    const run=async()=>{
      if(site.mailTransport?.sendMail)return site.mailTransport.sendMail(mail);
      if(site.mail?.sendMail)return site.mail.sendMail(mail);
      throw optionalIntegrationError('sendMail','mail transport / nodemailer');
    };
    const promise=Promise.resolve().then(run);
    if(typeof callback==='function'){promise.then(x=>callback(null,x),e=>callback(e));return}
    return promise;
  };
  define('sendMail',mailSend);
  define('sendEmail',mailSend);
  define('sendFreeMail',mailSend);
  define('sendSmptMail',mailSend);
  define('checkMailConfig',(mail,callback)=>{
    const ok=!!(mail&&(mail.host||mail.service||site.mailTransport||site.mail));
    const result={ok,mail};
    if(typeof callback==='function'){callback(null,result);return}
    return result;
  });
  define('initFontKit',(opts={},callback)=>{
    let value=null,error=null;
    try{value=opts.fontkit||require('fontkit')}catch(e){error=optionalIntegrationError('initFontKit','fontkit')}
    if(typeof callback==='function'){callback(error,value);return}
    if(error)throw error;
    return value;
  });
  define('loadPDF',(opts={},callback)=>{
    let value=null,error=null;
    try{
      const pdf=opts.PDF||opts.pdf||require('pdfjs-dist');
      value=pdf;
    }catch(e){error=optionalIntegrationError('loadPDF','PDF adapter')}
    if(typeof callback==='function'){callback(error,value);return}
    if(error)throw error;
    return value;
  });
  define('startProxy',(opts={})=>{
    if(site._legacyProxyServer)return site._legacyProxyServer;
    if(typeof site.createHttpProxyServer==='function'){
      site._legacyProxyServer=site.createHttpProxyServer(opts);
      return site._legacyProxyServer;
    }
    throw optionalIntegrationError('startProxy','Core HTTP proxy server');
  });
  // closeProxy was installed earlier; replace it with a real optional server closer.
  if(typeof site.closeProxy==='function'){
    const originalCloseProxy=site.closeProxy;
    override('closeProxy',async()=>{
      const server=site._legacyProxyServer;
      site._legacyProxyServer=null;
      if(server?.close)return await new Promise(resolve=>server.close(()=>resolve(true)));
      return originalCloseProxy();
    });
  }

  define('require',(filePath)=>{
    if(!filePath)return null;
    const resolved=path.isAbsolute(filePath)?filePath:path.resolve(site.cwd,String(filePath));
    const mod=require(resolved);
    if(typeof mod==='function'){
      const out=mod(site);
      return out===undefined?mod:out;
    }
    return mod;
  });

  // Legacy helpers and aliases.

  define('get_RegExp',(txt,flag='gium')=>site.regex(txt,flag));
  define('getRegExp',site.get_RegExp);
  define('fetch',site.fetch);
  define('request',site.request);
  define('fetchURLContent',(options,cb)=>{
    const url=typeof options==='string'?options:options?.url;
    const p=site.request(url,typeof options==='object'?options:{})
      .then(async r=>({status:r.status,headers:Object.fromEntries(r.headers.entries()),body:await r.text()}));
    if(typeof cb==='function')p.then(x=>cb(null,x),e=>cb(e));else return p;
  });

  define('AdaptiveCache',site.AdaptiveCache);
  define('AsyncPool',site.AsyncPool);
  define('BackpressureQueue',site.BackpressureQueue);
  define('adaptiveCache',opts=>new site.AdaptiveCache(opts));
  define('backpressureQueue',opts=>new site.BackpressureQueue(opts));
  define('adaptiveCaches',[]);
  define('backpressureQueues',[]);
  define('cacheTuner',{stats:()=>site.cache?.size?.()||0});
  define('circuitBreaker',(opts={})=>{
    let failures=0,openUntil=0;
    return async fn=>{
      if(Date.now()<openUntil)throw new Error('Circuit open');
      try{const v=await fn();failures=0;return v}catch(e){if(++failures>=Number(opts.failures||5))openUntil=Date.now()+Number(opts.resetMs||1000);throw e}
    };
  });
  define('createBatcher',(opts={})=>{
    const rows=[],max=Number(opts.max||100);
    return {push:x=>(rows.push(x),rows.length>=max),flush:()=>rows.splice(0),size:()=>rows.length};
  });
  define('createIdBatcher',site.createBatcher);
  define('deleteFile',(file,cb)=>{const p=site.files.delete(file);if(cb)p.then(x=>cb(x));else return p});
  define('deleteFileSync',site.files.deleteSync);
  define('download',async(url,file)=>{
    const r=await fetch(url);if(!r.ok)throw new Error(`HTTP ${r.status}`);
    const b=Buffer.from(await r.arrayBuffer());site.files.writeSync(file,b);return file;
  });
  define('backupDB',async(name='all',label='manual')=>{
    const out=[];for(const [n,col] of site.collections)if(name==='all'||name===n)out.push(col.backup(label));return out;
  });
  define('restoreDB',(options={},callback)=>{
    const run=async()=>{
      if(typeof options==='string')options={file:options};
      const name=options.collection||options.name||'all';
      const file=options.file||options.path;
      if(!file)throw Object.assign(new Error('restoreDB requires a backup file path'),{code:'ISITE_RESTORE_FILE_REQUIRED'});
      const targets=[...site.collections].filter(([n])=>name==='all'||n===name);
      if(!targets.length&&name!=='all'){
        const col=site.connectCollection(name);
        return [col.restore(file)];
      }
      return targets.map(([,col])=>col.restore(file));
    };
    const promise=Promise.resolve().then(run);
    if(typeof callback==='function'){promise.then(x=>callback(null,x),e=>callback(e));return}
    return promise;
  });
  define('dd',(...args)=>args.length<=1?args[0]:args);
  define('defaultFontOptions',{});
  define('abort',{controllers:new Set(),create(){const c=new AbortController();this.controllers.add(c);return c},all(){for(const c of this.controllers)c.abort();this.controllers.clear()}});
  for(const v of [4,5,6,7,8,9,10,11,15,16,17]) define('coreV'+v,{});

  // iSite advanced core aliases mapped to generic aisite Core facilities.
  define('events',site);
  define('scheduler',site.scheduler);
  define('hooks',site.hooks);
  define('inflight',site.inflight);
  define('responseCache',site.responseCache);
  define('mongoShapes',site.queryShapes);
  define('httpCache',{
    etag(value){return require('crypto').createHash('sha1').update(String(value)).digest('hex')},
    get:key=>site.responseCache.get(key),
    set:(key,value,ttl)=>site.responseCache.set(key,value,ttl),
    stats:()=>site.responseCache.stats()
  });
  define('cacheV3',site.cache);
  define('memory',{stats:()=>({heapUsed:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss})});
  define('shutdown',{close:()=>site.stop()});
  define('profile',{start:()=>performance.now(),end:start=>performance.now()-start});
  define('featuresV3',{});
  define('coreV3',{});
  define('coreV18',{});
  define('requestTelemetry',site.requestTelemetry);

  {
    const rc=site.responseCache;
    rc.has = rc.has || (key=>rc.get(key)!==null);
    rc.getOrLoad = rc.getOrLoad || (async(key,loader,ttl)=>{const hit=rc.get(key);if(hit!==null)return hit;return rc.set(key,await loader(),ttl)});
    rc.key = rc.key || (parts=>require('crypto').createHash('sha1').update(typeof parts==='string'?parts:JSON.stringify(parts)).digest('hex'));
    rc.apply = rc.apply || ((res,value)=>{if(value?.headers)for(const [k,v] of Object.entries(value.headers))res.setHeader(k,v);if(value?.status)res.statusCode=value.status;return value?.body!==undefined?res.send(value.body):res});
    rc.bindCollection = rc.bindCollection || ((name,opts={})=>{rc._bindings??=new Map();rc._bindings.set(name,opts);return opts});
    rc.unbindCollection = rc.unbindCollection || (name=>rc._bindings?.delete(name)||false);
    rc.collectionBinding = rc.collectionBinding || (name=>rc._bindings?.get(name)||null);
    rc.collectionBindings = rc.collectionBindings || (()=>Object.fromEntries(rc._bindings||[]));
    rc.invalidateCollection = rc.invalidateCollection || (()=>{rc.clear();return true});
    rc.invalidateTag = rc.invalidateTag || (()=>{rc.clear();return true});
    rc.invalidationStats = rc.invalidationStats || (()=>({clears:0}));
    rc.scheduleWarm = rc.scheduleWarm || ((key,delay,loader)=>site.scheduler.later('cache:'+key,delay,()=>rc.getOrLoad(key,loader)));
    rc.cancelWarm = rc.cancelWarm || (key=>site.scheduler.cancel('cache:'+key));
    rc.warm = rc.warm || ((key,loader)=>rc.getOrLoad(key,loader));
    rc.warmMany = rc.warmMany || (items=>Promise.all([].concat(items||[]).map(x=>rc.warm(x.key,x.loader))));
    rc.warmStats = rc.warmStats || (()=>rc.stats());
  }

  Object.defineProperty(site,'package',{
    enumerable:true,configurable:true,
    get(){
      const pkg=require('../../package.json');
      Object.defineProperty(site,'package',{value:pkg,enumerable:true,writable:false,configurable:true});
      return pkg;
    }
  });
  Object.defineProperty(site,'Module',{
    enumerable:true,configurable:true,
    get(){
      const mod=require('module');
      Object.defineProperty(site,'Module',{value:mod,enumerable:true,writable:false,configurable:true});
      return mod;
    }
  });
  define('requireFromString',(code,filename=path.join(process.cwd(),'inline-module.js'))=>{
    const Module=require('module');
    const m=new Module(filename,module);
    m.filename=filename;
    m.paths=Module._nodeModulePaths(path.dirname(filename));
    m._compile(String(code),filename);
    return m.exports;
  });

  // iSite legacy number/string/object helper names map to clean Core helpers.
  define('stringfiy',(value,lang='ar')=>{
    if(lang==='ar')return site.numberWords(value);
    return String(value??'');
  });

  // Official iSite object-options utility surface. Keep this entirely inside the
  // compatibility layer so Native Core semantics remain independent.
  const legacyTypeOf=value=>Object.prototype.toString.call(value).slice(8,-1);
  const legacyCopy=obj=>{
    if(obj===undefined||obj===null)return {};
    if(typeof obj==='object')return Object.assign({},obj);
    return obj;
  };
  const legacyToNumber=value=>value?parseFloat(parseFloat(value).toFixed(3)):0;
  const legacyToInt=value=>value?parseInt(value):0;
  const legacyToFloat=value=>value?parseFloat(value):0;
  const legacyToMoney=(value,float=true)=>{
    let n=0;
    if(value){
      let parts=Number(value).toFixed(2).split('.');
      const n2=parts[1]||'00';
      if(n2){
        let n3=n2[0]||'0',n4=n2[1]||'0';
        if(n4&&parseInt(n4)>5){
          n3=parseInt(n3)+1;n3=n3*10;
          if(n3===100){n3=0;parts[0]=parseInt(parts[0])+1;parts[1]=''}
          else parts[1]=n3;
        }else if(n4&&parseInt(n4)===5)parts[1]=n2;
        else if(n4&&parseInt(n4)>2){n4=5;parts[1]=n3+n4}
        else parts[1]=n3+'0';
      }
      n=parts.join('.');
    }
    if(!float){if(n&&String(n).endsWith('.'))n=n+'00';return n}
    return legacyToFloat(n);
  };
  const legacyRandom=(min,max)=>Math.floor(Math.random()*((Number(max)+1)-Number(min))+Number(min));
  const legacyGuid=()=>{
    const s4=()=>Math.floor((1+Math.random())*0x10000).toString(16).substring(1);
    return s4()+s4()+'-'+s4()+'-'+s4()+'-'+s4()+'-'+s4()+s4()+s4();
  };
  const legacyGetRegExp=(txt,flag='gium')=>{try{return new RegExp(txt,flag)}catch{return txt}};
  const legacyIsDate=date=>!!(date&&typeof date==='string'&&date.length===24&&date.includes('-')&&date.includes(':')&&!isNaN(new Date(date)));
  const legacyGetDate=value=>{
    const d=value?new Date(value):new Date();
    return new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate(),12,0,0));
  };
  const legacyToDateTime=value=>{
    const d=value?new Date(value):new Date();
    return new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate(),d.getHours(),d.getMinutes(),d.getSeconds()));
  };
  const legacyToDateOnly=value=>{
    const d=legacyToDateTime(value);
    return new Date(Date.UTC(d.getFullYear(),d.getMonth(),d.getDate(),12,0,0));
  };
  const legacyToDateX=value=>{const d=legacyToDateTime(value);return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate()};
  const legacyToDateXT=value=>{const d=legacyToDateTime(value);return d.getHours()+':'+d.getMinutes()+':'+d.getSeconds()};
  const legacyToDateXF=value=>{const d=legacyToDateTime(value);return d.getFullYear()+'-'+(d.getMonth()+1)+'-'+d.getDate()+' '+d.getHours()+':'+d.getMinutes()+':'+d.getSeconds()};
  const legacyToDateT=value=>legacyToDateOnly(value).getTime();
  const legacyToDateF=value=>legacyToDateTime(value).getTime();
  const legacyGetExtension=filename=>{const i=String(filename||'').lastIndexOf('.');return i<0?'':String(filename).substr(i)};
  const legacyGetContentType=file=>{
    if(file===undefined)return null;
    const ext=path.extname(String(file)).replace('.','').toLowerCase();
    const types={
      html:'text/html',htm:'text/html',css:'text/css',js:'application/javascript',mjs:'application/javascript',
      json:'application/json',xml:'application/xml',txt:'text/plain',svg:'image/svg+xml',
      png:'image/png',jpg:'image/jpeg',jpeg:'image/jpeg',gif:'image/gif',webp:'image/webp',ico:'image/x-icon',
      woff:'font/woff',woff2:'font/woff2',ttf:'font/ttf',otf:'font/otf',eot:'application/vnd.ms-fontobject',
      pdf:'application/pdf',zip:'application/zip',mp3:'audio/mpeg',mp4:'video/mp4'
    };
    return types[ext]||'application/'+ext;
  };
  const binaryExts=new Set(['.woff','.woff2','.ttf','.svg','.otf','.png','.gif','.jpg','.jpeg','.ico','.bmp','.webp','.xls','.xlsx','.eot','.doc','.docx','.pdf','.zip','.rar','.7z','.tar','.gz','.mp3','.mp4','.avi','.mov','.flv','.wmv']);
  const legacyGetFileEncode=file=>binaryExts.has(path.extname(String(file||'')).toLowerCase())?'binary':'UTF8';
  const legacyFromJson=(data,Default={})=>{
    try{
      if(!data)return Default;
      if(typeof data==='string'&&data!=='')return JSON.parse(data);
      if(typeof data==='object')return data;
    }catch{return Default}
    return Default;
  };
  const legacyRemoveRefObject=obj=>{
    const seen=new Set();
    const recurse=value=>{
      if(!value||typeof value!=='object')return value;
      if(seen.has(value))return undefined;
      seen.add(value);
      for(const [key,v] of Object.entries(value)){
        if(key==='_id')continue;
        if(v&&typeof v==='object'){
          if(seen.has(v))delete value[key];
          else{
            const out=recurse(v);
            if(out===undefined)delete value[key];
          }
        }
      }
      return value;
    };
    return recurse(obj);
  };
  const legacyToJson=obj=>{
    if(obj===undefined||obj===null)return '';
    return JSON.stringify(legacyRemoveRefObject(obj));
  };
  const legacyToBase64=data=>{
    if(data===undefined)return '';
    if(typeof data==='object')data=JSON.stringify(data);
    return Buffer.from(String(data)).toString('base64');
  };
  const legacyFromBase64=data=>typeof data==='string'?Buffer.from(data,'base64').toString():'';
  const legacyEscapeRegExp=text=>String(text??'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const legacyToHtmlTable=obj=>{
    if(obj===undefined||obj===null)return '';
    const type=legacyTypeOf(obj);
    if(type==='Object'||type==='Function'){
      let table='<table class="table">';
      for(const key of Object.getOwnPropertyNames(obj)){
        table+='<tr><td> '+key+' </td>';
        const v=obj[key],t=legacyTypeOf(v);
        table+='<td> '+((t==='Object'||t==='Array')?legacyToHtmlTable(v):String(v))+' </td></tr>';
      }
      return table+'</table>';
    }
    if(type==='Array'){
      let table='<table class="table">';
      for(const v of obj){const t=legacyTypeOf(v);table+='<tr><td>'+((t==='Object'||t==='Array')?legacyToHtmlTable(v):String(v))+'</td></tr>'}
      return table+'</table>';
    }
    return '';
  };
  const legacyObjectDiff=(obj1,obj2)=>{
    if(obj1===undefined||obj1===null||obj2===undefined||obj2===null)return obj1;
    const type=legacyTypeOf(obj1);
    if(type==='Object'){
      const out={};
      for(const key of Object.getOwnPropertyNames(obj1)){
        const v=obj1[key],other=obj2?.[key],t=legacyTypeOf(v);
        if(t==='Object'||t==='Array'){
          const diff=legacyObjectDiff(v,other);
          if(Array.isArray(diff)){const clean=diff.filter(x=>x!==null&&x!==undefined);if(clean.length)out[key]=clean}
          else if(diff&&typeof diff==='object'&&Object.keys(diff).length)out[key]=diff;
          else if(diff!==undefined&&diff!==null&&typeof diff!=='object')out[key]=diff;
        }else if(v!=other)out[key]=v;
      }
      return out;
    }
    if(type==='Array'){
      if(legacyTypeOf(obj2)!=='Array')return obj1;
      const out=[];
      for(let i=0;i<obj1.length;i++){
        const v=obj1[i],t=legacyTypeOf(v);
        if(t==='Object'||t==='Array'){
          const diff=legacyObjectDiff(v,obj2[i]);
          if(Array.isArray(diff)){const clean=diff.filter(x=>x!==null&&x!==undefined);if(clean.length)out.push(clean)}
          else if(diff&&typeof diff==='object'&&Object.keys(diff).length)out.push(diff);
        }else if(v!==undefined&&v!==null&&v!=obj2[i])out.push(v);
      }
      return out;
    }
    return obj1;
  };

  const legacyBase64Letters='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
  const legacyBase64Numbers=[];
  for(let i=11;i<99;i++)if(i%10!==0&&i%11!==0)legacyBase64Numbers.push(i);
  // Reuse Core's stable Native codec implementation. This keeps compatibility
  // aliases byte-for-byte aligned with Native Social Browser storage/IPC codecs.
  const legacyTo123=site.codecs.numericBase64.encode;
  const legacyFrom123=site.codecs.numericBase64.decode;
  const legacyShow=site.codecs.hiddenObject.decode;
  const legacyHide=site.codecs.hiddenObject.encode;
  // Utility aliases are exact iSite compatibility names, including historical aliases.
  const utilitySurface={
    copy:legacyCopy,
    toNumber:legacyToNumber,to_number:legacyToNumber,
    toInt:legacyToInt,to_int:legacyToInt,
    toFloat:legacyToFloat,to_float:legacyToFloat,
    toMoney:legacyToMoney,
    random:legacyRandom,guid:legacyGuid,
    getRegExp:legacyGetRegExp,get_RegExp:legacyGetRegExp,
    isDate:legacyIsDate,typeof:legacyTypeOf,typeOf:legacyTypeOf,
    getDate:legacyGetDate,
    toDateTime:legacyToDateTime,getDateTime:legacyToDateTime,
    toDateOnly:legacyToDateOnly,toDate:legacyToDateOnly,
    toDateX:legacyToDateX,toDateXT:legacyToDateXT,toDateXF:legacyToDateXF,toDateT:legacyToDateT,toDateF:legacyToDateF,
    getExtension:legacyGetExtension,getContentType:legacyGetContentType,getFileEncode:legacyGetFileEncode,
    toHtmlTable:legacyToHtmlTable,objectDiff:legacyObjectDiff,removeRefObject:legacyRemoveRefObject,
    fromJson:legacyFromJson,fromJSON:legacyFromJson,toJson:legacyToJson,toJSON:legacyToJson,
    toBase64:legacyToBase64,fromBase64:legacyFromBase64,
    to123:legacyTo123,from123:legacyFrom123,f1:legacyFrom123,_x0f1xo:legacyFrom123,
    hide:legacyHide,hideObject:legacyHide,show:legacyShow,showObject:legacyShow,ul:legacyShow,
    escapeRegExp:legacyEscapeRegExp,
    md5:value=>require('crypto').createHash('md5').update(String(value)).digest('hex'),
    hash:value=>require('crypto').createHash('md5').update(String(value)).digest('hex'),
    x0md50x:value=>require('crypto').createHash('md5').update(String(value)).digest('hex'),
    newURL:(url,base='https://egytag.com')=>{
      try{
        const parser=new URL(url,base);
        return {protocol:parser.protocol,slashes:true,auth:`${parser.username}:${parser.password}`,host:parser.host,port:parser.port,hostname:parser.hostname,hash:parser.hash,search:parser.search,query:Object.fromEntries(parser.searchParams),pathname:parser.pathname,path:parser.pathname+parser.search,href:parser.href};
      }catch{return{href:url,origin:'',protocol:'',username:'',password:'',host:'',hostname:'',port:'',pathname:url,search:'',searchParams:{},hash:'',query:{}}}
    },
    exe:(appPath,args,callback)=>{
      callback=callback||(()=>{});
      return require('child_process').execFile(appPath,args||[],(err,data)=>callback(err,data));
    }
  };
  for(const [name,fn] of Object.entries(utilitySurface))override(name,fn);
  override('fn',{...utilitySurface,$base64Letter:legacyBase64Letters,$base64Numbers:legacyBase64Numbers});
  define('strings',site.values);
  // Compatibility aliases above intentionally override Native helpers only while
  // compatibility is installed; uninstall restores the original descriptors.
  define('appList',site.apps);
  define('databaseCollectionList',site.collectionList);
  define('databaseList',[]);
  define('collectionByGuid',Object.create(null));
  define('args',{});
  define('const',{});
  define('context',site.context || {create:(seed={})=>({...seed,site})});
  define('capabilities',{});
  define('closing',false);
  define('child_process',require('child_process'));
  define('console',console);

  define('createDirSync',site.files.createDirSync);
  define('copy',v=>JSON.parse(JSON.stringify(v)));
  define('cookie',(name,value,opts={})=>({name,value,...opts}));
  define('canRequire',name=>{try{require.resolve(name);return true}catch{return false}});
  define('cmd',(command,args=[])=>require('child_process').spawn(command,[].concat(args),{shell:true}));
  define('cacheGetOrLoad',(key,loader,ttl=0)=>site.cache.remember(key,ttl,loader));
  define('addApp',app=>(site.apps.push(app),app));
define('connectApp',(options={})=>{
  if(typeof options==='string')options={name:options};
  options={...(options||{})};
  const name=String(options.name||options.collection||`app_${site.apps.length+1}`);
  const col=site.connectCollection(name);
  const memoryList=[];
  const manager={
    ...options,
    name,
    collection:col,
    memoryList,
    async load(){
      const rows=await col.findMany({sort:options.sort||undefined});
      memoryList.splice(0,memoryList.length,...(rows||[]));
      return memoryList;
    },
    add(data,cb){
      const p=Promise.resolve(col.add(data)).then(doc=>{
        const value=doc?.doc||doc?.data||doc||data;
        if(options.allowMemory!==false && value && typeof value==='object')memoryList.push(value);
        site.emit?.(`[${name}][created]`,value);
        return value;
      });
      if(typeof cb==='function'){p.then(x=>cb(null,x),e=>cb(e));return}
      return p;
    },
    edit(data,cb){
      const where=data?._id?{_id:data._id}:data?.id!=null?{id:data.id}:{};
      const p=Promise.resolve(col.edit({where,data})).then(result=>{
        if(options.allowMemory!==false){
          const idx=memoryList.findIndex(x=>(data?._id&&x?._id===data._id)||(data?.id!=null&&x?.id===data.id));
          if(idx>=0)memoryList[idx]={...memoryList[idx],...data};
        }
        site.emit?.(`[${name}][updated]`,data);
        return result;
      });
      if(typeof cb==='function'){p.then(x=>cb(null,x),e=>cb(e));return}
      return p;
    },
    delete(data,cb){
      const where=data?._id?{_id:data._id}:data?.id!=null?{id:data.id}:data||{};
      const p=Promise.resolve(col.delete({where})).then(result=>{
        if(options.allowMemory!==false){
          for(let i=memoryList.length-1;i>=0;i--){
            const x=memoryList[i];
            if((data?._id&&x?._id===data._id)||(data?.id!=null&&x?.id===data.id))memoryList.splice(i,1);
          }
        }
        site.emit?.(`[${name}][deleted]`,data);
        return result;
      });
      if(typeof cb==='function'){p.then(x=>cb(null,x),e=>cb(e));return}
      return p;
    },
    find(where={},cb){
      if(options.allowMemory!==false){
        const rows=memoryList.filter(row=>Object.entries(where||{}).every(([k,v])=>row?.[k]===v));
        if(typeof cb==='function'){cb(null,rows);return}
        return rows;
      }
      return col.findMany({where},cb);
    },
    findOne(where={},cb){
      if(options.allowMemory!==false){
        const row=memoryList.find(item=>Object.entries(where||{}).every(([k,v])=>item?.[k]===v))||null;
        if(typeof cb==='function'){cb(null,row);return}
        return row;
      }
      return col.findOne({where},cb);
    }
  };
  site.apps.push(manager);
  manager.ready=options.allowMemory!==false?Promise.resolve(manager.load()).catch(()=>memoryList):Promise.resolve(memoryList);
  const originalAdd=manager.add.bind(manager);
  manager.add=(data,cb)=>{
    const p=manager.ready.then(()=>originalAdd(data));
    if(typeof cb==='function'){p.then(x=>cb(null,x),e=>cb(e));return}
    return p;
  };
  const originalEdit=manager.edit.bind(manager);
  manager.edit=(data,cb)=>{
    const p=manager.ready.then(()=>originalEdit(data));
    if(typeof cb==='function'){p.then(x=>cb(null,x),e=>cb(e));return}
    return p;
  };
  const originalDelete=manager.delete.bind(manager);
  manager.delete=(data,cb)=>{
    const p=manager.ready.then(()=>originalDelete(data));
    if(typeof cb==='function'){p.then(x=>cb(null,x),e=>cb(e));return}
    return p;
  };
  return manager;
});
  const features=new Map();
  define('addFeature',(name,value=true)=>(features.set(name,value),value));
  define('addfeatures',obj=>{for(const [k,v] of Object.entries(obj||{}))site.addFeature(k,v);return obj});
  define('hasFeature',name=>features.has(name)&&features.get(name)!==false);
  define('feature',name=>features.get(name));
  define('getFeature',(name,Default)=>features.has(name)?features.get(name):Default);
  const vars={};
  define('vars',vars);
  define('addVar',(name,value)=>(vars[name]=value));
  define('addVars',obj=>Object.assign(vars,obj||{}));
  define('getVar',(name,Default)=>Object.prototype.hasOwnProperty.call(vars,name)?vars[name]:Default);
  define('var',function(name,value){
    if(arguments.length>1){vars[name]=value;return value}
    return vars[name];
  });

  const words={
    list:[],byName:Object.create(null),
    add(item){if(typeof item==='string')item={name:item,value:item};if(!item?.name)return null;words.byName[item.name]=item;words.list.push(item);return item},
    addList(list){return [].concat(list||[]).map(x=>words.add(x)).filter(Boolean)},
    get(name){return words.byName[name]||null},
    set(item){return words.add(item)},
    addFile(file){
      try{
        const data=legacyFromJson(readText(file),[]);
        return words.addList(Array.isArray(data)?data:Object.entries(data||{}).map(([name,value])=>({name,value})));
      }catch{return []}
    },
    word(name){const x=words.get(name);return x?.value??x?.word??name},
    save(){return true}
  };
  define('words',words);
  define('word',name=>words.word(name));
  define('getApp',name=>site.apps.find(x=>x?.name===name||x===name)||null);

  // iSite uses site.call(name, ...args) as its application event bus. Core's generic
  // HTTP helper keeps the explicit httpCall name while compatibility is enabled.
  state.originalCall=site.call;
  if(!site.httpCall)site.httpCall=site.call;
  site.call=(name,...args)=>site.emit(String(name),...args);
  const legacyQueues=new Map();
  define('quee',(name,args,callback)=>{
    name=String(name||'');
    const row={args,callback};
    let list=legacyQueues.get(name);if(!list)legacyQueues.set(name,(list=[]));
    list.push(row);
    if(typeof callback==='function')queueMicrotask(()=>callback(args));
    site.emit(name,args);
    return row;
  });
  define('quee_check',(name,fire=false)=>{
    const list=legacyQueues.get(String(name||''))||[];
    if(fire)for(const row of list)try{row.callback?.(row.args)}catch{}
    return list.length;
  });

  // Legacy callRoute receives a registered route pattern/name plus the existing
  // request/response pair (e.g. callRoute('/category/:id', req, res)).
  define('callRoute',async(pattern,req,res)=>{
    const target=typeof pattern==='string'?(pattern.startsWith('/')?pattern:'/'+pattern).toLowerCase():pattern;
    const route=site.router.routes.find(r=>String(r.pattern)===String(target));
    if(!route)return false;
    const out=await route.handler(req,res);
    if(!res?.writableEnded&&out!==undefined&&out!==res&&res?.send)res.send(out);
    return out===undefined?true:out;
  });

  // Legacy run(callback) starts on the configured/default port and invokes the callback
  // once the site is ready. Core run(ports) semantics remain available outside compat.
  state.originalRun=site.run;
  state.originalStart=site.start;
  state.originalListen=site.listen;
  const legacyStart=(portsOrCallback,callback)=>{
    let ports=portsOrCallback;
    if(typeof portsOrCallback==='function'){callback=portsOrCallback;ports=undefined}
    if(typeof callback==='function')site.once('ready',()=>callback(site.servers));
    return state.originalRun(ports);
  };
  site.run=site.start=site.listen=legacyStart;
  if(site.routing)site.routing.start=legacyStart;
  define('close',site.stop);
  define('closeGracefully',async()=>{site.closing=true;return site.stop()});
  define('reset',()=>{
    try{site.responseCache?.clear?.()}catch{}
    try{site.cache?.clear?.()}catch{}
    try{site.fileCache?.clear?.()}catch{}
    try{site.queryCache?.invalidateAll?.()}catch{}
    try{site.queryPlan?.clear?.()}catch{}
    site.closing=false;
    return site;
  });
  define('closeProxy',async()=>true);


// Collection aliases are installed per instance only.
// Never mutate JsonCollection.prototype: the compatibility layer must be removable.
const originalConnectCollection=site.connectCollection.bind(site);
state.originalConnectCollection=site.connectCollection;

function decorateCollection(col){
  if(!col || col.__isiteCompatDecorated)return col;
  if(!state.collectionOwnDescriptors.has(col))state.collectionOwnDescriptors.set(col,Object.getOwnPropertyDescriptors(col));
  Object.defineProperty(col,'__isiteCompatDecorated',{value:true,configurable:true});
  const added=new Set();
  const add=(name,fn)=>{
    if(typeof col[name]==='function')return;
    Object.defineProperty(col,name,{value:fn.bind(col),writable:true,configurable:true,enumerable:true});
    added.add(name);
  };
  const prop=(name,value)=>{
    if(Object.prototype.hasOwnProperty.call(col,name))return;
    Object.defineProperty(col,name,{value,writable:true,configurable:true,enumerable:true});
    added.add(name);
  };

  prop('collection',col.name);
  prop('db','aisite');
  prop('guid',require('crypto').createHash('sha1').update(String(col.name)).digest('hex'));
  prop('identityEnabled',true);
  prop('options',{});
  prop('readPool',{});
  prop('taskList',[]);
  prop('taskBusy',false);
  prop('taskCount',0);
  prop('insertBusy',false);
  prop('deleteBusy',false);
  prop('updateBusy',false);
  prop('docs',col.engine?.docs||[]);

  add('callback',function(){});
  add('bulkWriteFast',function(ops=[]){return this.transaction(ops)});
  add('invalidateQueryCache',function(){return true});
  add('findByIdsFast',function(ids,o={}){const field=o.field||'id';return this.findMany({...o,where:{...(o.where||{}),[field]:{$in:ids}}})});
  add('batchStats',function(){return{tasks:this.taskCount,pending:this.taskList.length}});
  add('checkTaskList',function(){return this.taskList});
  add('scheduleNextTask',function(){return true});
  add('taskDone',function(){this.taskBusy=false;return true});
  add('enqueueTask',function(task){this.taskList.push(task);this.taskCount++;return task});
  add('createUnique',function(field){return this.createIndex(field,{unique:true})});
  add('loadAll',function(o={}){return this.findMany(o)});

  add('addAsync',function(doc){return this.add(doc)});
  add('addMany',function(docs,cb){return this.insertMany(docs,cb)});
  add('insertAll',function(docs,cb){return this.insertMany(docs,cb)});
  add('editOne',function(o,cb){return this.edit(o,cb)});
  add('editMany',function(o,cb){return this.update({...o,multi:true},cb)});
  add('editAll',function(o,cb){return this.update({...o,multi:true},cb)});
  add('updateAsync',function(o){return this.update(o)});
  add('deleteAsync',function(o){return this.delete(o)});
  add('removeDuplicate',function(field,cb){return this.deleteDuplicate(field,cb)});
  add('removeOne',function(o,cb){return this.delete({...o,multi:false},cb)});
  add('removeAll',function(cb){return this.deleteAll(cb)});
  add('insert',function(doc,cb){return Array.isArray(doc)?this.insertMany(doc,cb):this.add(doc,cb)});
  add('insertOne',function(doc,cb){return this.add(doc,cb)});
  add('deleteOne',function(o={},cb){return this.delete({...o,multi:false},cb)});
  add('updateMany',function(o={},cb){return this.update({...o,multi:true},cb)});

  add('countAsync',function(where={}){return this.count(where)});
  add('countParallel',function(where={},cb){const p=Promise.resolve(this.count(where));if(cb)p.then(x=>cb(null,x),e=>cb(e));else return p});
  add('exists',async function(o={}){return !!(await this.findOne(o))});
  add('existsAsync',function(o={}){return this.exists(o)});
  add('findManyConcurrent',function(o={}){return this.findManyParallel(o)});
  add('findManyNoCount',function(o={}){return this.findManyFast(o)});
  add('findManyFastCached',function(o={}){return this.findManyFast(o)});
  add('findManyNoCountCached',function(o={}){return this.findManyFastCached(o)});
  add('findManyCached',function(o={}){return this.findMany(o)});
  add('findManyConcurrentCached',function(o={}){return this.findManyConcurrent(o)});
  add('findOneCached',function(o={}){return this.findOne(o)});
  add('findOneParallel',function(o={},cb){const p=Promise.resolve(this.findOne(o));if(cb)p.then(x=>cb(null,x),e=>cb(e));else return p});
  add('findPageBudgeted',function(o={}){return this.findPageFast(o)});
  add('findManyBudgeted',function(o={}){return this.findMany(o)});
  add('findByIdsBudgeted',function(ids,o={}){return this.findByIdsFast(ids,o)});
  add('findByIdsFastCached',function(ids,o={}){return this.findByIdsFast(ids,o)});
  add('findIdsBatched',function(ids,o={}){return this.findByIdsFast(ids,o)});
  add('findByIdBatched',function(id,o={}){return this.findOne({...o,where:{...(o.where||{}),id}})});
  add('findDuplicate',async function(field){
    const rows=await this.findMany({});const seen=new Set(),dups=[];
    for(const row of rows){const value=field.split('.').reduce((a,k)=>a?.[k],row);const key=JSON.stringify(value);if(seen.has(key))dups.push(row);else seen.add(key)}
    return dups;
  });

  add('export',async function(file,options={},cb){
    const rows=await this.findMany(options);require('fs').writeFileSync(file,JSON.stringify(rows,null,2));
    if(cb)cb(null,file);return file;
  });
  add('import',async function(file,options={},cb){
    const rows=JSON.parse(require('fs').readFileSync(file,'utf8'));const out=await this.insertMany(rows);
    if(cb)cb(null,out);return out;
  });
  add('drop',async function(){await this.deleteAll();return true});
  add('dropIndexes',function(){for(const x of this.listIndexes())this.dropIndex(x.fields||x.field);return true});
  add('explainFast',function(o={}){return this.explain(o)});

  const bindSame=(names,fn)=>{
    for(const name of names){
      Object.defineProperty(col,name,{value:fn,writable:true,configurable:true,enumerable:true});
      added.add(name);
    }
  };
  const cbWrap=(promise,cb)=>{
    const p=Promise.resolve(promise);
    if(typeof cb==='function'){p.then(x=>cb(null,x),e=>cb(e));return;}
    return p;
  };
  const addOneCanonical=(doc,cb)=>cbWrap(col.engine.add(doc),cb);
  const addManyCanonical=(docs,cb)=>cbWrap(col.engine.transaction(tx=>Promise.resolve([].concat(docs||[]).map(d=>tx.add(d)))),cb);
  const countCanonical=(options={})=>Promise.resolve(col.engine.count(options.where||options));
  const deleteOneCanonical=(options={},cb)=>{
    const where=options.where||Object.fromEntries(Object.entries(options).filter(([k])=>k!=='multi'));
    return cbWrap(col.engine.delete(where,false),cb);
  };
  const deleteManyCanonical=(options={},cb)=>{
    const where=options.where||Object.fromEntries(Object.entries(options).filter(([k])=>k!=='multi'));
    return cbWrap(col.engine.delete(where,true),cb);
  };
  const deleteDuplicateCanonical=(fieldOrFields,cb)=>{
    const p=(async()=>{
      const fields=[].concat(fieldOrFields||'_id'),seen=new Set(),dupIds=[];
      for(const doc of col.engine.docs){
        const key=JSON.stringify(fields.map(f=>require('../../lib/utils').getPath(doc,f)));
        if(seen.has(key))dupIds.push(doc._id); else seen.add(key);
      }
      return col.engine.transaction(async tx=>{
        let count=0;for(const _id of dupIds){const r=tx.delete({_id},false);count+=r.count}return{done:true,count};
      });
    })();
    return cbWrap(p,cb);
  };
  const updateOneCanonical=(options={},cb)=>{
    const where=options.where||(options._id?{_id:options._id}:options.id!=null?{id:options.id}:{});
    const patch=options.set||options.data||options.doc||Object.fromEntries(Object.entries(options).filter(([k])=>!['where','_id','id','set','data','doc','multi'].includes(k)));
    return cbWrap(col.engine.update(where,patch,false),cb);
  };
  const updateManyCanonical=(options={},cb)=>{
    const where=options.where||(options._id?{_id:options._id}:options.id!=null?{id:options.id}:{});
    const patch=options.set||options.data||options.doc||Object.fromEntries(Object.entries(options).filter(([k])=>!['where','_id','id','set','data','doc','multi'].includes(k)));
    return cbWrap(col.engine.update(where,patch,true),cb);
  };
  const findOneCanonical=(options={},cb)=>{
    col.observeQuery?.(options,{op:'findOne',collection:col.name});
    return cbWrap(Promise.resolve(col.engine.query({...options,limit:1})[0]||null),cb);
  };
  const findManyCanonical=(options={},cb)=>{
    col.observeQuery?.(options,{op:'findMany',collection:col.name});
    return cbWrap(Promise.resolve(col.engine.query(options)),cb);
  };
  const fastCanonical=(options={},cb)=>findManyCanonical(options,cb);

  bindSame(['add','addOne','insert','insertOne'],addOneCanonical);
  bindSame(['addAll','addMany','insertAll','insertMany'],addManyCanonical);
  bindSame(['count','getCount'],countCanonical);
  bindSame(['delete','deleteOne','remove','removeOne'],deleteOneCanonical);
  bindSame(['deleteAll','deleteMany','removeAll','removeMany'],deleteManyCanonical);
  bindSame(['deleteDuplicate','removeDuplicate'],deleteDuplicateCanonical);
  bindSame(['edit','editOne','update','updateOne'],updateOneCanonical);
  bindSame(['editAll','editMany','updateAll','updateMany'],updateManyCanonical);
  bindSame(['find','findOne','get','getOne','select','selectOne'],findOneCanonical);
  bindSame(['findAll','findMany','getAll','getMany','selectAll','selectMany'],findManyCanonical);
  bindSame(['findManyFast','findManyNoCount'],fastCanonical);

  const fastCached=(o={})=>col.findManyFast(o);
  Object.defineProperty(col,'findManyFastCached',{value:fastCached,writable:true,configurable:true,enumerable:true});added.add('findManyFastCached');
  Object.defineProperty(col,'findManyNoCountCached',{value:fastCached,writable:true,configurable:true,enumerable:true});added.add('findManyNoCountCached');

  const oid=(value)=>value||require('crypto').randomBytes(12).toString('hex');
  Object.defineProperty(col,'ObjectID',{value:oid,writable:true,configurable:true,enumerable:true});added.add('ObjectID');
  Object.defineProperty(col,'ObjectId',{value:oid,writable:true,configurable:true,enumerable:true});added.add('ObjectId');

  add('distinct',async function(field,o={}){
    const rows=await findManyCanonical(o);
    return [...new Set(rows.map(x=>field.split('.').reduce((a,k)=>a?.[k],x)))];
  });

  for(const n of added)if(!state.aliases.includes(`collection-instance.${n}`))state.aliases.push(`collection-instance.${n}`);
  return col;
}

site.connectCollection=(name,opts={})=>decorateCollection(originalConnectCollection(name,opts));
state.decorateCollection=decorateCollection;

// Decorate collections that existed before the compatibility layer was enabled.
for(const col of site.collections.values())decorateCollection(col);

  return site;
}

function uninstall(site){
  const state=site.compatibility?.isite;
  if(!state?.enabled)return site;
  for(const name of state.aliases){
    if(name.startsWith('collection-instance.'))continue;
    if(state.nativeRouteMethods&&Object.prototype.hasOwnProperty.call(state.nativeRouteMethods,name))continue;
    try{delete site[name]}catch{}
  }
  if(state.nativeRouteMethods){
    for(const [name,fn] of Object.entries(state.nativeRouteMethods))if(fn)site[name]=fn;
  }
  if(Array.isArray(site.middlewares)&&Number.isInteger(state.originalMiddlewareLength))
    site.middlewares.splice(state.originalMiddlewareLength);
  if(state.originalConnectCollection)site.connectCollection=state.originalConnectCollection;
  if(state.originalCall)site.call=state.originalCall;
  if(site.httpCall===state.originalCall)try{delete site.httpCall}catch{}
  if(state.originalRun)site.run=state.originalRun;
  if(state.originalOnWS)site.onWS=state.originalOnWS;
  if(state.originalWebsocket)site.websocket=state.originalWebsocket;
  if(Object.prototype.hasOwnProperty.call(state,'originalWsPrepare'))site._isitePrepareWebSocketRequest=state.originalWsPrepare;
  if(Object.prototype.hasOwnProperty.call(state,'originalWsMatchPath'))site._isiteWebSocketMatchPath=state.originalWsMatchPath;
  if(state.originalStart)site.start=state.originalStart;
  else try{delete site.start}catch{}
  if(state.originalListen)site.listen=state.originalListen;
  else try{delete site.listen}catch{}
  if(state.originalHttpCompatHooks){
    site._isiteFinalizeRequest=state.originalHttpCompatHooks.finalizeRequest;
    site._isiteMatchPath=state.originalHttpCompatHooks.matchPath;
    site._isitePreRoute=state.originalHttpCompatHooks.preRoute;
  }

if(state.originalRequestCompat){
  if(state.originalRequestCompat.request)site.options.request={...state.originalRequestCompat.request};
  else delete site.options.request;
}
if(state.originalStorageCompat){
  if(state.originalStorageCompat.storage)site.options.storage={...state.originalStorageCompat.storage};
  else delete site.options.storage;
}
if(state.originalSessionCompat&&site.sessionStore){
  site.sessionStore.cookieName=state.originalSessionCompat.cookieName;
  site.sessionStore.cookieAliases=state.originalSessionCompat.cookieAliases;
  if(state.originalSessionCompat.cookieOptions)site.sessionStore.cookieOptions=state.originalSessionCompat.cookieOptions;
  if(state.originalSessionCompat.dir)site.sessionStore.dir=state.originalSessionCompat.dir;
  site.sessionStore.lazy=state.originalSessionCompat.lazy;
}
  if(state.originalCompatOverrides){
    for(const [name,desc] of state.originalCompatOverrides){
      try{
        if(desc)Object.defineProperty(site,name,desc);
        else delete site[name];
      }catch{}
    }
  }
  if(state.originalSecurityDescriptors&&site.security){
    for(const name of Reflect.ownKeys(site.security)){
      if(!Object.prototype.hasOwnProperty.call(state.originalSecurityDescriptors,name)){
        try{delete site.security[name]}catch{}
      }
    }
    for(const [name,desc] of Object.entries(state.originalSecurityDescriptors)){
      try{Object.defineProperty(site.security,name,desc)}catch{}
    }
  }
  if(state.originalValidators){
    site.validateServerRequest=state.originalValidators.validateServerRequest;
    site.validateRequest=state.originalValidators.validateRequest;
    site.validateRoute=state.originalValidators.validateRoute;
    site.validateSession=state.originalValidators.validateSession;
  }
  if(state.originalDateHelpers){
    site.getDate=state.originalDateHelpers.getDate;
    site.getDateTime=state.originalDateHelpers.getDateTime;
    if(state.originalDateHelpers.toDateTime===undefined)delete site.toDateTime;
    else site.toDateTime=state.originalDateHelpers.toDateTime;
  }
  if(state.originalProtoHelpers){
    for(const [name,desc] of Object.entries(state.originalProtoHelpers)){
      try{
        if(desc)Object.defineProperty(String.prototype,name,desc);
        else delete String.prototype[name];
      }catch{}
    }
  }
  for(const col of site.collections.values()){
    const original=state.collectionOwnDescriptors?.get(col);
    for(const name of state.aliases){
      if(!name.startsWith('collection-instance.'))continue;
      const method=name.slice('collection-instance.'.length);
      try{delete col[method]}catch{}
    }
    try{delete col.__isiteCompatDecorated}catch{}
    if(original){
      for(const [name,desc] of Object.entries(original)){
        try{Object.defineProperty(col,name,desc)}catch{}
      }
    }
  }
  state.enabled=false;
  state._sharedCacheUnsubscribe?.();
  state._wordCacheUnsubscribe?.();
  state._staticCacheUnsubscribe?.();
  for(const off of state.descriptorInvalidationUnsubscribers||[])try{off()}catch{}
  state.descriptorInvalidationUnsubscribers?.clear?.();
  delete site.compatibility.isite;
  return site;
}

module.exports={install,uninstall};
