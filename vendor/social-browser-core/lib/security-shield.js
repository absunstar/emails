'use strict';

const net=require('net');
const crypto=require('crypto');
const dns=require('dns').promises;

function normalizeIp(ip=''){
  ip=String(ip||'').trim();
  if(ip.startsWith('::ffff:'))ip=ip.slice(7);
  if(ip==='::1')return '127.0.0.1';
  return ip;
}
function compileMatcher(items=[]){
  const exact=new Set(),prefix=[];
  for(const raw of items||[]){
    const s=String(raw).trim();if(!s)continue;
    if(s.endsWith('*'))prefix.push(s.slice(0,-1));
    else exact.add(normalizeIp(s));
  }
  return ip=>{ip=normalizeIp(ip);return exact.has(ip)||prefix.some(p=>ip.startsWith(p))}
}

class SlidingWindowLimiter{
  constructor(options={}){
    this.windowMs=Math.max(1000,Number(options.windowMs||60000));
    this.limit=Math.max(1,Number(options.limit||2000000));
    this.maxKeys=Math.max(100,Number(options.maxKeys||100000));
    this.map=new Map();
    this.ops=0;
  }
  cleanup(now=Date.now()){
    const bucket=Math.floor(now/this.windowMs);
    for(const [k,v] of this.map)if(v.bucket<bucket-1)this.map.delete(k);
    if(this.map.size>this.maxKeys){
      let remove=this.map.size-this.maxKeys;
      for(const k of this.map.keys()){this.map.delete(k);if(--remove<=0)break}
    }
  }
  hit(key,now=Date.now()){
    const bucket=Math.floor(now/this.windowMs),k=String(key||'unknown');
    let x=this.map.get(k);
    if(!x||x.bucket!==bucket){x={bucket,count:0};this.map.set(k,x)}
    x.count++;
    if((++this.ops&1023)===0 || this.map.size>this.maxKeys)this.cleanup(now);
    return {allowed:x.count<=this.limit,count:x.count,remaining:Math.max(0,this.limit-x.count),resetAt:(bucket+1)*this.windowMs};
  }
}


function timingSafeEqualText(a,b){
  const aa=Buffer.from(String(a||'')),bb=Buffer.from(String(b||''));
  return aa.length===bb.length && crypto.timingSafeEqual(aa,bb);
}
function isPrivateIp(ip){
  ip=normalizeIp(ip);
  if(net.isIP(ip)===4){
    const n=ip.split('.').map(Number);
    return n[0]===10 || n[0]===127 || (n[0]===169&&n[1]===254) ||
      (n[0]===172&&n[1]>=16&&n[1]<=31) || (n[0]===192&&n[1]===168) ||
      n[0]===0 || n[0]>=224;
  }
  if(net.isIP(ip)===6){
    const x=ip.toLowerCase();
    return x==='::1'||x==='::'||x.startsWith('fc')||x.startsWith('fd')||x.startsWith('fe80:')||x.startsWith('ff');
  }
  return false;
}
async function assertPublicTarget(hostname,options={}){
  const allow=new Set((options.allowHosts||[]).map(x=>String(x).toLowerCase()));
  const host=String(hostname||'').toLowerCase();
  if(allow.has(host))return true;
  if(host==='localhost'||host.endsWith('.localhost'))throw Object.assign(new Error('Private network target blocked'),{code:'SSRF_PRIVATE_TARGET'});
  const records=net.isIP(host)?[{address:host}]:await dns.lookup(host,{all:true,verbatim:true});
  if(!records.length)throw Object.assign(new Error('Target resolution failed'),{code:'SSRF_RESOLUTION_FAILED'});
  for(const r of records)if(isPrivateIp(r.address))throw Object.assign(new Error('Private network target blocked'),{code:'SSRF_PRIVATE_TARGET',address:r.address});
  return true;
}

