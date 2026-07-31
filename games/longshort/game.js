'use strict';
/* «Лонг/Шорт» — tap-trading hub, прототип №3 (стиль по макетам longshort-mech3).
   Живой график BTC (Binance REST + WebSocket) с фолбэком на генератор.
   Вся котлета в обе стороны, без ликвидаций. Vanilla JS, 60fps rAF. */

// ===================== helpers =====================
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, k) => a + (b - a) * k;

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const fmtInt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const fmtAxis = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
function fmtPct(p, dec = 1) {
  const v = p * 100;
  return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(dec) + '%';
}
function fmtMult(m) {
  const d = m < 10 ? 1 : 0;
  return '×' + m.toFixed(d);
}

// ===================== constants =====================
const ROUND_TIME = 60;
const START_BALANCE = 1000;
const CANDLE_DUR = 1.1;      // сек на свечу (геймовый темп)
const VISIBLE = 13;          // свечей на экране
const BEST_KEY = 'tth-longshort-best-v2'; // v2: старт 1000 монет (старый рекорд в другом масштабе)
const GAIN = 30;             // усиление реальных BTC-движений до геймового масштаба
const SIM_TICK = 0.125;      // рынок шагает 8 раз/сек (та же дисперсия/сек, без дрожи 60Гц)
const VIS_EASE = 0.13;       // тау глайда визуальной цены, сек (~плавный догон за 300мс)
const TXT_EVERY = 0.2;       // цифры обновляются 5 раз/сек, не каждый кадр

const NICKS = ['CandleSam', 'LongJohn', 'QuietTrader', 'PumpChaser', 'AuntCandle',
  'BearTapper', 'BraveBull', 'WickWizard', 'ProfitPete', 'TrendUncle',
  'HodlHarry', 'ChartChad'];

// hub integration: из хаба раунд играется ВСЕЙ котлетой кошелька (hub.balance),
// standalone — внутренний сид START_BALANCE. В хаб уходит дельта за раунд.
function hubStartBal() {
  if (window.parent === window) return null; // standalone
  try {
    const v = parseInt(localStorage.getItem('hub.balance'), 10);
    if (Number.isFinite(v)) return Math.max(0, v); // отрицательный кошелёк → 0 (математика котлеты)
  } catch (e) {}
  return null;
}

// онбординг из хаба (?tut=1): раунд = TUT_TRADES ЗАКРЫТЫХ сделок или таймер 60с —
// что наступит раньше (аналог «5 прогнозов» прогноза; директива владельца 24.07)
const TUT = new URLSearchParams(location.search).has('tut');
const TUT_TRADES = 5;

// ===================== state =====================
let state = 'start'; // start | countdown | play | paused | result
let price, simTime, balance, roundLeft, pos, trades, bust;
let seedBal = START_BALANCE; // котлета на старте раунда (хаб-кошелёк или внутренний сид)
let visPrice = 0;    // визуальная (сглаженная) цена — ТОЛЬКО рендер, механика на price
let tickAcc = 0;     // аккумулятор до следующего шага рынка
const ui = { acc: 9, pnl: 0, badge: '' }; // троттлинг цифр + плавный счётчик PnL
let regime = { drift: 0, sigma: 0.011, until: 0 };
let candles = [];            // {t0,o,h,l,c}
let roundStartPrice = 100;
let yMin = 0, yMax = 1, yInit = false;
let cdT = 0, cdShown = -1;
let inputLock = 0;
let lastTimerText = '';
let lives = 3;

// ===================== real BTC data =====================
const REAL = { anchor: null, lastReal: null, pendingReal: null, lastMsg: 0, wsTried: false };

async function seedReal() {
  try {
    const ctl = new AbortController();
    setTimeout(() => ctl.abort(), 5000);
    const r = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60',
      { signal: ctl.signal });
    const k = await r.json();
    const lastClose = +k[k.length - 1][4];
    if (lastClose > 0) {
      REAL.anchor = lastClose;
      startWS();
    }
  } catch (e) { /* оффлайн-фолбэк: генератор */ }
  updateNetBadge();
}
function startWS() {
  try {
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');
    ws.onmessage = e => {
      try {
        const p = +JSON.parse(e.data).p;
        if (p > 0) { REAL.pendingReal = p; REAL.lastMsg = performance.now(); }
      } catch (err) {}
    };
    ws.onclose = () => setTimeout(startWS, 4000);
    ws.onerror = () => { try { ws.close(); } catch (err) {} };
  } catch (e) {}
}
// lastMsg=0 (ни одного тика) НЕ считается живым фидом: без этого первые 3.5с жизни
// страницы оффлайн-клиент считал себя live и прятал offline-бейдж (найдено финишером 24.07)
const isLive = () => REAL.lastMsg > 0 && performance.now() - REAL.lastMsg < 3500;
function updateNetBadge() {
  $('net-badge').classList.toggle('hidden', isLive());
}

