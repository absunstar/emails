'use strict';
const net=require('net');
const tls=require('tls');

class SmtpClient{
  constructor(options={}){this.options=options;this.socket=null;this.buffer='';this.waiters=[];this.secure=false}
  _wait(){return new Promise((resolve,reject)=>this.waiters.push({resolve,reject,lines:[]}))}
  _onData(d){
    this.buffer+=d.toString('utf8');
    let i;
    while((i=this.buffer.indexOf('\r\n'))>=0){
      const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+2);
      const m=line.match(/^(\d{3})([- ])(.*)$/);if(!m)continue;
      const w=this.waiters[0];if(!w)continue;
      w.lines.push(line);
      if(m[2]===' '){this.waiters.shift();w.resolve({code:Number(m[1]),text:m[3],lines:w.lines})}
    }
  }
  async connect(options={}){
    const o={host:'127.0.0.1',port:options.secure?465:25,...this.options,...options};
    const greeting=this._wait();
    this.socket=o.secure?tls.connect({host:o.host,port:o.port,servername:o.servername||o.host,rejectUnauthorized:o.rejectUnauthorized!==false})
                        :net.connect(o.port,o.host);
    this.secure=!!o.secure;
    this.socket.on('data',d=>this._onData(d));
    return greeting;
  }
  async command(line){
    const p=this._wait();this.socket.write(line+'\r\n');return p;
  }
  async ehlo(name='localhost'){return this.command(`EHLO ${name}`)}
  async helo(name='localhost'){return this.command(`HELO ${name}`)}
  async authPlain(user,password){
    const token=Buffer.from(`\0${user}\0${password}`).toString('base64');
    return this.command(`AUTH PLAIN ${token}`);
  }
  async authLogin(user,password){
    let r=await this.command('AUTH LOGIN');
    if(r.code!==334)return r;
    r=await this.command(Buffer.from(user).toString('base64'));
    if(r.code!==334)return r;
    return this.command(Buffer.from(password).toString('base64'));
  }
  async send({from,to,data}){
    const recipients=[].concat(to||[]);
    let r=await this.command(`MAIL FROM:<${from}>`);if(r.code>=400)return r;
    for(const rcpt of recipients){r=await this.command(`RCPT TO:<${rcpt}>`);if(r.code>=400)return r}
    r=await this.command('DATA');if(r.code!==354)return r;
    const body=String(data||'').replace(/\r?\n\.\r?\n/g,'\r\n..\r\n');
    const p=this._wait();this.socket.write(body.replace(/\r?\n/g,'\r\n')+'\r\n.\r\n');return p;
  }
  async quit(){try{return await this.command('QUIT')}finally{this.socket?.end();this.socket=null}}
}
module.exports={SmtpClient};
