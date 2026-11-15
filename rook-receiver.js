/* ROOK's Cast receiver (5 Nov 2026). The public half of a ROOK display on a
 * Chromecast: it holds nothing private. The hub launches this app on the TV
 * and says hello (which display, and a key for it); this page then asks the
 * hub, over the Cast connection, for the display's own page and scripts and
 * runs them. Every request that page makes (fetch, or a photo) goes the same
 * way, so the TV needs no address it can reach: only the Cast link the hub
 * opened. See rook-hub/cast_display.py for the hub's half. */
(function (global) {
  'use strict';
  var NS = 'urn:x-cast:com.rook.display';
  var ASK_TIMEOUT_MS = 30000;

  // ---- pieces of one answer back into bytes (tested in node) ----------
  function Assembler() { this.waiting = {}; this.next = 1; }
  Assembler.prototype.open = function (resolve, reject, timeoutMs, setTimer, clearTimer) {
    var id = this.next++;
    var self = this;
    var row = { resolve: resolve, reject: reject, parts: [], got: 0, status: 0, headers: {} };
    row.timer = setTimer(function () { delete self.waiting[id]; reject(new Error('SoLLM did not answer')); }, timeoutMs);
    row.clear = function () { clearTimer(row.timer); };
    this.waiting[id] = row;
    return id;
  };
  Assembler.prototype.drop = function (id, error) {
    var row = this.waiting[id];
    if (!row) return;
    row.clear(); delete this.waiting[id]; row.reject(error);
  };
  Assembler.prototype.take = function (msg, decode) {
    var row = this.waiting[msg.id];
    if (!row || typeof msg.part !== 'number' || typeof msg.parts !== 'number') return false;
    if (msg.part === 0) { row.status = msg.status; row.headers = msg.headers || {}; }
    if (row.parts[msg.part] === undefined) { row.parts[msg.part] = msg.data || ''; row.got += 1; }
    if (row.got < msg.parts) return true;
    row.clear(); delete this.waiting[msg.id];
    row.resolve({ status: row.status, headers: row.headers, bytes: decode(row.parts.join('')) });
    return true;
  };

  function b64bytes(text) {
    var bin = global.atob(text);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }

  function hubPath(url) {
    return typeof url === 'string' && url.charAt(0) === '/' && url.charAt(1) !== '/';
  }

  function plainHeaders(h) {
    var out = {};
    if (!h) return out;
    if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach(function (v, k) { out[k] = v; });
    else Object.keys(h).forEach(function (k) { out[k] = h[k]; });
    return out;
  }

  function hashFor(hello) {
    return '#surface=' + encodeURIComponent(hello.surface) + '&key=' + encodeURIComponent(hello.key)
      + '&flux=' + encodeURIComponent(hello.flux || 'lean');
  }

  var api = { NS: NS, Assembler: Assembler, b64bytes: b64bytes, hubPath: hubPath, plainHeaders: plainHeaders, hashFor: hashFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (!global.cast || !global.cast.framework) return;      // node tests stop here

  // ---- on the TV -------------------------------------------------------
  var ctx = global.cast.framework.CastReceiverContext.getInstance();
  var hub = null;
  var assembler = new Assembler();
  var started = null;      // the hello this page is running
  var status = global.document.getElementById('rook-loader-status');
  function say(text) { if (status) status.textContent = text; }

  function send(msg) {
    try { ctx.sendCustomMessage(NS, hub || undefined, msg); } catch (_) { /* the hub is away; a timeout says so */ }
  }

  function ask(method, path, headers, body, signal) {
    return new Promise(function (resolve, reject) {
      var id = assembler.open(resolve, reject, ASK_TIMEOUT_MS, global.setTimeout.bind(global), global.clearTimeout.bind(global));
      if (signal) {
        if (signal.aborted) { assembler.drop(id, new global.DOMException('Aborted', 'AbortError')); return; }
        signal.addEventListener('abort', function () { assembler.drop(id, new global.DOMException('Aborted', 'AbortError')); });
      }
      send({ type: 'fetch', id: id, method: method, path: path, headers: headers || {}, body: body || '' });
    });
  }

  // Requests for the hub's own paths travel over the Cast link.
  var realFetch = global.fetch.bind(global);
  global.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url);
    if (!hubPath(url)) return realFetch(input, init);
    init = init || {};
    return ask(String(init.method || 'GET').toUpperCase(), url, plainHeaders(init.headers),
      typeof init.body === 'string' ? init.body : '', init.signal).then(function (r) {
      var empty = r.status === 204 || r.status === 304;
      return new global.Response(empty ? null : r.bytes, { status: r.status, headers: r.headers });
    });
  };

  // Photos the page shows by the hub's path: fetched the same way, shown from memory.
  var srcProp = Object.getOwnPropertyDescriptor(global.HTMLImageElement.prototype, 'src');
  Object.defineProperty(global.HTMLImageElement.prototype, 'src', {
    configurable: true, enumerable: true,
    get: function () { return (this.dataset && this.dataset.rookSrc) || srcProp.get.call(this); },
    set: function (value) {
      var img = this;
      if (!hubPath(value)) { if (img.dataset) delete img.dataset.rookSrc; srcProp.set.call(img, value); return; }
      img.dataset.rookSrc = value;
      ask('GET', value, {}, '').then(function (r) {
        if (img.dataset.rookSrc !== value) return;
        if (r.status >= 400) { img.dispatchEvent(new global.Event('error')); return; }
        var old = img.dataset.rookBlob;
        img.dataset.rookBlob = global.URL.createObjectURL(new global.Blob([r.bytes], { type: r.headers['content-type'] || 'image/jpeg' }));
        srcProp.set.call(img, img.dataset.rookBlob);
        if (old) global.setTimeout(function () { global.URL.revokeObjectURL(old); }, 5000);
      }).catch(function () { img.dispatchEvent(new global.Event('error')); });
    },
  });

  function text(path) {
    return ask('GET', path, {}, '').then(function (r) {
      if (r.status >= 400) throw new Error(path + ' answered ' + r.status);
      return new global.TextDecoder().decode(r.bytes);
    });
  }

  function addScript(source) {
    return new Promise(function (resolve, reject) {
      var tag = global.document.createElement('script');
      tag.src = global.URL.createObjectURL(new global.Blob([source], { type: 'text/javascript' }));
      tag.onload = resolve; tag.onerror = reject;
      global.document.body.appendChild(tag);
    });
  }

  // Hello: load the display page from the hub and run it.
  function begin(hello) {
    if (started) {
      if (started.key !== hello.key || started.surface !== hello.surface) global.location.reload();
      return;
    }
    started = hello;
    say('Opening the display');
    global.history.replaceState(null, '', global.location.pathname + hashFor(hello));
    text(hello.page || '/tela-fenestra.html').then(function (html) {
      var doc = new global.DOMParser().parseFromString(html, 'text/html');
      var styles = Array.prototype.map.call(doc.querySelectorAll('link[rel="stylesheet"]'), function (l) { return l.getAttribute('href'); });
      var scripts = Array.prototype.map.call(doc.querySelectorAll('script[src]'), function (s) { return s.getAttribute('src'); });
      Array.prototype.forEach.call(doc.querySelectorAll('script'), function (s) { s.remove(); });
      global.document.getElementById('rook-page').innerHTML = doc.body.innerHTML;
      return Promise.all(styles.map(text)).then(function (css) {
        css.forEach(function (rules) {
          var style = global.document.createElement('style');
          style.textContent = rules;
          global.document.head.appendChild(style);
        });
        return scripts.reduce(function (chain, src) { return chain.then(function () { return text(src).then(addScript); }); }, Promise.resolve());
      });
    }).then(function () {
      global.document.getElementById('rook-loader').className = 'gone';
    }).catch(function (err) {
      started = null;
      say('Could not open the display: ' + ((err && err.message) || err));
    });
  }

  ctx.addCustomMessageListener(NS, function (event) {
    var msg = event.data || {};
    if (msg.type === 'hello') { hub = event.senderId; begin(msg); }
    else if (msg.type === 'reply') assembler.take(msg, b64bytes);
  });
  ctx.addEventListener(global.cast.framework.system.EventType.SENDER_CONNECTED, function () {
    send({ type: 'ready' });
  });

  var options = new global.cast.framework.CastReceiverOptions();
  options.disableIdleTimeout = true;      // a display stays up with no film playing
  options.skipPlayersLoad = true;
  options.customNamespaces = {};
  options.customNamespaces[NS] = global.cast.framework.system.MessageType.JSON;
  ctx.start(options);
  send({ type: 'ready' });
})(typeof window !== 'undefined' ? window : globalThis);