// ===================== DOM =====================
const el = {
  screens: { start: $('screen-start'), game: $('screen-game'), result: $('screen-result') },
  hudBalance: $('hud-balance'), hudPreview: $('hud-preview'), hudTimer: $('hud-timer'),
  balanceStrip: document.querySelector('.balance-strip'),
  ringArc: $('ring-arc'), hearts: $('hearts'),
  tradesLog: $('trades-log'),
  cardIdle: $('card-idle'), cardPos: $('card-pos'),
  cardPrice: $('card-price'), cardPct: $('card-pct'),
  dirPill: $('dir-pill'), pnlValue: $('pnl-value'),
  entryPrice: $('entry-price'), curPrice: $('cur-price'),
  meltWarn: $('melt-warn'), hintIdle: $('hint-idle'),
  entryButtons: $('entry-buttons'), btnExit: $('btn-exit'), exitPreview: $('exit-preview'),
  countdown: $('countdown'), pauseOverlay: $('pause-overlay'),
  resultTitle: $('result-title'), resultBalance: $('result-balance'),
  resultMult: $('result-mult'), resultRecord: $('result-record'), resultBest: $('result-best'),
  tradesList: $('trades-list'), tradesCount: $('trades-count'), leaderboard: $('leaderboard'),
  startBest: $('start-best'), flash: $('flash'),
};
const RING_C = 2 * Math.PI * 36; // == stroke-dasharray в css (226.2)

// ===================== stage scaling =====================
const stage = $('stage');
let stageScale = 1;
function fitStage() {
  stageScale = Math.min(window.innerWidth / 390, window.innerHeight / 844);
  stage.style.transform = `scale(${stageScale})`;
  resizeCanvases();
}
window.addEventListener('resize', fitStage);

// ===================== canvases =====================
const chart = $('chart'), cx = chart.getContext('2d');
const fx = $('fx'), fcx = fx.getContext('2d');
let chW = 0, chH = 0, RES = 1;

function resizeCanvases() {
  RES = clamp((window.devicePixelRatio || 1) * stageScale, 1, 3);
  chW = chart.clientWidth; chH = chart.clientHeight;
  if (chW > 0) {
    chart.width = Math.round(chW * RES); chart.height = Math.round(chH * RES);
    cx.setTransform(RES, 0, 0, RES, 0, 0);
  }
  fx.width = Math.round(390 * RES); fx.height = Math.round(844 * RES);
  fcx.setTransform(RES, 0, 0, RES, 0, 0);
}

// ===================== sound (WebAudio-блипы) =====================
let AC = null;
function ac() {
  if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} }
  if (AC && AC.state === 'suspended') AC.resume();
  return AC;
}
function tone(freq, dur, type, vol, when = 0, slide = 0) {
  const a = ac(); if (!a) return;
  const t0 = a.currentTime + when;
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t0);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(t0); o.stop(t0 + dur + 0.05);
}
const snd = {
  long()  { tone(340, 0.14, 'triangle', 0.25, 0, 220); },
  short() { tone(340, 0.14, 'triangle', 0.25, 0, -160); },
  win(big) {
    tone(520, 0.1, 'triangle', 0.22); tone(660, 0.1, 'triangle', 0.22, 0.07);
    tone(880, 0.16, 'triangle', 0.24, 0.14);
    if (big) tone(1180, 0.22, 'triangle', 0.22, 0.22);
  },
  loss()  { tone(220, 0.22, 'sawtooth', 0.12, 0, -120); },
  tick()  { tone(900, 0.05, 'square', 0.06); },
  count() { tone(600, 0.09, 'triangle', 0.2); },
  go()    { tone(600, 0.16, 'triangle', 0.26, 0, 500); },
  bust()  { tone(300, 0.5, 'sawtooth', 0.16, 0, -240); },
};

