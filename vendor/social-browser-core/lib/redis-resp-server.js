'use strict';
const net=require('net');
const fs=require('fs');
const {parseResp}=require('./redis-resp');

function enc(v){
  if(v===null)return Buffer.from('$-1\r\n');
  if(v instanceof Error)return Buffer.from(`-${v.message}\r\n`);
  if(Number.isInteger(v))return Buffer.from(`:${v}\r\n`);
  if(Array.isArray(v))return Buffer.concat([Buffer.from(`*${v.length}\r\n`),...v.map(enc)]);
  if(typeof v==='string'&&['OK','PONG','QUEUED'].includes(v))return Buffer.from(`+${v}\r\n`);
  const b=Buffer.from(String(v));return Buffer.concat([Buffer.from(`$${b.length}\r\n`),b,Buffer.from('\r\n')]);
}
function createRedisRespServer(options={}){
  const store=options.store||new Map(),expiry=new Map(),channels=new Map(),txState=new WeakMap();
  const persistFile=options.persistFile||null;
  if(persistFile){try{const j=JSON.parse(fs.readFileSync(persistFile,'utf8'));for(const [k,v] of Object.entries(j.data||{}))store.set(k,v);for(const [k,v] of Object.entries(j.expiry||{}))expiry.set(k,v)}catch{}}
  const persist=()=>{if(!persistFile)return;const tmp=persistFile+'.tmp';fs.writeFileSync(tmp,JSON.stringify({data:Object.fromEntries(store),expiry:Object.fromEntries(expiry)}));fs.renameSync(tmp,persistFile)}
  const isExpired=k=>{const t=expiry.get(k);if(t&&t<=Date.now()){expiry.delete(k);store.delete(k);return true}return false}
  const server=net.createServer(sock=>{
    let buf=Buffer.alloc(0);
    sock.on('close',()=>{for(const set of channels.values())set.delete(sock);txState.delete(sock)});
    sock.on('data',d=>{buf=Buffer.concat([buf,d]);while(buf.length){
      let x;try{x=parseResp(buf,0)}catch(e){sock.write(enc(new Error('ERR '+e.message)));buf=Buffer.alloc(0);return}
      if(!x)return;buf=buf.subarray(x.next);
      const args=Array.isArray(x.value)?x.value.map(String):[],cmd=String(args.shift()||'').toUpperCase();
      Promise.resolve().then(async()=>{
        const tx=txState.get(sock);
        if(cmd==='MULTI'){txState.set(sock,[]);return 'OK'}
        if(cmd==='DISCARD'){txState.delete(sock);return 'OK'}
        if(cmd==='EXEC'){const q=tx||[];txState.delete(sock);const out=[];for(const fn of q)out.push(await fn());persist();return out}
        const execute=async()=>{
          if(options.handlers?.[cmd])return options.handlers[cmd](args,{socket:sock,store,expiry});
          if(cmd==='PING')return args[0]||'PONG';
          if(cmd==='GET'){if(isExpired(args[0]))return null;return store.has(args[0])?store.get(args[0]):null}
          if(cmd==='SET'){
            store.set(args[0],args[1]);expiry.delete(args[0]);
            for(let i=2;i<args.length;i++){const op=args[i].toUpperCase();if(op==='EX')expiry.set(args[0],Date.now()+Number(args[++i])*1000);else if(op==='PX')expiry.set(args[0],Date.now()+Number(args[++i]))}
            if(!tx)persist();return 'OK'
          }
          if(cmd==='DEL'){let n=0;for(const k of args){expiry.delete(k);if(store.delete(k))n++}if(!tx)persist();return n}
          if(cmd==='EXISTS'){let n=0;for(const k of args)if(!isExpired(k)&&store.has(k))n++;return n}
          if(cmd==='EXPIRE'){if(!store.has(args[0])||isExpired(args[0]))return 0;expiry.set(args[0],Date.now()+Number(args[1])*1000);if(!tx)persist();return 1}
          if(cmd==='PEXPIRE'){if(!store.has(args[0])||isExpired(args[0]))return 0;expiry.set(args[0],Date.now()+Number(args[1]));if(!tx)persist();return 1}
          if(cmd==='TTL'){if(isExpired(args[0])||!store.has(args[0]))return -2;if(!expiry.has(args[0]))return -1;return Math.max(0,Math.ceil((expiry.get(args[0])-Date.now())/1000))}
          if(cmd==='PERSIST'){const had=expiry.delete(args[0]);if(had&&!tx)persist();return had?1:0}
          if(cmd==='PUBLISH'){const set=channels.get(args[0])||new Set();for(const c of set)if(!c.destroyed)c.write(enc(['message',args[0],args[1]]));return set.size}
          if(cmd==='SUBSCRIBE'){for(const ch of args){if(!channels.has(ch))channels.set(ch,new Set());channels.get(ch).add(sock);sock.write(enc(['subscribe',ch,channels.get(ch).size]))}return null}
          if(cmd==='UNSUBSCRIBE'){for(const ch of args){channels.get(ch)?.delete(sock);sock.write(enc(['unsubscribe',ch,channels.get(ch)?.size||0]))}return null}
          if(cmd==='SAVE'){persist();return 'OK'}
          if(cmd==='QUIT'){setImmediate(()=>sock.end());return 'OK'}
          throw new Error('ERR unknown command');
        };
        if(tx&&!['EXEC','DISCARD','MULTI'].includes(cmd)){tx.push(execute);return 'QUEUED'}
        return execute();
      }).then(v=>{if(v!==null||!['SUBSCRIBE','UNSUBSCRIBE'].includes(cmd))sock.write(enc(v))}).catch(e=>sock.write(enc(e)));
    }});
  });
  server.store=store;server.expiry=expiry;server.save=persist;
  return server;
}
module.exports={createRedisRespServer,encodeRespReply:enc};
