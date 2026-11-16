// Tizenie relay: encrypted messages between the TV and the phone.
// Same idea as MIGO: the TV shows a QR code that holds a random topic name and
// a secret key (the key is in the URL #fragment and never goes to a server).
// Messages are encrypted with tweetnacl secretbox and passed through the free
// ntfy.sh service. Phone -> TV uses <topic>, TV -> phone uses <topic>r.
//
// This file is shared: app/js/relay.js and phone/relay.js must stay identical.
// Written for old Samsung TV browsers (Tizen 4.0 = Chromium 56): no modules,
// no object spread, no optional chaining.
(function (g) {
  'use strict';
  var nacl = g.nacl;
  var RELAY = 'https://ntfy.sh';
  // ntfy keeps messages up to 4096 bytes; long answers are sent in parts.
  var PART_CHARS = 900;

  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function unb64url(str) {
    str = String(str);
    var s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    var out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function utf8(str) { return new TextEncoder().encode(str); }
  function fromUtf8(bytes) { return new TextDecoder().decode(bytes); }

  function seal(obj, key) {
    var nonce = nacl.randomBytes(24);
    var box = nacl.secretbox(utf8(JSON.stringify(obj)), nonce, key);
    var all = new Uint8Array(24 + box.length);
    all.set(nonce); all.set(box, 24);
    return b64url(all);
  }
  function open(text, key) {
    try {
      var all = unb64url(text);
      var msg = nacl.secretbox.open(all.subarray(24), all.subarray(0, 24), key);
      return msg ? JSON.parse(fromUtf8(msg)) : null;
    } catch (e) { return null; }
  }

  function randomName(n) { return b64url(nacl.randomBytes(n)).replace(/[-_]/g, 'x'); }

  // A new pairing: { topic, keyStr }
  function newPairing() { return { topic: 'tzn-' + randomName(12), keyStr: b64url(nacl.randomBytes(32)) }; }

  // Read ?t=<topic>#k=<key> from the QR address.
  function parsePairUrl(text) {
    var t = /[?&]t=(tzn-[A-Za-z0-9]+)/.exec(text || '');
    var k = /#k=([A-Za-z0-9_-]+)/.exec(text || '');
    return t && k ? { topic: t[1], keyStr: k[1] } : null;
  }

  function post(topic, key, obj) {
    // text/plain body: a "simple" request, so no CORS preflight is needed.
    return fetch(RELAY + '/' + topic, { method: 'POST', body: seal(obj, key) }).then(function (r) {
      if (!r.ok) throw new Error('http ' + r.status);
      return true;
    });
  }

  // Send an object whose .text may be long: split into numbered parts.
  function postLong(topic, key, obj) {
    var text = String(obj.text || '');
    var parts = [];
    for (var i = 0; i < text.length || i === 0; i += PART_CHARS) parts.push(text.slice(i, i + PART_CHARS));
    var chain = Promise.resolve();
    parts.forEach(function (p, idx) {
      var one = {};
      for (var k in obj) one[k] = obj[k];
      one.text = p; one.part = idx; one.parts = parts.length;
      chain = chain.then(function () { return post(topic, key, one); });
    });
    return chain;
  }

  // Joins the parts made by postLong. Returns the full object when complete.
  function Joiner() { this.buf = {}; }
  Joiner.prototype.add = function (d) {
    if (!d.parts || d.parts <= 1) return d;
    var id = d.id || 'x';
    var b = this.buf[id] || (this.buf[id] = { got: 0, list: [] });
    if (b.list[d.part] == null) { b.list[d.part] = d.text; b.got++; }
    if (b.got < d.parts) return null;
    delete this.buf[id];
    var full = {};
    for (var k in d) full[k] = d[k];
    full.text = b.list.join('');
    delete full.part; delete full.parts;
    return full;
  };

  // Listen to a topic with Server-Sent Events (instant, one open connection).
  // onData(obj, rawMessage). Returns { stop() }.
  // opts: { since: message id or unix time, onState(state), onSince(id) }
  function listen(topic, key, onData, opts) {
    opts = opts || {};
    var since = opts.since || Math.floor(Date.now() / 1000) - 10;
    var seen = {};
    var es = null, timer = null, stopped = false, retry = 2000;
    var state = function (s) { if (opts.onState) opts.onState(s); };

    function connect() {
      if (stopped) return;
      state('connecting');
      try { es = new EventSource(RELAY + '/' + topic + '/sse?since=' + encodeURIComponent(since)); } catch (e) { return later(); }
      es.addEventListener('open', function () { retry = 2000; state('open'); });
      es.onmessage = function (e) {
        var m; try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.event !== 'message' || !m.message || seen[m.id]) return;
        seen[m.id] = 1;
        since = m.id;
        if (opts.onSince) opts.onSince(m.id);
        var d = open(m.message, key);
        if (d) onData(d, m);
      };
      // We reconnect ourselves so "since" always points at the last message.
      es.onerror = function () { if (es) es.close(); es = null; state('error'); later(); };
    }
    function later() {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(connect, retry);
      retry = Math.min(retry * 2, 30000);
    }
    connect();
    return { stop: function () { stopped = true; clearTimeout(timer); if (es) es.close(); es = null; } };
  }

  g.Relay = {
    newPairing: newPairing, parsePairUrl: parsePairUrl, keyBytes: unb64url,
    post: post, postLong: postLong, listen: listen, Joiner: Joiner, seal: seal, open: open,
  };
})(typeof window !== 'undefined' ? window : this);
