'use strict';
const crypto=require('crypto');
const {projectDoc,aggregateDocs}=require('./utils');

function missingDriver(name,pkg){
  const e=new Error(`ORM provider "${name}" requires optional package "${pkg}". Install it in your application; @social-browser/core keeps zero runtime dependencies.`);
  e.code='ORM_DRIVER_MISSING';e.provider=name;e.package=pkg;return e;
}
function safeIdent(value){
  const s=String(value||'');
  if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s))throw Object.assign(new Error(`Unsafe SQL identifier: ${s}`),{code:'ORM_UNSAFE_IDENTIFIER'});
  return s;
}
function whereInput(options={}){
  if(options.where)return options.where;
  const ignore=new Set(['sort','skip','limit','projection','select','fields','multi','set','data','doc','upsert']);
  return Object.fromEntries(Object.entries(options||{}).filter(([k])=>!ignore.has(k)));
}

function safePath(field){
  const parts=String(field||'').split('.');
  if(!parts.length)throw Object.assign(new Error('Empty ORM field path'),{code:'ORM_UNSAFE_IDENTIFIER'});
  for(const p of parts)safeIdent(p);
  return parts;
}
function pathExpr(dialect,field,valueHint){
  if(field==='_id')return '_id';
  const parts=safePath(field);
  let expr;
  if(dialect==='postgres'){
    const pgPath=parts.map(x=>`'${x}'`).join(',');
    expr=`(data #>> ARRAY[${pgPath}])`;
    if(typeof valueHint==='number')expr=`(${expr})::double precision`;
    else if(typeof valueHint==='boolean')expr=`(${expr})::boolean`;
  }else if(dialect==='mysql'){
    const jsonPath='$.'+parts.map(x=>`"${x}"`).join('.');
    expr=`JSON_UNQUOTE(JSON_EXTRACT(data, '${jsonPath}'))`;
    if(typeof valueHint==='number')expr=`CAST(${expr} AS DECIMAL(65,20))`;
  }else{
    const jsonPath='$.'+parts.join('.');
    expr=`json_extract(data, '${jsonPath}')`;
  }
  return expr;
}
function compileWhere(dialect,where={},start=1){
  const params=[];let n=start;
  const ph=()=>dialect==='postgres'?`$${n++}`:'?';
  const compile=(obj)=>{
    const parts=[];
    for(const [field,value] of Object.entries(obj||{})){
      if(field==='$and'||field==='$or'||field==='$nor'){
        const list=[].concat(value||[]).map(compile).filter(Boolean);
        if(list.length){
          const joined='('+list.join(field==='$and'?' AND ':' OR ')+')';
          parts.push(field==='$nor'?`NOT ${joined}`:joined);
        }
        continue;
      }
      if(field==='$not'){
        const inner=compile(value||{});
        if(inner)parts.push(`NOT (${inner})`);
        continue;
      }
      if(field.startsWith('$'))throw Object.assign(new Error(`Unsupported SQL ORM logical operator: ${field}`),{code:'ORM_QUERY_UNSUPPORTED',operator:field});
      if(value && typeof value==='object' && !Array.isArray(value) && !(value instanceof Date)){
        for(const [op,v] of Object.entries(value)){
          const hint=Array.isArray(v)?v.find(x=>x!=null):v;
          const expr=pathExpr(dialect,field,hint);
          if(op==='$not'){
            const inner=compile({[field]:v});
            parts.push(`NOT (${inner})`);
          }else if(op==='$in'||op==='$nin'){
            const list=[].concat(v||[]);if(!list.length){parts.push(op==='$in'?'1=0':'1=1');continue}
            const marks=list.map(()=>ph());params.push(...list);parts.push(`${expr} ${op==='$in'?'IN':'NOT IN'} (${marks.join(',')})`);
          }else if(op==='$exists'){
            parts.push(v?`${expr} IS NOT NULL`:`${expr} IS NULL`);
          }else if(op==='$regex'){
            if(dialect==='sqlite')throw Object.assign(new Error('SQLite REGEXP requires an application-defined function; use $like or register a custom provider'),{code:'ORM_QUERY_UNSUPPORTED',operator:'$regex'});
            const mark=ph();params.push(v instanceof RegExp?v.source:String(v));
            parts.push(dialect==='postgres'?`${expr} ~ ${mark}`:`${expr} REGEXP ${mark}`);
          }else if(op==='$like'){
            const mark=ph();params.push(String(v));parts.push(`${expr} LIKE ${mark}`);
          }else{
            const map={$eq:'=',$ne:'<>',$gt:'>',$gte:'>=',$lt:'<',$lte:'<='};
            if(!map[op])throw Object.assign(new Error(`Unsupported SQL ORM operator: ${op}`),{code:'ORM_QUERY_UNSUPPORTED',operator:op});
            const mark=ph();params.push(v);parts.push(`${expr} ${map[op]} ${mark}`);
          }
        }
      }else if(value===null){
        parts.push(`${pathExpr(dialect,field,value)} IS NULL`);
      }else{
        const mark=ph();params.push(value);parts.push(`${pathExpr(dialect,field,value)} = ${mark}`);
      }
    }
    return parts.length?parts.join(' AND '):'1=1';
  };
  const sql=compile(where);
  return {sql,params,next:n};
}

