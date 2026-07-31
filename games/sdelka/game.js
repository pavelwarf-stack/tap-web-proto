'use strict';
/* «Сделка» (вход/выход) — играбельный прототип по мокапам sdelka-mech2.
   Рынок — в темпе «Лонг/Шорт»: игровая цена = собственная симуляция (режимы
   тренд/болтанка, шаг 8 раз/сек) + усиленные (×GAIN) движения живого BTC из
   WebSocket btcusdt@trade (сид через Binance REST); оффлайн — генератор в
   полную силу, без визуальной разницы. Свечи фиксированного темпа 1.1с.
   Тап = вход всем балансом в лонг, тап = выход. PnL со скрытым фикс-плечом,
   −50% = ликвидация = минус сердце; 3 ликвидации = конец раунда. Раунд 60 сек. */

// ============================== CONFIG ==============================
const CFG = {
  ROUND_SEC: 60,
  START_BAL: 1000,
  LEV: 4,               // фикс-плечо: ликвидация −50% PnL = −12.5% цены
  LIQ_PNL: -50,
  MELT_MIN_PEAK: 12,
  MELT_DROP: 8,
  HEARTS: 3,
  // рынок в темпе «Лонг/Шорт» (approved-эталон)
  CANDLE_DUR: 1.1,      // сек на свечу (геймовый темп)
  VISIBLE: 13,          // свечей на экране
  GAIN: 30,             // усиление реальных BTC-движений до геймового масштаба
  SIM_TICK: 0.125,      // рынок шагает 8 раз/сек (без дрожи 60Гц)
  VIS_EASE: 0.13,       // тау глайда визуальной цены, сек
  TXT_EVERY: 0.2,       // цифры обновляются 5 раз/сек
};

const NICKS = [
  ['Alex', 5800], ['Tony Scorpos', 5400], ['Fill Simpany', 4990],
  ['CandleSam', 3100], ['LunaLong', 2050],
];

// ============================== UTILS ==============================
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// монеты/числа: «63 370» (пробел-тысячи), БЕЗ знака $ — «денежная» лексика в UI под вопросом; дроби только у небольших значений
function fmtCoins(v, sign = false) {
  const a = Math.abs(v);
  const s = v < 0 ? '−' : (sign ? '+' : '');
  const num = a < 1000 && Math.abs(a - Math.round(a)) > 0.005
    ? a.toFixed(2)
    : Math.round(a).toLocaleString('en-US');
  return s + num;
}
// ось цен в стиле мокапа: 63.420 (точка-тысячи)
const fmtAxis = v => Math.round(v).toLocaleString('en-US');
function fmtPct(p, sign = true) {
  const a = Math.abs(p);
  const d = a < 10 ? 2 : a < 100 ? 1 : 0;
  return (p < 0 ? '−' : (sign ? '+' : '')) + a.toFixed(d) + '%';
}
const fmtTimer = s => { const t = Math.max(0, Math.ceil(s)); return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0'); };

// ============================== SOUND ==============================
const Sound = {
  ctx: null, on: true,
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  },
  tone(freq, dur, { type = 'sine', gain = 0.12, when = 0, slide = 0 } = {}) {
    if (!this.on || !this.ctx) return;
    const t0 = this.ctx.currentTime + when;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t0 + dur);
    g.gain.setValueAtTime(gain, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.ctx.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  },
  noise(dur, gain = 0.25) {
    if (!this.on || !this.ctx) return;
    const n = this.ctx.sampleRate * dur;
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource(); src.buffer = buf;
    const g = this.ctx.createGain(); g.gain.value = gain;
    src.connect(g).connect(this.ctx.destination); src.start();
  },
  enter()  { this.tone(420, .09, {type:'square', gain:.08}); this.tone(640, .12, {type:'square', gain:.08, when:.06}); },
  exitWin(){ [523,659,784,1047].forEach((f,i)=>this.tone(f,.14,{type:'triangle',gain:.12,when:i*.06})); },
  exitLoss(){ this.tone(360,.18,{type:'sawtooth',gain:.07,slide:-160}); this.tone(240,.22,{type:'sawtooth',gain:.07,when:.1,slide:-100}); },
  warn()   { this.tone(880,.07,{type:'square',gain:.05}); },
  count()  { this.tone(1200,.06,{type:'square',gain:.06}); },
  liq()    { this.noise(.6,.3); this.tone(110,.7,{type:'sawtooth',gain:.22,slide:-70}); },
  best()   { [659,784,988,1319,1568].forEach((f,i)=>this.tone(f,.18,{type:'triangle',gain:.13,when:i*.09})); },
};

