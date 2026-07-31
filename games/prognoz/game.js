'use strict';
/* ============================================================
   УГАДАЙ СВЕЧУ — тап-аркада. Прототип #1 tap-trading hub.
   Реальные данные BTC: Binance REST (история) + WebSocket (лайв),
   при отсутствии сети — генератор от последней реальной цены.
   Vanilla JS + canvas, без зависимостей.
   ============================================================ */

const $ = s => document.querySelector(s);
const clamp = (v,a,b)=>v<a?a:v>b?b:v;
const lerp = (a,b,t)=>a+(b-a)*t;
const rand = (a,b)=>a+Math.random()*(b-a);
const randInt = (a,b)=>Math.floor(rand(a,b+1));
const easeOutCubic = t=>1-Math.pow(1-t,3);
const sstep = (a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t)};
const fmt = n=>Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g,' ');
const fmtPrice = p=>Math.round(p).toString().replace(/\B(?=(\d{3})+(?!\d))/g,',');

const CFG = {
  decideMs: 3000,       // окно решения — 3 секунды (решение владельца 24.07)
  revealLiveMs: 2600,   // формирование живой свечи из реальных сделок
  revealSimMs: 1500,    // рост свечи в оффлайн-режиме
  resolveMs: 900,
  deathMs: 1300,
  vis: 9,
  maxCandles: 60,       // жёсткий кап истории (память)
  superFirst: [3,5],
  superNext: [8,12],
  ringC: 276.5,         // длина окружности кольца таймера (2π·44)
};

const BOTS = [
  {n:'Alex', s:2564},
  {n:'Tony Scorpos', s:2433},
  {n:'Fill Simpany', s:2240},
  {n:'QuietTrader', s:2222},
  {n:'Satoshi Jr', s:2200},
  {n:'LunaHodler', s:2150},
];

/* ---------- DOM ---------- */
const el = {
  game: $('#game'),
  chart: $('#chart'), fx: $('#fx'), chartWrap: $('#chartWrap'),
  hearts: [...document.querySelectorAll('.hp')],
  score: $('#scoreVal'), streak: $('#streakVal'),
  multChip: $('#multChip'), segs: [...document.querySelectorAll('#segBar i')],
  netBadge: $('#netBadge'), msg: $('#msg'), floatLayer: $('#floatLayer'),
  countNum: $('#countNum'), ringArc: document.querySelector('#ring .rarc'),
  controls: $('#controls'), btnUp: $('#btnUp'), btnDown: $('#btnDown'),
  startScreen: $('#startScreen'), pauseScreen: $('#pauseScreen'), overScreen: $('#overScreen'),
  playBtn: $('#playBtn'), againBtn: $('#againBtn'), homeBtn: $('#homeBtn'),
  resumeBtn: $('#resumeBtn'), restartBtn: $('#restartBtn'), pauseBtn: $('#pauseBtn'),
  finalScore: $('#finalScore'), bonusPill: $('#bonusPill'),
  stCorrect: $('#stCorrect'), stStreak: $('#stStreak'), stMult: $('#stMult'),
  board: $('#board'),
};

const chartCtx = el.chart.getContext('2d');
const fxCtx = el.fx.getContext('2d');

/* ---------- persistent ---------- */
let best = 0;
try { best = +localStorage.getItem('prognozBest') || 0; } catch(e){}
function saveBest(){ try { localStorage.setItem('prognozBest', String(best)); } catch(e){} }

/* ---------- hub-экономика (решение владельца, 24.07) ----------
   Из хаба игрок заходит ВСЕМ балансом кошелька (localStorage hub.balance):
   верный прогноз = +BASE_WIN × текущий множитель серии (та же кривая multFor,
   что и полоска ×1→×2 в HUD — UI и математика согласованы), супер-свеча ×2;
   промах ИЛИ таймаут = −PENALTY. В хаб уходит дельта за раунд.
   Точная кривая роста — вопрос владельцу; пока кривая multFor (×1→×2). */
const BASE_WIN = 50;   // чипов за верный прогноз (умножается на множитель серии)
const PENALTY  = 60;   // чипов за промах/таймаут

function hubStartBal(){
  if(window.parent === window) return null; // standalone — старая внутренняя экономика
  try{
    const v = parseInt(localStorage.getItem('hub.balance'), 10);
    // отрицательный кошелёк клампим в 0: у мультипликативных игр отрицательная
    // котлета ломает математику, здесь держим единое правило всех четырёх игр
    if(Number.isFinite(v)) return Math.max(0, v);
  }catch(e){}
  return null;
}

/* ---------- множитель: 10 ступеней ×1 → ×2 (по макету) ---------- */
function multFor(streak){ return streak<=0 ? 1 : Math.min(2, 1+(streak-1)/9); }
function multText(streak){
  if(streak<=0) return '-';
  const r = Math.round(multFor(streak)*10)/10;
  return 'x' + (r%1 ? r.toFixed(1) : String(r));
}
function tierFor(streak){ const m=multFor(streak); return m>=2?'t3':m>=1.5?'t2':'t1'; }
function pointsFor(streak){ return Math.min(200, Math.round(100*multFor(streak)/10)*10); }

