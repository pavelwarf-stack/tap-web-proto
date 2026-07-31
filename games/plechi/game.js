'use strict';
/* ============================================================
   ПЛЕЧИ — тап-аркада про плечи и ликвидацию. Прототип для демо.
   Vanilla JS + canvas, без зависимостей. 60fps через rAF.

   Рынок — движок из longshort (одобрен как эталон): цена игры =
   живой сим (режимы тренд/болтанка/импульсы, шаг 8 раз/сек) +
   усиленные (×GAIN) лог-приращения реального BTC из Binance WS,
   якорь — реальная цена из REST. Визуальная цена — экспоненциальный
   глайд (тау ~130 мс), свечи ~1.1 с, живые тела без мёртвых полок.
   PnL = движение цены × плечо; ликвидация = вход×(1 ∓ 1/плечо) в том
   же ценовом пространстве графика (×1 — без ликвидации).
   ============================================================ */

const $ = s => document.querySelector(s);
const clamp = (v,a,b)=>v<a?a:v>b?b:v;
const lerp = (a,b,t)=>a+(b-a)*t;
const rand = (a,b)=>a+Math.random()*(b-a);
const randInt = (a,b)=>Math.floor(rand(a,b+1));
const sstep = (a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)};

const CFG = {
  start: 1000,          // стартовый баланс раунда (монеты)
  roundMs: 60000,      // раунд 60 c
  candleSec: 1.1,      // игровая свеча, сек
  vis: 13,             // видимых свечей
  gain: 30,            // усиление реальных BTC-движений до геймового масштаба
  simTick: 0.125,      // рынок шагает 8 раз/сек (без 60Гц-дрожи)
  visEase: 0.13,       // тау глайда визуальной цены, сек
  levs: [1, 2, 3, 4, 5],
  histCandles: 15,     // сколько свечей нарисовать до старта
};

const BOTS = [
  {n:'WhaleOfWallSt', s:52000},
  {n:'MarginCallMike', s:21000},
  {n:'TenXTina', s:9400},
  {n:'AllInAndy', s:4800},
  {n:'CarefulCarl', s:2100},
];

/* ---------- форматирование ---------- */
const fmtPrice = p => Math.round(p).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');
const fmtCoins = n => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,' ');
const fmtPct = (f, dec=2) => {      // f — доля (0.1597 → «+15,97%»)
  const v = f*100;
  const s = Math.abs(v).toFixed(dec);
  return (v >= 0 ? '+' : '-') + s + '%';
};
const fmtX = m => '×' + m.toFixed(1);
const fmtTime = ms => {
  const s = Math.max(0, Math.ceil(ms/1000));
  return Math.floor(s/60) + ':' + String(s%60).padStart(2,'0');
};

/* ---------- DOM ---------- */
const el = {
  game: $('#game'),
  chart: $('#chart'), fx: $('#fx'), chartWrap: $('#chartWrap'),
  pauseBtn: $('#pauseBtn'), timerVal: $('#timerVal'), ringArc: $('#ringArc'),
  bestVal: $('#bestVal'), balVal: $('#balVal'), runMult: $('#runMult'),
  offlineBadge: $('#offlineBadge'), vignette: $('#vignette'),
  msg: $('#msg'), floatLayer: $('#floatLayer'), stamp: $('#stamp'),
  flatInfo: $('#flatInfo'), flatPrice: $('#flatPrice'), flatPct: $('#flatPct'),
  posInfo: $('#posInfo'), levChip: $('#levChip'), dirChip: $('#dirChip'),
  plCoins: $('#plCoins'), plPct: $('#plPct'),
  entryVal: $('#entryVal'), curVal: $('#curVal'),
  liqLabel: $('#liqLabel'), liqFill: $('#liqFill'), liqBlock: document.querySelector('.liqBlock'),
  tradeUI: $('#tradeUI'), rowEnter: $('#rowEnter'), rowExit: $('#rowExit'),
  btnLong: $('#btnLong'), btnShort: $('#btnShort'),
  btnExit: $('#btnExit'), exitSub: $('#exitSub'),
  sliderTrack: $('#sliderTrack'), sliderFill: $('#sliderFill'), knob: $('#knob'),
  levLabels: [...document.querySelectorAll('#levLabels span')],
  startScreen: $('#startScreen'), pauseScreen: $('#pauseScreen'), overScreen: $('#overScreen'),
  playBtn: $('#playBtn'), againBtn: $('#againBtn'),
  resumeBtn: $('#resumeBtn'), restartBtn: $('#restartBtn'),
  startBest: $('#startBest'), startBestVal: $('#startBestVal'),
  overTitle: $('#overTitle'), finalBal: $('#finalBal'), finalMult: $('#finalMult'),
  recordNote: $('#recordNote'), tradesList: $('#tradesList'), board: $('#board'),
};

const chartCtx = el.chart.getContext('2d');
const fxCtx = el.fx.getContext('2d');
const RING_LEN = 276.46; // 2πr, r=44

/* ---------- persistent ---------- */
let best = 0;
try { best = +localStorage.getItem('plechiBest') || 0; } catch(e){}
function saveBest(){ try { localStorage.setItem('plechiBest', String(best)); } catch(e){} }

/* ============================================================
   ДАННЫЕ: Binance REST (затравка) + WebSocket (лайв) + генератор
   ============================================================ */
const FEED = {
  anchor: 0,         // якорная реальная цена (REST)
  pendingReal: null, // последний живой тик (агрегируется между шагами сима)
  lastReal: null,    // предыдущий учтённый тик
  ready: false,
  lastMsg: 0,        // performance.now() последнего тика
  pctHour: null,     // изменение за последний час (для карточки BTC)
  ws: null, tries: 0,
  readyResolve: null,
  readyPromise: null,
};
// lastMsg=0 (ни одного тика) НЕ считается живым фидом: без этого первые 3.5с жизни
// страницы оффлайн-клиент считал себя live и прятал offline-бейдж (найдено финишером 24.07)
const feedLive = () => FEED.lastMsg > 0 && performance.now() - FEED.lastMsg < 3500;
FEED.readyPromise = new Promise(r => FEED.readyResolve = r);

