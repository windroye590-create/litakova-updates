from pathlib import Path
import hashlib
import shutil
import subprocess
import tempfile

stage = Path(__file__).resolve().parent
repo = stage.parents[1]
exe = repo / 'channel/Litakova-Komisiia-PC.exe'
expected = '936f9f69e8862f2143edc84528f5ddfdbe666ad597df00b87ce47e8b7b08f31b'
base = 'fe184e32251331adb8409898167cfecf6d11a3ce985e68179c41f26177995285'
digest = hashlib.sha256(exe.read_bytes()).hexdigest()
if digest != expected:
    assert digest == base, 'Unexpected base release; refuse to overwrite it'
    with tempfile.TemporaryDirectory(prefix='lk-release-patch-') as folder:
        patch = Path(folder) / 'windows.patch'
        patch.write_bytes((stage / 'windows.patch').read_bytes().replace(b'\r\n', b'\n'))
        subprocess.run(['git', 'apply', '--check', str(patch)], cwd=repo, check=True)
        subprocess.run(['git', 'apply', str(patch)], cwd=repo, check=True)
assert hashlib.sha256(exe.read_bytes()).hexdigest() == expected
for name in ['updates.txt', 'index.html']:
    shutil.copyfile(stage / name, repo / 'channel' / name)
shutil.copyfile(stage / 'release-notes.md', repo / 'release-notes.md')
print('Restored exact signed Windows 1.2.18 / 141 bundle')
