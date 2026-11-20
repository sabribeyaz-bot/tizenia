/*
 * MIGOAKVARYUM — oynatıcı (player.html içinde çalışır)
 * Ana uygulamadan kamera listesini alır, YouTube canlı yayınını oynatır,
 * hata / donma olursa sıradaki kameraya geçer ve durumu üst pencereye bildirir.
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
    var timers = { start: null, stall: null, watchdog: null, primary: null, retry: null };
    var lastTime = -1, lastTimeChange = 0;

    var ST = { ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3 };

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
                     '&rel=0&iv_load_policy=3&playsinline=1&enablejsapi=1';
        if (location.protocol.indexOf('http') === 0) {
            common += '&origin=' + encodeURIComponent(location.protocol + '//' + location.host);
        }
        for (var i = 0; i < cams.length; i++) {
            var c = cams[i];
            if (c.videoId) {
                list.push({ cam: c, camIndex: i,
                    src: 'https://www.youtube.com/embed/' + c.videoId + '?' + common });
            }
            if (c.channelId) {
                list.push({ cam: c, camIndex: i,
                    src: 'https://www.youtube.com/embed/live_stream?channel=' + c.channelId + '&' + common });
            }
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

    function next(reason) {
        var n = current + 1;
        if (n >= attempts.length) {
            // Hepsi denendi: bir süre bekle ve baştan başla
            destroyPlayer();
            clearAll();
            current = -1;
            post({ type: 'allFailed', reason: reason });
            timers.retry = setTimeout(function () { tryAttempt(0); }, 60 * 1000);
            return;
        }
        tryAttempt(n, reason);
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
                onError: live(function (e) { next('hata ' + e.data); })
            }
        });

        timers.start = setTimeout(function () { next('başlamadı'); }, settings.START_TIMEOUT_MS);
    }

    function onReady() {
        try {
            if (settings.SOUND) { player.unMute(); player.setVolume(40); } else { player.mute(); }
            player.setPlaybackQuality && player.setPlaybackQuality('highres');
            player.playVideo();
        } catch (e) { /* yok say */ }
    }

    function onStateChange(e) {
        if (e.data === ST.PLAYING) {
            clear('start');
            clear('stall');
            startWatchdog();
            schedulePrimaryRetry();
            var a = attempts[current];
            var q = '';
            try { q = player.getPlaybackQuality(); } catch (err) { /* yok say */ }
            post({ type: 'playing', name: a.cam.name, place: a.cam.place, quality: q });
        } else if (e.data === ST.BUFFERING) {
            if (!timers.stall) {
                timers.stall = setTimeout(function () { next('donma'); }, settings.STALL_TIMEOUT_MS);
            }
        } else if (e.data === ST.ENDED) {
            next('yayın bitti');
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
                next('görüntü dondu');
            }
            // Kaliteyi düzenli bildir (etiket için)
            try { post({ type: 'quality', quality: player.getPlaybackQuality() }); } catch (e2) { /* yok say */ }
        }, 10 * 1000);
    }

    // Yedek kameradaysak bir süre sonra ana kamerayı yeniden dene
    function schedulePrimaryRetry() {
        clear('primary');
        if (attempts[current] && attempts[current].camIndex > 0) {
            timers.primary = setTimeout(function () { tryAttempt(0, 'ana kameraya dönüş'); },
                settings.PRIMARY_RETRY_MS);
        }
    }

    function maybeStart() {
        if (ytReady && settings && current === -1 && attempts.length) {
            tryAttempt(0);
        }
    }

    // YouTube IFrame API hazır olunca çağrılır
    window.onYouTubeIframeAPIReady = function () {
        ytReady = true;
        maybeStart();
    };

    window.addEventListener('message', function (ev) {
        var d = ev.data;
        if (!d || d.src !== 'migo-app') { return; }
        if (d.type === 'start') {
            settings = d.settings;
            attempts = buildAttempts(d.settings.CAMERAS || []);
            current = -1;
            maybeStart();
        } else if (d.type === 'stop') {
            attemptToken++;
            clearAll();
            destroyPlayer();
        }
    }, false);

    post({ type: 'hello' });
})();
