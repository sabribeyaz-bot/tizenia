// Tizenia phone page: opened by scanning the QR code on the TV.
// Type or speak a question -> it is encrypted and sent to the TV -> the TV asks
// Gemini and shows the answer -> the answer comes back here (and can be read aloud).
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('tzn.' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('tzn.' + k, JSON.stringify(v)); } catch (e) { /* ignore */ } },
  };

  // ---------- pairing ----------
  var fromUrl = Relay.parsePairUrl(location.href);
  if (fromUrl) store.set('pair', fromUrl);
  var pair = fromUrl || store.get('pair', null);
  if (!pair) { $('bad').classList.remove('hide'); setStatus('', 'Eşleşmedi'); return; }
  var key = Relay.keyBytes(pair.keyStr);
  var LOGKEY = 'log.' + pair.topic;
  $('dock').classList.remove('hide');

  var log = store.get(LOGKEY, []); // { id, role: 'user'|'ai'|'err', text, via, pending }
  var speakOn = store.get('speak', true);
  var timers = {};

  function setStatus(cls, text) {
    var s = $('st');
    s.className = 'st ' + cls;
    s.querySelector('span').textContent = text;
  }
  function newId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function plain(t) { return String(t || '').replace(/\*\*(.+?)\*\*/g, '$1').replace(/^\s*#+\s*/gm, '').replace(/^\s*[-*•]\s+/gm, '• ').replace(/\*/g, ''); }

  // ---------- chat log ----------
  function save() { store.set(LOGKEY, log.filter(function (m) { return !m.pending; }).slice(-60)); }
  function render() {
    var box = $('log');
    box.innerHTML = '';
    if (!log.length) {
      var e = document.createElement('div');
      e.className = 'empty';
      e.innerHTML = 'TV\'ye bir şey sorun.<br>Aşağıya yazın ya da <b>🎤 Dokun ve konuş</b> düğmesine basın.';
      box.appendChild(e);
      return;
    }
    log.slice(-40).forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'msg ' + (m.role === 'user' ? 'user' : m.role === 'err' ? 'ai err' : 'ai');
      var b = document.createElement('div');
      b.className = 'bubble';
      if (m.role === 'user' && m.via === 'tv') { var w = document.createElement('div'); w.className = 'who'; w.textContent = 'TV\'den'; b.appendChild(w); }
      if (m.pending) {
        var d = document.createElement('div'); d.className = 'typing'; d.innerHTML = '<span></span><span></span><span></span>'; b.appendChild(d);
      } else {
        b.appendChild(document.createTextNode(m.role === 'user' ? m.text : plain(m.text)));
        if (m.role === 'ai' && window.speechSynthesis) {
          var sp = document.createElement('button');
          sp.className = 'speak'; sp.type = 'button'; sp.textContent = '🔊 Sesli oku';
          sp.onclick = function () { speak(m.text); };
          b.appendChild(document.createElement('br')); b.appendChild(sp);
        }
      }
      row.appendChild(b);
      box.appendChild(row);
    });
    window.scrollTo(0, document.body.scrollHeight);
  }
  function find(id) { for (var i = log.length - 1; i >= 0; i--) if (log[i].id === id) return log[i]; return null; }

  function fail(id, text) {
    var a = find(id + 'a');
    if (a && a.pending) { a.pending = false; a.role = 'err'; a.text = text; save(); render(); }
  }

  // ---------- sending ----------
  function ask(text) {
    text = String(text || '').trim();
    if (!text) return;
    var id = newId();
    log.push({ id: id, role: 'user', text: text });
    log.push({ id: id + 'a', role: 'ai', text: '', pending: true });
    render();
    Relay.post(pair.topic, key, { kind: 'ask', id: id, text: text }).then(function () {
      timers[id] = setTimeout(function () { fail(id, 'TV cevap vermedi. Tizenia TV\'de açık mı?'); }, 20000);
    }).catch(function () { fail(id, 'Gönderilemedi. İnternet bağlantınızı kontrol edin.'); });
  }

  $('send').onclick = function () { var v = $('q').value; $('q').value = ''; autosize(); ask(v); };
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('send').onclick(); } });
  function autosize() { var t = $('q'); t.style.height = 'auto'; t.style.height = Math.min(140, t.scrollHeight) + 'px'; }
  $('q').addEventListener('input', autosize);

  $('optClear').onclick = function () {
    Relay.post(pair.topic, key, { kind: 'clear' });
    log = []; save(); render();
  };
  function paintSpeak() { $('optSpeak').classList.toggle('on', speakOn); $('optSpeak').textContent = speakOn ? '🔊 Sesli okuma açık' : '🔈 Sesli okuma kapalı'; }
  $('optSpeak').onclick = function () { speakOn = !speakOn; store.set('speak', speakOn); paintSpeak(); if (!speakOn && window.speechSynthesis) speechSynthesis.cancel(); };
  paintSpeak();

  // ---------- Gemini key ----------
  $('gear').onclick = function () { $('settings').classList.toggle('hide'); };
  $('sendKey').onclick = function () {
    var k = $('apiKey').value.trim();
    var note = $('keyNote');
    // Google keys look like "AIza…" or the newer "AQ.…" form (letters, digits, - _ .)
    if (!/^[A-Za-z0-9._-]{20,}$/.test(k)) { note.className = 'note err'; note.textContent = 'Bu bir Gemini anahtarına benzemiyor. Kopyaladığınız anahtarın tamamını yapıştırın.'; return; }
    note.className = 'note ok'; note.textContent = '⏳ TV anahtarı deniyor…';
    var id = newId();
    Relay.post(pair.topic, key, { kind: 'key', id: id, key: k }).then(function () {
      timers[id] = setTimeout(function () { note.className = 'note err'; note.textContent = 'TV cevap vermedi. Tizenia TV\'de açık mı?'; }, 20000);
    }).catch(function () { note.className = 'note err'; note.textContent = 'Gönderilemedi. İnternet bağlantınızı kontrol edin.'; });
  };

  // ---------- messages from the TV ----------
  var joiner = new Relay.Joiner();
  var gotHi = false;
  Relay.listen(pair.topic + 'r', key, function (d0) {
    var d = joiner.add(d0);
    if (!d) return;
    if (d.id && timers[d.id]) { clearTimeout(timers[d.id]); delete timers[d.id]; }
    if (d.kind === 'hi') {
      gotHi = true;
      setStatus('ok', d.model ? 'TV bağlı · Gemini ' + d.model : 'TV bağlı');
      if (!d.hasKey) $('settings').classList.remove('hide');
    } else if (d.kind === 'status') {
      setStatus('ok', 'TV düşünüyor…');
      timers[d.id] = setTimeout(function () { fail(d.id, 'Cevap çok uzun sürdü.'); }, 90000);
    } else if (d.kind === 'q') { // asked on the TV itself
      log.push({ id: d.id, role: 'user', text: d.text, via: 'tv' });
      log.push({ id: d.id + 'a', role: 'ai', text: '', pending: true });
      render();
    } else if (d.kind === 'answer') {
      var a = find(d.id + 'a');
      if (!a) { a = { id: d.id + 'a' }; log.push(a); }
      a.pending = false; a.role = d.error ? 'err' : 'ai'; a.text = d.text;
      setStatus('ok', 'TV bağlı');
      save(); render();
      if (!d.error && speakOn) speak(d.text);
    } else if (d.kind === 'keyok') {
      var note = $('keyNote');
      if (d.ok) {
        note.className = 'note ok'; note.textContent = '✓ Anahtar çalışıyor. Gemini ' + (d.model || '') + ' hazır.';
        $('apiKey').value = '';
        setStatus('ok', 'TV bağlı · Gemini ' + (d.model || ''));
        setTimeout(function () { $('settings').classList.add('hide'); }, 2500);
      } else { note.className = 'note err'; note.textContent = '✗ ' + (d.text || 'Anahtar çalışmadı.'); }
    } else if (d.kind === 'cleared') {
      log = []; save(); render();
    }
  }, {
    onState: function (s) { if (s === 'open') hello(); else if (s === 'error') setStatus('wait', 'Bağlantı yenileniyor…'); },
  });

  function hello() {
    Relay.post(pair.topic, key, { kind: 'hello' }).catch(function () { /* retry on next open */ });
    setTimeout(function () { if (!gotHi) setStatus('', 'TV yanıt vermiyor — Tizenia açık mı?'); }, 8000);
  }

  // ---------- reading answers aloud ----------
  function speak(text) {
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(plain(text).replace(/•/g, ''));
    u.lang = 'tr-TR';
    var v = speechSynthesis.getVoices().filter(function (x) { return /^tr/i.test(x.lang); })[0];
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  }
  if (window.speechSynthesis) speechSynthesis.getVoices(); // loads the voice list early

  // ---------- speaking a question ----------
  var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  var mic = $('mic'), interim = $('interim'), rec = null, listening = false;
  if (!Rec) {
    mic.textContent = '🎤 Sesli soru için klavyedeki mikrofon tuşunu kullanın';
    mic.onclick = function () { $('q').focus(); };
  } else {
    mic.onclick = function () {
      if (listening) { rec.stop(); return; }
      if (window.speechSynthesis) speechSynthesis.cancel();
      rec = new Rec();
      rec.lang = 'tr-TR';
      rec.interimResults = true;
      rec.continuous = false;
      var finalText = '';
      rec.onstart = function () { listening = true; mic.classList.add('on'); mic.textContent = '● Dinliyorum… (bitirmek için dokun)'; interim.textContent = ''; };
      rec.onresult = function (e) {
        var live = '';
        for (var i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) finalText += e.results[i][0].transcript;
          else live += e.results[i][0].transcript;
        }
        interim.textContent = finalText + live;
      };
      rec.onerror = function (e) {
        interim.textContent = e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'Mikrofon izni verilmedi. Tarayıcı ayarlarından bu siteye mikrofon izni verin.'
          : e.error === 'no-speech' ? 'Ses duyulmadı, tekrar deneyin.' : 'Ses tanınamadı (' + e.error + ').';
      };
      rec.onend = function () {
        listening = false; mic.classList.remove('on'); mic.textContent = '🎤 Dokun ve konuş';
        var t = finalText.trim() || interim.textContent.trim();
        if (finalText.trim()) { interim.textContent = ''; ask(t); }
      };
      try { rec.start(); } catch (e) { interim.textContent = 'Mikrofon başlatılamadı.'; }
    };
  }

  render();
})();
