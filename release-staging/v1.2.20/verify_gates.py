import json,os
from urllib.request import Request,urlopen
repo='windroye590-create/litakova-updates'
def github(path):
 req=Request('https://api.github.com/repos/'+repo+path,headers={'Authorization':'Bearer '+os.environ['GITHUB_TOKEN'],'Accept':'application/vnd.github+json','User-Agent':'Litakova-verified-release'})
 with urlopen(req,timeout=45) as response:return json.load(response)
def check_run(run_id,sha,required,all_success=False):
 run=github('/actions/runs/'+str(run_id))
 assert run['head_sha']==sha and run['status']=='completed' and run['event']=='push'
 if all_success:assert run['conclusion']=='success'
 jobs=github('/actions/runs/'+str(run_id)+'/jobs?per_page=100')['jobs']
 for name in required:
  selected=[j for j in jobs if j['name']==name]
  assert len(selected)==1 and selected[0]['conclusion']=='success',name+' verification missing'
 print(json.dumps({'verifiedRun':run_id,'head':sha,'requiredJobs':required}))
check_run(42097372794,'be3e0ef86df337f4790468c85a4eeba4bb737e71',['native','windows','model','chromium (extended)','chromium (stress)'])
check_run(42099181511,'0f6879cd26a96e7d4e9532283ab5a456c34f209a',['pdf'],all_success=True)
url='https://script.google.com/macros/s/AKfycbxthXT1noK9KVJGiqgLOu8L5HgUI8olKC4cySBYM8Yaj4Um8Usm0OgqzZeC1pt5csh7VQ/exec'
with urlopen(url,timeout=45) as response:health=json.load(response)
assert health.get('ok') is True and health.get('version')==23 and health.get('serverBuild')=='pc-1.2.20-audit-reliability' and health.get('privateLocalStorage') is True,'Compatible API 23 is not active'
print(json.dumps({'backendVersion':health['version'],'serverBuild':health['serverBuild'],'sameDeployment':True}))
