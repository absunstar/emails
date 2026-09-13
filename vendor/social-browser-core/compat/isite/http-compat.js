'use strict';
const {URL}=require('url');
const zlib=require('zlib');

function wildcardLike(value,pattern){
  value=String(value??'');pattern=String(pattern??'');
  if(pattern.includes('|'))return pattern.split('|').some(p=>wildcardLike(value,p));
  const esc=pattern.replace(/[.+?^${}()|[\]\\]/g,'\\$&').replace(/\*/g,'.*');
  try{return new RegExp('^'+esc+'$','i').test(value)}catch{return value.toLowerCase()===pattern.toLowerCase()}
}
function lowerQueryFromUrl(url,host='localhost',proto='http:'){
  const raw=new URL(url||'/',`${proto}//${host}`);
  const low=new URL(String(url||'/').toLowerCase(),`${proto}//${String(host||'localhost').toLowerCase()}`);
  const queryRaw=Object.fromEntries(raw.searchParams.entries());
  for(const [k,v] of Object.entries({...queryRaw}))queryRaw[k.toLowerCase()]=v;
  const query=Object.fromEntries(low.searchParams.entries());
  for(const [k,v] of Object.entries({...query}))query[k.toLowerCase()]=v;
  const pack=u=>({
    protocol:u.protocol,slashes:true,auth:u.username||u.password?`${u.username}:${u.password}`:'',
    host:u.host,port:u.port,hostname:u.hostname,hash:u.hash,search:u.search,
    query:Object.fromEntries(u.searchParams.entries()),pathname:u.pathname,path:u.pathname+u.search,href:u.href
  });
  const rawPack=pack(raw),lowPack=pack(low);
  rawPack.query=queryRaw;lowPack.query=query;
  return {raw,low,queryRaw,query,urlParserRaw:rawPack,urlParser:lowPack};
}
function normalizeIp(ip=''){ip=String(ip).replace(/^::ffff:/,'');return ip==='::1'?'127.0.0.1':ip}
function formidableFiles(files){
  if(!files)return {};
  if(!Array.isArray(files))return files;
  const out={};
  for(const f of files){
    const row={
      ...f,
      originalFilename:f.originalFilename??f.name??'',
      filepath:f.filepath??f.path,
      newFilename:f.newFilename??f.storedName,
      mimetype:f.mimetype??f.type,
      size:f.size
    };
    if(Object.hasOwn(out,f.field))out[f.field]=[].concat(out[f.field],row);
    else out[f.field]=row;
  }
  return out;
}
function buildUserFinger(req){
  const out={id:null,email:null,date:new Date(),ip:null};
  const user=req?.session?.user;
  if(user){
    user.profile=user.profile||{};
    out.id=user.id;
    out.email=user.email;
    out.name=user.profile.name||out.email;
    out.name_ar=user.profile.name_ar||out.email;
    out.name_en=user.profile.name_en||out.email;
    out.ip=req.ip;
  }
  return out;
}
function finalizeRequest(site,req,res){
  const proto=req.socket?.encrypted?'https:':'http:';
  req.host=req.headers.host||'';
  req.origin=req.headers.origin||'';
  req.referer=req.headers.referer||'';
  req.title=String(req.url||'').replace('/','').split('/').join(' - ')||'';
  req.domain=req.domain||'';
  req.subDomain=req.subDomain||'';
  req.obj=req.obj||{};

  req.remoteAddress=req.socket?.remoteAddress||'';
  req.acceptEncoding=req.headers['accept-encoding']||'';
  const forwarded=String(req.headers['x-forwarded-for']||'').split(',')[0].trim();
  req.ip=normalizeIp(site.securityShield?.trustProxy&&forwarded?forwarded:req.remoteAddress);
  req.ip2=normalizeIp(req.socket?.localAddress||'');
  req.port=req.socket?.remotePort;
  req.port2=req.socket?.localPort;
  res.ip=req.ip;res.ip2=req.ip2;res.port=req.port;res.port2=req.port2;

  // Legacy iSite exposes the same callable cookie facade as req.cookie/req.cookies/res.cookie/res.cookies.
  const parsedCookies=(req.cookies&&typeof req.cookies==='object')?{...req.cookies}:{};
  const coreCookie=res._coreCookie||res.cookie?.bind(res);
  const cookie=function(key,value,opts){
    if(arguments.length>1){coreCookie?.(key,value,opts||{});parsedCookies[key]=String(value??'');return value}
    return parsedCookies[key];
  };
  cookie.get=key=>parsedCookies[key];
  cookie.set=(key,value,opts)=>{coreCookie?.(key,value,opts||{});parsedCookies[key]=String(value??'');return value};
  cookie.delete=(key,opts)=>{coreCookie?.(key,'',{...(opts||{}),expires:new Date(0),maxAge:0});delete parsedCookies[key];return true};
  cookie.all=parsedCookies;
  cookie.write=()=>true;
  req.cookie=req.cookies=res.cookie=res.cookies=cookie;

  // iSite response defaults. Compatibility-only; native Core does not enable permissive CORS.
  res.set('CharSet','UTF-8');
  res.set('Access-Control-Allow-Credentials','true');
  res.set('Access-Control-Allow-Headers',req.headers['access-control-request-headers']||'Origin, X-Requested-With, Content-Type, Accept , Access-Token , Authorization');
  res.set('Access-Control-Allow-Methods',req.headers['access-control-request-method']||'POST,GET,DELETE,PUT,OPTIONS,VIEW,HEAD,CONNECT,TRACE');
  res.set('Access-Control-Allow-Origin',req.origin||req.referer||'*');

  req.urlRaw=req.url;
  const parsed=lowerQueryFromUrl(req.urlRaw,req.host||'localhost',proto);
  req.urlParserRaw=parsed.urlParserRaw;
  req.urlParser=parsed.urlParser;
  req.queryRaw=parsed.queryRaw;
  req.query=parsed.query;

  req.params=req.params||{};
  req.paramsRaw=req.paramsRaw||{};

  req.features=Array.isArray(req.features)?req.features:[];
  req.addFeature=name=>{if(!req.features.includes(name))req.features.push(name)};
  req.hasFeature=name=>req.features.some(f=>wildcardLike(f,name));
  req.removeFeature=name=>{req.features=req.features.filter(f=>!wildcardLike(f,name))};

  if(req.browserDetected){
    req.addFeature('browser.social');
    req.addFeature('browser.'+req.browserHeader);
    if(req.browserName)req.addFeature('browser.'+req.browserName);
    if(req.browserID)req.addFeature('browser.'+req.browserID);
    if(req.browserUUID)req.addFeature('browser.'+req.browserUUID);
    if(req.browserToken)req.addFeature('browser.auth-token');
  }

  req.getUserFinger=()=>buildUserFinger(req);

  const raw=req.rawBody;
  if(Buffer.isBuffer(raw))req.bodyRaw=raw.toString('utf8');
  else if(raw!=null)req.bodyRaw=String(raw);
  else if(req.bodyRaw==null)req.bodyRaw='';
  req.dataRaw=req.bodyRaw;

  const method=String(req.method||'GET').toLowerCase();
  if(method.includes('get')){
    req.body=req.data=req.query;
    req.bodyRaw=req.dataRaw=req.queryRaw;
  }else{
    req.data=req.body??{};
  }

  if(req.multipart){
    const files=formidableFiles(req.multipart.files||req.files);
    req.files=files;
    req.form={err:null,fields:req.multipart.fields||req.body||{},files};
    req.body=req.data=req.form.fields;
  }

  req.maxBodyBytes=req.maxBodyBytes||site.options?.request?.maxBodyBytes||10*1024*1024;
  req.bodyBytes=Buffer.isBuffer(raw)?raw.length:Buffer.byteLength(typeof req.bodyRaw==='string'?req.bodyRaw:'');
  req.appendBody=req.appendBody||function(data){
    req.bodyBytes+=Buffer.byteLength(data);
    if(req.bodyBytes>req.maxBodyBytes){req.bodyTooLarge=true;return false}
    req.bodyRaw=(typeof req.bodyRaw==='string'?req.bodyRaw:'')+data;
    return true;
  };

  req.word=req.word||((name)=>site.word?site.word(name,req.session?.language?.id||req.session?.lang):name);
  return req;
}
function finalizeParams(req,pattern,foundParams){
  if(!req.urlParserRaw?.pathname&&!req.path){
    req.params={...(req.params||{}),...(foundParams||{})};
    req.paramsRaw=req.paramsRaw||{...(req.params||{})};
    return req.params;
  }
  const rawPath=req.urlParserRaw?.pathname||req.path||'/';
  const lowPath=req.urlParser?.pathname||String(rawPath).toLowerCase();
  const rawSeg=rawPath.split('/');
  const lowSeg=lowPath.split('/');
  const pSeg=String(pattern||'').split('/');
  const lower={},raw={};
  for(let i=0;i<pSeg.length;i++){
    const seg=pSeg[i];
    if(seg?.startsWith(':')){
      const key=seg.slice(1);
      const lowerKey=key.toLowerCase();
      let value;
      try{value=decodeURIComponent((lowSeg[i]||'').replace(/\+/g,' '))}catch{value=(lowSeg[i]||'').replace(/\+/g,' ')}
      lower[lowerKey]=value;
      raw[lowerKey]=rawSeg[i]||'';
      if(key!==lowerKey){lower[key]=value;raw[key]=rawSeg[i]||''}
    }
  }
  req.params={...foundParams,...lower};
  req.paramsRaw=raw;
}