// ============================== BINANCE FEED ==============================
const Feed = {
  ready: false, wsLive: false, lastPrice: null, lastAt: 0, pendingReal: null,
  ws: null, wsTries: 0,
  async init() {
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 5000);
      const r = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60', { signal: ctl.signal });
      clearTimeout(to);
      const k = await r.json();
      const closes = k.map(x => +x[4]).filter(x => x > 0);
      if (closes.length < 10) throw new Error('bad klines');
      this.lastPrice = closes[closes.length - 1];
      this.lastAt = performance.now();
      try { localStorage.setItem('sdelka_lastprice', String(this.lastPrice)); } catch (e) {}
      this.ready = true;
      this.openWs();
    } catch (e) { this.ready = false; }
  },
  openWs() {
    if (this.wsTries >= 5) return;
    this.wsTries++;
    try {
      this.ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');
      this.ws.onmessage = ev => {
        const p = +JSON.parse(ev.data).p;
        if (p > 0) {
          this.lastPrice = p; this.pendingReal = p;
          this.lastAt = performance.now(); this.wsLive = true;
          this.wsTries = 0;
        }
      };
      this.ws.onclose = () => { this.wsLive = false; setTimeout(() => this.openWs(), 2500); };
      this.ws.onerror = () => { try { this.ws.close(); } catch (e) {} };
    } catch (e) { this.wsLive = false; }
  },
  // «свежесть» по времени: REST-сид даёт грейс на подключение WS,
  // дальше lastAt обновляют живые сделки
  fresh() { return this.lastPrice != null && performance.now() - this.lastAt < 5000; },
};
Feed.init();

// ============================== PRICE ENGINE ==============================
// Порт рынка из «Лонг/Шорт» (approved): игровая цена — собственная симуляция,
// генератор режимов шагает SIM_TICK (8/сек), поверх — усиленные ×GAIN движения
// живого BTC (тики WS агрегируются между шагами). Визуальная цена vis —
// экспоненциальный глайд к целевой (VIS_EASE); свечи фикс-темпа CANDLE_DUR
// строятся по vis. Оффлайн — генератор в полную силу, картинка та же.
class PriceEngine {
  constructor(p0, live) {
    this.price = p0;     // «сырая» игровая цена (механика режимов)
    this.vis = p0;       // сглаженная цена — рендер и торговля
    this.live = live;
    this.simTime = 0;
    this.tickAcc = 0;
    this.startPrice = p0;
    this.regime = { drift: 0, sigma: 0.011, until: 0 };
    this.trendStreak = 0; this.lastDir = 0;
    this.lastReal = null;
    this.candles = [];   // {t0,o,h,l,c} по сглаженной цене
    this.hist = [];      // короткая история vis для демо-бота [{t,p}]
    this.nextRegime();
  }
  nextRegime() {
    // Деэксплойт (решение владельца 24.07): без анти-стрика «не 3 тренда подряд» и без
    // ощутимой возвратности к старту — «шорти дип, лонгуй отскок» больше не стратегия.
    // Остался лишь слабый перекос на КРАЙНИХ выносах (страховка кадра, не гарантия отскока).
    const rel = this.price / this.startPrice;
    let upW = 0.38, dnW = 0.38;
    if (rel > 1.6) { upW = 0.30; dnW = 0.46; }
    else if (rel < 0.45) { upW = 0.46; dnW = 0.30; }
    const r = Math.random();
    let dir = 0;
    if (r < upW) dir = 1; else if (r < upW + dnW) dir = -1;
    let dur, drift, sigma;
    if (dir === 0) { // болтанка переменной ширины
      dur = 0.9 + Math.random() * 3.1;
      drift = (Math.random() - 0.5) * 0.008;
      sigma = 0.010 + Math.random() * 0.008;
    } else {
      dur = 1.2 + Math.random() * 5.2; // случайная длительность тренда (продолжения возможны)
      drift = dir * (0.010 + Math.random() * 0.017);
      sigma = 0.008 + Math.random() * 0.005;
      const q = Math.random();
      if (q < 0.10) { dur = 0.7 + Math.random() * 0.7; drift *= 2.4; }          // импульс
      else if (q < 0.28) { dur = 0.5 + Math.random() * 0.9;                      // фейковый вынос:
        drift *= (Math.random() < 0.5 ? -1 : 1) * (1.4 + Math.random()); }       // рывок в любую сторону
    }
    this.regime = { drift, sigma, until: this.simTime + dur };
  }
  // шаг рынка: редкие крупные шаги вместо 60Гц-дрожи
  marketTick(dt) {
    if (this.simTime >= this.regime.until) this.nextRegime();
    let realDp = 0;
    const live = this.live && Feed.fresh();
    if (live && Feed.pendingReal) {
      if (this.lastReal) realDp = clamp(Math.log(Feed.pendingReal / this.lastReal) * CFG.GAIN, -0.02, 0.02);
      this.lastReal = Feed.pendingReal;
      Feed.pendingReal = null;
    }
    const genScale = live ? 0.7 : 1; // при живых данных генератор чуть тише
    const dp = this.regime.drift * dt * genScale +
               this.regime.sigma * genScale * Math.sqrt(dt) * gauss() + realDp;
    this.price = Math.max(1, this.price * Math.exp(dp));
  }
  step(dt) {
    if (this.live && !Feed.fresh()) { // связь пропала посреди раунда → тихо на генератор
      this.live = false;
      G.offline = true;
      $('offlineBadge').classList.remove('hidden');
    }
    this.simTime += dt;
    this.tickAcc += dt;
    while (this.tickAcc >= CFG.SIM_TICK) { this.tickAcc -= CFG.SIM_TICK; this.marketTick(CFG.SIM_TICK); }
    // визуальная цена плавно догоняет целевую (глайд вместо скачка на тик)
    this.vis += (this.price - this.vis) * (1 - Math.exp(-dt / CFG.VIS_EASE));
    // свечи геймового темпа по сглаженной цене
    let c = this.candles[this.candles.length - 1];
    if (!c || this.simTime - c.t0 >= CFG.CANDLE_DUR) {
      c = { t0: c ? c.t0 + CFG.CANDLE_DUR : this.simTime, o: this.vis, h: this.vis, l: this.vis, c: this.vis };
      this.candles.push(c);
      if (this.candles.length > CFG.VISIBLE + 4) this.candles.shift();
    }
    c.c = this.vis; if (this.vis > c.h) c.h = this.vis; if (this.vis < c.l) c.l = this.vis;
    // история для демо-бота (~3с)
    this.hist.push({ t: this.simTime, p: this.vis });
    while (this.hist.length && this.simTime - this.hist[0].t > 3) this.hist.shift();
  }
  prefill() { // предыстория: полный экран свечей до старта раунда
    for (let i = 0; i < (CFG.VISIBLE + 1) * CFG.CANDLE_DUR * 30; i++) this.step(1 / 30);
  }
}

