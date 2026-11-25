"""Create and retire a guarded, namespaced test deployment; no production writes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import time
from urllib.parse import urlencode
from urllib.request import Request

from appscript_deploy import Google, config, content_files, content_hash, inspect, read_json, require
from google_load_sandbox import sandbox_files

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n')
    path.chmod(0o600)

class Drive:
    def __init__(self, google):self.token=google.token
    def call(self, method, path, value=None):
        require(path.startswith('/drive/v3/files'), 'Unexpected Drive path')
        return read_json(Request('https://www.googleapis.com'+path, method=method,
            data=None if value is None else json.dumps(value).encode(),
            headers={'Authorization':'Bearer '+self.token,'Content-Type':'application/json'}))
    def create(self, namespace, kind):
        value=self.call('POST','/drive/v3/files?fields=id,name,mimeType,appProperties',
            {'name':'Літакова — контроль навантаження — '+kind+' — '+namespace,
             'mimeType':'application/vnd.google-apps.spreadsheet',
             'appProperties':{'litakovaLoadRun':namespace,'litakovaLoadKind':kind}})
        require(value.get('id') and value.get('mimeType')=='application/vnd.google-apps.spreadsheet','Test spreadsheet creation failed')
        return value['id']
    def trash(self, file_id, namespace, kind):
        value=self.call('GET','/drive/v3/files/'+file_id+'?fields=id,mimeType,trashed,appProperties')
        require(value.get('appProperties')=={'litakovaLoadRun':namespace,'litakovaLoadKind':kind},'Refusing to trash an unowned test file')
        if not value.get('trashed'):self.call('PATCH','/drive/v3/files/'+file_id+'?fields=id,trashed',{'trashed':True})

def control(state, action, extra=None):
    body={'action':action,'loadTestKey':state['secret'],**(extra or {})}
    reply=read_json(Request(state['webAppUrl'],data=json.dumps(body).encode(),headers={'Content-Type':'application/json'},method='POST'))
    require(reply.get('ok') is True,'Sandbox control failed: '+str(reply.get('code','UNKNOWN')))
    return reply

def restore_head(client, state, path):
    if not state.get('headTouched'):return
    base='/v1/projects/'+state['scriptId']
    actual=content_files(client.call('GET',base+'/content'))
    current=content_hash(actual)
    if current==state['testHeadSHA256']:
        client.call('PUT',base+'/content',{'files':state['originalHead']})
    else:require(current==state['originalHeadSHA256'],'Another actor edited HEAD; refusing to overwrite it')
    restored=content_files(client.call('GET',base+'/content'))
    require(content_hash(restored)==state['originalHeadSHA256'],'Original HEAD was not restored')
    state['headTouched']=False;state['headRestored']=True;save(path,state)

def production_unchanged(client, state):
    base='/v1/projects/'+state['scriptId']
    current=client.call('GET',base+'/deployments/'+state['productionDeploymentId'])
    require(current['deploymentConfig']==state['productionDeploymentConfig'],'Production deployment configuration changed')
    head=content_files(client.call('GET',base+'/content'))
    require(content_hash(head)==state['originalHeadSHA256'],'Production project HEAD changed')

def setup(path, report_path, count):
    require(20<=count<=27,'Only 20–27 test clients are supported')
    settings=config();client=Google(os.environ.get('GAS_CREDENTIALS',''));drive=Drive(client)
    base,deployment,version,head,deployed,info=inspect(client,settings)
    require(content_hash(head)==content_hash(deployed),'Project contains unpublished edits; test setup stopped')
    state={'namespace':'LK_LT_'+secrets.token_hex(10)+'_','secret':secrets.token_hex(32),'clients':count,
           'scriptId':settings['scriptId'],'productionDeploymentId':settings['deploymentId'],
           'productionDeploymentConfig':deployment['deploymentConfig'],'productionVersion':version,
           'productionBuild':info['build'],'originalHead':head,'originalHeadSHA256':content_hash(head),
           'createdBooks':{},'headTouched':False,'productionDataWrites':0}
    print('::add-mask::'+state['secret'],flush=True)
    save(path,state)
    try:
        for kind in ['private','public']:
            file_id=drive.create(state['namespace'],kind)
            require(file_id!=settings['spreadsheetId'],'Test file aliases production')
            state['createdBooks'][kind]=file_id;save(path,state)
        files=sandbox_files(deployed,settings,state['namespace'],state['secret'],state['createdBooks']['private'],state['createdBooks']['public'])
        state['testHeadSHA256']=content_hash(files)
        require(content_hash(content_files(client.call('GET',base+'/content')))==state['originalHeadSHA256'],'HEAD changed during test preparation')
        state['headTouched']=True;save(path,state)
        try:
            client.call('PUT',base+'/content',{'files':files})
            created=client.call('POST',base+'/versions',{'description':'Isolated load test '+state['namespace']})
            require(isinstance(created.get('versionNumber'),int),'No test version returned')
            state['testVersion']=created['versionNumber'];save(path,state)
            target=client.call('POST',base+'/deployments',{'versionNumber':state['testVersion'],'manifestFileName':deployment['deploymentConfig'].get('manifestFileName','appsscript'),'description':'Isolated load test '+state['namespace']})
            state['testDeploymentId']=target['deploymentId']
            require(state['testDeploymentId']!=settings['deploymentId'],'Refusing to use production deployment')
            state['webAppUrl']='https://script.google.com/macros/s/'+state['testDeploymentId']+'/exec';save(path,state)
        finally:restore_head(client,state,path)
        production_unchanged(client,state)
        # Only the guarded test URL receives initialization requests.
        seeded=control(state,'load-test-seed')
        require(isinstance(seeded.get('inviteCode'),str) and seeded['inviteCode'],'No isolated instructor code')
        state['inviteCode']=seeded['inviteCode'];state['initialCacheKeys']=seeded.get('loadTestMetrics',{}).get('cacheKeys',[]);save(path,state)
        save(path.parent/'cache-keys.json',state['initialCacheKeys'])
        summary={'status':'ready','namespace':state['namespace'],'clients':count,'productionVersionPreserved':version,
                 'productionBuildPreserved':info['build'],'headRestored':True,'separatePrivateAndPublicBooks':True,
                 'sharedGoogleAccountAndScriptLock':True,'productionDataWrites':0}
        save(report_path/'setup.json',summary)
        print(json.dumps(summary),flush=True)
    except Exception:
        if state.get('headTouched'):restore_head(client,state,path)
        raise

def cleanup(path, report_path):
    if not path.exists():return
    state=json.loads(path.read_text());client=Google(os.environ.get('GAS_CREDENTIALS',''));drive=Drive(client)
    settings=config()
    require(state['scriptId']==settings['scriptId'] and state['productionDeploymentId']==settings['deploymentId'],'Cleanup target differs from configured project')
    restore_head(client,state,path)
    result={'status':'passed','productionDeploymentPreserved':False,'headRestored':False,'booksTrashed':[],'testDeploymentDeleted':False,'namespacePurged':False}
    failures=[]
    if state.get('webAppUrl'):
        keys_path=path.parent/'cache-keys.json'
        keys=json.loads(keys_path.read_text()) if keys_path.exists() else []
        journal=path.parent/'cache-keys.ndjson'
        if journal.exists():keys+= [json.loads(line) for line in journal.read_text().splitlines() if line.strip()]
        keys=list(set(keys))
        try:
            purged=control(state,'load-test-purge',{'cacheKeys':keys})
            result['namespacePurged']=True;result['removedProperties']=purged['removedProperties'];result['removedCacheKeys']=purged['removedCacheKeys']
        except Exception as error:failures.append('Namespace cleanup: '+str(error))
    if state.get('testDeploymentId'):
        try:
            require(state['testDeploymentId']!=settings['deploymentId'],'Refusing to remove production deployment')
            client.call('DELETE','/v1/projects/'+state['scriptId']+'/deployments/'+state['testDeploymentId'])
            result['testDeploymentDeleted']=True
        except Exception as error:failures.append('Test deployment cleanup: '+str(error))
    for kind,file_id in state['createdBooks'].items():
        try:
            require(file_id!=settings['spreadsheetId'],'Refusing to trash the production database')
            drive.trash(file_id,state['namespace'],kind);result['booksTrashed'].append(kind)
        except Exception as error:failures.append('Test file cleanup '+kind+': '+str(error))
    try:production_unchanged(client,state);result['productionDeploymentPreserved']=result['headRestored']=True
    except Exception as error:failures.append(str(error))
    if failures:result['status']='cleanup_incomplete';result['errors']=failures
    save(report_path/'cleanup.json',result);print(json.dumps(result),flush=True)
    require(not failures,'Test cleanup needs attention; see the bounded cleanup report')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('operation',choices=['setup','cleanup']);p.add_argument('--state',type=Path,required=True);p.add_argument('--report-dir',type=Path,required=True);p.add_argument('--clients',type=int,default=27)
    a=p.parse_args()
    try:
        if a.operation=='setup':setup(a.state,a.report_dir,a.clients)
        else:cleanup(a.state,a.report_dir)
    except Exception as error:
        # Google helpers deliberately omit OAuth values and raw response bodies.
        print(type(error).__name__+': '+str(error),flush=True);raise SystemExit(1)