/* ---------- Binance feed ---------- */
const Feed = {
  live:false, ws:null, price:0, lastTradeT:0,
  seedData:null, seedT:0, _reT:null,

  async seed(){
    try{
      const r = await fetch('https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1s&limit=48');
      const k = await r.json();
      if(!Array.isArray(k) || k.length < 8) throw new Error('bad klines');
      const out = [];
      for(let i=0; i+3 < k.length; i+=4){ // 4 секундных бара → одна 4с-свеча игры
        const seg = k.slice(i, i+4);
        const c = {
          open: +seg[0][1],
          high: Math.max(...seg.map(s=>+s[2])),
          low:  Math.min(...seg.map(s=>+s[3])),
          close:+seg[seg.length-1][4],
        };
        // только валидные числа — NaN в координатах ломает отрисовку
        if([c.open,c.high,c.low,c.close].every(v=>isFinite(v) && v>0)) out.push(c);
      }
      if(out.length < 4) throw new Error('bad seed');
      this.seedData = out;
      this.seedT = performance.now();
      if(!this.price) this.price = out[out.length-1].close;
    }catch(e){ /* сеть недоступна — играем на генераторе */ }
  },

  connect(){
    if(this.ws && this.ws.readyState <= 1) return; // сокет уже жив — второго не плодим
    let ws;
    try{ ws = new WebSocket('wss://stream.binance.com:9443/ws/btcusdt@trade'); }
    catch(e){ this.markDead(); return; }
    this.ws = ws;
    ws.onmessage = e=>{
      let p = 0;
      try{ p = +JSON.parse(e.data).p; }catch(_){ return; }
      if(!(p > 0)) return;
      this.price = p;
      this.lastTradeT = performance.now();
      if(!this.live){ this.live = true; updateNetBadge(); }
      onTradeTick(p);
    };
    ws.onclose = ()=>{ if(this.ws === ws) this.ws = null; this.markDead(); };
    ws.onerror = ()=>{ try{ ws.close(); }catch(_){} };
  },

  markDead(){
    if(this.live){ this.live = false; updateNetBadge(); }
    clearTimeout(this._reT);
    this._reT = setTimeout(()=>this.connect(), 3000);
  },

  fresh(){ return this.live && performance.now() - this.lastTradeT < 8000; },
};

// сторож: тихо умерший сокет (нет сделок >10с) закрываем → onclose переподключит
setInterval(()=>{
  if(Feed.live && performance.now() - Feed.lastTradeT > 10000){
    try{ Feed.ws && Feed.ws.close(); }catch(_){}
  }
}, 5000);

function updateNetBadge(){ el.netBadge.classList.toggle('hidden', Feed.live); }

function onTradeTick(p){
  if(!G || paused) return;
  // синтетическая история могла быть сгенерена от устаревшей цены —
  // при первой живой сделке сдвигаем её к реальному уровню (иначе разрыв плющит график)
  if(G.synthetic && !G.anchored){
    G.anchored = true;
    const delta = p - G.price;
    if(Math.abs(delta) > G.unit*2){
      for(const c of G.candles){ c.open+=delta; c.high+=delta; c.low+=delta; c.close+=delta; }
      if(G.next && G.next.open !== undefined && !G.next.liveForming){
        G.next.open+=delta; G.next.high+=delta; G.next.low+=delta; G.next.close+=delta;
      }
      G.price += delta;
      G.viewInit = false; // мгновенно перецентрировать вью
      G.camLock = false;  // и перефиксировать замороженную камеру окна решения
    }
  }
  if(G.phase === 'reveal' && G.next && G.next.liveForming){
    const c = G.next;
    c.close = p;
    if(p > c.high) c.high = p;
    if(p < c.low) c.low = p;
  }
}

/* ---------- game state ---------- */
let G = null;
let running = false;
let paused = false;
let msgTimer = null;
const particles = [];
const AUTO = new URLSearchParams(location.search).has('auto');
// онбординг из хаба (?tut=1): раунд = РОВНО 5 прогнозов, жизни не кончаются
const TUT = new URLSearchParams(location.search).has('tut');
const TUT_PREDICTS = 5;

function newGame(){
  const hubBal = hubStartBal(); // читается на старте КАЖДОГО раунда — свежий кошелёк хаба
  G = {
    hubMode: hubBal !== null, startBal: hubBal || 0, bal: hubBal || 0,
    score:0, lives:3, streak:0,
    correct:0, bestStreak:0, decisions:0, formDir:0, formDirT:0,
    candles:[], next:null,
    phase:'decide', phaseT:0, t:0,
    pick:null, timedOut:false, revealDur:CFG.revealLiveMs,
    price: Feed.price || 61750, unit: 4,
    prevDir:1, trendDir:1, trendLeft:0,
    superIn: randInt(CFG.superFirst[0], CFG.superFirst[1]),
    off:0, vmin:0, vmax:1, viewInit:false, camLock:false,
    animHi:0, animLo:0, newRecord:false,
    dLast:0, med:1, // дисплей-цепочка: визуальный масштаб развязан от сырых цен
  };
  // история: реальные свечи с Binance, если есть свежий сид; иначе генератор
  const sd = (Feed.seedData && performance.now()-Feed.seedT < 120000) ? Feed.seedData : null;
  if(sd){
    G.candles = sd.slice(-12).map(c=>({
      open:c.open, high:c.high, low:c.low, close:c.close,
      dir: c.close >= c.open ? 1 : -1, super:false, result:null,
    }));
    G.price = sd[sd.length-1].close;
    const ranges = sd.map(c=>c.high-c.low).filter(r=>r>0);
    G.unit = Math.max(
      ranges.length ? ranges.reduce((a,b)=>a+b,0)/ranges.length*0.6 : 0,
      G.price*1.2e-5);
    if(Feed.fresh()) G.price = Feed.price;
  }else{
    G.unit = Math.max(G.price*1.2e-5, 0.5);
    for(let i=0;i<10;i++) G.candles.push(seedCandle());
    G.synthetic = true; // история сгенерена — перецентрируем к первой живой цене
  }
  // визуальное усиление: 1 дисплей-единица ≈ типичное тело свечи. Реальные
  // 4с-движения BTC (~0.001%) без усиления рисуются плоскими чёрточками.
  const bodies = G.candles.map(c=>Math.abs(c.close-c.open));
  G.med = Math.max(
    bodies.length ? bodies.reduce((a,b)=>a+b,0)/bodies.length : 0,
    G.price*2e-6, 0.004);
  G.dLast = 0;
  for(const c of G.candles) finalizeDisplay(c);

  G.off = G.candles.length - 7;
  particles.length = 0;
  el.floatLayer.innerHTML = '';
  el.msg.className = '';
  Feed.seed(); // асинхронно освежить историю к следующей партии
  startDecide();
  renderHUD();
}

