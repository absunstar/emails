'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}

function getPath(obj, key) {
  if (!key) return obj;
  const parts = String(key).split('.');
  let cur = obj;
  for (const part of parts) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(obj, key, value) {
  const parts = String(key).split('.');
  if(parts.some(p=>p==='__proto__'||p==='prototype'||p==='constructor'))
    throw Object.assign(new Error('Unsafe object path'),{code:'UNSAFE_OBJECT_PATH'});
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (!isObject(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts.at(-1)] = value;
  return obj;
}


function assertQueryComplexity(value,options={}){
  const maxDepth=Math.max(1,Number(options.maxDepth||24));
  const maxNodes=Math.max(10,Number(options.maxNodes||2000));
  const maxArray=Math.max(10,Number(options.maxArray||1000));
  const maxString=Math.max(64,Number(options.maxString||16384));
  let nodes=0;
  const walk=(v,depth)=>{
    if(++nodes>maxNodes)throw Object.assign(new Error('ORM query too complex'),{code:'ORM_QUERY_TOO_COMPLEX',reason:'nodes'});
    if(depth>maxDepth)throw Object.assign(new Error('ORM query too deep'),{code:'ORM_QUERY_TOO_COMPLEX',reason:'depth'});
    if(typeof v==='string'&&v.length>maxString)throw Object.assign(new Error('ORM query string too large'),{code:'ORM_QUERY_TOO_COMPLEX',reason:'string'});
    if(Array.isArray(v)){
      if(v.length>maxArray)throw Object.assign(new Error('ORM query array too large'),{code:'ORM_QUERY_TOO_COMPLEX',reason:'array'});
      for(const x of v)walk(x,depth+1);
    }else if(v&&typeof v==='object'){
      for(const [k,x] of Object.entries(v)){
        if(k==='__proto__'||k==='prototype'||k==='constructor')throw Object.assign(new Error('Unsafe ORM query key'),{code:'ORM_QUERY_UNSAFE_KEY',key:k});
        walk(x,depth+1);
      }
    }
  };
  walk(value,0);
  return true;
}
function safeRegex(value){
  if(value instanceof RegExp){
    if(value.source.length>1024)throw Object.assign(new Error('Regex too large'),{code:'ORM_REGEX_UNSAFE'});
    return value;
  }
  const source=String(value??'');
  if(source.length>1024)throw Object.assign(new Error('Regex too large'),{code:'ORM_REGEX_UNSAFE'});
  // Reject common nested-quantifier forms associated with catastrophic backtracking.
  if(/(\([^)]*[+*][^)]*\)|\[[^\]]+\][+*]|\\w[+*]|\\s[+*]|\\d[+*])[+*{]/.test(source))
    throw Object.assign(new Error('Potentially unsafe regex'),{code:'ORM_REGEX_UNSAFE'});
  try{return new RegExp(source)}catch(e){throw Object.assign(new Error('Invalid regex'),{code:'ORM_REGEX_INVALID',cause:e})}
}

function compare(value, condition) {
  if (!isObject(condition) || condition instanceof Date) {
    if (Array.isArray(value)) return value.includes(condition);
    return value === condition;
  }
  for (const [op, expected] of Object.entries(condition)) {
    if (op === '$not' && compare(value, expected)) return false;
    else if (op === '$in' && !expected.includes(value)) return false;
    else if (op === '$nin' && expected.includes(value)) return false;
    else if (op === '$ne' && value === expected) return false;
    else if (op === '$gt' && !(value > expected)) return false;
    else if (op === '$gte' && !(value >= expected)) return false;
    else if (op === '$lt' && !(value < expected)) return false;
    else if (op === '$lte' && !(value <= expected)) return false;
    else if (op === '$exists' && ((value !== undefined) !== !!expected)) return false;
    else if (op === '$regex') {
      const rx = safeRegex(expected);
      if (!rx.test(String(value ?? ''))) return false;
    } else if (!op.startsWith('$') && !compare(value?.[op], expected)) return false;
  }
  return true;
}

function matches(doc, where = {}) {
  if (!where || Object.keys(where).length === 0) return true;
  if (Array.isArray(where.$and) && !where.$and.every(x => matches(doc, x))) return false;
  if (Array.isArray(where.$or) && !where.$or.some(x => matches(doc, x))) return false;
  if (Array.isArray(where.$nor) && where.$nor.some(x => matches(doc, x))) return false;
  if (where.$not && matches(doc, where.$not)) return false;

  for (const [key, cond] of Object.entries(where)) {
    if (key.startsWith('$')) continue;
    if (!compare(getPath(doc, key), cond)) return false;
  }
  return true;
}