async function feedInit(){
  // 1) REST-затравка: якорная цена + % за час.
  // readyPromise ОБЯЗАН резолвиться при любом исходе (мгновенный reject fetch,
  // таймаут, кривой JSON, неожиданный throw) — иначе старт игры зависнет.
  try{
    const ctl = new AbortController();
    const to = setTimeout(()=>ctl.abort(), 4000);
    const r = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=60',
                          {signal: ctl.signal});
    clearTimeout(to);
    const k = await r.json();
    if(Array.isArray(k) && k.length){
      const first = +k[0][1], last = +k[k.length-1][4];
      if(Number.isFinite(last) && last > 0){
        FEED.anchor = last;
        FEED.pctHour = Number.isFinite(first) && first > 0 ? last/first - 1 : null;
        FEED.ready = true;
      }
    }
  }catch(e){ /* оффлайн/бан API — сим стартует от дефолта */ }
  finally{
    if(!FEED.ready){ FEED.anchor = 63370; FEED.ready = true; } // якорь как в макете
    try{ FEED.readyResolve(); }catch(e){}
  }
  // 2) лайв через WebSocket
  try{ wsConnect(); }catch(e){}
}

function wsConnect(){
  if(FEED.tries >= 5) return;
  FEED.tries++;
  try{
    const ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade');
    FEED.ws = ws;
    ws.onmessage = ev => {
      try{
        const p = +JSON.parse(ev.data).p;
        if(!p) return;
        FEED.pendingReal = p;
        FEED.lastMsg = performance.now();
        FEED.tries = 0;
      }catch(e){}
    };
    ws.onclose = ws.onerror = () => {
      setTimeout(wsConnect, 1500*FEED.tries);
    };
  }catch(e){ setTimeout(wsConnect, 1500*FEED.tries); }
}

/* --- рыночный сим (движок longshort, одобренный эталон):
   режимы тренд/болтанка с мягкой возвратностью к старту раунда,
   редкие импульсы; поверх — усиленные лог-приращения живого BTC. --- */
function gauss(){ return (Math.random()+Math.random()+Math.random()+Math.random()-2)*1.732; }

function nextRegime(){
  // Деэксплойт (решение владельца 24.07): без анти-стрика «не 3 тренда подряд» и без
  // ощутимой возвратности к старту — «шорти дип, лонгуй отскок» больше не стратегия.
  // Остался лишь слабый перекос на КРАЙНИХ выносах (страховка кадра, не гарантия отскока).
  const rel = G.price / G.roundStart;
  let upW = 0.38, dnW = 0.38;
  if(rel > 1.6){ upW = 0.30; dnW = 0.46; }
  else if(rel < 0.45){ upW = 0.46; dnW = 0.30; }
  const r = Math.random();
  let dir = 0;
  if(r < upW) dir = 1; else if(r < upW + dnW) dir = -1;

  let dur, drift, sigma;
  if(dir === 0){ // болтанка переменной ширины
    dur = 0.9 + Math.random()*3.1;
    drift = (Math.random() - 0.5)*0.008;
    sigma = 0.010 + Math.random()*0.008;
  } else {
    dur = 1.2 + Math.random()*5.2; // случайная длительность тренда (продолжения возможны)
    drift = dir*(0.010 + Math.random()*0.017);
    sigma = 0.008 + Math.random()*0.005;
    const q = Math.random();
    if(q < 0.10){ dur = 0.7 + Math.random()*0.7; drift *= 2.4; }            // импульс
    else if(q < 0.28){ dur = 0.5 + Math.random()*0.9;                        // фейковый вынос:
      drift *= (Math.random() < 0.5 ? -1 : 1)*(1.4 + Math.random()); }       // рывок в любую сторону
  }
  G.regime = { drift, sigma, until: G.simTime + dur };
}

// шаг рынка: редкие крупные шаги вместо 60Гц-дрожи (дисперсия/сек та же)
function marketTick(dt){
  if(G.simTime >= G.regime.until) nextRegime();
  let realDp = 0;
  const live = feedLive();
  if(live && FEED.pendingReal){
    if(FEED.lastReal) realDp = clamp(Math.log(FEED.pendingReal/FEED.lastReal)*CFG.gain, -0.02, 0.02);
    FEED.lastReal = FEED.pendingReal;
    FEED.pendingReal = null;
  }
  const gs = live ? 0.7 : 1; // при живых данных генератор чуть тише
  const dp = G.regime.drift*dt*gs + G.regime.sigma*gs*Math.sqrt(dt)*gauss() + realDp;
  G.price = Math.max(1, G.price*Math.exp(dp));
}

/* ============================================================
   ИГРА
   ============================================================ */
let G = null;
let running = false;
let paused = false;
let msgTimer = null;
const particles = [];
let cracks = null; // {segs:[], t}
const AUTO = new URLSearchParams(location.search).has('auto');

let curLev = 5; // выбранное плечо (значение, не индекс)

/* hub integration: из хаба раунд играется всей котлетой кошелька (hub.balance),
   standalone — внутренний сид CFG.start. В хаб уходит дельта за раунд. */
function hubStartBal(){
  if(window.parent === window) return null; // standalone
  try{
    const v = parseInt(localStorage.getItem('hub.balance'), 10);
    if(Number.isFinite(v)) return Math.max(0, v); // отрицательный кошелёк → 0
  }catch(e){}
  return null;
}

function newGame(){
  const anchor = FEED.anchor || 63370;
  const hb = hubStartBal(); // свежий кошелёк хаба на старте каждого раунда
  const seedBal = hb !== null ? hb : CFG.start;
  G = {
    seed: seedBal,
    bal: seedBal, timeLeft: CFG.roundMs, t: 0,
    price: anchor, visPrice: anchor, roundStart: anchor,
    hi: anchor, lo: anchor,
    simTime: 0, tickAcc: 0,
    regime: { drift: 0, sigma: 0.011, until: 0 },
    trendStreak: 0, lastDir: 0,
    uiNext: 0,
    candles: [], cur: null,
    pos: null, trades: [],
    phase: 'run', phaseT: 0,
    vmin: 0, vmax: 0, viewInit: false,
    newRecord: false, nextThump: 0, lastTickSec: 61,
    autoPlan: null,
  };
  nextRegime();
  seedHistory();
  particles.length = 0;
  cracks = null;
  el.floatLayer.innerHTML = '';
  el.msg.className = '';
  el.stamp.classList.add('hidden');
  el.stamp.classList.remove('pop');
  setPositionUI(false);
  renderStatic();
}

