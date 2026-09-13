'use strict';
const {URL}=require('url');

class ProtocolFactory{
  constructor(site){this.site=site}
  capabilities(name=null){
    const all=this.site.protocolCapabilities();
    return name?all[String(name).replace(/:$/,'')]:all;
  }
  assert(name,side='client'){
    const key=String(name).replace(/:$/,'');
    const c=this.capabilities(key);
    if(!c)throw new Error(`Unknown protocol: ${key}`);
    if(!c[side])throw new Error(`Protocol ${key} does not support ${side}`);
    return c;
  }
  async connect(uri,options={}){
    const u=uri instanceof URL?uri:new URL(uri);
    const proto=u.protocol.slice(0,-1);
    this.assert(proto==='rediss'?'redis':proto==='mqtts'?'mqtt':proto==='pop3s'?'pop3':proto==='imaps'?'imap':proto==='ftps'?'ftp':proto,'client');
    const host=u.hostname,port=u.port?Number(u.port):undefined;
    if(proto==='ws'||proto==='wss'){const c=new this.site.WebSocketClient();return c.connect(u.toString(),options)}
    if(proto==='redis'||proto==='rediss'){const c=new this.site.RedisRespClient();await c.connect({host,port:port||6379,...options});return c}
    if(proto==='mqtt'||proto==='mqtts'){const c=new this.site.MqttClient();await c.connect({host,port:port||(proto==='mqtts'?8883:1883),secure:proto==='mqtts',...options});return c}
    if(proto==='ftp'||proto==='ftps'){const c=new this.site.FtpClient();await c.connect({host,port:port||21,...options});return c}
    if(proto==='smtp'||proto==='smtps'){const c=new this.site.SmtpClient();await c.connect({host,port:port||(proto==='smtps'?465:25),secure:proto==='smtps',...options});return c}
    if(proto==='pop3'||proto==='pop3s'){const c=new this.site.Pop3Client();await c.connect({host,port:port||(proto==='pop3s'?995:110),secure:proto==='pop3s',...options});return c}
    if(proto==='imap'||proto==='imaps'){const c=new this.site.ImapClient();await c.connect({host,port:port||(proto==='imaps'?993:143),secure:proto==='imaps',...options});return c}
    if(proto==='http2'||proto==='h2'||proto==='h2c'){const c=new this.site.Http2Client();await c.connect(options.authority||`${proto==='h2c'?'http':'https'}://${host}${port?':'+port:''}`,options);return c}
    if(proto==='tcp')return this.site.protocols.connectTcp({host,port,...options});
    if(proto==='tls')return this.site.protocols.connectTls({host,port,...options});
    if(proto==='ssh'){const c=new this.site.SshProtocol();return c.connect({host,port:port||22,...options})}
    throw new Error(`connectProtocol not implemented for ${proto}`);
  }
  createServer(protocol,options={}){
    const p=String(protocol).replace(/:$/,'');this.assert(p,'server');
    if(p==='http')return this.site.protocols.http(options.handler,options);
    if(p==='https')return this.site.protocols.https(options.handler,options);
    if(p==='http2')return this.site.protocols.http2(options.handler,options);
    if(p==='tcp')return this.site.protocols.tcp(options.handler,options);
    if(p==='tls')return this.site.protocols.tls(options.handler,options);
    if(p==='udp')return this.site.protocols.udp(options.handler,options);
    if(p==='ws')return this.site.protocols.ws(options.handler,options);
    if(p==='wss')return this.site.protocols.wss(options.handler,options);
    if(p==='ftp')return this.site.createFtpServer(options);
    if(p==='smtp')return this.site.createSmtpServer(options);
    if(p==='pop3')return this.site.createPop3Server(options);
    if(p==='imap')return this.site.createImapServer(options);
    if(p==='mqtt')return this.site.createMqttBroker(options);
    if(p==='redis')return this.site.createRedisRespServer(options);
    if(p==='socks5')return this.site.createSocks5Server(options);
    if(p==='http_connect')return this.site.createHttpProxyServer(options);
    if(p==='dns'){const d=new this.site.DnsRuntime(options);return d.createServer(options)}
    throw new Error(`createProtocolServer not implemented for ${p}`);
  }
}
module.exports={ProtocolFactory};
