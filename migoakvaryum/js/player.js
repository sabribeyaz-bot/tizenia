/*
 * MIGOAKVARYUM — oynatıcı (player.html içinde çalışır)
 * Ana uygulamadan kamera listesini alır ve her ROTATE_MS'de bir sıradaki
 * kameraya geçer (dünya turu). Her kamerada:
 *   - yayın gerçekten CANLI mı (kayıt/tekrar değil) diye bakar,
 *   - REQUIRE_4K açıksa kaynakta 4K var mı diye bakar,
 *   - hata verir / başlamaz / donarsa beklemeden sıradakine geçer.
 * Bir tam turda hiç 4K canlı yayın bulunamazsa 4K şartını gevşetir.
 * Eski Tizen TV tarayıcıları için ES5 ile yazıldı.
 */
(function () {
    'use strict';

    var settings = null;      // ana uygulamadan gelir
    var attempts = [];        // [{cam, camIndex, src}]
    var current = -1;
    var player = null;
    var ytReady = false;
    var attemptToken = 0;
    var timers = { start: null, stall: null, watchdog: null, rotate: null, retry: null };
    var lastTime = -1, lastTimeChange = 0;

    // Tur takibi: bu turda kaç kamera başarıyla gösterildi / denendi
    var triedInRound = 0;
    var shownInRound = 0;
    var relax4K = false;      // tam tur 4K bulamazsa true olur
    var badCams = {};         // camIndex -> son başarısızlık zamanı

    var ST = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 };
    var BAD_CAM_MS = 30 * 60 * 1000;   // başarısız kamerayı 30 dk atla

    function post(msg) {
        msg.src = 'migo-player';
        try { window.parent.postMessage(msg, '*'); } catch (e) { /* yok say */ }
    }

    function clear(name) {
        if (timers[name]) {
            clearTimeout(timers[name]);
            clearInterval(timers[name]);
            timers[name] = null;
        }
    }

    function clearAll() {
        for (var k in timers) { if (timers.hasOwnProperty(k)) { clear(k); } }
    }

    function buildAttempts(cams) {
        var list = [];
        var common = 'autoplay=1&mute=1&controls=0&disablekb=1&fs=0&modestbranding=1' +
                     '&rel=0&iv_load_policy=3&playsinline=1&enablejsapi=1&vq=hd2160';
        if (location.protocol.indexOf('http') === 0) {
            common += '&origin=' + encodeURIComponent(location.protocol + '//' + location.host);
        }
        for (var i = 0; i < cams.length; i++) {
            var c = cams[i];
            var src = null;
            if (c.videoId) {
                src = 'https://www.youtube.com/embed/' + c.videoId + '?' + common;
            } else if (c.channelId) {
                src = 'https://www.youtube.com/embed/live_stream?channel=' + c.channelId + '&' + common;
            }
            if (src) { list.push({ cam: c, camIndex: i, src: src }); }
        }
        return list;
    }

    function destroyPlayer() {
        attemptToken++;
        if (player && player.destroy) {
            try { player.destroy(); } catch (e) { /* yok say */ }
        }
        player = null;
        var box = document.getElementById('yt');
        while (box.firstChild) { box.removeChild(box.firstChild); }
    }

    function isBad(a) {
        var t = badCams[a.camIndex];
        return t && (Date.now() - t < BAD_CAM_MS);
    }

    // Kamera başarısız: işaretle ve hemen sıradakine geç
    function fail(reason) {
        var a = attempts[current];
        if (a) { badCams[a.camIndex] = Date.now(); }
        advance(reason);
    }

    // Sıradaki kameraya geç (dünya turu)
    function advance(reason) {
        if (!attempts.length) { return; }

        // Bir tur tamamlandı mı?
        if (triedInRound >= attempts.length) {
            if (shownInRound === 0) {
                if (settings.REQUIRE_4K && !relax4K) {
                    // Hiç 4K canlı bulunamadı: şartı gevşet, kara listeyi temizle, hemen yeniden dene
                    relax4K = true;
                    badCams = {};
                } else {
                    destroyPlayer();
                    clearAll();
                    triedInRound = 0;
                    post({ type: 'allFailed', reason: reason });
                    timers.retry = setTimeout(function () { badCams = {}; advance('yeniden deneme'); },
                        60 * 1000);
                    return;
                }
            } else if (relax4K && settings.REQUIRE_4K) {
                relax4K = false;   // her yeni turda 4K'yı tekrar dene
            }
            triedInRound = 0;
            shownInRound = 0;
        }

        // Kara listede olmayan sıradaki kamerayı bul
        var n = current;
        for (var k = 0; k < attempts.length; k++) {
            n = (n + 1) % attempts.length;
            triedInRound++;
            if (!isBad(attempts[n])) {
                tryAttempt(n, reason);
                return;
            }
            if (triedInRound >= attempts.length) { break; }
        }
        // Hepsi kara listede
        current = n;
        advance(reason);
    }

    function tryAttempt(i, reason) {
        clearAll();
        destroyPlayer();
        current = i;
        var a = attempts[i];
        post({ type: 'loading', name: a.cam.name, place: a.cam.place, reason: reason || '' });

        var iframe = document.createElement('iframe');
        iframe.setAttribute('allow', 'autoplay; encrypted-media');
        iframe.setAttribute('frameborder', '0');
        iframe.id = 'ytframe';
        iframe.src = a.src;
        document.getElementById('yt').appendChild(iframe);

        // Eski (kapatılmış) oynatıcılardan gelen geç olayları yok say
        var token = ++attemptToken;
        function live(fn) {
            return function (e) { if (token === attemptToken) { fn(e); } };
        }
        player = new YT.Player('ytframe', {
            events: {
                onReady: live(onReady),
                onStateChange: live(onStateChange),
                onError: live(function (e) { fail('hata ' + e.data); })
            }
        });

        timers.start = setTimeout(function () { fail('başlamadı'); }, settings.START_TIMEOUT_MS);
    }

    function onReady() {
        try {
            if (settings.SOUND) { player.unMute(); player.setVolume(40); } else { player.mute(); }
            if (player.setPlaybackQuality) { player.setPlaybackQuality('hd2160'); }
            player.playVideo();
        } catch (e) { /* yok say */ }
    }

    function has4K() {
        var levels = [];
        try { levels = player.getAvailableQualityLevels() || []; } catch (e) { return null; }
        if (!levels.length) { return null; }   // bilinmiyor
        for (var i = 0; i < levels.length; i++) {
            if (levels[i] === 'hd2160' || levels[i] === 'highres') { return true; }
        }
        return false;
    }

    function isLiveNow() {
        try {
            var d = player.getVideoData();
            if (d && typeof d.isLive === 'boolean') { return d.isLive; }
        } catch (e) { /* yok say */ }
        return true;   // bilgi yoksa kabul et
    }

    function onStateChange(e) {
        if (e.data === ST.PLAYING) {
            clear('start');
            clear('stall');

            if (!timers.rotate) {
                // Bu kamerada ilk kez oynamaya başladı: kontrolleri yap
                if (!isLiveNow()) { fail('canlı değil'); return; }
                if (settings.REQUIRE_4K && !relax4K && has4K() === false) { fail('4K değil'); return; }

                shownInRound++;
                timers.rotate = setTimeout(function () { advance('sıradaki yer'); }, settings.ROTATE_MS);
                startWatchdog();
            }

            var a = attempts[current];
            var q = '';
            try { q = player.getPlaybackQuality(); } catch (err) { /* yok say */ }
            post({ type: 'playing', name: a.cam.name, place: a.cam.place, quality: q });
        } else if (e.data === ST.BUFFERING) {
            if (!timers.stall) {
                timers.stall = setTimeout(function () { fail('donma'); }, settings.STALL_TIMEOUT_MS);
            }
        } else if (e.data === ST.ENDED) {
            fail('yayın bitti');
        } else if (e.data === ST.PAUSED) {
            try { player.playVideo(); } catch (err) { /* yok say */ }
        }
    }

    // Oynuyor görünüp görüntü donmuşsa yakala
    function startWatchdog() {
        clear('watchdog');
        lastTime = -1;
        lastTimeChange = Date.now();
        timers.watchdog = setInterval(function () {
            var t = -1;
            try { t = player.getCurrentTime(); } catch (e) { /* yok say */ }
            if (t !== lastTime) {
                lastTime = t;
                lastTimeChange = Date.now();
            } else if (Date.now() - lastTimeChange > settings.STALL_TIMEOUT_MS) {
                fail('görüntü dondu');
            }
            try { post({ type: 'quality', quality: player.getPlaybackQuality() }); } catch (e2) { /* yok say */ }
        }, 5 * 1000);
    }

    function start() {
        if (ytReady && settings && current === -1 && attempts.length) {
            triedInRound = 0;
            shownInRound = 0;
            // Her açılışta farklı bir yerden başla
            current = Math.floor(Math.random() * attempts.length) - 1;
            advance('');
        }
    }

    // YouTube IFrame API hazır olunca çağrılır
    window.onYouTubeIframeAPIReady = function () {
        ytReady = true;
        start();
    };

    window.addEventListener('message', function (ev) {
        var d = ev.data;
        if (!d || d.src !== 'migo-app') { return; }
        if (d.type === 'start') {
            settings = d.settings;
            if (!settings.ROTATE_MS) { settings.ROTATE_MS = 60 * 1000; }
            attempts = buildAttempts(d.settings.CAMERAS || []);
            current = -1;
            start();
        } else if (d.type === 'stop') {
            attemptToken++;
            clearAll();
            destroyPlayer();
        }
    }, false);

    post({ type: 'hello' });
})();