// ============================== FX (конфетти) ==============================
const FX = {
  cv: null, cx: null, parts: [],
  init() { this.cv = $('fx'); this.cx = this.cv.getContext('2d'); this.resize(); },
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = 390 * dpr; this.cv.height = 844 * dpr;
    this.cx.setTransform(dpr, 0, 0, dpr, 0, 0);
  },
  burst(x, y, n, big = false) {
    const colors = ['#1fa05c', '#ef4136', '#f7a92c', '#4a63e7', '#46345e', '#ffd977'];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = (big ? 260 : 180) * (0.4 + Math.random());
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - (big ? 160 : 80),
        w: 5 + Math.random() * 6, h: 8 + Math.random() * 7,
        rot: Math.random() * Math.PI, vr: (Math.random() - .5) * 10,
        c: colors[(Math.random() * colors.length) | 0], life: 1.4 + Math.random() * .8,
      });
    }
  },
  rain() { for (let i = 0; i < 90; i++) setTimeout(() => this.burst(20 + Math.random() * 350, -10, 1, true), i * 18); },
  update(dt) {
    if (!this.parts.length) { this.cx.clearRect(0, 0, 390, 844); return; }
    this.cx.clearRect(0, 0, 390, 844);
    this.parts = this.parts.filter(p => (p.life -= dt) > 0);
    for (const p of this.parts) {
      p.vy += 520 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
      this.cx.save();
      this.cx.translate(p.x, p.y); this.cx.rotate(p.rot);
      this.cx.globalAlpha = clamp(p.life, 0, 1);
      this.cx.fillStyle = p.c;
      this.cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      this.cx.restore();
    }
  },
};

// ============================== GAME STATE ==============================
const G = {
  screen: 'start', paused: false, over: false,
  gameT: 0,
  bal: CFG.START_BAL, dispBal: CFG.START_BAL, seed: CFG.START_BAL,
  inPos: false, entryPrice: 0, entryT: 0, peakPnl: 0,
  hearts: CFG.HEARTS,
  trades: [],
  best: (() => { try { return Number(localStorage.getItem('sdelka_best3') || 0); } catch (e) { return 0; } })(),
  engine: null, lev: CFG.LEV, offline: false, startPrice: 0,
  dispPrice: 0,    // сглаженная цена (= engine.vis) — всё видимое и вся торговля по ней
  txtAcc: 9,       // троттлинг текстовых обновлений PnL/тикера
  axisTxt: '',     // подпись ценового чипа — обновляется тем же темпом
  lastFrame: 0, lastDt: 1 / 60, lastCountSec: 99, melting: false,
  yMin: 0, yMax: 1, yInit: false,
};

const chart = $('chart');
const ctx = chart.getContext('2d');
let chartW = 0, chartH = 0;
const RING_LEN = 182.2; // 2πr, r=29