class SecurityShield{
  constructor(options={}){
    this.enabled=options.enabled!==false;
    this.trustProxy=options.trustProxy===true;
    this.maxHeaderBytes=Math.max(1024,Number(options.maxHeaderBytes||32768));
    this.maxUrlLength=Math.max(256,Number(options.maxUrlLength||8192));
    this.maxBodyBytes=Math.max(1024,Number(options.maxBodyBytes||10*1024*1024));
    this.maxConnectionsPerIp=Math.max(1,Number(options.maxConnectionsPerIp||100));
    this.maxConnectionsTotal=Math.max(1,Number(options.maxConnectionsTotal||10000));
    this.maxTrackedIps=Math.max(100,Number(options.maxTrackedIps||100000));
    this.activeConnectionsTotal=0;
    this.blockedMethods=new Set((options.blockedMethods||['TRACE']).map(x=>String(x).toUpperCase()));
    this.allowedHosts=new Set((options.allowedHosts||[]).map(x=>String(x).toLowerCase()));
    this.requireHost=options.requireHost!==false;
    this.allow=compileMatcher(options.allowIps||[]);
    this.deny=compileMatcher(options.denyIps||[]);
    this.hasAllow=(options.allowIps||[]).length>0;
    this.activeByIp=new Map();
    this.rateLimiter=new SlidingWindowLimiter(options.rateLimit||{});
    this.emitRateLimitHeaders=options.rateLimit?.headers===true;
    this.namedLimiters=new Map();
    this.onBlocked=typeof options.onBlocked==='function'?options.onBlocked:null;
    this.eventLogMax=Math.max(100,Number(options.eventLogMax||5000));
    this.events=[];
    this.bans=new Map();
    this.banThreshold=Math.max(1,Number(options.banThreshold||20));
    this.banWindowMs=Math.max(1000,Number(options.banWindowMs||60000));
    this.banDurationMs=Math.max(1000,Number(options.banDurationMs||300000));
    this.strikes=new Map();
    this.maxWsConnectionsPerIp=Math.max(1,Number(options.maxWsConnectionsPerIp||20));
    this.wsActiveByIp=new Map();
    this.circuit={
      enabled:options.circuitBreaker?.enabled!==false,
      windowMs:Math.max(1000,Number(options.circuitBreaker?.windowMs||10000)),
      errorThreshold:Math.max(1,Number(options.circuitBreaker?.errorThreshold||200)),
      coolDownMs:Math.max(1000,Number(options.circuitBreaker?.coolDownMs||5000)),
      errors:[],
      openUntil:0
    };
    this.headers={
      'X-Content-Type-Options':'nosniff',
      'X-Frame-Options':'DENY',
      'Referrer-Policy':'no-referrer',
      ...(options.headers||{})
    };
  }
  ip(req){
    let direct=req.socket?.__sbSecurityIp;
    if(!direct){direct=normalizeIp(req.socket?.remoteAddress||'');if(req.socket)req.socket.__sbSecurityIp=direct}
    if(!this.trustProxy)return direct;
    const xff=req.headers?.['x-forwarded-for'];
    return normalizeIp(String(xff||'').split(',')[0]||direct);
  }
  connectionIp(socket){return normalizeIp(socket.remoteAddress||'')}

cleanupAbuseState(now=Date.now()){
  const strikeCutoff=now-this.banWindowMs;
  for(const [ip,x] of this.strikes)if(x.startedAt<strikeCutoff)this.strikes.delete(ip);
  for(const [ip,until] of this.bans)if(until<=now)this.bans.delete(ip);
  const trim=(map)=>{
    if(map.size<=this.maxTrackedIps)return;
    let remove=map.size-this.maxTrackedIps;
    for(const k of map.keys()){map.delete(k);if(--remove<=0)break}
  };
  trim(this.strikes);trim(this.bans);trim(this.activeByIp);trim(this.wsActiveByIp);
}

