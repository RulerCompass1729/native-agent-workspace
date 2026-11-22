"""Read live Electron frames through the existing private GUI socket."""
import ctypes as C
import json
import math
import os
from pathlib import Path
import re
import secrets
import socket
import stat
import subprocess
import sys
import time

MESSAGE = 'frame 口径待核实'
BASIS = 'electron-getbounds-v1'
LEGACY_UNSUPPORTED = dict(status='unconfirmed', retry=False, failurePhase='admission', failureReason='invalid-request',
                          message='The authorized outbox could not confirm delivery; do not resend automatically.')


def require(value):
    if not value:
        raise ValueError(MESSAGE)


def exact_object(pairs):
    value = dict(pairs)
    require(len(value) == len(pairs))
    return value


def rectangle(value):
    require(isinstance(value, dict) and set(value) == {'x', 'y', 'width', 'height'})
    require(all(type(v) in (int, float) and math.isfinite(v) for v in value.values()))
    require(value['width'] > 0 and value['height'] > 0)
    return dict(value)


def windows(values, pid):
    require(isinstance(values, list) and 0 < len(values) <= 1000)
    result, seen = [], set()
    for row in values:
        require(isinstance(row, dict) and set(row) == {'pid', 'id', 'onScreen', 'bounds'})
        require(type(row['pid']) is int and row['pid'] == pid and type(row['id']) is int and 0 < row['id'] <= 0xffffffff)
        require(row['id'] not in seen and type(row['onScreen']) is bool)
        seen.add(row['id'])
        result.append(dict(row, bounds=rectangle(row['bounds'])))
    return sorted(result, key=lambda row: row['id'])


def observe(pid):
    helper = Path(__file__).parent / 'fixtures/install-windows.js'
    data = subprocess.check_output(['/usr/bin/osascript', '-l', 'JavaScript', str(helper), str(pid), '--menu-metadata'], timeout=1.5)
    require(len(data) <= 1024 * 1024)
    return json.loads(data)


def observation(value, pid):
    if isinstance(value, list):
        return windows(value, pid), [], {}
    require(isinstance(value, dict) and set(value) == {'windows', 'displays'})
    require(isinstance(value['windows'], list))
    layers, records = {}, []
    for row in value['windows']:
        require(isinstance(row, dict) and set(row) == {'pid', 'id', 'onScreen', 'bounds', 'layer'})
        require(type(row['layer']) is int)
        records.append({key: row[key] for key in ['pid', 'id', 'onScreen', 'bounds']})
        layers[row['id']] = row['layer']
    records = windows(records, pid)
    require(isinstance(value['displays'], list) and len(value['displays']) <= 64)
    displays, ids = [], set()
    for display in value['displays']:
        require(isinstance(display, dict) and set(display) == {'id', 'bounds', 'menuBarHeight'})
        number, height = display['id'], display['menuBarHeight']
        require(type(number) is int and 0 < number <= 0xffffffff and number not in ids)
        box = rectangle(display['bounds'])
        require(height is None or type(height) in (int, float) and math.isfinite(height) and 0 < height < box['height'])
        ids.add(number)
        displays.append(dict(id=number, bounds=box, menuBarHeight=height))
    return records, sorted(displays, key=lambda row: row['id']), layers


def infer_menu_windows(records, displays, layers, managed):
    # Authorized geometry inference, not proof of an AppKit class or creator.
    counts = {}
    for row in records:
        if row['id'] in managed:
            continue
        box = row['bounds']
        matches = [d for d in displays if layers.get(row['id']) == 0 and d['menuBarHeight'] is not None and
                   box['x'] == d['bounds']['x'] and box['y'] == d['bounds']['y'] and
                   box['width'] == d['bounds']['width'] and box['height'] <= d['menuBarHeight']]
        require(len(matches) == 1)
        number = matches[0]['id']
        counts[number] = counts.get(number, 0) + 1
        require(counts[number] <= 4)
    return [dict(display=d['id'], count=counts[d['id']], bounds=d['bounds'], menuBarHeight=d['menuBarHeight'])
            for d in displays if d['id'] in counts]