function resizeAll() {
  const s = Math.min(window.innerWidth / 390, window.innerHeight / 844);
  $('stage').style.setProperty('--s', s);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = $('chartWrap').getBoundingClientRect();
  const st = $('stage').getBoundingClientRect();
  chartW = st.width > 0 ? r.width / (st.width / 390) : 390;
  chartH = st.height > 0 ? r.height / (st.height / 844) : 300;
  chart.width = Math.max(10, Math.round(chartW * dpr));
  chart.height = Math.max(10, Math.round(chartH * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  FX.resize();
}

// PnL считается по сглаженной цене — игрок фиксирует ровно то, что видит
function pnlNow() {
  if (!G.inPos) return 0;
  return (G.dispPrice / G.entryPrice - 1) * 100 * G.lev;
}

// ---------- screens ----------
function show(name) {
  G.screen = name;
  $('screen-start').classList.toggle('hidden', name !== 'start');
  $('screen-game').classList.toggle('hidden', name !== 'game');
  $('screen-result').classList.toggle('hidden', name !== 'result');
  resizeAll();
}

// hub integration: из хаба раунд играется всей котлетой кошелька (hub.balance),
// standalone — внутренний сид CFG.START_BAL. В хаб уходит дельта за раунд.
function hubStartBal() {
  if (window.parent === window) return null; // standalone
  try {
    const v = parseInt(localStorage.getItem('hub.balance'), 10);
    if (Number.isFinite(v)) return Math.max(0, v); // отрицательный кошелёк → 0
  } catch (e) {}
  return null;
}

function startRound() {
  const liveOk = Feed.ready && Feed.fresh();
  const seed = Feed.lastPrice || (() => { try { return Number(localStorage.getItem('sdelka_lastprice')); } catch (e) { return 0; } })() || 63370;
  G.lev = CFG.LEV; // фикс-плечо: динамика лайв/оффлайн одинакова по построению
  G.offline = !liveOk;
  $('offlineBadge').classList.toggle('hidden', liveOk);
  G.engine = new PriceEngine(seed, liveOk);
  G.engine.prefill();

  const hb = hubStartBal(); // свежий кошелёк хаба на старте каждого раунда
  G.seed = hb !== null ? hb : CFG.START_BAL;
  G.gameT = 0; G.bal = G.seed; G.dispBal = G.seed;
  G.inPos = false; G.trades = []; G.over = false; G.paused = false;
  G.hubReported = false;
  G.hearts = CFG.HEARTS; G.lastCountSec = 99; G.melting = false; G.yInit = false;
  G.startPrice = G.engine.vis;
  G.dispPrice = G.engine.vis;
  G.txtAcc = 9; G.axisTxt = '';

  document.querySelectorAll('#hearts .heart').forEach(h => h.classList.remove('lost', 'pop'));
  $('pnlBox').classList.add('hidden');
  $('tickerBox').classList.remove('hidden');
  $('liqOverlay').classList.add('hidden');
  $('meltWarn').classList.add('hidden');
  setActionBtn(false);
  show('game');
}

function setActionBtn(inPos) {
  const b = $('btnAction');
  b.classList.toggle('green', !inPos);
  b.classList.toggle('red', inPos);
  $('btnLabel').textContent = inPos ? 'Exit' : 'Enter';
  b.classList.remove('bounce'); void b.offsetWidth; b.classList.add('bounce');
}

// ---------- позиция ----------
/* комиссия за вход в позицию: душит микро-скальпинг (0.5% котлеты за сделку),
   2–3 сделки за раунд почти не чувствуются (решение владельца 24.07) */
const TRADE_FEE = 0.005;
function feeFloat(txt) {
  const d = document.createElement('div');
  d.textContent = txt;
  d.style.cssText = 'position:fixed;left:50%;top:26%;transform:translate(-50%,0);color:#e8b64e;' +
    'font:700 15px -apple-system,Arial;opacity:1;transition:all .9s ease-out;z-index:60;' +
    'pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,.45)';
  document.body.appendChild(d);
  requestAnimationFrame(() => { d.style.opacity = '0'; d.style.transform = 'translate(-50%,-30px)'; });
  setTimeout(() => d.remove(), 950);
}

function enterPos() {
  const fee = G.bal * TRADE_FEE;
  if (fee > 0) {
    G.bal = Math.max(0, G.bal - fee);
    feeFloat('fee −' + fmtCoins(Math.max(1, Math.round(fee))));
  }
  G.inPos = true;
  G.entryPrice = G.dispPrice;
  G.entryT = G.gameT;
  G.peakPnl = 0; G.melting = false;
  $('pnlBox').classList.remove('hidden');
  $('tickerBox').classList.add('hidden');
  $('entryPriceEl').textContent = fmtCoins(G.entryPrice);
  setActionBtn(true);
  Sound.enter();
}

function exitPos(auto = false) {
  const pnl = clamp(pnlNow(), CFG.LIQ_PNL, 99999);
  closeTrade(pnl, false, auto);
  if (pnl >= 0) Sound.exitWin(); else Sound.exitLoss();
  if (pnl >= 30) FX.burst(195, 380, 36);
  flash(false);
}

function closeTrade(pnl, liq, auto) {
  const before = G.bal;
  G.bal = Math.max(0, G.bal * (1 + pnl / 100));
  G.trades.push({
    pnl, usd: G.bal - before,
    dur: Math.max(1, Math.round((G.gameT - G.entryT) / 1000)),
    liq: !!liq, auto: !!auto,
  });
  G.inPos = false; G.melting = false;
  $('pnlBox').classList.add('hidden');
  $('tickerBox').classList.remove('hidden');
  $('meltWarn').classList.add('hidden');
  setActionBtn(false);
}

function flash(red) {
  const f = $('flash');
  f.classList.toggle('red', red);
  f.classList.remove('on'); void f.offsetWidth; f.classList.add('on');
}

// ---------- ликвидация / конец раунда ----------
function liquidate() {
  closeTrade(CFG.LIQ_PNL, true, false);
  G.hearts--;
  const hearts = document.querySelectorAll('#hearts .heart');
  const h = hearts[G.hearts];
  if (h) { h.classList.add('lost'); h.classList.remove('pop'); void h.offsetWidth; h.classList.add('pop'); }
  Sound.liq();
  flash(true);
  $('liqSub').textContent = G.hearts > 0
    ? `−50% · ${G.hearts === 2 ? 'two hearts' : 'one heart'} left`
    : '−50% · no hearts left';
  $('liqOverlay').classList.remove('hidden');
  const st = $('stage');
  st.classList.remove('shake'); void st.offsetWidth; st.classList.add('shake');
  if (G.hearts <= 0) {
    G.over = true;
    setTimeout(() => finishRound(), 1600);
  } else {
    setTimeout(() => $('liqOverlay').classList.add('hidden'), 1200);
  }
}

function endRound() {
  G.over = true;
  if (G.inPos) exitPos(true);
  setTimeout(() => finishRound(), 450);
}

// hub integration: report the round result to the parent shell (iframe only)
function reportToHub(earned) {
  if (window.parent === window) return; // standalone open — no-op
  try {
    window.parent.postMessage({ type: 'hub:roundEnd', game: 'sdelka', earned: Math.round(earned) }, '*');
  } catch (e) {}
}

function finishRound() {
  $('liqOverlay').classList.add('hidden');
  // сид на следующий оффлайн-запуск — последняя РЕАЛЬНАЯ цена (игровая ушла ×GAIN)
  if (Feed.lastPrice) localStorage.setItem('sdelka_lastprice', String(Feed.lastPrice));
  const profit = Math.round(G.bal - G.seed);
  if (!G.hubReported) { G.hubReported = true; reportToHub(profit); }
  const isBest = profit > G.best;
  if (isBest) { G.best = profit; localStorage.setItem('sdelka_best3', String(profit)); }

  $('resScore').textContent = fmtCoins(profit, true);
  $('resScore').style.color = profit < 0 ? 'var(--red)' : 'var(--ink)';
  $('resMult').textContent = '×' + (Math.max(0, G.bal) / (G.seed || 1)).toFixed(1) + ' from start';
  $('resBest').textContent = 'Best result: ' + fmtCoins(G.best, true);
  $('resBestBadge').classList.toggle('hidden', !isBest);
  $('tradesAll').textContent = `View all (${G.trades.length})`;

  // история сделок
  const tr = $('resTrades');
  tr.innerHTML = '';
  if (!G.trades.length) tr.innerHTML = '<div class="res-none">No trades — be bolder!</div>';
  G.trades.slice(-7).reverse().forEach(t => {
    const d = document.createElement('div');
    d.className = 'trade-row';
    d.innerHTML =
      `<div class="trade-ico">📈</div>` +
      `<div class="trade-main"><div class="trade-pair">BTC/USDT</div><div class="trade-dur">${t.dur}s${t.auto ? ' · auto' : ''}</div></div>` +
      (t.liq ? '<span class="liq-badge">LIQUIDATION</span>' : '') +
      `<div class="trade-pnl ${t.usd >= 0 ? 'win' : 'loss'}">${fmtCoins(Math.round(t.usd), true)}</div>`;
    tr.appendChild(d);
  });

  // лидерборд: топ-3 + You
  const lb = $('leaderboard');
  lb.innerHTML = '';
  const rows = NICKS.map(([n, s]) => ({ n, s, me: false }));
  rows.push({ n: 'You', s: profit, me: true });
  rows.sort((a, b) => b.s - a.s);
  const myIdx = rows.findIndex(r => r.me);
  let shown;
  if (myIdx <= 3) shown = rows.slice(0, 4).map((r, i) => ({ ...r, place: i + 1 }));
  else {
    shown = rows.slice(0, 3).map((r, i) => ({ ...r, place: i + 1 }));
    // псевдо-глобальный ранг для драматизма, как в мокапе
    const fakeRank = clamp(4 + Math.round((rows[2].s - profit) / 120), 4, 99);
    shown.push({ n: 'You', s: profit, me: true, place: fakeRank });
  }
  shown.forEach(r => {
    const d = document.createElement('div');
    d.className = 'lb-row' + (r.me ? ' me' : '');
    d.innerHTML = `<div class="lb-place">${r.place}</div><div class="lb-name">${r.n}</div>` +
      `<div class="lb-score">${fmtCoins(r.s, true)}</div>`;
    lb.appendChild(d);
  });

  show('result');
  if (isBest && profit > 0) { Sound.best(); FX.rain(); }
}

// ============================== CHART RENDER ==============================
const AXIS_W = 74; // зона оси цен справа

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * pow;
}

function drawChart() {
  const W = chartW, H = chartH;
  ctx.clearRect(0, 0, W, H);
  const e = G.engine;
  if (!e || !e.candles.length) return;
  const plotW = W - AXIS_W;
  const candles = e.candles;
  const slot = plotW / CFG.VISIBLE;
  const bodyW = slot * 0.66;
  const cur = candles[candles.length - 1];
  const progress = clamp((e.simTime - cur.t0) / CFG.CANDLE_DUR, 0, 1);
  const first = Math.max(0, candles.length - (CFG.VISIBLE + 1));

  // шкала Y (плавная): диапазон видимых свечей + вход
  let lo = Infinity, hi = -Infinity;
  for (let i = first; i < candles.length; i++) {
    if (candles[i].l < lo) lo = candles[i].l;
    if (candles[i].h > hi) hi = candles[i].h;
  }
  if (G.inPos) { lo = Math.min(lo, G.entryPrice); hi = Math.max(hi, G.entryPrice); }
  const pad = Math.max((hi - lo) * 0.22, e.price * 0.004);
  const tLo = lo - pad, tHi = hi + pad;
  if (!G.yInit) { G.yMin = tLo; G.yMax = tHi; G.yInit = true; }
  const kY = 1 - Math.exp(-6 * G.lastDt);
  G.yMin += (tLo - G.yMin) * kY;
  G.yMax += (tHi - G.yMax) * kY;

  const Y = p => H - ((p - G.yMin) / (G.yMax - G.yMin)) * H;
  const xOf = i => plotW - (candles.length - 1 - i + progress) * slot + slot * 0.5;

  const pnl = pnlNow();
  const posUp = pnl >= 0;

  // зона позиции: полоса от уровня входа до текущей цены (как в мокапе)
  if (G.inPos) {
    const eY = Y(G.entryPrice), cY = Y(e.vis);
    ctx.fillStyle = posUp ? 'rgba(31,160,92,0.20)' : 'rgba(239,65,54,0.20)';
    ctx.fillRect(0, Math.min(eY, cY), plotW, Math.max(2, Math.abs(cY - eY)));
  }

  // пунктирная сетка + ось цен
  const range = G.yMax - G.yMin;
  const step = Math.max(niceStep(range / 4.5), 1); // шаг ≥ $1 — без дублей на оси
  ctx.font = '800 17px ui-rounded, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  const firstLine = Math.ceil(G.yMin / step) * step;
  ctx.setLineDash([5, 6]);
  for (let p = firstLine; p < G.yMax; p += step) {
    const y = Y(p);
    ctx.strokeStyle = 'rgba(255,255,255,0.75)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(plotW, y); ctx.stroke();
    ctx.fillStyle = 'rgba(70,52,94,0.75)';
    ctx.fillText(fmtAxis(p), plotW + 10, y);
  }
  // вертикальные линии: едут вместе со свечами (стабильны по времени свечи)
  ctx.strokeStyle = 'rgba(255,255,255,0.55)';
  ctx.lineWidth = 1.5;
  for (let i = first; i < candles.length; i++) {
    if (Math.round(candles[i].t0 / CFG.CANDLE_DUR) % 4 !== 0) continue;
    const x = xOf(i);
    if (x < -4 || x > plotW) continue;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
  }
  ctx.setLineDash([]);

  // линия входа + линия ликвидации
  if (G.inPos) {
    const eY = Y(G.entryPrice);
    ctx.setLineDash([7, 6]);
    ctx.strokeStyle = 'rgba(70,52,94,0.6)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(0, eY); ctx.lineTo(plotW, eY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(70,52,94,0.85)';
    ctx.font = '800 12px ui-rounded, system-ui, sans-serif';
    ctx.fillText('entry', 10, eY - 9);

    const liqPrice = G.entryPrice * (1 + CFG.LIQ_PNL / 100 / G.lev);
    const lY = Y(liqPrice);
    if (lY < H + 60) {
      ctx.setLineDash([4, 5]);
      ctx.strokeStyle = 'rgba(239,65,54,0.65)';
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(0, lY); ctx.lineTo(plotW, lY); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = 'rgba(239,65,54,0.9)';
      ctx.font = '800 12px ui-rounded, system-ui, sans-serif';
      ctx.fillText('💥 liquidation', 10, lY - 9);
    }
    ctx.font = '800 17px ui-rounded, system-ui, sans-serif';
  }

  // свечи фиксированного геймового темпа
  for (let i = first; i < candles.length; i++) {
    const cd = candles[i];
    const x = xOf(i);
    if (x < -slot || x > plotW + slot) continue;
    const up = cd.c >= cd.o;
    const col = up ? '#1fa05c' : '#ef4136';
    ctx.fillStyle = col;
    // фитиль
    ctx.fillRect(x - 1.2, Y(cd.h), 2.4, Math.max(1, Y(cd.l) - Y(cd.h)));
    // тело
    const y1 = Y(Math.max(cd.o, cd.c)), y2 = Y(Math.min(cd.o, cd.c));
    const bh = Math.max(3, y2 - y1);
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath(); ctx.roundRect(x - bodyW / 2, y1, bodyW, bh, 3); ctx.fill();
    } else ctx.fillRect(x - bodyW / 2, y1, bodyW, bh);
  }

  // синий чип текущей цены на оси: позиция глайдит каждый кадр,
  // цифры внутри — раз в TXT_EVERY (без спиннера разрядов)
  const curY = clamp(Y(e.vis), 14, H - 14);
  const label = G.axisTxt || fmtAxis(e.vis);
  const tw = ctx.measureText(label).width;
  const chipX = plotW + 4, chipW = Math.max(tw + 16, AXIS_W - 6), chipH = 30;
  ctx.fillStyle = '#4a63e7';
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(chipX, curY - chipH / 2, chipW, chipH, 9);
  else ctx.rect(chipX, curY - chipH / 2, chipW, chipH);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.fillText(label, chipX + 8, curY + 1);
  // стрелка чипа к цене
  ctx.fillStyle = '#4a63e7';
  ctx.beginPath();
  ctx.moveTo(chipX + 1, curY - 6); ctx.lineTo(chipX - 7, curY); ctx.lineTo(chipX + 1, curY + 6);
  ctx.fill();
}

