'use strict';
const CAPABILITIES=Object.freeze({
  http:{client:true,server:true,secure:false,status:'ready'},
  https:{client:true,server:true,secure:true,status:'ready'},
  http2:{client:true,server:true,secure:'optional',status:'ready'},
  tcp:{client:true,server:true,secure:false,status:'ready'},
  tls:{client:true,server:true,secure:true,status:'ready'},
  udp:{client:true,server:true,secure:false,status:'ready'},
  dns:{client:true,server:true,secure:false,status:'ready-cache-forwarder'},
  ws:{client:true,server:true,secure:false,status:'ready'},
  wss:{client:true,server:true,secure:true,status:'ready'},
  ftp:{client:true,server:true,secure:false,status:'ready-passive-basic'},
  smtp:{client:true,server:true,secure:'implicit-tls-supported',status:'ready-basic'},
  pop3:{client:true,server:true,secure:'implicit-tls-supported',status:'ready-basic'},
  imap:{client:true,server:true,secure:'implicit-tls-supported',status:'ready-basic'},
  mqtt:{client:true,server:true,secure:'tls-supported',status:'ready-qos1-qos2-retained-sessions'},
  redis:{client:true,server:true,secure:false,status:'ready-pubsub-multi-ttl-persistence'},
  socks4:{client:true,server:false,secure:false,status:'ready-basic'},
  socks5:{client:true,server:true,secure:false,status:'ready-connect-udp-associate'},
  http_connect:{client:true,server:true,secure:'tunnel',status:'ready-basic'},
  ssh:{client:true,server:false,secure:true,status:'partial-banner-only'},
  unix:{client:true,server:true,secure:false,status:'via-tcp-api-path'},
  sse:{client:true,server:true,secure:'http-dependent',status:'via-http'},
  http3:{client:false,server:false,secure:true,status:'not-available-with-current-node-native-runtime'},
  quic:{client:false,server:false,secure:true,status:'not-available-with-current-node-native-runtime'}
});
function protocolCapabilities(){return JSON.parse(JSON.stringify(CAPABILITIES))}
module.exports={CAPABILITIES,protocolCapabilities};