// ===================== market sim =====================
// Деэксплойт (решение владельца 24.07): без анти-стрика «не 3 тренда подряд» и без
// ощутимой возвратности к старту — «шорти дип, лонгуй отскок» больше не стратегия.
// Остался лишь слабый перекос на КРАЙНИХ выносах (страховка кадра, не гарантия отскока).
function nextRegime() {
  const rel = price / roundStartPrice;
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
  regime = { drift, sigma, until: simTime + dur };
}

// шаг рынка: редкие крупные шаги вместо 60Гц-дрожи (дисперсия на секунду та же)
function marketTick(dt) {
  if (simTime >= regime.until) nextRegime();

  // реальная компонента: усиленное движение живого BTC (тики агрегируются между шагами)
  let realDp = 0;
  const live = isLive();
  if (live && REAL.pendingReal) {
    if (REAL.lastReal) realDp = clamp(Math.log(REAL.pendingReal / REAL.lastReal) * GAIN, -0.02, 0.02);
    REAL.lastReal = REAL.pendingReal;
    REAL.pendingReal = null;
  }
  const genScale = live ? 0.7 : 1; // при живых данных генератор чуть тише
  const dp = regime.drift * dt * genScale +
             regime.sigma * genScale * Math.sqrt(dt) * gauss() + realDp;
  price = Math.max(1, price * Math.exp(dp));
}

function simStep(dt) {
  simTime += dt;
  tickAcc += dt;
  while (tickAcc >= SIM_TICK) { tickAcc -= SIM_TICK; marketTick(SIM_TICK); }

  // визуальная цена плавно догоняет целевую (глайд вместо скачка на тик)
  visPrice += (price - visPrice) * (1 - Math.exp(-dt / VIS_EASE));

  // свечи геймового темпа рисуются по сглаженной цене
  let c = candles[candles.length - 1];
  if (!c || simTime - c.t0 >= CANDLE_DUR) {
    c = { t0: c ? c.t0 + CANDLE_DUR : simTime, o: visPrice, h: visPrice, l: visPrice, c: visPrice };
    candles.push(c);
    if (candles.length > VISIBLE + 4) candles.shift();
  }
  c.c = visPrice; if (visPrice > c.h) c.h = visPrice; if (visPrice < c.l) c.l = visPrice;

  if (pos) {
    const pnl = pnlOf(price);
    if (pnl > pos.peak) pos.peak = pnl;
    if (balance * (1 + pnl) < 1) doExit(true); // пол баланса — «слив»
  }
}

const pnlOf = p => pos.dir === 1 ? p / pos.entry - 1 : 1 - p / pos.entry;

// ===================== round flow =====================
function resetRound() {
  price = REAL.anchor || 63370;
  visPrice = price; tickAcc = 0;
  ui.acc = 9; ui.pnl = 0; ui.badge = '';
  roundStartPrice = price;
  const hb = hubStartBal(); // свежий кошелёк хаба на старте каждого раунда
  seedBal = hb !== null ? hb : START_BALANCE;
  simTime = 0; balance = seedBal;
  roundLeft = ROUND_TIME; pos = null; trades = []; bust = false;
  candles = []; yInit = false;
  nextRegime();
  for (let i = 0; i < (VISIBLE + 1) * CANDLE_DUR * 30; i++) simStep(1 / 30); // предыстория
  roundLeft = ROUND_TIME;
  el.hudBalance.textContent = fmtInt(balance);
  el.hudTimer.textContent = '1:00'; lastTimerText = '1:00';
  el.hudTimer.classList.remove('hot');
  el.tradesLog.innerHTML = '';
  if (lives <= 0) lives = 3;
  drawHearts();
  setPosUI();
}
function drawHearts() {
  [...el.hearts.children].forEach((h, i) => h.classList.toggle('lost', i >= lives));
}

function showScreen(name) {
  for (const k in el.screens) el.screens[k].classList.toggle('hidden', k !== name);
}

function startCountdown() {
  resetRound();
  showScreen('game');
  resizeCanvases(); // экран игры только что стал видимым
  state = 'countdown';
  cdT = 2.4; cdShown = -1;
  el.countdown.classList.remove('hidden');
}

function beginPlay() {
  state = 'play';
  el.countdown.classList.add('hidden');
  el.flash.classList.remove('go'); void el.flash.offsetWidth; el.flash.classList.add('go');
  snd.go();
}

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

/* вибрация только после реального жеста: без этого Chrome логирует intervention
   на каждый vibrate в безжестовых прогонах (?auto/кёоск) — шум в консоли */
function vibrate(pattern) {
  try {
    if (navigator.vibrate && (!navigator.userActivation || navigator.userActivation.hasBeenActive)) {
      navigator.vibrate(pattern);
    }
  } catch (e) {}
}

