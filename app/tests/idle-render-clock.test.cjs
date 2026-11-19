const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');

// Idle page cost (2026-11-15: the person's idle window used 37–126% of a core). The window's one-second
// clock redrew the whole window on every tick while any session's reported status was stale, which lasts
// as long as a session waits on a long tool or a permission. A stale status needs one redraw, when it
// turns stale; a newer snapshot redraws anyway. The real clock statement from renderer.js runs here
// with a counted render, a fake clock and no window.
function clock() {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/renderer.js'), 'utf8');
  const fresh = source.split('\n').find(line => line.startsWith('const nativeStatusFresh = '));
  const at = source.indexOf('const nativeActivityClock = setInterval('), end = source.indexOf('}, 1000);', at);
  // The clock with the state it keeps just above it (an older renderer has the clock alone).
  const start = source.includes('let staleStatusKeys') ? source.indexOf('let staleStatusKeys') : at;
  assert.ok(fresh && at > 0 && end > at && start <= at);
  const context = { now: 1_000_000, renders: 0, refreshed: 0, tick: null, selected: '', state: null, roomOverview: null, panorama: null, statusTicks: 0 };
  context.taskBoard = { tick() { context.statusTicks++; } };
  context.Date = { now: () => context.now };
  context.setInterval = fn => { context.tick = fn; return 1; };
  context.render = () => { context.renders++; };
  context.renderNativeActivity = () => {}; context.current = () => context.state?.sessions[0] || null;
  context.refreshRoomMemberTabs = () => { context.refreshed++; };
  vm.runInNewContext(fresh + '\n' + source.slice(start, end + '}, 1000);'.length), context);
  assert.equal(typeof context.tick, 'function');
  const idle = seconds => { for (let n = 0; n < seconds; n++) { context.now += 1000; context.tick(); } };
  return { context, idle };
}
const session = (id, more = {}) => ({ id, nativeId: id + '-native', state: 'idle', ...more });

test('a permission waiting longer than its freshness redraws the window once in a minute of idle, not every second', () => {
  const { context, idle } = clock();
  context.state = { sessions: [session('shown'), session('waiting', { state: 'approval',
    nativeApproval: { nativeOnly: true, observedAt: context.now - 10_000, requests: [{ id: 'permission:1', title: 'Bash' }] } })] };
  idle(60);
  assert.equal(context.renders, 1, `60 s idle with one stale permission: ${context.renders} whole-window redraws`);
});

test('a long tool run redraws once when its shared status turns stale, and again only for a newer stale observation', () => {
  const { context, idle } = clock();
  const activity = { nativeId: 'tool-native', turnId: 'turn-1', label: 'Bash', observedAt: context.now };
  context.state = { sessions: [session('shown'), session('tool', { state: 'working', sharedActivity: activity })] };
  idle(4);
  assert.equal(context.renders, 0, 'a fresh status needs no clock redraw');
  idle(56);
  assert.equal(context.renders, 1, 'turning stale redraws once');
  // A newer snapshot (its own redraw happens on arrival) brings a fresh observation, which later turns stale too.
  context.state = { sessions: [session('shown'), session('tool', { state: 'working', sharedActivity: { ...activity, observedAt: context.now } })] };
  idle(60);
  assert.equal(context.renders, 2);
});

test('a status the backend already marks stale and several stale sessions still cost one redraw each', () => {
  const { context, idle } = clock();
  context.state = { sessions: [session('a', { sharedActivity: { stale: true } }),
    session('b', { nativeApproval: { observedAt: context.now - 6000, requests: [] } })] };
  idle(60);
  assert.equal(context.renders, 1, 'both were stale at the first tick');
  context.state.sessions.push(session('c', { nativeApproval: { observedAt: context.now - 6000, requests: [] } }));
  idle(60);
  assert.equal(context.renders, 2, 'a third session turning stale redraws once more');
});

test('with nothing stale the clock never redraws the whole window, and the space header still refreshes each second', () => {
  const { context, idle } = clock();
  context.state = { sessions: [session('a'), session('b', { sharedActivity: { observedAt: Number.NaN } })] };
  context.selected = 'room';
  idle(60);
  assert.equal(context.renders, 0);
  assert.equal(context.refreshed, 60, 'member tab times keep their one-second refresh');
});
