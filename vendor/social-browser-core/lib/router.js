'use strict';

function normalizePathname(pathname){
  pathname=String(pathname||'/');
  if(pathname.length>1 && pathname.endsWith('/')) pathname=pathname.slice(0,-1);
  return pathname || '/';
}

function compilePattern(pattern) {
  if (pattern instanceof RegExp) return { regex: pattern, keys: [], kind:'regex', firstSegment:'*', staticCount:0, partsCount:0, paramCount:0, wildcardCount:0, optionalCount:0, segments:[], trieEligible:false };
  pattern = String(pattern || '/');
  const keys = [];
  let src = '^';
  const parts = pattern.split('/').filter(Boolean);
  let staticCount=0,paramCount=0,wildcardCount=0,optionalCount=0;
  let firstSegment='*';
  const segments=[];

  if(parts.length===0) src+='/';
  for(let i=0;i<parts.length;i++){
    const part=parts[i];
    src+='/';
    if(part==='*'){
      keys.push('wild');src+='(.*)';wildcardCount++;segments.push({kind:'wildcard',value:'*'});
    }else if(part.startsWith(':')){
      const optional=part.endsWith('?');
      const name=part.slice(1,optional?-1:undefined);
      keys.push(name);
      src+=optional?'([^/]*)':'([^/]+)';paramCount++;if(optional)optionalCount++;
      segments.push({kind:optional?'optional':'param',value:name});
    }else{
      src+=part.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      staticCount++;if(i===0) firstSegment=part;segments.push({kind:'static',value:part});
    }
  }
  src+='/?$';
  return {
    regex:new RegExp(src),keys,
    kind:wildcardCount?'wildcard':paramCount?'param':'exact',
    firstSegment,staticCount,partsCount:parts.length,paramCount,wildcardCount,optionalCount,segments,
    trieEligible:!wildcardCount&&!optionalCount&&parts.length>0
  };
}

function routeScore(route,index=0){
  return route.staticCount*100000 + route.partsCount*1000 - route.paramCount*100 - route.wildcardCount*10000 - index;
}


function newTrieNode(){return {static:new Map(),param:null,routes:[]}}

function insertTrie(root,route){
  let node=root;
  for(const seg of route.segments||[]){
    if(seg.kind==='static'){
      let next=node.static.get(seg.value);
      if(!next){next=newTrieNode();node.static.set(seg.value,next)}
      node=next;
    }else if(seg.kind==='param'){
      if(!node.param)node.param=newTrieNode();
      node=node.param;
    }else return false;
  }
  node.routes.push(route);return true;
}

function prepareTrie(node,sort){
  if(!node)return;
  node.routes.sort(sort);
  for(const child of node.static.values())prepareTrie(child,sort);
  prepareTrie(node.param,sort);
}

function matchTrie(root,pathname){
  const parts=String(pathname||'/').split('/').filter(Boolean);
  let best=null;
  const visit=(node,index)=>{
    if(!node)return;
    if(index===parts.length){
      const route=node.routes[0];
      if(route&&(!best||route.score>best.score||(route.score===best.score&&route.index<best.index)))best=route;
      return;
    }
    const value=parts[index];
    // Static branch first; param remains available for ambiguous patterns.
    visit(node.static.get(value),index+1);
    visit(node.param,index+1);
  };
  visit(root,0);return best;
}

class Router {
  constructor(options={}) {
    this.routes=[];
    this.exact=new Map();
    this.dynamicByMethod=new Map();
    this.dynamicAny=new Map();
    this.regexByMethod=new Map();
    this.regexAny=[];
    this.trieByMethod=new Map();
    this.trieAny=newTrieNode();
    this.version=0;
    this.cache=new Map();
    this.cacheMax=Math.max(256,Number(options.cacheMax||16384));
    this._preparedVersion=-1;
    this.metrics={matches:0,exactHits:0,trieHits:0,dynamicHits:0,regexHits:0,cacheHits:0,misses:0,prepares:0};
  }
  _exactMap(method){let m=this.exact.get(method);if(!m){m=new Map();this.exact.set(method,m)}return m}
  _dynamicMap(method){let m=this.dynamicByMethod.get(method);if(!m){m=new Map();this.dynamicByMethod.set(method,m)}return m}
  _trie(method){let t=this.trieByMethod.get(method);if(!t){t=newTrieNode();this.trieByMethod.set(method,t)}return t}
  _bucket(map,key){let a=map.get(key);if(!a){a=[];map.set(key,a)}return a}

