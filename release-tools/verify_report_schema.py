"""Finish the resumable public-sheet layout after the new server is healthy.

This deliberately runs outside deployment rollback: a partial layout must be
resumed by the new header-aware server, never by an older positional writer.
"""
import argparse
import json
from pathlib import Path
import time
from urllib.request import Request

from appscript_deploy import config,read_json,require

def verify(settings,build,read=read_json,pause=time.sleep,attempts=5):
    for attempt in range(attempts):
        ready=read(Request(settings['webAppUrl']+'?reports_check='+str(time.time_ns()),headers={'Cache-Control':'no-cache'}))
        require(ready.get('ok') is True and ready.get('serverBuild')==build,'Unexpected server during spreadsheet migration')
        require(ready.get('formattedReports') is True and ready.get('intakeArchives') is True,'The deployed server lacks Excel reports')
        if ready.get('formattedResultsReady') is True:return {'status':'passed','serverBuild':build,'spreadsheetLayoutReady':True}
        # The normal groups request runs the existing schema initializer under
        # its script lock; it never starts an intake or changes learning data.
        body={'action':'api','method':'GET','path':'/api/groups','body':{'initializeReports':True},'writtenProtocol':1,'choiceProtocol':2}
        reply=read(Request(settings['webAppUrl'],data=json.dumps(body).encode(),headers={'Content-Type':'application/json'},method='POST'))
        require(reply.get('code')=='BUSY' or reply.get('ok') is True and isinstance(reply.get('groups'),list),'Could not initialize spreadsheet reports')
        if reply.get('ok') is True:
            updated=read(Request(settings['webAppUrl']+'?reports_check='+str(time.time_ns()),headers={'Cache-Control':'no-cache'}))
            require(updated.get('serverBuild')==build,'Server changed during spreadsheet migration')
            if updated.get('formattedResultsReady') is True:return {'status':'passed','serverBuild':build,'spreadsheetLayoutReady':True}
        if attempt+1<attempts:pause(10)
    raise RuntimeError('Spreadsheet layout is still pending. The new server retains the migration backup; rerun release to resume it.')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--receipt',required=True,type=Path);args=parser.parse_args()
    receipt=json.loads(args.receipt.read_text());print(json.dumps(verify(config(),receipt['targetBuild'])))
