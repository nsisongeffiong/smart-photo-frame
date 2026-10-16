(function () {
  'use strict';

  var root = document.getElementById('app');
  var toastEl = document.getElementById('toast');
  var session = null;      // { limits, haEnabled }
  var toastTimer = null;
  var busy = false;        // an upload queue is running
  var pending = [];        // jobs waiting to be sent; each job knows its own album
  var onQueueIdle = null;  // set by the album page currently on screen

  // ---------- helpers ----------

  function h(tag, attrs) {
    var el = document.createElement(tag);
    var key;
    for (key in (attrs || {})) {
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
      var val = attrs[key];
      if (val === null || val === undefined || val === false) continue;
      if (key === 'class') el.className = val;
      else if (key.indexOf('on') === 0) el.addEventListener(key.slice(2), val);
      else if (val === true) el.setAttribute(key, '');
      else el.setAttribute(key, val);
    }
    for (var i = 2; i < arguments.length; i += 1) append(el, arguments[i]);
    return el;
  }
  function append(el, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (c) { append(el, c); }); return; }
    el.appendChild(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  function mount() {
    while (root.firstChild) root.removeChild(root.firstChild);
    for (var i = 0; i < arguments.length; i += 1) append(root, arguments[i]);
  }
  function toast(msg, ms) {
    toastEl.textContent = msg;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.hidden = true; }, ms || 5000);
  }
  function mb(bytes) {
    return bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB';
  }
  function enc(s) { return encodeURIComponent(s); }

  function api(method, url, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (res.status === 401 && url !== '/api/login') { session = null; showLogin(); throw new Error('Please sign in again.'); }
        if (!res.ok) { var e = new Error(data.message || ('Request failed (' + res.status + ')')); e.data = data; throw e; }
        return data;
      });
    });
  }

  // ---------- login ----------

  function showLogin(message) {
    var pw = h('input', { type: 'password', id: 'pw', autocomplete: 'current-password', required: true, 'aria-describedby': 'loginerr' });
    var err = h('p', { class: 'error', id: 'loginerr' }, message || '');
    var btn = h('button', { class: 'primary', type: 'submit' }, 'Sign in');
    var form = h('form', { class: 'stack', onsubmit: function (ev) {
      ev.preventDefault();
      btn.disabled = true; err.textContent = '';
      api('POST', '/api/login', { password: pw.value }).then(function () { return boot(); })
        .catch(function (e) { err.textContent = e.message; btn.disabled = false; pw.select(); });
    } },
      h('div', null, h('label', { for: 'pw' }, 'Password'), pw), err, btn);
    mount(h('header', { class: 'top' }, h('h1', null, 'Frame uploads')), h('div', { class: 'card' }, form));
    pw.focus();
  }

  // ---------- album list ----------

  function showAlbums() {
    mount(h('p', { class: 'muted' }, 'Loading albums…'));
    api('GET', '/api/albums').then(function (data) {
      var input = h('input', { type: 'text', id: 'newalbum', placeholder: 'e.g. Holidays', maxlength: '64', autocomplete: 'off', autocapitalize: 'words', 'aria-label': 'New album name' });
      var addBtn = h('button', { class: 'primary', type: 'submit' }, 'Create');
      var form = h('form', { class: 'inline', onsubmit: function (ev) {
        ev.preventDefault();
        var name = input.value.trim();
        if (!name) return;
        addBtn.disabled = true;
        api('POST', '/api/albums', { name: name }).then(function (r) { location.hash = '#/album/' + enc(name); })
          .catch(function (e) { toast(e.message, 8000); addBtn.disabled = false; });
      } }, input, addBtn);

      var list = data.albums.length ? data.albums.map(function (a) {
        return h('a', { class: 'btn album card', href: '#/album/' + enc(a.name) },
          h('span', { class: 'grow name' }, a.name),
          h('span', { class: 'badge' }, a.count + (a.count === 1 ? ' photo' : ' photos')));
      }) : h('p', { class: 'muted' }, 'No albums yet. Create one below, then add photos to it.');

      mount(
        h('header', { class: 'top' }, h('h1', null, 'Frame uploads'),
          h('button', { class: 'link', onclick: function () { api('POST', '/api/logout').then(function () { session = null; showLogin(); }); } }, 'Sign out')),
        data.skipped.length ? h('div', { class: 'banner warn' }, 'These folders are hidden from the frame because their names use characters it does not allow: ' + data.skipped.join(', ')) : null,
        h('h2', null, 'Albums'), list,
        h('h2', null, 'New album'), h('div', { class: 'card' }, form,
          h('p', { class: 'muted' }, 'Letters, numbers, spaces, dots, dashes and underscores. Add the same name to the album dropdown in Home Assistant so you can select it.'))
      );
    }).catch(function (e) { if (session) mount(h('div', { class: 'banner warn' }, e.message), h('button', { onclick: showAlbums }, 'Try again')); });
  }

  // ---------- upload queue ----------

  function enqueue(album, listEl, files) {
    if (!files.length) return;
    var jobs = files.map(function (f) {
      var status = h('div', { class: 'status' }, 'Waiting');
      var bar = h('progress', { max: '100', value: '0' });
      listEl.appendChild(h('li', null, h('div', { class: 'fname' }, f.name), status, bar));
      return { album: album, file: f, status: status, bar: bar };
    });
    if (busy) toast('Added to the queue.');
    pending = pending.concat(jobs);
    if (busy) return;
    busy = true;
    var done = 0, failed = 0;
    (function next() {
      var job = pending.shift();
      if (!job) {
        busy = false;
        toast(failed ? (done + ' uploaded, ' + failed + ' failed.') : (done + (done === 1 ? ' photo' : ' photos') + ' uploaded.'));
        if (onQueueIdle) onQueueIdle();
        return;
      }
      sendOne(job).then(function () { done += 1; }, function () { failed += 1; }).then(next);
    })();
  }

  function sendOne(job) {
    var limits = session ? session.limits : { maxUploadMb: 40 };
    return new Promise(function (resolve, reject) {
      function fail(msg) {
        job.status.textContent = msg; job.status.className = 'status fail'; job.bar.hidden = true;
        reject(new Error(msg));
      }
      if (job.file.size > limits.maxUploadMb * 1048576) return fail('Too large (' + mb(job.file.size) + '; limit ' + limits.maxUploadMb + ' MB)');
      var fd = new FormData();
      fd.append('file', job.file, job.file.name);
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/albums/' + enc(job.album) + '/photos');
      xhr.upload.onprogress = function (ev) {
        if (!ev.lengthComputable) return;
        job.bar.value = Math.round(ev.loaded / ev.total * 100);
        job.status.textContent = job.bar.value < 100 ? 'Uploading ' + job.bar.value + '%' : 'Processing\u2026';
      };
      xhr.onerror = function () { fail('Network error. Check your connection and try this one again.'); };
      xhr.ontimeout = xhr.onerror;
      xhr.timeout = 5 * 60 * 1000;
      xhr.onload = function () {
        var data = {};
        try { data = JSON.parse(xhr.responseText); } catch (e) { /* not JSON */ }
        if (xhr.status === 401) {
          // Signed out mid-queue: stop, rather than failing every remaining photo.
          pending = []; session = null; showLogin('Your session ended. Sign in and try again.');
          return fail('Signed out');
        }
        if (xhr.status >= 200 && xhr.status < 300) {
          job.bar.value = 100; job.bar.hidden = true;
          job.status.className = 'status done';
          job.status.textContent = '\u2713 ' + mb(data.bytesIn) + ' \u2192 ' + mb(data.bytesOut) + ' (' + data.width + '\u00d7' + data.height + ')'
            + (data.onFrame === false ? ' \u2014 past the frame limit' : '');
          return resolve();
        }
        fail(data.message || ('Upload failed (' + xhr.status + ')'));
      };
      job.status.textContent = 'Uploading 0%';
      xhr.send(fd);
    });
  }

  // ---------- one album ----------

  function showAlbum(name) {
    mount(h('p', { class: 'muted' }, 'Loading…'));
    api('GET', '/api/albums/' + enc(name) + '/photos').then(function (data) { renderAlbum(name, data); })
      .catch(function (e) { if (session) { toast(e.message, 6000); location.hash = '#/'; } });
  }

  function renderAlbum(name, data) {
    var limits = session.limits;
    var photos = data.photos;
    var grid = h('div', { class: 'grid' });
    var queueEl = h('ul', { class: 'queue' });
    var countEl = h('p', { class: 'muted' });
    var emptyEl = h('p', { class: 'muted' }, 'Nothing here yet.');

    function updateCount() {
      var t = photos.length + (photos.length === 1 ? ' photo' : ' photos');
      if (limits.frameMaxPhotos) t += ' · the frame shows up to ' + limits.frameMaxPhotos;
      countEl.textContent = t;
    }

    function tile(p) {
      var del = h('button', { class: 'del', 'aria-label': 'Delete ' + p.name, onclick: function () {
        if (!window.confirm('Delete ' + p.name + '? This cannot be undone.')) return;
        api('DELETE', '/api/albums/' + enc(name) + '/photos/' + enc(p.name)).then(function () {
          photos = photos.filter(function (x) { return x.name !== p.name; });
          drawGrid(); updateCount();
        }).catch(function (e) { toast(e.message); });
      } }, '×');
      return h('div', { class: 'tile' },
        h('a', { href: '/photo/' + enc(name) + '/' + enc(p.name), target: '_blank', rel: 'noopener' },
          h('img', { src: '/thumb/' + enc(name) + '/' + enc(p.name) + '?v=' + Math.round(p.mtimeMs), alt: p.name, loading: 'lazy' })),
        del, p.onFrame ? null : h('div', { class: 'off' }, 'Past the frame limit'));
    }
    function drawGrid() {
      while (grid.firstChild) grid.removeChild(grid.firstChild);
      photos.forEach(function (p) { grid.appendChild(tile(p)); });
      emptyEl.hidden = photos.length > 0;
    }

    // --- upload queue (the queue itself lives at module level) ---
    var fileInput = h('input', { type: 'file', id: 'files', accept: 'image/*', multiple: true });
    fileInput.addEventListener('change', function () { enqueue(name, queueEl, Array.prototype.slice.call(fileInput.files)); fileInput.value = ''; });

    onQueueIdle = function () {
      api('GET', '/api/albums/' + enc(name) + '/photos').then(function (d) { photos = d.photos; drawGrid(); updateCount(); }).catch(function () {});
    };

    var zone = h('div', { class: 'dropzone', id: 'zone' },
      h('label', { class: 'btn primary', for: 'files' }, 'Choose photos'), fileInput,
      h('p', { class: 'muted' }, 'Photos are resized to fit ' + limits.maxEdge + ' px and stripped of location data automatically.'));
    ['dragenter', 'dragover'].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.add('over'); }); });
    ['dragleave', 'drop'].forEach(function (t) { zone.addEventListener(t, function (e) { e.preventDefault(); zone.classList.remove('over'); }); });
    zone.addEventListener('drop', function (e) { enqueue(name, queueEl, Array.prototype.slice.call(e.dataTransfer.files)); });

    var delAlbum = h('button', { class: 'danger', onclick: function () {
      var q = photos.length
        ? 'Delete the album "' + name + '" and its ' + photos.length + ' photos? This cannot be undone.'
        : 'Delete the empty album "' + name + '"?';
      if (!window.confirm(q)) return;
      api('DELETE', '/api/albums/' + enc(name) + (photos.length ? '?withPhotos=1' : '')).then(function () {
        location.hash = '#/';
      }).catch(function (e) { toast(e.message, 8000); });
    } }, 'Delete album');

    drawGrid(); updateCount();
    mount(
      h('header', { class: 'top' }, h('a', { class: 'btn', href: '#/' }, '‹ Albums'), delAlbum),
      h('h1', null, name), countEl, zone, queueEl,
      h('h2', null, 'Photos'),
      emptyEl,
      grid
    );
  }

  // ---------- routing ----------

  function route() {
    if (!session) return;
    var m = /^#\/album\/(.+)$/.exec(location.hash);
    if (m) {
      var name;
      try { name = decodeURIComponent(m[1]); } catch (e) { location.hash = '#/'; return; }
      showAlbum(name);
    } else {
      showAlbums();
    }
  }
  window.addEventListener('hashchange', route);
  window.addEventListener('beforeunload', function (e) {
    if (busy) { e.preventDefault(); e.returnValue = ''; }
  });

  function boot() {
    return fetch('/api/session', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (s) {
      if (!s.authenticated) { showLogin(); return; }
      session = s;
      route();
    }).catch(function () { mount(h('div', { class: 'banner warn' }, 'Can’t reach the server.'), h('button', { onclick: boot }, 'Try again')); });
  }

  boot();
})();
