#!/usr/bin/env python3
"""Local, fail-closed publication checks. Never print matched private data.

Copyright 2026 RulerCompass1729. Licensed under Apache-2.0.
This is an accidental-disclosure guard, not a sandbox or a legal certification.
"""
from __future__ import annotations

import argparse
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tempfile

MAX_BLOB = 2 * 1024 * 1024
MAX_SCAN = 192 * 1024 * 1024
CONFIG_KEY = "privacyGuard.privatePatternsFile"
HOOKS = ("pre-commit", "commit-msg", "pre-push")
BLOCKED_DIRS = {".git", ".local", ".scratch", ".runtime", ".claude", ".codex",
                "local-only", "private", "transcripts", "screenshots"}
BLOCKED_SUFFIXES = {".db", ".sqlite", ".sqlite3", ".csv", ".tsv", ".jsonl",
                    ".log", ".pem", ".key", ".p12", ".pfx", ".pdf", ".zip",
                    ".gz", ".tar", ".7z", ".png", ".jpg", ".jpeg", ".webp",
                    ".gif", ".mp4", ".mov", ".wav", ".mp3", ".docx", ".xlsx"}
BASELINE = (
    ("personal-home-path", r"/(?:Users|home)/[A-Za-z0-9_.-]+"),
    ("windows-home-path", r"[A-Z]:[\\/](?:Users|Documents and Settings)[\\/][^\s\\/]+"),
    ("identity-number", r"\b[0-9]{3}-[0-9]{2}-[0-9]{4}\b"),
    ("financial-record", r"\b(?:account|routing|iban|balance|portfolio|holdings)\s*(?:number|id|value)?\s*[:=]\s*[$€£]?[0-9]"),
    ("private-record", r"(?:账号|账户|余额|持仓|身份证|护照)\s*[:：=]\s*[$￥¥]?[0-9]"),
)
EMAIL = re.compile(r"[A-Z0-9._%+\-]+@([A-Z0-9.\-]+\.[A-Z]{2,})", re.I)
SAFE_EMAIL_DOMAINS = {"example.com", "example.org", "example.net", "example.invalid",
                      "example.test", "users.noreply.github.com"}


class Blocked(Exception):
    pass


def run(args, *, data=None, cwd=None):
    """Capture failures without echoing filenames, command arguments, or content."""
    try:
        p = subprocess.run(args, input=data, stdout=subprocess.PIPE,
                           stderr=subprocess.PIPE, cwd=cwd, timeout=120,
                           env={**os.environ, "GIT_NO_REPLACE_OBJECTS": "1"})
    except (OSError, subprocess.TimeoutExpired):
        raise Blocked("required command unavailable or timed out") from None
    if p.returncode:
        raise Blocked("required command failed; no pass issued")
    return p.stdout


def git(*args):
    return run(["git", *args])


def root_dir():
    return Path(os.fsdecode(git("rev-parse", "--show-toplevel")).strip()).resolve()


def load_patterns(path, root):
    path = Path(path).expanduser().resolve()
    if path == root or root in path.parents:
        raise Blocked("private patterns must live outside the repository")
    try:
        rules = [s.strip() for s in path.read_text(encoding="utf-8").splitlines()
                 if s.strip() and not s.lstrip().startswith("#")]
        patterns = [re.compile(s, re.I) for s in rules]
    except (OSError, UnicodeError, re.error):
        raise Blocked("private rules missing, unreadable, or invalid") from None
    if not patterns or any(p.search("") for p in patterns):
        raise Blocked("private rules empty or match empty input")
    return patterns