function enter(dir) {
  if (state !== 'play' || pos || performance.now() < inputLock) return;
  const fee = balance * TRADE_FEE;
  if (fee > 0) {
    balance = Math.max(0, balance - fee);
    el.hudBalance.textContent = fmtInt(balance);
    feeFloat('fee −' + fmtInt(Math.max(1, Math.round(fee))));
  }
  pos = { dir, entry: price, entryT: simTime, peak: 0 };
  ui.pnl = 0; ui.acc = 9; // счётчик PnL с нуля, цифры обновить сразу
  (dir === 1 ? snd.long : snd.short)();
  vibrate(12);
  setPosUI();
}

function doExit(forced) {
  if (!pos) return;
  const pnl = pnlOf(price);
  balance = Math.max(0, balance * (1 + pnl));
  trades.push({ dir: pos.dir, pnl, res: balance });
  addTradeChip(pos.dir, pnl);
  el.hudBalance.textContent = fmtInt(balance);
  el.balanceStrip.classList.remove('pop'); void el.balanceStrip.offsetWidth;
  el.balanceStrip.classList.add('pop');
  if (pnl >= 0.08) { confettiBurst(pnl >= 0.2 ? 140 : 80); snd.win(pnl >= 0.2); }
  else if (pnl >= 0) snd.win(false);
  else snd.loss();
  vibrate(pnl >= 0 ? [10, 30, 10] : 25);
  pos = null;
  ui.acc = 9; // цифры карточки обновить сразу
  inputLock = performance.now() + 220; // защита от даблтапа
  setPosUI();
  // онбординг: ровно TUT_TRADES закрытых сделок — обычный конец раунда (без «слива»)
  if (TUT && trades.length >= TUT_TRADES) { endRound(); return; }
  if (forced || balance < 1) {
    bust = true;
    lives = Math.max(0, lives - 1);
    drawHearts();
    const h = el.hearts.children[lives];
    if (h) { h.classList.add('pop'); }
    endRound();
  }
}

// hub integration: report the round result to the parent shell (iframe only)
function reportToHub(earned) {
  if (window.parent === window) return; // standalone open — no-op
  try {
    window.parent.postMessage({ type: 'hub:roundEnd', game: 'longshort', earned: Math.round(earned) }, '*');
  } catch (e) {}
}

function endRound() {
  if (state === 'result') return;
  if (pos) doExit(false);
  if (state === 'result') return; // doExit мог закончить раунд «сливом»
  state = 'result';
  reportToHub(balance - seedBal);
  if (bust) snd.bust();
  buildResult();
  showScreen('result');
}

// ===================== game UI =====================
function setPosUI() {
  const inPos = !!pos;
  el.entryButtons.classList.toggle('hidden', inPos);
  el.btnExit.classList.toggle('hidden', !inPos);
  el.cardIdle.classList.toggle('hidden', inPos);
  el.cardPos.classList.toggle('hidden', !inPos);
  el.hudPreview.classList.toggle('hidden', !inPos);
  el.hintIdle.classList.toggle('hidden', inPos || trades.length > 0);
  el.meltWarn.classList.add('hidden');
  if (inPos) {
    el.dirPill.className = pos.dir === 1 ? 'long' : 'short';
    el.dirPill.textContent = pos.dir === 1 ? 'Long' : 'Short';
    el.entryPrice.textContent = fmtInt(pos.entry);
  }
}

