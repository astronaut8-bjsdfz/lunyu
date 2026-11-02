/* ============================================================
   论语 · 日课 —— 主程序
   ------------------------------------------------------------
   题库在 data.js，进度在 localStorage，云同步只是「备份」。
   断网、Supabase 挂了，做题照样能用，这是有意的。
   ============================================================ */

(function () {
  'use strict';

  var D = window.LUN_DATA;
  var CFG = window.LUN_BACKEND || {};

  var K_PROG = 'lunyu.prog.v1';
  var K_META = 'lunyu.meta.v1';
  var K_THEME = 'lunyu.theme.v1';

  /* 答对一次进一档，间隔按档位走；答错直接回 0 档 */
  var GAP = [1, 3, 7, 16, 35];
  var NEW_PER_DAY = 4;
  var MAX_DUE = 8;

  var P = load(K_PROG, {});
  var M = load(K_META, {});
  var sess = null;
  var ans = { w: {}, ta: '', hits: null };
  var revealed = false;
  var pushTimer = 0;

  /* ---------------- 小工具 ---------------- */

  function load(k, d) {
    try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : d; }
    catch (e) { return d; }
  }
  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {}
  }
  function $(s, r) { return (r || document).querySelector(s); }
  function esc(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function dayKey(offset) {
    var d = new Date();
    if (offset) d.setDate(d.getDate() + offset);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function addDays(k, n) {
    var p = k.split('-');
    var d = new Date(+p[0], +p[1] - 1, +p[2]);
    d.setDate(d.getDate() + n);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  var CH = {};
  D.chs.forEach(function (c) { CH[c.id] = c; });
  var IT = {};
  D.items.forEach(function (i) { IT[i.id] = i; });

  var TYPE_NAME = { word: '解词', trans: '翻译', compare: '对比分析' };

  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('on'); }, 1800);
  }

  /* ---------------- 主题 ---------------- */

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', t === 'dark' ? '#0a0c0e' : '#efe8d7');
    var btn = $('#themeBtn');
    if (btn) btn.textContent = t === 'dark' ? '纸' : '夜';
    save(K_THEME, t);
  }
  function toggleTheme() {
    var t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'paper' : 'dark';
    applyTheme(t);
  }

  /* ---------------- 排期 ---------------- */

  function dueCount() {
    var t = dayKey(), n = 0;
    D.items.forEach(function (i) { if (P[i.id] && P[i.id].d <= t) n++; });
    return n;
  }
  function mastered() {
    var n = 0;
    D.items.forEach(function (i) { if (P[i.id] && P[i.id].b >= 3) n++; });
    return n;
  }
  function started() {
    var n = 0;
    D.items.forEach(function (i) { if (P[i.id]) n++; });
    return n;
  }

  function buildQueue() {
    var t = dayKey();
    var due = [], fresh = [];
    D.items.forEach(function (i) {
      if (!P[i.id]) fresh.push(i);
      else if (P[i.id].d <= t) due.push(i);
    });
    due.sort(function (a, b) { return (P[a.id].d || '').localeCompare(P[b.id].d || ''); });
    fresh = fresh.slice(0, NEW_PER_DAY);
    return mix(due.slice(0, MAX_DUE), fresh);
  }

  /* 到期题和新题交替，再把连续同题型的挪开，避免一上来三道翻译 */
  function mix(a, b) {
    var out = [], i, n = Math.max(a.length, b.length);
    for (i = 0; i < n; i++) { if (a[i]) out.push(a[i]); if (b[i]) out.push(b[i]); }
    for (i = 1; i < out.length; i++) {
      if (out[i].t === out[i - 1].t) {
        for (var j = i + 1; j < out.length; j++) {
          if (out[j].t !== out[i - 1].t) {
            var x = out[i]; out[i] = out[j]; out[j] = x; break;
          }
        }
      }
    }
    return out;
  }

  function record(it, hit, total) {
    var rate = total ? hit / total : 0;
    var p = P[it.id] || { b: 0, r: 0, w: 0, n: 0 };
    p.n++;
    if (rate >= 0.85) { p.b = Math.min(p.b + 1, 4); p.r++; }
    else if (rate >= 0.5) { p.b = Math.max(0, p.b - 1); p.w++; }
    else { p.b = 0; p.w++; }
    p.d = addDays(dayKey(), GAP[p.b]);
    p.t = Date.now();
    p.s = Math.round(rate * 100);
    P[it.id] = p;
    save(K_PROG, P);
    bumpDay();
    queuePush();
  }

  function bumpDay() {
    var t = dayKey();
    if (M.last === t) return;
    M.streak = (M.last === addDays(t, -1)) ? (M.streak || 0) + 1 : 1;
    M.last = t;
    save(K_META, M);
  }

  /* ---------------- 渲染：今日 ---------------- */

  function renderCard() {
    var stage = $('#stage');
    if (!stage) return;
    if (!sess || sess.i >= sess.q.length) { stage.innerHTML = doneHTML(); updateHero(); return; }

    var it = sess.q[sess.i];
    revealed = false;
    ans = { w: {}, ta: '', hits: null };
    stage.innerHTML = cardHTML(it);

    var first = stage.querySelector('.inp, .ta');
    if (first && window.innerWidth > 640) first.focus();
    updateHero();
  }

  function cardHTML(it) {
    var isCmp = it.t === 'compare';
    var ch = Array.isArray(it.c) ? CH[it.c[0]] : CH[it.c];
    var loc = isCmp
      ? it.c.map(function (id) { return CH[id].no; }).join(' · ')
      : ch.no;

    var h = '<div class="card">';
    h += '<div class="meta"><span class="tag">' + TYPE_NAME[it.t] + '</span>';
    h += '<span>' + (ch ? ch.b === 'xy' ? '学而 ' : '' : '') + loc + '</span>';
    h += '<span class="r">' + (sess.i + 1) + ' / ' + sess.q.length + '</span></div>';

    if (isCmp) {
      h += '<ul class="mats">';
      it.mats.forEach(function (m, k) {
        /* 编号用数字，不用 ①② —— 宋体里这个字形经常掉成方框 */
        h += '<li><b>材料 ' + (k + 1) + ' · ' + it.c.map(function (id) { return CH[id].no; })[k] + '</b>' + esc(m) + '</li>';
      });
      h += '</ul>';
      h += '<p class="ask">' + esc(it.q) + '</p>';
      h += '<textarea class="ta" data-ta placeholder="先写角度，再写共同点，别只抄原句"></textarea>';
    } else if (it.t === 'trans') {
      h += '<p class="src">「' + esc(it.q) + '」</p>';
      h += '<p class="ask">翻译上面这句</p>';
      h += '<textarea class="ta" data-ta placeholder="逐字落实，别漏虚词"></textarea>';
    } else {
      h += '<p class="ask"><b>' + esc(it.q) + '</b></p>';
      it.p.forEach(function (p, k) {
        h += '<div class="wline"><span class="w">' + esc(p.w) + '</span>';
        h += '<input class="inp" type="text" data-w="' + esc(p.w) + '" autocomplete="off" spellcheck="false" placeholder="什么意思">';
        h += '<span class="verdict" data-v="' + k + '"></span></div>';
      });
    }

    h += '<div class="acts"><button class="btn pri" data-act="reveal">对答案</button></div>';

    /* 答案区先搭好、藏起来，揭晓时只改状态，不重绘，免得输入框内容被冲掉 */
    h += '<div class="reveal" id="reveal" hidden>';
    /* 只有单句翻译题才配译文。对比题照整章译文没意义，只给第一则反而误导 */
    if (it.t === 'trans' && ch && ch.trans) {
      h += '<p class="rev-h">参考译文</p>';
      h += '<p class="trans">' + esc(ch.trans) +
           (ch.chk ? '' : '<span class="todo">译文待校</span>') + '</p>';
    }
    h += '<p class="rev-h">评分点 · 自动勾的偏宽，自己核一下</p><ul class="pts">';
    it.p.forEach(function (p, k) {
      h += '<li><button class="pt" type="button" data-pt="' + k + '">' +
           '<i class="bx"></i><span>' + (p.w ? '<b>' + esc(p.w) + '</b> ' : '') + esc(p.t) + '</span>' +
           '</button></li>';
    });
    h += '</ul><p class="score">得分 <b>0 / ' + it.p.length + '</b></p>';
    h += '<div class="acts"><button class="btn" data-act="next">下一题</button></div>';
    h += '</div>';

    h += '</div>';
    return h;
  }

  function doReveal() {
    if (revealed) return;
    revealed = true;
    var it = sess.q[sess.i];
    var rv = $('#reveal');
    if (!rv) return;

    ans.hits = it.p.map(function (p) {
      var src = p.w ? (ans.w[p.w] || '') : ans.ta;
      if (!src) return false;
      return p.kw.some(function (k) { return src.indexOf(k) >= 0; });
    });

    /* 解词题：顺手在输入框旁边标一下对错 */
    if (it.t === 'word') {
      it.p.forEach(function (p, k) {
        var v = document.querySelector('.verdict[data-v="' + k + '"]');
        if (!v) return;
        var ok = ans.hits[k];
        v.className = 'verdict ' + (ok ? 'ok' : 'no');
        v.textContent = ok ? '✓' : '✗';
      });
    }

    rv.hidden = false;
    /* 揭晓之后「对答案」就没用了，留在那儿会让人重复点 */
    var rb = document.querySelector('[data-act="reveal"]');
    if (rb) rb.hidden = true;
    var pts = rv.querySelectorAll('.pt');
    pts.forEach(function (el, k) { el.classList.toggle('on', !!ans.hits[k]); });
    updateScore();
  }

  function updateScore() {
    var it = sess.q[sess.i];
    var n = it.p.length;
    var hit = ans.hits ? ans.hits.filter(Boolean).length : 0;
    var b = document.querySelector('.score b');
    if (b) b.textContent = hit + ' / ' + n;
  }

  function nextCard() {
    if (!revealed) return;
    var it = sess.q[sess.i];
    var hit = ans.hits ? ans.hits.filter(Boolean).length : 0;
    record(it, hit, it.p.length);
    sess.i++;
    sess.done++;
    renderCard();
  }

  function doneHTML() {
    var t = dayKey();
    var due = dueCount();
    var total = sess ? sess.q.length : 0;
    return '<div class="card"><div class="empty"><b>今天这一场做完了</b>' +
      '共 ' + total + ' 题，明天要复习的有 ' + due + ' 题。<br>' +
      '不用赶，一天一场就够。</div>' +
      '<div class="acts"><button class="btn" data-act="free">再来 10 题（挑最弱的）</button>' +
      '<button class="btn ghost" data-act="go-bank">去翻篇目</button></div></div>';
  }

  function updateHero() {
    var h = $('#hero');
    if (!h) return;
    var t = dayKey();
    var total = sess ? sess.q.length : 0;
    var done = sess ? sess.done : 0;
    var pct = total ? Math.round(done / total * 100) : 0;
    var due = dueCount();
    h.innerHTML =
      '<h2>今日</h2>' +
      '<p>' + (total ? '这一场 ' + total + ' 题 · 到期的先来，再补 ' + sess.newN + ' 道新章' : '没有到期的题') + '</p>' +
      '<div class="nums">' +
        '<div><b>' + done + '</b>已做</div>' +
        '<div><b>' + total + '</b>本场</div>' +
        '<div><b>' + due + '</b>待复习</div>' +
        '<div><b>' + (M.streak || 0) + '</b>连续天</div>' +
      '</div>' +
      '<div class="pbar"><i style="width:' + pct + '%"></i></div>';
  }

  function renderToday() {
    /* 只有「没会话」或「跨天」才重开一场。做完了就停在完成页，
       否则每切一次 tab 回来就把刚做的题重新排一遍，完成数也会归零。 */
    if (!sess || sess.day !== dayKey()) startToday();
    var view = $('#view');
    view.innerHTML = '<div class="hero" id="hero"></div><div id="stage"></div>';
    renderCard();
  }

  function startToday() {
    var q = buildQueue();
    sess = { q: q, i: 0, done: 0, day: dayKey(), newN: 0 };
    /* 数一下这场里有几道是第一次见 */
    q.forEach(function (i) { if (!P[i.id]) sess.newN++; });
  }

  function freeRun(n) {
    var arr = D.items.slice().sort(function (a, b) {
      var pa = P[a.id], pb = P[b.id];
      var sa = pa ? pa.b * 100 - (pa.s || 0) : -60;
      var sb = pb ? pb.b * 100 - (pb.s || 0) : -60;
      return sa - sb;
    }).slice(0, n);
    sess = { q: arr, i: 0, done: 0, day: dayKey(), newN: 0, free: true };
    renderToday();
  }

  /* ---------------- 渲染：篇目 ---------------- */

  function chDots(c) {
    var ids = D.items.filter(function (i) { return !Array.isArray(i.c) && i.c === c.id; });
    var n = ids.length, on = 0;
    ids.forEach(function (i) { if (P[i.id] && P[i.id].b >= 3) on++; });
    var h = '<span class="dots">';
    for (var k = 0; k < n; k++) h += '<i class="' + (k < on ? 'on' : '') + '"></i>';
    return h + '</span>';
  }

  function renderBank() {
    var h = '<p class="lead">按篇翻。点某章看原文、注释和译文，也可以单独练这一章。</p>';
    D.books.forEach(function (b) {
      var chs = D.chs.filter(function (c) { return c.b === b.id; });
      h += '<div class="book"><div class="book-h"><span class="no">第 ' + b.no + ' 篇</span>' +
           '<span class="nm">' + b.name + '</span>' +
           '<span class="st">' + (b.on ? chs.length + ' 章 · 已收录' : '即将') + '</span></div>';
      if (b.on) {
        chs.forEach(function (c) {
          h += '<a class="chline" href="#/ch/' + c.id + '">' +
               '<span class="no">' + c.no + '</span>' +
               '<span class="tx">' + esc(c.text.replace(/^[^：]*：/, '').replace(/[「」]/g, '')) + '</span>' +
               chDots(c) + '</a>';
        });
      } else {
        h += '<div class="soonline">译文和题目还在录，先在学而篇练</div>';
      }
      h += '</div>';
    });
    $('#view').innerHTML = h;
  }

  function renderCh(id) {
    var c = CH[id];
    if (!c) { location.hash = '#/bank'; return; }
    var its = D.items.filter(function (i) {
      return Array.isArray(i.c) ? i.c.indexOf(id) >= 0 : i.c === id;
    });
    var b = D.books.filter(function (x) { return x.id === c.b; })[0];

    var h = '<div class="card">';
    h += '<div class="meta"><span class="tag">' + b.name + ' ' + c.no + '</span>';
    h += '<span class="r"><a href="#/bank" style="color:inherit">← 篇目</a></span></div>';
    h += '<p class="src">' + esc(c.text) + '</p>';

    h += '<p class="rev-h">注释</p><div class="notes">';
    c.notes.forEach(function (n) { h += '<span><b>' + esc(n[0]) + '</b> ' + esc(n[1]) + '</span>'; });
    h += '</div>';

    h += '<p class="rev-h">译文</p>';
    h += '<p class="trans">' + esc(c.trans) + (c.chk ? '' : '<span class="todo">译文待校</span>') + '</p>';

    h += '<div class="acts"><button class="btn pri" data-act="practice" data-ch="' + c.id + '">练这一章（' + its.length + ' 题）</button></div>';
    h += '</div>';
    $('#view').innerHTML = h;
  }

  /* ---------------- 渲染：我的 ---------------- */

  function renderMe() {
    var t = dayKey();
    var ms = mastered(), st = started(), du = dueCount();
    var total = D.items.length;

    var h = '<div class="stats">' +
      '<div class="stat"><b>' + ms + '</b><span>已掌握</span></div>' +
      '<div class="stat"><b>' + st + '</b><span>做过的题</span></div>' +
      '<div class="stat"><b>' + du + '</b><span>今天到期</span></div>' +
      '<div class="stat"><b>' + (M.streak || 0) + '</b><span>连续天数</span></div>' +
      '</div>';

    /* 薄弱画像：按题型看平均得分率 */
    var groups = {};
    D.items.forEach(function (i) {
      var p = P[i.id];
      if (!p) return;
      var g = groups[i.t] || (groups[i.t] = { n: 0, s: 0 });
      g.n++; g.s += (p.s || 0);
    });
    var rows = Object.keys(groups).map(function (k) {
      return { k: TYPE_NAME[k], v: Math.round(groups[k].s / groups[k].n), n: groups[k].n };
    }).sort(function (a, b) { return a.v - b.v; });

    h += '<p class="sec-h">薄弱 · 按题型</p>';
    if (!rows.length) {
      h += '<p class="lead">还没有数据，先做一场再看看。</p>';
    } else {
      h += '<ul class="weak">';
      rows.forEach(function (r) {
        h += '<li><span class="nm">' + r.k + '</span>' +
             '<span class="track"><i style="width:' + r.v + '%"></i></span>' +
             '<span class="pc">' + r.v + '% · ' + r.n + ' 题</span></li>';
      });
      h += '</ul>';
    }

    h += '<p class="sec-h">同步</p>';
    h += '<div class="card">';
    h += '<p class="lead">换手机、换电脑时，输入这串同步码就能接着背。抄在纸上，别只存在这台机器里。</p>';
    h += '<p class="code">' + ensureCode() + '</p>';
    h += '<div class="acts"><button class="btn" data-act="copy">复制</button>' +
         '<button class="btn ghost" data-act="sync">立即同步</button>' +
         '<span class="r" style="font-family:var(--mono);font-size:11px;color:var(--muted)">' + (M.syncMsg || '未连接') + '</span></div>';
    h += '</div>';

    h += '<p class="sec-h">其他</p>';
    h += '<div class="card"><div class="acts">' +
         '<button class="btn ghost" data-act="theme">换个皮</button>' +
         '<button class="btn ghost" data-act="reset">清空这台机器的进度</button></div>' +
         '<p class="lead" style="margin:12px 0 0">题库共 ' + total + ' 题，收了学而篇 16 章。为政、里仁在录。</p></div>';

    $('#view').innerHTML = h;
  }

  /* ---------------- 同步 ---------------- */

  function ensureCode() {
    if (M.code) return M.code;
    var A = 'ACDEFGHJKLMNPQRTUVWXY34679';
    var s = '';
    for (var i = 0; i < 10; i++) s += A.charAt(Math.floor(Math.random() * A.length));
    M.code = s.slice(0, 5) + '-' + s.slice(5);
    save(K_META, M);
    return M.code;
  }

  function sb(path, opt) {
    var ctl = new AbortController();
    var tm = setTimeout(function () { ctl.abort(); }, 6500);
    var o = opt || {};
    return fetch(CFG.url + '/rest/v1/' + path, {
      method: o.method || 'POST',
      signal: ctl.signal,
      headers: {
        'apikey': CFG.anonKey,
        'Authorization': 'Bearer ' + CFG.anonKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(o.body || {})
    }).then(function (r) {
      clearTimeout(tm);
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.text();
    }).then(function (tx) {
      return tx ? JSON.parse(tx) : null;
    }).catch(function (e) { clearTimeout(tm); throw e; });
  }

  function cloudPull() {
    return sb('rpc/' + (CFG.prefix || 'lun_') + 'pull', { body: { p_key: ensureCode() } })
      .then(function (data) {
        if (!data || typeof data !== 'object') return false;
        var merged = 0;
        Object.keys(data).forEach(function (id) {
          var remote = data[id], local = P[id];
          if (!local || (remote.t || 0) > (local.t || 0)) { P[id] = remote; merged++; }
        });
        if (merged) save(K_PROG, P);
        M.syncMsg = merged ? '已取回 ' + merged + ' 条' : '已同步';
        save(K_META, M);
        return true;
      })
      .catch(function () { M.syncMsg = '未连接（本地照常可用）'; save(K_META, M); return false; });
  }

  function cloudPush() {
    if (!M.code) return Promise.resolve(false);
    var body = { p_key: M.code, p_data: P };
    return sb('rpc/' + (CFG.prefix || 'lun_') + 'push', { body: body })
      .then(function () { M.syncMsg = '已同步'; save(K_META, M); return true; })
      .catch(function () { M.syncMsg = '未连接（本地照常可用）'; save(K_META, M); return false; });
  }

  function queuePush() {
    clearTimeout(pushTimer);
    pushTimer = setTimeout(function () { cloudPush(); }, 4000);
  }

  /* ---------------- 路由 ---------------- */

  function route() {
    var raw = location.hash.replace(/^#\/?/, '');
    var parts = raw.split('/');
    var tab = parts[0] || 'today';

    var tabs = document.querySelectorAll('#tabs a');
    var mark = (tab === 'ch') ? 'bank' : tab;
    tabs.forEach(function (a) { a.classList.toggle('on', a.dataset.tab === mark); });

    if (tab === 'bank') { renderBank(); }
    else if (tab === 'me') { renderMe(); }
    else if (tab === 'ch' && parts[1]) { renderCh(parts[1]); }
    else { renderToday(); }
    window.scrollTo(0, 0);
  }

  /* ---------------- 事件 ---------------- */

  document.addEventListener('click', function (e) {
    var t = e.target.closest('[data-act]');
    if (t) {
      var act = t.dataset.act;
      if (act === 'reveal') { doReveal(); return; }
      if (act === 'next') { nextCard(); return; }
      if (act === 'free') { freeRun(10); return; }
      if (act === 'go-bank') { location.hash = '#/bank'; return; }
      if (act === 'practice') {
        var id = t.dataset.ch;
        var list = D.items.filter(function (i) {
          return Array.isArray(i.c) ? i.c.indexOf(id) >= 0 : i.c === id;
        });
        sess = { q: list, i: 0, done: 0, day: dayKey(), newN: 0, free: true };
        location.hash = '#/today';
        setTimeout(renderToday, 0);
        return;
      }
      if (act === 'copy') {
        var code = ensureCode();
        if (navigator.clipboard) navigator.clipboard.writeText(code).then(function () { toast('同步码已复制'); });
        else toast(code);
        return;
      }
      if (act === 'sync') {
        toast('正在同步…');
        cloudPull().then(function () { return cloudPush(); }).then(function () { route(); });
        return;
      }
      if (act === 'theme') { toggleTheme(); return; }
      if (act === 'reset') {
        if (confirm('清空这台机器上的做题记录？云端不会动。')) {
          P = {}; M.streak = 0;
          save(K_PROG, P); save(K_META, M);
          sess = null;
          route();
          toast('已清空');
        }
        return;
      }
    }

    var pt = e.target.closest('.pt');
    if (pt && revealed) {
      var k = +pt.dataset.pt;
      ans.hits[k] = !ans.hits[k];
      pt.classList.toggle('on', ans.hits[k]);
      updateScore();
    }
  });

  document.addEventListener('input', function (e) {
    if (e.target.dataset && e.target.dataset.w !== undefined) {
      ans.w[e.target.dataset.w] = e.target.value;
    } else if (e.target.dataset && e.target.dataset.ta !== undefined) {
      ans.ta = e.target.value;
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target.classList && e.target.classList.contains('inp')) {
      e.preventDefault();
      if (!revealed) doReveal(); else nextCard();
    }
  });

  $('#themeBtn').addEventListener('click', toggleTheme);
  window.addEventListener('hashchange', route);

  /* ---------------- 启动 ---------------- */

  applyTheme(load(K_THEME, window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'paper'));
  ensureCode();
  route();

  /* 开场拉一次云端进度。拉回来只在「我的」页重画 ——
     如果在做题中间重画，会把刚写了一半的答案冲掉。 */
  setTimeout(function () {
    cloudPull().then(function (ok) {
      if (!ok) return;
      if ((location.hash || '').indexOf('me') >= 0) route();
    });
  }, 600);

  /* 调试钩子，方便无头浏览器验收 */
  window.__lun = {
    D: D, P: function () { return P; }, M: function () { return M; },
    sess: function () { return sess; },
    reveal: doReveal, next: nextCard, route: route,
    startToday: startToday, freeRun: freeRun,
    resetSess: function () { sess = null; }
  };

})();
