"""Owned raw-mode choice fixture; logs bytes and effects, never calls a model."""
import json, os, sys, termios, tty
log = sys.argv[1]
def record(**row):
    with open(log, 'a') as out:
        out.write(json.dumps(row) + '\n')
fd = sys.stdin.fileno()
saved = termios.tcgetattr(fd)
tty.setraw(fd)
dialog = True
selected = 1
text = ''
pending = b''
def paint():
    sys.stdout.write("\x1b[2J\x1b[HTeach auto mode about your environment?\r\n❯ 1. Yes\r\n  2. Not now\r\n  3. Don't show again\r\nEnter to confirm · Esc to cancel")
    sys.stdout.flush()
try:
    paint()
    while True:
        data = os.read(fd, 65536)
        if not data: break
        record(bytes=data.hex(), inDialog=dialog)
        pending += data
        if pending.startswith(b'\x1b[200~'):
            if b'\x1b[201~' not in pending: continue
            paste, pending = pending[6:].split(b'\x1b[201~', 1)
            content = paste.decode('utf-8', errors='replace')
            record(effect='ignored-paste' if dialog else 'editor-paste', text=content)
            if not dialog: text += content
        data, pending = pending, b''
        for value in data.decode('utf-8', errors='replace'):
            if value == '\x03': sys.exit(0)
            if value == '\x12':
                dialog = True
                record(effect='opened')
                paint()
                continue
            if dialog:
                if value in '\r\n':
                    record(effect='confirmed', option=selected, label='Yes' if selected == 1 else 'Not now')
                    dialog = False
                    sys.stdout.write('\x1b[2J\x1b[H❯ ')
                elif value == '\x1b':
                    record(effect='cancelled')
                    dialog = False
                    sys.stdout.write('\x1b[2J\x1b[H❯ ')
                elif value in '123': selected = int(value)
                else: record(effect='ignored-by-dialog', character=value)
            elif value in '\r\n':
                record(effect='submitted', text=text)
                text = ''
                sys.stdout.write('\r\n❯ ')
            else:
                text += value
                sys.stdout.write(value)
        sys.stdout.flush()
finally:
    termios.tcsetattr(fd, termios.TCSADRAIN, saved)