// ============================== HUD ==============================
function updateHUD(dt) {
  // плавный баланс (реализованный, как в мокапе)
  G.dispBal += (G.bal - G.dispBal) * Math.min(1, dt * 9);
  $('balTop').textContent = fmtCoins(Math.abs(G.dispBal - Math.round(G.dispBal)) < 0.005 ? Math.round(G.dispBal) : G.dispBal);

  // таймер-кольцо
  const left = Math.max(0, CFG.ROUND_SEC - G.gameT / 1000);
  const sec = Math.ceil(left);
  $('timerText').textContent = fmtTimer(left);
  $('ringArc').style.strokeDashoffset = (left / CFG.ROUND_SEC) * RING_LEN;
  const hot = left <= 10;
  $('timerText').classList.toggle('hot', hot);
  if (hot && sec !== G.lastCountSec && sec <= 5 && sec > 0) Sound.count();
  G.lastCountSec = sec;

  // тексты PnL/тикера — с читаемой частотой (~5/с), значения и так скользят плавно
  G.txtAcc += dt;
  const txtTick = G.txtAcc >= CFG.TXT_EVERY;
  if (txtTick) { G.txtAcc = 0; G.axisTxt = fmtAxis(G.dispPrice); }

  if (G.inPos) {
    const pnl = pnlNow();
    if (pnl > G.peakPnl) G.peakPnl = pnl;
    if (txtTick) {
      const usd = G.bal * pnl / 100;
      $('uPnlUsd').textContent = fmtCoins(usd, true);
      $('uPnlPct').textContent = fmtPct(pnl);
      $('curPriceEl').textContent = fmtCoins(G.dispPrice);
    }

    const drop = G.peakPnl - pnl;
    const meltNow = G.peakPnl >= CFG.MELT_MIN_PEAK && drop >= Math.max(CFG.MELT_DROP, G.peakPnl * 0.35) && pnl > -20;
    if (meltNow && !G.melting) Sound.warn();
    G.melting = meltNow;
    $('meltWarn').classList.toggle('hidden', !meltNow);
    const box = $('pnlBox');
    box.classList.toggle('neg', pnl < 0 && !meltNow);
    box.classList.toggle('melt', meltNow);
    // пульс числа PnL
    const mag = clamp(Math.abs(pnl) / 60, 0, 1);
    const beat = 1 + mag * 0.15 + 0.05 * mag * Math.sin(performance.now() / 110);
    $('uPnlUsd').style.transform = `scale(${beat})`;
    $('uPnlUsd').style.display = 'inline-block';
  } else if (txtTick) {
    $('tickerPrice').textContent = fmtCoins(G.dispPrice);
    const chg = (G.dispPrice / G.startPrice - 1) * 100;
    const el = $('tickerChg');
    el.textContent = fmtPct(chg);
    el.classList.toggle('up', chg >= 0);
    el.classList.toggle('down', chg < 0);
  }
}

