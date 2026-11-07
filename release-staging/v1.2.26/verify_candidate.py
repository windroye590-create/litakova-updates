"""Verify this unsigned candidate; publication still requires its original key."""
import hashlib
import json
from pathlib import Path
import sys
import zipfile

root=Path(__file__).resolve().parent
manifest=json.loads((root/'candidate-manifest.json').read_text())
assert manifest['version']=='1.2.26' and manifest['versionCode']==149
assert {item['path'] for item in manifest['files']}=={
    'Litakova-Komisiia-PC.exe','Litakova-Komisiia-PC-1.2.26-source.zip'}
for item in manifest['files']:
    data=(root/item['path']).read_bytes()
    assert len(data)==item['bytes'],item['path']+' size differs'
    assert hashlib.sha256(data).hexdigest()==item['sha256'],item['path']+' digest differs'
assert (root/'Litakova-Komisiia-PC.exe').read_bytes().startswith(b'MZ')
destination=Path(sys.argv[1]).resolve()
destination.mkdir(parents=True,exist_ok=True)
with zipfile.ZipFile(root/'Litakova-Komisiia-PC-1.2.26-source.zip') as archive:
    assert archive.testzip() is None
    for member in archive.infolist():
        path=Path(member.filename)
        assert not path.is_absolute() and '..' not in path.parts
        assert (destination/path).resolve().is_relative_to(destination)
        assert 'signing' not in path.parts
        assert path.suffix.lower() not in {'.jks','.p12','.pfx','.key'}
    package=json.loads(archive.read('package.json'))
    assert package['version']=='1.2.26' and package['versionCode']==149
    archive.extractall(destination)
print('Verified candidate 1.2.26 / 149; auto-update catalog signing is a separate gate.')