  add(method,pattern,handler){
    method=String(method||'GET').toUpperCase();
    const compiled=compilePattern(pattern);
    const route={method,pattern,handler,...compiled,index:this.routes.length};
    route.score=routeScore(route,route.index);
    this.routes.push(route);
    if(compiled.kind==='exact' && !(pattern instanceof RegExp)){
      this._exactMap(method).set(normalizePathname(pattern),route);
    }else if(compiled.kind==='regex'){
      if(method==='ALL')this.regexAny.push(route);
      else{let arr=this.regexByMethod.get(method);if(!arr){arr=[];this.regexByMethod.set(method,arr)}arr.push(route)}
    }else if(compiled.trieEligible){
      insertTrie(method==='ALL'?this.trieAny:this._trie(method),route);
    }else{
      const map=method==='ALL'?this.dynamicAny:this._dynamicMap(method);
      this._bucket(map,compiled.firstSegment).push(route);
    }
    this.version++;this._preparedVersion=-1;this.cache.clear();return handler;
  }

  prepare(){
    if(this._preparedVersion===this.version)return this;
    const sort=(a,b)=>b.score-a.score || a.index-b.index;
    for(const map of this.dynamicByMethod.values())for(const rows of map.values())rows.sort(sort);
    for(const rows of this.dynamicAny.values())rows.sort(sort);
    for(const trie of this.trieByMethod.values())prepareTrie(trie,sort);
    prepareTrie(this.trieAny,sort);
    for(const rows of this.regexByMethod.values())rows.sort((a,b)=>a.index-b.index);
    this.regexAny.sort((a,b)=>a.index-b.index);
    this._preparedVersion=this.version;this.metrics.prepares++;return this;
  }

  _firstSegment(pathname){if(pathname==='/'||!pathname)return '';const i=pathname.indexOf('/',1);return i<0?pathname.slice(1):pathname.slice(1,i)}
  _cached(key,value){if(this.cache.size>=this.cacheMax){const first=this.cache.keys().next().value;if(first!==undefined)this.cache.delete(first)}const stored=value&&value.params?{route:value.route,params:Object.freeze({...value.params})}:value;this.cache.set(key,stored);return stored&&stored.params?{route:stored.route,params:{...stored.params}}:stored}

  match(method,pathname){
    this.prepare();this.metrics.matches++;
    const upper=String(method||'GET').toUpperCase();pathname=normalizePathname(pathname);
    const cacheKey=upper+' '+pathname;
    const cached=this.cache.get(cacheKey);
    if(cached!==undefined){this.metrics.cacheHits++;return cached&&cached.params?{route:cached.route,params:{...cached.params}}:cached}

    const exactMethod=this.exact.get(upper)?.get(pathname);
    const exactAll=this.exact.get('ALL')?.get(pathname);
    if(exactMethod||exactAll){this.metrics.exactHits++;const route=exactMethod||exactAll;return this._cached(cacheKey,{route,params:{}})}

    const first=this._firstSegment(pathname);
    let best=null;
    const consider=(route,kind)=>{
      const m=route.regex.exec(pathname);if(!m)return;
      if(!best||route.score>best.route.score||(route.score===best.route.score&&route.index<best.route.index))best={route,m,kind};
    };
    const trieMethod=matchTrie(this.trieByMethod.get(upper),pathname);
    const trieAll=matchTrie(this.trieAny,pathname);
    if(trieMethod)consider(trieMethod,'trie');
    if(trieAll)consider(trieAll,'trie');
    const dyn=this.dynamicByMethod.get(upper);
    if(dyn){for(const r of dyn.get(first)||[])consider(r,'dynamic');for(const r of dyn.get('*')||[])consider(r,'dynamic')}
    for(const r of this.dynamicAny.get(first)||[])consider(r,'dynamic');
    for(const r of this.dynamicAny.get('*')||[])consider(r,'dynamic');
    // Regex routes remain a rare fallback and preserve registration ordering.
    for(const r of this.regexByMethod.get(upper)||[])consider(r,'regex');
    for(const r of this.regexAny)consider(r,'regex');
    if(!best){this.metrics.misses++;return this._cached(cacheKey,null)}
    if(best.kind==='regex')this.metrics.regexHits++;else if(best.kind==='trie')this.metrics.trieHits++;else this.metrics.dynamicHits++;
    const params={};best.route.keys.forEach((k,i)=>{try{params[k]=decodeURIComponent(best.m[i+1]||'')}catch{params[k]=best.m[i+1]||''}});
    return this._cached(cacheKey,{route:best.route,params});
  }

  rebuild(){
    const existing=this.routes.map(r=>({method:r.method,pattern:r.pattern,handler:r.handler}));
    this.routes=[];this.exact.clear();this.dynamicByMethod.clear();this.dynamicAny.clear();this.regexByMethod.clear();this.regexAny=[];this.trieByMethod.clear();this.trieAny=newTrieNode();this.cache.clear();this.version=0;this._preparedVersion=-1;
    for(const r of existing)this.add(r.method,r.pattern,r.handler);this.prepare();return this;
  }
  stats(){return {...this.metrics,routes:this.routes.length,exact:[...this.exact.values()].reduce((n,m)=>n+m.size,0),trieMethods:this.trieByMethod.size,cacheEntries:this.cache.size,version:this.version,preparedVersion:this._preparedVersion}}
}

module.exports={Router,compilePattern,normalizePathname,routeScore};
