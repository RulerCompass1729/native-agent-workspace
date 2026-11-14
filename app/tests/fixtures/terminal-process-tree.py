"""Synthetic native process tree; no provider or model, only this test's group."""
import json
import os
import signal
import sys
import time

receipt, mode = sys.argv[1:]
signal.alarm(45)  # Cleanup insurance, never the asserted shutdown mechanism.
signal.signal(signal.SIGHUP, signal.SIG_IGN)
signal.signal(signal.SIGTERM, signal.SIG_IGN)
ready_read, ready_write = os.pipe()
child = os.fork()
if child == 0:
    os.close(ready_read)
    signal.alarm(45)
    if mode == 'graceful':
        signal.signal(signal.SIGTERM, signal.SIG_DFL)
    os.write(ready_write, b"1")
    os.close(ready_write)
    while True:
        time.sleep(1)
os.close(ready_write)
os.read(ready_read, 1)
os.close(ready_read)
if mode == 'leader-exits':
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
if mode == 'graceful':
    def save_and_exit(*_):
        time.sleep(2)
        with open(receipt + '.saved', 'w') as output:
            output.write('saved before exit')
        os.waitpid(child, 0)
        sys.exit(0)
    signal.signal(signal.SIGTERM, save_and_exit)
with open(receipt, 'w') as output:
    json.dump({'leader': os.getpid(), 'child': child, 'group': os.getpgrp()}, output)
while True:
    time.sleep(1)
