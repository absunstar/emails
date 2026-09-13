'use strict';
class FeatureRegistry {
  constructor(){ this.map=new Map(); }
  set(name,value=true){ this.map.set(String(name),value); return value; }
  get(name,fallback){ return this.map.has(String(name))?this.map.get(String(name)):fallback; }
  enable(name){ this.map.set(String(name),true); return true; }
  disable(name){ this.map.set(String(name),false); return false; }
  isEnabled(name){ return this.map.get(String(name))===true; }
  clear(name){ if(name===undefined)this.map.clear(); else this.map.delete(String(name)); return true; }
  list(){ return [...this.map.entries()].map(([name,value])=>({name,value})); }
}
module.exports={FeatureRegistry};
