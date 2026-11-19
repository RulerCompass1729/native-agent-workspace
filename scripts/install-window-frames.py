"""External installer metadata only; no window mutation or content capture."""
import ctypes as C
import json
import math
from pathlib import Path
import re
import subprocess
import sys

MESSAGE = 'frame 口径待核实'
BASIS = 'native-window-frame-v1'


class FrameUnconfirmed(RuntimeError):
    pass


def rectangle(value):
    if not isinstance(value, dict) or set(value) != {'x', 'y', 'width', 'height'}:
        raise FrameUnconfirmed(MESSAGE)
    if any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value.values()):
        raise FrameUnconfirmed(MESSAGE)
    if value['width'] <= 0 or value['height'] <= 0:
        raise FrameUnconfirmed(MESSAGE)
    return dict(value)


def windows(values, pid):
    if not isinstance(values, list) or not values or len(values) > 1000:
        raise FrameUnconfirmed(MESSAGE)
    result, seen = [], set()
    for row in values:
        if not isinstance(row, dict) or set(row) != {'pid', 'id', 'onScreen', 'bounds'}:
            raise FrameUnconfirmed(MESSAGE)
        number = row['id']
        if type(row['pid']) is not int or row['pid'] != pid or type(number) is not int or not 0 < number <= 0xffffffff or number in seen or type(row['onScreen']) is not bool:
            raise FrameUnconfirmed(MESSAGE)
        seen.add(number)
        result.append(dict(pid=pid, id=number, onScreen=row['onScreen'], bounds=rectangle(row['bounds'])))
    return sorted(result, key=lambda row: row['id'])


def observe(pid):
    helper = Path(__file__).parent / 'fixtures/install-windows.js'
    data = subprocess.check_output(['/usr/bin/osascript', '-l', 'JavaScript', str(helper), str(pid)], timeout=1.5)
    if len(data) > 1024 * 1024:
        raise FrameUnconfirmed(MESSAGE)
    return json.loads(data)


class Point(C.Structure):
    _fields_ = [('x', C.c_double), ('y', C.c_double)]


class Size(C.Structure):
    _fields_ = [('width', C.c_double), ('height', C.c_double)]


class Rect(C.Structure):
    _fields_ = [('origin', Point), ('size', Size)]


def sls_reader(load=C.CDLL):
    try:
        library = load('/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight')
        connection, get_bounds = library.SLSMainConnectionID, library.SLSGetWindowBounds
        connection.argtypes, connection.restype = [], C.c_int
        get_bounds.argtypes, get_bounds.restype = [C.c_int, C.c_uint32, C.POINTER(Rect)], C.c_int
        if C.sizeof(Rect) != 32:
            raise FrameUnconfirmed(MESSAGE)
        cid = connection()
    except Exception as error:
        raise FrameUnconfirmed(MESSAGE) from error

    def read(number):
        value = Rect()
        if get_bounds(cid, number, C.byref(value)) != 0:
            raise FrameUnconfirmed(MESSAGE)
        return rectangle(dict(x=value.origin.x, y=value.origin.y, width=value.size.width, height=value.size.height))
    return read


def collect(pid, sample=observe, reader=None):
    if type(pid) is not int or not 1 < pid < 0x80000000:
        raise FrameUnconfirmed(MESSAGE)
    before = windows(sample(pid), pid)
    read_frame = reader if reader is not None else sls_reader()
    result = [dict(row, frame=rectangle(read_frame(row['id'])), frameBasis=BASIS) for row in before]
    # Recheck identity and the observation bracket after all private reads.
    if windows(sample(pid), pid) != before:
        raise FrameUnconfirmed(MESSAGE)
    return dict(pid=pid, windows=result)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or not re.fullmatch('[0-9]{1,10}', sys.argv[1]):
            raise FrameUnconfirmed(MESSAGE)
        print(json.dumps(collect(int(sys.argv[1])), allow_nan=False))
    except Exception:
        sys.stderr.buffer.write((MESSAGE + '\n').encode('utf-8'))
        sys.exit(1)
