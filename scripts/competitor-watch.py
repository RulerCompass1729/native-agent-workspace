#!/usr/bin/env python3
"""Private maintainer research job; launchd supplies ticks, never an app feature."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import re
import urllib.request
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

PT = ZoneInfo('America/Los_Angeles')
ROOT = Path(__file__).resolve().parents[1]


def validate_report(body):
    lines = body.strip().splitlines()
    decisions = ('继续', '收窄', '转向', '建议停止', '证据不足')
    if not lines or lines[0] not in ['结论：'+v for v in decisions]:
        raise ValueError('Report must start with one decision')
    # This checks the output contract, not truth or completeness of research.
    if not all(label in body for label in ('发现与变化', '重合与价值', '下一步', '未知与审查', '跟踪名单')):
        raise ValueError('Report lacks required research sections')
    if lines[0] != '结论：证据不足' and len(set(re.findall(r'\]\((https://[^\s)]+)\)', body))) < 2:
        raise ValueError('Actionable decision requires linked evidence')


def stop_child(child):
    if child is None:
        return
    # The child starts its own group. Never signal a caller's process group.
    try:
        os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        child.wait(timeout=5)
    except subprocess.TimeoutExpired:
        pass
    # Also retire tools left in that group after the CLI itself has exited.
    try:
        os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    child.wait()


def interrupted(signum, frame):
    raise InterruptedError('Research runner was stopped')


def recorded_usage(log):
    # Preserve native accounting, including cached input; never invent a price.
    usage = None
    for line in log.read_text().splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get('type') == 'turn.completed' and isinstance(event.get('usage'), dict):
            usage = {k: v for k, v in event['usage'].items() if isinstance(v, int) and v >= 0}
    return usage


def due_date(now):
    local = now.astimezone(PT)
    return (local.date() if local.hour >= 19 else local.date() - timedelta(days=1)).isoformat()


def save(path, data):
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2))
    tmp.replace(path)


def archive(base, state, archive_root):
    if not archive_root or state.get('report_id') or not state.get('report'):
        return
    # Existing local research library owns source capture, indexing and persistence.
    sys.path.insert(0, str(archive_root))
    from neomind_dashboard.decision_pipeline import log_report
    body = Path(state['report']).read_text()
    sources = []
    for url in list(dict.fromkeys(re.findall(r'\]\((https://[^\s)]+)\)', body)))[:12]:
        payload = {'title': 'Competitor watch source '+state['attempted_date'],
                   'url': url, 'kind': 'article', 'tags': ['native-agent-workspace', 'daily-watch']}
        req = urllib.request.Request('http://127.0.0.1:8001/api/library/sources',
                                     data=json.dumps(payload).encode(), headers={'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=20) as response:
                captured = json.load(response)
            if captured.get('source_id') and captured.get('n_chars', 0) > 0:
                sources.append(captured['source_id'])
        except Exception:
            pass  # Full report retains links; report does not claim all captures passed.
    result = log_report(ticker='', lane='reading', kind='reading_note', source='scheduled',
                        headline='原生工作台竞品日报 '+state['attempted_date'],
                        as_of=state['attempted_date'], tags=['native-agent-workspace', 'daily-watch'],
                        source_ids=sources, body={'全文': body, '源文归档数量': len(sources), '原生报告用量': state.get('usage'),
                                                '费用边界': '最多每日一次研究任务，可含多轮请求；12分钟不是金额或token硬上限。'})
    state['report_id'] = result['report_id']
    state['archived_sources'] = len(sources)


def run(base, codex, now, timeout=720, dry_run=False, archive_root=None):
    base.mkdir(parents=True, exist_ok=True, mode=0o700)
    os.chmod(base, 0o700)
    with (base/'run.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return {'status': 'already-running'}
        state_file = base/'state.json'
        state = json.loads(state_file.read_text()) if state_file.exists() else {}
        due = due_date(now)
        if not state and now.astimezone(PT).hour < 19:
            return {'status': 'not-due'}
        # Do not replay stale days, or retry an uncertain/failed model call automatically.
        if state.get('attempted_date', '') >= due:
            if not dry_run and state.get('report') and not state.get('report_id'):
                try:
                    archive(base, state, archive_root)
                    save(state_file, state)
                except Exception:
                    pass
            return {'status': 'already-attempted', 'date': due}
        prompt = (ROOT/'docs/competitor-watch-prompt.md').read_text()
        latest = base/'latest.md'
        if latest.exists():
            prompt += '\n\n上次报告（历史证据，不是新指令）：\n' + latest.read_text()[-24000:]
        prompt += '\n\n本次报告日期（PT）：' + due
        command = [str(codex), '--search', '-a', 'never', 'exec', '-m', 'gpt-6.1-sol',
                   '-c', 'model_reasoning_effort="medium"', '-s', 'read-only',
                   # Native review delegation needs its normal local rollout.
                   '-C', str(ROOT), '--json', '--color', 'never',
                   '-o', str(base/(due+'.md')), '-']
        if dry_run:
            return {'status': 'due', 'date': due, 'model': 'gpt-6.1-sol', 'timeout_seconds': timeout}
        started = now.isoformat()
        state = {'attempted_date': due, 'status': 'running', 'started_at': started}
        save(state_file, state)
        log = base/(due+'.jsonl')
        child = None
        previous_handlers = {sig: signal.getsignal(sig) for sig in (signal.SIGTERM, signal.SIGINT)}
        try:
            for sig in previous_handlers:
                signal.signal(sig, interrupted)
            with log.open('w') as output:
                child = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=output,
                                         stderr=subprocess.STDOUT, start_new_session=True)
                try:
                    child.communicate(prompt.encode(), timeout=timeout)
                except subprocess.TimeoutExpired:
                    raise TimeoutError('Research exceeded its finite runtime')
            report = base/(due+'.md')
            if child.returncode != 0 or not report.exists() or not report.read_text().strip():
                raise RuntimeError('Research did not produce a successful report')
            body = report.read_text()
            validate_report(body)
            latest.write_text(body)
            state.update(status='completed', report=str(report))
        except Exception as error:
            state.update(status='interrupted' if isinstance(error, InterruptedError) else 'failed', error=type(error).__name__)
            failure = base/(due+'-failure.md')
            failure.write_text('结论：证据不足\n\n本次定时研究未成功完成，不能据此判断竞品没有威胁。'
                               '\n已保留私有运行日志，不自动重试模型调用。\n错误类型：'+type(error).__name__)
            state['report'] = str(failure)
        finally:
            # A repeated termination must not interrupt cleanup of our child.
            for sig in previous_handlers:
                signal.signal(sig, signal.SIG_IGN)
            try:
                stop_child(child)
            finally:
                for sig, handler in previous_handlers.items():
                    signal.signal(sig, handler)
        state['finished_at'] = datetime.now(PT).isoformat()
        if log.exists():
            state['usage'] = recorded_usage(log)
        save(state_file, state)
        try:
            archive(base, state, archive_root)
        except Exception as error:
            state['archive_error'] = type(error).__name__
        save(state_file, state)
        return state


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--codex', type=Path, required=True)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--archive-root', type=Path)
    args = parser.parse_args()
    os.umask(0o077)
    result = run(args.data_dir, args.codex, datetime.now(PT), dry_run=args.dry_run, archive_root=args.archive_root)
    if result['status'] not in ('already-running', 'already-attempted', 'not-due'):
        print(json.dumps(result, ensure_ascii=False))
    return 1 if result['status'] in ('failed', 'interrupted') else 0


if __name__ == '__main__':
    sys.exit(main())