function seedHistory(){
  // прошлое — прогон того же сима (без реальных тиков), чтобы график
  // с первого кадра был живой и однородный с живыми свечами
  G.cur = { o: G.visPrice, h: G.visPrice, l: G.visPrice, c: G.visPrice, t0: 0 };
  const steps = Math.round(CFG.histCandles*CFG.candleSec/CFG.simTick);
  for(let s=0; s<steps; s++){
    G.simTime += CFG.simTick;
    marketTick(CFG.simTick);
    G.visPrice += (G.price - G.visPrice)*(1 - Math.exp(-CFG.simTick/CFG.visEase));
    let c = G.cur;
    if(G.simTime - c.t0 >= CFG.candleSec){
      G.candles.push({o:c.o, h:c.h, l:c.l, c:c.c});
      G.cur = { o: c.c, h: c.c, l: c.c, c: c.c, t0: c.t0 + CFG.candleSec };
      c = G.cur;
    }
    c.c = G.visPrice;
    if(G.visPrice > c.h) c.h = G.visPrice;
    if(G.visPrice < c.l) c.l = G.visPrice;
  }
  G.roundStart = G.price; // возвратность режимов — к цене на старте раунда
}

/* ---------- шаг сима + визуальный глайд + свечи ----------
   Механика и рендер сидят на visPrice (глайд к целевой цене сима,
   тау ~130 мс): график скользит без дёрганья, ликвидация срабатывает
   ровно когда НАРИСОВАННАЯ цена касается нарисованной линии. */
function simStep(dtMs){
  const dtS = dtMs/1000;
  G.simTime += dtS;
  G.tickAcc += dtS;
  while(G.tickAcc >= CFG.simTick){ G.tickAcc -= CFG.simTick; marketTick(CFG.simTick); }

  const prev = G.visPrice;
  G.visPrice += (G.price - G.visPrice)*(1 - Math.exp(-dtS/CFG.visEase));
  G.hi = Math.max(prev, G.visPrice);
  G.lo = Math.min(prev, G.visPrice);

  el.offlineBadge.classList.toggle('hidden', feedLive());

  let c = G.cur;
  if(G.simTime - c.t0 >= CFG.candleSec){
    G.candles.push({o:c.o, h:c.h, l:c.l, c:c.c});
    if(G.candles.length > CFG.vis + 6) G.candles.shift();
    G.cur = { o: c.c, h: c.c, l: c.c, c: c.c, t0: c.t0 + CFG.candleSec };
    c = G.cur;
  }
  c.c = G.visPrice;
  if(G.visPrice > c.h) c.h = G.visPrice;
  if(G.visPrice < c.l) c.l = G.visPrice;
}

/* ---------- позиция ---------- */
function liqPrice(entry, dir, lev){
  if(lev <= 1) return null; // ×1 — без ликвидации (−100% цены недостижимо)
  return entry * (1 - dir/lev);
}
function posPnl(){ // доля: +0.16 = +16%
  const p = G.pos;
  const raw = p.dir * (G.visPrice/p.entry - 1) * p.lev;
  return Math.max(raw, -1);
}

/* комиссия за вход в позицию: душит микро-скальпинг (0.5% котлеты за сделку),
   2–3 сделки за раунд почти не чувствуются (решение владельца 24.07) */
const TRADE_FEE = 0.005;

function enter(dir){ // dir: 1 лонг, -1 шорт
  if(!running || paused || !G || G.phase !== 'run' || G.pos) return;
  const fee = G.bal * TRADE_FEE;
  if(fee > 0){
    G.bal = Math.max(0, G.bal - fee);
    floatText('fee −' + fmtCoins(Math.max(1, Math.round(fee))), 'neg');
  }
  G.pos = {
    dir, lev: curLev, entry: G.visPrice,
    liq: liqPrice(G.visPrice, dir, curLev),
    tEnter: G.t,
  };
  setPositionUI(true);
  sEnter();
}

function exitPos(auto){
  if(!G.pos) return;
  const pnl = posPnl();
  const p = G.pos;
  G.bal = Math.max(0, G.bal * (1 + pnl));
  G.trades.push({dir: p.dir, lev: p.lev, pnl, liq: false});
  G.pos = null;
  setPositionUI(false);
  if(G.bal > best && G.bal > G.seed) G.newRecord = true;

  const txt = fmtPct(pnl, Math.abs(pnl) >= 1 ? 0 : 1) + '  →  🪙 ' + fmtCoins(G.bal);
  floatText(txt, pnl >= 0 ? '' : 'neg', Math.abs(pnl) > 0.35);
  if(pnl >= 0.5){ burstConfetti(130); showMsg('Nailed it!', 'good'); sBigWin(); }
  else if(pnl >= 0.18){ burstConfetti(60); sWin(); }
  else if(pnl >= 0){ sWin(); }
  else { sLose(); }
  renderStatic();
}

function liquidate(){
  const p = G.pos;
  G.trades.push({dir: p.dir, lev: p.lev, pnl: -1, liq: true});
  G.pos = null;
  G.bal = 0;
  G.phase = 'liq';
  G.phaseT = 0;
  setPositionUI(false);
  renderStatic();
  // драма: трещины + тряска + штамп
  makeCracks();
  el.game.classList.remove('shake'); void el.game.offsetWidth;
  el.game.classList.add('shake');
  el.stamp.classList.remove('hidden','pop'); void el.stamp.offsetWidth;
  el.stamp.classList.add('pop');
  el.vignette.style.opacity = 1;
  sLiq();
}

