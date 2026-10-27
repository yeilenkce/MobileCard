/*
 * 시험패스 PoC: 탭 전환과 시작
 */
(function (g) {
  'use strict';
  var SP = g.SP, ui = SP.ui, $ = ui.$;
  var TABS = ['applicant', 'ticket', 'supervisor'];
  var app = (SP.app = {});
  var currentTab = 'applicant';

  app.go = function (name, opts) {
    opts = opts || {};
    var prev = currentTab;
    currentTab = name;
    TABS.forEach(function (t) {
      var on = t === name, b = $('#tab-' + t);
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
      $('#view-' + t).hidden = !on;
    });
    if (prev === 'supervisor' && name !== 'supervisor') SP.supervisor.leave();
    if (name === 'ticket') SP.ticket.refresh(opts.tokenId);
    if (name === 'supervisor') {
      SP.supervisor.enter();
      SP.supervisor.refresh().then(function () { if (opts.paste) SP.supervisor.prefill(opts.paste); });
    }
    if (opts.focus) $('#tab-' + name).focus();
    try { g.history.replaceState(null, '', '#' + name); } catch (e) { /* file:// 등에서 막히면 무시 */ }
    g.scrollTo({ top: 0, behavior: 'auto' });
  };

  // opts.ticketId: 방금 발급한 시험패스를 수험표에 바로 보여 준다.
  app.refresh = async function (opts) {
    await SP.ticket.refresh(opts && opts.ticketId);
    await SP.supervisor.refresh();
  };

  app.init = async function () {
    ui.initTheme();
    var st = await SP.db.init();
    if (!st.persistent) {
      var note = ui.el('div', { class: 'demo-band warn', role: 'note', text: '이 브라우저는 저장소를 막고 있어 새로고침하면 발급한 시험패스와 검증 패키지가 사라집니다.' });
      g.document.body.insertBefore(note, ui.$('.skip').nextSibling);
    }
    SP.applicant.init();
    SP.ticket.init();
    SP.supervisor.init();

    TABS.forEach(function (t, i) {
      var b = $('#tab-' + t);
      b.addEventListener('click', function () { app.go(t); });
      b.addEventListener('keydown', function (e) {
        var d = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : e.key === 'Home' ? -i : e.key === 'End' ? TABS.length - 1 - i : 0;
        if (!d) return;
        e.preventDefault();
        app.go(TABS[(i + d + TABS.length) % TABS.length], { focus: true });
      });
    });
    var hash = (g.location.hash || '').replace('#', '');
    if (TABS.indexOf(hash) > -1) app.go(hash);
    await app.refresh();
    g.document.documentElement.setAttribute('data-ready', '1');
  };

  g.document.addEventListener('DOMContentLoaded', function () {
    app.init().catch(function (e) {
      var n = ui.el('div', { class: 'demo-band warn', role: 'alert', text: '시작하지 못했습니다: ' + e.message });
      g.document.body.insertBefore(n, g.document.body.firstChild);
      if (g.console) g.console.error(e);
    });
  });
})(typeof globalThis !== 'undefined' ? globalThis : self);
