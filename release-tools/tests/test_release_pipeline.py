import json
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import release_pipeline as pipeline


class VersionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.source = Path(self.temp.name)
        for name in ['package.json', 'web/core.js', 'native/update_protocol.h', 'Code.gs']:
            destination = self.source / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(pipeline.SOURCE / name, destination)
        self.override = patch.object(pipeline, 'SOURCE', self.source)
        self.override.start()
        self.addCleanup(self.override.stop)

    def test_prepared_version_matches_frontend_native_and_server(self):
        result = pipeline.prepare('1.2.28', 150, '1.2.27')
        self.assertEqual((result['version'], result['versionCode']), ('1.2.28', 151))
        self.assertIn("APP_VERSION='1.2.28'", (self.source / 'web/core.js').read_text())
        self.assertIn('PC_VERSION_CODE 151u', (self.source / 'native/update_protocol.h').read_text())
        self.assertIn("LATEST_APP_VERSION_NAME = '1.2.28'", (self.source / 'Code.gs').read_text())

    def test_failed_release_retry_reuses_its_prepared_code(self):
        first = pipeline.prepare('1.2.28', 150, '1.2.27')
        retry = pipeline.prepare('1.2.28', 150, '1.2.27')
        self.assertEqual(first['versionCode'], retry['versionCode'])

    def test_remote_newer_code_is_never_replaced_with_local_old_counter(self):
        self.assertEqual(pipeline.prepare('1.2.30', 170, '1.2.29')['versionCode'], 171)

    def test_invalid_or_old_versions_do_not_modify_sources(self):
        before = (self.source / 'package.json').read_bytes()
        for version in ['1.2.27', '1.2.26', '1.2.28; command', '../1.2.28', 'v1.2.28']:
            with self.assertRaises(ValueError):
                pipeline.prepare(version, 150, '1.2.27')
        self.assertEqual((self.source / 'package.json').read_bytes(), before)


class SnapshotTests(unittest.TestCase):
    def test_candidate_records_complete_source_without_publishing_or_private_files(self):
        with tempfile.TemporaryDirectory() as scratch:
            root = Path(scratch)
            (root / 'release-tools').mkdir()
            (root / 'channel').mkdir()
            shutil.copyfile(pipeline.ROOT / 'release-tools/update-public.pem', root / 'release-tools/update-public.pem')
            (root / 'next-release-notes.md').write_text('Verified release fixture')
            receipt = root / 'plan.json'
            receipt.write_text(json.dumps({'changed': False, 'targetBuild': 'existing-server'}))
            bundle = pipeline.ROOT / 'channel'
            with patch.object(pipeline, 'ROOT', root), patch.dict('os.environ', {
                'GITHUB_REF': 'refs/heads/main', 'GITHUB_REPOSITORY': pipeline.github.REPOSITORY,
            }):
                paths = pipeline.snapshot(bundle, receipt, dry_run=True)
            import zipfile
            archives = list((root / 'release-staging').rglob('*.zip'))
            self.assertEqual(len(archives), 1)
            with zipfile.ZipFile(archives[0]) as archive:
                self.assertIn('web/vendor/pdfjs/build/pdf.mjs', archive.namelist())
                self.assertEqual(archive.read('web/results.js'), (pipeline.SOURCE / 'web/results.js').read_bytes())
                self.assertFalse(any(Path(name).suffix in {'.jks', '.p12', '.key'} for name in archive.namelist()))
            self.assertEqual((root / 'channel/Litakova-Komisiia-PC.exe').read_bytes(), (bundle / 'Litakova-Komisiia-PC.exe').read_bytes())
            self.assertIn('channel', paths)
            self.assertFalse((root / '.git').exists())


if __name__ == '__main__':
    unittest.main()
