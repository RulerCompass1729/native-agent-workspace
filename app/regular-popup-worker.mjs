import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createWireGuard, selectWithDsh, createDshContext } = require('./regular-popup-dsh.cjs');
const controller = new AbortController(); let host, grant, inputStarted = false, buffer = '';
const stop = () => { controller.abort(); process.exit(1); }, timer = setTimeout(stop, 35000);
process.on('SIGTERM', stop); process.stdin.on('end', stop); process.stdin.setEncoding('utf8');
async function run(input) {
  try {
    if (!process.env.DEEPSEEK_API_KEY || process.env.HOME !== process.env.DSH_HOME) throw Error();
    const originalFetch = globalThis.fetch.bind(globalThis), guard = createWireGuard(async (url, init) => {
      const approval = await new Promise(resolve => { grant = resolve; process.stdout.write('{"authorize":true}\n'); });
      const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!approval?.authorized || approval.budgetDay !== day || controller.signal.aborted) throw Error('dispatch-cancelled');
      return originalFetch(url, init);
    }, input);
    globalThis.fetch = guard.fetch; host = await createDshContext();
    const result = await selectWithDsh(input, { ctx: host.ctx, signal: controller.signal, usage: guard.usage });
    await new Promise(resolve => process.stdout.write(JSON.stringify(result) + '\n', resolve));
  } catch { process.exitCode = 1; }
  finally { try { await host?.close(); } finally { clearTimeout(timer); process.exit(process.exitCode || 0); } }
}
process.stdin.on('data', chunk => {
  buffer += chunk; if (Buffer.byteLength(buffer) > 16000) return stop(); let end;
  while ((end = buffer.indexOf('\n')) >= 0) {
    let value; try { value = JSON.parse(buffer.slice(0, end)); } catch { return stop(); } buffer = buffer.slice(end + 1);
    if (!inputStarted) { inputStarted = true; run(value); }
    else if (grant) { const resolve = grant; grant = null; resolve(value); }
    else return stop();
  }
});
