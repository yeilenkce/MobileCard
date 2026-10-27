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

  // 카메라. onFound(text) 는 한 번만 불리고, 그 뒤 카메라를 끈다.
  scanner.camera = function (video, cb) {
    var stream = null, timer = 0, running = false, cv = doc.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });

    function stop() {
      running = false;
      clearTimeout(timer);
      if (stream) stream.getTracks().forEach(function (t) { t.stop(); });
      stream = null;
      video.srcObject = null;
    }

    function tick() {
      if (!running) return;
      if (video.readyState >= 2 && video.videoWidth) {
        var s = Math.min(1, 720 / video.videoWidth);
        var w = Math.round(video.videoWidth * s), h = Math.round(video.videoHeight * s);
        if (cv.width !== w) { cv.width = w; cv.height = h; }
        cx.drawImage(video, 0, 0, w, h);
        var text = scan(cx.getImageData(0, 0, w, h).data, w, h, false);
        if (text) { stop(); cb.onFound(text); return; }
      }
      timer = setTimeout(tick, 70);
    }

    return {
      active: function () { return running; },
      stop: stop,
      start: async function () {
        if (!g.navigator.mediaDevices || !g.navigator.mediaDevices.getUserMedia) {
          var e = new Error('이 브라우저는 카메라를 쓸 수 없습니다. 주소가 https 또는 localhost 인지 확인하세요.'); e.name = 'Unsupported'; throw e;
        }
        stream = await g.navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false
        });
        video.srcObject = stream;
        await video.play();
        running = true;
        tick();
      }
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
