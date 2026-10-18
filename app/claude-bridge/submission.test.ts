// Runs inside Claude Code's real mod engine, with its external boundary mocked.
// No login, network, or model turn. Keep this separate from the Node unit tests.
import { test, expect, mock } from 'claude-code/testing';
for (const allowed of [false, true]) {
  test(allowed ? 'authorized exact payload enters once' : 'canceled payload never enters', async ($, on) => {
    const clock = mock.clock(on);
    mock.env(on, {NAW_SUBMIT_SOCKET:'/fixture/socket', NAW_HOOK_TOKEN:'fixture-token'});
    on('session.id', async () => ({value:'fixture-session'}));
    on('session.version', async () => ({value:{version:'2.1.302'}}));
    on('prompt.read', async () => ({value:{text:'',cursor:0}}));
    on('session.start', async ($, e) => e);
    let polls = 0; const calls = []; const entered = []; const results = [];
    on('http.fetch', async ($, e) => {
      const route = new URL(e.url).pathname, body = JSON.parse(e.init.body);
      expect(e.init.socketPath).toBe('/fixture/socket');
      calls.push(route);
      if (route === '/result') results.push(body.status);
      const value = route === '/next' ? (++polls === 1 ? {id:'fixture-id',text:'fixture text'} : {closed:true}) : route === '/authorize' ? {allowed} : {received:true};
      return {value:{ok:true,status:200,headers:{},text:JSON.stringify(value)}};
    });
    on('prompt.submit', async ($, e) => {
      expect(calls).toEqual(['/next','/authorize']);
      expect(e.origin).toEqual({kind:'plugin',name:'native-workspace-submit',asUser:true});
      entered.push(e.text); return {text:e.text};
    });
    await $.session.start({cwd:'/fixture'}); await clock.settle();
    expect(entered).toEqual(allowed ? ['fixture text'] : []);
    expect(results).toEqual([allowed ? 'accepted' : 'blocked']);
  });
}
