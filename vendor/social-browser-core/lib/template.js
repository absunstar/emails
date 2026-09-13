'use strict';

const fs = require('fs');
const { escapeHtml, getPath } = require('./utils');

function truthy(v) { return !!v && v !== 'false' && v !== 0; }

const interpolationPlans=new Map();
const MAX_PLANS=20000;

function getInterpolationPlan(source){
  source=String(source);
  if(interpolationPlans.has(source)){
    const p=interpolationPlans.get(source);interpolationPlans.delete(source);interpolationPlans.set(source,p);return p;
  }
  const re=/\{\{\{\s*([\w.$-]+)\s*\}\}\}|\{\{\s*([\w.$-]+)\s*\}\}/g;
  const parts=[];let last=0,m;
  while((m=re.exec(source))){
    if(m.index>last)parts.push(source.slice(last,m.index));
    parts.push({key:m[1]||m[2],raw:!!m[1]});
    last=re.lastIndex;
  }
  if(last<source.length)parts.push(source.slice(last));
  const p={parts,hasTokens:parts.some(x=>typeof x==='object')};
  interpolationPlans.set(source,p);
  while(interpolationPlans.size>MAX_PLANS)interpolationPlans.delete(interpolationPlans.keys().next().value);
  return p;
}

function interpolate(source,data){
  const plan=getInterpolationPlan(source);
  if(!plan.hasTokens)return String(source);
  let out='';
  for(const part of plan.parts){
    if(typeof part==='string'){out+=part;continue}
    const value=getPath(data,part.key)??'';
    out+=part.raw?String(value):escapeHtml(value);
  }
  return out;
}

function renderBlocks(source, data) {
  source = source.replace(/\{\{#if\s+([\w.$-]+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_,k,body) => truthy(getPath(data,k)) ? body : '');
  source = source.replace(/\{\{#unless\s+([\w.$-]+)\}\}([\s\S]*?)\{\{\/unless\}\}/g, (_,k,body) => !truthy(getPath(data,k)) ? body : '');
  source = source.replace(/\{\{#each\s+([\w.$-]+)\}\}([\s\S]*?)\{\{\/each\}\}/g, (_,k,body) => {
    const list = getPath(data,k);
    if (!Array.isArray(list)) return '';
    return list.map((item,index) => renderString(body,{...data,this:item,index,item})).join('');
  });
  return source;
}

function renderDirectives(source, data={}) {
  source = source.replace(/<x-if\s+value="([^"]+)"\s*>([\s\S]*?)<\/x-if>/g, (_,k,body)=>truthy(getPath(data,k))?body:'');
  source = source.replace(/<x-unless\s+value="([^"]+)"\s*>([\s\S]*?)<\/x-unless>/g, (_,k,body)=>!truthy(getPath(data,k))?body:'');
  source = source.replace(/<x-permission\s+name="([^"]+)"\s*>([\s\S]*?)<\/x-permission>/g, (_,p,body)=>{
    const perms = [].concat(data.permissions || data.user?.permissions || []);
    return perms.includes(p) ? body : '';
  });
  source = source.replace(/<x-role\s+name="([^"]+)"\s*>([\s\S]*?)<\/x-role>/g, (_,p,body)=>{
    const roles = [].concat(data.roles || data.user?.roles || []);
    return roles.includes(p) ? body : '';
  });
  return source;
}

function renderString(source, data = {}) {
  const out = renderDirectives(renderBlocks(String(source), data), data);
  return interpolate(out,data);
}

function renderFile(file, data, options={}) {
  const source=options.fileCache?.getTextSync?options.fileCache.getTextSync(file,'utf8'):fs.readFileSync(file,'utf8');
  return renderString(source, data);
}

function templateStats(){return {interpolationPlans:interpolationPlans.size,maxPlans:MAX_PLANS}}
function clearTemplatePlans(){interpolationPlans.clear()}

module.exports = { renderString, renderFile, templateStats, clearTemplatePlans };
