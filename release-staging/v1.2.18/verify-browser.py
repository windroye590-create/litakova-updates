from pathlib import Path
import json
import os
import shutil
import subprocess

stage = Path('release-staging/v1.2.18').resolve()
ci = Path(os.environ['RUNNER_TEMP']) / 'lk-private-release-browser'
shutil.copytree(stage / 'tests', ci / 'tests', dirs_exist_ok=True)
(ci / 'verification').mkdir(parents=True, exist_ok=True)
(ci / 'package.json').write_text(json.dumps({'name': 'litakova-private-release', 'private': True,
    'type': 'module', 'version': '1.2.18', 'versionCode': 141, 'dependencies': {'playwright': '1.62.1'}}))
exe = Path('channel/Litakova-Komisiia-PC.exe').resolve()
metadata = stage / 'assets-1.2.18.json'
subprocess.run(['npm', 'install', '--prefix', str(ci), '--ignore-scripts', '--no-audit', '--no-fund'], check=True)
chrome = shutil.which('google-chrome') or shutil.which('chromium') or shutil.which('chromium-browser')
assert chrome, 'Actual Chromium is required'
env = {**os.environ, 'CHROMIUM_PATH': chrome, 'PACKED_EXE': str(exe), 'PACKED_METADATA': str(metadata)}
for name in ['packaged-startup.mjs', 'private-storage-ui.mjs']:
    subprocess.run(['node', str(ci / 'tests' / name)], check=True, env=env)
for name in ['packaged-startup.json', 'private-storage-ui.json']:
    print((ci / 'verification' / name).read_text())
