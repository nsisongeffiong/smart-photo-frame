import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { JSDOM, ResourceLoader, CookieJar } from 'jsdom';
import { startApp, jpeg } from './helpers.js';

// Drives the real page and script in jsdom against the real server. It cannot
// prove the layout looks right on a phone; it proves the flow works and that
// the page needs no inline script or style (the CSP forbids both).

const until = async (fn, what, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 25));
  }
};

async function openPage(base) {
  const jar = new CookieJar();
  const dom = await JSDOM.fromURL(base + '/', {
    runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true, cookieJar: jar,
    beforeParse(win) {
      // jsdom has no fetch; give the page one that shares its cookie jar.
      win.fetch = async (url, opts = {}) => {
        const abs = new URL(url, base).href;
        const headers = { ...(opts.headers || {}), cookie: jar.getCookieStringSync(abs) };
        const res = await fetch(abs, { ...opts, headers, redirect: 'manual' });
        for (const c of res.headers.getSetCookie?.() ?? []) jar.setCookieSync(c, abs);
        return res;
      };
      win.confirm = () => true;
    },
  });
  return dom;
}
const $ = (dom, sel) => dom.window.document.querySelector(sel);
const $$ = (dom, sel) => [...dom.window.document.querySelectorAll(sel)];
const text = (dom) => dom.window.document.body.textContent;

test('the page uses no inline script, inline style or event-handler attributes', async () => {
  const html = await fs.readFile(path.join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8');
  assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), 'inline <script>');
  assert.ok(!/<style[\s>]/i.test(html), 'inline <style>');
  assert.ok(!/\sstyle\s*=/i.test(html), 'style attribute');
  assert.ok(!/\son[a-z]+\s*=/i.test(html), 'on* attribute');
  const js = await fs.readFile(path.join(import.meta.dirname, '..', 'public', 'app.js'), 'utf8');
  assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(js), 'script builds DOM with text nodes only');
  assert.ok(!/\.setAttribute\(\s*['"]style/.test(js));
});

test('sign in, create an album, upload a photo, see it, delete it, sign out', async (t) => {
  const a = await startApp({ COOKIE_SECURE: 'false' }); t.after(() => a.close());
  const dom = await openPage(a.base);
  t.after(() => dom.window.close());

  // sign-in form is shown first
  await until(() => $(dom, '#pw'), 'sign-in form');
  $(dom, '#pw').value = 'wrong wrong wrong';
  $(dom, 'form').dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await until(() => /not right/.test($(dom, '#loginerr').textContent), 'wrong-password message');
  $(dom, '#pw').value = 'correct horse battery staple';
  $(dom, 'form').dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await until(() => $(dom, '#newalbum'), 'album list');
  assert.match(text(dom), /No albums yet/);

  // create an album
  $(dom, '#newalbum').value = 'Holiday 2026';
  $(dom, 'form').dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await until(() => $(dom, '#files'), 'album page');
  assert.equal(dom.window.location.hash, '#/album/Holiday%202026');
  assert.match($(dom, 'h1').textContent, /Holiday 2026/);
  assert.equal($$(dom, 'p').find((p) => p.textContent === 'Nothing here yet.').hidden, false);

  // upload one real photo through the real file input
  const img = await jpeg(3200, 2400);
  const file = new dom.window.File([img], 'IMG_0042.JPG', { type: 'image/jpeg' });
  Object.defineProperty($(dom, '#files'), 'files', { value: [file], configurable: true });
  $(dom, '#files').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await until(() => $$(dom, '.tile img').length === 1, 'thumbnail tile', 15000);
  assert.ok(await fs.stat(path.join(a.photos, 'Holiday 2026', 'IMG_0042.jpg')));
  assert.match(text(dom), /uploaded/);
  assert.equal($$(dom, 'p').find((p) => p.textContent === 'Nothing here yet.').hidden, true, 'empty-state message goes away');
  assert.match(text(dom), /\d+ KB \u2192 \d+ KB/, 'small files are shown in KB, not 0.0 MB');
  assert.match($(dom, '.tile img').getAttribute('src'), /^\/thumb\/Holiday%202026\/IMG_0042\.jpg/);

  // a file that is not an image shows the server's reason, and the queue carries on
  const bad = new dom.window.File(['hello'], 'notes.jpg', { type: 'image/jpeg' });
  Object.defineProperty($(dom, '#files'), 'files', { value: [bad], configurable: true });
  $(dom, '#files').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  await until(() => /not an image this server can read/.test(text(dom)), 'rejection message', 15000);
  assert.equal($$(dom, '.tile img').length, 1);

  // delete the photo
  $(dom, '.tile .del').click();
  await until(() => $$(dom, '.tile').length === 0, 'tile removed');
  assert.deepEqual(await fs.readdir(path.join(a.photos, 'Holiday 2026')), []);

  // delete the album and land back on the list
  [...$$(dom, 'button')].find((b) => b.textContent === 'Delete album').click();
  await until(() => $(dom, '#newalbum') && /No albums yet/.test(text(dom)), 'back at the list');

  // sign out
  [...$$(dom, 'button')].find((b) => b.textContent === 'Sign out').click();
  await until(() => $(dom, '#pw'), 'sign-in form again');
});

test('folder names containing markup are shown as text, never interpreted', async (t) => {
  const a = await startApp({ COOKIE_SECURE: 'false' }); t.after(() => a.close());
  const evil = '<img src=x onerror=alert(1)>';
  await fs.mkdir(path.join(a.photos, evil));
  await fs.mkdir(path.join(a.photos, 'Fine'));
  const dom = await openPage(a.base);
  t.after(() => dom.window.close());
  await until(() => $(dom, '#pw'), 'sign-in form');
  $(dom, '#pw').value = 'correct horse battery staple';
  $(dom, 'form').dispatchEvent(new dom.window.Event('submit', { cancelable: true, bubbles: true }));
  await until(() => $(dom, '#newalbum'), 'album list');
  assert.equal($$(dom, 'a.album .name').length, 1, 'only the valid folder is an album');
  assert.ok(text(dom).includes(evil), 'the odd folder is reported as plain text');
  assert.equal($$(dom, 'img').length, 0);
  assert.equal($$(dom, '[onerror]').length, 0);
});