let lastPnlBucket = null;
function updateHud() {
  // таймер + кольцо
  const left = Math.max(0, roundLeft);
  const s = Math.ceil(left);
  const txt = s >= 60 ? '1:00' : '0:' + String(s).padStart(2, '0');
  if (txt !== lastTimerText) {
    el.hudTimer.textContent = txt; lastTimerText = txt;
    if (s <= 5 && s > 0 && state === 'play') snd.tick();
  }
  el.hudTimer.classList.toggle('hot', left <= 10.2 && state === 'play');
  el.ringArc.style.strokeDashoffset = RING_C * (left / ROUND_TIME);

  // плавный счётчик PnL — каждый кадр, но ТЕКСТЫ пишем 5 раз/сек (без мельтешения)
  if (pos) ui.pnl += (pnlOf(price) - ui.pnl) * (1 - Math.exp(-lastDt / 0.18));
  ui.acc += lastDt;
  if (ui.acc < TXT_EVERY) return;
  ui.acc = 0;
  ui.badge = fmtAxis(visPrice); // подпись ценника на графике — тем же темпом

  if (pos) {
    const pnl = ui.pnl;
    el.pnlValue.textContent = fmtPct(pnl);
    el.pnlValue.classList.toggle('up', pnl >= 0);
    el.pnlValue.classList.toggle('down', pnl < 0);
    const bucket = Math.round(pnl * 20); // пульс на каждые 5%
    if (lastPnlBucket !== null && bucket !== lastPnlBucket) {
      el.pnlValue.classList.remove('pulse'); void el.pnlValue.offsetWidth;
      el.pnlValue.classList.add('pulse');
    }
    lastPnlBucket = bucket;
    el.curPrice.textContent = fmtInt(visPrice);
    const preview = balance * (1 + pnl);
    el.hudPreview.textContent = '→ ' + fmtInt(preview);
    el.hudPreview.classList.toggle('up', pnl >= 0);
    el.hudPreview.classList.toggle('down', pnl < 0);
    el.exitPreview.textContent = '→ ' + fmtInt(preview) + ' coins · ' + fmtPct(pnl);
    // тающая прибыль
    const real = pnlOf(price);
    const melting = pos.peak >= 0.05 && real < pos.peak * 0.6 && real > -0.5 &&
                    (pos.peak - real) >= 0.03;
    el.meltWarn.classList.toggle('hidden', !melting);
  } else {
    lastPnlBucket = null;
    el.cardPrice.textContent = fmtInt(visPrice);
    const chg = visPrice / roundStartPrice - 1;
    el.cardPct.textContent = fmtPct(chg, 2);
    el.cardPct.classList.toggle('up', chg >= 0);
    el.cardPct.classList.toggle('down', chg < 0);
  }
  updateNetBadge();
}

function addTradeChip(dir, pnl) {
  const c = document.createElement('div');
  c.className = 'tchip ' + (pnl >= 0 ? 'win' : 'loss');
  c.textContent = (dir === 1 ? '▲' : '▼') + ' ' + fmtPct(pnl);
  el.tradesLog.prepend(c);
  while (el.tradesLog.children.length > 3) el.tradesLog.lastChild.remove();
}

// ===================== chart render (свечи) =====================
function niceStep(range) {
  const raw = range / 4.5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) if (raw <= m * mag) return m * mag;
  return 10 * mag;
}

