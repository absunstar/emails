'use strict';

function normalizeList(v){return v==null?[]:Array.isArray(v)?v:[v]}
function valueName(v){return v&&typeof v==='object'?(v.name??v.id??v.key):v}
function normalizeNames(v){return normalizeList(v).map(valueName).filter(x=>x!=null).map(String)}
function stableSignature(values){return normalizeNames(values).sort().join('\u0000')}

function createSecurity(options={}){
  const userIndexes={id:new Map(),_id:new Map(),email:new Map(),username:new Map(),mobile:new Map(),key:new Map()};
  const roleByName=new Map(),permissionByName=new Map();
  const ruleCache=new Map();
  const permissionCache=new WeakMap();
  let version=1;

  const api={
    $users:Object.create(null),roles:Object.create(null),permissions:new Set(),keys:new Map(),busy:false,
    userIndexes,roleByName,permissionByName,ruleCache,
    _fingerDateCache:new Map(),_getFingerDate:()=>new Date(),

    _bump(){version++;ruleCache.clear();return version},
    _indexUser(user){
      if(!user)return user;
      if(user.id!=null)userIndexes.id.set(String(user.id),user);
      if(user._id!=null)userIndexes._id.set(String(user._id),user);
      if(user.email)userIndexes.email.set(String(user.email).trim().toLowerCase(),user);
      if(user.username)userIndexes.username.set(String(user.username).trim().toLowerCase(),user);
      if(user.mobile)userIndexes.mobile.set(String(user.mobile).trim().toLowerCase(),user);
      if(user.key)userIndexes.key.set(String(user.key),user);
      return user;
    },
    rebuildUserIndexes(){for(const m of Object.values(userIndexes))m.clear();for(const u of Object.values(api.$users))api._indexUser(u);return userIndexes},
    rebuildRoleIndexes(){
      roleByName.clear();permissionByName.clear();
      for(const [name,role] of Object.entries(api.roles||{})){if(role)roleByName.set(String(role.name||name),role)}
      for(const p of api.permissions||[]){const n=valueName(p);if(n!=null)permissionByName.set(String(n),p)}
      api._bump();return {roleByName,permissionByName};
    },
    findCachedUser(query){
      if(query==null)return null;
      if(typeof query!=='object')return userIndexes.id.get(String(query))||userIndexes.email.get(String(query).toLowerCase())||null;
      if(query.id!=null)return userIndexes.id.get(String(query.id))||null;
      if(query._id!=null)return userIndexes._id.get(String(query._id))||null;
      if(query.email)return userIndexes.email.get(String(query.email).trim().toLowerCase())||null;
      if(query.username)return userIndexes.username.get(String(query.username).trim().toLowerCase())||null;
      if(query.mobile)return userIndexes.mobile.get(String(query.mobile).trim().toLowerCase())||null;
      if(query.key)return userIndexes.key.get(String(query.key))||null;
      return null;
    },
    cacheUser(user){return api.addUser(user)},

    addKey(key){api.keys.set(String(key),true);api._bump();return key},
    addPermissions(role,perms){
      const name=typeof role==='object'?String(role.name):String(role);
      const r=api.roles[name]||(api.roles[name]={name,permissions:[]});
      r.permissions=[...new Set(normalizeNames(r.permissions).concat(normalizeNames(perms)))];
      roleByName.set(name,r);for(const p of normalizeNames(perms)){api.permissions.add(p);permissionByName.set(p,p)}api._bump();return r;
    },
    addRole(name,data={}){
      if(name&&typeof name==='object'){data=name;name=data.name}
      name=String(name||data?.name||'');if(!name)return null;
      const role={name,...data};api.roles[name]=role;roleByName.set(name,role);api._bump();return role;
    },
    addRoles(list){return normalizeList(list).map(x=>typeof x==='string'?api.addRole(x):api.addRole(x.name,x))},
    addUser(user){
      if(!user)return null;const id=user.id??user.email??user.username??user.key;if(id==null)return user;
      const existing=api.findCachedUser(user);
      if(existing&&existing!==user){Object.assign(existing,user);user=existing}
      api.$users[String(id)]=user;api._indexUser(user);permissionCache.delete(user);api._bump();return user;
    },
    removeUser(userOrId){const u=typeof userOrId==='object'?userOrId:api.findCachedUser({id:userOrId});if(!u)return false;for(const [k,v] of Object.entries(api.$users))if(v===u)delete api.$users[k];api.rebuildUserIndexes();permissionCache.delete(u);api._bump();return true},
    addUserPermission(userId,permission){const u=api.findCachedUser({id:userId})||api.$users[userId];if(!u)return null;u.permissions=[...new Set(normalizeNames(u.permissions).concat(normalizeNames(permission)))];permissionCache.delete(u);api._bump();return u},

    effectivePermissions(user){
      if(!user)return new Set();
      const signature=version+'|'+stableSignature(user.permissions)+'|'+stableSignature(user.roles);
      const cached=permissionCache.get(user);if(cached?.signature===signature)return cached.set;
      const set=new Set(normalizeNames(user.permissions));
      for(const roleName of normalizeNames(user.roles)){
        const role=roleByName.get(roleName)||api.roles[roleName];
        for(const p of normalizeNames(role?.permissions))set.add(p);
      }
      if(user.isAdmin||user.is_admin||set.has('*')||normalizeNames(user.roles).includes('*'))set.add('*');
      permissionCache.set(user,{signature,set});return set;
    },
    hasRole(user,roles){const need=normalizeNames(roles);if(!need.length)return true;const have=new Set(normalizeNames(user?.roles));if(have.has('*')||user?.isAdmin||user?.is_admin)return true;return need.some(r=>have.has(r))},
    hasPermission(user,permissions){const need=normalizeNames(permissions);if(!need.length)return true;const have=api.effectivePermissions(user);if(have.has('*'))return true;return need.every(p=>have.has(p))},
    can(user,rule){
      if(!rule)return true;if(typeof rule==='function')return !!rule(user);
      if(typeof rule==='string'||Array.isArray(rule))return api.hasPermission(user,rule);
      if(rule.roles&&!api.hasRole(user,rule.roles))return false;
      if(rule.permissions&&!api.hasPermission(user,rule.permissions))return false;
      return true;
    },
    compile(rule){
      if(typeof rule==='function')return rule;
      const key=typeof rule==='string'?`s:${rule}`:`j:${JSON.stringify(rule??null)}`;
      let fn=ruleCache.get(key);if(fn)return fn;
      if(typeof rule==='string'||Array.isArray(rule)){const need=normalizeNames(rule);fn=user=>api.hasPermission(user,need)}
      else if(rule&&typeof rule==='object'){const roles=normalizeNames(rule.roles),permissions=normalizeNames(rule.permissions);fn=user=>(!roles.length||api.hasRole(user,roles))&&(!permissions.length||api.hasPermission(user,permissions))}
      else fn=()=>true;
      ruleCache.set(key,fn);return fn;
    },
    middleware(rule){const check=api.compile(rule);return(req,res,next)=>check(req.user||req.session?.user)?next():res.status(403).json({error:'Forbidden'})},
    prepare(){api.rebuildUserIndexes();api.rebuildRoleIndexes();return api},
    stats(){return {users:Object.keys(api.$users).length,userIndexEntries:Object.values(userIndexes).reduce((n,m)=>n+m.size,0),roles:roleByName.size,permissions:permissionByName.size,compiledRules:ruleCache.size,version}}
  };

  // Standalone exports can delegate to these methods for backwards compatibility.
  api.hasRole=api.hasRole.bind(api);api.hasPermission=api.hasPermission.bind(api);api.can=api.can.bind(api);api.middleware=api.middleware.bind(api);
  for(const r of options.roles||[])api.addRole(r?.name||r,r||{});
  for(const p of options.permissions||[]){const n=valueName(p);if(n!=null){api.permissions.add(String(n));permissionByName.set(String(n),p)}}
  for(const u of options.users||[])api.addUser(u);
  api.rebuildRoleIndexes();
  return api;
}

function hasRole(user,roles){const have=new Set(normalizeNames(user?.roles));const need=normalizeNames(roles);return !need.length||have.has('*')||need.some(r=>have.has(r))}
function hasPermission(user,permissions){const have=new Set(normalizeNames(user?.permissions));const need=normalizeNames(permissions);return !need.length||have.has('*')||need.every(p=>have.has(p))}
function can(user,rule){if(!rule)return true;if(typeof rule==='function')return !!rule(user);if(typeof rule==='string'||Array.isArray(rule))return hasPermission(user,rule);if(rule.roles&&!hasRole(user,rule.roles))return false;if(rule.permissions&&!hasPermission(user,rule.permissions))return false;return true}
function middleware(rule){return(req,res,next)=>can(req.user||req.session?.user,rule)?next():res.status(403).json({error:'Forbidden'})}

module.exports={hasRole,hasPermission,can,middleware,createSecurity};