function setPositionUI(inPos){
  el.tradeUI.classList.toggle('hidden', inPos);
  el.rowExit.classList.toggle('hidden', !inPos);
  el.posInfo.classList.toggle('hidden', !inPos);
  el.flatInfo.classList.toggle('hidden', inPos);
  if(inPos){
    const p = G.pos;
    el.levChip.textContent = 'x' + p.lev;
    el.dirChip.textContent = p.dir > 0 ? 'Long' : 'Short';
    el.dirChip.className = p.dir > 0 ? 'long' : 'short';
    el.entryVal.textContent = fmtPrice(p.entry);
  } else {
    el.vignette.style.opacity = 0;
  }
  if(G){ G.uiNext = 0; renderNumbers(); } // мгновенный первый рендер на смене состояния
}

/* ---------- слайдер плеча ---------- */
const STOP_POS = [2, 26, 50, 74, 98]; // % трека (стопы по макету — метки у краёв)
function setLev(i){
  i = clamp(i, 0, CFG.levs.length-1);
  curLev = CFG.levs[i];
  el.knob.style.left = STOP_POS[i] + '%';
  el.sliderFill.style.width = STOP_POS[i] + '%';
  el.levLabels.forEach((s,j)=>s.classList.toggle('active', j === i));
}
function sliderPick(clientX){
  const r = el.sliderTrack.getBoundingClientRect();
  const f = clamp((clientX - r.left)/r.width, 0, 1)*100;
  let bi = 0, bd = 1e9;
  STOP_POS.forEach((p,i)=>{ const d = Math.abs(p-f); if(d < bd){ bd = d; bi = i; } });
  if(CFG.levs[bi] !== curLev){ setLev(bi); sTick(520); }
}
let sliderDrag = false;
el.sliderTrack.parentElement.addEventListener('pointerdown', e=>{
  if(G && G.pos) return;
  sliderDrag = true; sliderPick(e.clientX);
});
window.addEventListener('pointermove', e=>{ if(sliderDrag) sliderPick(e.clientX); });
window.addEventListener('pointerup', ()=>{ sliderDrag = false; });
el.levLabels.forEach(s=>s.addEventListener('pointerdown', e=>{
  if(G && G.pos) return;
  e.stopPropagation(); setLev(+s.dataset.i); sTick(520);
}));

/* ---------- update ---------- */
function update(dt){
  G.t += dt;
  G.phaseT += dt;

  if(G.phase === 'liq'){
    if(G.phaseT >= 2000) endRound(true);
    return;
  }
  if(G.phase !== 'run') return;

  G.timeLeft -= dt;
  simStep(dt);

  // ликвидация: касание уровня экстремумами тиков
  if(G.pos && G.pos.liq !== null){
    const p = G.pos;
    const touched = p.dir > 0 ? (G.lo <= p.liq) : (G.hi >= p.liq);
    if(touched || posPnl() <= -1){ liquidate(); return; }
  }

  // тик-так последние 5 секунд
  const sec = Math.ceil(G.timeLeft/1000);
  if(sec <= 5 && sec >= 1 && sec !== G.lastTickSec){ G.lastTickSec = sec; sTick(880); }

  // сердцебиение у ликвидации
  if(G.pos){
    const prox = liqProx();
    if(prox > 0.5 && G.t >= G.nextThump){
      sThump();
      G.nextThump = G.t + lerp(950, 320, sstep(0.5, 1, prox));
    }
  }

  if(AUTO) autoPlay();

  if(G.timeLeft <= 0){
    if(G.pos) exitPos(true);
    endRound(false);
  }
}

function liqProx(){ // 0 — у входа, 1 — у ликвидации
  const p = G.pos;
  if(!p || p.liq === null) return 0;
  const distFrac = p.dir * (G.visPrice - p.liq) / p.entry; // доля хода цены до ликвидации
  return clamp(1 - distFrac * p.lev, 0, 1);
}

/* hub integration: report the round result to the parent shell (iframe only) */
function reportToHub(earned){
  if(window.parent === window) return; // standalone open — no-op
  try{
    window.parent.postMessage({type:'hub:roundEnd', game:'plechi', earned:Math.round(earned)}, '*');
  }catch(e){}
}

function endRound(liq){
  G.phase = 'over';
  running = false;
  const bal = Math.round(G.bal);
  if(!G.hubReported){ G.hubReported = true; reportToHub(bal - G.seed); }
  if(bal > best){ best = bal; G.newRecord = true; saveBest(); }
  el.overTitle.textContent = liq ? 'Liquidated 💀' : 'Round complete';
  el.finalBal.textContent = '🪙 ' + fmtCoins(bal);
  el.finalMult.textContent = fmtX(bal/(G.seed || 1)) + ' from start';
  el.recordNote.classList.toggle('hidden', !G.newRecord);
  buildTrades();
  buildBoard(bal);
  el.overScreen.classList.remove('hidden');
  if(G.newRecord) burstConfetti(120, 0.5, 0.3);
}

function buildTrades(){
  el.tradesList.innerHTML = G.trades.length
    ? G.trades.map(t=>{
        const d = t.dir > 0 ? '<span class="dir long">Long</span>' : '<span class="dir short">Short</span>';
        const pnl = t.liq ? '💀 -100%' : fmtPct(t.pnl, Math.abs(t.pnl) >= 1 ? 0 : 1);
        return `<div class="trow">${d}<span class="lev">×${t.lev}</span>`+
               `<span class="tpnl ${t.pnl >= 0 ? 'pos' : 'neg'}">${pnl}</span></div>`;
      }).join('')
    : '<div class="trow"><span class="lev">no trades</span></div>';
}

function buildBoard(myBal){
  const bots = BOTS.map(b=>({n:b.n, s:Math.round(b.s*rand(0.8,1.25))}));
  const rows = [...bots, {n:'You', s:myBal, me:true}].sort((a,b)=>b.s-a.s);
  el.board.innerHTML = rows.map((r,i)=>{
    const medal = i===0?'🏆':i===1?'🥈':i===2?'🥉':(i+1);
    return `<div class="row${r.me?' me':''}"><span class="rank">${medal}</span>`+
           `<span class="name">${r.n}</span><span class="pts">🪙 ${fmtCoins(r.s)}</span></div>`;
  }).join('');
}

