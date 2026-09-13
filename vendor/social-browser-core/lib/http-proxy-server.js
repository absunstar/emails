'use strict';
const http=require('http');
const net=require('net');
const {URL}=require('url');

function createHttpProxyServer(options={}){
  const server=http.createServer((req,res)=>{
    let u;
    try{u=new URL(req.url)}catch{
      const host=req.headers.host||'';
      try{u=new URL(`http://${host}${req.url}`)}catch{res.writeHead(400);res.end('Bad Request');return}
    }
    const out=http.request({
      host:u.hostname,port:u.port||80,method:req.method,path:u.pathname+u.search,
      headers:{...req.headers,host:u.host}
    },r=>{
      res.writeHead(r.statusCode||502,r.headers);r.pipe(res);
    });
    out.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('Bad Gateway')});
    req.pipe(out);
  });
  server.on('connect',(req,client,head)=>{
    const [host,portRaw]=String(req.url||'').split(':');
    const port=Number(portRaw||443);
    const upstream=net.connect(port,host,()=>{
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head?.length)upstream.write(head);
      upstream.pipe(client);client.pipe(upstream);
    });
    upstream.on('error',()=>{try{client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')}catch{};client.destroy()});
  });
  return server;
}
module.exports={createHttpProxyServer};
