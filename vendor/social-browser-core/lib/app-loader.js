'use strict';
const fs=require('fs');
const path=require('path');

class AppLoader {
  constructor(site) {
    this.site=site;
    this.loaded=new Map();
  }

  resolve(nameOrPath) {
    const s=this.site;
    const value=String(nameOrPath||'');
    const expand=candidate=>{
      if(!candidate)return [];
      try{
        if(fs.existsSync(candidate)&&fs.statSync(candidate).isDirectory())
          return [path.join(candidate,'app.js'),path.join(candidate,'index.js')];
      }catch{}
      return [candidate];
    };
    const candidates=[
      ...expand(value),
      path.join(s.cwd,'apps',value,'app.js'),
      path.join(s.cwd,value,'app.js'),
      path.join(s.cwd,'apps',value,'index.js')
    ];
    return candidates.find(f=>{try{return fs.existsSync(f)&&fs.statSync(f).isFile()}catch{return false}})||null;
  }

  load(nameOrPath,options={}) {
    const file=this.resolve(nameOrPath);
    if(!file)return null;
    const abs=path.resolve(file);
    const existing=this.loaded.get(abs);
    if(existing&&!options.reload)return existing;

    if(options.reload){
      try{delete require.cache[require.resolve(abs)]}catch{}
      if(existing){
        const idx=this.site.apps.indexOf(existing);
        if(idx>=0)this.site.apps.splice(idx,1);
        this.loaded.delete(abs);
        try{existing.module?.dispose?.(this.site,existing)}catch{}
        this.site.emit?.('[app][unloaded]',existing);
      }
    }

    const mod=require(abs);
    const appPath=path.dirname(abs);
    const appName=options.name||path.basename(appPath);
    const descriptor={
      name:appName,
      name2:options.name2||appName,
      path:appPath,
      file:abs,
      module:mod,
      options:{...options},
      loadedAt:new Date().toISOString(),
      state:'loading'
    };

    this.site.emit?.('[app][loading]',descriptor);
    let result;
    if(typeof mod==='function')result=mod(this.site,options,descriptor);
    else if(mod&&typeof mod.init==='function')result=mod.init(this.site,options,descriptor);

    descriptor.result=result;
    descriptor.instance=result&&typeof result==='object'?result:null;
    descriptor.state='loaded';
    this.loaded.set(abs,descriptor);
    this.site.apps.push(descriptor);
    this.site.emit?.('[app][loaded]',descriptor);
    return descriptor;
  }

  loadAll(dir=path.join(this.site.cwd,'apps'),options={}) {
    if(!fs.existsSync(dir))return [];
    return fs.readdirSync(dir,{withFileTypes:true})
      .filter(x=>x.isDirectory())
      .map(x=>this.load(path.join(dir,x.name),options))
      .filter(Boolean);
  }

  unload(nameOrPath){
    const file=this.resolve(nameOrPath);
    const abs=file?path.resolve(file):null;
    const app=abs?this.loaded.get(abs):this.site.apps.find(x=>x.name===nameOrPath||x.name2===nameOrPath);
    if(!app)return false;
    try{app.module?.dispose?.(this.site,app)}catch{}
    const idx=this.site.apps.indexOf(app);if(idx>=0)this.site.apps.splice(idx,1);
    this.loaded.delete(app.file);
    try{delete require.cache[require.resolve(app.file)]}catch{}
    app.state='unloaded';
    this.site.emit?.('[app][unloaded]',app);
    return true;
  }
}

module.exports={AppLoader};