class Scanner:
    def __init__(self):
        self.root = root_dir()
        value = git("config", "--local", "--get", CONFIG_KEY).decode().strip()
        self.patterns = load_patterns(value, self.root)
        self.gitleaks = shutil.which("gitleaks")
        if not self.gitleaks:
            raise Blocked("gitleaks is required; install it before publishing")
        self.parts = []
        self.size = 0
        self.blobs = set()
        self.commits = 0

    def add(self, data, label):
        if len(data) > MAX_BLOB or self.size + len(data) > MAX_SCAN:
            raise Blocked("scan size limit exceeded; nothing was silently skipped")
        try:
            text = data.decode("utf-8")
        except UnicodeError:
            raise Blocked(f"{label}: non-UTF-8 content requires separate review") from None
        if any(ord(c) < 32 and c not in "\n\r\t" for c in text):
            raise Blocked(f"{label}: binary/control content requires separate review")
        for i, pattern in enumerate(self.patterns, 1):
            if pattern.search(text):
                raise Blocked(f"{label}: private rule {i} matched (value withheld)")
        for name, pattern in BASELINE:
            if re.search(pattern, text, re.I):
                raise Blocked(f"{label}: {name} matched (value withheld)")
        if any(m.group(1).lower() not in SAFE_EMAIL_DOMAINS for m in EMAIL.finditer(text)):
            raise Blocked(f"{label}: non-example, non-noreply email (value withheld)")
        self.parts.append(data)
        self.size += len(data)

    def path(self, raw):
        self.add(raw, "path/ref")
        path = PurePosixPath(raw.decode("utf-8"))
        name = path.name.lower()
        if (any(part.lower() in BLOCKED_DIRS for part in path.parts)
                or path.suffix.lower() in BLOCKED_SUFFIXES
                or ".private." in name
                or (name.startswith(".env") and name != ".env.example")
                or name in {"auth.json", "credentials.json", "credentials", "id_rsa", "id_ed25519"}):
            raise Blocked("restricted data/credential/artifact path (name withheld)")

    def entries(self, data, staged=False):
        for entry in data.split(b"\0"):
            if not entry:
                continue
            info, path = entry.split(b"\t", 1)
            fields = info.split()
            mode = fields[0]
            oid = fields[1] if staged else fields[2]
            if staged and fields[2] != b"0":
                raise Blocked("unmerged index cannot be scanned for publication")
            self.path(path)
            if mode not in (b"100644", b"100755", b"120000"):
                raise Blocked("submodule or unsupported entry requires separate review")
            if oid in self.blobs and mode != b"120000":
                continue
            if int(git("cat-file", "-s", oid.decode())) > MAX_BLOB:
                raise Blocked("blob exceeds scan limit; no pass issued")
            content = git("cat-file", "blob", oid.decode())
            self.add(content, "file content")
            if mode == b"120000":
                target = PurePosixPath(content.decode())
                if target.is_absolute() or ".." in target.parts:
                    raise Blocked("external/parent symlink is not publishable")
                self.path(content)
            self.blobs.add(oid)

    def staged(self):
        self.entries(git("ls-files", "--stage", "-z"), staged=True)
        self.add(git("diff", "--cached", "--text", "--no-ext-diff", "--no-textconv"),
                 "staged patch")

    def history(self, tips):
        if git("rev-parse", "--is-shallow-repository").strip() != b"false":
            raise Blocked("shallow history is incomplete; fetch complete history first")
        for tip in tips:
            if not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", tip):
                raise Blocked("invalid object ID")
            current = tip
            while git("cat-file", "-t", current).strip() == b"tag":
                tag = git("cat-file", "tag", current)
                self.add(tag, "tag metadata/message")
                current = tag.splitlines()[0].split()[1].decode("ascii")
            if git("cat-file", "-t", current).strip() != b"commit":
                raise Blocked("non-commit ref requires separate review")
        commits = git("rev-list", *tips).decode().splitlines() if tips else []
        for oid in commits:
            self.commits += 1
            self.add(git("show", "-s", "--format=%B", oid), "commit message")
            self.add(git("show", "-s", "--format=%an <%ae>%n%cn <%ce>", oid), "commit identity")
            self.entries(git("ls-tree", "-r", "-z", oid))
            self.add(git("show", "--format=", "--root", "-m", "-p", "--text",
                         "--no-ext-diff", "--no-textconv", oid), "historical patch")

    def finish(self):
        with tempfile.TemporaryDirectory(prefix="publication-scan-") as tmp:
            folder = Path(tmp)
            config = folder / "gitleaks.toml"
            config.write_text("[extend]\nuseDefault = true\n")
            ignore = folder / "empty-ignore"
            ignore.write_text("")
            # No repo config, inline allow comments, baseline, or ignore file can
            # silently disable the standard secret scan.
            env = {k: v for k, v in os.environ.items() if not k.startswith("GITLEAKS_")}
            try:
                p = subprocess.run([self.gitleaks, "stdin", "--no-banner", "--redact",
                                    "--config", str(config), "--gitleaks-ignore-path", str(ignore),
                                    "--ignore-gitleaks-allow", "--timeout", "120"],
                                   input=b"\n".join(self.parts), stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, cwd=tmp, env=env, timeout=135)
            except (OSError, subprocess.TimeoutExpired):
                raise Blocked("gitleaks unavailable or timed out") from None
            if p.returncode:
                raise Blocked("gitleaks detected a secret or failed; output withheld")
        print(f"PASS privacy guard: {len(self.patterns)} private rules, generic checks, "
              f"gitleaks; {len(self.blobs)} blobs, {self.commits} commits; no matches")