/* ---------- generator (оффлайн-фолбэк) ---------- */
function genOHLC(isSuper){
  let pUp;
  if(G.trendLeft > 0){
    pUp = G.trendDir > 0 ? 0.74 : 0.26;
    G.trendLeft--;
  } else if(Math.random() < 0.3){
    G.trendDir = Math.random() < 0.5 ? 1 : -1;
    G.trendLeft = randInt(3,6);
    pUp = G.trendDir > 0 ? 0.74 : 0.26;
  } else {
    pUp = G.prevDir > 0 ? 0.55 : 0.45;
  }
  const dir = Math.random() < pUp ? 1 : -1;
  const body = (isSuper ? rand(2.0,3.0) : rand(0.5,1.6)) * G.unit;
  const open = G.price;
  const close = open + dir*body;
  const high = Math.max(open,close) + rand(0.05,0.5)*body;
  const low  = Math.min(open,close) - rand(0.05,0.5)*body;
  G.price = close;
  G.prevDir = dir;
  return {open, close, high, low, dir, fake:Math.random()<0.38, wseed:rand(0,6.28)};
}
function seedCandle(){
  const c = genOHLC(false);
  return {...c, super:false, result:null};
}

/* ---------- дисплей-масштаб свечей ----------
   Тело в дисплей-единицах = |реальное тело|/G.med с клампами (обычная 0.4–2.4,
   супер 1.6–3.2): направление всегда реальное, пропорции — как в макете.
   Цепочка dO→dC неразрывна. Шкала справа остаётся реальной: цены
   восстанавливаются обратным преобразованием через G.med. */
function finalizeDisplay(c){
  const m = G.med;
  const body = c.close - c.open;
  const minB = c.super ? 1.6 : 0.4;
  const maxB = c.super ? 3.2 : 2.4;
  const mag = clamp(Math.abs(body)/m, minB, maxB);
  const dir = c.dir > 0 ? 1 : -1;
  c.dO = G.dLast;
  c.dC = c.dO + dir*mag;
  c.dH = Math.max(c.dO,c.dC) + clamp((c.high - Math.max(c.open,c.close))/m, 0.18, 1.3)*0.6;
  c.dL = Math.min(c.dO,c.dC) - clamp((Math.min(c.open,c.close) - c.low)/m, 0.18, 1.3)*0.6;
  G.dLast = c.dC;
  // EMA волатильности: усиление само подстраивается под живой рынок
  G.med = Math.max(0.7*G.med + 0.3*Math.abs(body), G.price*2e-6, 0.004);
}

// дисплей-геометрия формирующейся свечи (на лету; без нижнего клампа тела —
// свеча визуально растёт от нуля, финальные пропорции даст finalizeDisplay)
function formingDisplay(){
  const c = G.next;
  const o = c.open;
  let cl, hi, lo;
  if(c.liveForming){
    cl = c.close; hi = c.high; lo = c.low;
  }else{
    const t = clamp(G.phaseT / G.revealDur, 0, 1);
    cl = animClose(c, t);
    if(cl > G.animHi) G.animHi = cl;
    if(cl < G.animLo) G.animLo = cl;
    const wickT = sstep(0.5, 1, t);
    hi = Math.max(G.animHi, lerp(G.animHi, c.high, wickT));
    lo = Math.min(G.animLo, lerp(G.animLo, c.low, wickT));
  }
  const m = G.med;
  const body = cl - o;
  // гистерезис направления живой свечи: тик-осцилляции вокруг цены открытия не
  // должны стробить цвет красный↔зелёный каждый кадр (фидбек владельца 24.07).
  // Пока |close−open| в мёртвой зоне — свеча «не определилась» (нейтральный тон),
  // коммит цвета при выходе за зону; обратный флип — только через зону в другую
  // сторону И не чаще раза в ~0.3с (защёлка: даже размашистая пила шире зоны
  // не может стробить кадр-в-кадр — цвет живёт минимум 280 мс).
  if(c.liveForming){
    const db = m * 0.15;
    if(G.formDir === 0){ // первый коммит из нейтрали — без задержки
      if(body > db){ G.formDir = 1; G.formDirT = G.phaseT; }
      else if(body < -db){ G.formDir = -1; G.formDirT = G.phaseT; }
    } else if(G.phaseT - G.formDirT > 280){
      if(G.formDir < 0 && body > db){ G.formDir = 1; G.formDirT = G.phaseT; }
      else if(G.formDir > 0 && body < -db){ G.formDir = -1; G.formDirT = G.phaseT; }
    }
  }
  const gDir = G.formDir !== 0 ? G.formDir : 1; // не определилась — стабильная геометрия вверх
  // нижний кламп тела растёт с прогрессом: свеча «надувается» и к закрытию
  // уже имеет финальный минимум (0.4) — без скачка при фиксации
  const tProg = clamp(G.phaseT / G.revealDur, 0, 1);
  const minB = lerp(0.08, c.super ? 1.6 : 0.4, tProg);
  const mag = clamp(Math.abs(body)/m, minB, c.super ? 3.2 : 2.4);
  const dO = G.dLast;
  const dC = dO + mag*gDir;
  const dH = Math.max(dO,dC) + clamp((hi - Math.max(o,cl))/m, 0, 1.3)*0.6;
  const dL = Math.min(dO,dC) - clamp((Math.min(o,cl) - lo)/m, 0, 1.3)*0.6;
  return {dO, dC, dH, dL, super:c.super, result:null,
          col: G.formDir === 0 ? '#b9a988' : null}; // нейтральный тон до коммита
}

