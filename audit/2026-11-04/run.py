from pathlib import Path
import json,os,shutil,subprocess,sys,time
root=Path(os.environ['RUNNER_TEMP'])/'litakova-full-audit'
chrome=shutil.which('google-chrome') or shutil.which('chromium')
assert chrome
suites={
 'standard':['ui','materials-ui','written-ui','results-ui','office','responsive-ui','updates-ui','instructors-ui'],
 'extended':['performance-ui','large-tests-ui','review-presence-ui','test-access-intake-ui','public-table-sync-ui','private-storage-ui','packaged-startup'],
 'stress':['deep-stress-browser']}
exe=Path('channel/Litakova-Komisiia-PC.exe').resolve()
env={**os.environ,'LITAKOVA_CHROMIUM_EXECUTABLE':chrome,'CHROMIUM_PATH':chrome,'PACKED_EXE':str(exe),'PACKED_METADATA':str(Path(__file__).resolve().parent/'assets.json')}
results=[]
for name in suites[sys.argv[1]]:
 start=time.time()
 print('SUITE_START '+name,flush=True)
 try:r=subprocess.run(['node',str(root/'tests'/(name+'.mjs'))],cwd=root,env=env,timeout=420);code=r.returncode
 except subprocess.TimeoutExpired:code='timeout'
 results.append({'suite':name,'exitCode':code,'seconds':time.time()-start})
 print('SUITE_RESULT '+json.dumps(results[-1]),flush=True)
print('AUDIT_RESULTS '+json.dumps(results),flush=True)
raise SystemExit(0 if all(r['exitCode']==0 for r in results) else 1)
