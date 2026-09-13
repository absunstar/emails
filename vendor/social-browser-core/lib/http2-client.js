'use strict';
const http2=require('http2');
class Http2Client{
  constructor(options={}){this.options=options;this.session=null}
  connect(authority,options={}){
    this.session=http2.connect(authority,{...this.options,...options});
    return new Promise((resolve,reject)=>{
      this.session.once('connect',()=>resolve(this));
      this.session.once('error',reject);
    });
  }
  request(headers={},body=null){
    if(!this.session)throw new Error('HTTP/2 client is not connected');
    return new Promise((resolve,reject)=>{
      const req=this.session.request(headers);
      const chunks=[];let responseHeaders={};
      req.on('response',h=>responseHeaders=h);
      req.on('data',d=>chunks.push(Buffer.from(d)));
      req.on('end',()=>resolve({
        headers:responseHeaders,
        status:Number(responseHeaders[':status']||0),
        body:Buffer.concat(chunks),
        text(){return this.body.toString('utf8')},
        json(){return JSON.parse(this.text())}
      }));
      req.on('error',reject);
      if(body!=null)req.end(body);else req.end();
    });
  }
  get(path='/',headers={}){return this.request({':method':'GET',':path':path,...headers})}
  close(){this.session?.close();this.session=null}
}
module.exports={Http2Client};