/* ---------- phases ---------- */
function startDecide(){
  G.pick = null;
  G.timedOut = false;
  G.superIn--;
  const isSuper = G.superIn <= 0;
  if(isSuper) G.superIn = randInt(CFG.superNext[0], CFG.superNext[1]);
  G.next = {super:isSuper, liveForming:false, result:null};
  G.phase = 'decide';
  G.phaseT = 0;
  el.btnUp.classList.remove('pale');
  el.btnDown.classList.remove('pale');
  el.controls.classList.remove('locked');
  el.ringArc.style.strokeDasharray = '0 ' + CFG.ringC;
  el.countNum.textContent = '0:' + Math.round(CFG.decideMs/1000);
}

function pick(dir){
  if(!running || paused || !G || G.phase !== 'decide') return;
  if(G.pick === dir) return;
  G.pick = dir; // выбор можно сменить до конца отсчёта
  el.btnUp.classList.toggle('pale', dir !== 'up');
  el.btnDown.classList.toggle('pale', dir !== 'down');
  sPick();
}

function startReveal(timedOut){
  G.timedOut = timedOut;
  const c = G.next;
  if(Feed.fresh()){
    // живая свеча: открытие = текущая цена BTC, дальше её пишут реальные сделки
    c.open = c.high = c.low = c.close = Feed.price;
    c.liveForming = true;
    G.revealDur = CFG.revealLiveMs;
    G.formDir = 0; G.formDirT = 0; // цвет «не определился» — коммит через мёртвую зону (без стробинга)
  }else{
    Object.assign(c, genOHLC(c.super));
    c.liveForming = false;
    G.revealDur = CFG.revealSimMs;
    G.formDir = c.close >= c.open ? 1 : -1; // сим: направление известно сразу
  }
  G.animHi = c.open; G.animLo = c.open;
  G.phase = 'reveal';
  G.phaseT = 0;
  el.controls.classList.add('locked');
  el.countNum.textContent = '0:0';
  el.ringArc.style.strokeDasharray = CFG.ringC + ' ' + CFG.ringC;
}

function resolve(){
  const c = G.next;
  if(c.liveForming){
    c.liveForming = false;
    if(c.close === c.open){
      // мёртвый штиль на рынке за окно — трактуем в пользу игрока
      c.dir = G.pick === 'down' ? -1 : 1;
      const eps = Math.max(G.unit*0.05, 0.01);
      c.close = c.open + c.dir*eps;
      if(c.dir > 0) c.high = Math.max(c.high, c.close);
      else c.low = Math.min(c.low, c.close);
    }else{
      c.dir = c.close > c.open ? 1 : -1;
    }
    G.price = c.close;
    G.prevDir = c.dir;
  }
  finalizeDisplay(c); // зафиксировать дисплей-геометрию (усиленное тело, цепочка)
  G.candles.push(c);
  if(G.candles.length > CFG.maxCandles){
    const cut = G.candles.length - CFG.maxCandles;
    G.candles.splice(0, cut);
    G.off -= cut;
  }

  if(G.timedOut){
    c.result = 'to';
    loseLife('⏱ Too slow!', 'warn');
    sTimeout();
  }else{
    const correctGuess = (G.pick === 'up') === (c.dir > 0);
    c.result = correctGuess ? 'win' : 'lose';
    if(correctGuess) win(c);
    else { loseLife('Missed!', 'bad'); sLose(); }
  }
  renderHUD();
  if(c.result === 'win'){ // бамп чипа множителя (после renderHUD, чтобы класс не затёрся)
    el.multChip.classList.add('bump');
  }
  G.decisions++; // каждый разыгранный прогноз (win/промах/таймаут)
  // онбординг: ровно TUT_PREDICTS прогнозов, потом обычный конец раунда
  if(TUT && G.decisions >= TUT_PREDICTS) G.phase = 'dead';
  else G.phase = G.lives > 0 ? 'resolve' : 'dead';
  G.phaseT = 0;
}

function win(c){
  G.streak++;
  G.correct++;
  if(G.streak > G.bestStreak) G.bestStreak = G.streak;
  let pts = pointsFor(G.streak); // база ×множитель, кап 200
  let superHit = false;
  if(c.super){ pts *= 2; superHit = true; } // супер-свеча удваивает
  G.score += pts;
  if(G.score > best){ best = G.score; G.newRecord = true; }

  // hub-экономика: чипы двигаются вживую на каждом прогнозе
  let chips = 0;
  if(G.hubMode){
    chips = Math.round(BASE_WIN * multFor(G.streak));
    if(c.super) chips *= 2;
    G.bal += chips;
  }

  showMsg('Correct!', 'good');
  floatText('+' + fmt(G.hubMode ? chips : pts), superHit);
  if(superHit){
    floatText('×2!', true, -0.14);
    burstConfetti(60);
    sSuper();
  }else{
    sWin();
  }
}

function loseLife(text, cls){
  if(!TUT) G.lives--; // онбординг: жизни не кончаются — 5 прогнозов доигрываются всегда
  G.streak = 0;
  if(G.hubMode){ // промах/таймаут бьёт по чипам сразу
    G.bal -= PENALTY;
    floatText('−' + PENALTY);
  }
  showMsg(text, cls);
  const idx = G.lives;
  if(el.hearts[idx]){
    el.hearts[idx].classList.remove('pop'); void el.hearts[idx].offsetWidth;
    el.hearts[idx].classList.add('pop');
  }
  el.game.classList.remove('shake'); void el.game.offsetWidth;
  el.game.classList.add('shake');
}

