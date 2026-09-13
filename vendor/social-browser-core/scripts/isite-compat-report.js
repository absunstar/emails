'use strict';
const fs=require('fs'),os=require('os'),path=require('path');
const aisite=require('..');
const site=aisite({cwd:fs.mkdtempSync(path.join(os.tmpdir(),'aisite-isite-report-')),compatibility:'isite'});

const expectedSite=[
'onGET','onPOST','onPUT','onPATCH','onDELETE','onOPTIONS','onHEAD','onCOPY','onLOCK','onMKCOL','onMOVE','onPROPFIND','onPROPPATCH','onUNLOCK',
'fsm','mongodb','words','word','addFeature','addfeatures','hasFeature','feature','addVar','addVars','vars',
'stringfiy','from123','to123','showObject','requestTelemetry','responseCache','mongoShapes','httpCache','coreV3','coreV18','package','Module','requireFromString',
'security'
];
const collection=site.connectCollection('compat-report');
const expectedCollection=['ObjectID','insert','insertOne','deleteOne','updateMany','findManyConcurrent','findCursorFast','findByIdsFast','explainQuery','invalidateQueryCache','invalidateWriteCaches','handleDoc','distinct'];
const siteMissing=expectedSite.filter(n=>!(n in site));
const collectionMissing=expectedCollection.filter(n=>typeof collection[n]!=='function');

console.log(JSON.stringify({
 version:site.version,
 expectedSite:expectedSite.length,
 sitePresent:expectedSite.length-siteMissing.length,
 siteMissing,
 expectedCollection:expectedCollection.length,
 collectionPresent:expectedCollection.length-collectionMissing.length,
 collectionMissing,
 score:(expectedSite.length-siteMissing.length+expectedCollection.length-collectionMissing.length)/(expectedSite.length+expectedCollection.length)
},null,2));
