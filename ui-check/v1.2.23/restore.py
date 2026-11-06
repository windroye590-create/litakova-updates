from pathlib import Path
import hashlib,os,subprocess,tempfile,zipfile
stage=Path(__file__).resolve().parent
exe=Path('channel/Litakova-Komisiia-PC.exe').resolve()
expected='adbb597ce0c2528803f6e8e08c79f7566e6531c9462982b6b97d26477df0ee90'
if hashlib.sha256(exe.read_bytes()).hexdigest()!=expected:
 assert hashlib.sha256(exe.read_bytes()).hexdigest()=='cd916d94e0d8daf6861a21373ed3821a50131161a31f62799058eef2a7216bbd'
 with tempfile.TemporaryDirectory() as tmp:
  patch=Path(tmp)/'windows.patch';patch.write_bytes((stage/'windows.patch').read_bytes().replace(b'\r\n',b'\n'))
  subprocess.run(['git','apply','--check',str(patch)],check=True)
  subprocess.run(['git','apply',str(patch)],check=True)
assert hashlib.sha256(exe.read_bytes()).hexdigest()==expected
archive=stage/'source.zip'
assert hashlib.sha256(archive.read_bytes()).hexdigest()=='ae1951fe9783c3e56ab3f6de85968010240d21a177e906fcb51e3be1395ee323'
root=Path(os.environ['RUNNER_TEMP'])/'litakova-one-attempt23';root.mkdir(exist_ok=True)
with zipfile.ZipFile(archive) as z:
 for name in z.namelist():assert (root/name).resolve().is_relative_to(root)
 z.extractall(root)
with tempfile.TemporaryDirectory() as tmp:
 patch=Path(tmp)/'source.patch';patch.write_bytes((stage/'source.patch').read_bytes().replace(b'\r\n',b'\n'))
 subprocess.run(['git','-c','core.autocrlf=false','apply','--check',str(patch)],cwd=root,check=True)
 subprocess.run(['git','-c','core.autocrlf=false','apply',str(patch)],cwd=root,check=True)
(root/'verification').mkdir(exist_ok=True);(root.parent/'tmp').mkdir(exist_ok=True)
subprocess.run(['python',str(root/'tests/packed_image.py'),str(exe),'--root',str(root),'--metadata',str(stage/'assets.json'),'--output',str(root/'web'),'--check'],check=True)
assert hashlib.sha256((root/'Code.gs').read_bytes()).hexdigest()=='3a14d1f8fef783b627af2d0cc89c52c56904a621c1b784b6aeeb0ab870acd719'
print('Exact 1.2.23 / 146 and API 24 restored; isolated models only; no production requests')