def descriptor(profile, pid):
    root = Path(profile)
    require(root.is_absolute() and root.resolve() == root)
    s = root.lstat()
    require(stat.S_ISDIR(s.st_mode) and s.st_uid == os.getuid() and not s.st_mode & 0o077)
    identity = dict(dev=str(s.st_dev), ino=str(s.st_ino))
    fd = os.open(root / 'outbox-owner.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_uid == os.getuid() and s.st_nlink == 1 and not s.st_mode & 0o077 and s.st_size <= 16384)
        data = os.read(fd, 16385)
        last = os.fstat(fd)
        require(len(data) == s.st_size and (s.st_ino, s.st_size, s.st_mtime_ns) == (last.st_ino, last.st_size, last.st_mtime_ns))
    finally:
        os.close(fd)
    value = json.loads(data, object_pairs_hook=exact_object)
    require(isinstance(value, dict) and set(value) == {'version', 'socketPath', 'capability', 'issuer'} and type(value['version']) is int and value['version'] == 1)
    require(isinstance(value['issuer'], dict) and set(value['issuer']) == {'pid', 'started'} and type(value['issuer']['pid']) is int and value['issuer']['pid'] == pid)
    require(isinstance(value['issuer']['started'], str) and 0 < len(value['issuer']['started']) <= 200)
    require(isinstance(value['capability'], str) and re.fullmatch('[a-f0-9]{64}', value['capability']))
    endpoint = Path(value['socketPath'])
    require(endpoint.is_absolute() and endpoint.resolve() == endpoint and endpoint.name == 'outbox.sock')
    parent, entry = endpoint.parent.lstat(), endpoint.lstat()
    require(stat.S_ISDIR(parent.st_mode) and parent.st_uid == os.getuid() and not parent.st_mode & 0o077)
    require(stat.S_ISSOCK(entry.st_mode) and entry.st_uid == os.getuid() and not entry.st_mode & 0o077)
    return value, identity


def peer(sock, pid):
    # Public Darwin sys/un.h: SOL_LOCAL=0, LOCAL_PEERPID=2.
    require(sock.getsockopt(0, 2) == pid)
    uid, gid = C.c_uint32(), C.c_uint32()
    getpeereid = C.CDLL(None).getpeereid
    getpeereid.argtypes = [C.c_int, C.POINTER(C.c_uint32), C.POINTER(C.c_uint32)]
    getpeereid.restype = C.c_int
    require(getpeereid(sock.fileno(), C.byref(uid), C.byref(gid)) == 0 and uid.value == os.getuid())


def exchange(d, pid, kind, nonce):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
        sock.settimeout(1.0)
        sock.connect(d['socketPath'])
        peer(sock, pid)
        sock.sendall((json.dumps(dict(kind=kind, capability=d['capability'], identity=d['issuer'], nonce=nonce)) + '\n').encode())
        data = b''
        while b'\n' not in data:
            block = sock.recv(65536)
            require(block and len(data) + len(block) <= 1024 * 1024)
            data += block
        require(data.endswith(b'\n') and data.count(b'\n') == 1)
        return json.loads(data, object_pairs_hook=exact_object)


def request(profile, pid, started):
    d, identity = descriptor(profile, pid)
    nonce = secrets.token_hex(16)
    value = exchange(d, pid, 'window-frames-v3', nonce)
    version = 3
    if value == LEGACY_UNSUPPORTED and value['retry'] is False:
        # A current broker reports an unavailable capture separately.
        nonce = secrets.token_hex(16)
        value = exchange(d, pid, 'window-frames', nonce)
        version = 1
    return validate(value, pid, started, nonce, time.time() * 1000, identity, version)


def validate(value, pid, started, nonce, now, identity, version=1):
    keys = {'version', 'basis', 'pid', 'started', 'profile', 'nonce', 'capturedAt', 'windows', 'hiddenBackgroundWindows'}
    if version == 3:
        keys.add('localPageWindowIds')
    require(isinstance(value, dict) and set(value) == keys)
    require(type(value['version']) is int and value['version'] == version and value['basis'] == BASIS and type(value['pid']) is int and value['pid'] == pid and value['started'] == started and value['nonce'] == nonce)
    require(value['profile'] == identity)
    at = value['capturedAt']
    require(type(at) in (int, float) and math.isfinite(at) and 0 <= now - at <= 2000)
    result, owners, ids = {}, set(), set()
    for key in ['windows', 'hiddenBackgroundWindows']:
        require(isinstance(value[key], list) and len(value[key]) <= 1000 and (key != 'windows' or value[key]))
        rows = result[key] = {}
        for row in value[key]:
            require(isinstance(row, dict) and set(row) == {'id', 'owner', 'frame'})
            number, owner = row['id'], row['owner']
            require(type(number) is int and 0 < number <= 0xffffffff and number not in ids)
            require(isinstance(owner, str) and 0 < len(owner) <= 200 and not re.search('[\x00-\x1f\x7f]', owner) and owner not in owners)
            owners.add(owner); ids.add(number)
            require(len(ids) <= 1000)
            rows[number] = dict(row, frame=rectangle(row['frame']))
    if version == 3:
        locals_ids = value['localPageWindowIds']
        require(isinstance(locals_ids, list) and len(ids) + len(locals_ids) <= 1000)
        for number in locals_ids:
            require(type(number) is int and 0 < number <= 0xffffffff and number not in ids)
            ids.add(number)
        result['localPageWindowIds'] = locals_ids
    return result


def collect(pid, profile, started, sample=observe, frames=request):
    require(type(pid) is int and 1 < pid < 0x80000000 and isinstance(started, str) and 0 < len(started) <= 200)
    before, displays, layers = observation(sample(pid), pid)
    proof = frames(profile, pid, started)
    live, background = proof['windows'], proof['hiddenBackgroundWindows']
    local_pages = proof.get('localPageWindowIds', [])
    managed = set(live).union(background, local_pages)
    require(len(managed) == len(live) + len(background) + len(local_pages) and managed.issubset({row['id'] for row in before}))
    inferred = infer_menu_windows(before, displays, layers, managed)
    require(all(row['onScreen'] is False for row in before if row['id'] in background))
    result = [dict(row, frame=live[row['id']]['frame'], owner=live[row['id']]['owner'], frameBasis=BASIS) for row in before if row['id'] in live]
    require(observation(sample(pid), pid) == (before, displays, layers))
    return dict(pid=pid, windows=result, inferredMenuWindows=inferred)


if __name__ == '__main__':
    try:
        require(len(sys.argv) == 4 and re.fullmatch('[0-9]{1,10}', sys.argv[1]))
        print(json.dumps(collect(int(sys.argv[1]), sys.argv[2], sys.argv[3]), allow_nan=False))
    except Exception:
        sys.stderr.buffer.write((MESSAGE + '\n').encode('utf-8'))
        sys.exit(1)
