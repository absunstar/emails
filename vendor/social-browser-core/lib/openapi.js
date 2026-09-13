'use strict';

function validateSchema(value,schema={},path='$'){
  const errors=[];
  if(!schema||typeof schema!=='object')return errors;
  const type=schema.type;
  const actual=Array.isArray(value)?'array':value===null?'null':typeof value;
  if(type){
    const ok=type==='integer'?Number.isInteger(value):
      type==='number'?typeof value==='number'&&Number.isFinite(value):
      type==='object'?value&&typeof value==='object'&&!Array.isArray(value):
      type==='array'?Array.isArray(value):
      actual===type;
    if(!ok)errors.push({path,message:`expected ${type}, got ${actual}`});
  }
  if(schema.enum&&!schema.enum.includes(value))errors.push({path,message:'value not in enum'});
  if(typeof value==='string'){
    if(schema.minLength!=null&&value.length<schema.minLength)errors.push({path,message:`minLength ${schema.minLength}`});
    if(schema.maxLength!=null&&value.length>schema.maxLength)errors.push({path,message:`maxLength ${schema.maxLength}`});
    if(schema.pattern){try{if(!new RegExp(schema.pattern).test(value))errors.push({path,message:'pattern mismatch'})}catch{}}
  }
  if(typeof value==='number'){
    if(schema.minimum!=null&&value<schema.minimum)errors.push({path,message:`minimum ${schema.minimum}`});
    if(schema.maximum!=null&&value>schema.maximum)errors.push({path,message:`maximum ${schema.maximum}`});
  }
  if(Array.isArray(value)){
    if(schema.minItems!=null&&value.length<schema.minItems)errors.push({path,message:`minItems ${schema.minItems}`});
    if(schema.maxItems!=null&&value.length>schema.maxItems)errors.push({path,message:`maxItems ${schema.maxItems}`});
    if(schema.items)value.forEach((x,i)=>errors.push(...validateSchema(x,schema.items,`${path}[${i}]`)));
  }
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    for(const req of schema.required||[])if(!(req in value))errors.push({path:`${path}.${req}`,message:'required'});
    for(const [k,sub] of Object.entries(schema.properties||{}))if(k in value)errors.push(...validateSchema(value[k],sub,`${path}.${k}`));
    if(schema.additionalProperties===false){
      const allowed=new Set(Object.keys(schema.properties||{}));
      for(const k of Object.keys(value))if(!allowed.has(k))errors.push({path:`${path}.${k}`,message:'additional property not allowed'});
    }
  }
  return errors;
}

class OpenApiRegistry{
  constructor(site,options={}){
    this.site=site;this.options=options;this.paths={};this.components={schemas:{},securitySchemes:{}};
  }
  schema(name,schema){this.components.schemas[name]=schema;return schema}
  securityScheme(name,schema){this.components.securitySchemes[name]=schema;return schema}
  route(method,path,meta={}){
    const m=String(method).toLowerCase();this.paths[path]=this.paths[path]||{};
    this.paths[path][m]={
      summary:meta.summary,description:meta.description,tags:meta.tags,
      operationId:meta.operationId,
      parameters:meta.parameters||[],
      requestBody:meta.body?{required:meta.bodyRequired!==false,content:{'application/json':{schema:meta.body}}}:undefined,
      responses:meta.responses||{'200':{description:'Success'}},
      security:meta.security
    };
    return this.paths[path][m];
  }
  document(extra={}){
    return {
      openapi:'3.1.0',
      info:{title:this.options.title||'Social Browser Core API',version:this.site.version,...(this.options.info||{})},
      paths:this.paths,
      components:this.components,
      ...extra
    };
  }
  validate(value,schema){const errors=validateSchema(value,schema);return {ok:errors.length===0,errors}}
}

module.exports={OpenApiRegistry,validateSchema};
