"""Exercise real Git hooks against synthetic data and local-only bare remotes.

No real credentials, private pattern file, or network remote is used here.
Explicit hook bypasses below create hostile legacy history ONLY in disposable
test repositories, so pre-push interception can be tested independently.
"""
from pathlib import Path
import os
import shutil
import subprocess
import sys
import tempfile
import unittest

SOURCE = Path(__file__).resolve().parents[1]
CANARY = "SYNTHETIC_PRIVATE_RECORD_" + "7319"


class PublicationGuardTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="privacy-guard-test-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / "repo"
        self.repo.mkdir()
        self.remote = self.base / "remote.git"
        self.patterns = self.base / "private-patterns.txt"
        self.patterns.write_text("# synthetic only\n\nSYNTHETIC_PRIVATE_RECORD_\n")
        self.env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        self.env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                        GIT_TERMINAL_PROMPT="0")
        self.call("git", "init", "-q", "-b", "main")
        self.call("git", "config", "user.name", "Fixture Contributor")
        self.call("git", "config", "user.email", "fixture@users.noreply.github.com")
        shutil.copytree(SOURCE / ".githooks", self.repo / ".githooks")
        (self.repo / "scripts").mkdir()
        shutil.copy2(SOURCE / "scripts/privacy_guard.py", self.repo / "scripts/privacy_guard.py")
        self.call(sys.executable, "scripts/privacy_guard.py", "install", str(self.patterns))
        self.call("git", "add", ".")
        self.call("git", "commit", "-qm", "Safe initial fixture")
        self.call("git", "init", "--bare", "-q", str(self.remote))
        self.call("git", "remote", "add", "origin", str(self.remote))

    def call(self, *args, ok=True, env=None):
        result = subprocess.run(args, cwd=self.repo, env=env or self.env,
                                capture_output=True, text=True, timeout=60)
        if ok:
            self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def blocked(self, result):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("BLOCKED privacy guard", result.stderr)
        self.assertNotIn(CANARY, result.stdout + result.stderr)

    def file(self, name, value="safe fixture\n"):
        file = self.repo / name
        file.parent.mkdir(parents=True, exist_ok=True)
        file.write_text(value)
        self.call("git", "add", "-f", "--", name)

    def unsafe_commit(self, message="Legacy synthetic fixture"):
        # Only this disposable repo gets a bypass, to simulate prior mistakes.
        self.call("git", "-c", "core.hooksPath=" + str(self.base / "no-hooks"),
                  "commit", "--allow-empty", "-qm", message)

    def assert_remote_empty(self):
        self.assertEqual(self.call("git", "--git-dir=" + str(self.remote),
                                   "show-ref", ok=False).returncode, 1)

    def test_clean_commit_and_push(self):
        self.file("example.txt", "example@example.com\n")
        self.call("git", "commit", "-qm", "Safe example")
        self.call("git", "push", "origin", "main")
        local = self.call("git", "rev-parse", "HEAD").stdout
        remote = self.call("git", "--git-dir=" + str(self.remote),
                           "rev-parse", "refs/heads/main").stdout
        self.assertEqual(local, remote)

    def test_index_not_clean_worktree_is_scanned(self):
        self.file("note.txt", CANARY)
        (self.repo / "note.txt").write_text("clean working file\n")
        self.blocked(self.call("git", "commit", "-qm", "Do not publish staged data", ok=False))

    def test_candidate_message_and_author_are_blocked(self):
        self.blocked(self.call("git", "commit", "--allow-empty", "-qm", CANARY, ok=False))
        self.blocked(self.call("git", "commit", "--allow-empty", "--author",
                               CANARY + " <fixture@users.noreply.github.com>",
                               "-qm", "Safe message", ok=False))

    def test_fake_key_detected_without_printing_it(self):
        fake = "gh" + "p_" + "A7b9C2d5E8f1G4h6J3k0L9m2N5p8Q1r4S7t0"
        self.file("example.txt", fake)
        result = self.call("git", "commit", "-qm", "Synthetic key test", ok=False)
        self.blocked(result)
        self.assertNotIn(fake, result.stdout + result.stderr)

    def test_restricted_files_and_binary_content(self):
        for name in (".env", "holdings.csv", "store.sqlite", "screenshot.png", "memo.private.md"):
            with self.subTest(name=name):
                self.file(name)
                self.blocked(self.call("git", "commit", "-qm", "Restricted artifact", ok=False))
                self.call("git", "reset", "--hard", "-q", "HEAD")
        (self.repo / "binary.txt").write_bytes(b"safe\x00unsafe")
        self.call("git", "add", "binary.txt")
        self.blocked(self.call("git", "commit", "-qm", "Binary artifact", ok=False))

    def test_generic_identity_and_finance_shapes(self):
        for value in ("/" + "Users/fixture-person/doc.txt", "balance" + ": $" + "123456",
                      "fixture-person@" + "personal.invalid", "123" + "-45-6789"):
            with self.subTest(kind=value.split(":")[0]):
                self.file("private.txt", value)
                self.blocked(self.call("git", "commit", "-qm", "Generic pattern test", ok=False))
                self.call("git", "reset", "--hard", "-q", "HEAD")

    def test_missing_empty_invalid_private_rules_fail_closed(self):
        for content in (None, "# comments only\n\n", "[invalid"):
            with self.subTest(content=content):
                if content is None:
                    self.patterns.unlink()
                else:
                    self.patterns.write_text(content)
                self.blocked(self.call("git", "commit", "--allow-empty", "-qm", "No rules", ok=False))

    def test_scanner_error_is_not_pass_and_does_not_echo_output(self):
        bins = self.base / "bin"
        bins.mkdir()
        fake = bins / "gitleaks"
        fake.write_text("#!/bin/sh\necho " + CANARY + " >&2\nexit 2\n")
        fake.chmod(0o700)
        env = {**self.env, "PATH": str(bins) + os.pathsep + self.env["PATH"]}
        self.blocked(self.call("git", "commit", "--allow-empty", "-qm", "Tool error", ok=False, env=env))

    def test_scanner_timeout_remains_blocked(self):
        code = """
import subprocess, sys
from unittest.mock import patch
from scripts.privacy_guard import Scanner, Blocked
scan = Scanner()
scan.add(b'safe fixture\\n', 'synthetic record')
try:
    with patch('scripts.privacy_guard.subprocess.run', side_effect=subprocess.TimeoutExpired('synthetic scanner', 135)):
        scan.finish()
except Blocked as error:
    print('BLOCKED privacy guard: ' + str(error), file=sys.stderr)
    raise SystemExit(1)
"""
        result = self.call(sys.executable, '-c', code, ok=False)
        self.blocked(result)
        self.assertIn('gitleaks unavailable or timed out', result.stderr)

    def test_complete_history_scanner_keeps_a_finite_tool_and_process_deadline(self):
        code = """
import subprocess
from unittest.mock import patch
from scripts.privacy_guard import Scanner
scan = Scanner()
scan.add(b'safe fixture\\n', 'synthetic record')
with patch('scripts.privacy_guard.subprocess.run', return_value=subprocess.CompletedProcess([], 0, b'', b'')) as invoke:
    scan.finish()
arguments, options = invoke.call_args
assert arguments[0][arguments[0].index('--timeout') + 1] == '120'
assert options['timeout'] == 135
assert options['input'] == b'safe fixture\\n'
"""
        result = self.call(sys.executable, '-c', code)
        self.assertIn('PASS privacy guard', result.stdout)

    def test_missing_gitleaks_blocks(self):
        bins = self.base / "limited-bin"
        bins.mkdir()
        for name in ("git", "python3"):
            (bins / name).symlink_to(shutil.which(name))
        env = {**self.env, "PATH": str(bins)}
        self.blocked(self.call("git", "commit", "--allow-empty", "-qm", "Missing scanner", ok=False, env=env))

    def test_deleted_intermediate_content_blocks_new_branch_push(self):
        self.file("legacy.txt", CANARY)
        self.unsafe_commit()
        self.call("git", "rm", "-q", "legacy.txt")
        self.unsafe_commit("Removed synthetic data")
        self.blocked(self.call("git", "push", "origin", "main", ok=False))
        self.assert_remote_empty()

    def test_commit_metadata_blocks_push_with_clean_tree(self):
        self.unsafe_commit(CANARY)
        self.blocked(self.call("git", "push", "origin", "main", ok=False))
        self.assert_remote_empty()

    def test_annotated_tag_message_is_scanned(self):
        self.call("git", "tag", "-a", "release", "-m", CANARY)
        self.blocked(self.call("git", "push", "origin", "refs/tags/release", ok=False))
        self.assert_remote_empty()

    def test_ref_name_is_scanned(self):
        self.call("git", "branch", CANARY)
        self.blocked(self.call("git", "push", "origin", CANARY, ok=False))
        self.assert_remote_empty()

    def test_multiple_refs_do_not_hide_dirty_branch(self):
        self.call("git", "branch", "safe")
        self.file("legacy.txt", CANARY)
        self.unsafe_commit()
        self.blocked(self.call("git", "push", "origin", "safe", "main", ok=False))
        self.assert_remote_empty()

    def test_merge_resolution_content_is_scanned(self):
        self.call("git", "checkout", "-qb", "side")
        self.file("side.txt")
        self.call("git", "commit", "-qm", "Safe side")
        self.call("git", "checkout", "-q", "main")
        self.file("main.txt")
        self.call("git", "commit", "-qm", "Safe main")
        self.call("git", "merge", "--no-ff", "--no-commit", "side")
        self.file("merge-only.txt", CANARY)
        self.unsafe_commit("Synthetic merge resolution")
        self.blocked(self.call("git", "push", "origin", "main", ok=False))
        self.assert_remote_empty()

    def test_external_symlink_and_sensitive_filename_block(self):
        (self.repo / "external").symlink_to(self.patterns)
        self.call("git", "add", "external")
        self.blocked(self.call("git", "commit", "-qm", "External link", ok=False))
        self.call("git", "reset", "--hard", "-q", "HEAD")
        self.file(CANARY + ".txt")
        self.blocked(self.call("git", "commit", "-qm", "Private filename", ok=False))

    def test_in_repo_private_rules_are_rejected(self):
        local = self.repo / "local-rules.txt"
        local.write_text("SYNTHETIC_PRIVATE_RECORD_\n")
        self.blocked(self.call(sys.executable, "scripts/privacy_guard.py", "install", str(local), ok=False))

    def test_gitleaks_inline_allow_cannot_suppress_a_key(self):
        fake = "gh" + "p_" + "A7b9C2d5E8f1G4h6J3k0L9m2N5p8Q1r4S7t0"
        self.file("fixture.txt", fake + " # gitleaks:allow\n")
        self.blocked(self.call("git", "commit", "-qm", "Inline suppression test", ok=False))

    def test_git_replace_cannot_hide_original_commit(self):
        safe = self.call("git", "rev-parse", "HEAD").stdout.strip()
        self.unsafe_commit(CANARY)
        dirty = self.call("git", "rev-parse", "HEAD").stdout.strip()
        self.call("git", "replace", dirty, safe)
        self.blocked(self.call("git", "push", "origin", "main", ok=False))
        self.assert_remote_empty()

    def scan_many_parts(self, ending):
        # Exercise real private rules/gitleaks after the former 192 MiB limit.
        # Only this owned subprocess supplies scanner inputs directly; native Git
        # traversal and actual hooks are covered by the other disposable repos.
        code = """
import sys
from scripts.privacy_guard import Scanner, Blocked, MAX_BLOB, MAX_SCAN
scan = Scanner()
part = b'safe fixture line\\n' * ((MAX_BLOB - 1) // 18)
try:
    while scan.size <= 192 * 1024 * 1024:
        scan.add(part, 'synthetic history')
""" + ending + """
except Blocked as error:
    print('BLOCKED privacy guard: ' + str(error), file=sys.stderr)
    raise SystemExit(1)
"""
        return self.call(sys.executable, '-c', code, ok=False)

    def test_scanner_parts_above_old_total_limit_are_checked(self):
        result = self.scan_many_parts("    scan.finish()\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PASS privacy guard', result.stdout)

    def test_private_data_after_old_total_limit_still_blocks(self):
        result = self.scan_many_parts("    scan.add(" + repr(CANARY.encode()) + ", 'late synthetic record')\n    scan.finish()\n")
        self.blocked(result)
        self.assertIn('private rule', result.stderr)

    def test_secret_after_old_total_limit_still_blocks(self):
        fake = 'gh' + 'p_' + 'A7b9C2d5E8f1G4h6J3k0L9m2N5p8Q1r4S7t0'
        result = self.scan_many_parts("    scan.add(" + repr(fake.encode()) + ", 'late synthetic secret')\n    scan.finish()\n")
        self.blocked(result)
        self.assertIn('gitleaks detected a secret', result.stderr)
        self.assertNotIn(fake, result.stderr + result.stdout)

    def test_new_total_limit_remains_fail_closed(self):
        result = self.scan_many_parts("    while True:\n        scan.add(part, 'synthetic history beyond bound')\n")
        self.blocked(result)
        self.assertIn('scan size limit exceeded', result.stderr)

    def test_oversized_content_is_blocked_not_skipped(self):
        self.file("large.txt", "a" * (2 * 1024 * 1024 + 1))
        self.blocked(self.call("git", "commit", "-qm", "Large file", ok=False))


if __name__ == "__main__":
    unittest.main(verbosity=2)