function runLegacyValidator(fn,req,res){
  if(typeof fn!=='function')return Promise.resolve(true);
  return new Promise((resolve,reject)=>{
    let settled=false;
    const next=(r=req,s=res)=>{if(settled)return;settled=true;resolve(true)};
    try{
      const out=fn(req,res,next);
      if(out&&typeof out.then==='function'){
        out.then(value=>{if(!settled){settled=true;resolve(value===false?false:true)}}).catch(reject);
      }else{
        queueMicrotask(()=>{if(!settled){settled=true;resolve(out===false?false:!!res.writableEnded?false:false)}});
      }
    }catch(e){reject(e)}
  });
}
function selectCompression(req,contentType,body){
  if(typeof body!=='string'&&!Buffer.isBuffer(body))return null;
  const size=Buffer.byteLength(body);
  if(size<1024)return null;
  const type=String(contentType||'').toLowerCase();
  if(!/(text\/css|javascript|text\/html|text\/plain|application\/json|application\/xml|text\/xml|image\/svg\+xml)/.test(type))return null;
  const accept=String(req.acceptEncoding||req.headers?.['accept-encoding']||'').toLowerCase();
  if(accept.includes('br')&&zlib.brotliCompress)return {encoding:'br',fn:zlib.brotliCompress};
  if(accept.includes('gzip'))return {encoding:'gzip',fn:zlib.gzip};
  if(accept.includes('deflate'))return {encoding:'deflate',fn:zlib.deflate};
  return null;
}

