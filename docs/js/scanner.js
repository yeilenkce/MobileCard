/*
 * 시험패스 PoC: QR 읽기 (jsQR). 카메라, 이미지 파일, 캔버스 모두 이 기기 안에서만 처리한다.
 */
(function (g) {
  'use strict';
  var SP = g.SP, doc = g.document;
  var scanner = (SP.scanner = {});

  function scan(data, w, h, both) {
    var r = g.jsQR(data, w, h, { inversionAttempts: both ? 'attemptBoth' : 'dontInvert' });
    return r ? r.data : null;
  }

  // 이미지 한 장에서 QR 찾기. 크기를 바꿔 가며 몇 번 시도한다.
  scanner.decodeBlob = async function (blob) {
    var bmp = await g.createImageBitmap(blob);
    var cv = doc.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });
    var longest = Math.max(bmp.width, bmp.height), found = null;
    var sizes = [1000, 640, 1600, 400];
    for (var i = 0; i < sizes.length && !found; i++) {
      var s = Math.min(1, sizes[i] / longest);
      if (i > 0 && s === 1 && sizes[i] > longest) continue;
      var w = Math.max(1, Math.round(bmp.width * s)), h = Math.max(1, Math.round(bmp.height * s));
      cv.width = w; cv.height = h;
      cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h);
      cx.drawImage(bmp, 0, 0, w, h);
      found = scan(cx.getImageData(0, 0, w, h).data, w, h, true);
    }
    if (bmp.close) bmp.close();
    return found;
  };

  // 카메라. QR 을 찾으면 onFound(text) 를 한 번 부르고 스캔만 멈춘다(스트림은 켜 둔다).
  // resume() 으로 곧바로 이어서 스캔하고, 끌 때는 stop() 을 부른다.
  // start()/stop() 은 세대 번호로 직렬화해서, 시작 중에 stop() 이 불려도 서로 엉키지 않는다.
  scanner.camera = function (video, cb) {
    var stream = null, timer = 0, scanning = false, gen = 0;
    var cv = doc.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });

    function halt() { scanning = false; clearTimeout(timer); }
    function release() {
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
      video.srcObject = null;
    }

    function tick() {
      if (!scanning) return;
      if (video.readyState >= 2 && video.videoWidth) {
        var s = Math.min(1, 720 / video.videoWidth);
        var w = Math.round(video.videoWidth * s), h = Math.round(video.videoHeight * s);
        if (cv.width !== w) { cv.width = w; cv.height = h; }
        cx.drawImage(video, 0, 0, w, h);
        var text = scan(cx.getImageData(0, 0, w, h).data, w, h, false);
        if (text) { halt(); cb.onFound(text); return; }
      }
      timer = setTimeout(tick, 70);
    }

    var api = {
      alive: function () { return !!stream; },
      scanning: function () { return scanning; },
      pause: halt,
      resume: function () { if (stream && !scanning) { scanning = true; tick(); } },
      stop: function () { gen++; halt(); release(); },
      // true: 스캔 중, false: 시작하는 동안 stop() 이 불려 취소됨. 권한 거부 등은 예외로 던진다.
      start: async function () {
        if (stream) { api.resume(); return true; }
        if (!g.navigator.mediaDevices || !g.navigator.mediaDevices.getUserMedia) {
          var e = new Error('이 브라우저는 카메라를 쓸 수 없습니다. 주소가 https 인지 확인하세요.'); e.name = 'Unsupported'; throw e;
        }
        var my = ++gen;
        var s = await g.navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
        });
        if (my !== gen) { s.getTracks().forEach(function (t) { t.stop(); }); return false; }
        stream = s;
        video.srcObject = s;
        try { await video.play(); }
        catch (err) {
          // 다른 start/stop 이 srcObject 를 바꾸면 play() 가 AbortError 로 끝난다. 오류가 아니라 취소다.
          if (my !== gen) return false;
          if (err && err.name === 'AbortError') { release(); return false; }
          release();
          throw err;
        }
        if (my !== gen) return false;
        scanning = true;
        tick();
        return true;
      }
    };
    return api;
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