function render() {
  if (!chW || !candles.length) return;
  cx.clearRect(0, 0, chW, chH);

  const areaW = chW * 0.80;             // свечи слева, ось справа
  const slot = areaW / VISIBLE;
  const bodyW = slot * 0.66;
  const cur = candles[candles.length - 1];
  const progress = clamp((simTime - cur.t0) / CANDLE_DUR, 0, 1);

  // диапазон видимых свечей (+ вход)
  let lo = Infinity, hi = -Infinity;
  const first = Math.max(0, candles.length - (VISIBLE + 1));
  for (let i = first; i < candles.length; i++) {
    if (candles[i].l < lo) lo = candles[i].l;
    if (candles[i].h > hi) hi = candles[i].h;
  }
  if (pos) { lo = Math.min(lo, pos.entry); hi = Math.max(hi, pos.entry); }
  const pad = Math.max((hi - lo) * 0.22, price * 0.004);
  const tMin = lo - pad, tMax = hi + pad;
  if (!yInit) { yMin = tMin; yMax = tMax; yInit = true; }
  const k = 1 - Math.exp(-6 * lastDt);
  yMin = lerp(yMin, tMin, k); yMax = lerp(yMax, tMax, k);
  const Y = p => chH - (p - yMin) / (yMax - yMin) * chH;
  const xOf = i => areaW - (candles.length - 1 - i + progress) * slot + slot * 0.5;

  // зона позиции: полоса от входа до текущей (сглаженной) цены
  if (pos) {
    const y1 = Y(pos.entry), y2 = Y(visPrice);
    const pnl = pnlOf(visPrice);
    cx.fillStyle = pnl >= 0 ? 'rgba(31,161,92,.20)' : 'rgba(238,68,55,.20)';
    cx.fillRect(0, Math.min(y1, y2), chW, Math.max(2, Math.abs(y2 - y1)));
  }

  // сетка: горизонтальные пунктирные линии по «красивым» уровням + подписи оси
  const step = niceStep(yMax - yMin);
  cx.font = '800 16px ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", sans-serif';
  cx.textBaseline = 'middle';
  cx.setLineDash([7, 8]);
  cx.strokeStyle = 'rgba(255,255,255,.7)';
  cx.lineWidth = 1.5;
  for (let p = Math.ceil(yMin / step) * step; p < yMax; p += step) {
    const y = Y(p);
    cx.beginPath(); cx.moveTo(0, y); cx.lineTo(chW, y); cx.stroke();
    cx.fillStyle = '#9d9382';
    cx.textAlign = 'right';
    cx.fillText(fmtAxis(p), chW - 8, y - 12);
  }
  // вертикальные пунктирные линии, едут вместе со свечами (стабильны по времени свечи)
  for (let i = first; i < candles.length; i++) {
    if (Math.round(candles[i].t0 / CANDLE_DUR) % 4 !== 0) continue;
    const x = xOf(i);
    if (x < -4 || x > chW) continue;
    cx.beginPath(); cx.moveTo(x, 0); cx.lineTo(x, chH); cx.stroke();
  }
  cx.setLineDash([]);

  // свечи
  for (let i = first; i < candles.length; i++) {
    const c = candles[i];
    const x = xOf(i);
    if (x < -slot || x > areaW + slot) continue;
    const up = c.c >= c.o;
    const col = up ? '#1fa15c' : '#ee4437';
    cx.fillStyle = col;
    // фитиль
    cx.fillRect(x - 1.2, Y(c.h), 2.4, Math.max(1, Y(c.l) - Y(c.h)));
    // тело
    const yO = Y(c.o), yC = Y(c.c);
    const top = Math.min(yO, yC), hgt = Math.max(3, Math.abs(yC - yO));
    roundRect(x - bodyW / 2, top, bodyW, hgt, 3, col);
  }

  // бейдж текущей цены на правом краю (синий): позиция глайдит каждый кадр,
  // цифры внутри — раз в TXT_EVERY (без спиннера разрядов)
  const by = clamp(Y(visPrice), 16, chH - 16);
  const label = ui.badge || fmtAxis(visPrice);
  cx.font = '800 15px ui-rounded, "SF Pro Rounded", "Nunito", "Segoe UI", sans-serif';
  const bw = cx.measureText(label).width + 20;
  roundRect(chW - bw - 2, by - 15, bw + 12, 30, 10, '#4f74e8'); // хвост уходит за край
  cx.fillStyle = '#fff';
  cx.textAlign = 'center';
  cx.fillText(label, chW - bw / 2 - 2 + 4, by + 1);

  // линия входа (тонкий штрих на границе полосы)
  if (pos) {
    const ey = Y(pos.entry);
    cx.setLineDash([5, 5]);
    cx.strokeStyle = 'rgba(75,63,94,.5)'; cx.lineWidth = 1.5;
    cx.beginPath(); cx.moveTo(0, ey); cx.lineTo(chW, ey); cx.stroke();
    cx.setLineDash([]);
  }

  function roundRect(x, y, w, h, r, fill) {
    if (w < 0) { x += w; w = -w; }
    if (h < 0) { y += h; h = -h; }
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    cx.fillStyle = fill;
    cx.beginPath();
    if (cx.roundRect) cx.roundRect(x, y, w, h, r);
    else cx.rect(x, y, w, h);
    cx.fill();
  }
}

// ===================== confetti =====================
const parts = [];
const CONF_COLORS = ['#1fa15c', '#ee4437', '#4f74e8', '#f2b93b', '#fff6df', '#f2a51d'];
function confettiBurst(n, y0) {
  for (let i = 0; i < n; i++) {
    parts.push({
      x: 195 + (Math.random() - 0.5) * 120,
      y: (y0 === undefined ? 440 : y0) + (Math.random() - 0.5) * 60,
      vx: (Math.random() - 0.5) * 460,
      vy: -250 - Math.random() * 380,
      s: 5 + Math.random() * 6,
      r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 12,
      c: CONF_COLORS[(Math.random() * CONF_COLORS.length) | 0],
      life: 1.6 + Math.random() * 0.8,
      t: 0,
    });
  }
}
function fxRender(dt) {
  if (!parts.length) { fcx.clearRect(0, 0, 390, 844); return; }
  fcx.clearRect(0, 0, 390, 844);
  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    p.t += dt;
    if (p.t > p.life) { parts.splice(i, 1); continue; }
    p.vy += 900 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.r += p.vr * dt;
    p.vx *= (1 - 1.4 * dt);
    const a = 1 - p.t / p.life;
    fcx.save();
    fcx.translate(p.x, p.y); fcx.rotate(p.r);
    fcx.globalAlpha = a;
    fcx.fillStyle = p.c;
    fcx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.7);
    fcx.restore();
  }
}

