"""Check the published update with the actual previous Windows host in isolation."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

if sys.platform!='win32':
    raise SystemExit('This check requires Windows')
previous='006a7a2aa690f4fb362024e9d9aa91f18a493f8f5347a9a8ab61c2b88c4be256'
expected='ae1c8fbef210207520c08de35669e90f52059bb71ad3ad4b4a7dcdb9e17372d1'
url='https://github.com/windroye590-create/litakova-updates/releases/download/v1.2.25/Litakova-Komisiia-PC.exe'
with tempfile.TemporaryDirectory(prefix='lk-published-update-') as scratch:
    root=Path(scratch)
    executable=root/'Litakova-Komisiia-PC.exe'
    with urllib.request.urlopen(url,timeout=90) as response:
        old=response.read(64*1024*1024+1)
    assert len(old)==9797906 and hashlib.sha256(old).hexdigest()==previous
    executable.write_bytes(old)
    data=root/'data';data.mkdir()
    browser=root/'programs/Microsoft/Edge/Application/msedge.exe'
    browser.parent.mkdir(parents=True)
    shutil.copyfile(Path(os.environ['SystemRoot'])/'System32/whoami.exe',browser)
    env={**os.environ,'LOCALAPPDATA':str(data),'ProgramFiles':str(root/'programs'),'ProgramFiles(x86)':str(root/'programs')}
    process=subprocess.Popen([str(executable)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    try:
        folder=data/'LitakovaKomisiiaPC';launch=folder/'launch.txt'
        until=time.monotonic()+45
        while not launch.exists():
            assert process.poll() is None,'Previous host exited during startup'
            if time.monotonic()>until:raise AssertionError('Missing launch receipt')
            time.sleep(.1)
        parsed=urllib.parse.urlsplit(launch.read_bytes().decode('utf-16-le').rstrip('\0'))
        origin=urllib.parse.urlunsplit((parsed.scheme,parsed.netloc,'','',''))
        secret=urllib.parse.parse_qs(parsed.query)['key'][0]
        def local(path,value=None):
            raw=None if value is None else json.dumps(value).encode()
            request=urllib.request.Request(origin+path,data=raw,headers={'X-LK-Key':secret,'Content-Type':'application/json'})
            with urllib.request.urlopen(request,timeout=15) as response:return json.load(response)
        state=local('/updates/check',{})
        until=time.monotonic()+240;retry=time.monotonic()+5
        while state.get('state')!=3:
            assert process.poll() is None,'Previous host exited during update check'
            if time.monotonic()>until:raise AssertionError('Published update not ready: '+json.dumps(state,ensure_ascii=False))
            time.sleep(.5)
            state=local('/updates/status')
            if state.get('state') in {2,4} and time.monotonic()>retry:
                state=local('/updates/check',{});retry=time.monotonic()+5
        assert state['currentCode']==148 and state['currentVersion']=='1.2.25'
        assert state['code']==149 and state['version']=='1.2.26'
        downloaded=folder/'updates/update.exe'
        assert downloaded.stat().st_size==9803026 and hashlib.sha256(downloaded.read_bytes()).hexdigest()==expected
        assert (folder/'updates/release.txt').read_bytes().startswith(b'LKUPDATE1\n')
        assert hashlib.sha256(executable.read_bytes()).hexdigest()==previous
        report={'status':'passed','previousVersion':'1.2.25','publishedVersion':'1.2.26','previousCode':148,'publishedCode':149,'actualWindowsUpdaterExecuted':True,'originalWindowsRSAVerifierAcceptedCatalog':True,'downloadedExeSHA256':expected,'installationRequested':False,'productionAPIWrites':0}
        output=Path(sys.argv[1]);output.parent.mkdir(parents=True,exist_ok=True)
        output.write_text(json.dumps(report,indent=2)+'\n')
        print(json.dumps(report))
    finally:
        if process.poll() is None:
            subprocess.run(['taskkill','/PID',str(process.pid),'/T','/F'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=False)
        try:process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill();process.wait()
