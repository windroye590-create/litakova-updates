import copy
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from verify_live_google_load import PHASES, verdict


def complete_report():
    return {'clients': 27, 'authenticated': 27, 'status': 'completed', 'runError': None,
            'actualGoogleServer': True, 'isolatedSyntheticData': True, 'productionDataWrites': 0,
            'phases': [{'name': name, 'clients': 27, 'succeeded': 27,
                        'outcomes': [{'client': i, 'ok': True} for i in range(27)]} for name in PHASES],
            'results': {'target': 54, 'acknowledged': 54, 'authoritative': 54, 'publicRows': 54,
                        'answersVerifiedForAcknowledgedResults': True, 'pendingOnClients': 0}}


class LiveGoogleVerdictTest(unittest.TestCase):
    def test_fully_delivered_scenario_passes(self):
        self.assertEqual(verdict(complete_report())['status'], 'passed')

    def test_completed_diagnostic_with_live_observed_counts_fails(self):
        report = complete_report()
        report['results'].update(acknowledged=46, authoritative=46, publicRows=39, pendingOnClients=8)
        result = verdict(report)
        self.assertEqual(result['status'], 'failed')
        self.assertIn('client_queue_not_empty', result['failures'])

    def test_checkpoint_failure_cannot_hide_behind_all_results(self):
        report = complete_report()
        report['phases'][3]['succeeded'] = 26
        report['phases'][3]['outcomes'][0]['ok'] = False
        self.assertIn('phase_incomplete:training-checkpoint-1', verdict(report)['failures'])

    def test_duplicate_client_outcomes_cannot_pass(self):
        report = complete_report()
        report['phases'][0]['outcomes'][0]['client'] = 1
        self.assertEqual(verdict(report)['status'], 'failed')

    def test_missing_phase_and_duplicate_results_fail(self):
        report = complete_report()
        report['phases'].pop()
        report['results']['authoritative'] = 55
        result = verdict(report)
        self.assertIn('missing_or_duplicate_phase:exam-finish-200', result['failures'])
        self.assertIn('result_count_mismatch:authoritative', result['failures'])

    def test_incomplete_or_unisolated_scenarios_fail(self):
        for changes in [{'status': 'test_error'}, {'productionDataWrites': 1}, {'clients': True}, {'authenticated': 26}]:
            with self.subTest(changes=changes):
                report = copy.deepcopy(complete_report())
                report.update(changes)
                self.assertEqual(verdict(report)['status'], 'failed')

    def test_candidate_requires_live_literal_storage_checks(self):
        report=complete_report();report['testedCandidate']=True;report['findings']={'signingKeyFingerprints':1}
        self.assertIn('credential_storage_unverified',verdict(report)['failures'])
        report['credentialStorage']={'newWriterPreservedCredentials':True,'newCellsLiteral':True,'legacyRecoverable':True,'legacyRecovered':False}
        self.assertIn('legacy_credentials_not_recovered',verdict(report)['failures'])
        report['credentialStorage']['legacyRecovered']=True
        self.assertEqual(verdict(report)['status'],'passed')


if __name__ == '__main__':
    unittest.main()
