"""Execute the shipped WinHTTP relay with bounded decoded-stream fault vectors."""
from pathlib import Path
import json
import os
import subprocess
import tempfile

root = Path(__file__).resolve().parents[1]
text = (root / 'native/main.c').read_text()
actual = text[text.index('static BYTE*commission_request('):text.index('#include "updater.h"')]
driver = r'''
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>
typedef unsigned char BYTE;
typedef uint32_t DWORD;
typedef int BOOL;
typedef wchar_t WCHAR;
typedef void* HINTERNET;
typedef int SOCKET;
#define MAX_BODY (8u*1024u*1024u)
static unsigned mode,cursor,total,options,closed,sends,allocations;
static DWORD injectedStatus;
static char*wire;
static char relayed[2048];
static void json(SOCKET s,const char*body){assert(strlen(body)<sizeof(relayed));strcpy(relayed,body);}
static void response(SOCKET s,int status,const char*type,const BYTE*body,DWORD length){assert(status==200&&strcmp(type,"application/json; charset=utf-8")==0);assert(length<sizeof(relayed));memcpy(relayed,body,length);relayed[length]=0;}
static void*allocate(size_t size){allocations++;return calloc(1,size);}
static void zero(void*p,size_t n){memset(p,0,n);}
static void release(void*p){if(p){for(unsigned i=0;i<cursor;i++)assert(((BYTE*)p)[i]==0);free(p);allocations--;}}
static HINTERNET WinHttpOpen(const WCHAR*a,DWORD b,void*c,void*d,DWORD e){assert(wcsstr(a,L"gzip"));return (void*)1;}
static BOOL WinHttpSetTimeouts(HINTERNET a,int b,int c,int d,int e){return 1;}
static HINTERNET WinHttpConnect(HINTERNET a,const WCHAR*b,unsigned short c,DWORD d){assert(wcscmp(b,L"script.google.com")==0&&c==443);return (void*)2;}
static HINTERNET WinHttpOpenRequest(HINTERNET a,const WCHAR*b,const WCHAR*c,void*d,void*e,void*f,DWORD g){assert(wcscmp(b,L"POST")==0&&g==0x00800000);assert(wcsstr(c,L"/macros/s/")==c);return mode==10?0:(void*)3;}
static BOOL WinHttpSetOption(HINTERNET a,DWORD option,void*value,DWORD size){assert(a==(void*)3&&option==118&&size==4&&*(DWORD*)value==1);assert(sends==0);options++;return mode!=1;}
static BOOL WinHttpSendRequest(HINTERNET a,const WCHAR*b,DWORD c,void*d,DWORD e,DWORD f,uint64_t g){assert(options==1);assert(!wcsstr(b,L"Accept-Encoding"));assert(e==f&&e==strlen(d)&&strcmp(d,"{\"submissionId\":\"synthetic-stable-id\"}")==0);sends++;return 1;}
static BOOL WinHttpReceiveResponse(HINTERNET a,void*b){return mode!=6;}
static BOOL WinHttpQueryHeaders(HINTERNET a,DWORD b,void*c,void*d,DWORD*e,void*f){*(DWORD*)d=injectedStatus?injectedStatus:mode==7?429:200;return 1;}
static BOOL WinHttpQueryDataAvailable(HINTERNET a,DWORD*out){if(mode==4&&cursor>0)return 0;*out=total-cursor;if(*out>32768)*out=32768;return 1;}
static BOOL WinHttpReadData(HINTERNET a,void*out,DWORD size,DWORD*got){if(mode==5&&cursor>0)return 0;memcpy(out,wire+cursor,size);cursor+=size;*got=size;return 1;}
static BOOL WinHttpCloseHandle(HINTERNET a){closed++;return 1;}
''' + actual + r'''
int main(void){
 for(mode=0;mode<=10;mode++){
  cursor=options=closed=sends=allocations=0;
  total=mode==2?MAX_BODY:mode==3?MAX_BODY+1:100003;
  wire=malloc(total+1);memset(wire,'A',total);memcpy(wire,"{\"t\":\"",6);wire[total-2]='"';wire[total-1]='}';wire[total]=0;
  if(mode==8)wire[0]='<';if(mode==9)total=0;
  char body[]="{\"submissionId\":\"synthetic-stable-id\"}";
  DWORD length=0,status=0;BYTE*reply=commission_request(body,(DWORD)strlen(body),&length,&status);
  if(mode<=2){assert(reply&&length==total&&memcmp(reply,wire,total)==0&&status==200);zero(reply,length);release(reply);}
  else assert(!reply);
  assert(allocations==0);assert(closed==(mode==10?2u:3u));assert(options==(mode==10?0u:1u));
  if(mode==7)assert(status==429);
  free(wire);printf("PASS decoded-stream vector %u\n",mode);
 }
 const DWORD statuses[]={0,200,204,301,400,401,403,404,408,429,500,502,503,504};
 for(unsigned i=0;i<sizeof(statuses)/sizeof(statuses[0]);i++){
  mode=statuses[i]==0?6:0;cursor=options=closed=sends=allocations=0;injectedStatus=statuses[i];
  char page[]="<html>Google transport failure</html>";
  wire=page;total=(DWORD)strlen(page);
  char body[]="{\"submissionId\":\"synthetic-stable-id\"}";
  relay(0,body,(DWORD)strlen(body));assert(allocations==0&&closed==3);
  printf("RELAY %u %s\n",statuses[i],relayed);
 }
 mode=0;cursor=options=closed=sends=allocations=0;injectedStatus=200;
 char api[]="{\"ok\":false,\"code\":\"NOT_FOUND\"}";
 wire=api;total=(DWORD)strlen(api);
 char body[]="{\"submissionId\":\"synthetic-stable-id\"}";
 relay(0,body,(DWORD)strlen(body));assert(strcmp(relayed,api)==0&&allocations==0);
 printf("PASS valid API NOT_FOUND remains unchanged\n");
 return 0;
}
'''
with tempfile.TemporaryDirectory(prefix='lk-native-http-') as directory:
    directory = Path(directory)
    source, exe = directory / 'http.c', directory / 'http'
    source.write_text(driver)
    subprocess.run(['gcc', '-std=c11', '-O1', '-g', '-Wall', '-Wextra', '-Werror',
                    '-Wno-unused-parameter', '-Wno-misleading-indentation',
                    '-fsanitize=address,undefined', '-fno-omit-frame-pointer', '-no-pie',
                    str(source), '-o', str(exe)], check=True)
    completed = subprocess.run([str(exe)], capture_output=True, text=True, timeout=30,
                               env={**os.environ, 'ASAN_OPTIONS': 'detect_leaks=1:halt_on_error=1',
                                    'UBSAN_OPTIONS': 'halt_on_error=1'})
    assert completed.returncode == 0, completed.stderr
    relays = {}
    for line in completed.stdout.splitlines():
        if line.startswith('RELAY '):
            _, status, raw = line.split(' ', 2)
            relays[status] = json.loads(raw)
        else:
            print(line)
    model = subprocess.check_output(['node', '--input-type=module', '-e',
        "import {googleRelayFailure} from './tests/fixtures/google-relay.mjs';"
        "import {retryable} from './web/core.js';"
        "const statuses=JSON.parse(process.argv[1]);"
        "const result=Object.fromEntries(statuses.map(s=>[s,googleRelayFailure(Number(s))]));"
        "if(!retryable(result[404].code)||retryable('NOT_FOUND'))throw Error('Retry classification drift');"
        "process.stdout.write(JSON.stringify(result));", json.dumps(list(relays))], cwd=root, text=True)
    assert relays == json.loads(model), 'Live driver and shipped native relay diverged'
    print(f'PASS live-driver parity with actual native relay: {len(relays)} HTTP failure vectors')
report = {'status': 'passed', 'passed': 11, 'actualCommissionRequestExecuted': True,
          'winHttpDecompressionOption': 118, 'gzipOnlyFlag': 1,
          'decodedLimitBytes': 8 * 1024 * 1024, 'unsupportedOptionPlainFallback': True,
          'requestBytesPreserved': True, 'addressSanitizer': True,
          'undefinedBehaviorSanitizer': True, 'actualWindowsNetworkExecuted': False,
          'relayFailureParityVectors': len(relays), 'actualNativeRelayExecuted': True,
          'html404ClientCode': relays['404']['code'], 'apiNotFoundPreserved': True}
(root / 'verification/native-http.json').write_text(json.dumps(report, indent=2) + '\n')
