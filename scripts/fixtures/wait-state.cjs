// Playwright 1.64.1's waitForFunction does not await a predicate that returns a Promise (an async function or a
// .then chain): the Promise is truthy, so the wait ends after one evaluation even when that reading is false.
// Poll the page and await each reading instead, the same rule as check-room's waitForState (T-151, T-169).
async function waitForState(page, check, arg, label, { attempts = 200, interval = 50 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) { if (await page.evaluate(check, arg)) return; await page.waitForTimeout(interval); }
  throw Error('Timed out waiting for ' + label);
}
module.exports = { waitForState };