function sortSql(dialect,sort={}){
  const parts=[];
  for(const [f,d] of Object.entries(sort||{}))parts.push(`${pathExpr(dialect,f)} ${Number(d)<0?'DESC':'ASC'}`);
  return parts.length?` ORDER BY ${parts.join(', ')}`:'';
}
function parseRow(row){
  if(!row)return null;
  let data=row.data;
  if(typeof data==='string'){try{data=JSON.parse(data)}catch{data={}}}
  data={...(data||{})};if(data._id==null)data._id=row._id;return data;
}
function idOf(doc){return String(doc?._id||crypto.randomUUID())}


const SQL_TYPES={
  postgres:{
    string:'TEXT',text:'TEXT',integer:'BIGINT',number:'DOUBLE PRECISION',boolean:'BOOLEAN',
    date:'TIMESTAMPTZ',json:'JSONB',uuid:'UUID'
  },
  mysql:{
    string:'VARCHAR(255)',text:'LONGTEXT',integer:'BIGINT',number:'DOUBLE',boolean:'BOOLEAN',
    date:'DATETIME(3)',json:'JSON',uuid:'CHAR(36)'
  },
  sqlite:{
    string:'TEXT',text:'TEXT',integer:'INTEGER',number:'REAL',boolean:'INTEGER',
    date:'TEXT',json:'TEXT',uuid:'TEXT'
  }
};

function quoteIdent(dialect,name){
  safeIdent(name);
  return dialect==='mysql'?`\`${name}\``:`"${name}"`;
}
function normalizeRelationalSchema(schema={}){
  const columns={};
  for(const [name,defRaw] of Object.entries(schema.columns||schema.properties||{})){
    const def=typeof defRaw==='string'?{type:defRaw}:{...(defRaw||{})};
    columns[name]={
      type:def.type||'string',
      required:!!def.required,
      primary:!!def.primary,
      unique:!!def.unique,
      default:def.default,
      references:def.references||null,
      onDelete:def.onDelete||null,
      onUpdate:def.onUpdate||null,
      index:!!def.index
    };
  }
  return {
    columns,
    primaryKey:schema.primaryKey||Object.entries(columns).find(([,d])=>d.primary)?.[0]||'id',
    indexes:[...(schema.indexes||[])],
    unique:[...(schema.unique||[])],
    version:Number(schema.version||1),
    relations:{...(schema.relations||{})}
  };
}
function sqlType(dialect,type){
  const t=SQL_TYPES[dialect]?.[type];
  if(!t)throw Object.assign(new Error(`Unsupported ${dialect} relational column type: ${type}`),{code:'ORM_SCHEMA_TYPE_UNSUPPORTED',dialect,type});
  return t;
}
function encodeRelationalValue(dialect,type,value){
  if(value==null)return value;
  if(type==='json')return typeof value==='string'?value:JSON.stringify(value);
  if(type==='boolean'&&dialect==='sqlite')return value?1:0;
  if(type==='date'){
    const d=value instanceof Date?value:new Date(value);
    return dialect==='sqlite'?d.toISOString():d;
  }
  return value;
}
function decodeRelationalValue(dialect,type,value){
  if(value==null)return value;
  if(type==='json'&&typeof value==='string'){try{return JSON.parse(value)}catch{return value}}
  if(type==='boolean'&&dialect==='sqlite')return !!value;
  return value;
}
function compileRelationalWhere(dialect,schema,where={},start=1){
  const params=[];let n=start;
  const ph=()=>dialect==='postgres'?`$${n++}`:'?';
  const colExpr=name=>{
    const col=schema.columns[name];
    if(!col)throw Object.assign(new Error(`Unknown relational column: ${name}`),{code:'ORM_SCHEMA_COLUMN_UNKNOWN',column:name});
    return quoteIdent(dialect,name);
  };
  const compile=(obj)=>{
    const parts=[];
    for(const [field,value] of Object.entries(obj||{})){
      if(field==='$and'||field==='$or'||field==='$nor'){
        const list=[].concat(value||[]).map(compile).filter(Boolean);
        if(list.length){
          const joined='('+list.join(field==='$and'?' AND ':' OR ')+')';
          parts.push(field==='$nor'?`NOT ${joined}`:joined);
        }
        continue;
      }
      if(field==='$not'){
        const inner=compile(value||{});
        if(inner)parts.push(`NOT (${inner})`);
        continue;
      }
      const expr=colExpr(field);
      const def=schema.columns[field];
      if(value && typeof value==='object' && !Array.isArray(value) && !(value instanceof Date)){
        for(const [op,v] of Object.entries(value)){
          if(op==='$not'){
            const inner=compile({[field]:v});
            parts.push(`NOT (${inner})`);
          }else if(op==='$in'||op==='$nin'){
            const list=[].concat(v||[]);
            if(!list.length){parts.push(op==='$in'?'1=0':'1=1');continue}
            const marks=list.map(()=>ph());params.push(...list.map(x=>encodeRelationalValue(dialect,def.type,x)));
            parts.push(`${expr} ${op==='$in'?'IN':'NOT IN'} (${marks.join(',')})`);
          }else if(op==='$exists'){
            parts.push(v?`${expr} IS NOT NULL`:`${expr} IS NULL`);
          }else if(op==='$like'){
            const mark=ph();params.push(String(v));parts.push(`${expr} LIKE ${mark}`);
          }else{
            const map={$eq:'=',$ne:'<>',$gt:'>',$gte:'>=',$lt:'<',$lte:'<='};
            if(!map[op])throw Object.assign(new Error(`Unsupported relational ORM operator: ${op}`),{code:'ORM_QUERY_UNSUPPORTED',operator:op});
            const mark=ph();params.push(encodeRelationalValue(dialect,def.type,v));parts.push(`${expr} ${map[op]} ${mark}`);
          }
        }
      }else if(value===null){
        parts.push(`${expr} IS NULL`);
      }else{
        const mark=ph();params.push(encodeRelationalValue(dialect,def.type,value));parts.push(`${expr} = ${mark}`);
      }
    }
    return parts.length?parts.join(' AND '):'1=1';
  };
  return {sql:compile(where),params,next:n};
}
function relationalSortSql(dialect,schema,sort={}){
  const parts=[];
  for(const [f,d] of Object.entries(sort||{})){
    if(!schema.columns[f])throw Object.assign(new Error(`Unknown relational column: ${f}`),{code:'ORM_SCHEMA_COLUMN_UNKNOWN',column:f});
    parts.push(`${quoteIdent(dialect,f)} ${Number(d)<0?'DESC':'ASC'}`);
  }
  return parts.length?` ORDER BY ${parts.join(', ')}`:'';
}
function poolStats(dialect,pool,db){
  if(dialect==='postgres'&&pool)return {
    total:pool.totalCount??null,
    idle:pool.idleCount??null,
    waiting:pool.waitingCount??null
  };
  if(dialect==='mysql'&&pool){
    const core=pool.pool||pool;
    return {
      all:core?._allConnections?.length??null,
      free:core?._freeConnections?.length??null,
      queued:core?._connectionQueue?.length??null
    };
  }
  return {open:!!db};
}

