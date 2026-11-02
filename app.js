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
  var K_TEXT = 'lunyu.text.v1';
  var K_PICK = 'lunyu.pick.v1';

  /* 答对一次进一档，间隔按档位走；答错直接回 0 档 */
  var GAP = [1, 3, 7, 16, 35];
  var NEW_PER_DAY = 4;
  var MAX_DUE = 8;

  var P = load(K_PROG, {});
  var M = load(K_META, {});
  /* 校对过的译文单独存一层，盖在 data.js 上面。
     data.js 是随网页下发的，网页改不了它，所以改动只能存在这里。 */
  var TEXT = load(K_TEXT, {});
  var PICK = load(K_PICK, { books: ['xy'], types: ['word', 'trans', 'compare'], n: 10 });

  /* 范围有两种：按篇（整篇都要）和按句（只练勾出来的那几句）。
     老存档里没有这两个字段，补上默认值，别让它崩 */
  if (PICK.mode !== 'book' && PICK.mode !== 'ch') PICK.mode = 'book';
  if (!Array.isArray(PICK.chs)) PICK.chs = [];
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
  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  /* 把原文里被考的词标出来。解词题没有原文就无从「加点」，
     所以要高亮，而且是一次性正则替换，不能逐个 split ——
     否则短的词会落进已经包好的 <em> 里，套出嵌套标签。 */
  function hlWords(text, words) {
    var s = esc(text);
    var ws = (words || []).filter(Boolean).map(function (w) { return esc(w); })
      .sort(function (a, b) { return b.length - a.length; });
    if (!ws.length) return s;
    var re = new RegExp('(' + ws.map(escRe).join('|') + ')', 'g');
    return s.replace(re, '<em class="hl">$1</em>');
  }

  /* Fisher-Yates，随机抽题用；不用 sort(random) 那套，分布偏 */
  function shuffle(a) {
    var x = a.slice();
    for (var i = x.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = x[i]; x[i] = x[j]; x[j] = t;
    }
    return x;
  }
  function toggleIn(arr, v) {
    var i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1); else arr.push(v);
  }

  var CH = {};
  D.chs.forEach(function (c) { CH[c.id] = c; });
  var BK = {};
  D.books.forEach(function (b) { BK[b.id] = b; });
  var IT = {};
  D.items.forEach(function (i) { IT[i.id] = i; });

  var TYPE_NAME = { word: '解词', trans: '翻译', compare: '对比分析' };

  /* 译文优先取校对过的那一层 */
  function transOf(ch) {
    return (ch && TEXT[ch.id] && TEXT[ch.id].t) || (ch ? ch.trans : '');
  }
  function chkOf(ch) {
    if (!ch) return 1;
    var o = TEXT[ch.id];
    if (o && o.c !== undefined) return o.c;
    return ch.chk;
  }

  /* 「学过这一章」＝ 这一章的题里有任何一道做过。
     对比题要求材料涉及的每一章都学过，否则整题不出。 */
  function chLearned(cid) {
    for (var i = 0; i < D.items.length; i++) {
      var it = D.items[i];
      if (!P[it.id]) continue;
      if (Array.isArray(it.c) ? it.c.indexOf(cid) >= 0 : it.c === cid) return true;
    }
    return false;
  }
  function itemAllowed(it) {
    if (it.t !== 'compare') return true;
    return it.c.every(function (cid) { return CH[cid] && chLearned(cid); });
  }
  /* 自选范围：篇目、题型都要对上；按句模式下还要求每一句都在勾选里。
     对比题是跨章的，所以它涉及的每一章都得同时满足，缺一章整题不出 */
  function itemInScope(it) {
    if (PICK.types.indexOf(it.t) < 0) return false;
    var cs = Array.isArray(it.c) ? it.c : [it.c];
    return cs.every(function (cid) {
      var ch = CH[cid];
      if (!ch || PICK.books.indexOf(ch.b) < 0) return false;
      if (PICK.mode === 'ch') return PICK.chs.indexOf(cid) >= 0;
      return true;
    });
  }

  /* 当前篇目下的全部章 / 打了 hot 标记的重点章 */
  function bookChs() {
    return D.chs.filter(function (c) { return PICK.books.indexOf(c.b) >= 0; });
  }
  function hotIds() {
    return bookChs().filter(function (c) { return c.hot; })
      .map(function (c) { return c.id; });
  }
  /* 句子列表里只放前半句，认得出是哪一章就行，原文在章节页里一字不少 */
  function snippet(t) {
    var s = String(t).replace(/^[^：]{0,8}：/, '').replace(/[「」]/g, '');
    var m = s.split(/[。？！；]/)[0] || s;
    return m.length > 20 ? m.slice(0, 20) + '…' : m;
  }

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
      /* 没学过材料的对比题不进队列，等两边都碰过再放它出来 */
      if (!itemAllowed(i)) return;
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
    return spreadChapters(out);
  }

  function ck(it) { return Array.isArray(it.c) ? it.c.join('+') : it.c; }

  /* 同一章的两题别挨着：刚问完「说」是什么意思，下一题就让你翻译同一句，很腻。
     不逐个判断邻居——换位之后左右邻都变了，容易漏（j 紧挨着 i 时还会自己跟自己比）。
     直接数全局「相邻同章」的处数，只有换完真的变少才留下。 */
  function ck(it) { return Array.isArray(it.c) ? it.c.join('+') : it.c; }
  function clashes(arr) {
    var n = 0;
    for (var i = 1; i < arr.length; i++) if (ck(arr[i]) === ck(arr[i - 1])) n++;
    return n;
  }
  function spreadChapters(arr) {
    var guard = 0;
    while (clashes(arr) && guard++ < 40) {
      var better = false;
      for (var i = 1; i < arr.length && !better; i++) {
        if (ck(arr[i]) !== ck(arr[i - 1])) continue;
        for (var j = i + 1; j < arr.length; j++) {
          var before = clashes(arr);
          var t = arr[i]; arr[i] = arr[j]; arr[j] = t;
          if (clashes(arr) < before) { better = true; break; }
          arr[j] = arr[i]; arr[i] = t;
        }
      }
      if (!better) break;
    }
    return arr;
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

    /* 跨篇对比时只写「4.11」看不出是哪一篇，得把篇名带上；
       篇内的就不必，否则「八佾 3.1 · 八佾 3.19」啰嗦 */
    var cIds = Array.isArray(it.c) ? it.c : [it.c];
    var sameBook = cIds.every(function (id) { return CH[id] && CH[id].b === ch.b; });
    function refOf(id) {
      var c = CH[id];
      if (!c) return id;
      return (sameBook || !BK[c.b] ? '' : BK[c.b].name + ' ') + c.no;
    }

    var loc = isCmp ? cIds.map(refOf).join(' · ') : ch.no;

    var h = '<div class="card">';
    h += '<div class="meta"><span class="tag">' + TYPE_NAME[it.t] + '</span>';
    h += '<span>' + (sameBook && ch && BK[ch.b] ? BK[ch.b].name + ' ' : '') + loc + '</span>';
    h += '<span class="r">' + (sess.i + 1) + ' / ' + sess.q.length + '</span></div>';

    if (isCmp) {
      h += '<ul class="mats">';
      it.mats.forEach(function (m, k) {
        /* 编号用数字，不用 ①② —— 宋体里这个字形经常掉成方框 */
        h += '<li><b>材料 ' + (k + 1) + ' · ' + refOf(it.c[k]) + '</b>' + esc(m) + '</li>';
      });
      h += '</ul>';
      h += '<p class="ask">' + esc(it.q) + '</p>';
      h += '<textarea class="ta" data-ta placeholder="先写角度，再写共同点，别只抄原句"></textarea>';
    } else if (it.t === 'trans') {
      h += '<p class="src">「' + esc(it.q) + '」</p>';
      h += '<p class="ask">翻译上面这句</p>';
      h += '<textarea class="ta" data-ta placeholder="逐字落实，别漏虚词"></textarea>';
    } else {
      /* 解词题必须先给原文：没有语境，光看两个词等于让人猜词典 */
      h += '<p class="src">' + hlWords(ch.text, it.p.map(function (p) { return p.w; })) + '</p>';
      h += '<p class="ask">' + esc(it.q) + '</p>';
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
    if (it.t === 'trans' && ch && transOf(ch)) {
      h += '<p class="rev-h">参考译文</p>';
      h += '<p class="trans">' + esc(transOf(ch)) +
           (chkOf(ch) ? '' : '<span class="todo">译文待校</span>') + '</p>';
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
    var arr = D.items.filter(itemAllowed).sort(function (a, b) {
      var pa = P[a.id], pb = P[b.id];
      var sa = pa ? pa.b * 100 - (pa.s || 0) : -60;
      var sb = pb ? pb.b * 100 - (pb.s || 0) : -60;
      return sa - sb;
    }).slice(0, n);
    sess = { q: arr, i: 0, done: 0, day: dayKey(), newN: 0, free: true };
    renderToday();
  }

  /* 自选练习：从选定篇目、选定题型里随机抽 n 题。
     范围内的对比题还要额外满足「材料章都学过」，否则跳过。 */
  function scopePool() {
    return D.items.filter(function (i) { return itemInScope(i) && itemAllowed(i); });
  }
  function customRun() {
    var pool = scopePool();
    if (!pool.length) { toast('这个范围里没有能出的题'); return; }
    var n = PICK.n > 0 ? Math.min(PICK.n, pool.length) : pool.length;

    /* 纯随机一定会偏：16 道解词、16 道翻译里抽 10 题，
       很容易抽成八道解词、一道翻译。按题型轮着取，凑满为止 */
    var groups = {};
    pool.forEach(function (i) { (groups[i.t] || (groups[i.t] = [])).push(i); });
    var keys = PICK.types.filter(function (t) { return groups[t]; });
    keys.forEach(function (t) { groups[t] = shuffle(groups[t]); });

    var out = [], round = 0, usedCh = {};
    while (out.length < n) {
      var got = false;
      for (var k = 0; k < keys.length && out.length < n; k++) {
        var b = groups[keys[(round + k) % keys.length]];
        if (!b.length) continue;
        /* 优先挑还没出现过的章，从源头上就不让同一句被考两遍 */
        var idx = -1;
        for (var q = 0; q < b.length; q++) {
          if (!usedCh[ck(b[q])]) { idx = q; break; }
        }
        if (idx < 0) idx = 0;
        var one = b.splice(idx, 1)[0];
        usedCh[ck(one)] = 1;
        out.push(one);
        got = true;
      }
      if (!got) break;
      round++;
    }

    sess = { q: spreadChapters(shuffle(out)), i: 0, done: 0, day: dayKey(), newN: 0, free: true, custom: true };
    location.hash = '#/today';
    setTimeout(renderToday, 0);
    if (n < (PICK.n || 0)) toast('范围内只凑出 ' + pool.length + ' 题');
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

  function pickHTML() {
    var pool = scopePool();
    var h = '<div class="card pick">';
    h += '<div class="pick-h"><span class="pk-t">自选练习</span>' +
         '<span class="pk-n">可出 ' + pool.length + ' 题</span></div>';
    h += '<p class="lead">挑篇目、挑题型、定题数，从这里随机抽，不按今天的排期走。</p>';

    h += '<p class="pk-lab">范围</p><div class="chips">';
    h += '<button class="chip' + (PICK.mode === 'book' ? ' on' : '') + '" data-pick-mode="book">按篇</button>';
    h += '<button class="chip' + (PICK.mode === 'ch' ? ' on' : '') + '" data-pick-mode="ch">按句</button>';
    h += '</div>';

    h += '<p class="pk-lab">篇目</p><div class="chips">';
    D.books.forEach(function (b) {
      var on = PICK.books.indexOf(b.id) >= 0;
      h += '<button class="chip' + (on ? ' on' : '') + '" data-pick-book="' + b.id + '"' +
           (b.on ? '' : ' disabled') + '>' + b.name + (b.on ? '' : ' · 未收') + '</button>';
    });
    h += '</div>';

    if (PICK.mode === 'ch') {
      var list = bookChs();
      var chosen = list.filter(function (c) { return PICK.chs.indexOf(c.id) >= 0; });
      h += '<p class="pk-lab">句子<span class="pk-sub">已选 ' + chosen.length + ' / ' + list.length + '</span></p>';
      if (!list.length) {
        /* 篇目一个都没选，句子自然为空；别摆一个空框让人以为坏了 */
        h += '<p class="pk-note">先在上面选一个篇目。</p>';
      } else {
        h += '<div class="chips" style="margin-bottom:10px">';
        h += '<button class="chip xs" data-pick-hot="hot">只留重点</button>';
        h += '<button class="chip xs" data-pick-hot="all">全选</button>';
        h += '<button class="chip xs" data-pick-hot="none">清空</button>';
        h += '</div>';
        h += '<div class="sents">';
        var lastB = null;
        list.forEach(function (c) {
          /* 篇目多选时一口气列一百多句，按篇插一条小标题才找得到 */
          if (c.b !== lastB) {
            lastB = c.b;
            var bk = BK[c.b];
            h += '<div class="sent-bk">第 ' + (bk ? bk.no : '') + ' 篇 · ' +
                 (bk ? bk.name : c.b) + '</div>';
          }
          var on = PICK.chs.indexOf(c.id) >= 0;
          h += '<button class="sent' + (on ? ' on' : '') + '" data-pick-ch="' + c.id + '"' +
               ' aria-pressed="' + (on ? 'true' : 'false') + '">' +
               '<i class="s-bx"></i>' +
               '<span class="s-no">' + c.no + '</span>' +
               '<span class="s-tx">' + esc(snippet(c.text)) + '</span>' +
               (c.hot ? '<span class="s-hot">重点</span>' : '') +
               '</button>';
        });
        h += '</div><p class="sents-hint">↑↓ 列表可上下滑，共 ' + list.length + ' 句</p>';
        h += '<p class="pk-note">「重点」是常考的那几句，切到按句就默认勾上；其余句子照样能勾，只是不默认。</p>';
      }
    }

    h += '<p class="pk-lab">题型</p><div class="chips">';
    ['word', 'trans', 'compare'].forEach(function (t) {
      h += '<button class="chip' + (PICK.types.indexOf(t) >= 0 ? ' on' : '') + '" data-pick-type="' + t + '">' +
           TYPE_NAME[t] + '</button>';
    });
    h += '</div>';

    h += '<p class="pk-lab">题数</p><div class="chips">';
    [5, 10, 20, 0].forEach(function (n) {
      h += '<button class="chip' + (PICK.n === n ? ' on' : '') + '" data-pick-n="' + n + '">' +
           (n || '全部') + '</button>';
    });
    h += '</div>';

    /* 选了几组对比、却因材料没学全而被扣下的，明说，不然像 bug */
    var locked = 0;
    D.items.forEach(function (i) {
      if (i.t === 'compare' && itemInScope(i) && !itemAllowed(i)) locked++;
    });
    if (locked) {
      h += '<p class="pk-note">还有 ' + locked + ' 组对比题被扣下了：' +
           (PICK.mode === 'ch' ? '要它涉及的每一句都勾上，且都学过' : '涉及的章要都学过') +
           '，才放出来。</p>';
    }

    var n = PICK.n > 0 ? Math.min(PICK.n, pool.length) : pool.length;
    h += '<div class="acts"><button class="btn pri" data-act="custom"' +
         (pool.length ? '' : ' disabled') + '>开始 · 抽 ' + n + ' 题</button></div>';
    h += '</div>';
    return h;
  }

  function renderBank() {
    /* 勾一句就重绘整块，列表的滚动位置得自己接住，
       否则滑到 1.13 点一下，列表跳回顶上，人得再滑一次 */
    var oldBox = document.querySelector('.sents');
    var keepTop = oldBox ? oldBox.scrollTop : 0;

    var h = pickHTML();
    h += '<p class="lead" style="margin-top:22px">按篇翻。点某章看原文、注释和译文，也可以单独练这一章。</p>';
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

    var box = document.querySelector('.sents');
    if (box) {
      if (keepTop) box.scrollTop = keepTop;
      /* 装不下才提示「可上下滑」，装得下就不啰嗦 */
      var hint = document.querySelector('.sents-hint');
      var upd = function () {
        if (hint) hint.classList.toggle('on', box.scrollHeight - box.clientHeight > 4);
      };
      box.addEventListener('scroll', upd);
      upd();
    }
  }

  function renderCh(id) {
    var c = CH[id];
    if (!c) { location.hash = '#/bank'; return; }
    var its = D.items.filter(function (i) {
      if (!itemAllowed(i)) return false;
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

    h += '<div class="revrow"><span class="rev-h">译文</span>' +
         '<button class="btn ghost xs" data-act="edit-trans" data-ch="' + c.id + '">校对译文</button></div>';
    h += '<p class="trans" id="transShow">' + esc(transOf(c)) +
         (chkOf(c) ? '' : '<span class="todo">译文待校</span>') + '</p>';

    h += '<div class="editbox" id="editBox" hidden>' +
         '<textarea class="ta" id="transTa" spellcheck="false">' + esc(transOf(c)) + '</textarea>' +
         '<p class="pk-note">照纸书改。「已核对」亮着表示这句你核过了，角标会消失；只是改了字还不踏实，就点灭它。</p>' +
         '<div class="acts">' +
           '<button class="btn pri" data-act="save-trans" data-ch="' + c.id + '">保存</button>' +
           '<button class="chip verbtn" id="chkBtn" data-act="flip-chk">' +
             (chkOf(c) ? '已核对' : '标为已核对') + '</button>' +
           '<button class="btn ghost" data-act="cancel-trans">取消</button>' +
         '</div></div>';

    h += '<div class="acts"><button class="btn pri" data-act="practice" data-ch="' + c.id + '">练这一章（' + its.length + ' 题）</button></div>';
    h += '</div>';
    $('#view').innerHTML = h;
    /* 打开时记下当前的核对状态，编辑期间只动内存，保存才落盘，
       否则一点「已核对」就重画，textarea 里刚改的字全丢 */
    editChk = !!chkOf(c);
    syncChkBtn();
  }

  var editChk = null;
  function syncChkBtn() {
    var b = $('#chkBtn');
    if (!b) return;
    b.classList.toggle('on', !!editChk);
    b.textContent = editChk ? '已核对' : '标为已核对';
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
    h += '<p class="lead">这串码只属于这台设备。每个同学打开网页都会自动生成自己的一串，各不相同，进度互不影响——所以不必担心谁把谁覆盖掉。</p>';
    h += '<p class="code">' + ensureCode() + '</p>';
    h += '<p class="pk-note">换手机、换电脑时，在新设备上把这串码填进下面的框，就能接着背。反过来，把这串码发给别人，两边的进度就会并成一份，别这么干。</p>';
    h += '<div class="row2"><input class="inp" id="codeIn" type="text" maxlength="12" autocomplete="off" spellcheck="false" placeholder="输入旧设备的同步码"><button class="btn" data-act="use-code">用这串</button></div>';
    h += '<div class="acts"><button class="btn ghost" data-act="copy">复制我的码</button>' +
         '<button class="btn ghost" data-act="sync">立即同步</button>' +
         '<span class="r" style="font-family:var(--mono);font-size:11px;color:var(--muted)">' + (M.syncMsg || '未连接') + '</span></div>';
    h += '</div>';

    /* 译文校对：改动在本机，导出后交给维护者写进 data.js，全班才看得到 */
    var tn = Object.keys(TEXT).length, tc = 0;
    Object.keys(TEXT).forEach(function (k) { if (TEXT[k] && TEXT[k].c) tc++; });
    h += '<p class="sec-h">译文校对</p>';
    h += '<div class="card">';
    if (!tn) {
      h += '<p class="lead">题库的译文据杨伯峻《论语译注》核过一轮。发现哪句有出入，去「篇目」点开那一章，译文右边有「校对译文」。</p>';
    } else {
      h += '<p class="lead">改过 ' + tn + ' 条，其中 ' + tc + ' 条标了已核对。</p>';
      h += '<p class="pk-note">改动只存在这台机器上。要让全班都看到，点下面导出，把这段发给维护者写进题库。</p>';
      h += '<div class="acts"><button class="btn" data-act="export-text">导出校对结果</button>' +
           '<button class="btn ghost" data-act="clear-text">撤销全部改动</button></div>';
      h += '<textarea class="ta" id="expTa" readonly hidden></textarea>';
    }
    h += '</div>';

    h += '<p class="sec-h">其他</p>';
    h += '<div class="card"><div class="acts">' +
         '<button class="btn ghost" data-act="theme">换个皮</button>' +
         '<button class="btn ghost" data-act="reset">清空这台机器的进度</button></div>' +
         '<p class="lead" style="margin:12px 0 0">题库共 ' + total + ' 题，收了' +
         D.books.filter(function (b) { return b.on; }).map(function (b) { return b.name; }).join('、') +
         '，共 ' + D.chs.length + ' 章。</p></div>';

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
          if (!itemAllowed(i)) return false;
          return Array.isArray(i.c) ? i.c.indexOf(id) >= 0 : i.c === id;
        });
        if (!list.length) { toast('这一章暂时没有能出的题'); return; }
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

      if (act === 'custom') { customRun(); return; }

      if (act === 'edit-trans') {
        var box = $('#editBox'), show = $('#transShow');
        if (box) { box.hidden = false; if (show) show.hidden = true; }
        var ta = $('#transTa');
        if (ta) {
          /* 高度跟着内容走，长译文别让人在小框里滚 */
          ta.style.height = 'auto';
          ta.style.height = Math.min(ta.scrollHeight + 4, 460) + 'px';
          if (window.innerWidth > 640) ta.focus();
        }
        return;
      }
      if (act === 'flip-chk') { editChk = !editChk; syncChkBtn(); return; }
      if (act === 'save-trans') {
        var cid = t.dataset.ch;
        var nv = (($('#transTa') || {}).value || '').trim();
        if (!nv) { toast('译文不能空着'); return; }
        TEXT[cid] = { t: nv, c: editChk ? 1 : 0, at: Date.now() };
        save(K_TEXT, TEXT);
        toast(editChk ? '已保存，标为已核对' : '已保存，仍是待校');
        route();
        return;
      }
      if (act === 'cancel-trans') {
        var eb = $('#editBox'), ts = $('#transShow');
        if (eb) eb.hidden = true;
        if (ts) ts.hidden = false;
        return;
      }

      if (act === 'use-code') {
        var inp = $('#codeIn');
        var raw = ((inp && inp.value) || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
        if (raw.length !== 10) { toast('同步码是 10 位字符'); return; }
        var nc = raw.slice(0, 5) + '-' + raw.slice(5);
        if (nc === M.code) { toast('就是当前这串'); return; }
        if (!confirm('换成 ' + nc + '？\n\n这台机器上已有的进度不会丢，会和那串的进度合并到一起。')) return;
        M.code = nc;
        save(K_META, M);
        toast('正在取回…');
        cloudPull().then(function () { return cloudPush(); }).then(function () { route(); });
        return;
      }

      if (act === 'export-text') {
        var et = $('#expTa');
        if (et) {
          et.value = JSON.stringify(TEXT);
          et.hidden = false;
          et.focus();
          et.select();
          toast('已填入，全选复制');
        }
        return;
      }
      if (act === 'clear-text') {
        if (confirm('撤销这台机器上所有译文改动？题库里的原稿不会变。')) {
          TEXT = {};
          save(K_TEXT, TEXT);
          route();
          toast('已撤销');
        }
        return;
      }

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

    /* 自选练习：范围 / 篇目 / 句子 / 题型 / 题数 */
    var pk = e.target.closest('[data-pick-mode],[data-pick-book],[data-pick-ch],[data-pick-hot],[data-pick-type],[data-pick-n]');
    if (pk) {
      if (pk.dataset.pickMode !== undefined) {
        PICK.mode = pk.dataset.pickMode;
        /* 第一次切到按句，先把重点句勾上；不然一片空框，不知道该点哪 */
        if (PICK.mode === 'ch' && !PICK.chs.length) PICK.chs = hotIds();
      }
      if (pk.dataset.pickBook !== undefined) toggleIn(PICK.books, pk.dataset.pickBook);
      if (pk.dataset.pickCh !== undefined) toggleIn(PICK.chs, pk.dataset.pickCh);
      if (pk.dataset.pickHot !== undefined) {
        var v = pk.dataset.pickHot;
        var vis = bookChs().map(function (c) { return c.id; });
        /* 别的篇目勾过的先留着：关掉这个篇目再打开，勾选还在，不白丢 */
        var rest = PICK.chs.filter(function (id) { return vis.indexOf(id) < 0; });
        if (v === 'none') PICK.chs = rest;
        else if (v === 'all') PICK.chs = rest.concat(vis);
        else PICK.chs = rest.concat(hotIds());
      }
      if (pk.dataset.pickType !== undefined) toggleIn(PICK.types, pk.dataset.pickType);
      if (pk.dataset.pickN !== undefined) PICK.n = +pk.dataset.pickN;
      save(K_PICK, PICK);
      renderBank();
      return;
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
    startToday: startToday, freeRun: freeRun, customRun: customRun,
    scopePool: scopePool, chLearned: chLearned, itemAllowed: itemAllowed,
    itemInScope: itemInScope, bookChs: bookChs, hotIds: hotIds, snippet: snippet,
    TEXT: function () { return TEXT; }, PICK: function () { return PICK; },
    resetSess: function () { sess = null; }
  };

})();