// ===================== result =====================
function loadBest() {
  try { return JSON.parse(localStorage.getItem(BEST_KEY)) || null; } catch (e) { return null; }
}
function buildResult() {
  const mult = balance / (seedBal || 1);
  let title;
  if (bust) title = '💥 Busted!';
  else if (mult >= 3) title = '🚀 On fire!';
  else if (mult >= 2) title = '🔥 Huge!';
  else if (mult >= 1.2) title = '📈 In profit!';
  else if (mult >= 0.95) title = '😬 Almost break-even';
  else title = '📉 In the red…';
  el.resultTitle.textContent = title;
  el.resultTitle.classList.toggle('bust', bust || mult < 0.95);
  el.resultBalance.textContent = fmtInt(balance);
  el.resultMult.textContent = fmtMult(mult) + ' from start';

  // рекорд
  const prev = loadBest();
  const isRecord = !prev || balance > prev.bal;
  if (isRecord && balance > seedBal) {
    try { localStorage.setItem(BEST_KEY, JSON.stringify({ bal: Math.round(balance), mult })); } catch (e) {}
  }
  el.resultRecord.classList.toggle('hidden', !(isRecord && balance > seedBal));
  const best = loadBest();
  el.resultBest.textContent = best
    ? 'Personal best: ' + fmtInt(best.bal) + ' coins · ' + fmtMult(best.mult || best.bal / START_BALANCE)
    : '';

  // список сделок
  el.tradesCount.textContent = trades.length ? '· ' + trades.length : '';
  el.tradesList.innerHTML = '';
  if (!trades.length) {
    el.tradesList.innerHTML = '<div class="trades-empty">No trades — be bolder!</div>';
  } else {
    for (const t of trades) {
      const row = document.createElement('div');
      row.className = 'trow';
      row.innerHTML =
        `<span class="tbadge ${t.dir === 1 ? 'long' : 'short'}">${t.dir === 1 ? '▲ Long' : '▼ Short'}</span>` +
        `<span class="tpnl ${t.pnl >= 0 ? 'win' : 'loss'}">${fmtPct(t.pnl)}</span>` +
        `<span class="tres">→ ${fmtInt(t.res)}</span>`;
      el.tradesList.appendChild(row);
    }
  }

  // фейковый лидерборд
  const names = NICKS.slice().sort(() => Math.random() - 0.5).slice(0, 6);
  const base = Math.max(balance, (best && best.bal) || 0, START_BALANCE * 1.6);
  const others = [
    Math.round(base * (1.55 + Math.random() * 0.7)),
    Math.round(base * (1.15 + Math.random() * 0.3)),
    Math.round(base * (0.82 + Math.random() * 0.14)),
    Math.round(base * (0.55 + Math.random() * 0.18)),
    Math.round(base * (0.34 + Math.random() * 0.14)),
    Math.round(base * (0.16 + Math.random() * 0.1)),
  ];
  const rows = others.map((b, i) => ({ name: names[i], bal: b, me: false }));
  rows.push({ name: 'You', bal: Math.round(balance), me: true });
  rows.sort((a, b) => b.bal - a.bal);
  el.leaderboard.innerHTML = '';
  rows.forEach((r, i) => {
    const d = document.createElement('div');
    d.className = 'lrow' + (r.me ? ' me' : '');
    d.innerHTML = `<span class="lrank">${i + 1}</span><span>${r.name}</span>` +
      `<span class="lbal"><span class="coin small"></span>${fmtInt(r.bal)}</span>`;
    el.leaderboard.appendChild(d);
  });

  if (!bust && mult >= 1.5) setTimeout(() => confettiBurst(120, 300), 350);
}