function createRelationalProvider({site,name,options,providerOptions},dialect){
  const schema=normalizeRelationalSchema(options.schema||{});
  if(!Object.keys(schema.columns).length)throw Object.assign(new Error('Relational ORM mode requires schema.columns'),{code:'ORM_SCHEMA_REQUIRED'});
  const table=safeIdent(options.tableName||name);
  const cfg={...(site.options?.database?.[dialect]||{}),...(site.options?.orm?.providers?.[dialect]||{}),...providerOptions};
  let driver,pool,db;
  const qTable=quoteIdent(dialect,table);
  const cfgKey={...cfg};delete cfgKey.pool;delete cfgKey.db;
  const resourceKey=`${dialect}:relational:`+JSON.stringify(cfgKey);

  if(dialect==='postgres'){
    try{driver=require('pg')}catch(e){if(e?.code==='MODULE_NOT_FOUND')throw missingDriver('postgres','pg');throw e}
    pool=site.orm.resource(resourceKey,()=>cfg.pool||new driver.Pool(cfg));
  }else if(dialect==='mysql'){
    try{driver=require('mysql2/promise')}catch(e){if(e?.code==='MODULE_NOT_FOUND')throw missingDriver('mysql','mysql2');throw e}
    pool=site.orm.resource(resourceKey,()=>cfg.pool||driver.createPool(cfg));
  }else{
    try{driver=require('better-sqlite3')}catch(e){if(e?.code==='MODULE_NOT_FOUND')throw missingDriver('sqlite','better-sqlite3');throw e}
    db=site.orm.resource(resourceKey,()=>cfg.db||new driver(cfg.filename||cfg.file||':memory:',cfg.options||{}));
  }

  const execute=async(sql,params=[])=>{
    if(dialect==='postgres'){const r=await pool.query(sql,params);return {rows:r.rows,rowCount:r.rowCount}}
    if(dialect==='mysql'){const [rows,meta]=await pool.execute(sql,params);return {rows:Array.isArray(rows)?rows:[],rowCount:meta?.affectedRows??rows?.affectedRows??0,meta:rows}}
    const stmt=db.prepare(sql);
    if(/^\s*(select|pragma)/i.test(sql)){const rows=stmt.all(...params);return {rows,rowCount:rows.length}}
    const info=stmt.run(...params);return {rows:[],rowCount:info.changes,meta:info};
  };

  const columnSql=[];
  const fkSql=[];
  for(const [colName,def] of Object.entries(schema.columns)){
    let part=`${quoteIdent(dialect,colName)} ${sqlType(dialect,def.type)}`;
    if(def.primary)part+=' PRIMARY KEY';
    if(def.required)part+=' NOT NULL';
    if(def.unique)part+=' UNIQUE';
    if(def.default!==undefined){
      if(typeof def.default==='number')part+=` DEFAULT ${def.default}`;
      else if(typeof def.default==='boolean')part+=` DEFAULT ${def.default?(dialect==='sqlite'?1:'TRUE'):(dialect==='sqlite'?0:'FALSE')}`;
      else if(def.default===null)part+=' DEFAULT NULL';
      else part+=` DEFAULT '${String(def.default).replace(/'/g,"''")}'`;
    }
    columnSql.push(part);
    if(def.references){
      const refTable=quoteIdent(dialect,def.references.table);
      const refCol=quoteIdent(dialect,def.references.column||'id');
      let fk=`FOREIGN KEY (${quoteIdent(dialect,colName)}) REFERENCES ${refTable} (${refCol})`;
      if(def.onDelete)fk+=` ON DELETE ${String(def.onDelete).toUpperCase()}`;
      if(def.onUpdate)fk+=` ON UPDATE ${String(def.onUpdate).toUpperCase()}`;
      fkSql.push(fk);
    }
  }
  const createSql=`CREATE TABLE IF NOT EXISTS ${qTable} (${[...columnSql,...fkSql].join(', ')})`;


const metaTable=quoteIdent(dialect,'__sb_orm_migrations');
const ensureMigrationTable=async()=>{
  await execute(`CREATE TABLE IF NOT EXISTS ${metaTable} (model_name ${dialect==='mysql'?'VARCHAR(191)':'TEXT'} PRIMARY KEY, version INTEGER NOT NULL)`);
};
const getVersion=async()=>{
  await ensureMigrationTable();
  const mark=dialect==='postgres'?'$1':'?';
  const r=await execute(`SELECT version FROM ${metaTable} WHERE model_name=${mark}`,[name]);
  return Number(r.rows[0]?.version||0);
};
const setVersion=async(version)=>{
  await ensureMigrationTable();
  if(dialect==='postgres'){
    await execute(`INSERT INTO ${metaTable}(model_name,version) VALUES ($1,$2) ON CONFLICT(model_name) DO UPDATE SET version=EXCLUDED.version`,[name,version]);
  }else if(dialect==='mysql'){
    await execute(`INSERT INTO ${metaTable}(model_name,version) VALUES (?,?) ON DUPLICATE KEY UPDATE version=VALUES(version)`,[name,version]);
  }else{
    await execute(`INSERT INTO ${metaTable}(model_name,version) VALUES (?,?) ON CONFLICT(model_name) DO UPDATE SET version=excluded.version`,[name,version]);
  }
};

const migrate=async(opts={})=>{
  await ensureMigrationTable();
  let current=await getVersion();
  const migrations=[...(opts.migrations||options.migrations||[])].sort((a,b)=>Number(a.version)-Number(b.version));
  const direction=opts.direction||'up';
  if(direction==='down'){
    const target=opts.target==null?Math.max(0,current-1):Number(opts.target);
    for(const m of [...migrations].sort((a,b)=>Number(b.version)-Number(a.version))){
      const v=Number(m.version||0);
      if(v>current||v<=target)continue;
      if(typeof m.down==='function')await m.down({execute,dialect,table:qTable,schema,from:current,to:target});
      else if(Array.isArray(m.downSql)){for(const sql of m.downSql)await execute(sql)}
      else if(typeof m.downSql==='string')await execute(m.downSql);
      else throw Object.assign(new Error(`Migration ${v} has no down/downSql`),{code:'ORM_MIGRATION_DOWN_MISSING',version:v});
      const previous=[...migrations].filter(x=>Number(x.version)<v).map(x=>Number(x.version)).sort((a,b)=>b-a)[0]||0;
      current=Math.max(target,previous);
      await setVersion(current);
    }
    return {version:current,direction:'down'};
  }

  const target=opts.target==null?Infinity:Number(opts.target);
  for(const m of migrations){
    const v=Number(m.version||0);
    if(v<=current||v>target)continue;
    if(typeof m.up==='function')await m.up({execute,dialect,table:qTable,schema,from:current,to:v});
    else if(Array.isArray(m.sql)){for(const sql of m.sql)await execute(sql)}
    else if(typeof m.sql==='string')await execute(m.sql);
    else throw Object.assign(new Error(`Migration ${v} has no up/sql`),{code:'ORM_MIGRATION_INVALID',version:v});
    await setVersion(v);current=v;
  }
  if(current<schema.version&&schema.version<=target&&!migrations.some(m=>Number(m.version)===schema.version)){
    await setVersion(schema.version);current=schema.version;
  }
  return {version:current,direction:'up'};
};


  const readyPromise=(async()=>{
    await execute(createSql);
    for(const [colName,def] of Object.entries(schema.columns)){
      if(def.index&&!def.unique){
        const idx=safeIdent(`idx_${table}_${colName}`);
        await execute(`CREATE INDEX IF NOT EXISTS ${quoteIdent(dialect,idx)} ON ${qTable} (${quoteIdent(dialect,colName)})`);
      }
    }
    for(const idxRaw of schema.indexes){
      const idx=typeof idxRaw==='string'?{fields:[idxRaw]}:idxRaw;
      const fields=[].concat(idx.fields||[]);for(const f of fields)if(!schema.columns[f])throw Object.assign(new Error(`Unknown relational index column: ${f}`),{code:'ORM_SCHEMA_COLUMN_UNKNOWN',column:f});
      const idxName=safeIdent(idx.name||`idx_${table}_${fields.join('_')}`);
      await execute(`CREATE ${idx.unique?'UNIQUE ':''}INDEX IF NOT EXISTS ${quoteIdent(dialect,idxName)} ON ${qTable} (${fields.map(f=>quoteIdent(dialect,f)).join(', ')})`);
    }
    await migrate();
    return true;
  })();
  const ready=()=>readyPromise;

  const encodeDoc=doc=>{
    const out={};
    for(const [name,def] of Object.entries(schema.columns)){
      if(doc[name]!==undefined)out[name]=encodeRelationalValue(dialect,def.type,doc[name]);
    }
    return out;
  };
  const decodeRow=row=>{
    if(!row)return null;
    const out={};
    for(const [name,def] of Object.entries(schema.columns)){
      if(Object.prototype.hasOwnProperty.call(row,name))
        out[name]=decodeRelationalValue(dialect,def.type,row[name]);
    }
    return out;
  };

  const select=async(options={})=>{
    await ready();
    const projection=options.projection?Object.entries(options.projection).filter(([,v])=>v).map(([k])=>k):null;
    const fields=(projection?.length?projection:Object.keys(schema.columns)).map(f=>{
      if(!schema.columns[f])throw Object.assign(new Error(`Unknown relational projection column: ${f}`),{code:'ORM_SCHEMA_COLUMN_UNKNOWN',column:f});
      return quoteIdent(dialect,f);
    }).join(', ');
    const w=compileRelationalWhere(dialect,schema,whereInput(options));
    let sql=`SELECT ${fields} FROM ${qTable} WHERE ${w.sql}${relationalSortSql(dialect,schema,options.sort)}`;
    const params=[...w.params];
    if(options.limit!=null){
      if(dialect==='postgres'){sql+=` LIMIT $${params.length+1}`;params.push(Number(options.limit))}
      else {sql+=' LIMIT ?';params.push(Number(options.limit))}
    }
    if(options.skip){
      if(options.limit==null)sql+=dialect==='mysql'?' LIMIT 18446744073709551615':dialect==='sqlite'?' LIMIT -1':' LIMIT ALL';
      if(dialect==='postgres'){sql+=` OFFSET $${params.length+1}`;params.push(Number(options.skip))}
      else {sql+=' OFFSET ?';params.push(Number(options.skip))}
    }
    const r=await execute(sql,params);return r.rows.map(decodeRow);
  };

  const add=async doc=>{
    await ready();const value={...(doc||{})};
    const encoded=encodeDoc(value);
    const names=Object.keys(encoded);
    if(!names.length)throw Object.assign(new Error('No schema columns supplied for insert'),{code:'ORM_EMPTY_INSERT'});
    const cols=names.map(n=>quoteIdent(dialect,n)).join(', ');
    const params=names.map(n=>encoded[n]);
    const marks=names.map((_,i)=>dialect==='postgres'?`$${i+1}`:'?').join(', ');
    let sql=`INSERT INTO ${qTable} (${cols}) VALUES (${marks})`;
    if(dialect==='postgres')sql+=` RETURNING *`;
    const r=await execute(sql,params);
    if(dialect==='postgres'&&r.rows[0])return decodeRow(r.rows[0]);
    return value;
  };

  const update=async o=>{
    await ready();const patch=o?.set||o?.data||o?.doc||{};
    const encoded=encodeDoc(patch),fields=Object.keys(encoded);
    if(!fields.length)return {matchedCount:0,modifiedCount:0};
    const w=compileRelationalWhere(dialect,schema,whereInput(o||{}),fields.length+1);
    const params=fields.map(f=>encoded[f]);
    const sets=fields.map((f,i)=>`${quoteIdent(dialect,f)}=${dialect==='postgres'?`$${i+1}`:'?'}`);
    let sql=`UPDATE ${qTable} SET ${sets.join(', ')} WHERE ${w.sql}`;
    params.push(...w.params);
    if(!o?.multi){
      const pk=schema.primaryKey;
      const one=await select({...o,projection:{[pk]:1},limit:1});
      if(!one[0])return {matchedCount:0,modifiedCount:0};
      const pkWhere=compileRelationalWhere(dialect,schema,{[pk]:one[0][pk]},fields.length+1);
      sql=`UPDATE ${qTable} SET ${sets.join(', ')} WHERE ${pkWhere.sql}`;
      params.splice(fields.length,params.length-fields.length,...pkWhere.params);
    }
    const r=await execute(sql,params);return {matchedCount:r.rowCount||0,modifiedCount:r.rowCount||0};
  };

  const del=async o=>{
    await ready();
    if(!o?.multi){
      const pk=schema.primaryKey;
      const one=await select({...o,projection:{[pk]:1},limit:1});
      if(!one[0])return {count:0,deletedCount:0};
      const w=compileRelationalWhere(dialect,schema,{[pk]:one[0][pk]});
      const r=await execute(`DELETE FROM ${qTable} WHERE ${w.sql}`,w.params);
      return {count:r.rowCount||0,deletedCount:r.rowCount||0};
    }
    const w=compileRelationalWhere(dialect,schema,whereInput(o||{}));
    const r=await execute(`DELETE FROM ${qTable} WHERE ${w.sql}`,w.params);
    return {count:r.rowCount||0,deletedCount:r.rowCount||0};
  };

  const createIndex=async(fields,opts={})=>{
    await ready();const list=[].concat(fields||[]);
    for(const f of list)if(!schema.columns[f])throw Object.assign(new Error(`Unknown relational index column: ${f}`),{code:'ORM_SCHEMA_COLUMN_UNKNOWN',column:f});
    const idxName=safeIdent(opts.name||`idx_${table}_${list.join('_')}`);
    await execute(`CREATE ${opts.unique?'UNIQUE ':''}INDEX IF NOT EXISTS ${quoteIdent(dialect,idxName)} ON ${qTable} (${list.map(f=>quoteIdent(dialect,f)).join(', ')})`);
    return idxName;
  };


const include=async(rows,relations,includeOptions={})=>{
  const requested=Array.isArray(relations)?relations:Object.keys(relations||{});
  const out=(rows||[]).map(x=>({...x}));
  for(const relName of requested){
    const rel=schema.relations[relName];
    if(!rel)throw Object.assign(new Error(`Unknown relation: ${relName}`),{code:'ORM_RELATION_NOT_FOUND',relation:relName});
    const targetName=rel.model||rel.collection;
    const targetDef=site.getModel?.(targetName)||{};
    const target=site.connectCollection(targetName,{
      ...targetDef,
      provider:rel.provider||targetDef.provider||options.provider||dialect,
      mode:rel.mode||targetDef.mode||'relational',
      schema:rel.schema||targetDef.schema||includeOptions.schemas?.[targetName],
      providerOptions:{...(targetDef.providerOptions||{}),...providerOptions}
    });
    if(rel.type==='belongsTo'){
      const localKey=rel.localKey||`${relName}Id`,foreignKey=rel.foreignKey||'id';
      for(const row of out)row[relName]=await target.findOne({where:{[foreignKey]:row[localKey]}});
    }else if(rel.type==='hasMany'){
      const localKey=rel.localKey||schema.primaryKey,foreignKey=rel.foreignKey||`${name}Id`;
      for(const row of out)row[relName]=await target.findMany({where:{[foreignKey]:row[localKey]}});
    }else if(rel.type==='hasOne'){
      const localKey=rel.localKey||schema.primaryKey,foreignKey=rel.foreignKey||`${name}Id`;
      for(const row of out)row[relName]=await target.findOne({where:{[foreignKey]:row[localKey]}});
    }else{
      throw Object.assign(new Error(`Unsupported relation type: ${rel.type}`),{code:'ORM_RELATION_TYPE_UNSUPPORTED',relation:relName});
    }
  }
  return out;
};

  return {
    mode:'relational',
    schema,
    ready,
    migrate,
    migrationVersion:getVersion,
    relations:()=>schema.relations,
    include,
    findMany:select,
    findOne:async o=>(await select({...o,limit:1}))[0]||null,
    add,
    insertMany:async docs=>{const out=[];for(const d of docs||[])out.push(await add(d));return out},
    update,
    updateOne:o=>update({...o,multi:false}),
    updateMany:o=>update({...o,multi:true}),
    delete:del,
    deleteOne:o=>del({...o,multi:false}),
    deleteMany:o=>del({...o,multi:true}),
    count:async o=>{await ready();const w=compileRelationalWhere(dialect,schema,whereInput(o||{}));const r=await execute(`SELECT COUNT(*) AS n FROM ${qTable} WHERE ${w.sql}`,w.params);return Number(r.rows[0]?.n||0)},
    distinct:async(field,o={})=>{await ready();if(!schema.columns[field])throw Object.assign(new Error(`Unknown relational column: ${field}`),{code:'ORM_SCHEMA_COLUMN_UNKNOWN',column:field});const w=compileRelationalWhere(dialect,schema,whereInput(o));const r=await execute(`SELECT DISTINCT ${quoteIdent(dialect,field)} AS v FROM ${qTable} WHERE ${w.sql}`,w.params);return r.rows.map(x=>decodeRelationalValue(dialect,schema.columns[field].type,x.v))},
    aggregate:async pipeline=>aggregateDocs(await select({}),pipeline||[]),
    createIndex,
    dropIndex:async name=>{await ready();safeIdent(name);if(dialect==='mysql')return execute(`DROP INDEX ${quoteIdent(dialect,name)} ON ${qTable}`);return execute(`DROP INDEX IF EXISTS ${quoteIdent(dialect,name)}`)},
    listIndexes:async()=>[],
    transaction:async fn=>{
      await ready();
      if(dialect==='sqlite'){
        db.exec('BEGIN');
        try{
          const result=await fn({db,execute,table:qTable,schema});
          db.exec('COMMIT');
          return result;
        }catch(e){
          try{db.exec('ROLLBACK')}catch{}
          throw e;
        }
      }
      const conn=dialect==='postgres'?await pool.connect():await pool.getConnection();
      try{
        if(dialect==='postgres')await conn.query('BEGIN');else await conn.beginTransaction();
        const txExec=async(sql,params=[])=>dialect==='postgres'?(()=>conn.query(sql,params).then(r=>({rows:r.rows,rowCount:r.rowCount})))():(()=>conn.execute(sql,params).then(([rows,meta])=>({rows:Array.isArray(rows)?rows:[],rowCount:meta?.affectedRows??rows?.affectedRows??0})))();
        const result=await fn({connection:conn,execute:txExec,table:qTable,schema});
        if(dialect==='postgres')await conn.query('COMMIT');else await conn.commit();
        return result;
      }catch(e){
        if(dialect==='postgres')await conn.query('ROLLBACK');else await conn.rollback();
        throw e;
      }finally{conn.release?.()}
    },
    health:async()=>{await ready();await execute('SELECT 1 AS ok');return {provider:dialect,status:'UP',ok:true,pool:poolStats(dialect,pool,db)}},
    stats:()=>({provider:dialect,mode:'relational',name,table,schema,pool:poolStats(dialect,pool,db)}),
    ObjectId:v=>v
  };
}

