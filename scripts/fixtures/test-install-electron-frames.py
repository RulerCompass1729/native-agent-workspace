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
        for answers, kinds in [(4, ['window-frames-v4']), (3, ['window-frames-v4', 'window-frames-v3']),
                               (1, ['window-frames-v4', 'window-frames-v3', 'window-frames'])]:
            def exchange(_desc, pid, kind, nonce, answers=answers):
                version = {'window-frames-v4': 4, 'window-frames-v3': 3, 'window-frames': 1}[kind]
                if version > answers:
                    return dict(m.LEGACY_UNSUPPORTED)
                extra = dict(localPageWindowIds=[]) if version >= 3 else {}
                if version == 4:
                    extra['electronWindowIds'] = [1]
                return dict(value(), version=version, nonce=nonce, **extra)
            with self.subTest(answers=answers), patch.object(m, 'descriptor', return_value=({}, PROFILE)), \
                    patch.object(m.time, 'time', return_value=1.001), patch.object(m, 'exchange', side_effect=exchange) as calls:
                proof = m.request('/synthetic', PID, STARTED)
                self.assertEqual(proof['windows'][1]['owner'], 'synthetic-owner')
                self.assertEqual('electronWindowIds' in proof, answers == 4)
                sent = [call.args for call in calls.call_args_list]
                self.assertEqual([a[2] for a in sent], kinds)
                self.assertEqual(len({a[3] for a in sent}), len(sent))
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


# CG rows recorded when 287's strict post refused window 1071 (18:14:55Z; layer-0 rows only, as install-windows.js returns them).
DISPLAY = dict(id=1, bounds=dict(x=0, y=0, width=2560, height=1440), menuBarHeight=30)
MAIN, BACKGROUND, SYSTEM = 1068, (1115, 1120), 1071
SYSTEM_BOX = dict(x=0, y=940, width=500, height=500)
CLOSED, CLOSED_BOX = (19824, 19825, 19826), dict(x=660, y=295, width=1240, height=850)


def closed_background(number, onScreen=False, **box):
    return dict(pid=PID, id=number, onScreen=onScreen, bounds=dict(CLOSED_BOX, **box), layer=0)


def cg_287(extra=(), system=True):
    rows = [dict(pid=PID, id=MAIN, onScreen=True, bounds=dict(x=263, y=173, width=1904, height=1042), layer=0)]
    rows += [dict(pid=PID, id=n, onScreen=False, bounds=dict(x=660, y=295, width=1240, height=850), layer=0) for n in BACKGROUND]
    rows += [dict(pid=PID, id=n, onScreen=False, bounds=dict(x=0, y=0, width=2560, height=30), layer=0) for n in range(1064, 1068)]
    if system:
        rows.append(dict(pid=PID, id=SYSTEM, onScreen=False, bounds=dict(SYSTEM_BOX), layer=0))
    return dict(windows=rows + [dict(r) for r in extra], displays=[dict(DISPLAY)])


def proof_287(version=4, electron=(MAIN,) + BACKGROUND):
    data = dict(value(), version=version, windows=[dict(id=MAIN, owner='synthetic-owner', frame=dict(FRAME))],
                hiddenBackgroundWindows=[dict(id=n, owner='background-' + str(n), frame=dict(FRAME)) for n in BACKGROUND])
    if version >= 3:
        data['localPageWindowIds'] = []
    if version == 4:
        data['electronWindowIds'] = list(electron)
    return m.validate(data, PID, STARTED, NONCE, 1001, PROFILE, version)


def collect(samples, proof):
    samples = iter(samples)
    return m.collect(PID, '/synthetic', STARTED, sample=lambda _: next(samples), frames=lambda *_: proof)


