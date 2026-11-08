// Since 3751738 the default space (共同工作) stays hidden until something uses it: a member, notes, messages or other
// saved activity (renderer.js allSpaces; renderSpaceNavigation hides its sidebar row). A GUI script that starts from a
// fresh profile and then opens that space, or moves a session into it from the session menu, calls this right after
// its first launch, before anything is measured (T-170).
// - Already shown: nothing changes.
// - Nothing uses it yet, by the renderer's own rule: save one note, which also adds one "notes updated" event to the
//   space's record (a script that later looks up its own note event should take the latest), and wait until the
//   sidebar shows it.
// - In use but still hidden: fail. That is a product regression, and a note must not mask it.
// Production code never imports this module.
const shown = () => {
  const row = document.getElementById('room-nav')?.parentElement;
  // The row is static HTML, so before the first render it is not hidden yet; the renderer marks it once it draws it.
  return Boolean(row && !row.hidden && row.dataset.spaceId === 'shared' && document.getElementById('room-nav-name')?.textContent.trim());
};
async function waitShown(page, timeout) {
  try { await page.waitForFunction(shown, undefined, { timeout }); return true; } catch (error) { if (error.name === 'TimeoutError') return false; throw error; }
}
async function revealDefaultSpace(page, note = 'Test setup: the default space is in use (T-170)') {
  if (await waitShown(page, 3000)) return false;
  const { found, inUse, revision } = await page.evaluate(async () => {
    const state = await workspace.initial(), r = state.rooms.find(room => room.id === 'shared');
    // The same fields and membership test as renderer.js allSpaces.
    return { found: Boolean(r), revision: r?.metadataRevision, inUse: Boolean(r && (r.metadataRevision || r.revision || r.archived || r.notes || r.files?.length ||
      r.messages?.length || r.events?.length || state.sessions.some(s => window.nativeWorkspaceSpaces.isMember(s, 'shared')))) };
  });
  if (!found) throw Error('The service reported no default space');
  if (inUse) {
    if (await waitShown(page, 8000)) return false;
    throw Error('The default space is in use but the sidebar hides it: a product regression, not test setup');
  }
  await page.evaluate(([text, expected]) => workspace.spaceAction('shared', 'notes', [text, expected]), [note, revision]);
  if (!await waitShown(page, 8000)) throw Error('The default space did not show after its note was saved');
  return true;
}
module.exports = { revealDefaultSpace };