function createSqlDocumentProvider(args,dialect){
  const {site,name,options,providerOptions}=args;
  if(options.mode==='relational'||options.relational===true||options.schemaMode==='relational')return createRelationalProvider(args,dialect);
  const table=safeIdent(options.tableName||name);
  const cfg={...(site.options?.database?.[dialect]||{}),...(site.options?.orm?.providers?.[dialect]||{}),...providerOptions};
  let driver,pool,db;
  const qIdent=dialect==='mysql'?`\`${table}\``:`"${table}"`;
  const cfgKey={...cfg};delete cfgKey.pool;delete cfgKey.db;
  const resourceKey=`${dialect}:`+JSON.stringify(cfgKey);

  if(dialect==='postgres'){
    try{driver=require('pg')}catch(e){if(e?.code==='MODULE_NOT_FOUND')throw missingDriver('postgres','pg');throw e}
    pool=site.orm.resource(resourceKey,()=>cfg.pool||new driver.Pool(cfg));
  }else if(dialect==='mysql'){
    try{driver=require('mysql2/promise')}catch(e){if(e?.code==='MODULE_NOT_FOUND')throw missingDriver('mysql','mysql2');throw e}
    pool=site.orm.resource(resourceKey,()=>cfg.pool||driver.createPool(cfg));
  }else{
    try{driver=require('better-sqlite3')}catch(e){if(e?.code==='MODULE_NOT_FOUND')throw missingDriver('sqlite','better-sqlite3');throw e}
    db=site.orm.resource(resourceKey,()=>cfg.db||new driver(cfg.filename||cfg.file||':memory:',cfg.options||{}));
  }

  const execute=async(sql,params=[])=>{
    if(dialect==='postgres'){const r=await pool.query(sql,params);return {rows:r.rows,rowCount:r.rowCount}}
    if(dialect==='mysql'){const [rows,meta]=await pool.execute(sql,params);return {rows:Array.isArray(rows)?rows:[],rowCount:meta?.affectedRows??rows?.affectedRows??0,meta:rows}}
    const stmt=db.prepare(sql);
    if(/^\s*select/i.test(sql)){const rows=stmt.all(...params);return {rows,rowCount:rows.length}}
    const info=stmt.run(...params);return {rows:[],rowCount:info.changes,meta:info};
  };

  const readyPromise=(async()=>{
    if(dialect==='postgres')await execute(`CREATE TABLE IF NOT EXISTS ${qIdent} (_id TEXT PRIMARY KEY, data JSONB NOT NULL)`);
    else if(dialect==='mysql')await execute(`CREATE TABLE IF NOT EXISTS ${qIdent} (_id VARCHAR(191) PRIMARY KEY, data JSON NOT NULL)`);
    else await execute(`CREATE TABLE IF NOT EXISTS ${qIdent} (_id TEXT PRIMARY KEY, data TEXT NOT NULL)`);
    return true;
  })();
  const ready=()=>readyPromise;

  const jsonValue=doc=>JSON.stringify(doc);
  const select=async(options={})=>{
    await ready();
    const w=compileWhere(dialect,whereInput(options));
    let sql=`SELECT _id,data FROM ${qIdent} WHERE ${w.sql}${sortSql(dialect,options.sort)}`;
    const params=[...w.params];
    if(options.limit!=null){
      if(dialect==='postgres'){sql+=` LIMIT $${params.length+1}`;params.push(Number(options.limit))}
      else {sql+=' LIMIT ?';params.push(Number(options.limit))}
    }
    if(options.skip){
      if(options.limit==null)sql+=dialect==='mysql'?' LIMIT 18446744073709551615':dialect==='sqlite'?' LIMIT -1':' LIMIT ALL';
      if(dialect==='postgres'){sql+=` OFFSET $${params.length+1}`;params.push(Number(options.skip))}
      else {sql+=' OFFSET ?';params.push(Number(options.skip))}
    }
    const r=await execute(sql,params);let rows=r.rows.map(parseRow);if(options.projection)rows=rows.map(x=>projectDoc(x,options.projection));return rows;
  };

  const add=async doc=>{
    await ready();const value={...(doc||{})},id=idOf(value);value._id=id;const data=jsonValue(value);
    if(dialect==='postgres')await execute(`INSERT INTO ${qIdent} (_id,data) VALUES ($1,$2::jsonb)`,[id,data]);
    else await execute(`INSERT INTO ${qIdent} (_id,data) VALUES (?,?)`,[id,data]);
    return value;
  };

  const update=async o=>{
    const rows=await select({...o,limit:o?.multi?undefined:1});
    let count=0;const patch=o?.set||o?.data||o?.doc||{};
    for(const row of rows){
      const next={...row,...patch,_id:row._id},data=jsonValue(next);
      const r=dialect==='postgres'?await execute(`UPDATE ${qIdent} SET data=$1::jsonb WHERE _id=$2`,[data,String(row._id)]):await execute(`UPDATE ${qIdent} SET data=? WHERE _id=?`,[data,String(row._id)]);
      count+=r.rowCount||0;
    }
    return {matchedCount:rows.length,modifiedCount:count};
  };
  const del=async o=>{
    await ready();const w=compileWhere(dialect,whereInput(o||{}));
    let sql=`DELETE FROM ${qIdent} WHERE ${w.sql}`,params=[...w.params];
    if(!o?.multi){
      const one=await select({...o,limit:1});if(!one[0])return {count:0,deletedCount:0};
      sql=dialect==='postgres'?`DELETE FROM ${qIdent} WHERE _id=$1`:`DELETE FROM ${qIdent} WHERE _id=?`;params=[String(one[0]._id)];
    }
    const r=await execute(sql,params);return {count:r.rowCount||0,deletedCount:r.rowCount||0};
  };

  return {
    ready,
    findMany:select,
    findOne:async o=>(await select({...o,limit:1}))[0]||null,
    add,
    insertMany:async docs=>{const out=[];for(const d of docs||[])out.push(await add(d));return out},
    update,
    updateOne:o=>update({...o,multi:false}),
    updateMany:o=>update({...o,multi:true}),
    delete:del,
    deleteOne:o=>del({...o,multi:false}),
    deleteMany:o=>del({...o,multi:true}),
    count:async o=>{await ready();const w=compileWhere(dialect,whereInput(o||{}));const r=await execute(`SELECT COUNT(*) AS n FROM ${qIdent} WHERE ${w.sql}`,w.params);return Number(r.rows[0]?.n||0)},
    distinct:async(field,o={})=>{await ready();const w=compileWhere(dialect,whereInput(o));const expr=pathExpr(dialect,field);const r=await execute(`SELECT DISTINCT ${expr} AS v FROM ${qIdent} WHERE ${w.sql}`,w.params);return r.rows.map(x=>x.v)},
    aggregate:async pipeline=>{
      const rows=await select({});
      return aggregateDocs(rows,pipeline||[]);
    },
    transaction:async fn=>{
      await ready();
      if(dialect==='sqlite'){
        db.exec('BEGIN');
        try{
          const result=await fn({db,execute});
          db.exec('COMMIT');
          return result;
        }catch(e){
          try{db.exec('ROLLBACK')}catch{}
          throw e;
        }
      }
      const conn=dialect==='postgres'?await pool.connect():await pool.getConnection();
      try{
        if(dialect==='postgres')await conn.query('BEGIN');else await conn.beginTransaction();
        const txExec=async(sql,params=[])=>dialect==='postgres'?(()=>conn.query(sql,params).then(r=>({rows:r.rows,rowCount:r.rowCount})))():(()=>conn.execute(sql,params).then(([rows,meta])=>({rows:Array.isArray(rows)?rows:[],rowCount:meta?.affectedRows??rows?.affectedRows??0})))();
        const result=await fn({connection:conn,execute:txExec});
        if(dialect==='postgres')await conn.query('COMMIT');else await conn.commit();
        return result;
      }catch(e){
        if(dialect==='postgres')await conn.query('ROLLBACK');else await conn.rollback();
        throw e;
      }finally{conn.release?.()}
    },
    health:async()=>{await ready();await execute('SELECT 1 AS ok');return {provider:dialect,status:'UP',ok:true,pool:poolStats(dialect,pool,db)}},
    stats:()=>({provider:dialect,name,table,pool:poolStats(dialect,pool,db)}),
    ObjectId:v=>v||crypto.randomUUID()
  };
}
const createPostgresProvider=args=>createSqlDocumentProvider(args,'postgres');
const createMysqlProvider=args=>createSqlDocumentProvider(args,'mysql');
const createSqliteProvider=args=>createSqlDocumentProvider(args,'sqlite');
module.exports={createSqlDocumentProvider,createRelationalProvider,createPostgresProvider,createMysqlProvider,createSqliteProvider,compileWhere,compileRelationalWhere,normalizeRelationalSchema,sortSql,safeIdent,whereInput};