// ===================== input =====================
function press(elBtn, fn) {
  const h = e => { e.preventDefault(); elBtn.classList.remove('bounce'); void elBtn.offsetWidth; elBtn.classList.add('bounce'); fn(); };
  elBtn.addEventListener('pointerdown', h);
}
press($('btn-long'), () => enter(1));
press($('btn-short'), () => enter(-1));
press(el.btnExit, () => { if (state === 'play') doExit(false); });
press($('btn-start'), () => { ac(); startCountdown(); });
press($('btn-again'), () => { ac(); startCountdown(); });
press($('btn-pause'), () => {
  if (state === 'play') { state = 'paused'; el.pauseOverlay.classList.remove('hidden'); }
});
press($('btn-resume'), () => {
  if (state === 'paused') { state = 'play'; el.pauseOverlay.classList.add('hidden'); }
});
press($('btn-restart'), () => {
  el.pauseOverlay.classList.add('hidden'); startCountdown();
});
/* «Exit to menu» в паузе — IIFE-сниппет оркестратора в конце файла (hubExitBtn) */
// клавиатура для десктоп-записи видео
window.addEventListener('keydown', e => {
  if (e.repeat) return;
  if (e.code === 'ArrowUp' || e.code === 'KeyA') enter(1);
  else if (e.code === 'ArrowDown' || e.code === 'KeyD') enter(-1);
  else if (e.code === 'Space') {
    e.preventDefault();
    if (state === 'start' || state === 'result') { ac(); startCountdown(); }
    else if (pos && state === 'play') doExit(false);
  }
});

// ===================== авто-режим (?auto) для проверки =====================
const AUTO = new URLSearchParams(location.search).has('auto');
let autoPlan = null;
function autoPlay() {
  if (state !== 'play') return;
  if (!pos) {
    if (!autoPlan) autoPlan = { at: simTime + 0.4 + Math.random() * 1.5 };
    if (simTime >= autoPlan.at) {
      enter(Math.random() < 0.5 ? 1 : -1);
      autoPlan = { t0: simTime, hold: 1.5 + Math.random() * 3.5,
                   tp: 0.06 + Math.random() * 0.2, sl: -(0.08 + Math.random() * 0.2) };
    }
  } else {
    const pnl = pnlOf(price);
    if (pnl >= autoPlan.tp || pnl <= autoPlan.sl || simTime - autoPlan.t0 > autoPlan.hold) {
      doExit(false);
      autoPlan = null;
    }
  }
}

// ===================== main loop =====================
let lastNow = performance.now(), lastDt = 1 / 60;
function frame(now) {
  const dt = clamp((now - lastNow) / 1000, 0.001, 0.05);
  lastNow = now; lastDt = dt;

  if (state === 'countdown') {
    simStep(dt);
    cdT -= dt;
    const n = Math.ceil(cdT / 0.8);
    if (n !== cdShown && n > 0) {
      cdShown = n;
      el.countdown.textContent = n;
      el.countdown.classList.remove('tick'); void el.countdown.offsetWidth;
      el.countdown.classList.add('tick');
      snd.count();
    }
    if (cdT <= 0) beginPlay();
  } else if (state === 'play') {
    simStep(dt);
    if (AUTO) autoPlay();
    roundLeft -= dt;
    if (roundLeft <= 0) { roundLeft = 0; endRound(); }
  }

  if (state === 'play' || state === 'countdown' || state === 'paused') {
    updateHud();
    render();
  }
  fxRender(dt);
  requestAnimationFrame(frame);
}

// ===================== boot =====================
const bootBest = loadBest();
if (bootBest) {
  el.startBest.textContent = '🏆 best: ' + fmtInt(bootBest.bal) + ' coins · ' + fmtMult(bootBest.bal / START_BALANCE);
  el.startBest.classList.remove('hidden');
}
// из хаба стартовая подпись «multiply 1 000 coins» неверна — котлета равна кошельку
if (hubStartBal() !== null) {
  for (const li of document.querySelectorAll('#screen-start li')) {
    if (li.textContent.includes('1 000 coins')) {
      li.innerHTML = li.innerHTML.replace('multiply 1 000 coins', 'multiply your balance');
    }
  }
}
seedReal();
fitStage();
requestAnimationFrame(t => { lastNow = t; requestAnimationFrame(frame); });
if (AUTO) setTimeout(() => { if (state === 'start') { startCountdown(); } }, 700); // автостарт для прогонов

/* hub: выход в меню из паузы (только в iframe хаба; добавлено оркестратором 24.07) */
(function(){
  if (window.parent === window) return;
  function mount(){
    if (document.getElementById('hubExitBtn')) return;
    var anchor = document.getElementById('btn-restart');
    if (!anchor) return;
    var b = document.createElement('button');
    b.id = 'hubExitBtn'; b.className = 'ghostbtn'; b.textContent = 'Exit to menu';
    b.addEventListener('click', function(){
      try { window.parent.postMessage({type:'hub:exit', game:'longshort'}, '*'); } catch(e){}
    });
    anchor.insertAdjacentElement('afterend', b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