function projectDoc(doc, projection) {
  if (!projection || typeof projection !== 'object' || !Object.keys(projection).length) return clone(doc);
  const include = Object.entries(projection).filter(([,v])=>!!v).map(([k])=>k);
  const exclude = Object.entries(projection).filter(([,v])=>!v).map(([k])=>k);
  if (include.length) {
    const out={};
    for(const key of include){
      const value=getPath(doc,key);
      if(value!==undefined)setPath(out,key,clone(value));
    }
    if(projection._id!==0 && doc?._id!==undefined && !include.includes('_id')) out._id=clone(doc._id);
    return out;
  }
  const out=clone(doc);
  for(const key of exclude){
    const parts=String(key).split('.');
    let cur=out;
    for(let i=0;i<parts.length-1;i++){cur=cur?.[parts[i]];if(cur==null)break}
    if(cur&&typeof cur==='object')delete cur[parts.at(-1)];
  }
  return out;
}

function aggregateDocs(input, pipeline=[]) {
  let list=(input||[]).map(clone);
  for(const stage of pipeline||[]){
    if(stage.$match) list=list.filter(x=>matches(x,stage.$match));
    else if(stage.$sort) list=sortDocs(list,stage.$sort);
    else if(stage.$skip) list=list.slice(Number(stage.$skip)||0);
    else if(stage.$limit) list=list.slice(0,Number(stage.$limit)||0);
    else if(stage.$project) list=list.map(x=>projectDoc(x,stage.$project));
    else if(stage.$count) return [{[stage.$count]:list.length}];
    else if(stage.$group){
      const spec=stage.$group||{},groups=new Map();
      const idExpr=spec._id;
      const valueOf=(doc,expr)=>{
        if(typeof expr==='string'&&expr.startsWith('$'))return getPath(doc,expr.slice(1));
        return expr;
      };
      for(const doc of list){
        const id=valueOf(doc,idExpr);
        const key=JSON.stringify(id);
        if(!groups.has(key))groups.set(key,{_id:clone(id)});
        const row=groups.get(key);
        for(const [field,acc] of Object.entries(spec)){
          if(field==='_id')continue;
          if(acc&&typeof acc==='object'){
            if('$sum' in acc)row[field]=(row[field]||0)+Number(valueOf(doc,acc.$sum)||0);
            else if('$min' in acc){const v=valueOf(doc,acc.$min);row[field]=row[field]===undefined?v:(v<row[field]?v:row[field])}
            else if('$max' in acc){const v=valueOf(doc,acc.$max);row[field]=row[field]===undefined?v:(v>row[field]?v:row[field])}
            else if('$first' in acc){if(!(field in row))row[field]=clone(valueOf(doc,acc.$first))}
            else if('$push' in acc){(row[field]||(row[field]=[])).push(clone(valueOf(doc,acc.$push)))}
            else throw Object.assign(new Error(`Unsupported aggregate accumulator for ${field}`),{code:'ORM_AGGREGATE_UNSUPPORTED'});
          }
        }
      }
      list=[...groups.values()];
    } else throw Object.assign(new Error(`Unsupported aggregate stage: ${Object.keys(stage)[0]||'unknown'}`),{code:'ORM_AGGREGATE_UNSUPPORTED'});
  }
  return list;
}

function sortDocs(list, sort) {
  if (!sort) return list;
  const entries = Array.isArray(sort)
    ? sort
    : Object.entries(sort).map(([key, dir]) => [key, Number(dir) < 0 ? -1 : 1]);
  return list.sort((a, b) => {
    for (const [key, dir] of entries) {
      const av = getPath(a, key), bv = getPath(b, key);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
    }
    return 0;
  });
}

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function md5(value) {
  return crypto.createHash('md5').update(String(value)).digest('hex');
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function atomicWrite(file, data, options={}) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  const durable=options===true||options?.durable===true;
  let fd=null;
  try{
    fd=fs.openSync(tmp,'w');
    if(Buffer.isBuffer(data))fs.writeFileSync(fd,data);
    else fs.writeFileSync(fd,String(data));
    if(durable)fs.fsyncSync(fd);
  }finally{if(fd!=null)try{fs.closeSync(fd)}catch{}}
  fs.renameSync(tmp,file);
  if(durable){
    // Persist the directory entry where supported. Windows may reject directory fsync.
    let dirFd=null;
    try{dirFd=fs.openSync(path.dirname(file),'r');fs.fsyncSync(dirFd)}catch{}
    finally{if(dirFd!=null)try{fs.closeSync(dirFd)}catch{}}
  }
}
function atomicWriteDurable(file,data){return atomicWrite(file,data,{durable:true})}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toDate(v) {
  if (v instanceof Date) return v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fromJson(v, fallback = null) {
  try { return JSON.parse(v); } catch { return fallback; }
}

module.exports = {
  isObject, clone, getPath, setPath, matches, sortDocs, projectDoc, aggregateDocs,
  assertQueryComplexity, safeRegex,
  randomId, md5, sha256, ensureDir, atomicWrite, atomicWriteDurable, escapeHtml, toNumber, toDate, fromJson
};
