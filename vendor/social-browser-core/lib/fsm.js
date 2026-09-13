'use strict';
const fs=require('fs');
const path=require('path');
const { ensureDir }=require('./utils');

function createFSM(site){
  const fsm={
    dir:site.dir,
    list:[],
    cache:new Map(),
    pathCache:new Map(),
    missingPathCache:new Map(),
    cacheBytes:0,
    cacheMaxBytes:32*1024*1024,
    cacheMaxEntries:500,
    pathCacheTTL:30_000,
    missingPathCacheTTL:5_000,
    off(){ fsm.cache.clear(); fsm.pathCache.clear(); fsm.missingPathCache.clear(); fsm.cacheBytes=0; },
    clearCache(){ fsm.off(); },
    createDir(dir){ return fs.promises.mkdir(dir,{recursive:true}).then(()=>dir); },
    createDirSync(dir){ fs.mkdirSync(dir,{recursive:true}); return dir; },
    mkDir(dir){ return fsm.createDir(dir); },
    mkdirSync(dir){ return fsm.createDirSync(dir); },
    deleteFile(file,cb){
      const p=fs.promises.unlink(file).then(()=>true,()=>false);
      if(typeof cb==='function')p.then(x=>cb(x)); else return p;
    },
    removeFile(file,cb){ return fsm.deleteFile(file,cb); },
    deleteFileSync(file){ try{fs.unlinkSync(file);return true}catch{return false} },
    removeFileSync(file){ return fsm.deleteFileSync(file); },
    isFileExists(file,cb){
      const p=fs.promises.access(file).then(()=>true,()=>false);
      if(typeof cb==='function')p.then(x=>cb(x)); else return p;
    },
    isFileExistsSync:file=>fs.existsSync(file),
    stat(file,cb){
      const p=fs.promises.stat(file);
      if(typeof cb==='function')p.then(x=>cb(x),e=>cb(null,e)); else return p;
    },
    statSync:file=>fs.statSync(file),
    readFile(file,enc='utf8'){ return fs.promises.readFile(file,enc); },
    readFileNow(file,enc='utf8'){ return fs.promises.readFile(file,enc); },
    readFileRaw(file){ return fs.promises.readFile(file); },
    readFileSync(file,enc='utf8'){ return fs.readFileSync(file,enc); },
    readFileSyncRaw(file){ return fs.readFileSync(file); },
    readFileStream(file){ return fs.createReadStream(file); },
    async readFiles(files,enc='utf8'){ return Promise.all([].concat(files||[]).map(f=>fsm.readFile(f,enc))); },
    writeFile(file,data,enc='utf8'){ ensureDir(path.dirname(file)); return fs.promises.writeFile(file,data,enc).then(()=>true); },
    writeFileSync(file,data,enc='utf8'){ ensureDir(path.dirname(file)); fs.writeFileSync(file,data,enc); return true; },
    getFilePath(file){ return path.isAbsolute(file)?file:path.join(fsm.dir,file); },
    getContent(file){ return fsm.readFile(fsm.getFilePath(file)); },
    isImage(file){ return /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(String(file)); },
    html(file){ return fsm.readFile(fsm.getFilePath(file)); },
    css(file){ return fsm.readFile(fsm.getFilePath(file)); },
    js(file){ return fsm.readFile(fsm.getFilePath(file)); },
    json(file){ return fsm.readFile(fsm.getFilePath(file)).then(JSON.parse); },
    xml(file){ return fsm.readFile(fsm.getFilePath(file)); },
    async download(url,file){
      if(!globalThis.fetch)throw new Error('fetch unavailable');
      const r=await fetch(url); if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const buf=Buffer.from(await r.arrayBuffer()); ensureDir(path.dirname(file)); await fs.promises.writeFile(file,buf); return file;
    },
    downloadFile(url,file){ return fsm.download(url,file); },
    _cacheFile(file,data){ fsm.cache.set(file,data); return data; },
    _evictPath(file){ return fsm.cache.delete(file); },
    _fileSize(file){ try{return fs.statSync(file).size}catch{return 0} },
    _getCached(file){ return fsm.cache.get(file); },
    _touch(){ return true; }
  };
  return fsm;
}
module.exports={createFSM};
