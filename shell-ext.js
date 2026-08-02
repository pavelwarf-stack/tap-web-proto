/* ===========================================================================
   hub analytics — телеметрия тап-трейдинга (клиент).

   ПРИНЦИП: файл автономный. Он НЕ требует ни одной правки в shell.js / game.js —
   события снимаются пассивно:
     1) перехват записи в localStorage 'hub.intents'  → все logIntent() хаба;
     2) слушатель window 'message'                    → мост игра→шелл (hub:roundEnd и др.);
     3) MutationObserver на #gameframe / .screen / #sheetlayer → раунды, экраны, шиты;
     4) жизненный цикл страницы                       → старт/конец сессии, пинги.
   Значит билд-сессия может переписывать вёрстку и логику как угодно — телеметрия
   не ломается и ничего не конфликтит. Новый logIntent-тег, которого нет в карте
   ниже, НЕ теряется: уезжает событием 'intent' с исходным тегом.

   ДВА СТОКА (решение владельца 02.08): свой сборщик на VPS = источник истины,
   Supabase = аварийный. Событие уходит в ОБА; из очереди удаляется, когда
   подтвердил ХОТЯ БЫ ОДИН. Легли оба — лежит в localStorage и досылается позже.
   Дедуп на чтении — по event_id (uuid v4 генерится ЗДЕСЬ, на клиенте).

   Контракт событий и схема — ../EVENTS.md. Ничего не деплоить без слова владельца.
   =========================================================================== */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ конфиг
     Пустой адрес = сток выключен. Можно переопределить, объявив
     window.HUB_ANALYTICS_CONFIG ДО подключения этого файла. */
  var CFG = {
    vps: 'https://hub-195-123-208-223.sslip.io:8443/e',  // 'https://<поддомен>/e'  — свой сборщик (истина)
    supabaseUrl: 'https://jcqgyylmjcfjypebdwkl.supabase.co',  // 'https://<проект>.supabase.co'
    supabaseKey: 'sb_publishable_EU2nk83dsDnEvJkUY1q5dw_ikTXgoVH',  // anon-ключ (политика insert-only, читать им нельзя)
    appVer: 'hub-proto',
    batchMax: 20,       // событий в одной посылке
    flushMs: 4000,      // пауза перед отправкой накопленного
    pingMs: 60000,      // пинг «сессия жива» (даёт время игры без чистого конца)
    queueCap: 1000,     // потолок очереди; переполнение — режем СТАРЫЕ
    debug: false
  };
  try { for (var k in (window.HUB_ANALYTICS_CONFIG || {})) CFG[k] = window.HUB_ANALYTICS_CONFIG[k]; } catch (e) {}

  var QKEY = 'hub.aq';        // очередь неотправленного
  var AKEY = 'hub.anon';      // анонимный id устройства (живёт между сессиями)
  var OFFKEY = 'hub.aq.off';  // рубильник (выключен = не собираем)

  /* --------------------------------------------------------------- рубильник */
  var qs;
  try { qs = new URLSearchParams(location.search); } catch (e) { qs = { get: function () { return null; } }; }
  if (qs.get('noanalytics') === '1') { try { localStorage.setItem(OFFKEY, '1'); } catch (e) {} }
  if (qs.get('noanalytics') === '0') { try { localStorage.removeItem(OFFKEY); } catch (e) {} }
  try { if (localStorage.getItem(OFFKEY)) return; } catch (e) {}
  if (qs.get('dbg') === 'analytics') CFG.debug = true;

  function dbg() { if (CFG.debug && window.console) console.log.apply(console, ['[a]'].concat([].slice.call(arguments))); }

  /* -------------------------------------------------------------------- id-ы */
  function uuid() {
    try { if (crypto && crypto.randomUUID) return crypto.randomUUID(); } catch (e) {}
    try {
      var b = new Uint8Array(16); crypto.getRandomValues(b);
      b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
      var h = []; for (var i = 0; i < 16; i++) h.push((b[i] + 0x100).toString(16).slice(1));
      return h.slice(0, 4).join('') + '-' + h.slice(4, 6).join('') + '-' + h.slice(6, 8).join('') +
             '-' + h.slice(8, 10).join('') + '-' + h.slice(10).join('');
    } catch (e) {}
    // последний фолбэк (крипто недоступно): времени+случайности хватает, чтобы не склеиться
    return 'f' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2, 10) +
           '-' + Math.random().toString(16).slice(2, 10);
  }

  var anonId;
  try {
    anonId = localStorage.getItem(AKEY);
    if (!anonId) { anonId = uuid(); localStorage.setItem(AKEY, anonId); }
  } catch (e) { anonId = uuid(); }
  var isNewUser = false;
  try { isNewUser = !localStorage.getItem('hub.state'); } catch (e) {}

  var sessionId = uuid();
  var seq = 0;
  var bootTs = Date.now();
  var lastEvent = '';

  /* Время НА ЭКРАНЕ, а не по часам: вкладку свернули — секунды не капают.
     Без этого «средняя сессия» врёт вверх у всех, кто отвлёкся на звонок. */
  var activeMs = 0;
  var fgSince = (document.visibilityState === 'hidden') ? 0 : Date.now();
  function activeNow() { return activeMs + (fgSince ? Date.now() - fgSince : 0); }

  function urlSkin() { return qs.get('skin') || ''; }
  function curSkin() {
    try { if (typeof SKIN !== 'undefined' && SKIN) return String(SKIN); } catch (e) {}
    return urlSkin() || 'paper';
  }

  /* ------------------------------------------------------------------ очередь */
  var q = [];
  try { q = JSON.parse(localStorage.getItem(QKEY) || '[]') || []; } catch (e) { q = []; }
  if (!Array.isArray(q)) q = [];
  var persistTimer = null;
  function persist() {
    if (persistTimer) return;
    persistTimer = setTimeout(function () {
      persistTimer = null;
      try { localStorage.setItem(QKEY, JSON.stringify(q)); }
      catch (e) { q = q.slice(-Math.floor(CFG.queueCap / 2)); try { localStorage.setItem(QKEY, JSON.stringify(q)); } catch (e2) {} }
    }, 250);
  }

  var flushTimer = null;
  function track(event, detail) {
    var ev = {
      event_id: uuid(),
      ts: Date.now(),
      anon_id: anonId,
      session_id: sessionId,
      seq: ++seq,
      skin: curSkin(),
      event: String(event),
      detail: detail && Object.keys(detail).length ? clampDetail(detail) : null,
      app_ver: CFG.appVer
    };
    lastEvent = ev.event;
    q.push(ev);
    if (q.length > CFG.queueCap) q = q.slice(-CFG.queueCap);
    persist();
    dbg(ev.event, ev.detail || '');
    if (q.length >= CFG.batchMax) flush();
    else if (!flushTimer) flushTimer = setTimeout(function () { flushTimer = null; flush(); }, CFG.flushMs);
    return ev;
  }

  /* ---------------------------------------------------------------- вехи
     Именованные точки воронки: «открыл лендинг» → «начал онбординг» → «прошёл
     туториал раунда 1/2/3» → «сыграл платный раунд» → «увидел оффер» → «нажал
     оплату». Каждая веха взводится РОВНО ОДИН РАЗ на устройство и запоминается,
     поэтому воронка считается тривиально: `count(distinct anon_id)` по имени вехи,
     без вывода состояния из последовательности сырых событий. */
  var MSKEY = 'hub.ms';
  var msDone = {};
  try { msDone = JSON.parse(localStorage.getItem(MSKEY) || '{}') || {}; } catch (e) { msDone = {}; }

  function milestone(name, detail) {
    if (msDone[name]) return false;
    msDone[name] = Date.now();
    try { localStorage.setItem(MSKEY, JSON.stringify(msDone)); } catch (e) {}
    var d = detail || {};
    d.name = name;
    d.since_first_ms = Date.now() - (msDone.landing || bootTs);  // сколько шёл до вехи
    track('milestone', d);
    return true;
  }

  // detail — ДАННЫЕ (в т.ч. пришедшие из iframe игры): режем размер, ничего не исполняем
  function clampDetail(d) {
    var out = {}, n = 0;
    for (var key in d) {
      if (!Object.prototype.hasOwnProperty.call(d, key) || n++ >= 20) continue;
      var v = d[key];
      if (v === null || v === undefined || v === '') continue;
      if (typeof v === 'string') v = v.slice(0, 200);
      else if (typeof v === 'number') { if (!isFinite(v)) continue; }
      else if (typeof v !== 'boolean') { try { v = JSON.stringify(v).slice(0, 200); } catch (e) { continue; } }
      out[String(key).slice(0, 40)] = v;
    }
    return Object.keys(out).length ? out : null;
  }

  /* ------------------------------------------------------------------ отправка */
  var sending = false;

  var HAS_FETCH = (typeof fetch === 'function');

  function sendVps(batch, beacon) {
    if (!CFG.vps) return Promise.resolve(false);
    var body = JSON.stringify({ batch: batch });
    if ((beacon || !HAS_FETCH) && navigator.sendBeacon) {
      // text/plain = простой запрос, без preflight (сборщик всё равно отдаёт CORS)
      try { return Promise.resolve(navigator.sendBeacon(CFG.vps, new Blob([body], { type: 'text/plain;charset=UTF-8' }))); }
      catch (e) { return Promise.resolve(false); }
    }
    if (!HAS_FETCH) return Promise.resolve(false);
    try {
      return fetch(CFG.vps, {
        method: 'POST', body: body, keepalive: true, mode: 'cors', credentials: 'omit',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
      }).then(function (r) { return r.ok; }).catch(function () { return false; });
    } catch (e) { return Promise.resolve(false); }
  }

  function sendSupabase(batch) {
    if (!CFG.supabaseUrl || !CFG.supabaseKey || !HAS_FETCH) return Promise.resolve(false);
    // Простой INSERT, без ?on_conflict: upsert PostgREST потребовал бы дать анониму
    // право UPDATE, а ключ лежит открытым в коде страницы. Дубли гасит триггер в базе
    // (schema.sql), а 409 на гонке = событие уже там, считаем доставленным.
    // sendBeacon не умеет заголовки → всегда fetch (keepalive доживает выгрузку страницы)
    return fetch(CFG.supabaseUrl.replace(/\/+$/, '') + '/rest/v1/events', {
      method: 'POST', keepalive: true, mode: 'cors', credentials: 'omit',
      headers: {
        'Content-Type': 'application/json',
        'apikey': CFG.supabaseKey,
        'Authorization': 'Bearer ' + CFG.supabaseKey,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(batch.map(toRow))
    }).then(function (r) { return r.ok || r.status === 409; }).catch(function () { return false; });
  }

  // строка Postgres: detail отдельным json-полем, время — ISO (Supabase timestamptz)
  function toRow(e) {
    return {
      event_id: e.event_id, ts: new Date(e.ts).toISOString(), anon_id: e.anon_id,
      session_id: e.session_id, seq: e.seq, skin: e.skin, event: e.event,
      detail: e.detail, app_ver: e.app_ver
    };
  }

  function flush(beacon) {
    if (sending || !q.length) return;
    if (!CFG.vps && !CFG.supabaseUrl) return; // стоков нет — копим, отправим когда появятся
    var batch = q.slice(0, CFG.batchMax);
    var ids = {}; batch.forEach(function (e) { ids[e.event_id] = 1; });
    sending = true;
    Promise.all([sendVps(batch, beacon), sendSupabase(batch)]).then(function (res) {
      sending = false;
      var acked = res[0] === true || res[1] === true;
      dbg('flush', batch.length, 'vps=' + res[0], 'supa=' + res[1]);
      if (!acked) return;                       // не дошло — лежит дальше, досылаем позже
      q = q.filter(function (e) { return !ids[e.event_id]; });
      persist();
      if (q.length) setTimeout(function () { flush(beacon); }, 50); // хвост очереди
    }).catch(function () { sending = false; });
  }

  /* ------------------------------------- 1. intent-лог хаба (перехват setItem) */
  var lastSig = null;
  try {
    var arr0 = JSON.parse(localStorage.getItem('hub.intents') || '[]') || [];
    lastSig = arr0.length ? JSON.stringify(arr0[arr0.length - 1]) : null;
  } catch (e) {}

  var _setItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (key, val) {
    var r = _setItem.apply(this, arguments);
    if (key === 'hub.intents') { try { onIntents(val); } catch (e) {} }
    return r;
  };

  // хаб режет лог до 500 записей (slice(-500)) — по длине новое не поймать,
  // поэтому ищем последнюю известную запись с конца и берём всё, что после неё
  function onIntents(raw) {
    var arr; try { arr = JSON.parse(raw || '[]') || []; } catch (e) { return; }
    if (!Array.isArray(arr) || !arr.length) return;
    var start = 0;
    if (lastSig !== null) {
      var found = -1;
      for (var i = arr.length - 1; i >= 0; i--) { if (JSON.stringify(arr[i]) === lastSig) { found = i; break; } }
      start = found >= 0 ? found + 1 : arr.length - 1; // не нашли — считаем новой только последнюю
    }
    for (var j = start; j < arr.length; j++) mapIntent(arr[j]);
    lastSig = JSON.stringify(arr[arr.length - 1]);
  }

  /* Карта тегов logIntent → события сетки. Тег, которого здесь нет, уезжает
     событием 'intent' — новые теги билд-сессии не теряются. */
  function mapIntent(it) {
    if (!it || typeof it.source !== 'string') return;
    var src = it.source, pack = it.pack || null;

    if (src.indexOf('peak-view:') === 0) {
      track('offer_view', { offer: 'peak', reason: src.slice(10) });
      return void milestone('offer_seen', { offer: 'peak' });
    }
    if (src === 'peak-later')            return void track('offer_dismiss', { offer: 'peak' });
    if (src.indexOf('peak-') === 0) {
      track('offer_click', { offer: 'peak', option: src.slice(5), pack: pack });
      return void milestone('offer_clicked', { offer: 'peak', option: src.slice(5) });
    }
    if (src.indexOf('skin-view:') === 0) return void track('skin_view', { skin: src.slice(10) });
    if (src.indexOf('skin-pick:') === 0) return void track('skin_pick', { skin: src.slice(10) });
    if (src === 'tut-step') {
      track('tutorial_step', { step: pack });
      // pack = 'rNsM' (раунд N, шаг M) либо 'partialsM' — веха на КАЖДЫЙ первый шаг
      milestone('tut_step_' + String(pack || 'x'), {});
      return;
    }
    if (src.indexOf('stub-pay:') === 0) {
      track('pay_start', { item: src.slice(9) });
      return void milestone('pay_pressed', { item: src.slice(9) });
    }
    if (src.indexOf('stub-redirect:') === 0) return void track('redirect_out', { to: src.slice(14) });
    if (src.indexOf('course-tier') === 0) {
      track('pack_click', { kind: 'course', item: src, pack: pack });
      return void milestone('buy_clicked', { kind: 'course', item: src });
    }

    var PACKISH = { 'shop-pack': 'shop', 'ooc-pack': 'out-of-chips', 'shop-offer-open': 'shop-offer',
                    'home-starter-open': 'home-starter', 'starter-pack': 'starter-sheet',
                    'offer-sheet': 'offer-sheet', 'referral-course': 'referral' };
    if (PACKISH[src]) {
      track('pack_click', { kind: PACKISH[src], item: src, pack: pack });
      return void milestone('buy_clicked', { kind: PACKISH[src], item: src, pack: pack });
    }

    track('intent', { source: src, pack: pack });
  }

  /* ------------------------------------------- 2. мост игра→шелл (postMessage) */
  var roundStartedAt = 0, roundGame = '', roundNo = 0, roundEnded = true;

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object' || typeof d.type !== 'string' || d.type.indexOf('hub:') !== 0) return;
    // источник — только фрейм игры (чужие окна игнорируем, как это делает сам шелл)
    try { var fr = document.getElementById('gameframe'); if (fr && e.source !== fr.contentWindow) return; } catch (err) { return; }

    if (d.type === 'hub:roundEnd') {
      var ob = num(d.obRound);
      endRound('finish', {
        earned: num(d.earned), sim: !!d.sim, stage: num(d.stage),
        staged_up: !!d.stagedUp, ob_round: ob, peak: !!d.peak,
        // аддитивные поля игры (30.07): глубина раунда, а не только итог
        trades: num(d.trades), wins: num(d.wins), liqs: num(d.liqs),
        best_pnl: num(d.bestTradePnl)
      });
      // вехи онбординга: номер раунда даёт САМА игра (1..3, 0 = не онбординг).
      // Начальные вехи добираем задним числом: раунд мог стартовать до загрузки
      // телеметрии или из ветки, где признака tut в адресе нет — иначе в воронке
      // «доиграл» окажется больше, чем «начал», и она перестанет читаться.
      if (ob >= 1) {
        milestone('onboarding_start', { backfill: true });
        milestone('tut_round_' + ob + '_done', { trades: num(d.trades), liqs: num(d.liqs) });
        if (ob >= OB_ROUNDS) milestone('onboarding_done', {});
      } else if (!d.sim) {
        milestone('real_round_start', { backfill: true });
        milestone('real_round_done', { earned: num(d.earned), trades: num(d.trades),
                                       wins: num(d.wins), liqs: num(d.liqs) });
      }
    } else if (d.type === 'hub:tutEvent') {
      track('tutorial_event', { ev: String(d.ev || '').slice(0, 60), game: String(d.game || '') });
    } else if (d.type === 'hub:feeRefund') {
      track('fee_refund', { game: String(d.game || '') });
    } else if (d.type === 'hub:exit') {
      // выход из игры: если раунда конца не было — это отвал внутри раунда
      endRound('exit', {});
    }
  }, true);

  function num(v) { v = +v; return isFinite(v) ? v : 0; }

  var OB_ROUNDS = 3;   // столько симуляционных раундов в онбординге (shell.js)

  function startRound(game, query) {
    if (!roundEnded) endRound('replaced', {});
    roundGame = game; roundStartedAt = Date.now(); roundEnded = false; roundNo++;
    var tut = query.indexOf('tut=1') >= 0;
    track('round_start', { game: game, round_no: roundNo, tut: tut });
    milestone('first_round_start', { game: game, tut: tut });
    if (tut) milestone('onboarding_start', { game: game });
    else milestone('real_round_start', { game: game });
  }
  function endRound(how, extra) {
    if (roundEnded) return;
    roundEnded = true;
    var det = { game: roundGame, round_no: roundNo, how: how,
                duration_ms: roundStartedAt ? Date.now() - roundStartedAt : 0 };
    for (var key in extra) det[key] = extra[key];
    track('round_end', det);
  }

  /* --------------------------------- 3. наблюдатели DOM: раунды, экраны, шиты */
  function observeAll() {
    var frame = document.getElementById('gameframe');
    if (frame) {
      new MutationObserver(function () {
        var src = frame.getAttribute('src') || '';
        var m = src.match(/games\/([^/]+)\//);
        if (m) startRound(m[1], src);
        else if (!roundEnded) endRound('close', {}); // src → about:blank без roundEnd/exit
      }).observe(frame, { attributes: true, attributeFilter: ['src'] });
    }

    // экраны: .screen получает класс active
    var screens = document.querySelectorAll('.screen');
    if (screens.length) {
      var scrObs = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var el = muts[i].target;
          if (el.classList && el.classList.contains('active') && el.id !== lastScreen) {
            lastScreen = el.id;
            track('screen_view', { screen: el.id });
            milestone('screen_' + el.id, {});   // первый визит на КАЖДЫЙ экран = веха
          }
        }
      });
      for (var s = 0; s < screens.length; s++) scrObs.observe(screens[s], { attributes: true, attributeFilter: ['class'] });
      var act = document.querySelector('.screen.active');
      if (act) {
        lastScreen = act.id;
        track('screen_view', { screen: act.id, first: true });
        milestone('screen_' + act.id, { first: true });   // стартовый экран — тоже веха
      }
    }

    // шиты: #sheetlayer .sheet снимает hidden
    var layer = document.getElementById('sheetlayer');
    if (layer) {
      new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var el = muts[i].target;
          if (el === layer) continue;
          if (el.classList && el.classList.contains('sheet') && !el.hidden && el.id !== lastSheet) {
            lastSheet = el.id;
            track('sheet_open', { sheet: el.id });
            milestone('sheet_' + el.id, {});    // первое открытие каждого шита (в т.ч. оплаты)
          }
        }
        if (layer.hidden) lastSheet = '';
      }).observe(layer, { attributes: true, attributeFilter: ['hidden'], subtree: true });
    }
  }
  var lastScreen = '', lastSheet = '';

  /* ------------------------------------------------- 4. жизненный цикл сессии */

  // откуда пришёл: полный набор меток закупки + клик-ид рекламных систем и sub-ид
  // трекера. ПЕРВОЕ касание запоминается навсегда — вернувшийся через день игрок
  // всё равно приписывается той закупке, которая его привела.
  var ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
                   'gclid', 'fbclid', 'ttclid', 'msclkid', 'twclid',
                   'subid', 'sub_id', 'sub1', 'sub2', 'sub3', 'sub4', 'sub5',
                   'click_id', 'clickid', 'cid', 'aff', 'src', 'ref'];
  var attr = {};
  for (var ai = 0; ai < ATTR_KEYS.length; ai++) {
    var av = qs.get(ATTR_KEYS[ai]);
    if (av) attr[ATTR_KEYS[ai]] = String(av).slice(0, 120);
  }
  var firstAttr = null;
  try {
    firstAttr = JSON.parse(localStorage.getItem('hub.attr') || 'null');
    if (!firstAttr && Object.keys(attr).length) {
      firstAttr = attr;
      localStorage.setItem('hub.attr', JSON.stringify(attr));
    }
  } catch (e) {}

  var tzName = '';
  try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}

  track('session_start', {
    new_user: isNewUser,
    ref: (document.referrer || '').slice(0, 200),
    lang: (navigator.language || ''),
    tz: tzName,                                  // «America/New_York» — рабочая замена гео
    tz_off: -new Date().getTimezoneOffset(),
    scr: (screen.width || 0) + 'x' + (screen.height || 0),
    vp: (window.innerWidth || 0) + 'x' + (window.innerHeight || 0),
    dpr: window.devicePixelRatio || 1,
    touch: ('ontouchstart' in window) || (navigator.maxTouchPoints > 0),
    ua: (navigator.userAgent || '').slice(0, 200),
    url_skin: urlSkin()
  });
  if (Object.keys(attr).length || firstAttr) {
    track('attribution', { now: JSON.stringify(attr), first: JSON.stringify(firstAttr || attr) });
  }
  milestone('landing', { skin: curSkin(), tz: tzName });

  // скорость загрузки: на закупленном трафике медленный старт — первая причина отвала
  function reportPerf() {
    try {
      var n = (performance.getEntriesByType && performance.getEntriesByType('navigation')[0]) || null;
      if (n) {
        track('perf', { ttfb: Math.round(n.responseStart), dcl: Math.round(n.domContentLoadedEventEnd),
                        load: Math.round(n.loadEventEnd || n.duration), type: String(n.type || '') });
      } else if (performance.timing) {
        var t = performance.timing, o = t.navigationStart;
        track('perf', { ttfb: t.responseStart - o, dcl: t.domContentLoadedEventEnd - o,
                        load: t.loadEventEnd - o });
      }
    } catch (e) {}
  }
  if (document.readyState === 'complete') setTimeout(reportPerf, 0);
  else window.addEventListener('load', function () { setTimeout(reportPerf, 300); });

  setInterval(function () {
    if (document.visibilityState === 'hidden') return;
    track('ping', { alive_ms: Date.now() - bootTs, active_ms: activeNow(), in_round: !roundEnded });
  }, CFG.pingMs);

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') {
      if (fgSince) { activeMs += Date.now() - fgSince; fgSince = 0; }
      track('bg', { alive_ms: Date.now() - bootTs, active_ms: activeMs });
      flush();
    } else {
      fgSince = Date.now();
      track('fg', { alive_ms: Date.now() - bootTs, active_ms: activeMs });
    }
  });

  // конец сессии = маркер отвала: последний экран/шит и сколько прожил
  var ended = false;
  function endSession(how) {
    if (ended) return;
    ended = true;
    if (!roundEnded) endRound('pagehide', {});
    track('session_end', { alive_ms: Date.now() - bootTs, active_ms: activeNow(),
                           last_event: lastEvent, last_screen: lastScreen,
                           last_sheet: lastSheet, events: seq, how: how });
    flush(true);
  }
  window.addEventListener('pagehide', function () { endSession('pagehide'); });
  // Safari на iOS часто не даёт pagehide при свайпе домой — страхуемся скрытием вкладки
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') setTimeout(function () {
      if (document.visibilityState === 'hidden') flush(true);
    }, 0);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', observeAll);
  else observeAll();

  flush(); // хвост прошлой сессии, если он лежал в очереди

  window.hubAnalytics = { track: track, flush: flush, queue: function () { return q.slice(); },
                          ids: function () { return { anon: anonId, session: sessionId }; } };
})();
