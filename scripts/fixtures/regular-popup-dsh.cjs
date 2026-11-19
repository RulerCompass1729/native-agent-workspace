globalThis.fetch = async (url, init) => {
  if (url !== 'https://api.deepseek.com/anthropic/v1/messages' || init.headers['x-deepseek-harness-user-id'] || init.headers['x-deepseek-harness-session-id']) throw Error('Fixture wire boundary');
  const body = JSON.parse(init.body), supplied = JSON.parse(body.messages[0].content[0].text);
  const output = JSON.stringify({ picks: supplied.candidates.slice(0, 1).map(c => ({ id: c.id, why: 'Synthetic public candidate matches the supplied concern.' })) });
  const events = [
    { type: 'message_start', message: { id: 'synthetic', type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], usage: { input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 100 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: output } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 100 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream', date: 'Wed, 18 Nov 2026 02:00:00 GMT' } });
};
import('../../app/regular-popup-worker.mjs');
