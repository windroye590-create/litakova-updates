"""Run the real Windows host against an isolated synthetic local data directory."""
import ctypes,json,os,pathlib,shutil,subprocess,sys,tempfile,time,urllib.request,urllib.parse
if sys.platform!='win32':raise SystemExit('This smoke test requires Windows')
exe=pathlib.Path(sys.argv[1]).resolve()
checks=[]
with tempfile.TemporaryDirectory(prefix='lk-native-ci-') as scratch:
 scratch=pathlib.Path(scratch);data=scratch/'data';data.mkdir()
 # A known Windows executable substitutes only for launching a browser. It
 # never renders the app and therefore cannot make production RPC calls.
 browser=scratch/'programs/Microsoft/Edge/Application/msedge.exe';browser.parent.mkdir(parents=True)
 shutil.copyfile(pathlib.Path(os.environ['SystemRoot'])/'System32/where.exe',browser)
 env=os.environ.copy();env.update(LOCALAPPDATA=str(data),ProgramFiles=str(scratch/'programs'))
 env['ProgramFiles(x86)']=str(scratch/'programs')
 process=subprocess.Popen([str(exe)],env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 folder=data/'LitakovaKomisiiaPC';launch=folder/'launch.txt';origin=None;secret=None
 try:
  until=time.monotonic()+30
  while time.monotonic()<until:
   if process.poll() is not None:raise AssertionError('The Windows host exited before initialization')
   if launch.exists():
    text=launch.read_bytes().decode('utf-16-le').rstrip('\0');parsed=urllib.parse.urlsplit(text)
    origin=urllib.parse.urlunsplit((parsed.scheme,parsed.netloc,'','',''));secret=urllib.parse.parse_qs(parsed.query)['key'][0];break
   time.sleep(.1)
  assert origin and secret,'The isolated host did not create its local launch receipt'
  def request(path,value=None):
   raw=None if value is None else json.dumps(value,ensure_ascii=False,separators=(',',':')).encode()
   req=urllib.request.Request(origin+path,data=raw,headers={'X-LK-Key':secret,'Content-Type':'application/json'})
   with urllib.request.urlopen(req,timeout=10) as r:return json.loads(r.read())
  def passed(name):checks.append(name);print('PASS '+name)
  assert request('/state')=={};assert request('/journal')=={};passed('New Windows profile starts without fabricated read errors')
  state={'version':1,'session':None,'accounts':{'ci-user':{'pending':[{'submissionId':'ci-preserved','answer':'Збережена відповідь Windows'}]}}}
  assert request('/state',state)['ok'];assert request('/state')==state
  statefile=folder/'state.bin';assert 'Збережена відповідь Windows'.encode() not in statefile.read_bytes();passed('Real Windows DPAPI encrypts and restores queued answers')
  journal={'serial':11,'kind':'run','userId':'ci-user','submissionId':'ci-preserved','revision':1,'answers':{str(i):'Ж'*2000 for i in range(20)}}
  assert request('/journal',journal)['ok'];assert request('/journal')==journal;passed('A large Unicode journal survives real encrypted storage')
  assert request('/journal',{**journal,'serial':10,'answers':{'old':'stale'}})['ok'];assert request('/journal')==journal;passed('Older checkpoint writes cannot replace the acknowledged journal')
  kernel=ctypes.WinDLL('kernel32',use_last_error=True);kernel.CreateFileW.restype=ctypes.c_void_p;kernel.CreateFileW.argtypes=[ctypes.c_wchar_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p,ctypes.c_uint32,ctypes.c_uint32,ctypes.c_void_p];kernel.CloseHandle.argtypes=[ctypes.c_void_p]
  handle=kernel.CreateFileW(str(statefile),0x80000000,0,None,3,0x80,None);assert handle not in (None,ctypes.c_void_p(-1).value)
  try:assert request('/state').get('code')=='STORAGE_READ'
  finally:kernel.CloseHandle(handle)
  assert request('/state')==state;passed('A real Windows sharing violation reports STORAGE_READ and preserves the profile')
  backup=statefile.read_bytes();statefile.write_bytes(b'not-a-valid-DPAPI-packet')
  try:assert request('/state').get('code')=='STORAGE_READ'
  finally:statefile.write_bytes(backup)
  assert request('/state')==state;passed('A corrupt DPAPI packet cannot be mistaken for an empty profile')
  moved=folder/'state.saved';statefile.rename(moved);statefile.mkdir()
  try:assert request('/state').get('code')=='STORAGE_READ'
  finally:statefile.rmdir();moved.rename(statefile)
  assert request('/state')==state;assert request('/journal')==journal;passed('An inaccessible state path never becomes a successful empty read')
  print(json.dumps({'status':'passed','checks':checks,'passed':len(checks),'actualWindowsHostExecuted':True,'realDPAPIVerified':True,'browserRendered':False,'productionRPCRequests':0}))
 finally:
  process.terminate()
  try:process.wait(timeout=10)
  except subprocess.TimeoutExpired:process.kill();process.wait()
