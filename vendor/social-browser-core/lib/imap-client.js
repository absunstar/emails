'use strict';
const net=require('net');
const tls=require('tls');

class ImapClient{
  constructor(options={}){this.options=options;this.socket=null;this.buffer='';this.tag=0;this.waiters=new Map();this.greeting=null}
  _onData(d){
    this.buffer+=d.toString('utf8');
    let i;
    while((i=this.buffer.indexOf('\r\n'))>=0){
      const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+2);
      if(line.startsWith('* ')&&!this.greeting){this.greeting=line;this._greetingResolve?.(line);continue}
      const m=line.match(/^([A-Za-z0-9]+) (OK|NO|BAD|BYE)(?: (.*))?$/);
      if(m&&this.waiters.has(m[1])){
        const w=this.waiters.get(m[1]);this.waiters.delete(m[1]);
        w.lines.push(line);w.resolve({ok:m[2]==='OK',status:m[2],text:m[3]||'',lines:w.lines});continue
      }
      for(const w of this.waiters.values())w.lines.push(line);
    }
  }
  connect(options={}){
    const o={host:'127.0.0.1',port:options.secure?993:143,...this.options,...options};
    const greeting=new Promise((res,rej)=>{this._greetingResolve=res;this._greetingReject=rej});
    this.socket=o.secure?tls.connect({host:o.host,port:o.port,servername:o.servername||o.host,rejectUnauthorized:o.rejectUnauthorized!==false})
                        :net.connect(o.port,o.host);
    this.socket.on('data',d=>this._onData(d));this.socket.once('error',e=>this._greetingReject?.(e));
    return greeting;
  }
  command(cmd){
    const tag='A'+(++this.tag);
    const p=new Promise((resolve,reject)=>this.waiters.set(tag,{resolve,reject,lines:[]}));
    this.socket.write(`${tag} ${cmd}\r\n`);return p;
  }
  login(user,pass){return this.command(`LOGIN "${String(user).replace(/"/g,'\\"')}" "${String(pass).replace(/"/g,'\\"')}"`)}
  capability(){return this.command('CAPABILITY')}
  select(mailbox='INBOX'){return this.command(`SELECT "${mailbox}"`)}
  list(ref='',pattern='*'){return this.command(`LIST "${ref}" "${pattern}"`)}
  search(criteria='ALL'){return this.command(`SEARCH ${criteria}`)}
  fetch(seq,items='BODY[]'){return this.command(`FETCH ${seq} (${items})`)}
  logout(){const p=this.command('LOGOUT');p.finally(()=>this.socket?.end());return p}
}
module.exports={ImapClient};
