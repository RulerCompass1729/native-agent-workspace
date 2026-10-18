// Preloaded only into our DSH UI host. Native agents never use this lease.
// The IPC pipe closes even when the desktop process crashes or is killed.
if (typeof process.send !== 'function' || !process.connected) {
  process.stderr.write('The workspace UI host requires its desktop parent.\n');
  process.exit(1);
}
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  // Let upstream clean up first; bound UI-only cleanup if a plugin hangs.
  setTimeout(() => process.exit(0), 1500).unref();
  process.kill(process.pid, 'SIGTERM');
}
process.once('disconnect', stop);
process.on('message', message => { if (message?.type === 'workspace-ui-stop') stop(); });
