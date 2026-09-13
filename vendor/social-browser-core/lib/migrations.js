'use strict';

class MigrationManager {
  constructor(site){this.site=site;this.registry=new Map()}
  _key(provider,name){return `${String(provider||'core').toLowerCase()}:${String(name)}`}
  create(name,definition={}){
    const provider=String(definition.provider||this.site.orm.defaultProvider||'core').toLowerCase();
    const row={
      name:String(name),provider,
      migrations:[...(definition.migrations||[])].map(x=>({...x,version:Number(x.version)})).sort((a,b)=>a.version-b.version),
      collectionOptions:{...(definition.collectionOptions||{})}
    };
    this.registry.set(this._key(provider,name),row);
    return row;
  }
  register(name,definition={}){return this.create(name,definition)}
  get(name,provider){return this.registry.get(this._key(provider||this.site.orm.defaultProvider,name))||null}
  list(){return [...this.registry.values()].map(x=>({...x,migrations:[...x.migrations]}))}
  async _collection(row){
    const col=this.site.connectCollection(row.name,{provider:row.provider,...row.collectionOptions,migrations:row.migrations});
    await col.ready();
    return col;
  }
  async status(name,provider){
    const row=this.get(name,provider);
    if(!row)throw Object.assign(new Error(`Migration set not found: ${name}`),{code:'ORM_MIGRATION_SET_NOT_FOUND'});
    const col=await this._collection(row);
    const current=typeof col.migrationVersion==='function'?await col.migrationVersion():null;
    return {name:row.name,provider:row.provider,current,pending:current==null?row.migrations.map(x=>x.version):row.migrations.filter(x=>x.version>current).map(x=>x.version)};
  }
  async up(name,provider,options={}){
    const row=this.get(name,provider);
    if(!row)throw Object.assign(new Error(`Migration set not found: ${name}`),{code:'ORM_MIGRATION_SET_NOT_FOUND'});
    const col=await this._collection(row);
    return col.migrate({direction:'up',target:options.target,migrations:row.migrations});
  }
  async down(name,provider,options={}){
    const row=this.get(name,provider);
    if(!row)throw Object.assign(new Error(`Migration set not found: ${name}`),{code:'ORM_MIGRATION_SET_NOT_FOUND'});
    const col=await this._collection(row);
    return col.migrate({direction:'down',target:options.target,migrations:row.migrations});
  }
  async upAll(options={}){
    const out=[];for(const row of this.registry.values())out.push(await this.up(row.name,row.provider,options));return out;
  }
}

function diffSchemas(current={},next={}){
  const a=current.columns||current.properties||{},b=next.columns||next.properties||{};
  const added=[],removed=[],changed=[];
  for(const [name,def] of Object.entries(b)){
    if(!(name in a))added.push({name,definition:def});
    else if(JSON.stringify(a[name])!==JSON.stringify(def))changed.push({name,from:a[name],to:def});
  }
  for(const [name,def] of Object.entries(a))if(!(name in b))removed.push({name,definition:def});
  return {added,removed,changed,changedAny:!!(added.length||removed.length||changed.length)};
}
module.exports={MigrationManager,diffSchemas};