/* hub integration: report the round result to the parent shell (iframe only) */
function reportToHub(earned){
  if(window.parent === window) return; // standalone open — no-op
  try{
    window.parent.postMessage({type:'hub:roundEnd', game:'prognoz', earned:Math.round(earned)}, '*');
  }catch(e){}
}

function gameOver(){
  running = false;
  saveBest();
  if(!G.hubReported){
    G.hubReported = true;
    reportToHub(G.hubMode ? G.bal - G.startBal : G.score); // в хаб — дельта чипов за раунд
  }
  if(G.hubMode){
    const d = G.bal - G.startBal;
    el.finalScore.textContent = (d < 0 ? '−' : '+') + fmt(Math.abs(d));
    const lbl = document.querySelector('.goLbl');
    if(lbl) lbl.textContent = 'Round result';
  }else{
    el.finalScore.textContent = fmt(G.score);
  }
  if(G.bestStreak > 1){
    el.bonusPill.textContent = '+' + multText(G.bestStreak).replace('x','×') + ' streak bonus';
    el.bonusPill.classList.remove('hidden');
  }else{
    el.bonusPill.classList.add('hidden');
  }
  el.stCorrect.textContent = G.correct;
  el.stStreak.textContent = G.bestStreak + '🔥';
  el.stMult.textContent = multText(G.bestStreak).replace('x','×');
  buildBoard();
  el.overScreen.classList.remove('hidden');
  if(G.newRecord) burstConfetti(110, 0.5, 0.25);
}

function buildBoard(){
  const better = BOTS.filter(b=>b.s > G.score).length;
  let rows;
  if(better < BOTS.length){
    rows = [...BOTS, {n:'You', s:G.score, me:true}]
      .sort((a,b)=>b.s-a.s).slice(0,7)
      .map((r,i)=>({...r, rank:i+1}));
  }else{
    // ниже всех ботов — «дальний» ранг, как в макете
    const gap = Math.max(0, BOTS[BOTS.length-1].s - G.score);
    const rank = 7 + Math.min(92, Math.floor(gap/40));
    rows = [
      ...BOTS.map((b,i)=>({...b, rank:i+1})),
      {n:'You', s:G.score, me:true, rank},
    ];
  }
  el.board.innerHTML = rows.map(r=>
    `<div class="row${r.me?' me':''}"><span class="rank">${r.rank}</span>`+
    `<span class="name">${r.n}</span><span class="pts">${fmt(r.s)}</span></div>`
  ).join('');
}

/* ---------- update loop ---------- */
function update(dt){
  G.phaseT += dt;
  G.t += dt;

  switch(G.phase){
    case 'decide': {
      const remMs = CFG.decideMs - G.phaseT;
      el.countNum.textContent = '0:' + Math.max(0, Math.ceil(remMs/1000));
      const f = clamp(G.phaseT/CFG.decideMs, 0, 1);
      el.ringArc.style.strokeDasharray = (f*CFG.ringC) + ' ' + CFG.ringC;
      if(AUTO && G.pick === null && G.phaseT > 1500) pick(Math.random()<0.5?'up':'down');
      if(remMs <= 0) startReveal(G.pick === null);
      break;
    }
    case 'reveal':
      if(G.phaseT >= G.revealDur) resolve();
      break;
    case 'resolve':
      if(G.phaseT >= CFG.resolveMs) startDecide();
      break;
    case 'dead':
      if(G.phaseT >= CFG.deathMs) gameOver();
      break;
  }
}

/* ---------- HUD ---------- */
function renderHUD(){
  // из хаба HUD показывает живой чип-баланс кошелька, standalone — очки
  el.score.textContent = fmt(G.hubMode ? G.bal : G.score);
  el.streak.textContent = G.streak;
  el.multChip.textContent = multText(G.streak);
  el.multChip.className = tierFor(G.streak);
  const lit = Math.min(G.streak, 10);
  const tier = tierFor(G.streak);
  el.segs.forEach((s,i)=>{ s.className = i < lit ? 'on ' + tier : ''; });
  el.hearts.forEach((h,i)=>h.classList.toggle('lost', i >= G.lives));
}

function showMsg(text, cls){
  el.msg.textContent = text;
  el.msg.className = '';
  void el.msg.offsetWidth;
  el.msg.className = cls + ' show';
  clearTimeout(msgTimer);
  msgTimer = setTimeout(()=>{ el.msg.className = ''; }, 900);
}

function floatText(text, superCls, dyFrac){
  if(el.floatLayer.childElementCount > 12) return; // страховка от накопления
  const d = document.createElement('div');
  d.className = 'float' + (superCls ? ' super' : '');
  d.textContent = text;
  d.style.left = (52 + rand(-6,6)) + '%';
  d.style.top = (32 + (dyFrac||0)*100 + rand(-3,3)) + '%';
  el.floatLayer.appendChild(d);
  d.addEventListener('animationend', ()=>d.remove());
  setTimeout(()=>{ if(d.parentNode) d.remove(); }, 1500);
}