function decorateResponse(site,req,res){
  if(res.__isiteHttpDecorated)return res;
  Object.defineProperty(res,'__isiteHttpDecorated',{value:true});

  res.code=null;
  res.headers=res.headers||[];
  res._coreCookie=res._coreCookie||res.cookie?.bind(res);
  res.download2=res.download;
  const rawSet=res.set?.bind(res);
  res.set=(a,b,c)=>{
    if(res.headersSent||res.finished)return res;
    if(typeof a==='object'){
      for(const [k,v] of Object.entries(a))res.set(k,v);
      return res;
    }
    if(typeof b==='string'){
      if(String(a).toLowerCase()==='content-type'&&!b.toLowerCase().includes('charset=utf-8'))b+='; charset=utf-8';
      res.headers[a]=String(b).toLowerCase();
    }
    res.setHeader(a,b,c);return res;
  };
  res._setContentType=value=>res.set('Content-Type',value);

  res.delete=res.remove=(name)=>{res.removeHeader(name);return res};


const nativeEnd=res.end.bind(res);
res.end0=nativeEnd;
res.end=function(arg1,arg2,arg3){
  if(res.writableEnded||res.ended)return res;
  if(typeof arg1==='number'){
    if(!res.code)res.code=arg1;
    res.statusCode=arg1;
    return res.end(arg2,arg3);
  }
  if(!res.getHeader('Content-Type'))res.set('Content-Type','text/html');
  res.statusCode=res.code||res.statusCode||200;
  const streamingEnd=(arg1===undefined||arg1===null)&&(res.headersSent||res.getHeader('Content-Length')!=null);
  const body=streamingEnd?undefined:(arg1||' ');
  // Never recompress a body that an upstream/static-file path has already
  // encoded. Recompressing a precompressed Brotli/Gzip buffer leaves the
  // browser with one compressed layer after decoding Content-Encoding.
  const alreadyEncoded=!!res.getHeader('Content-Encoding');
  const compression=(body===undefined||alreadyEncoded)?null:selectCompression(req,res.getHeader('Content-Type'),body);
  res.ended=true;
  if(compression){
    const source=Buffer.isBuffer(body)?body:Buffer.from(String(body));
    const finishCompressed=compressed=>{
      if(!res.headersSent){
        res.set('Content-Encoding',compression.encoding);
        res.set('Vary','Accept-Encoding');
        try{res.removeHeader('Content-Length')}catch{}
      }
      nativeEnd(compressed,arg2,arg3);
    };
    if(site.compressionCache?.compress){
      site.compressionCache.compress(source,compression.encoding).then(finishCompressed,()=>nativeEnd(body,arg2,arg3));
    }else{
      compression.fn(source,(err,compressed)=>err?nativeEnd(body,arg2,arg3):finishCompressed(compressed));
    }
    return res;
  }
  if(body===undefined)nativeEnd();
  else nativeEnd(body,arg2,arg3);
  return res;
};
  res.status=code=>{if(!res.code)res.code=code||200;res.statusCode=res.code;return res};
  res.error=code=>res.status(code||404).end();
  res.sendStatus=code=>{res.status(code||200).end();return res};
  res.ending=(time,...data)=>setTimeout(()=>res.end(...data),Number(time)||0);

  const coreRedirect=res.redirect?.bind(res);
  res.redirect=(url,code=302)=>{
    res.set('Location',url);
    res.status(code).end();
    return res;
  };

  const coreJson=res.json?.bind(res);
  res.json=(obj,time)=>{
    if(typeof obj==='string'&&site.fsm?.getContent&&res.jsonFile)return res.jsonFile(obj);
    res._setContentType('application/json');
    // iSite exposes site.toJson() as a standalone utility that removes repeated
    // references in-place, but res.json() serializes the response object directly.
    // Using site.toJson() here can delete repeated fields such as req.body/req.data.
    const text=JSON.stringify(obj);
    res.status(200);
    if(time)return res.ending(time,text);
    res.end(text);return res;
  };

  res.htmlContent=res.send=res.sendHTML=(text)=>{
    if(typeof text==='string'){res.set('Content-Type','text/html');res.status(200).end(text)}
    else res.json(text);
    return res;
  };
  res.textContent=res.sendTEXT=(text)=>{
    if(typeof text==='string'){res.set('Content-Type','text/plain');res.status(200).end(text)}
    else res.json(text);
    return res;
  };
  return res;
}
function routeMeta(descriptor,method,defaults={}){
  const d=typeof descriptor==='object'&&descriptor?descriptor:{name:descriptor};
  const isPublic=d.public??defaults.public??false;
  const reqDefault=defaults.require||{features:[],permissions:[]};
  const defaultDefault=defaults.defaults||{features:[],permissions:[]};
  return {
    ...d,
    name:d.name,
    nameRaw:d.name,
    method:String(method||d.method||'GET').toUpperCase(),
    public:isPublic,
    path:d.path??null,
    lang:d.lang??null,
    language:d.language??null,
    content:d.content,
    headers:d.headers??null,
    parser:d.parser||'static',
    parserDir:d.parserDir||defaults.dir,
    masterPage:d.masterPage||null,
    overwrite:d.overwrite??false,
    cache:d.cache??true,
    count:d.count||0,
    hide:d.hide??false,
    compress:d.compress??d.compres??false,
    encript:d.encript??false,
    shared:d.shared??false,
    map:d.map||[],
    require:isPublic?{features:[],permissions:[]}:{
      features:[...(d.require?.features??reqDefault.features??[])],
      permissions:[...(d.require?.permissions??reqDefault.permissions??[])]
    },
    default:{
      features:[...(d.default?.features??defaultDefault.features??[])],
      permissions:[...(d.default?.permissions??defaultDefault.permissions??[])]
    },
    limitPerIP:d.limitPerIP,
    limitWindowMs:d.limitWindowMs||60000
  };
}
async function enforceRoute(site,req,res,route){
  if(!await runLegacyValidator(site.validateRoute,req,res))return false;
  if(!await runLegacyValidator(site.validateSession,req,res))return false;
  route.count=(route.count||0)+1;
  req.route=route;
  if(route.language)req.session.language={...route.language};
  if(route.lang){
    req.session.language=req.session.language||{};
    req.session.language.id=route.lang;
  }
  if(route.headers)for(const [k,v] of Object.entries(route.headers))res.set(k,v);

  if(route.limitPerIP&&!req.headers.range){
    route.ipMap=route.ipMap||new Map();
    const now=Date.now(),windowMs=route.limitWindowMs||60000;
    let bucket=route.ipMap.get(req.ip);
    if(!bucket||now>=bucket.resetAt)bucket={count:0,resetAt:now+windowMs};
    bucket.count++;route.ipMap.set(req.ip,bucket);
    if(bucket.count>route.limitPerIP){
      res.set('Retry-After',Math.max(1,Math.ceil((bucket.resetAt-now)/1000)));
      res.status(429).json({error:'Too many requests from this IP'});
      return false;
    }
    if(route.ipMap.size>10000)for(const [ip,value] of route.ipMap)if(now>=value.resetAt)route.ipMap.delete(ip);
  }

  if(route.public)return true;

  const featureMissing=(route.require?.features||[]).filter(f=>!req.hasFeature(f));
  if(featureMissing.length){
    res.status(401).json({done:false,error:'Required Features',features:route.require.features});
    return false;
  }
  const permissionMissing=(route.require?.permissions||[]).filter(p=>!site.security?.isUserHasPermissions?.(req,res,p));
  if(permissionMissing.length){
    if(String(route.name||'').includes('/api/')){
      res.status(401).json({done:false,error:'Required Permissions',permissions:route.require.permissions});
    }else if((route.require.permissions||[]).includes('login')){
      res.redirect(site.options?.security?.login_url||'/login');
    }else{
      res.status(401).send(`Required Permissions : ${(route.require.permissions||[]).join(',')}`);
    }
    return false;
  }
  return true;
}
module.exports={
  wildcardLike,lowerQueryFromUrl,formidableFiles,buildUserFinger,
  finalizeRequest,finalizeParams,decorateResponse,routeMeta,enforceRoute,
  runLegacyValidator,selectCompression
};