// ============================== DEMO BOT (?demo=1 или ?auto) ==============================
const _qs = new URLSearchParams(location.search);
const DEMO = _qs.has('demo') || _qs.has('auto');
let demoCooldown = 0;
function demoBot(dt) {
  demoCooldown -= dt;
  if (demoCooldown > 0) return;
  const e = G.engine, h = e.hist;
  if (h.length < 10) return;
  // импульс за ~0.5с в леверидж-процентах — работает и в лайве, и в симе;
  // серия сглажена глайдом, поэтому пороги ниже «сырых»
  let j = h.length - 1;
  while (j > 0 && e.simTime - h[j].t < 0.5) j--;
  const mLev = (e.vis - h[j].p) / h[j].p * G.lev * 100;
  if (!G.inPos) {
    if (mLev > 2.2) { enterPos(); demoCooldown = 0.8; }
  } else {
    const pnl = pnlNow(), drop = G.peakPnl - pnl;
    if ((G.peakPnl > 10 && drop > G.peakPnl * 0.3) || (mLev < -1.4 && pnl > 5) || pnl < -16) {
      exitPos(); demoCooldown = 1.2;
    }
  }
}

// ============================== MAIN LOOP ==============================
let lastWinW = 0, lastWinH = 0, sizeCheck = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  if (!G.lastFrame) { G.lastFrame = ts; return; }
  let dt = (ts - G.lastFrame) / 1000;
  G.lastFrame = ts;
  dt = clamp(dt, 0, 0.05);
  G.lastDt = Math.max(dt, 0.001);

  if (++sizeCheck >= 30) {
    sizeCheck = 0;
    if (window.innerWidth !== lastWinW || window.innerHeight !== lastWinH) {
      lastWinW = window.innerWidth; lastWinH = window.innerHeight;
      resizeAll();
    }
  }

  FX.update(dt);

  if (G.screen !== 'game' || G.paused || G.over) {
    if (G.screen === 'game' && !G.over) drawChart();
    return;
  }

  G.gameT += dt * 1000;
  G.engine.step(dt); // рынок + глайд визуальной цены + свечи
  G.dispPrice = G.engine.vis;

  // ликвидация проверяется ДО бота/ввода — её нельзя «переиграть» выходом
  if (G.inPos && pnlNow() <= CFG.LIQ_PNL) { liquidate(); drawChart(); updateHUD(dt); return; }
  if (DEMO) demoBot(dt);
  if (G.gameT >= CFG.ROUND_SEC * 1000) { endRound(); return; }

  drawChart();
  updateHUD(dt);
}