/* ---------- canvas helpers ---------- */
function fitCanvas(cv, ctx){
  const w = cv.clientWidth, h = cv.clientHeight;
  const d = Math.min(2, window.devicePixelRatio || 1); // кап DPR: не раздувать бэкинг-стор
  const W = Math.round(w*d), H = Math.round(h*d);
  if(cv.width !== W || cv.height !== H){
    cv.width = W; cv.height = H;
    ctx.setTransform(d,0,0,d,0,0);
  }
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

function niceStep(x){
  const p = Math.pow(10, Math.floor(Math.log10(Math.max(x,1e-9))));
  const m = x/p;
  return (m>=5?5:m>=2?2:1)*p;
}

/* Анимированный close оффлайн-свечи: ease к финалу + дрожь + «обманка». */
function animClose(c, t){
  const e = easeOutCubic(t);
  let v = c.open + (c.close - c.open)*e;
  const range = Math.max(1e-9, c.high - c.low);
  if(c.fake) v += -(c.close - c.open)*0.5*Math.sin(Math.PI*clamp(t/0.45,0,1))*(1-t);
  v += range*0.16*Math.sin(t*17 + c.wseed)*(1-t)*Math.min(1, t*8);
  return clamp(v, c.low, c.high);
}

/* ---------- chart ---------- */
/* Целевое окно Y: плотно вокруг видимых свечей + фикс. запас вокруг якоря
   (последний close). Живая цена в расчёте НЕ участвует — окно решения
   не должно спойлерить направление. Общая формула для заморозки (decide)
   и плавной подгонки (resolve) — переходы сходятся в одну точку без скачка. */
function fitTarget(len, anchorD){
  let vmin = Infinity, vmax = -Infinity;
  const j0 = Math.max(0, Math.floor(G.off) - 1);
  for(let i=j0; i<len; i++){
    const c = G.candles[i];
    if(c.dL < vmin) vmin = c.dL;
    if(c.dH > vmax) vmax = c.dH;
  }
  vmin = Math.min(vmin, anchorD - 1);
  vmax = Math.max(vmax, anchorD + 1);
  if(!isFinite(vmin)){ vmin = -3; vmax = 4; }
  const pad = Math.max((vmax - vmin)*0.12, 0.4);
  vmin -= pad; vmax += pad;
  const minR = 7; // окно минимум ~7 «тел»: свечи мясистые, как в макете
  if(vmax - vmin < minR){
    const mid = (vmin + vmax)/2;
    vmin = mid - minR/2; vmax = mid + minR/2;
  }
  return {vmin, vmax};
}

function drawChart(dt){
  const {w,h} = fitCanvas(el.chart, chartCtx);
  const ctx = chartCtx;
  ctx.clearRect(0,0,w,h);
  if(!G) return;

  const axisW = 54;
  const wPlot = w - axisW;
  const slotW = wPlot / CFG.vis;
  const len = G.candles.length;
  // слот будущей свечи всегда 8-й; панорама на один слот происходит в фазе
  // resolve (свеча уже в истории) — к началу окна решения камера досела
  const targetOff = len - 7;
  const k = 1 - Math.exp(-dt/1000*7);

  // якорь дисплей ↔ реальная цена (последняя закрытая свеча)
  const lastC = len ? G.candles[len-1] : null;
  const anchorReal = lastC ? lastC.close : (Feed.price || G.price);
  const anchorD = lastC ? lastC.dC : 0;
  const cur = Feed.fresh() ? Feed.price : G.price;
  const dCur = anchorD + clamp((cur - anchorReal)/G.med, -2, 2);

  let form = null;
  if(G.phase === 'reveal' && G.next) form = formingDisplay();

  if(G.phase === 'decide'){
    // ОКНО РЕШЕНИЯ: камера полностью заморожена — ни рефитов, ни дрейфа,
    // ни смены подписей оси. Ноль утечки о живой цене до фиксации выбора.
    if(!G.camLock){
      G.off = targetOff; // снап: панорама resolve уже досела (остаток субпиксельный)
      const t = fitTarget(len, anchorD);
      G.vmin = t.vmin; G.vmax = t.vmax;
      G.viewInit = true;
      G.camLock = true;
    }
  }else{
    G.camLock = false;
    G.off = lerp(G.off, targetOff, k);
    let vmin, vmax;
    if(G.phase === 'reveal'){
      // свеча оживает при неподвижной камере; окно расширяется ТОЛЬКО если
      // свеча выходит за кадр (сдерживание, не подгонка) — рефит после, в resolve
      vmin = G.vmin; vmax = G.vmax;
      if(form){
        vmin = Math.min(vmin, form.dL - 0.4);
        vmax = Math.max(vmax, form.dH + 0.4);
      }
    }else{
      // resolve/dead: плавный рефит окна под новую свечу (ease ~0.4 c)
      const t = fitTarget(len, anchorD);
      vmin = t.vmin; vmax = t.vmax;
    }
    if(!G.viewInit){ G.vmin = vmin; G.vmax = vmax; G.viewInit = true; }
    G.vmin = lerp(G.vmin, vmin, k);
    G.vmax = lerp(G.vmax, vmax, k);
  }
  // страховка от NaN/вырожденного диапазона: гигантские координаты валят GPU-растеризацию
  if(!isFinite(G.vmin) || !isFinite(G.vmax) || G.vmax - G.vmin < 1.5){
    const t = fitTarget(len, anchorD);
    G.vmin = t.vmin; G.vmax = t.vmax;
  }

  const i0 = Math.max(0, Math.floor(G.off) - 1);

  const yTop = h*0.06, yBot = h*0.97;
  const Y = d => yBot - (d - G.vmin)/(G.vmax - G.vmin)*(yBot - yTop);
  const X = i => (i - G.off + 0.5)*slotW;

  // вертикальный пунктир (едет вместе со свечами)
  ctx.strokeStyle = 'rgba(255,253,242,.6)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([6,7]);
  const gStart = Math.floor(G.off/3)*3;
  for(let i = gStart; i < G.off + CFG.vis + 3; i += 3){
    const gx = X(i) - slotW/2;
    if(gx < -10 || gx > wPlot+10) continue;
    ctx.beginPath(); ctx.moveTo(gx, yTop); ctx.lineTo(gx, yBot); ctx.stroke();
  }

  // горизонтальный пунктир (5 линий) + шкала РЕАЛЬНЫХ цен справа
  // (обратное преобразование дисплей → цена через якорь и G.med)
  ctx.font = '700 12px -apple-system,Arial';
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  const lblStep = (G.vmax - G.vmin)*G.med/5; // реальный шаг между соседними подписями
  for(let gi=0; gi<5; gi++){
    const gy = yTop + (yBot - yTop)*(gi + 0.5)/5;
    const dVal = G.vmin + (yBot - gy)/(yBot - yTop)*(G.vmax - G.vmin);
    const real = anchorReal + (dVal - anchorD)*G.med;
    ctx.strokeStyle = 'rgba(255,253,242,.6)';
    ctx.beginPath(); ctx.moveTo(0, gy); ctx.lineTo(wPlot, gy); ctx.stroke();
    ctx.fillStyle = '#a2937a';
    let lbl;
    if(lblStep >= 1){ lbl = fmtPrice(real); }
    else{ // тихий рынок: соседние подписи различимы только с десятыми
      const f = real.toFixed(1);
      const di = f.lastIndexOf('.');
      lbl = fmtPrice(+f.slice(0, di)) + '.' + f.slice(di+1);
    }
    ctx.fillText(lbl, wPlot + 8, gy);
  }
  ctx.setLineDash([]);

  // тонкая линия текущей цены; в окне решения пришпилена к последнему close —
  // живая цена не должна светиться до фиксации выбора
  ctx.save();
  ctx.setLineDash([4,5]);
  ctx.strokeStyle = 'rgba(160,140,100,.4)';
  ctx.lineWidth = 1;
  const cy0 = Y(G.phase === 'decide' ? anchorD : dCur);
  ctx.beginPath(); ctx.moveTo(0, cy0); ctx.lineTo(wPlot, cy0); ctx.stroke();
  ctx.restore();

  // история
  for(let i=i0; i<len; i++) drawCandle(ctx, X(i), G.candles[i], slotW, Y, false);

  // формирующаяся свеча
  if(form) drawCandle(ctx, X(len), form, slotW, Y, true);

  // плейсхолдер «?» / синий Х2 в слоте будущей свечи (фикс. позиция: центр)
  if(G.phase === 'decide'){
    drawPlaceholder(ctx, X(len), slotW, yTop, yBot, G.next && G.next.super);
  }
}

function drawCandle(ctx, x, c, slotW, Y, growing){
  if(x < -slotW) return;
  const up = c.dC >= c.dO;
  const bw = slotW * (c.super ? 0.8 : 0.72); // широкие тела по макету
  const yO = Y(c.dO), yC = Y(c.dC);
  const top = Math.min(yO,yC), bot = Math.max(yO,yC);
  const bh = Math.max(6, bot-top);
  const col = c.col || (up ? '#1f9e57' : '#ea4b41'); // c.col — нейтральный тон формирующейся

  ctx.save();
  // фитиль
  ctx.strokeStyle = col;
  ctx.lineWidth = Math.max(3, slotW*0.1);
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x, Y(c.dH)); ctx.lineTo(x, Y(c.dL)); ctx.stroke();
  // тело (флэт, скруглённые углы)
  ctx.fillStyle = col;
  roundRect(ctx, x-bw/2, top, bw, bh, Math.min(7, bw*0.28));
  ctx.fill();

  // бейдж ✓/✗ на разыгранных свечах
  if(c.result){
    const size = Math.min(bw*0.72, 22);
    const cyB = top + bh/2;
    const bcol = c.result==='to' ? '#948a71' : (up ? '#0f7e45' : '#c22f24');
    ctx.fillStyle = bcol;
    roundRect(ctx, x-size/2, cyB-size/2, size, size, size*0.3);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = Math.max(2, size*0.14);
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    if(c.result === 'win'){
      ctx.moveTo(x-size*0.22, cyB+size*0.02);
      ctx.lineTo(x-size*0.05, cyB+size*0.2);
      ctx.lineTo(x+size*0.24, cyB-size*0.18);
    }else{
      ctx.moveTo(x-size*0.18, cyB-size*0.18); ctx.lineTo(x+size*0.18, cyB+size*0.18);
      ctx.moveTo(x+size*0.18, cyB-size*0.18); ctx.lineTo(x-size*0.18, cyB+size*0.18);
    }
    ctx.stroke();
  }

  // отметка ×2 над сыгранной супер-свечой
  if(c.super && !growing){
    const chW = slotW*0.52, chH = slotW*0.34;
    const cyT = Y(c.dH) - chH - 5;
    ctx.fillStyle = '#4a6cf0';
    roundRect(ctx, x-chW/2, cyT, chW, chH, chH*0.35);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `900 ${chH*0.72}px -apple-system,Arial`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('×2', x, cyT + chH/2 + 0.5);
  }
  ctx.restore();
}

