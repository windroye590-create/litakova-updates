"""Create and retire a guarded, namespaced test deployment; no production writes."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import secrets
import re
import io
import zipfile
import xml.etree.ElementTree as ET
import time
from urllib.parse import urlencode
from urllib.request import Request, build_opener
from urllib.error import HTTPError
from github_release import SafeRedirect

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
    def credential_shapes(self, file_id):
        # This method is called only after the observer proves the book is ours.
        url='https://www.googleapis.com/drive/v3/files/'+file_id+'/export?'+urlencode({'mimeType':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})
        with build_opener(SafeRedirect()).open(Request(url,headers={'Authorization':'Bearer '+self.token}),timeout=60) as response:raw=response.read(10*1024*1024+1)
        require(len(raw)<=10*1024*1024,'Synthetic book export exceeds its diagnostic bound')
        ns={'x':'http://schemas.openxmlformats.org/spreadsheetml/2006/main','r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
        with zipfile.ZipFile(io.BytesIO(raw)) as book:
            workbook=ET.fromstring(book.read('xl/workbook.xml'));sheets=[s for s in workbook.findall('x:sheets/x:sheet',ns) if s.get('name')=='_Користувачі'];require(len(sheets)==1,'Synthetic users sheet not found')
            relationship=sheets[0].get('{'+ns['r']+'}id');rels=ET.fromstring(book.read('xl/_rels/workbook.xml.rels'));target=next(r.get('Target') for r in rels if r.get('Id')==relationship)
            target=target.lstrip('/') if target.startswith('/') else 'xl/'+target
            strings=[]
            if 'xl/sharedStrings.xml' in book.namelist():strings=[''.join(s.itertext()) for s in ET.fromstring(book.read('xl/sharedStrings.xml'))]
            shapes=[]
            for row in ET.fromstring(book.read(target)).findall('x:sheetData/x:row',ns):
                if row.get('r')=='1':continue
                cells={}
                for cell in row:
                    column=re.match(r'[A-Z]+',cell.get('r','')).group();kind=cell.get('t','n');node=cell.find('x:v',ns);value=node.text if node is not None else ''
                    if kind=='s':value=strings[int(value)]
                    elif kind=='inlineStr':value=''.join(cell.itertext())
                    cells[column]=(kind,value or '')
                if not cells.get('A',('', ''))[1]:continue
                shapes.append({'userId':cells['A'][1],'role':cells.get('E',('', ''))[1],
                    'hashLength':len(cells.get('F',('', ''))[1]),'saltLength':len(cells.get('G',('', ''))[1]),
                    'hashCellType':cells.get('F',('', ''))[0],'saltCellType':cells.get('G',('', ''))[0]})
        return shapes

def control(state, action, extra=None):
    body={'action':action,'loadTestKey':state['secret'],**(extra or {})}
    try:
        with build_opener(SafeRedirect()).open(Request(state['webAppUrl'],data=json.dumps(body).encode(),headers={'Content-Type':'application/json'},method='POST'),timeout=330) as response:
            raw=response.read(8*1024*1024+1)
        require(len(raw)<=8*1024*1024,'Sandbox control response too large')
        reply=json.loads(raw)
    except HTTPError as error:raise RuntimeError('Sandbox control failed: HTTP '+str(error.code)) from None
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
            print('Created isolated '+kind+' spreadsheet',flush=True)
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
        print('Temporary deployment created; original project HEAD restored',flush=True)
        production_unchanged(client,state)
        # Only the guarded test URL receives initialization requests.
        seeded=control(state,'load-test-seed')
        require(isinstance(seeded.get('inviteCode'),str) and seeded['inviteCode'],'No isolated instructor code')
        state['inviteCode']=seeded['inviteCode'];state['initialCacheKeys']=seeded.get('loadTestMetrics',{}).get('cacheKeys',[]);save(path,state)
        save(path.parent/'cache-keys.json',state['initialCacheKeys'])
        reaped=control(state,'load-test-reap');state['orphanTestKeysRemoved']=reaped['removedProperties'];save(path,state)
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

def observe(report_path):
    settings=config();client=Google(os.environ.get('GAS_CREDENTIALS',''));base='/v1/projects/'+settings['scriptId']
    deployments=client.call('GET',base+'/deployments').get('deployments',[])
    candidates=[item for item in deployments if item['deploymentId']!=settings['deploymentId'] and re.fullmatch(r'Isolated load test LK_LT_[0-9a-f]{20}_',item['deploymentConfig'].get('description',''))]
    if not candidates:
        result={'status':'no_active_test','productionDataReads':0,'productionDataWrites':0}
    else:
        require(len(candidates)==1,'Multiple test deployments; observer stopped')
        item=candidates[0];files=content_files(client.call('GET',base+'/content?versionNumber='+str(item['deploymentConfig']['versionNumber'])))
        matches=[file for file in files if file['name']=='LoadTestHarness' and file['type']=='SERVER_JS'];require(len(matches)==1,'No test guard found')
        source=matches[0]['source']
        def value(name):
            found=re.findall(r'^var LT_'+name+r' = ("[^"]+");$',source,re.M);require(len(found)==1,'Invalid test guard identity');return json.loads(found[0])
        namespace,secret,private_id,public_id=[value(name) for name in ['NAMESPACE','SECRET','PRIVATE','PUBLIC']]
        require(item['deploymentConfig']['description']=='Isolated load test '+namespace,'Namespace differs from deployment')
        require(settings['spreadsheetId'] not in [private_id,public_id] and private_id!=public_id,'Observer cannot read production books')
        drive=Drive(client)
        for file_id,kind in [(private_id,'private'),(public_id,'public')]:
            meta=drive.call('GET','/drive/v3/files/'+file_id+'?fields=id,appProperties,trashed')
            require(meta.get('appProperties')=={'litakovaLoadRun':namespace,'litakovaLoadKind':kind} and not meta.get('trashed'),'Observer target is not the active test')
        snapshot=control({'secret':secret,'webAppUrl':'https://script.google.com/macros/s/'+item['deploymentId']+'/exec'},'load-test-inspect')['snapshot']
        tests={}
        for row in snapshot['privateRows']:
            entry=tests.setdefault(row['testId'],{'works':0,'questions':row['total'],'pendingPublication':0});entry['works']+=1;entry['pendingPublication']+=int(row['publicState']=='pending')
        result={'status':'observed','namespace':namespace,'authoritativeResults':len(snapshot['privateRows']),'publicResults':len(snapshot['publicResultIds']),'byTest':tests,
                'scriptFileNames':[file['name'] for file in files],'productionDataReads':0,'productionDataWrites':0}
        try:result['syntheticCredentialShapes']=drive.credential_shapes(private_id)
        except Exception as error:result['credentialShapeDiagnostic']=type(error).__name__
    save(report_path/'observation.json',result);print(json.dumps(result),flush=True)

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('operation',choices=['setup','cleanup','observe']);p.add_argument('--state',type=Path,required=True);p.add_argument('--report-dir',type=Path,required=True);p.add_argument('--clients',type=int,default=27)
    a=p.parse_args()
    try:
        if a.operation=='setup':setup(a.state,a.report_dir,a.clients)
        elif a.operation=='cleanup':cleanup(a.state,a.report_dir)
        else:observe(a.report_dir)
    except Exception as error:
        # Google helpers deliberately omit OAuth values and raw response bodies.
        print(type(error).__name__+': '+str(error),flush=True);raise SystemExit(1)
