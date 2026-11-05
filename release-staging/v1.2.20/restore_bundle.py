from pathlib import Path
import hashlib,shutil,subprocess,tempfile
stage=Path(__file__).resolve().parent
repo=stage.parents[1]
exe=repo/'channel/Litakova-Komisiia-PC.exe'
expected='80b41db35d0da51cc05233f5f873813a6d05be6b062a5998e2004a7d44185c40'
base='ad83434092e50a07d7e9865381e94ad34d472bfb33d2ff39c189dea2b982cbe9'
actual=hashlib.sha256(exe.read_bytes()).hexdigest()
if actual!=expected:
 assert actual==base,'Unexpected base image; refuse to overwrite it'
 with tempfile.TemporaryDirectory(prefix='lk-release-patch-') as folder:
  patch=Path(folder)/'windows.patch';patch.write_bytes((stage/'windows.patch').read_bytes().replace(b'\r\n',b'\n'))
  subprocess.run(['git','apply','--check',str(patch)],cwd=repo,check=True)
  subprocess.run(['git','apply',str(patch)],cwd=repo,check=True)
assert hashlib.sha256(exe.read_bytes()).hexdigest()==expected
for name in ['updates.txt','index.html']:shutil.copyfile(stage/name,repo/'channel'/name)
shutil.copyfile(stage/'release-notes.md',repo/'release-notes.md')
print('Restored exact signed Windows 1.2.20 / 143 bundle')