/* ---------- авто-режим (?auto) для проверки ---------- */
function autoPlay(){
  if(G.phase !== 'run') return;
  if(!G.pos){
    if(!G.autoPlan) G.autoPlan = { at: G.t + rand(400, 1500) };
    if(G.t >= G.autoPlan.at){
      setLev(randInt(0, CFG.levs.length-1));
      enter(Math.random() < 0.5 ? 1 : -1);
      G.autoPlan = { hold: rand(1500, 5000), t0: G.t,
                     tp: rand(0.12, 0.5), sl: -rand(0.15, 0.5) };
    }
  } else {
    const pnl = posPnl();
    const a = G.autoPlan;
    if(pnl >= a.tp || pnl <= a.sl || G.t - a.t0 > a.hold){
      exitPos();
      G.autoPlan = null;
    }
  }
}

/* ---------- HUD / DOM ---------- */
function renderStatic(){
  el.balVal.textContent = fmtCoins(G.bal);
  const m = G.bal/(G.seed || 1);
  el.runMult.textContent = fmtX(m);
  el.runMult.className = m > 1.001 ? 'up' : m < 0.999 ? 'down' : '';
  el.bestVal.textContent = best > 0 ? fmtCoins(best) : '—';
}

function renderDynamic(){
  // непрерывное (плавные анимации): таймер-кольцо, виньетка
  el.timerVal.textContent = fmtTime(G.timeLeft);
  el.timerVal.classList.toggle('urgent', G.timeLeft < 10000 && G.phase === 'run');
  const frac = clamp(1 - G.timeLeft/CFG.roundMs, 0, 1);
  el.ringArc.style.strokeDashoffset = RING_LEN*(1 - frac);
  if(G.pos && G.phase === 'run'){
    const prox = liqProx();
    const beat = 0.5 + 0.5*Math.sin(G.t/lerp(300, 90, prox));
    el.vignette.style.opacity = prox > 0.35 ? (0.2 + 0.55*sstep(0.35, 1, prox))*(0.6 + 0.4*beat) : 0;
  }
  // числа — читаемым темпом ~5 раз/с, без мерцания на каждый тик
  if(G.t < G.uiNext) return;
  G.uiNext = G.t + 200;
  renderNumbers();
}

function renderNumbers(){
  if(G.pos){
    const pnl = posPnl();
    const cls = pnl >= 0 ? 'pos' : 'neg';
    const coins = G.bal*pnl;
    el.plCoins.textContent = (coins >= 0 ? '+' : '-') +
      Math.abs(coins).toFixed(Math.abs(coins) >= 100 ? 0 : 1).replace(/\B(?=(\d{3})+(?!\d))/g,' ');
    el.plCoins.className = cls;
    el.plPct.textContent = fmtPct(pnl);
    el.plPct.className = cls;
    el.curVal.textContent = fmtPrice(G.visPrice);
    const noLiq = G.pos.liq === null;
    el.liqBlock.classList.toggle('hidden', noLiq);
    if(!noLiq){
      const prox = liqProx();
      const distG = (100/G.pos.lev)*(1 - prox); // в «игровых» процентах хода цены
      el.liqLabel.textContent = 'to liquidation: ' +
        distG.toFixed(1) + '%';
      el.liqLabel.classList.toggle('hot', prox > 0.6);
      el.liqFill.style.width = Math.max(2, prox*100) + '%';
    }
    el.exitSub.textContent = '→ ' + fmtCoins(G.bal*(1 + pnl));
  } else {
    el.flatPrice.textContent = fmtPrice(G.visPrice);
    if(FEED.pctHour !== null){
      el.flatPct.textContent = fmtPct(FEED.pctHour) + ' past hour';
      el.flatPct.className = FEED.pctHour >= 0 ? 'up' : 'down';
    } else el.flatPct.textContent = '';
  }
}

function showMsg(text, cls){
  el.msg.textContent = text;
  el.msg.className = '';
  void el.msg.offsetWidth;
  el.msg.className = cls + ' show';
  clearTimeout(msgTimer);
  msgTimer = setTimeout(()=>{ el.msg.className=''; }, 900);
}

function floatText(text, cls, big){
  const d = document.createElement('div');
  d.className = 'float ' + (cls||'') + (big ? ' big' : '');
  d.textContent = text;
  d.style.left = '50%';
  d.style.transform = 'translateX(-50%)';
  d.style.top = (30 + rand(-4,4)) + '%';
  el.floatLayer.appendChild(d);
  d.addEventListener('animationend', ()=>d.remove());
  setTimeout(()=>d.remove(), 1400);
}

/* ---------- график ---------- */
let dpr = 1;
function fitCanvas(cv, ctx){
  const w = cv.clientWidth, h = cv.clientHeight;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  const W = Math.round(w*dpr), H = Math.round(h*dpr);
  if(cv.width !== W || cv.height !== H){ cv.width = W; cv.height = H; }
  ctx.setTransform(dpr,0,0,dpr,0,0);
  return {w,h};
}
function roundRect(ctx,x,y,w,h,r){
  if(w < 0){ x += w; w = -w; }
  if(h < 0){ y += h; h = -h; }
  r = Math.max(0, Math.min(r, w/2, h/2));
  if(ctx.roundRect){ ctx.beginPath(); ctx.roundRect(x,y,w,h,r); return; }
  ctx.beginPath();
  ctx.moveTo(x+r,y);
  ctx.arcTo(x+w,y,x+w,y+h,r); ctx.arcTo(x+w,y+h,x,y+h,r);
  ctx.arcTo(x,y+h,x,y,r); ctx.arcTo(x,y,x+w,y,r);
  ctx.closePath();
}

function tickStep(span){
  const target = span/4.5;
  const steps = [1,2,5,10,20,25,50,100,200,250,500,1000,2000,5000,10000,20000];
  for(const s of steps) if(s >= target) return s;
  return 10000;
}

