from pathlib import Path
import hashlib
import json
import subprocess
import tempfile

stage = Path(__file__).resolve().parent
repo = stage.parents[1]
info = json.loads((stage / 'candidate.json').read_text())
exe = repo / 'channel/Litakova-Komisiia-PC.exe'
digest = hashlib.sha256(exe.read_bytes()).hexdigest()
if digest != info['candidateSHA256']:
    assert digest == info['baseSHA256'], 'Unexpected base EXE; refuse to replace it'
    with tempfile.TemporaryDirectory(prefix='lk-ci-patch-') as directory:
        patch = Path(directory) / 'candidate.patch'
        patch.write_bytes((stage / 'candidate.patch').read_bytes().replace(b'\r\n', b'\n'))
        subprocess.run(['git', 'apply', '--check', str(patch)], cwd=repo, check=True)
        subprocess.run(['git', 'apply', str(patch)], cwd=repo, check=True)
assert hashlib.sha256(exe.read_bytes()).hexdigest() == info['candidateSHA256']
assert exe.stat().st_size == info['bytes']
print('Restored exact CI candidate. No release or channel manifest was changed.')
