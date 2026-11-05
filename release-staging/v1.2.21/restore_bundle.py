from pathlib import Path
import hashlib,shutil,subprocess,tempfile
stage=Path(__file__).resolve().parent
repo=stage.parents[1]
exe=repo/'channel/Litakova-Komisiia-PC.exe'
expected='182354d561b4f0c046d1c6d5d93ae0566e3487c99f91a5eed3d24763959a776c'
base='80b41db35d0da51cc05233f5f873813a6d05be6b062a5998e2004a7d44185c40'
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
print('Restored exact signed Windows 1.2.21 / 144 bundle')
