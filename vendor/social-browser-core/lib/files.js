'use strict';
const fs=require('fs');
const path=require('path');
const {ensureDir}=require('./utils');

function createFiles(site){
  return {
    root:site.dir,
    createDir(dir){return fs.promises.mkdir(dir,{recursive:true}).then(()=>dir)},
    createDirSync(dir){fs.mkdirSync(dir,{recursive:true});return dir},
    delete(file){return fs.promises.unlink(file).then(()=>{site.fileCache.invalidate(file);return true},()=>false)},
    deleteSync(file){try{fs.unlinkSync(file);site.fileCache.invalidate(file);return true}catch{return false}},
    exists(file){return Promise.resolve(site.fileCache?.existsSync?site.fileCache.existsSync(file):fs.existsSync(file))},
    existsSync:file=>site.fileCache?.existsSync?site.fileCache.existsSync(file):fs.existsSync(file),
    stat:file=>Promise.resolve(site.fileCache?.statSync?site.fileCache.statSync(file):fs.statSync(file)),
    statSync:file=>site.fileCache?.statSync?site.fileCache.statSync(file):fs.statSync(file),
    readRaw(file,enc='utf8'){return fs.promises.readFile(file,enc)},
    readRawSync(file,enc='utf8'){return fs.readFileSync(file,enc)},
    read(file,enc='utf8'){return site.fileCache.getText(file,enc)},
    readSync(file,enc='utf8'){return site.fileCache.getTextSync(file,enc)},
    readCached(file,enc='utf8'){return site.fileCache.getText(file,enc)},
    readCachedSync(file,enc='utf8'){return site.fileCache.getTextSync(file,enc)},
    readBufferRaw:file=>fs.promises.readFile(file),
    readBufferRawSync:file=>fs.readFileSync(file),
    readBuffer:file=>site.fileCache.getBuffer(file),
    readBufferSync:file=>site.fileCache.getBufferSync(file),
    readBufferCached:file=>site.fileCache.getBuffer(file),
    readBufferCachedSync:file=>site.fileCache.getBufferSync(file),
    stream:file=>fs.createReadStream(file),
    write(file,data,enc='utf8'){ensureDir(path.dirname(file));return fs.promises.writeFile(file,data,enc).then(()=>{site.fileCache.invalidate(file);return true})},
    writeSync(file,data,enc='utf8'){ensureDir(path.dirname(file));fs.writeFileSync(file,data,enc);site.fileCache.invalidate(file);return true},
    writeJSON(file,value,space=2){return this.write(file,JSON.stringify(value,null,space),'utf8')},
    writeJSONSync(file,value,space=2){return this.writeSync(file,JSON.stringify(value,null,space),'utf8')},
    async readJSON(file){const text=await this.read(file,'utf8');return JSON.parse(String(text||''))},
    readJSONSync(file){const text=this.readSync(file,'utf8');return JSON.parse(String(text||''))},
    resolve(file){return path.isAbsolute(file)?file:path.join(site.dir,file)},
    isImage(file){return /\.(png|jpe?g|gif|webp|svg|ico|bmp|avif)$/i.test(String(file))}
  };
}
module.exports={createFiles};
