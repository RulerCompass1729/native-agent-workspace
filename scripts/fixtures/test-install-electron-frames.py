import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('electron_frames', Path(__file__).parent.parent / 'install-electron-frames.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
PID, STARTED, NONCE = 424242, 'synthetic UTC lifetime', '1' * 32
PROFILE = dict(dev='1', ino='2')
FRAME = dict(x=285, y=160, width=1904, height=1042)
CG = dict(x=297, y=168, width=1867, height=1022)


def value():
    return dict(version=1, basis=m.BASIS, pid=PID, started=STARTED, profile=PROFILE, nonce=NONCE, capturedAt=1000,
                windows=[dict(id=1, owner='synthetic-owner', frame=dict(FRAME))], hiddenBackgroundWindows=[])


def row():
    return dict(pid=PID, id=1, onScreen=True, bounds=dict(CG))


class Frames(unittest.TestCase):
    def test_positive_public_frame_and_cg_are_separate(self):
        live = m.validate(value(), PID, STARTED, NONCE, 1001, PROFILE)
        result = m.collect(PID, '/synthetic', STARTED, sample=lambda _: [row()], frames=lambda *_: live)
        self.assertEqual(result['windows'][0]['frame'], FRAME)
        self.assertEqual(result['windows'][0]['bounds'], CG)
        self.assertEqual(result['windows'][0]['owner'], 'synthetic-owner')

    def test_nonce_lifetime_pid_basis_version_and_unknown_fields_refuse(self):
        for field, replacement in [('nonce', '2' * 32), ('started', 'other'), ('pid', PID + 1),
                                   ('basis', 'unknown'), ('version', True), ('profile', dict(dev='1', ino='3')), ('extra', 'private')]:
            with self.subTest(field=field), self.assertRaises(ValueError):
                m.validate(dict(value(), **{field: replacement}), PID, STARTED, NONCE, 1001, PROFILE)

    def test_old_future_and_nonfinite_samples_refuse(self):
        for stamp in [-2000, 1002, float('nan'), float('inf'), True]:
            with self.subTest(stamp=stamp), self.assertRaises(ValueError):
                m.validate(dict(value(), capturedAt=stamp), PID, STARTED, NONCE, 1001, PROFILE)

    def test_strict_frame_fields_and_owner_refuse(self):
        for change in [dict(id=0), dict(id=True), dict(owner=''), dict(owner='bad\nowner'),
                       dict(frame=dict(FRAME, width=0)), dict(frame=dict(FRAME, x=float('nan'))), dict(title='private')]:
            data = value(); data['windows'][0].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                m.validate(data, PID, STARTED, NONCE, 1001, PROFILE)

    def test_duplicate_id_or_owner_refuses(self):
        for change in [{}, dict(id=2)]:
            data = value(); data['windows'].append(dict(data['windows'][0], **change))
            with self.assertRaises(ValueError):
                m.validate(data, PID, STARTED, NONCE, 1001, PROFILE)

    def test_cg_pid_id_visibility_and_bounds_bracket_refuse(self):
        live = m.validate(value(), PID, STARTED, NONCE, 1001, PROFILE)
        for change in [dict(pid=PID + 1), dict(id=2), dict(onScreen=False), dict(bounds=dict(CG, x=298))]:
            samples = iter([[row()], [dict(row(), **change)]])
            with self.subTest(change=change), self.assertRaises(ValueError):
                m.collect(PID, '/synthetic', STARTED, sample=lambda _: next(samples), frames=lambda *_: live)

    def test_missing_or_extra_window_identity_refuses(self):
        live = m.validate(value(), PID, STARTED, NONCE, 1001, PROFILE)
        for records in [[], [dict(row(), id=2)], [row(), dict(row(), id=2)]]:
            with self.assertRaises(ValueError):
                m.collect(PID, '/synthetic', STARTED, sample=lambda _: records, frames=lambda *_: live)

    def test_proven_background_is_excluded_but_unknown_or_onscreen_windows_refuse(self):
        data = value(); data['hiddenBackgroundWindows'] = [dict(id=2, owner='background', frame=dict(FRAME))]
        live = m.validate(data, PID, STARTED, NONCE, 1001, PROFILE)
        records = [row(), dict(row(), id=2, onScreen=False)]
        good = m.collect(PID, '/synthetic', STARTED, sample=lambda _: records, frames=lambda *_: live)
        self.assertEqual([w['id'] for w in good['windows']], [1])
        for wrong in [[row(), dict(row(), id=2, onScreen=True)],
                      records + [dict(row(), id=3)], records + [dict(row(), id=3, onScreen=False)]]:
            with self.assertRaises(ValueError):
                m.collect(PID, '/synthetic', STARTED, sample=lambda _: wrong, frames=lambda *_: live)
        changed = iter([records, [row(), dict(records[1], bounds=dict(CG, x=300))]])
        with self.assertRaises(ValueError):
            m.collect(PID, '/synthetic', STARTED, sample=lambda _: next(changed), frames=lambda *_: live)

    def test_background_rows_are_strict_and_cannot_duplicate_human_identity(self):
        for rows in [None, [dict(id=1, owner='background', frame=dict(FRAME))],
                     [dict(id=2, owner='synthetic-owner', frame=dict(FRAME))],
                     [dict(id=2, owner='background', frame=dict(FRAME), title='private')],
                     [dict(id=2, owner='background', frame=dict(FRAME, width=0))]]:
            with self.assertRaises(ValueError):
                m.validate(dict(value(), hiddenBackgroundWindows=rows), PID, STARTED, NONCE, 1001, PROFILE)

    def test_local_pages_must_match_same_pid_and_remain_in_the_bracket(self):
        proof = m.validate(dict(value(), version=3, localPageWindowIds=[2]), PID, STARTED, NONCE, 1001, PROFILE, 3)
        page = dict(row(), id=2, bounds=dict(x=0, y=940, width=500, height=500))
        for visible in [True, False]:
            page['onScreen'] = visible
            records = [row(), page]
            result = m.collect(PID, '/synthetic', STARTED, sample=lambda _: records, frames=lambda *_: proof)
            self.assertEqual(result['windows'], [dict(row(), frame=FRAME, frameBasis=m.BASIS, owner='synthetic-owner')])
            for after in [[row()], [row(), dict(page, pid=PID + 1)], [row(), page, dict(page, id=3)]]:
                with self.subTest(after=after), self.assertRaises(ValueError):
                    samples = iter([records, after])
                    m.collect(PID, '/synthetic', STARTED, sample=lambda _: next(samples), frames=lambda *_: proof)
        for ids in [None, [True], [0], [1], [2, 2], [dict(id=2, title='private')]]:
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                m.validate(dict(value(), version=3, localPageWindowIds=ids), PID, STARTED, NONCE, 1001, PROFILE, 3)

    def test_legacy_fallback_uses_new_nonce_and_requires_exact_old_refusal(self):
        def exchange(_desc, pid, kind, nonce):
            if kind == 'window-frames-v3':
                return dict(m.LEGACY_UNSUPPORTED)
            return dict(value(), nonce=nonce)
        with patch.object(m, 'descriptor', return_value=({}, PROFILE)), patch.object(m.time, 'time', return_value=1.001), \
                patch.object(m, 'exchange', side_effect=exchange) as calls:
            self.assertEqual(m.request('/synthetic', PID, STARTED)['windows'][1]['owner'], 'synthetic-owner')
            a, b = (call.args for call in calls.call_args_list)
            self.assertEqual([a[2], b[2]], ['window-frames-v3', 'window-frames'])
            self.assertNotEqual(a[3], b[3])
        for response in [dict(m.LEGACY_UNSUPPORTED, failureReason='operation-unconfirmed'), dict(m.LEGACY_UNSUPPORTED, retry=0), value()]:
            with patch.object(m, 'descriptor', return_value=({}, PROFILE)), patch.object(m, 'exchange', return_value=response) as call:
                with self.assertRaises(ValueError):
                    m.request('/synthetic', PID, STARTED)
                call.assert_called_once()

    def test_wrong_kernel_peer_pid_refuses_before_sending_capability(self):
        class Socket:
            def getsockopt(self, level, option):
                self.options = (level, option)
                return PID + 1
        sock = Socket()
        with self.assertRaises(ValueError):
            m.peer(sock, PID)
        self.assertEqual(sock.options, (0, 2))

    def test_private_descriptor_and_permissions(self):
        with tempfile.TemporaryDirectory(prefix='electron-frame-descriptor-') as folder:
            root = Path(folder).resolve()
            endpoint = root / 'outbox.sock'
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(str(endpoint)); os.chmod(endpoint, 0o600)
                data = dict(version=1, socketPath=str(endpoint), capability='a' * 64, issuer=dict(pid=PID, started=STARTED))
                file = root / 'outbox-owner.json'; file.write_text(json.dumps(data)); os.chmod(file, 0o600)
                self.assertEqual(m.descriptor(str(root), PID)[1], dict(dev=str(root.stat().st_dev), ino=str(root.stat().st_ino)))
                os.chmod(file, 0o644)
                with self.assertRaises(ValueError):m.descriptor(str(root), PID)
                os.chmod(file, 0o600)
                for bad in [dict(data, version=True), dict(data, extra=True), dict(data, issuer=dict(pid=PID + 1, started=STARTED))]:
                    file.write_text(json.dumps(bad))
                    with self.assertRaises(ValueError):m.descriptor(str(root), PID)
                file.unlink(); file.symlink_to('outbox.sock')
                with self.assertRaises(OSError):m.descriptor(str(root), PID)

    def test_duplicate_json_fields_refuse(self):
        with self.assertRaises(ValueError):
            json.loads('{"version":1,"version":1}', object_pairs_hook=m.exact_object)

    def test_wrong_kernel_uid_refuses(self):
        class Function:
            def __call__(self, fd, uid, gid):
                uid._obj.value = os.getuid() + 1
                return 0
        class Library:
            getpeereid = Function()
        class Socket:
            def getsockopt(self, *_):return PID
            def fileno(self):return 17
        with patch.object(m.C, 'CDLL', return_value=Library()), self.assertRaises(ValueError):
            m.peer(Socket(), PID)


if __name__ == '__main__':
    unittest.main()