function drawChart(dt){
  const {w,h} = fitCanvas(el.chart, chartCtx);
  const ctx = chartCtx;
  ctx.clearRect(0,0,w,h);
  if(!G) return;

  const xRight = w*0.84;
  const slotW = xRight/CFG.vis;
  const len = G.candles.length;
  const frac = clamp((G.simTime - G.cur.t0)/CFG.candleSec, 0, 1);
  const X = i => xRight - (len + frac - i)*slotW + slotW*0.5;
  const i0 = Math.max(0, len - CFG.vis - 2);

  // диапазон
  let vmin = Infinity, vmax = -Infinity;
  for(let i=i0;i<len;i++){
    const c = G.candles[i];
    if(c.l < vmin) vmin = c.l;
    if(c.h > vmax) vmax = c.h;
  }
  vmin = Math.min(vmin, G.cur.l); vmax = Math.max(vmax, G.cur.h);
  if(G.pos){
    vmin = Math.min(vmin, G.pos.entry);
    vmax = Math.max(vmax, G.pos.entry);
    if(G.pos.liq !== null){
      // линию ликвидации включаем в диапазон, только если она недалеко —
      // иначе (×2 = 50% хода) не плющить свечи, линия прижмётся к краю
      const span = Math.max(vmax - vmin, G.visPrice*0.004);
      if(G.pos.liq > vmin - span*0.9 && G.pos.liq < vmax + span*0.9){
        vmin = Math.min(vmin, G.pos.liq);
        vmax = Math.max(vmax, G.pos.liq);
      }
    }
  }
  if(!isFinite(vmin)){ vmin = G.visPrice*0.999; vmax = G.visPrice*1.001; }
  const pad = Math.max((vmax - vmin)*0.14, G.visPrice*0.002);
  vmin -= pad; vmax += pad;
  const k = 1 - Math.exp(-dt/1000*8);
  if(!G.viewInit){ G.vmin = vmin; G.vmax = vmax; G.viewInit = true; }
  G.vmin = lerp(G.vmin, vmin, k);
  G.vmax = lerp(G.vmax, vmax, k);
  const yTop = h*0.06, yBot = h*0.97;
  const Y = p => yBot - (p - G.vmin)/(G.vmax - G.vmin)*(yBot - yTop);

  // зона PnL: между входом и текущей ценой (как в макетах 1928/1929)
  if(G.pos){
    const pnl = posPnl();
    const y1 = Y(G.pos.entry), y2 = Y(G.visPrice);
    ctx.fillStyle = pnl >= 0 ? 'rgba(19,168,109,.30)' : 'rgba(245,64,64,.30)';
    ctx.fillRect(0, Math.min(y1,y2), w, Math.max(2, Math.abs(y2-y1)));
  }

  // сетка: горизонтали по тикам оси + вертикали, скроллящиеся со свечами
  const step = tickStep(G.vmax - G.vmin);
  ctx.strokeStyle = 'rgba(255,253,243,.8)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5,7]);
  const t0 = Math.ceil(G.vmin/step)*step;
  const ticks = [];
  for(let p=t0; p<=G.vmax; p+=step){
    const y = Y(p);
    ticks.push([p,y]);
    ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(w,y); ctx.stroke();
  }
  for(let i = Math.floor(i0/4)*4; i <= len+2; i += 4){
    const x = X(i);
    if(x < -5 || x > w+5) continue;
    ctx.beginPath(); ctx.moveTo(x, yTop-8); ctx.lineTo(x, yBot+8); ctx.stroke();
  }
  ctx.setLineDash([]);

  // линия входа
  if(G.pos){
    ctx.setLineDash([6,6]);
    ctx.strokeStyle = 'rgba(75,63,94,.55)';
    ctx.lineWidth = 2;
    const ye = Y(G.pos.entry);
    ctx.beginPath(); ctx.moveTo(0,ye); ctx.lineTo(w,ye); ctx.stroke();
    ctx.setLineDash([]);
  }

  // свечи (ширина тела — пропорция макета: 19.4px тела в 27px слота)
  const bw = slotW*0.72;
  for(let i=i0;i<len;i++) drawCandle(ctx, X(i), G.candles[i], bw, Y);
  drawCandle(ctx, X(len), G.cur, bw, Y);

  // линия ликвидации: пульсирует при приближении (у ×1 её нет)
  if(G.pos && G.pos.liq !== null){
    const prox = liqProx();
    let yl = Y(G.pos.liq);
    const offEdge = yl > yBot + 2 || yl < yTop - 2; // далёкая ликвидация (низкое плечо)
    if(offEdge) yl = clamp(yl, yTop, yBot);
    const pulse = 0.5 + 0.5*Math.sin(G.t/lerp(260, 80, prox));
    ctx.save();
    // «свечение» без shadowBlur (дорог на Retina в цикле): широкая бледная подложка
    if(prox > 0.4){
      ctx.setLineDash([10,7]);
      ctx.strokeStyle = `rgba(214,59,60,${0.28*pulse*sstep(0.4,1,prox)})`;
      ctx.lineWidth = 9;
      ctx.beginPath(); ctx.moveTo(0,yl); ctx.lineTo(w,yl); ctx.stroke();
    }
    ctx.setLineDash([10,7]);
    ctx.strokeStyle = `rgba(214,59,60,${0.75 + 0.25*pulse})`;
    ctx.lineWidth = 2.5 + (prox > 0.4 ? 2.2*pulse*sstep(0.4,1,prox) : 0);
    ctx.beginPath(); ctx.moveTo(0,yl); ctx.lineTo(w,yl); ctx.stroke();
    ctx.setLineDash([]);
    // ярлык
    const lb = offEdge ? (G.pos.dir > 0 ? '💀 liquidation ↓' : '💀 liquidation ↑') : '💀 liquidation';
    ctx.font = `800 ${w*0.032}px ui-rounded,-apple-system,Arial`;
    const tw = ctx.measureText(lb).width + w*0.04;
    const lh = w*0.055;
    const yPill = clamp(yl - lh/2, 2, h - lh - 2);
    ctx.fillStyle = '#d63b3c';
    roundRect(ctx, w*0.025, yPill, tw, lh, lh/2); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(lb, w*0.045, yPill + lh/2 + 1);
    ctx.restore();
  }

  // подписи оси (поверх сетки, справа)
  ctx.font = `800 ${w*0.042}px ui-rounded,-apple-system,Arial`;
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillStyle = 'rgba(92,81,72,.9)';
  for(const [p,y] of ticks){
    if(y > yTop-2 && y < yBot+2) ctx.fillText(fmtPrice(p), w - w*0.02, y);
  }

  // ценник текущей цены (синий, у правого края)
  const yp = Y(G.visPrice);
  const label = fmtPrice(G.visPrice);
  ctx.font = `900 ${w*0.042}px ui-rounded,-apple-system,Arial`;
  const tw2 = ctx.measureText(label).width + w*0.045;
  const th = w*0.075;
  const yTag = clamp(yp - th/2, 2, h - th - 2);
  ctx.fillStyle = 'rgba(45,75,216,.35)';
  roundRect(ctx, w - tw2 - 2, yTag + 2, tw2 + w*0.03, th, th*0.4); ctx.fill(); // «тень»
  ctx.fillStyle = '#4068f5';
  roundRect(ctx, w - tw2 - 2, yTag, tw2 + w*0.03, th, th*0.4); ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText(label, w - w*0.018, yTag + th/2 + 1);
}