  onConnection(socket){
    if(!this.enabled)return true;
    const ip=this.connectionIp(socket);
    socket.__sbSecurityIp=ip;
    this.cleanupAbuseState();
    if(this.isBanned(ip)){this.logEvent('banned_connection',ip);socket.destroy();return false}
    if(this.deny(ip)||(this.hasAllow&&!this.allow(ip))){this.block('connection_ip_policy',ip);socket.destroy();return false}
    if(this.activeConnectionsTotal>=this.maxConnectionsTotal){
      this.block('global_connection_limit',ip,{active:this.activeConnectionsTotal});
      socket.destroy();return false;
    }
    const n=(this.activeByIp.get(ip)||0)+1;this.activeByIp.set(ip,n);
    if(n>this.maxConnectionsPerIp){this.block('connection_limit',ip,{active:n});socket.destroy();this.activeByIp.set(ip,n-1);return false}
    this.activeConnectionsTotal++;
    socket.once('close',()=>{
      this.activeConnectionsTotal=Math.max(0,this.activeConnectionsTotal-1);
      const left=Math.max(0,(this.activeByIp.get(ip)||1)-1);
      if(left)this.activeByIp.set(ip,left);else this.activeByIp.delete(ip);
    });
    return true;
  }

logEvent(type,ip,details={}){
  const row={type,ip:normalizeIp(ip),at:Date.now(),...details};
  this.events.push(row);
  if(this.events.length>this.eventLogMax)this.events.splice(0,this.events.length-this.eventLogMax);
  return row;
}
recentEvents(limit=100,filter={}){
  let rows=this.events;
  if(filter.type)rows=rows.filter(x=>x.type===filter.type);
  if(filter.ip)rows=rows.filter(x=>x.ip===normalizeIp(filter.ip));
  return rows.slice(-Math.max(0,Number(limit)||100));
}
isBanned(ip,now=Date.now()){
  ip=normalizeIp(ip);const until=this.bans.get(ip)||0;
  if(until<=now){if(until)this.bans.delete(ip);return false}
  return true;
}
ban(ip,durationMs=this.banDurationMs,reason='manual'){
  ip=normalizeIp(ip);const until=Date.now()+Math.max(1000,Number(durationMs||this.banDurationMs));
  this.bans.set(ip,until);this.logEvent('ban',ip,{reason,until});return until;
}
unban(ip){ip=normalizeIp(ip);const had=this.bans.delete(ip);this.strikes.delete(ip);return had}
strike(ip,reason='blocked'){
  ip=normalizeIp(ip);const now=Date.now();
  let x=this.strikes.get(ip);
  if(!x||now-x.startedAt>this.banWindowMs)x={count:0,startedAt:now};
  x.count++;this.strikes.set(ip,x);
  if(x.count>=this.banThreshold){this.ban(ip,this.banDurationMs,reason);this.strikes.delete(ip);return true}
  return false;
}
circuitOpen(now=Date.now()){
  if(!this.circuit.enabled)return false;
  return this.circuit.openUntil>now;
}
recordServerError(){
  if(!this.circuit.enabled)return;
  const now=Date.now(),min=now-this.circuit.windowMs;
  this.circuit.errors.push(now);
  while(this.circuit.errors.length&&this.circuit.errors[0]<min)this.circuit.errors.shift();
  if(this.circuit.errors.length>=this.circuit.errorThreshold){
    this.circuit.openUntil=now+this.circuit.coolDownMs;
    this.circuit.errors.length=0;
    this.logEvent('circuit_open','',{until:this.circuit.openUntil});
  }
}
wsConnection(socket,req){
  if(!this.enabled)return true;
  const ip=this.ip(req);
  if(this.isBanned(ip)){this.logEvent('ws_banned',ip);socket.destroy();return false}
  const n=(this.wsActiveByIp.get(ip)||0)+1;this.wsActiveByIp.set(ip,n);
  if(n>this.maxWsConnectionsPerIp){
    this.block('ws_connection_limit',ip,{active:n});
    this.wsActiveByIp.set(ip,n-1);socket.destroy();return false;
  }
  socket.once('close',()=>{const left=Math.max(0,(this.wsActiveByIp.get(ip)||1)-1);if(left)this.wsActiveByIp.set(ip,left);else this.wsActiveByIp.delete(ip)});
  return true;
}

  limiter(name,options={}){
    if(!this.namedLimiters.has(name))this.namedLimiters.set(name,new SlidingWindowLimiter(options));
    return this.namedLimiters.get(name);
  }
  checkLimit(name,key,options={}){
    return this.limiter(name,options).hit(key);
  }
  middleware(name,keyFn,options={}){
    return (req,res,next)=>{
      const key=typeof keyFn==='function'?keyFn(req):this.ip(req);
      const hit=this.checkLimit(name,key,options);
      if(!hit.allowed){
        this.block('named_rate_limit',this.ip(req),{name,key,count:hit.count});
        res.statusCode=429;res.setHeader('Retry-After',String(Math.ceil((options.windowMs||60000)/1000)));res.end('Too Many Requests');return;
      }
      return next();
    };
  }


profile(name,options={}){
  const presets={
    login:{limit:10,windowMs:60000,maxKeys:50000},
    otp:{limit:6,windowMs:60000,maxKeys:50000},
    passwordReset:{limit:5,windowMs:300000,maxKeys:50000},
    api:{limit:1200,windowMs:60000,maxKeys:100000},
    upload:{limit:120,windowMs:60000,maxKeys:50000}
  };
  const base=presets[name];
  if(!base)throw new Error(`Unknown security profile: ${name}`);
  const cfg={...base,...options};
  return this.middleware(`profile:${name}`,req=>this.ip(req),cfg);
}

originGuard(allowedOrigins=[]){
  const allow=new Set((allowedOrigins||[]).map(x=>String(x)));
  return (req,res,next)=>{
    const origin=req.headers?.origin;
    if(!origin||allow.has(origin))return next();
    this.block('origin_not_allowed',this.ip(req),{origin});
    res.statusCode=403;res.end('Forbidden');return;
  };
}
csrf(options={}){
  const cookieName=options.cookieName||'sb.csrf';
  const headerName=String(options.headerName||'x-csrf-token').toLowerCase();
  const safe=new Set(['GET','HEAD','OPTIONS']);
  return (req,res,next)=>{
    let token=req.cookies?.[cookieName]||null;
    if(safe.has(String(req.method||'GET').toUpperCase())){
      if(!token){
        token=crypto.randomBytes(24).toString('base64url');
        res.cookie(cookieName,token,{httpOnly:false,sameSite:options.sameSite||'Strict',secure:!!options.secure});
      }
      req.csrfToken=()=>token;
      return next();
    }
    const supplied=req.headers?.[headerName];
    if(!token||!supplied||!timingSafeEqualText(token,supplied)){
      this.block('csrf_failed',this.ip(req));
      res.statusCode=403;res.end('CSRF validation failed');return;
    }
    req.csrfToken=()=>token;
    return next();
  };
}
async assertPublicTarget(hostname,options={}){return assertPublicTarget(hostname,options)}

