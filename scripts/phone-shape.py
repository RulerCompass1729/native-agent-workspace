"""Count JSON string tokens; never decode or retain conversation string values."""
import argparse
import json
from collections import Counter
from pathlib import Path


def shape(data):
    i, sessions, queues, rooms = 0, [], [], []
    roles = {b'user', b'human', b'assistant', b'tool', b'system'}
    keys = {b'sessions', b'messages', b'role', b'kind', b'text', b'rooms', b'queue'}

    def string(keep=False):
        nonlocal i
        i += 1
        start, size = i, 0
        while data[i] != 34:
            c = data[i]
            if c == 92:
                i += 6 if data[i + 1] == 117 else 2
                size += 1
            else:
                if c < 128 or c >= 192:
                    size += 2 if c >= 240 else 1
                i += 1
        raw = data[start:i] if keep and i - start <= 64 else b''
        i += 1
        return raw, size

    def value(context=''):
        nonlocal i
        while data[i] in b' \t\r\n':
            i += 1
        if data[i] == 34:
            raw, size = string(context in ('role', 'kind'))
            if context == 'text':
                return size
            return raw.decode('ascii') if raw in roles or context == 'kind' and raw in (b'text', b'tool', b'tool_call', b'tool_result') else 'other'
        if data[i] == 123:
            i += 1
            row = {}
            while True:
                while data[i] in b' \t\r\n,':
                    i += 1
                if data[i] == 125:
                    i += 1
                    break
                key, _ = string(True)
                while data[i] in b' \t\r\n:':
                    i += 1
                field = key.decode('ascii') if key in keys else ''
                result = value(field)
                if field in ('messages', 'role', 'kind', 'text'):
                    row[field] = result
            return row
        if data[i] == 91:
            i += 1
            result = []
            while True:
                while data[i] in b' \t\r\n,':
                    i += 1
                if data[i] == 93:
                    i += 1
                    break
                item = value()
                if context in ('sessions', 'messages'):
                    result.append(item)
                elif context in ('queue', 'rooms'):
                    result.append(None)
            if context == 'sessions':
                sessions.extend(result)
            if context == 'queue':
                queues.append(len(result))
            if context == 'rooms':
                rooms.append(len(result))
            return result
        while i < len(data) and data[i] not in b',]} \t\r\n':
            i += 1
        return None

    value()
    output = []
    for session in sessions:
        histogram = Counter()
        for m in session.get('messages', []):
            length = m.get('text') or 0
            histogram[(m.get('role', 'other'), m.get('kind', 'other'), length)] += 1
        output.append({'messages': sum(histogram.values()), 'distribution': [
            {'role': r, 'kind': k, 'length': n, 'count': c} for (r, k, n), c in sorted(histogram.items())]})
    return {'sessions': output, 'rooms': max(rooms, default=0), 'queues': queues}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('files', nargs='+')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    results = [shape(Path(f).read_bytes()) for f in args.files]
    result = {'version': 1, 'sessions': [s for r in results for s in r['sessions']],
              'rooms': max((r['rooms'] for r in results), default=0), 'queues': [n for r in results for n in r['queues']]}
    Path(args.output).write_text(json.dumps(result))
    print(json.dumps({'sessions': len(result['sessions']), 'messages': sum(s['messages'] for s in result['sessions']),
                      'rooms': result['rooms'], 'queueItems': sum(result['queues'])}))
