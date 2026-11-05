from pathlib import Path
import hashlib,os,subprocess,tempfile,zipfile
stage=Path(__file__).resolve().parent
archive=stage/'source.zip'
assert hashlib.sha256(archive.read_bytes()).hexdigest()=='ae1951fe9783c3e56ab3f6de85968010240d21a177e906fcb51e3be1395ee323'
exe=Path('channel/Litakova-Komisiia-PC.exe').resolve()
expected='80b41db35d0da51cc05233f5f873813a6d05be6b062a5998e2004a7d44185c40'
if hashlib.sha256(exe.read_bytes()).hexdigest()!=expected:
 assert hashlib.sha256(exe.read_bytes()).hexdigest()=='ad83434092e50a07d7e9865381e94ad34d472bfb33d2ff39c189dea2b982cbe9'
 with tempfile.TemporaryDirectory() as tmp:
  patch=Path(tmp)/'windows.patch';patch.write_bytes((stage/'windows.patch').read_bytes().replace(b'\r\n',b'\n'))
  subprocess.run(['git','apply','--check',str(patch)],check=True)
  subprocess.run(['git','apply',str(patch)],check=True)
assert hashlib.sha256(exe.read_bytes()).hexdigest()==expected
root=Path(os.environ['RUNNER_TEMP'])/'litakova-full-audit';root.mkdir(exist_ok=True)
with zipfile.ZipFile(archive) as z:
 for n in z.namelist():assert (root/n).resolve().is_relative_to(root)
 z.extractall(root)
(root/'verification').mkdir(exist_ok=True);(root.parent/'stress-2026-10-28').mkdir(exist_ok=True)
subprocess.run(['python',str(root/'tests/packed_image.py'),str(exe),'--root',str(root),'--metadata',str(stage/'assets.json'),'--output',str(root/'web'),'--check'],check=True)
assert hashlib.sha256((root/'Code.gs').read_bytes()).hexdigest()=='f6aeb3b93e48a6658f401a62b20dba7424c0ed076295a4987cdaee87909b882b'
print('Prepared 1.2.20 / 143 and API 23 sources verified; no live writes')
