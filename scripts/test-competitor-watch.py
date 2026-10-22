import importlib.util
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('watch', Path(__file__).with_name('competitor-watch.py'))
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


class ScheduleTests(unittest.TestCase):
    def test_pacific_deadline_survives_dst(self):
        for instant, expected in [
            ('2026-10-22T01:59:00+00:00', '2026-10-20'),
            ('2026-10-22T02:00:00+00:00', '2026-10-21'),
            ('2026-11-02T02:59:00+00:00', '2026-10-31'),
            ('2026-11-02T03:00:00+00:00', '2026-11-01'),
        ]:
            self.assertEqual(watch.due_date(datetime.fromisoformat(instant)), expected)

    def test_no_early_run_and_no_repeat_after_uncertain_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            self.assertEqual(watch.run(base, Path('/missing'), datetime(2026,10,21,18,tzinfo=watch.PT))['status'], 'not-due')
            now = datetime(2026,10,21,19,tzinfo=watch.PT)
            self.assertEqual(watch.run(base, Path('/missing'), now)['status'], 'failed')
            self.assertEqual(watch.run(base, Path('/missing'), now)['status'], 'already-attempted')
            self.assertIn('证据不足', (base/'2026-10-21-failure.md').read_text())

    def test_wake_catches_only_latest_missed_date(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            watch.save(base/'state.json', {'attempted_date': '2026-10-18', 'status': 'completed'})
            result = watch.run(base, Path('/missing'), datetime(2026,10,22,8,tzinfo=watch.PT), dry_run=True)
            self.assertEqual(result['date'], '2026-10-21')
            self.assertEqual(json.loads((base/'state.json').read_text())['attempted_date'], '2026-10-18')

    def test_real_child_success_and_timeout_are_distinct(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            helper = base/'helper'
            body = '结论：证据不足\n发现与变化\n重合与价值\n下一步\n未知与审查\n跟踪名单\n基础设施测试，不是竞品研究。'
            helper.write_text('#!/usr/bin/python3\nimport sys\nfrom pathlib import Path\nsys.stdin.read()\nPath(sys.argv[sys.argv.index("-o")+1]).write_text('+repr(body)+')\n')
            helper.chmod(0o700)
            now = datetime(2026,10,21,19,tzinfo=watch.PT)
            self.assertEqual(watch.run(base/'success', helper, now)['status'], 'completed')
            helper.write_text('#!/usr/bin/python3\nimport time\ntime.sleep(30)\n')
            result = watch.run(base/'timeout', helper, now, timeout=0.1)
            self.assertEqual(result['status'], 'failed')
            self.assertEqual(result['error'], 'TimeoutError')

    def test_report_template_or_unsupported_decision_is_rejected(self):
        for text in ['结论：继续 / 收窄 / 转向 / 建议停止 / 证据不足',
                     'Here is the template: 结论：继续',
                     '结论：继续\n发现与变化\n重合与价值\n下一步\n未知与审查\n跟踪名单']:
            with self.assertRaises(ValueError):
                watch.validate_report(text)

    def test_usage_preserves_native_cached_accounting_without_a_price_estimate(self):
        with tempfile.TemporaryDirectory() as temp:
            log = Path(temp)/'events.jsonl'
            log.write_text('a diagnostic line\n'+json.dumps({'type': 'turn.completed', 'usage': {
                'input_tokens': 100, 'cached_input_tokens': 80, 'output_tokens': 10}})+'\n')
            self.assertEqual(watch.recorded_usage(log), {'input_tokens': 100, 'cached_input_tokens': 80, 'output_tokens': 10})

    def test_real_runner_termination_cleans_child_and_does_not_retry(self):
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp)
            helper = base/'helper'
            pidfile = base/'child.pid'
            helper.write_text('#!/usr/bin/python3\nimport os,time\nfrom pathlib import Path\nPath('+repr(str(pidfile))+').write_text(str(os.getpid()))\ntime.sleep(60)\n')
            helper.chmod(0o700)
            script = ('import sys\nfrom pathlib import Path\nfrom datetime import datetime\n'
                      'sys.path.insert(0, '+repr(str(Path(__file__).parent))+')\n'
                      'import importlib\nw=importlib.import_module("competitor-watch")\n'
                      'w.run(Path('+repr(str(base/'state'))+'),Path('+repr(str(helper))+'),datetime(2026,10,21,19,tzinfo=w.PT))')
            runner = subprocess.Popen([sys.executable, '-c', script])
            try:
                deadline = time.monotonic()+5
                while not pidfile.exists() and time.monotonic() < deadline:
                    time.sleep(0.02)
                self.assertTrue(pidfile.exists())
                child_pid = int(pidfile.read_text())
                runner.terminate()
                runner.wait(timeout=8)
                with self.assertRaises(ProcessLookupError):
                    os.kill(child_pid, 0)
                result = json.loads((base/'state/state.json').read_text())
                self.assertEqual(result['status'], 'interrupted')
                self.assertEqual(watch.run(base/'state', helper, datetime(2026,10,21,20,tzinfo=watch.PT))['status'], 'already-attempted')
            finally:
                if runner.poll() is None:
                    runner.kill()
                    runner.wait()


if __name__ == '__main__':
    unittest.main()
