"""Real fake-tool processes; synthetic input and an isolated local Git repo."""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("privacy_guard", Path(__file__).resolve().parents[1] / "scripts/privacy_guard.py")
pg = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(pg)


class DeadlineTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="privacy-deadline-test-")
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.repo = self.base / "repo"
        self.repo.mkdir()
        for key, name in ((pg.CONFIG_KEY, "private"), (pg.IDENTITY_KEY, "identities")):
            rules = self.base / name
            rules.write_text("SYNTHETIC_PRIVATE_CANARY\n")
            if not (self.repo / ".git").exists():
                subprocess.run(["git", "init", "-q", str(self.repo)], check=True)
            subprocess.run(["git", "-C", str(self.repo), "config", "--local", key, str(rules)], check=True)
        self.tool = self.base / "gitleaks"
        self.tool.write_text("#!" + sys.executable + "\n" + '''import hashlib, json, pathlib, sys, time
args = sys.argv[1:]
data = sys.stdin.buffer.read()
with pathlib.Path(__file__).with_name('received').open('a') as audit:
    audit.write(json.dumps([len(data), hashlib.sha256(data).hexdigest()]) + '\\n')
report = pathlib.Path(args[args.index('--report-path') + 1])
mode = pathlib.Path(__file__).with_name('mode').read_text()
if mode == 'sleep':
    report.write_text('[]')
    time.sleep(3)
elif mode in ('tool-timeout', 'zero-timeout'):
    print('SYNTHETIC_PRIVATE_CANARY context deadline exceeded', file=sys.stderr)
    report.write_text('[]')
    sys.exit(0 if mode == 'zero-timeout' else 1)
elif mode == 'found':
    report.write_text(json.dumps([{'Secret': 'SYNTHETIC_PRIVATE_CANARY'}]))
    sys.exit(int(args[args.index('--exit-code') + 1]) if '--exit-code' in args else 1)
elif mode == 'error':
    print('SYNTHETIC_PRIVATE_CANARY', file=sys.stderr)
    report.write_text('[]')
    sys.exit(2)
else:
    report.write_text('[]')
''')
        self.tool.chmod(0o700)

    def outcome(self, mode, second=False, parts=None):
        (self.base / "mode").write_text(mode)
        out, err = io.StringIO(), io.StringIO()
        # Only the test's imported module gets a short deadline. The executable
        # really sleeps past it, so TimeoutExpired comes from a real child.
        with patch.object(pg, "root_dir", return_value=self.repo), \
             patch.object(pg, "git", side_effect=lambda *args: subprocess.check_output(["git", "-C", str(self.repo), *args])), \
             patch.object(pg.shutil, "which", return_value=str(self.tool)), \
             patch.object(pg, "GITLEAKS_TIMEOUT", 1, create=True), \
             patch.object(pg, "GITLEAKS_GRACE", 0.2, create=True), \
             contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            scan = pg.Scanner()
            if second:
                (self.base / "mode").write_text("clean")
                scan.add(b"first safe part\n", "synthetic")
                scan.flush()
                (self.base / "mode").write_text(mode)
            for part in parts or [b"next safe part\n"]:
                scan.add(part, "synthetic")
            try:
                scan.finish()
                code = 0
            except pg.Blocked as error:
                print("BLOCKED privacy guard: " + str(error), file=err)
                code = 1
        result = out.getvalue() + err.getvalue()
        self.assertNotIn("SYNTHETIC_PRIVATE_CANARY", result)
        return code, result, scan

    def test_clean_finding_and_process_timeout_are_distinct(self):
        clean, finding, timeout = [self.outcome(mode) for mode in ("clean", "found", "sleep")]
        self.assertEqual(clean[0], 0)
        self.assertIn("PASS privacy guard", clean[1])
        self.assertEqual(finding[0], 1)
        self.assertIn("gitleaks detected a secret", finding[1])
        self.assertNotIn("timed out", finding[1])
        self.assertEqual(timeout[0], 1)
        self.assertIn("batch 1 timed out", timeout[1])
        self.assertNotIn("detected a secret", timeout[1])
        self.assertNotIn("PASS", timeout[1])
        self.assertEqual(timeout[2].batches, [])

    def test_internal_timeout_and_tool_failure_are_not_findings(self):
        for mode in ("tool-timeout", "zero-timeout", "error"):
            with self.subTest(mode=mode):
                code, output, scan = self.outcome(mode)
                self.assertEqual(code, 1)
                self.assertNotIn("PASS", output)
                self.assertNotIn("detected a secret", output)
                self.assertIn("batch 1 timed out" if "timeout" in mode else "batch 1 failed", output)
                self.assertEqual(scan.batches, [])

    def test_timeout_identifies_the_failed_later_batch_and_keeps_it_unpassed(self):
        code, output, scan = self.outcome("sleep", second=True)
        self.assertEqual(code, 1)
        self.assertIn("batch 1:", output)
        self.assertIn("batch 2 timed out", output)
        self.assertNotIn("PASS", output)
        self.assertEqual(len(scan.batches), 1)
        self.assertEqual(scan.parts, [b"next safe part\n"])

    def test_large_production_batches_have_more_deadline_margin_without_cutting_parts(self):
        body = b"safe fixture line\n" * ((pg.MAX_BLOB - 32) // 18)
        parts = [b"part %02d\n" % index + body for index in range(17)]
        code, _, scan = self.outcome("clean", parts=parts)
        self.assertEqual(code, 0)
        received = [json.loads(line) for line in (self.base / "received").read_text().splitlines()]
        self.assertGreaterEqual(len(received), 2, "Production input above 32 MiB must not stay in a 192 MiB batch")
        cursor = 0
        for size, digest in received:
            self.assertLessEqual(size, 32 * 1024 * 1024)
            start = cursor
            while cursor < len(parts) and len(b"\n".join(parts[start:cursor])) < size:
                cursor += 1
            batch = b"\n".join(parts[start:cursor])
            self.assertEqual(len(batch), size, "A batch boundary cannot split a part")
            self.assertEqual(hashlib.sha256(batch).hexdigest(), digest)
        self.assertEqual(cursor, len(parts))
        self.assertEqual(sum(n for n, _ in scan.batches), len(parts))


if __name__ == "__main__":
    unittest.main()
