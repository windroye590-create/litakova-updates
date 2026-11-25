// Test deployments only. This file is never added to the production deployment.
var LT_NAMESPACE = __LT_NAMESPACE__;
var LT_SECRET = __LT_SECRET__;
var LT_PRIVATE = __LT_PRIVATE__;
var LT_PUBLIC = __LT_PUBLIC__;
var ltMetrics = {lockWaitMs:0,lockHeldMs:0,locksAcquired:0,cacheKeys:[],stages:{}};
function loadTestStage_(name,fn,args){var start=Date.now();try{return fn.apply(null,args);}finally{var value=ltMetrics.stages[name]||(ltMetrics.stages[name]={calls:0,milliseconds:0});value.calls++;value.milliseconds+=Date.now()-start;}}
function loadTestProperties_() {
  var native = PropertiesService.getScriptProperties();
  return {
    getProperty:function(key){return native.getProperty(LT_NAMESPACE+key);},
    setProperty:function(key,value){native.setProperty(LT_NAMESPACE+key,String(value));return this;},
    deleteProperty:function(key){native.deleteProperty(LT_NAMESPACE+key);return this;},
    getProperties:function(){var all=native.getProperties(),out={};Object.keys(all).forEach(function(key){if(key.indexOf(LT_NAMESPACE)===0)out[key.slice(LT_NAMESPACE.length)]=all[key];});return out;},
    setProperties:function(values,replace){if(replace)this.deleteAllProperties();var self=this;Object.keys(values).forEach(function(key){self.setProperty(key,values[key]);});return this;},
    deleteAllProperties:function(){var all=this.getProperties(),self=this;Object.keys(all).forEach(function(key){self.deleteProperty(key);});return this;}
  };
}
function loadTestCache_() {
  var native=CacheService.getScriptCache();
  return {
    get:function(key){return native.get(LT_NAMESPACE+key);},
    put:function(key,value,seconds){ltMetrics.cacheKeys.push(key);native.put(LT_NAMESPACE+key,value,seconds);},
    remove:function(key){native.remove(LT_NAMESPACE+key);},
    getAll:function(keys){var out={},self=this;keys.forEach(function(key){var value=self.get(key);if(value!==null)out[key]=value;});return out;},
    putAll:function(values,seconds){var self=this;Object.keys(values).forEach(function(key){self.put(key,values[key],seconds);});},
    removeAll:function(keys){var self=this;keys.forEach(function(key){self.remove(key);});}
  };
}
function loadTestLock_() {
  var native=LockService.getScriptLock(),held=0;
  return {
    tryLock:function(ms){var start=Date.now(),ok=native.tryLock(ms);ltMetrics.lockWaitMs+=Date.now()-start;if(ok){held=Date.now();ltMetrics.locksAcquired++;}return ok;},
    waitLock:function(ms){var start=Date.now();native.waitLock(ms);ltMetrics.lockWaitMs+=Date.now()-start;held=Date.now();ltMetrics.locksAcquired++;},
    releaseLock:function(){if(held){ltMetrics.lockHeldMs+=Date.now()-held;held=0;}native.releaseLock();}
  };
}
function loadTestSnapshot_() {
  var book=SpreadsheetApp.openById(LT_PRIVATE),results=book.getSheetByName(SHEETS.results),pub=SpreadsheetApp.openById(LT_PUBLIC).getSheetByName('Результати курсантів');
  var rows=results&&results.getLastRow()>1?results.getRange(2,1,results.getLastRow()-1,HEADERS.results.length).getValues():[];
  var visible=pub?publicRowsFromSheet_(pub):[];
  return {privateRows:rows.map(function(row){return {id:String(row[0]),userId:String(row[1]),testId:String(row[4]),submissionId:String(row[12]),correct:Number(row[7]),total:Number(row[8]),answers:JSON.parse(String(row[13]||'{}')),publicState:String(row[26]||'')};}),publicResultIds:visible.filter(function(row){return row[7]!=='';}).map(function(row){return String(row[7]);})};
}
function doGet() {return jsonResponse_({ok:true,loadTestSandbox:true,namespace:LT_NAMESPACE});}
function doPost(e) {
  var start=Date.now(),request;
  try{request=JSON.parse(e&&e.postData&&e.postData.contents||'{}');}catch(ignored){}
  if(!request||request.loadTestKey!==LT_SECRET)return jsonResponse_({ok:false,code:'LOAD_TEST_FORBIDDEN'});
  var native=PropertiesService.getScriptProperties();
  if(request.action==='load-test-reap'){
    var all=native.getProperties(),count=0,prefixes={};
    Object.keys(all).forEach(function(key){var match=key.match(/^(LK_LT_[0-9a-f]{20}_)/);if(match&&match[1]!==LT_NAMESPACE){prefixes[match[1]]=true;native.deleteProperty(key);count++;}});
    var cache=CacheService.getScriptCache();Object.keys(prefixes).forEach(function(prefix){['LK_SCHEMA_READY_API25','LK_SCHEMA_READY_PUBLIC_CADETS_V1','LK_SCHEMA_CADET_CARD_V1','LK_SCHEMA_ANSWER_CHANGES_V1','LK_SCHEMA_EXCEL_V1','LK_PUBLIC_SYNC_SUMMARY_V1'].forEach(function(key){cache.remove(prefix+key);});});
    return jsonResponse_({ok:true,removedProperties:count,removedNamespaces:Object.keys(prefixes).length});
  }
  if(request.action==='load-test-purge'){
    var keys=Array.isArray(request.cacheKeys)?request.cacheKeys:[];
    if(keys.length>10000||keys.some(function(key){return typeof key!=='string'||key.length+LT_NAMESPACE.length>250;}))return jsonResponse_({ok:false,code:'BAD_CACHE_KEYS'});
    var cache=CacheService.getScriptCache();keys.forEach(function(key){cache.remove(LT_NAMESPACE+key);});
    var all=native.getProperties(),count=0;Object.keys(all).forEach(function(key){if(key.indexOf(LT_NAMESPACE)===0){native.deleteProperty(key);count++;}});
    return jsonResponse_({ok:true,removedProperties:count,removedCacheKeys:keys.length});
  }
  var reply;
  if(request.action==='load-test-seed'){
    var props=loadTestProperties_();props.setProperty(PUBLIC_RESULTS_PROPERTY,LT_PUBLIC);props.setProperty('LK_EXCEL_LAYOUT_ARMED_V1','1');
    createInitialInstructorCode();reply={ok:true,inviteCode:props.getProperty('INITIAL_INVITE_CODE')};
  }else if(request.action==='load-test-inspect')reply={ok:true,snapshot:loadTestSnapshot_()};
  else reply=JSON.parse(loadTestOriginalDoPost_(e).getContent());
  reply.loadTestMetrics={elapsedMs:Date.now()-start,lockWaitMs:ltMetrics.lockWaitMs,lockHeldMs:ltMetrics.lockHeldMs,locksAcquired:ltMetrics.locksAcquired,cacheKeys:ltMetrics.cacheKeys,stages:ltMetrics.stages};
  return jsonResponse_(reply);
}
