const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..', '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

// "Needs you" status text (11-15): one colour for the sidebar row and the hover card, 4.5:1 on every background
// it sits on. Backgrounds measured live in a hidden synthetic window on 11-15: row plain/hover/selected, the
// card's own colour, and the 70% card over the page. Over the strict worst backdrop (sidebar-hover-card.test.cjs)
// no value that still reads as orange reaches 4.5:1, so that case is not part of this check.
const BACKGROUNDS = {
  light: { raised: '#ffffff', hover: '#f1f3f5', selected: '#f5f6f7', surface: '#ffffff' },
  dark: { raised: '#2c2c2e', hover: '#353638', selected: '#212123', surface: '#151517' },
};
const hex = value => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
const channel = c => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
const contrast = (a, b) => { const [lo, hi] = [luminance(a), luminance(b)].sort((x, y) => x - y); return (hi + 0.05) / (lo + 0.05); };

test('the sidebar row and the hover card take the needs-you colour from one token', () => {
  const look = read('app/renderer/sidebar-look.css'), card = read('app/renderer/sidebar-hover-card.css');
  assert.match(look, /\.session-row:has\(\.state-dot\.approval\) \.session-metadata small\{color:var\(--approval-ink\)!important;/);
  assert.match(card, /#naw-hover-card \[data-tone="approval"\]\{color:var\(--approval-ink\);/);
  for (const name of fs.readdirSync(path.join(root, 'app/renderer')).filter(file => file.endsWith('.css')))
    assert.doesNotMatch(read('app/renderer/' + name).replace(/--approval-ink:#[0-9a-f]{6}/g, ''), /#a8553a/i, name + ' keeps no copy of the old colour');
});

test('the needs-you colour keeps 4.5:1 on the rows and the card in both looks', () => {
  const styles = read('app/renderer/styles.css'), card = read('app/renderer/sidebar-hover-card.css');
  const value = {
    light: styles.match(/^:root\{[^}]*--approval-ink:(#[0-9a-f]{6});/)?.[1],
    // scripts/build-ui.cjs nests styles.css inside .naw: a plain body[...] rule would match nothing there.
    dark: styles.match(/^body\[data-ds-dark-theme\] &\{--approval-ink:(#[0-9a-f]{6})\}/m)?.[1],
  };
  assert.ok(value.light && value.dark, 'Light value in the :root palette, dark value in the nested dark rule: ' + JSON.stringify(value));
  const opacity = Number(card.match(/--naw-hover-card-opacity:(\d+)%/)[1]) / 100, failures = [];
  for (const [look, b] of Object.entries(BACKGROUNDS)) {
    const overPage = hex(b.raised).map((v, i) => opacity * v + (1 - opacity) * hex(b.surface)[i]);
    for (const [where, bg] of [['row', hex(b.raised)], ['row hover', hex(b.hover)], ['row selected', hex(b.selected)], ['card over the page', overPage]]) {
      const ratio = contrast(hex(value[look]), bg); if (ratio < 4.5) failures.push(`${look} ${where} ${ratio.toFixed(2)}`);
    }
  }
  assert.deepEqual(failures, []);
});
