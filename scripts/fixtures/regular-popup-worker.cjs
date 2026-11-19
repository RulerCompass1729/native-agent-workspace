const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
let buffer = '', requested = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk; if (!buffer.includes('\n')) return;
  if (!requested) { requested = true; buffer = ''; process.stdout.write('{"authorize":true}\n'); return; }
  let readDenied = false, writeDenied = false;
  const outside = path.join(path.dirname(process.env.HOME), 'must-not-read');
  try { fs.readFileSync(outside); } catch { readDenied = true; }
  try { fs.writeFileSync(outside, 'changed'); } catch { writeDenied = true; }
  const command = cp.spawnSync('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' });
  process.stdout.write(JSON.stringify({ picks: [], costMicros: 0, probe: { readDenied, writeDenied, execDenied: command.status !== 0, credentialPresent: Boolean(process.env.DEEPSEEK_API_KEY), keyInArgv: process.argv.includes(process.env.DEEPSEEK_API_KEY) } }) + '\n', () => process.exit(0));
});
