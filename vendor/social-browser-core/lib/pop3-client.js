'use strict';
const net=require('net');
const tls=require('tls');

class Pop3Client{
  constructor(options={}){this.options=options;this.socket=null;this.buffer='';this.waiters=[]}
  _wait(multiline=false){return new Promise((resolve,reject)=>this.waiters.push({resolve,reject,multiline,lines:[]}))}
  _onData(d){
    this.buffer+=d.toString('utf8');
    while(true){
      const w=this.waiters[0];if(!w)return;
      if(w.multiline){
        const end=this.buffer.indexOf('\r\n.\r\n');
        if(end<0)return;
        const block=this.buffer.slice(0,end);this.buffer=this.buffer.slice(end+5);
        const lines=block.split('\r\n');
        const status=lines.shift()||'';
        this.waiters.shift();
        w.resolve({ok:status.startsWith('+OK'),status,lines:lines.map(x=>x.startsWith('..')?x.slice(1):x)});
      }else{
        const i=this.buffer.indexOf('\r\n');if(i<0)return;
        const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+2);
        this.waiters.shift();w.resolve({ok:line.startsWith('+OK'),line});
      }
    }
  }
  connect(options={}){
    const o={host:'127.0.0.1',port:options.secure?995:110,...this.options,...options};
    const p=this._wait(false);
    this.socket=o.secure?tls.connect({host:o.host,port:o.port,servername:o.servername||o.host,rejectUnauthorized:o.rejectUnauthorized!==false})
                        :net.connect(o.port,o.host);
    this.socket.on('data',d=>this._onData(d));
    return p;
  }
  command(line,multiline=false){const p=this._wait(multiline);this.socket.write(line+'\r\n');return p}
  user(v){return this.command(`USER ${v}`)}
  pass(v){return this.command(`PASS ${v}`)}
  stat(){return this.command('STAT')}
  list(){return this.command('LIST',true)}
  retr(id){return this.command(`RETR ${id}`,true)}
  dele(id){return this.command(`DELE ${id}`)}
  noop(){return this.command('NOOP')}
  quit(){const p=this.command('QUIT');p.finally(()=>this.socket?.end());return p}
}
module.exports={Pop3Client};
