import json
from pathlib import Path
import sys
import unittest
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from google_load_sandbox import sandbox_files, candidate_files
from appscript_deploy import config, content_hash

ROOT=Path(__file__).resolve().parents[2]
class SandboxTests(unittest.TestCase):
    def original(self):return [{'name':'Code','type':'SERVER_JS','source':(ROOT/'source/Code.gs').read_text()},{'name':'appsscript','type':'JSON','source':'{"runtimeVersion":"V8"}'}]
    def build(self,**kwargs):
        args={'namespace':'LK_LT_'+'a'*20+'_','secret':'b'*64,'private_id':'isolated-private-id','public_id':'isolated-public-id',**kwargs}
        return sandbox_files(self.original(),config(),**args)
    def test_original_is_never_modified(self):
        value=self.original();before=content_hash(value);sandbox_files(value,config(),'LK_LT_'+'a'*20+'_','b'*64,'isolated-private-id','isolated-public-id');self.assertEqual(content_hash(value),before)
    def test_candidate_preserves_manifest_and_original_identity(self):
        original=self.original();before=content_hash(original)
        local=original[0]['source']+'\n// candidate change\n'
        candidate=candidate_files(original,config(),local)
        self.assertEqual(content_hash(original),before)
        self.assertEqual(candidate[1],original[1])
        self.assertIn('// candidate change',candidate[0]['source'])
        self.assertNotEqual(candidate[0]['source'],original[0]['source'])
        with self.assertRaises(ValueError):candidate_files(original,config(),local.replace(config()['spreadsheetId'],'wrong-database'))
        with self.assertRaises(ValueError):candidate_files(original,config(),local.replace('const API_VERSION = 26;','const API_VERSION = 999;'))
    def test_every_original_service_call_is_namespaced(self):
        files=self.build();server=files[0]['source'];self.assertNotIn(config()['spreadsheetId'],server)
        for service in ['PropertiesService.getScriptProperties()','CacheService.getScriptCache()','LockService.getScriptLock()']:self.assertNotIn(service,server)
        self.assertIn('function loadTestOriginalDoPost_(',server);self.assertIn('loadTestStage_("pcStateWrite_"',server)
    def test_guard_and_cleanup_are_only_in_the_test_harness(self):
        files=self.build();harness=files[-1];self.assertEqual(harness['name'],'LoadTestHarness');self.assertIn('request.loadTestKey!==LT_SECRET',harness['source']);self.assertIn('key.indexOf(LT_NAMESPACE)===0',harness['source'])
        self.assertNotIn('LoadTestHarness',(ROOT/'source/Code.gs').read_text())
    def test_live_database_or_shared_book_ids_are_rejected(self):
        with self.assertRaises(ValueError):self.build(private_id=config()['spreadsheetId'])
        with self.assertRaises(ValueError):self.build(public_id='isolated-private-id')
    def test_weak_namespaces_secrets_and_injection_are_rejected(self):
        for change in [{'namespace':''},{'namespace':'LK_'},{'secret':'guessable'},{'private_id':"x'; dangerous(); //"}]:
            with self.assertRaises(ValueError):self.build(**change)
    def test_alternate_unisolated_service_spelling_fails_closed(self):
        files=self.original();files[0]['source']+='\nfunction unsafe(){return PropertiesService.getScriptProperties ( );}'
        with self.assertRaises(ValueError):sandbox_files(files,config(),'LK_LT_'+'a'*20+'_','b'*64,'isolated-private-id','isolated-public-id')

if __name__=='__main__':unittest.main()
