from pathlib import Path
import hashlib,os,shutil,subprocess,tempfile,zipfile
stage=Path(__file__).resolve().parent
exe=Path('channel/Litakova-Komisiia-PC.exe').resolve()
expected='182354d561b4f0c046d1c6d5d93ae0566e3487c99f91a5eed3d24763959a776c'
if hashlib.sha256(exe.read_bytes()).hexdigest()!=expected:
 assert hashlib.sha256(exe.read_bytes()).hexdigest()=='80b41db35d0da51cc05233f5f873813a6d05be6b062a5998e2004a7d44185c40'
 with tempfile.TemporaryDirectory() as tmp:
  patch=Path(tmp)/'windows.patch';patch.write_bytes((stage/'windows.patch').read_bytes().replace(b'\r\n',b'\n'))
  subprocess.run(['git','apply','--check',str(patch)],check=True)
  subprocess.run(['git','apply',str(patch)],check=True)
assert hashlib.sha256(exe.read_bytes()).hexdigest()==expected
archive=stage/'source.zip'
assert hashlib.sha256(archive.read_bytes()).hexdigest()=='ae1951fe9783c3e56ab3f6de85968010240d21a177e906fcb51e3be1395ee323'
root=Path(os.environ['RUNNER_TEMP'])/'litakova-ui21';root.mkdir(exist_ok=True)
with zipfile.ZipFile(archive) as z:
 for name in z.namelist():assert (root/name).resolve().is_relative_to(root)
 z.extractall(root)
for name in ['package.json','tests/materials-ui.mjs','native/update_protocol.h']:shutil.copyfile(stage/name,root/name)
(root/'verification').mkdir(exist_ok=True);(root.parent/'tmp').mkdir(exist_ok=True)
subprocess.run(['python',str(root/'tests/packed_image.py'),str(exe),'--root',str(root),'--metadata',str(stage/'assets.json'),'--output',str(root/'web'),'--check'],check=True)
assert hashlib.sha256((root/'Code.gs').read_bytes()).hexdigest()=='f6aeb3b93e48a6658f401a62b20dba7424c0ed076295a4987cdaee87909b882b'
print('Exact 1.2.21 / 144 assets restored; API 23 unchanged; no live data writes')
