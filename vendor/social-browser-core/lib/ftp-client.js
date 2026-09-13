'use strict';
const net=require('net');
const {EventEmitter}=require('events');

class FtpClient extends EventEmitter{
  constructor(options={}){super();this.options=options;this.socket=null;this.buffer='';this.queue=[];this.host=null}
  connect(options={}){
    const o={host:'127.0.0.1',port:21,...this.options,...options};
    this.host=o.host;
    const greeting=this._await();
    return new Promise((resolve,reject)=>{
      this.socket=net.connect(o.port,o.host);
      this.socket.setEncoding('utf8');
      this.socket.on('data',d=>this._onData(d));
      this.socket.once('error',reject);
      greeting.then(r=>{this.socket.removeListener('error',reject);resolve(r)}).catch(reject);
    });
  }
  _onData(d){
    this.buffer+=d;
    let i;
    while((i=this.buffer.indexOf('\r\n'))>=0){
      const line=this.buffer.slice(0,i);this.buffer=this.buffer.slice(i+2);
      const m=line.match(/^(\d{3})([ -])(.*)$/);
      if(!m)continue;
      const code=Number(m[1]),text=m[3];
      const waiter=this.queue[0];
      if(waiter&&m[2]===' '){this.queue.shift();waiter.resolve({code,text,line})}
      this.emit('reply',{code,text,line});
    }
  }
  _await(){return new Promise((resolve,reject)=>this.queue.push({resolve,reject}))}
  async command(cmd){
    if(!this.socket)throw new Error('FTP is not connected');
    const p=this._await();this.socket.write(cmd+'\r\n');return p;
  }
  async login(user='anonymous',password='anonymous@'){
    let r=await this.command(`USER ${user}`);
    if(r.code===331)r=await this.command(`PASS ${password}`);
    return r;
  }
  async pwd(){return this.command('PWD')}
  async cwd(path){return this.command(`CWD ${path}`)}
  async type(mode='I'){return this.command(`TYPE ${mode}`)}

  async _passiveEndpoint(){
    let r=await this.command('EPSV');
    if(r.code===229){
      const m=r.text.match(/\(\|\|\|(\d+)\|\)/);
      if(m)return {host:this.host,port:Number(m[1])};
    }
    r=await this.command('PASV');
    if(r.code!==227)throw new Error(`FTP passive mode failed: ${r.code} ${r.text}`);
    const m=r.text.match(/\((\d+),(\d+),(\d+),(\d+),(\d+),(\d+)\)/);
    if(!m)throw new Error('Invalid PASV reply');
    return {host:[m[1],m[2],m[3],m[4]].join('.'),port:Number(m[5])*256+Number(m[6])};
  }

  async _dataCommand(command,upload=null){
    const ep=await this._passiveEndpoint();
    const dataSocket=net.connect(ep.port,ep.host);
    const chunks=[];
    const connected=new Promise((res,rej)=>{dataSocket.once('connect',res);dataSocket.once('error',rej)});
    await connected;
    const replyPromise=this.command(command);
    if(upload!=null){
      dataSocket.end(Buffer.isBuffer(upload)?upload:Buffer.from(String(upload)));
    }else{
      dataSocket.on('data',d=>chunks.push(Buffer.from(d)));
    }
    const dataDone=new Promise((res,rej)=>{dataSocket.once('end',res);dataSocket.once('close',res);dataSocket.once('error',rej)});
    const first=await replyPromise;
    if(first.code>=400){dataSocket.destroy();throw new Error(`FTP data command failed: ${first.code} ${first.text}`)}
    await dataDone;
    const final=await this._await();
    return {reply:final,data:Buffer.concat(chunks)};
  }

  async list(path=''){
    const x=await this._dataCommand(`LIST${path?' '+path:''}`);
    return x.data.toString('utf8');
  }
  async retr(path){return (await this._dataCommand(`RETR ${path}`)).data}
  async stor(path,data){return (await this._dataCommand(`STOR ${path}`,data)).reply}
  async quit(){
    if(!this.socket)return {code:221,text:'not connected'};
    try{return await this.command('QUIT')}
    finally{try{this.socket.end()}catch{};this.socket=null}
  }
}
module.exports={FtpClient};