function drawCandle(ctx, x, c, bw, Y){
  const up = c.c >= c.o;
  const col = up ? '#13a86d' : '#f54040'; // цвета свечей из макета
  const yO = Y(c.o), yC = Y(c.c);
  const top = Math.min(yO,yC), bot = Math.max(yO,yC);
  const bh = Math.max(3, bot-top);
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(1.6, bw*0.10);
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x, Y(c.h)); ctx.lineTo(x, Y(c.l)); ctx.stroke();
  ctx.fillStyle = col;
  roundRect(ctx, x - bw/2, top, bw, bh, Math.min(3, bw*0.18));
  ctx.fill();
}

/* ---------- fx: конфетти + трещины ---------- */
const CONF_COLORS = ['#4068f5','#f54040','#13a86d','#f5a623','#ffffff','#8a6cf0'];
function burstConfetti(n, fx=0.5, fy=0.35){
  const r = el.game.getBoundingClientRect();
  const cx = r.width*fx, cy = r.height*fy;
  for(let i=0;i<n;i++){
    const a = rand(0, Math.PI*2), sp = rand(120, 520);
    particles.push({
      x:cx, y:cy,
      vx:Math.cos(a)*sp, vy:Math.sin(a)*sp - 220,
      rot:rand(0,6.28), vr:rand(-9,9),
      w:rand(5,10), h:rand(8,16),
      color:CONF_COLORS[randInt(0,CONF_COLORS.length-1)],
      life:rand(0.9,1.6), t:0,
    });
  }
}

function makeCracks(){
  const r = el.game.getBoundingClientRect();
  const cx = r.width/2, cy = r.height*0.38;
  const segs = [];
  const rays = randInt(11, 15);
  for(let i=0;i<rays;i++){
    const a0 = (i/rays)*Math.PI*2 + rand(-0.2,0.2);
    let x = cx, y = cy, a = a0;
    const steps = randInt(4, 8);
    const segLen = rand(0.05, 0.10)*Math.max(r.width, r.height);
    for(let sIdx=0;sIdx<steps;sIdx++){
      const nx = x + Math.cos(a)*segLen*rand(0.6,1.3);
      const ny = y + Math.sin(a)*segLen*rand(0.6,1.3);
      segs.push({x1:x, y1:y, x2:nx, y2:ny, lw: lerp(3.4, 0.8, sIdx/steps)});
      // ответвление
      if(sIdx > 0 && Math.random() < 0.35){
        const ba = a + rand(0.5, 1.1)*(Math.random()<0.5?1:-1);
        segs.push({x1:x, y1:y,
                   x2:x + Math.cos(ba)*segLen*0.7, y2:y + Math.sin(ba)*segLen*0.7,
                   lw:1.1});
      }
      x = nx; y = ny; a += rand(-0.35, 0.35);
    }
  }
  cracks = { segs, t: 0, cx, cy };
}

function drawFx(dt){
  const {w,h} = fitCanvas(el.fx, fxCtx);
  const ctx = fxCtx;
  ctx.clearRect(0,0,w,h);
  const step = paused ? 0 : dt/1000;

  if(cracks){
    cracks.t += step*1000;
    // вспышка первые 200 мс
    if(cracks.t < 200){
      ctx.fillStyle = `rgba(255,245,235,${0.85*(1 - cracks.t/200)})`;
      ctx.fillRect(0,0,w,h);
    }
    const grow = sstep(0, 260, cracks.t); // трещины разбегаются
    const n = Math.ceil(cracks.segs.length*grow);
    ctx.strokeStyle = 'rgba(70,40,38,.85)';
    ctx.lineCap = 'round';
    for(let i=0;i<n;i++){
      const s = cracks.segs[i];
      ctx.lineWidth = s.lw;
      ctx.beginPath(); ctx.moveTo(s.x1,s.y1); ctx.lineTo(s.x2,s.y2); ctx.stroke();
    }
    // белёсые сколы вокруг центра
    ctx.strokeStyle = 'rgba(255,253,243,.5)';
    ctx.lineWidth = 1;
    for(let i=0;i<n;i+=3){
      const s = cracks.segs[i];
      ctx.beginPath(); ctx.moveTo(s.x1+1.5,s.y1+1.5); ctx.lineTo(s.x2+1.5,s.y2+1.5); ctx.stroke();
    }
  }

  for(let i=particles.length-1;i>=0;i--){
    const p = particles[i];
    p.t += step;
    if(p.t >= p.life){ particles.splice(i,1); continue; }
    p.vy += 900*step;
    p.vx *= (1 - 1.4*step);
    p.x += p.vx*step; p.y += p.vy*step;
    p.rot += p.vr*step;
    const fade = 1 - sstep(0.6, 1, p.t/p.life);
    ctx.save();
    ctx.globalAlpha = fade;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h*Math.abs(Math.sin(p.rot*1.7)+0.3));
    ctx.restore();
  }
}

