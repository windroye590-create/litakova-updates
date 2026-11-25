"""Judge delivery separately from whether the diagnostic scenario completed."""
import argparse
import json
from pathlib import Path

PHASES = (
    'login', 'workspace', 'training-start-50', 'training-checkpoint-1',
    'training-checkpoint-2', 'training-finish-50', 'workspace-after-training',
    'exam-start-200', 'exam-checkpoint-1', 'exam-checkpoint-2', 'exam-finish-200',
)


def verdict(report):
    failures = []
    clients = report.get('clients')
    valid_clients = type(clients) is int and 20 <= clients <= 27
    if not valid_clients:
        failures.append('invalid_client_count')
    if report.get('status') != 'completed' or report.get('runError') is not None:
        failures.append('scenario_incomplete')
    if not (report.get('actualGoogleServer') is True
            and report.get('isolatedSyntheticData') is True
            and report.get('productionDataWrites') == 0):
        failures.append('isolation_or_live_server_unverified')
    if not valid_clients or report.get('authenticated') != clients:
        failures.append('authentication_incomplete')
    phases = report.get('phases', [])
    for name in PHASES:
        matches = [item for item in phases if item.get('name') == name]
        if len(matches) != 1:
            failures.append('missing_or_duplicate_phase:' + name)
            continue
        item = matches[0]
        outcomes = item.get('outcomes', [])
        if (not valid_clients or item.get('clients') != clients
                or item.get('succeeded') != clients or len(outcomes) != clients
                or any(outcome.get('ok') is not True for outcome in outcomes)
                or {outcome.get('client') for outcome in outcomes} != set(range(clients))):
            failures.append('phase_incomplete:' + name)
    results = report.get('results', {})
    target = clients * 2 if valid_clients else None
    for field in ['target', 'acknowledged', 'authoritative', 'publicRows']:
        if not valid_clients or results.get(field) != target:
            failures.append('result_count_mismatch:' + field)
    if results.get('answersVerifiedForAcknowledgedResults') is not True:
        failures.append('answers_unverified')
    if results.get('pendingOnClients') != 0:
        failures.append('client_queue_not_empty')
    return {'status': 'failed' if failures else 'passed',
            'scope': 'all classroom stages, durable delivery and publication within the scenario budgets',
            'failures': failures}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--report-dir', type=Path, required=True)
    args = parser.parse_args()
    report = json.loads((args.report_dir / 'summary.json').read_text())
    result = verdict(report)
    (args.report_dir / 'acceptance.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result))
    raise SystemExit(0 if result['status'] == 'passed' else 1)