  reject(req,res,status,message,{close=false,headers={}}={}){
    res.statusCode=status;
    for(const [k,v] of Object.entries(headers))res.setHeader(k,v);
    if(close)res.setHeader('Connection','close');
    res.end(message);
    if(close)res.once('finish',()=>{try{req.socket?.destroy()}catch{}});
    return false;
  }
  block(reason,ip,extra={}){
    const row=this.logEvent('blocked',ip,{reason,...extra});
    this.strike(ip,reason);
    try{this.onBlocked?.(row)}catch{}
    return row;
  }
  checkRequest(req,res){
    if(!this.enabled)return true;
    const ip=this.ip(req);
    if(this.isBanned(ip)){
      this.logEvent('banned_request',ip);
      return this.reject(req,res,403,'Forbidden',{close:true});
    }
    if(this.circuitOpen()){
      return this.reject(req,res,503,'Service Unavailable',{close:true,headers:{'Retry-After':'5'}});
    }
    const method=String(req.method||'GET').toUpperCase();
    if(this.blockedMethods.has(method)){
      this.block('blocked_method',ip,{method});res.statusCode=405;res.setHeader('Allow','GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS');res.end('Method Not Allowed');return false;
    }
    const host=String(req.headers?.host||'').split(':')[0].toLowerCase();
    if(this.requireHost&&!host){
      this.block('missing_host',ip);return this.reject(req,res,400,'Bad Request',{close:true});
    }
    if(this.allowedHosts.size&&!this.allowedHosts.has(host)){
      this.block('host_not_allowed',ip,{host});res.statusCode=421;res.end('Misdirected Request');return false;
    }
    const te=String(req.headers?.['transfer-encoding']||'').toLowerCase();
    const hasCl=req.headers?.['content-length']!=null;
    if(hasCl && te){
      this.block('ambiguous_message_framing',ip,{contentLength:req.headers['content-length'],transferEncoding:te});
      return this.reject(req,res,400,'Bad Request',{close:true});
    }
    if(te && te!=='chunked'){
      this.block('unsupported_transfer_encoding',ip,{transferEncoding:te});
      return this.reject(req,res,400,'Bad Request',{close:true});
    }
    const cl=Number(req.headers?.['content-length']||0);
    if(Number.isFinite(cl)&&cl>this.maxBodyBytes){
      this.block('body_too_large',ip,{contentLength:cl});return this.reject(req,res,413,'Payload Too Large',{close:true});
    }
    if(this.deny(ip)||(this.hasAllow&&!this.allow(ip))){
      this.block('request_ip_policy',ip);res.statusCode=403;res.end('Forbidden');return false;
    }
    if(String(req.url||'').length>this.maxUrlLength){
      this.block('url_too_long',ip);return this.reject(req,res,414,'URI Too Long',{close:true});
    }
    const hit=this.rateLimiter.hit(ip);
    if(this.emitRateLimitHeaders){
      res.setHeader('RateLimit-Limit',String(this.rateLimiter.limit));
      res.setHeader('RateLimit-Remaining',String(hit.remaining));
      res.setHeader('RateLimit-Reset',String(Math.ceil(hit.resetAt/1000)));
    }
    if(!hit.allowed){
      this.block('rate_limit',ip,{count:hit.count});res.statusCode=429;res.setHeader('Retry-After',String(Math.ceil(this.rateLimiter.windowMs/1000)));res.end('Too Many Requests');return false;
    }
    for(const [k,v] of Object.entries(this.headers))if(v!=null&&!res.hasHeader(k))res.setHeader(k,String(v));
    if(req.socket?.encrypted&&!res.hasHeader('Strict-Transport-Security'))res.setHeader('Strict-Transport-Security','max-age=31536000; includeSubDomains');
    return true;
  }
}
module.exports={SecurityShield,SlidingWindowLimiter,normalizeIp,isPrivateIp,assertPublicTarget,timingSafeEqualText};