/* ---------- звук (крошечный синт) ---------- */
let AC = null;
function tone(f, t0, dur, type='triangle', vol=0.14, slideTo=0){
  try{
    if(!AC) AC = new (window.AudioContext||window.webkitAudioContext)();
    if(AC.state === 'suspended') AC.resume();
    const o = AC.createOscillator(), g = AC.createGain();
    const T = AC.currentTime + t0;
    o.type = type;
    o.frequency.setValueAtTime(f, T);
    if(slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, T+dur);
    g.gain.setValueAtTime(0.0001, T);
    g.gain.linearRampToValueAtTime(vol, T+0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, T+dur);
    o.connect(g); g.connect(AC.destination);
    o.start(T); o.stop(T+dur+0.05);
  }catch(e){}
}
const sEnter  = ()=>{tone(520,0,0.08,'triangle',0.12); tone(700,0.06,0.1,'triangle',0.1);};
const sWin    = ()=>{tone(660,0,0.09); tone(880,0.08,0.16);};
const sBigWin = ()=>{[660,880,1100,1320,1660].forEach((f,i)=>tone(f,i*0.07,0.14,'triangle',0.16));};
const sLose   = ()=>tone(300,0,0.25,'sawtooth',0.09,170);
const sLiq    = ()=>{
  tone(150,0,0.6,'sawtooth',0.22,40);
  tone(90,0.05,0.7,'square',0.14,35);
  tone(1200,0,0.08,'square',0.06,300);
};
const sTick   = f=>tone(f,0,0.05,'square',0.05);
const sThump  = ()=>{tone(72,0,0.1,'sine',0.22,55); tone(58,0.12,0.09,'sine',0.14,48);};
const sStart  = ()=>{tone(520,0,0.1); tone(780,0.09,0.16);};

/* ---------- main loop ---------- */
let lastT = 0;
function frame(t){
  if(window.__freeze){ lastT = 0; requestAnimationFrame(frame); return; } // для CDP-скринов
  const dt = Math.min(50, lastT ? t-lastT : 16);
  lastT = t;
  if(running && !paused && G){
    update(dt);
    if(G) renderDynamic();
  }
  drawChart(paused ? 0 : dt);
  drawFx(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------- flow ---------- */
let starting = false; // гард от даблтапа Play/Restart: второй вызов во время await — no-op
async function startGame(){
  if(starting) return;
  starting = true;
  try{
    el.playBtn.disabled = true;
    await Promise.race([FEED.readyPromise, new Promise(r=>setTimeout(r, 3000))]);
    el.playBtn.disabled = false;
    if(!FEED.ready){ FEED.anchor = 63370; FEED.ready = true; }
    el.startScreen.classList.add('hidden');
    el.overScreen.classList.add('hidden');
    el.pauseScreen.classList.add('hidden');
    paused = false;
    newGame();
    running = true;
    try{ sStart(); }catch(e){} // звук не должен ронять старт (авто-плей политика браузера)
  }finally{
    starting = false;
    el.playBtn.disabled = false;
  }
}
function togglePause(force){
  if(!running) return;
  paused = force !== undefined ? force : !paused;
  el.pauseScreen.classList.toggle('hidden', !paused);
}

/* ---------- input ---------- */
el.playBtn.addEventListener('click', startGame);
el.againBtn.addEventListener('click', startGame);
el.restartBtn.addEventListener('click', startGame);
el.resumeBtn.addEventListener('click', ()=>togglePause(false));
/* «Exit to menu» в паузе — IIFE-сниппет оркестратора в конце файла (hubExitBtn) */
el.pauseBtn.addEventListener('pointerdown', e=>{ e.preventDefault(); togglePause(); });

el.btnLong.addEventListener('pointerdown', e=>{ e.preventDefault(); enter(1); });
el.btnShort.addEventListener('pointerdown', e=>{ e.preventDefault(); enter(-1); });
el.btnExit.addEventListener('pointerdown', e=>{
  e.preventDefault();
  if(running && !paused && G && G.phase === 'run') exitPos();
});

window.addEventListener('keydown', e=>{
  if(e.repeat) return;
  if(e.key === 'ArrowUp' || e.key === 'w') enter(1);
  else if(e.key === 'ArrowDown' || e.key === 's') enter(-1);
  else if(e.key === ' '){
    if(!running){ startGame(); return; }
    if(G && G.pos && G.phase === 'run' && !paused) exitPos();
  }
  else if(e.key >= '1' && e.key <= '5') { if(!(G&&G.pos)) setLev(+e.key - 1); }
  else if(e.key === 'p' || e.key === 'Escape') togglePause();
});

document.addEventListener('visibilitychange', ()=>{
  // в ?auto не паузим: самоигра должна крутиться и в фоновом окне (запись/тесты)
  if(document.hidden && running && !AUTO) togglePause(true);
});
document.addEventListener('touchmove', e=>e.preventDefault(), {passive:false});

/* ---------- init ---------- */
feedInit();
setLev(2); // ×3 по умолчанию
if(best > 0){
  el.startBest.classList.remove('hidden');
  el.startBestVal.textContent = fmtCoins(best);
  el.bestVal.textContent = fmtCoins(best);
}
if(AUTO) startGame();

/* hub: выход в меню из паузы (только в iframe хаба; добавлено оркестратором 24.07) */
(function(){
  if (window.parent === window) return;
  function mount(){
    if (document.getElementById('hubExitBtn')) return;
    var anchor = document.getElementById('restartBtn');
    if (!anchor) return;
    var b = document.createElement('button');
    b.id = 'hubExitBtn'; b.className = 'ghostBtn'; b.textContent = 'Exit to menu';
    b.addEventListener('click', function(){
      try { window.parent.postMessage({type:'hub:exit', game:'plechi'}, '*'); } catch(e){}
    });
    anchor.insertAdjacentElement('afterend', b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
