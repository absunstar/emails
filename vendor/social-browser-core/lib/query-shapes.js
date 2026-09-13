'use strict';

function shapeOf(value){
  if(value===null)return 'null';
  if(Array.isArray(value))return value.map(shapeOf);
  if(typeof value!=='object')return typeof value;
  return Object.fromEntries(Object.keys(value).sort().map(k=>[k,shapeOf(value[k])]));
}

class QueryShapes {
  constructor(){this.rows=new Map()}
  signature(query={}){
    return JSON.stringify(shapeOf(query));
  }
  observe(query={},meta={}){
    const sig=this.signature(query);
    const row=this.rows.get(sig)||{signature:sig,count:0,example:query,lastMeta:null};
    row.count++;row.lastMeta=meta;row.lastSeen=Date.now();
    this.rows.set(sig,row);
    return row;
  }
  report(limit=100){
    return [...this.rows.values()].sort((a,b)=>b.count-a.count).slice(0,limit);
  }
  clear(){this.rows.clear()}
}
module.exports={QueryShapes,shapeOf};
