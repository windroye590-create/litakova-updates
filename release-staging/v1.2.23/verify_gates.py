import json,os
from urllib.request import Request,urlopen
repo='windroye590-create/litakova-updates'
def github(path):
 req=Request('https://api.github.com/repos/'+repo+path,headers={'Authorization':'Bearer '+os.environ['GITHUB_TOKEN'],'Accept':'application/vnd.github+json','User-Agent':'Litakova-verified-release'})
 with urlopen(req,timeout=45) as response:return json.load(response)
run=github('/actions/runs/42213958203')
assert run['head_sha']=='8df5cc787ba415126eb3cc6e360aed37e732d217' and run['status']=='completed' and run['conclusion']=='success'
jobs=github('/actions/runs/42213958203/jobs?per_page=100')['jobs']
for name in ['browser (standard)','browser (review)','windows','models']:
 selected=[j for j in jobs if j['name']==name]
 assert len(selected)==1 and selected[0]['conclusion']=='success',name+' verification missing'
print(json.dumps({'verifiedRun':run['id'],'sha':run['head_sha'],'browserAndWindows':True}))
url='https://script.google.com/macros/s/AKfycbxthXT1noK9KVJGiqgLOu8L5HgUI8olKC4cySBYM8Yaj4Um8Usm0OgqzZeC1pt5csh7VQ/exec'
with urlopen(url,timeout=45) as response:health=json.load(response)
assert health.get('ok') is True and health.get('version')==24 and health.get('serverBuild')=='pc-1.2.23-single-attempt' and health.get('singleAttempt') is True and health.get('privateLocalStorage') is True,'Single-attempt API 24 is not active'
print(json.dumps({'backendVersion':24,'serverBuild':health['serverBuild'],'singleAttempt':True}))
