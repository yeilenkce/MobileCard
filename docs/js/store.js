/*
 * 시험패스 PoC: 브라우저 저장소 (IndexedDB, 사용할 수 없으면 메모리)
 * 스토어
 *   kv        발급기관 키쌍(비추출 개인키)
 *   passes    응시자 앱이 발급받은 시험패스
 *   packages  시험장 검증 패키지 메타와 AES-GCM 키 (감독관 단말)
 *   entries   토큰ID -> 암호화된 이름·생년월일·사진 (감독관 단말)
 *   used      통과 처리된 토큰 (감독관 단말)
 *   history   검증 이력, 수험번호만 기록 (감독관 단말)
 *   metrics   측정 모드 기록 (개인정보 없음)
 */
(function (g) {
  'use strict';
  var SP = (g.SP = g.SP || {});

  var NAME = 'sigeompass-poc';
  var VERSION = 1;
  var STORES = {
    kv: { keyPath: 'k' },
    passes: { keyPath: 'tokenId' },
    packages: { keyPath: 'pkgId' },
    entries: { keyPath: 'tokenId' },
    used: { keyPath: 'tokenId' },
    history: { keyPath: 'id', autoIncrement: true },
    metrics: { keyPath: 'id', autoIncrement: true }
  };
  var names = Object.keys(STORES);

  var idb = null, mem = null, mode = 'pending';

  function makeMem() {
    var m = {}, seq = {};
    names.forEach(function (n) { m[n] = new Map(); seq[n] = 0; });
    return { m: m, seq: seq };
  }

  function openIDB() {
    return new Promise(function (resolve, reject) {
      if (typeof g.indexedDB === 'undefined') return reject(new Error('IndexedDB 없음'));
      var req;
      try { req = g.indexedDB.open(NAME, VERSION); } catch (e) { return reject(e); }
      req.onupgradeneeded = function () {
        var db = req.result;
        names.forEach(function (n) { if (!db.objectStoreNames.contains(n)) db.createObjectStore(n, STORES[n]); });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('IndexedDB 차단됨')); };
    });
  }

  function run(store, access, fn) {
    return new Promise(function (resolve, reject) {
      var t = idb.transaction(store, access), out;
      t.oncomplete = function () { resolve(out); };
      t.onerror = function () { reject(t.error); };
      t.onabort = function () { reject(t.error || new Error('트랜잭션 중단')); };
      var r = fn(t.objectStore(store));
      if (r) r.onsuccess = function () { out = r.result; };
    });
  }

  SP.db = {
    // { persistent: boolean }
    init: async function () {
      if (mode !== 'pending') return { persistent: mode === 'idb' };
      try { idb = await openIDB(); mode = 'idb'; }
      catch (e) { mem = makeMem(); mode = 'mem'; }
      return { persistent: mode === 'idb' };
    },
    persistent: function () { return mode === 'idb'; },

    get: async function (store, key) {
      if (mode === 'mem') return mem.m[store].get(key) || null;
      var v = await run(store, 'readonly', function (s) { return s.get(key); });
      return v || null;
    },
    put: async function (store, value) {
      if (mode === 'mem') {
        var kp = STORES[store].keyPath, key = value[kp];
        if (key === undefined) { key = ++mem.seq[store]; value[kp] = key; }
        mem.m[store].set(key, value);
        return key;
      }
      return run(store, 'readwrite', function (s) { return s.put(value); });
    },
    del: async function (store, key) {
      if (mode === 'mem') { mem.m[store].delete(key); return; }
      return run(store, 'readwrite', function (s) { return s.delete(key); });
    },
    all: async function (store) {
      if (mode === 'mem') return Array.from(mem.m[store].values());
      return run(store, 'readonly', function (s) { return s.getAll(); });
    },
    count: async function (store) {
      if (mode === 'mem') return mem.m[store].size;
      return run(store, 'readonly', function (s) { return s.count(); });
    },
    clear: async function (store) {
      if (mode === 'mem') { mem.m[store].clear(); return; }
      return run(store, 'readwrite', function (s) { return s.clear(); });
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