// ============================== INPUT ==============================
function onAction() {
  Sound.ensure();
  if (G.screen !== 'game' || G.paused || G.over) return;
  if (!G.inPos) enterPos(); else exitPos();
}

function bind() {
  $('btnPlay').addEventListener('click', () => { Sound.ensure(); startRound(); });
  $('btnAgain').addEventListener('click', () => { Sound.ensure(); startRound(); });
  $('btnHome').addEventListener('click', () => show('start'));
  document.querySelector('#screen-game .action-zone').addEventListener('pointerdown', e => {
    e.preventDefault(); onAction();
  });
  window.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); onAction(); }
  });
  $('btnPause').addEventListener('click', () => {
    if (G.over) return;
    G.paused = true;
    $('pauseOverlay').classList.remove('hidden');
  });
  $('btnResume').addEventListener('click', () => {
    G.paused = false;
    $('pauseOverlay').classList.add('hidden');
  });
  $('btnExitRound').addEventListener('click', () => {
    G.paused = false;
    $('pauseOverlay').classList.add('hidden');
    endRound();
  });
  $('btnSound').addEventListener('click', () => {
    Sound.on = !Sound.on;
    $('btnSound').textContent = Sound.on ? '🔊 Sound: on' : '🔇 Sound: off';
  });
  /* «Exit to menu» в паузе — IIFE-сниппет оркестратора в конце файла (hubExitBtn) */
  window.addEventListener('resize', resizeAll);
}

// ============================== BOOT ==============================
window.__sdelka = { G, CFG, Feed }; // отладочный хук (headless-верификация)
FX.init();
bind();
show('start');
resizeAll();
requestAnimationFrame(frame);
if (DEMO) { // старт после готовности фида (или через 6с — оффлайн)
  const t0 = performance.now();
  const w = setInterval(() => {
    if ((Feed.ready && Feed.fresh()) || performance.now() - t0 > 6000) {
      clearInterval(w); startRound();
    }
  }, 200);
}

/* hub: выход в меню из паузы (только в iframe хаба; добавлено оркестратором 24.07) */
(function(){
  if (window.parent === window) return;
  function mount(){
    if (document.getElementById('hubExitBtn')) return;
    var anchor = document.getElementById('btnSound');
    if (!anchor) return;
    var b = document.createElement('button');
    b.id = 'hubExitBtn'; b.className = 'ghostbtn'; b.textContent = 'Exit to menu';
    b.addEventListener('click', function(){
      try { window.parent.postMessage({type:'hub:exit', game:'sdelka'}, '*'); } catch(e){}
    });
    anchor.insertAdjacentElement('afterend', b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
