"""Attach verified candidate files to its existing draft; never publish it."""
import hashlib
import json
import os
from pathlib import Path
import sys
import zipfile

root=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(root/'release-tools'))
from github_release import GitHub

stage=Path(__file__).resolve().parent
manifest=json.loads((stage/'candidate-manifest.json').read_text())
for item in manifest['files']:
    raw=(stage/item['path']).read_bytes()
    assert len(raw)==item['bytes'] and hashlib.sha256(raw).hexdigest()==item['sha256']
with zipfile.ZipFile(stage/'Litakova-Komisiia-PC-1.2.26-source.zip') as archive:
    assert archive.read('Code.gs')==(root/'server/Code-1.2.26.gs').read_bytes()
report=json.loads((stage/'verification-1.2.26.json').read_text())
assert report['exe']['sha256']==next(i['sha256'] for i in manifest['files'] if i['path'].endswith('.exe'))
assert report['nodeSuites']=={'total':68,'passed':68}
assert report['windows']['passed']==16 and report['windows']['status']=='passed'
client=GitHub('windroye590-create/litakova-updates',os.environ['GITHUB_TOKEN'])
release=client.release(437766841)
assert release['draft'] is True and release['tag_name']=='v1.2.26-candidate'
assert release['target_commitish']=='repair/reliability-1.2.26'
assets={
    'Litakova-Komisiia-PC.exe':(stage/'Litakova-Komisiia-PC.exe').read_bytes(),
    'Litakova-Komisiia-PC-1.2.26-source.zip':(stage/'Litakova-Komisiia-PC-1.2.26-source.zip').read_bytes(),
    'Code-1.2.26.gs':(root/'server/Code-1.2.26.gs').read_bytes(),
    'verification-1.2.26.json':(stage/'verification-1.2.26.json').read_bytes(),
}
existing={a['name']:a for a in release['assets']}
assert set(existing).issubset(assets),'Unexpected draft files; preserve them for review'
for name,raw in assets.items():
    asset=existing.get(name)
    if asset and asset['state']=='starter' and asset['size']==0:
        client.delete_asset(asset)
        asset=None
    if not asset:
        asset=client.upload(release['id'],name,raw)
    assert asset['state']=='uploaded' and asset['size']==len(raw),name
    assert client.download(asset)==raw,'Uploaded bytes differ: '+name
    print('Verified candidate asset:',name,hashlib.sha256(raw).hexdigest())
assert client.release(release['id'])['draft'] is True
print('Candidate files are attached. The signed auto-update channel was not changed.')