function drawPlaceholder(ctx, x, slotW, yTop, yBot, superFlag){
  const chH = yBot - yTop;
  const ph = chH*0.44, pw = slotW*0.86;
  // ВСЕГДА одна фикс. позиция: вертикальный центр графика. Никакой связи
  // с живой ценой — карточка «?» не должна подсказывать направление.
  const cy = yTop + chH/2;

  ctx.save();
  // фитиль-линия за карточкой
  ctx.strokeStyle = superFlag ? '#4a6cf0' : 'rgba(255,253,242,.95)';
  ctx.lineWidth = 4;
  ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(x, cy-ph*0.74); ctx.lineTo(x, cy+ph*0.74); ctx.stroke();

  // карточка (тень — дешёвой подложкой, БЕЗ shadowBlur в кадровом цикле: дорого для GPU)
  ctx.fillStyle = 'rgba(140,115,70,.22)';
  roundRect(ctx, x-pw/2+2, cy-ph/2+5, pw, ph, 11);
  ctx.fill();
  ctx.fillStyle = superFlag ? '#4a6cf0' : '#e7d8b7';
  roundRect(ctx, x-pw/2, cy-ph/2, pw, ph, 11);
  ctx.fill();
  ctx.strokeStyle = '#fffdf2';
  ctx.lineWidth = 3;
  roundRect(ctx, x-pw/2, cy-ph/2, pw, ph, 11);
  ctx.stroke();

  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  if(superFlag){
    const rows = [[-0.34,0.5],[-0.17,0.62],[0,0.95],[0.17,0.62],[0.34,0.5]];
    rows.forEach(([dy,s],idx)=>{
      ctx.save();
      ctx.translate(x, cy+dy*ph);
      ctx.rotate(-0.12);
      ctx.font = `900 ${slotW*0.42*s}px -apple-system,Arial`;
      ctx.fillStyle = idx===2 ? '#fff' : 'rgba(255,255,255,.6)';
      ctx.fillText('X2', 0, 0);
      ctx.restore();
    });
  }else{
    [[-0.3,0.55],[0,1],[0.3,0.55]].forEach(([dy,s])=>{
      ctx.font = `900 ${slotW*0.5*s}px -apple-system,Arial`;
      ctx.fillStyle = 'rgba(148,120,72,.8)';
      ctx.fillText('?', x, cy+dy*ph);
    });
  }
  ctx.restore();
}

