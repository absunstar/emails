'use strict';
const net=require('net');
const path=require('path');
const fs=require('fs');

function createFtpServer(options={}){
  const root=path.resolve(options.root||process.cwd());
  function safe(p){
    const r=path.resolve(root,'.'+('/'+String(p||'').replace(/\\/g,'/')));
    if(r!==root && !r.startsWith(root+path.sep))throw new Error('Path escape');
    return r;
  }
  const server=net.createServer(sock=>{
    sock.setEncoding('utf8');sock.write('220 aisite FTP\r\n');
    let buf='',cwd='/',passive=null,authed=!options.authenticate;
    const closePassive=()=>{try{passive?.close()}catch{};passive=null};
    sock.on('close',closePassive);
    sock.on('data',d=>{buf+=d;let i;while((i=buf.indexOf('\r\n'))>=0){const line=buf.slice(0,i);buf=buf.slice(i+2);handle(line).catch(()=>sock.write('550 Failed\r\n'))}});
    async function handle(line){
      const [cmd,...rest]=line.split(' '),arg=rest.join(' '),c=(cmd||'').toUpperCase();
      if(c==='USER'){sock._ftpUser=arg;sock.write(options.authenticate?'331 Password required\r\n':'230 Logged in\r\n');return}
      if(c==='PASS'){authed=await Promise.resolve(options.authenticate?.(sock._ftpUser,arg));sock.write(authed?'230 Logged in\r\n':'530 Login incorrect\r\n');return}
      if(!authed){sock.write('530 Not logged in\r\n');return}
      if(c==='SYST'){sock.write('215 UNIX Type: L8\r\n');return}
      if(c==='TYPE'){sock.write('200 Type set\r\n');return}
      if(c==='PWD'){sock.write(`257 "${cwd}"\r\n`);return}
      if(c==='CWD'){const np=path.posix.normalize(path.posix.join(cwd,arg||'/'));const fp=safe(np);if(fs.existsSync(fp)&&fs.statSync(fp).isDirectory()){cwd=np;sock.write('250 Directory changed\r\n')}else sock.write('550 Not a directory\r\n');return}
      if(c==='EPSV'){
        closePassive();passive=net.createServer();passive._pending=[];passive.on('connection',s=>passive?._pending?.push(s));
        await new Promise(res=>passive.listen(0,'127.0.0.1',res));const p=passive.address().port;sock.write(`229 Entering Extended Passive Mode (|||${p}|)\r\n`);return
      }
      if(c==='PASV'){
        closePassive();passive=net.createServer();passive._pending=[];passive.on('connection',s=>passive?._pending?.push(s));
        await new Promise(res=>passive.listen(0,'127.0.0.1',res));const p=passive.address().port;sock.write(`227 Entering Passive Mode (127,0,0,1,${p>>8},${p&255})\r\n`);return
      }
      async function dataSocket(){
        if(!passive)throw new Error('Use passive mode first');
        const ps=passive;
        const finish=s=>{passive=null;try{ps.close()}catch{};return s};
        if(ps._pending?.length)return finish(ps._pending.shift());
        return new Promise((resolve,reject)=>{
          const onConn=s=>{ps.off('error',onErr);resolve(finish(s))};
          const onErr=e=>{ps.off('connection',onConn);reject(e)};
          ps.once('connection',onConn);ps.once('error',onErr);
        });
      }
      if(c==='LIST'){
        const dsP=dataSocket();sock.write('150 Opening data connection\r\n');const ds=await dsP;
        const fp=safe(path.posix.join(cwd,arg||''));const names=fs.readdirSync(fp);
        for(const n of names){const st=fs.statSync(path.join(fp,n));ds.write(`${st.isDirectory()?'d':'-'}rw-r--r-- 1 aisite aisite ${st.size} Jan 01 00:00 ${n}\r\n`)}
        ds.end();sock.write('226 Transfer complete\r\n');return
      }
      if(c==='RETR'){
        const dsP=dataSocket();sock.write('150 Opening data connection\r\n');const ds=await dsP;const fp=safe(path.posix.join(cwd,arg));
        fs.createReadStream(fp).pipe(ds).on('finish',()=>sock.write('226 Transfer complete\r\n'));return
      }
      if(c==='STOR'){
        const dsP=dataSocket();sock.write('150 Opening data connection\r\n');const ds=await dsP;const fp=safe(path.posix.join(cwd,arg));
        fs.mkdirSync(path.dirname(fp),{recursive:true});ds.pipe(fs.createWriteStream(fp)).on('finish',()=>sock.write('226 Transfer complete\r\n'));return
      }
      if(c==='QUIT'){sock.write('221 Bye\r\n');sock.end();return}
      sock.write('502 Command not implemented\r\n');
    }
  });
  return server;
}
module.exports={createFtpServer};