class FramesV4(unittest.TestCase):
    def test_system_window_1071_outside_electron_is_recorded_not_refused(self):
        result = collect([cg_287(), cg_287()], proof_287())
        self.assertEqual([w['id'] for w in result['windows']], [MAIN])
        self.assertEqual(result['offscreenWindows'], [dict(bounds=SYSTEM_BOX, basis='outside-electron')])
        self.assertEqual([g['count'] for g in result['inferredMenuWindows']], [4])
        self.assertEqual(collect([cg_287(system=False)] * 2, proof_287())['offscreenWindows'], [])

    def test_unregistered_or_unstable_windows_are_still_refused(self):
        same_size = dict(pid=PID, id=1072, onScreen=False, bounds=dict(SYSTEM_BOX), layer=0)
        visible = cg_287(); visible['windows'][-1]['onScreen'] = True
        moved = cg_287(); moved['windows'][-1]['bounds'] = dict(SYSTEM_BOX, x=1)
        cases = {
            'same size, hidden, but Electron lists it': ([cg_287()] * 2, proof_287(electron=(MAIN,) + BACKGROUND + (SYSTEM,))),
            'Electron menu-bar-shaped window NAW did not register': ([cg_287()] * 2, proof_287(electron=(MAIN,) + BACKGROUND + (1064,))),
            'unknown window on screen': ([visible] * 2, proof_287()),
            'appears between samples': ([cg_287(system=False), cg_287()], proof_287()),
            'disappears between samples': ([cg_287(), cg_287(system=False)], proof_287()),
            'moves between samples': ([cg_287(), moved], proof_287()),
            'a second window outside Electron': ([cg_287([same_size])] * 2, proof_287()),
        }
        for name, (samples, proof) in cases.items():
            with self.subTest(name), self.assertRaises(ValueError):
                collect(samples, proof)

    def test_closed_background_windows_outside_electron_are_recorded_not_refused(self):
        # alpha.309 strict pre (11-26): three background windows Electron had dropped, beside 1071.
        closed = [closed_background(n) for n in CLOSED]
        result = collect([cg_287(closed)] * 2, proof_287())
        self.assertEqual(result['offscreenWindows'], [dict(bounds=SYSTEM_BOX, basis='outside-electron')] +
                         [dict(bounds=CLOSED_BOX, basis='closed-background')] * 3)
        many = [closed_background(1200 + n) for n in range(m.CLOSED_BACKGROUND_LIMIT)]
        self.assertEqual(len(collect([cg_287(many)] * 2, proof_287())['offscreenWindows']), m.CLOSED_BACKGROUND_LIMIT + 1)

    def test_only_the_exact_hidden_default_frame_outside_electron_counts_as_closed(self):
        cases = {
            'two pixels off center': ([cg_287([closed_background(1200, x=662)])] * 2, proof_287()),
            'one pixel taller': ([cg_287([closed_background(1200, height=851)])] * 2, proof_287()),
            'on screen': ([cg_287([closed_background(1200, onScreen=True)])] * 2, proof_287()),
            'still a BrowserWindow NAW did not register': ([cg_287([closed_background(1200)])] * 2, proof_287(electron=(MAIN,) + BACKGROUND + (1200,))),
            'more than the limit': ([cg_287([closed_background(1200 + n) for n in range(m.CLOSED_BACKGROUND_LIMIT + 1)])] * 2, proof_287()),
            'appears between samples': ([cg_287(), cg_287([closed_background(1200)])], proof_287()),
        }
        for name, (samples, proof) in cases.items():
            with self.subTest(name), self.assertRaises(ValueError):
                collect(samples, proof)
        for version in [1, 3]:
            with self.subTest(version=version), self.assertRaises(ValueError):
                collect([cg_287([closed_background(1200)])] * 2, proof_287(version))

    def test_background_size_is_main_window_default(self):
        main = (Path(__file__).parent.parent.parent / 'app/main.cjs').read_text(encoding='utf-8')
        width, height = m.BACKGROUND_SIZE
        self.assertRegex(main, r"function windowOptions\(view = \{\}\) \{ return \{ title: '[^']+', width: %d, height: %d, \.\.\.view\.bounds," % (width, height))
        self.assertIn('new BrowserWindow({ ...windowOptions(), show: false, focusable: false, skipTaskbar: true })', main)

    def test_electron_list_is_strict_and_covers_every_registered_window(self):
        for electron in [(MAIN,), (MAIN, BACKGROUND[0]), (MAIN,) + BACKGROUND + (MAIN,), (MAIN, True) + BACKGROUND, None, (0,)]:
            with self.subTest(electron=electron), self.assertRaises(ValueError):
                data = dict(value(), version=4, localPageWindowIds=[], electronWindowIds=electron if electron is None else list(electron),
                            windows=[dict(id=MAIN, owner='synthetic-owner', frame=dict(FRAME))],
                            hiddenBackgroundWindows=[dict(id=n, owner='background-' + str(n), frame=dict(FRAME)) for n in BACKGROUND])
                m.validate(data, PID, STARTED, NONCE, 1001, PROFILE, 4)
        with self.assertRaises(ValueError):
            m.validate(dict(value(), version=4, localPageWindowIds=[7], electronWindowIds=[1]), PID, STARTED, NONCE, 1001, PROFILE, 4)
        self.assertEqual(m.validate(dict(value(), version=4, localPageWindowIds=[7], electronWindowIds=[7, 1]), PID, STARTED, NONCE, 1001, PROFILE, 4)['electronWindowIds'], [7, 1])

    def test_menu_band_and_missing_display_metadata_give_no_offscreen_exemption(self):
        near_menu = cg_287(system=False)
        near_menu['windows'][3]['bounds'] = dict(x=0, y=0, width=2559, height=30)
        no_height = cg_287()
        no_height['windows'] = [r for r in no_height['windows'] if r['id'] not in range(1064, 1068)]
        no_height['displays'][0]['menuBarHeight'] = None
        for name, sample in [('one pixel narrower than the menu bar', near_menu), ('menu height unavailable', no_height)]:
            with self.subTest(name), self.assertRaises(ValueError):
                collect([sample] * 2, proof_287())

    def test_old_gui_without_electron_list_records_the_window_as_unproven(self):
        for version in [1, 3]:
            with self.subTest(version=version):
                result = collect([cg_287()] * 2, proof_287(version))
                self.assertEqual(result['offscreenWindows'], [dict(bounds=SYSTEM_BOX, basis='unproven')])
                with self.assertRaises(ValueError):
                    collect([cg_287([dict(pid=PID, id=1072, onScreen=False, bounds=dict(SYSTEM_BOX), layer=0)])] * 2, proof_287(version))


if __name__ == '__main__':
    unittest.main()