/* ---------- confetti ---------- */
const CONF_COLORS = ['#1f9e57','#ea4b41','#4f6df6','#f5b63f','#a24df1','#fffdf4'];
function burstConfetti(n, fx=0.55, fy=0.35){
  const r = el.game.getBoundingClientRect();
  const cx = r.width*fx, cy = r.height*fy;
  const room = Math.max(0, 320 - particles.length); // жёсткий кап частиц
  for(let i=0; i<Math.min(n, room); i++){
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
function drawFx(dt){
  const {w,h} = fitCanvas(el.fx, fxCtx);
  const ctx = fxCtx;
  ctx.clearRect(0,0,w,h);
  if(!particles.length) return;
  const stepT = paused ? 0 : dt/1000;
  for(let i=particles.length-1; i>=0; i--){
    const p = particles[i];
    p.t += stepT;
    if(p.t >= p.life){ particles.splice(i,1); continue; }
    p.vy += 900*stepT;
    p.vx *= (1 - 1.4*stepT);
    p.x += p.vx*stepT; p.y += p.vy*stepT;
    p.rot += p.vr*stepT;
    ctx.save();
    ctx.globalAlpha = 1 - sstep(0.6, 1, p.t/p.life);
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.w/2, -p.h/2, p.w, p.h*Math.abs(Math.sin(p.rot*1.7)+0.3));
    ctx.restore();
  }
}

/* ---------- audio (крошечный синт) ---------- */
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
const sPick    = ()=>tone(620,0,0.07,'triangle',0.1);
const sWin     = ()=>{tone(660,0,0.09); tone(880,0.08,0.16);};
const sSuper   = ()=>{[660,880,1100,1320].forEach((f,i)=>tone(f,i*0.07,0.13,'triangle',0.16));};
const sLose    = ()=>tone(220,0,0.28,'sawtooth',0.1,130);
const sTimeout = ()=>tone(340,0,0.2,'square',0.08,170);
const sStart   = ()=>{tone(520,0,0.1); tone(780,0.09,0.16);};

/* ---------- main loop ---------- */
let lastT = 0;
function frame(t){
  const dt = Math.min(50, lastT ? t-lastT : 16);
  lastT = t;
  if(running && !paused && G) update(dt);
  drawChart(paused ? 0 : dt);
  drawFx(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ---------- flow ---------- */
function startGame(){
  el.startScreen.classList.add('hidden');
  el.overScreen.classList.add('hidden');
  el.pauseScreen.classList.add('hidden');
  paused = false;
  newGame();
  running = true;
  sStart();
}
function goHome(){
  running = false; paused = false;
  el.overScreen.classList.add('hidden');
  el.pauseScreen.classList.add('hidden');
  el.startScreen.classList.remove('hidden');
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
el.homeBtn.addEventListener('click', goHome);
el.resumeBtn.addEventListener('click', ()=>togglePause(false));
el.pauseBtn.addEventListener('pointerdown', e=>{ e.preventDefault(); togglePause(); });
/* «Exit to menu» в паузе — IIFE-сниппет оркестратора в конце файла (hubExitBtn) */

el.btnUp.addEventListener('pointerdown', e=>{ e.preventDefault(); pick('up'); });
el.btnDown.addEventListener('pointerdown', e=>{ e.preventDefault(); pick('down'); });

// свайп по графику: вверх = Лонг, вниз = Шорт
let swipe = null;
el.chartWrap.addEventListener('pointerdown', e=>{ swipe = {y:e.clientY, t:performance.now()}; });
window.addEventListener('pointerup', e=>{
  if(!swipe) return;
  const dy = e.clientY - swipe.y;
  const dtS = performance.now() - swipe.t;
  swipe = null;
  if(dtS < 600 && Math.abs(dy) > 24) pick(dy < 0 ? 'up' : 'down');
});

window.addEventListener('keydown', e=>{
  if(e.repeat) return;
  if(e.key === 'ArrowUp' || e.key === 'w') pick('up');
  else if(e.key === 'ArrowDown' || e.key === 's') pick('down');
  else if(e.key === ' '){ if(!running) startGame(); }
  else if(e.key === 'p' || e.key === 'Escape') togglePause();
});

document.addEventListener('visibilitychange', ()=>{
  if(document.hidden && running) togglePause(true);
});

document.addEventListener('touchmove', e=>e.preventDefault(), {passive:false});

/* ---------- init ---------- */
Feed.connect();
Feed.seed().then(()=>{
  updateNetBadge();
  if(AUTO && !running) startGame(); // автостарт — после попытки сида (история от реальной цены)
});
updateNetBadge();

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
      try { window.parent.postMessage({type:'hub:exit', game:'prognoz'}, '*'); } catch(e){}
    });
    anchor.insertAdjacentElement('afterend', b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
