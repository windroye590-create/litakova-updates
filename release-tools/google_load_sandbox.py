"""Build a namespaced deployment of the existing server, never its live URL."""
import copy
import json
import re
from pathlib import Path
from appscript_deploy import require, server_file, source_info

def candidate_files(files, settings, source):
    """Keep the deployed manifest/files; replace only the validated server."""
    info=source_info(source,settings)
    build='pc-api'+str(info['api'])+'-'+info['sha256'][:16]
    result=copy.deepcopy(files)
    server_file(result)['source']=re.sub(r"serverBuild:\s*'[^']+'", "serverBuild: '"+build+"'", source)
    return result

def sandbox_files(files, settings, namespace, secret, private_id, public_id):
    require(re.fullmatch(r'LK_LT_[0-9a-f]{20}_', namespace), 'Invalid test namespace')
    require(re.fullmatch(r'[0-9a-f]{64}', secret), 'Invalid test secret')
    require(private_id != public_id and settings['spreadsheetId'] not in [private_id, public_id], 'Test books must be separate')
    require(all(re.fullmatch(r'[A-Za-z0-9_-]{5,150}', x) for x in [private_id, public_id]), 'Invalid test book ID')
    result=copy.deepcopy(files)
    server=server_file(result)
    source_info(server['source'], settings)
    server['source'], count=re.subn(r"^const SPREADSHEET_ID = '[^']+';", 'const SPREADSHEET_ID = '+json.dumps(private_id)+';', server['source'], flags=re.M)
    require(count == 1, 'Database replacement was not unique')
    for name in ['doPost', 'doGet']:
        server['source'], count=re.subn(r'\bfunction '+name+r'\s*\(', 'function loadTestOriginal'+name[0].upper()+name[1:]+'_(', server['source'])
        require(count == 1, 'Entrypoint replacement was not unique')
    stages=['requireSession_','getTestById_','pcStateMetadata_','pcStateRead_','pcStateWrite_','readResultRecord_','submitResult_','flushRequestWrites_','drainPublicResults_','signText_']
    wrappers=[]
    for name in stages:
        renamed='loadTestActual_'+name
        server['source'],count=re.subn(r'\bfunction '+name+r'\s*\(','function '+renamed+'(',server['source'])
        require(count==1,'Timing hook was not unique: '+name)
        wrappers.append('function '+name+'(){return loadTestStage_('+json.dumps(name)+','+renamed+',arguments);}')
    server['source']+='\n'+'\n'.join(wrappers)+'\n'
    replacements={'PropertiesService.getScriptProperties()':'loadTestProperties_()', 'CacheService.getScriptCache()':'loadTestCache_()', 'LockService.getScriptLock()':'loadTestLock_()'}
    for item in result:
        if item['type']!='SERVER_JS': continue
        for before, after in replacements.items():item['source']=item['source'].replace(before,after)
        require(settings['spreadsheetId'] not in item['source'], 'Production database remains in test source')
        require(not re.search(r'(?:PropertiesService\.get(?:Script|User|Document)Properties|CacheService\.getScriptCache|LockService\.getScriptLock)\s*\(',item['source']), 'An unisolated service call remains')
    require(not any(f['name']=='LoadTestHarness' for f in result), 'Harness filename already exists')
    harness=(Path(__file__).parent/'load_test_harness.gs').read_text()
    for key,value in [('NAMESPACE',namespace),('SECRET',secret),('PRIVATE',private_id),('PUBLIC',public_id)]:harness=harness.replace('__LT_'+key+'__',json.dumps(value))
    result.append({'name':'LoadTestHarness','type':'SERVER_JS','source':harness})
    return result
