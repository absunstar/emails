
'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const aisite=require('..');

test('iSite v14 collection alias identity groups match',()=>{
 const site=aisite({compatibility:'isite'}),c=site.connectCollection('x');
 const groups=[
  ['add','addOne','insert','insertOne'],
  ['addAll','addMany','insertAll','insertMany'],
  ['count','getCount'],
  ['delete','deleteOne','remove','removeOne'],
  ['deleteAll','deleteMany','removeAll','removeMany'],
  ['deleteDuplicate','removeDuplicate'],
  ['edit','editOne','update','updateOne'],
  ['editAll','editMany','updateAll','updateMany'],
  ['find','findOne','get','getOne','select','selectOne'],
  ['findAll','findMany','getAll','getMany','selectAll','selectMany'],
  ['findManyFast','findManyNoCount'],
  ['findManyFastCached','findManyNoCountCached'],
  ['ObjectID','ObjectId']
 ];
 for(const g of groups)for(const n of g)assert.strictEqual(c[n],c[g[0]],g.join('='));
});

test('iSite v14 collection expanded surface exists',()=>{
 const site=aisite({compatibility:'isite'}),c=site.connectCollection('x');
 const f=['addAsync','aggregate','batchStats','bulkWriteFast','callback','checkTaskList','countAsync','countParallel','createIndex','createUnique',
 'deleteAsync','deleteDuplicate','drop','dropIndex','dropIndexes','enqueueTask','exists','existsAsync','explainFast','export','findByIdBatched',
 'findByIdsBudgeted','findByIdsFast','findByIdsFastCached','findDuplicate','findIdsBatched','findManyAsync','findManyBudgeted','findManyCached',
 'findManyConcurrent','findManyConcurrentCached','findManyFast','findManyFastCached','findManyNoCount','findManyNoCountCached','findManyParallel',
 'findOne','findOneAsync','findOneCached','findOneParallel','findPageBudgeted','findPageFast','findPageFastCached','import','invalidateQueryCache',
 'loadAll','removeDuplicate','scheduleNextTask','streamFast','taskDone','updateAsync'];
 for(const n of f)assert.equal(typeof c[n],'function',n);
});
