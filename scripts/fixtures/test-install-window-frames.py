import copy
import importlib.util
from pathlib import Path
import sys
import types
import unittest

spec = importlib.util.spec_from_file_location('frame_bridge', Path(__file__).parent.parent / 'install-window-frames.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
PID = 424242
CG = dict(x=297, y=168, width=1867, height=1022)
FRAME = dict(x=285, y=160, width=1904, height=1042)


def row():
    return dict(pid=PID, id=1, onScreen=True, bounds=dict(CG))


class Function:
    def __init__(self, fn):
        self.fn = fn
    def __call__(self, *args):
        return self.fn(*args)


def library(status=0, frame=FRAME):
    def bounds(cid, number, pointer):
        if cid != 17 or number != 1:
            raise AssertionError('Wrong native target')
        value = pointer._obj
        value.origin.x, value.origin.y = frame['x'], frame['y']
        value.size.width, value.size.height = frame['width'], frame['height']
        return status
    return types.SimpleNamespace(SLSMainConnectionID=Function(lambda: 17), SLSGetWindowBounds=Function(bounds))


class Bridge(unittest.TestCase):
    def test_g_oracle_retains_cg_and_reads_only_the_bound_id(self):
        reads = []
        def native(number):
            reads.append(number)
            return dict(FRAME)
        result = m.collect(PID, sample=lambda pid: [row()], reader=native)
        self.assertEqual(reads, [1])
        self.assertEqual(result['windows'][0]['bounds'], CG)
        self.assertEqual(result['windows'][0]['frame'], FRAME)
        self.assertEqual(result['windows'][0]['frameBasis'], m.BASIS)

    def test_typed_native_abi_positive_control(self):
        self.assertEqual(m.sls_reader(lambda _: library())(1), FRAME)
        self.assertEqual(m.C.sizeof(m.Rect), 32)

    def test_missing_library_refuses(self):
        def unavailable(_):
            raise OSError('synthetic unavailable')
        with self.assertRaises(m.FrameUnconfirmed):
            m.sls_reader(unavailable)

    def test_missing_symbol_refuses(self):
        with self.assertRaises(m.FrameUnconfirmed):
            m.sls_reader(lambda _: types.SimpleNamespace(SLSMainConnectionID=Function(lambda: 17)))

    def test_nonzero_native_return_refuses(self):
        with self.assertRaises(m.FrameUnconfirmed):
            m.sls_reader(lambda _: library(status=5))(1)

    def test_unknown_frame_shape_refuses(self):
        for value in [dict(FRAME, x=float('nan')), dict(FRAME, width=0)]:
            with self.assertRaises(m.FrameUnconfirmed):
                m.sls_reader(lambda _: library(frame=value))(1)

    def test_wrong_pid_never_reaches_native_reader(self):
        reads = []
        with self.assertRaises(m.FrameUnconfirmed):
            m.collect(PID, sample=lambda _: [dict(row(), pid=PID + 1)], reader=lambda number: reads.append(number))
        self.assertEqual(reads, [])

    def test_identity_change_after_native_read_refuses(self):
        for field, value in [('pid', PID + 1), ('id', 2), ('onScreen', False)]:
            after = dict(row(), **{field: value})
            samples = iter([[row()], [after]])
            with self.assertRaises(m.FrameUnconfirmed):
                m.collect(PID, sample=lambda _: next(samples), reader=lambda _: dict(FRAME))

    def test_cg_bracket_change_refuses(self):
        after = dict(row(), bounds=dict(CG, x=CG['x'] + 1))
        samples = iter([[row()], [after]])
        with self.assertRaises(m.FrameUnconfirmed):
            m.collect(PID, sample=lambda _: next(samples), reader=lambda _: dict(FRAME))

    def test_duplicate_id_or_missing_screen_identity_refuses(self):
        missing = row()
        del missing['onScreen']
        for values in [[row(), row()], [missing], []]:
            with self.assertRaises(m.FrameUnconfirmed):
                m.collect(PID, sample=lambda _: copy.deepcopy(values), reader=lambda _: dict(FRAME))

    def test_stable_offscreen_state_is_not_forged_as_onscreen(self):
        result = m.collect(PID, sample=lambda _: [dict(row(), onScreen=False)], reader=lambda _: dict(FRAME))
        self.assertIs(result['windows'][0]['onScreen'], False)

    def test_entry_only_names_readonly_private_functions(self):
        source = (Path(__file__).parent.parent / 'install-window-frames.py').read_text()
        self.assertNotIn('SLSGetWindowTransform', source)
        self.assertNotIn('SetWindow', source)
        self.assertNotIn('OrderWindow', source)
        self.assertNotIn('CGRequestScreenCaptureAccess', source)
        self.assertNotIn('AXUIElement', source)


if __name__ == '__main__':
    result = unittest.TextTestRunner(stream=sys.stdout, verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Bridge))
    sys.exit(not result.wasSuccessful())