def install(path):
    root = root_dir()
    load_patterns(path, root)
    if not shutil.which("gitleaks"):
        raise Blocked("gitleaks is required")
    configured = subprocess.run(["git", "config", "--get", "core.hooksPath"],
                                capture_output=True, text=True)
    if configured.returncode not in (0, 1):
        raise Blocked("cannot inspect existing hook configuration")
    if configured.returncode == 0 and configured.stdout.strip() != ".githooks":
        raise Blocked("existing hooksPath requires explicit integration; not overwritten")
    hooks_dir = Path(os.fsdecode(git("rev-parse", "--git-path", "hooks")).strip())
    if configured.returncode == 1 and any((hooks_dir / h).exists() for h in HOOKS):
        raise Blocked("existing Git hooks require explicit integration; not overwritten")
    for hook in HOOKS:
        file = root / ".githooks" / hook
        if not file.is_file():
            raise Blocked("hook source missing")
        file.chmod(file.stat().st_mode | 0o111)
    git("config", "--local", CONFIG_KEY, str(Path(path).expanduser().resolve()))
    git("config", "--local", "core.hooksPath", ".githooks")
    print("Installed local pre-commit, commit-msg, pre-push guards; private path not printed")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["install", "staged", "message", "push", "history"])
    parser.add_argument("argument", nargs="?")
    args = parser.parse_args()
    try:
        if args.mode == "install":
            if not args.argument:
                raise Blocked("supply an external private-pattern file")
            install(args.argument)
            return 0
        scan = Scanner()
        if args.mode == "staged":
            scan.staged()
        elif args.mode == "message":
            if not args.argument:
                raise Blocked("commit-message file required")
            scan.add(Path(args.argument).read_bytes(), "commit message")
            for var in ("GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"):
                scan.add(git("var", var), "commit identity")
        elif args.mode == "history":
            refs = git("for-each-ref", "--format=%(refname) %(objectname)")
            scan.add(refs, "ref names")
            scan.history([line.split()[-1].decode() for line in refs.splitlines()])
        else:
            updates = sys.stdin.buffer.read()
            scan.add(updates, "push ref names")
            tips = []
            for line in updates.splitlines():
                fields = line.split()
                if len(fields) != 4:
                    raise Blocked("invalid pre-push input")
                oid = fields[1].decode("ascii")
                if not re.fullmatch(r"0{40}|0{64}", oid):
                    tips.append(oid)
            scan.history(tips)
        scan.finish()
        return 0
    except (Blocked, OSError, UnicodeError, ValueError) as exc:
        reason = str(exc) if isinstance(exc, Blocked) else "input/configuration error; details withheld"
        print("BLOCKED privacy guard: " + reason, file=sys.stderr)
        return 1
    except Exception:
        # An unexpected failure must neither allow publication nor dump private
        # paths/values through a traceback into logs that may later be shared.
        print("BLOCKED privacy guard: unexpected scan failure; details withheld", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
