'use strict';
/* «Trade» — ЕДИНАЯ игра веб-версии (решение встречи 24.07): движок «Сделки»
   (живой BTC: Binance REST+WS + генератор режимов, свечи 1.1с, сердца,
   ликвидация −50% PnL) + лестница механик ВНУТРИ одной игры:
     stage 1 — лонг всей котлетой (вход/выход);
     stage 2 — + шорты (модель «Лонг/Шорт»: dir ±1);
     stage 3 — + плечо ×1–×5 (выбор игрока, дефолт ×2 — слово владельца 25.07);
     stage 4 — + частичные позиции 25/50/75/100% на вход И на выход.
   Анлоки стадий 2–3 — РАУНДАМИ ОНБОРДИНГА (слово владельца 25.07): три коротких
   обучающих раунда подряд НА СИМУЛЯЦИИ (сид всегда 1000, кошелёк игрока не трогаем):
   раунд 1 — базовая торговля (туториал «как у Миши») → анлок шортов; раунд 2 — с
   шортами → анлок плеча; раунд 3 — с плечами. Дальше — основная игра на фишках.
   UI онбординга — пиксель-перфект по макетам Миши (вердикт 30.07 п.23,
   _рабочее/onboarding-new): гейты раунда в G.caps (r1 Buy-only / r2 +Short /
   r3 +Leverage), интро-модалки шортов/плеча в онбординге заменены хаб-баблами,
   карточка позиции с бейджами xN/Long-Short и полосой ликвидации (r3+),
   сим-раунды — кебаб ⋮ вместо сердец (сердца возвращаются в реальных раундах).
   Stage 4 (частичные) — залоченные Size + тап «🔒 Open» → обучающий раунд (вердикт 25.07).
   Прогресс: localStorage 'trade.progress' (общий с шеллом, same-origin). */

// ============================== CONFIG ==============================
const CFG = {
  ROUND_SEC: 60,
  OB_ROUND_SEC: 15,     // онбординг-раунды короткие («первый раунд на 15 секунд торгов» — владелец 25.07)
  START_BAL: 1000,
  LEV_BASE: 2,          // stages 1–2: скрытая часть буста по PnL (вердикт 26.07: ×2 очки × ×2 волатильность = те же ×4, но качели видны на графике)
  OB_VOL: 2,            // stages 1–2: множитель хода фейк-цены — график видимо скачет сильнее (вердикт 26.07)
  LEVS: [1, 2, 3, 4, 5], // stage 3+: выбор игрока ×1–×5, дефолт ×2 (слово владельца 25.07)
  LEV_DEF: 2,
  TUT_LEV_DEF: 3,       // дефолт плеча в ОБУЧАЮЩИХ раундах — x3 (решение Павла 31.07, п.36б)
  FRACS: [0.25, 0.5, 0.75, 1], // stage 4+: доли котлеты на вход/выход
  LIQ_PNL: -50,         // ликвидация: PnL позиции −50% (расстояние цены = 50%/lev)
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

/* ── Онбординг v3 — интерактив (вердикт 31.07 п.36): обучающие раунды идут на
   СЦЕНИРОВАННОЙ симуляции цены — заранее заданная последовательность сегментов
   (падение → отскок → рост → откат) под сценарий урока. Одобрено Павлом 31.07
   («в онбординге можно симуляцию хотя бы на старте»); п.33 «реальный live-стрим»
   относится к РЕАЛЬНЫМ раундам — их движок не тронут.
   Сегмент: dur (сек), drift (лог-дрифт/сек), sigma (шум), emit (событие фазы для
   подсказки хаба в МОМЕНТ события), hold (сегмент тянется после dur, пока не
   выполнится условие: 'go' — хаб отпустил вступительные баблы; 'frac' — игрок
   выбрал долю <100%; 'enter' — открыта позиция; 'exit' — позиция закрыта).
   ★draft: формы сценариев и длительности — моё предложение, не вердикт. */
const TUT_SCRIPT = {
  1: [ // раунд 1 — лонг: флэт → падение → отскок (Buy!) → рост → затухание (Close!)
    { dur: 2.0, drift: 0,      sigma: 0.006, hold: 'go' },
    { dur: 3.0, drift: -0.032, sigma: 0.004 },
    { dur: 1.4, drift: 0.010,  sigma: 0.003, emit: 'rebound', hold: 'enter' },
    { dur: 4.0, drift: 0.032,  sigma: 0.005 },
    { dur: 1.6, drift: -0.004, sigma: 0.004, emit: 'stall', hold: 'exit' },
    { dur: 9e9, drift: 0.003,  sigma: 0.010 }, // свободная игра до конца раунда
  ],
  2: [ // раунд 2 — шорт: флэт → рост → разворот (Short!) → падение → дно (Close!)
    { dur: 2.0, drift: 0,      sigma: 0.006, hold: 'go' },
    { dur: 3.0, drift: 0.030,  sigma: 0.004 },
    { dur: 1.4, drift: -0.008, sigma: 0.003, emit: 'turn', hold: 'enter' },
    { dur: 4.0, drift: -0.032, sigma: 0.005 },
    { dur: 1.6, drift: 0.005,  sigma: 0.004, emit: 'bottom', hold: 'exit' },
    { dur: 9e9, drift: -0.002, sigma: 0.010 },
  ],
  3: [ // раунд 3 — плечо x3: флэт → провал → отскок (Long!) → рост → затухание (Close!)
    { dur: 2.0, drift: 0,      sigma: 0.006, hold: 'go' },
    { dur: 2.6, drift: -0.026, sigma: 0.004 },
    { dur: 1.4, drift: 0.010,  sigma: 0.003, emit: 'rebound', hold: 'enter' },
    { dur: 4.0, drift: 0.028,  sigma: 0.006 },
    { dur: 1.6, drift: -0.005, sigma: 0.004, emit: 'stall', hold: 'exit' },
    { dur: 9e9, drift: 0.003,  sigma: 0.012 },
  ],
  p: [ // обучающий раунд частичных позиций (п.18/п.35): флэт, пока игрок выбирает
       // долю → провал → отскок (Buy частью котлеты!) → рост → затухание (Close!)
    { dur: 2.0, drift: 0,      sigma: 0.006, hold: 'frac' },
    { dur: 2.6, drift: -0.024, sigma: 0.004 },
    { dur: 1.4, drift: 0.010,  sigma: 0.003, emit: 'rebound', hold: 'enter' },
    { dur: 4.0, drift: 0.028,  sigma: 0.005 },
    { dur: 1.6, drift: -0.005, sigma: 0.004, emit: 'stall', hold: 'exit' },
    { dur: 9e9, drift: 0.003,  sigma: 0.010 },
  ],
};
/* событие туториала game→shell: контракт {type:'hub:tutEvent', game:'trade', ev}
   ev: 'phase:<имя>' (сегмент сценария начался) | 'enter:1'/'enter:-1' | 'exit' |
   'liq' | 'frac:<доля>' | 'partial-start'. Существующие типы сообщений не тронуты. */
function postTutEvent(ev) {
  if (window.parent === window) return;
  try { window.parent.postMessage({ type: 'hub:tutEvent', game: 'trade', ev }, '*'); } catch (e) {}
}

/* ── Анлоки (вердикт владельца 25.07): стадии 2–3 открываются РАУНДАМИ онбординга
   (раунд 1 пройден → шорты; раунд 2 → плечо), НЕ порогами. Stage 4 (частичные позиции,
   вердикт 25.07 вечер): в основной игре сегменты Size видны ЗАЛОЧЕННЫМИ + кнопка 🔒 —
   тап запускает ОБУЧАЮЩИЙ 4-й раунд (симуляция, про хеджирование рисков), после него
   стадия открыта навсегда. Порогов больше нет. */
const OB_ROUNDS = 3;                            // раундов онбординга (симуляция)
const MAX_STAGE = 4;

const NICKS = [
  ['Alex', 5800], ['Tony Scorpos', 5400], ['Fill Simpany', 4990],
  ['CandleSam', 3100], ['LunaLong', 2050],
];

/* ── Trading asset (Deal-экран, Figma f2055): выбор BTC/ETH/SOL меняет подпись
   графика и сид цены; движок симуляции ЕДИНЫЙ. ★draft: живой фид Binance в игре
   только BTC — ETH/SOL идут на том же генераторе режимов от типичного сида
   (честный минимум по заданию 31.07); выбор живёт в рамках iframe, дефолт BTC */
/* ★draft: макеты 31.07 рисуют монету активов ПЛОСКИМ кружком в цвете тикера
   (у каждого варианта свои: --dot-btc/-eth/-sol), поэтому 3D-webp монеты кремовой
   итерации (coin-*.webp) больше не подключаются; файлы оставлены в папке, если
   владелец захочет вернуть картиночные монеты. */
const ASSETS = {
  BTC: { name: 'Bitcoin',  ticker: 'BTC', seed: 63370, live: true  },
  ETH: { name: 'Ethereum', ticker: 'ETH', seed: 3420,  live: false },
  SOL: { name: 'Solana',   ticker: 'SOL', seed: 180,   live: false },
};

// ============================== PROGRESS (ladder) ==============================
const P = (() => {
  const def = {
    stage: 1,
    profitTrades: 0,   // закрытых сделок в плюс (за всё время)
    cumEarned: 0,      // сумма ПЛЮСОВЫХ раундовых дельт
    rounds: 0,
    hotStreak: 0,      // подряд выигранных раундов с PnL ≥ +30% (триггер «пика», вердикт 25.07)
    pendingPartial: false, // тренировка частичных заказана тапом 🔒 — стартует СЛЕДУЮЩИМ раундом
    intros: { short: false, lev: false, partial: false }, // one-time онбординги
  };
  let s = {};
  try { s = JSON.parse(localStorage.getItem('trade.progress') || '{}') || {}; } catch (e) {}
  const out = Object.assign({}, def, s);
  out.intros = Object.assign({}, def.intros, (typeof s.intros === 'object' && s.intros) || {});
  out.stage = Math.min(MAX_STAGE, Math.max(1, +out.stage || 1));
  // миграция с порожной системы (до 25.07): stage уже открыт старыми порогами →
  // rounds не ниже обратной лесенки targetStage (stage N достигается ПОСЛЕ раунда N−1).
  // Было `stage>=3 ? 3` — это выбивало 3-й раунд онбординга в реальный (QA 27.07:
  // rounds прыгал 2→3 на буте айфрейма, раунд шёл с живым кошельком без fee)
  // считаем соответствующие онбординг-раунды сыгранными, не гоним игрока в симуляции
  out.rounds = Math.max(+out.rounds || 0, out.stage - 1);
  out.profitTrades = Math.max(0, +out.profitTrades || 0);
  out.cumEarned = Math.max(0, +out.cumEarned || 0);
  out.rounds = Math.max(0, +out.rounds || 0);
  return out;
})();
function saveP() { try { localStorage.setItem('trade.progress', JSON.stringify(P)); } catch (e) {} }
/** Онбординг активен, пока не сыграны все OB_ROUNDS (симуляция, кошелёк не трогаем). */
function onboarding() { return P.rounds < OB_ROUNDS; }
function targetStage() {
  // стадии 2–3 — раундами онбординга: сыгран раунд N → стадия N+1 (вердикт 25.07).
  // Stage 4 — ТОЛЬКО через обучающий раунд по тапу (см. finishRound/G.partialTraining)
  return Math.min(3, P.rounds + 1);
}

/* practice tasks (обучающий модуль, решение встречи п.6): живые галочки в хабе */
const Tasks = {
  get() { try { return JSON.parse(localStorage.getItem('trade.tasks') || '{}') || {}; } catch (e) { return {}; } },
  set(flag) {
    const t = this.get();
    if (t[flag]) return;
    t[flag] = true;
    try { localStorage.setItem('trade.tasks', JSON.stringify(t)); } catch (e) {}
  },
};

// ============================== SKIN (вердикт владельца 31.07 вечер, п.32) ==============================
/* Игра больше НЕ едина по виду: у каждого из четырёх вариантов приложения свои игровые
   экраны. Скин приходит из хаба двумя каналами:
     1) ?skin=<key> в URL айфрейма (shell.js openGame) — читаем на буте;
     2) postMessage {type:'hub:skin', skin:'<key>'} — дев-переключатель Style в Settings,
        перекрашиваем ЖИВУЮ игру без перезагрузки.
   Скин = ТОЛЬКО набор CSS-токенов на html[data-skin] (+ цвета канваса читаются из тех же
   переменных). DOM и раскладка не ветвятся (п.20 в силе). */
const SKINS = ['paper', 'crypto-light', 'crypto-dark', 'cream', 'corporate'];
// когортные ссылки прошлой итерации не должны ломаться (те же алиасы, что в shell.js;
// narodny/taptrade исторически = папирусный 622-дизайн → снова ведут на paper)
const SKIN_ALIAS = { narodny: 'paper', taptrade: 'paper', terminal: 'crypto-dark', editorial: 'corporate' };
const normSkin = s => (SKINS.includes(s) ? s : (SKIN_ALIAS[s] || null));
let SKIN = 'paper'; // дефолт = папирусный рабочий прототип (слово Павла 31.07 поздний вечер)
function applySkin(s) {
  const k = normSkin(s);
  if (!k) return false;
  SKIN = k;
  document.documentElement.dataset.skin = k;
  return true;
}
// без ?skin= применяем ДЕФОЛТ явно: иначе жёсткий data-skin из разметки оставался
// на DOM и standalone-игра открывалась не папирусом (JS-переменная и атрибут расходились)
try { applySkin(new URLSearchParams(location.search).get('skin') || SKIN); } catch (e) { applySkin(SKIN); }

// ============================== GAME I18N (новые строки — 8 языков) ==============================
/* Язык берём из настроек хаба (hub.state.lang). Торговые термины (Long/Short/
   Exit/×2/25%) — English во всех языках (действующее продуктовое решение). */
const HUB_LANGS = ['en', 'es', 'fr', 'de', 'ja', 'zh', 'pt', 'ar'];
const GLANG = (() => {
  try { return HUB_LANGS[(JSON.parse(localStorage.getItem('hub.state') || '{}') || {}).lang | 0] || 'en'; }
  catch (e) { return 'en'; }
})();
const GT_DICT = {
en: {
  'stage.badge': 'Stage {0} of {1}',
  'mech.short': 'Shorts', 'mech.lev': 'Leverage ×2–×5', 'mech.partial': 'Partial positions',
  'unlock.band': 'New mechanic unlocked: {0}',
  'gotit': 'Got it',
  'intro.short.t': 'Shorts unlocked',
  'intro.short.1': 'Until now you could only bet on the price going UP (long). A short is the opposite: you profit when the price goes DOWN.',
  'intro.short.2': 'Tap Short when you expect a drop, then Exit to lock in the difference. Wrong direction works against you the same way.',
  'intro.lev.t': 'Leverage unlocked',
  'intro.lev.1': 'Leverage multiplies your position: with ×5, a 1% price move changes your stake by 5%.',
  'intro.lev.2': 'Pick ×2–×5 before entering. Careful: liquidation (−50% of your stake) gets closer as leverage grows.',
  'hint.partial': 'New: partial positions — enter and exit with 25/50/75% of your stack',
  'hint.trainq': 'Training round starts right after this one',
  'intro.partial.t': 'Partial positions — hedge your risk',
  'intro.partial.1': 'Pros rarely go all-in. Entering with a part of your stack keeps the rest in cash — that reserve is your hedge when the market turns.',
  'intro.partial.2': 'Had 1000 and entered at 75%? 750 works in BTC, 250 stays safe. Exit in parts too: lock in profit, let the rest ride. Try it in a training round.',
  'howto.1.enter': 'Tap to enter: your whole balance in',
  'howto.1.exit': 'Tap to exit: don’t get greedy!',
  'howto.short': 'Long earns on rise, Short earns on fall',
  'howto.lev': 'Leverage ×2–×5 multiplies gains AND losses',
  'howto.partial': 'Trade a part of your stack: 25 / 50 / 75 / 100%',
  'howto.chart': 'The chart is Bitcoin’s live price',
  'howto.liq': '−50% is liquidation — you lose a heart',
  /* игровой хром по онбординг-макетам (30.07); Buy/Long/Short — English во всех языках */
  'ui.balance': 'Balance',
  'ui.trade': 'Trade',
  'ui.leverage': 'Leverage',
  'ui.size': 'Trade size',
  'ui.upnl': 'Unrealized P&L',
  'ui.enter': 'Enter',
  'ui.current': 'Current',
  'ui.liq': 'Liquidation',
  'ui.liqCaption': 'Liquidation at −50% of the rate',
  'ui.close': 'Close position', 'ui.study': 'Learn',
  'ui.closeFrac': 'Close {0}%',
  /* Deal pre-round screen (Figma 622 / f2055); RU copy макета переведена в EN-базу */
  'deal.title': 'Deal',
  'deal.balance': 'Your balance',
  'deal.settings': 'Level settings',
  'deal.setup': 'Set up the level before starting the game',
  'deal.asset': 'Trading asset',
  'deal.start': 'Start game',
  'deal.unlock.t': 'New mechanic unlocked!',
  'deal.learn': 'Learn',
  'deal.mech.partial.d': 'Now you can choose your position size and control your risk',
  'deal.howto.t': 'How to play',
  'ui.chartlbl': '{0} chart ({1}/USD)',
  'ui.gtitle': 'Trade',
},
es: {
  'stage.badge': 'Etapa {0} de {1}',
  'mech.short': 'Shorts', 'mech.lev': 'Apalancamiento ×2–×5', 'mech.partial': 'Posiciones parciales',
  'unlock.band': 'Nueva mecánica desbloqueada: {0}',
  'gotit': 'Entendido',
  'intro.short.t': 'Shorts desbloqueados',
  'intro.short.1': 'Hasta ahora solo podías apostar a que el precio SUBE (long). El short es lo contrario: ganas cuando el precio BAJA.',
  'intro.short.2': 'Toca Short cuando esperes una caída y luego Exit para asegurar la diferencia. La dirección equivocada juega en tu contra igual.',
  'intro.lev.t': 'Apalancamiento desbloqueado',
  'intro.lev.1': 'El apalancamiento multiplica tu posición: con ×5, un movimiento del 1% cambia tu apuesta un 5%.',
  'intro.lev.2': 'Elige ×2–×5 antes de entrar. Cuidado: la liquidación (−50% de tu apuesta) se acerca al subir el apalancamiento.',
  'hint.partial': 'Nuevo: posiciones parciales — entra y sal con 25/50/75% de tu stack',
  'hint.trainq': 'La ronda de práctica empieza justo después de esta',
  'intro.partial.t': 'Posiciones parciales — cubre tu riesgo',
  'intro.partial.1': 'Los profesionales rara vez van all-in. Entrar con una parte deja el resto en efectivo: esa reserva es tu cobertura cuando el mercado gira.',
  'intro.partial.2': '¿Tenías 1000 y entraste al 75%? 750 trabajan en BTC, 250 quedan a salvo. Sal también por partes: asegura ganancia y deja correr el resto. Pruébalo en una ronda de práctica.',
  'howto.1.enter': 'Toca para entrar: todo tu saldo dentro',
  'howto.1.exit': 'Toca para salir: ¡no seas avaro!',
  'howto.short': 'Long gana al subir, Short gana al bajar',
  'howto.lev': 'El apalancamiento ×2–×5 multiplica ganancias Y pérdidas',
  'howto.partial': 'Opera una parte del stack: 25 / 50 / 75 / 100%',
  'howto.chart': 'El gráfico es el precio real de Bitcoin',
  'howto.liq': '−50% es liquidación — pierdes un corazón',
  'ui.balance': 'Saldo',
  'ui.trade': 'Operación',
  'ui.leverage': 'Apalancamiento',
  'ui.size': 'Tamaño de operación',
  'ui.upnl': 'P&L no realizado',
  'ui.enter': 'Entrada',
  'ui.current': 'Actual',
  'ui.liq': 'Liquidación',
  'ui.liqCaption': 'Liquidación al −50% de la tasa',
  'ui.close': 'Cerrar posición', 'ui.study': 'Aprender',
  'ui.closeFrac': 'Cerrar {0}%',
  'deal.title': 'Operación',
  'deal.balance': 'Tu saldo',
  'deal.settings': 'Ajustes del nivel',
  'deal.setup': 'Configura el nivel antes de empezar la partida',
  'deal.asset': 'Activo de trading',
  'deal.start': 'Empezar el juego',
  'deal.unlock.t': '¡Nueva mecánica desbloqueada!',
  'deal.learn': 'Aprender',
  'deal.mech.partial.d': 'Ahora puedes elegir el tamaño de tu posición y controlar el riesgo',
  'deal.howto.t': 'Cómo jugar',
  'ui.chartlbl': 'Gráfico de {0} ({1}/USD)',
  'ui.gtitle': 'Trade',
},
fr: {
  'stage.badge': 'Étape {0} sur {1}',
  'mech.short': 'Shorts', 'mech.lev': 'Levier ×2–×5', 'mech.partial': 'Positions partielles',
  'unlock.band': 'Nouvelle mécanique débloquée : {0}',
  'gotit': 'Compris',
  'intro.short.t': 'Shorts débloqués',
  'intro.short.1': 'Jusqu’ici tu ne pouvais parier que sur la HAUSSE (long). Le short, c’est l’inverse : tu gagnes quand le prix BAISSE.',
  'intro.short.2': 'Touche Short quand tu attends une chute, puis Exit pour encaisser la différence. La mauvaise direction joue contre toi pareil.',
  'intro.lev.t': 'Levier débloqué',
  'intro.lev.1': 'Le levier multiplie ta position : avec ×5, un mouvement de 1% change ta mise de 5%.',
  'intro.lev.2': 'Choisis ×2–×5 avant d’entrer. Attention : la liquidation (−50% de la mise) se rapproche quand le levier monte.',
  'hint.partial': 'Nouveau : positions partielles — entre et sors avec 25/50/75% du stack',
  'hint.trainq': 'La manche d’entraînement démarre juste après celle-ci',
  'intro.partial.t': 'Positions partielles — couvre ton risque',
  'intro.partial.1': 'Les pros vont rarement all-in. Entrer avec une partie du stack garde le reste en cash : cette réserve est ta couverture quand le marché se retourne.',
  'intro.partial.2': 'Tu avais 1000 et tu entres à 75%? 750 travaillent en BTC, 250 restent au chaud. Sors aussi par étapes : sécurise le profit, laisse courir le reste. Essaie-le dans une manche d’entraînement.',
  'howto.1.enter': 'Touche pour entrer : tout ton solde',
  'howto.1.exit': 'Touche pour sortir : ne sois pas gourmand !',
  'howto.short': 'Long gagne à la hausse, Short gagne à la baisse',
  'howto.lev': 'Le levier ×2–×5 multiplie gains ET pertes',
  'howto.partial': 'Trade une partie du stack : 25 / 50 / 75 / 100%',
  'howto.chart': 'Le graphique est le prix réel du Bitcoin',
  'howto.liq': '−50% = liquidation — tu perds un cœur',
  'ui.balance': 'Solde',
  'ui.trade': 'Trade',
  'ui.leverage': 'Levier',
  'ui.size': 'Taille du trade',
  'ui.upnl': 'P&L latent',
  'ui.enter': 'Entrée',
  'ui.current': 'Actuel',
  'ui.liq': 'Liquidation',
  'ui.liqCaption': 'Liquidation à −50% du cours',
  'ui.close': 'Clôturer la position', 'ui.study': 'Découvrir',
  'ui.closeFrac': 'Clôturer {0}%',
  'deal.title': 'Transaction',
  'deal.balance': 'Ton solde',
  'deal.settings': 'Réglages du niveau',
  'deal.setup': 'Configure le niveau avant de lancer la partie',
  'deal.asset': 'Actif de trading',
  'deal.start': 'Lancer la partie',
  'deal.unlock.t': 'Nouvelle mécanique débloquée !',
  'deal.learn': 'Découvrir',
  'deal.mech.partial.d': 'Tu peux maintenant choisir la taille de ta position et contrôler ton risque',
  'deal.howto.t': 'Comment jouer',
  'ui.chartlbl': 'Graphique {0} ({1}/USD)',
  'ui.gtitle': 'Trade',
},
de: {
  'stage.badge': 'Stufe {0} von {1}',
  'mech.short': 'Shorts', 'mech.lev': 'Hebel ×2–×5', 'mech.partial': 'Teilpositionen',
  'unlock.band': 'Neue Mechanik freigeschaltet: {0}',
  'gotit': 'Verstanden',
  'intro.short.t': 'Shorts freigeschaltet',
  'intro.short.1': 'Bisher konntest du nur auf STEIGENDE Preise setzen (Long). Der Short ist das Gegenteil: du gewinnst, wenn der Preis FÄLLT.',
  'intro.short.2': 'Tippe Short, wenn du einen Fall erwartest, dann Exit, um die Differenz zu sichern. Die falsche Richtung wirkt genauso gegen dich.',
  'intro.lev.t': 'Hebel freigeschaltet',
  'intro.lev.1': 'Der Hebel multipliziert deine Position: mit ×5 ändert eine 1%-Bewegung deinen Einsatz um 5%.',
  'intro.lev.2': 'Wähle ×2–×5 vor dem Einstieg. Vorsicht: die Liquidation (−50% des Einsatzes) rückt mit höherem Hebel näher.',
  'hint.partial': 'Neu: Teilpositionen — mit 25/50/75% des Stacks ein- und aussteigen',
  'hint.trainq': 'Die Trainingsrunde startet direkt nach dieser',
  'intro.partial.t': 'Teilpositionen — sichere dein Risiko ab',
  'intro.partial.1': 'Profis gehen selten all-in. Wer nur einen Teil einsetzt, behält den Rest in Cash — diese Reserve ist deine Absicherung, wenn der Markt dreht.',
  'intro.partial.2': '1000 gehabt und mit 75% rein? 750 arbeiten in BTC, 250 bleiben sicher. Steig auch in Teilen aus: Gewinn sichern, den Rest laufen lassen. Probier es in einer Trainingsrunde.',
  'howto.1.enter': 'Tippen zum Einstieg: dein ganzes Guthaben',
  'howto.1.exit': 'Tippen zum Ausstieg: nicht gierig werden!',
  'howto.short': 'Long verdient beim Anstieg, Short beim Fall',
  'howto.lev': 'Hebel ×2–×5 multipliziert Gewinne UND Verluste',
  'howto.partial': 'Handle einen Teil des Stacks: 25 / 50 / 75 / 100%',
  'howto.chart': 'Der Chart ist der echte Bitcoin-Preis',
  'howto.liq': '−50% = Liquidation — du verlierst ein Herz',
  'ui.balance': 'Guthaben',
  'ui.trade': 'Trade',
  'ui.leverage': 'Hebel',
  'ui.size': 'Positionsgröße',
  'ui.upnl': 'Unrealisierter P&L',
  'ui.enter': 'Einstieg',
  'ui.current': 'Aktuell',
  'ui.liq': 'Liquidation',
  'ui.liqCaption': 'Liquidation bei −50% des Kurses',
  'ui.close': 'Position schließen', 'ui.study': 'Lernen',
  'ui.closeFrac': '{0}% schließen',
  'deal.title': 'Deal',
  'deal.balance': 'Dein Guthaben',
  'deal.settings': 'Level-Einstellungen',
  'deal.setup': 'Stelle das Level vor dem Spielstart ein',
  'deal.asset': 'Handels-Asset',
  'deal.start': 'Spiel starten',
  'deal.unlock.t': 'Neue Mechanik freigeschaltet!',
  'deal.learn': 'Ansehen',
  'deal.mech.partial.d': 'Jetzt kannst du deine Positionsgröße wählen und dein Risiko steuern',
  'deal.howto.t': 'So wird gespielt',
  'ui.chartlbl': '{0}-Chart ({1}/USD)',
  'ui.gtitle': 'Trade',
},
ja: {
  'stage.badge': 'ステージ {0} / {1}',
  'mech.short': 'ショート', 'mech.lev': 'レバレッジ ×2–×5', 'mech.partial': '部分ポジション',
  'unlock.band': '新メカニクス解放: {0}',
  'gotit': 'わかった',
  'intro.short.t': 'ショート解放',
  'intro.short.1': 'これまでは価格の上昇（ロング）にしか賭けられませんでした。ショートはその逆で、価格が下がると利益になります。',
  'intro.short.2': '下落を予想したら Short をタップ、Exit で差額を確定。方向を間違えれば同じだけ損になります。',
  'intro.lev.t': 'レバレッジ解放',
  'intro.lev.1': 'レバレッジはポジションを倍増します。×5なら価格1%の動きで賭け金は5%変わります。',
  'intro.lev.2': 'エントリー前に ×2–×5 を選択。注意: レバレッジが上がるほど清算（賭け金の−50%）が近づきます。',
  'hint.partial': '新機能: 部分ポジション — スタックの25/50/75%で出入りできます',
  'hint.trainq': 'このラウンドの直後にトレーニングラウンドが始まります',
  'intro.partial.t': '部分ポジション — リスクをヘッジ',
  'intro.partial.1': 'プロはめったに全額を投じません。一部だけでエントリーすれば残りは現金のまま — その余力が相場反転時のヘッジになります。',
  'intro.partial.2': '1000のうち75%でエントリー? 750がBTCで働き、250は安全に待機。決済も部分的に: 利益を確定し、残りを走らせる。トレーニングラウンドで試そう。',
  'howto.1.enter': 'タップでエントリー: 残高全額を投入',
  'howto.1.exit': 'タップで決済: 欲張らないで！',
  'howto.short': 'Long は上昇で、Short は下落で稼ぐ',
  'howto.lev': 'レバレッジ ×2–×5 は利益も損失も倍増',
  'howto.partial': 'スタックの一部で取引: 25 / 50 / 75 / 100%',
  'howto.chart': 'チャートはビットコインのライブ価格',
  'howto.liq': '−50%で清算 — ハートを1つ失う',
  'ui.balance': '残高',
  'ui.trade': '取引',
  'ui.leverage': 'レバレッジ',
  'ui.size': '取引サイズ',
  'ui.upnl': '含み損益',
  'ui.enter': 'エントリー',
  'ui.current': '現在',
  'ui.liq': '清算',
  'ui.liqCaption': 'レートの−50%で清算',
  'ui.close': 'ポジションを決済', 'ui.study': '学ぶ',
  'ui.closeFrac': '{0}%決済',
  'deal.title': 'ディール',
  'deal.balance': 'あなたの残高',
  'deal.settings': 'レベル設定',
  'deal.setup': 'ゲームを始める前にレベルを設定しよう',
  'deal.asset': '取引資産',
  'deal.start': 'ゲーム開始',
  'deal.unlock.t': '新メカニクス解放！',
  'deal.learn': '学ぶ',
  'deal.mech.partial.d': 'ポジションのサイズを選んでリスクをコントロールできるようになりました',
  'deal.howto.t': '遊び方',
  'ui.chartlbl': '{0}チャート ({1}/USD)',
  'ui.gtitle': 'Trade',
},
zh: {
  'stage.badge': '第 {0} 阶段，共 {1} 阶段',
  'mech.short': '做空', 'mech.lev': '杠杆 ×2–×5', 'mech.partial': '部分仓位',
  'unlock.band': '解锁新机制: {0}',
  'gotit': '知道了',
  'intro.short.t': '做空已解锁',
  'intro.short.1': '之前你只能押价格上涨（做多）。做空正相反: 价格下跌时你赚钱。',
  'intro.short.2': '预期下跌时点 Short，再点 Exit 锁定差价。方向错了同样会亏损。',
  'intro.lev.t': '杠杆已解锁',
  'intro.lev.1': '杠杆会放大你的仓位: ×5 时，价格波动1%，你的本金变化5%。',
  'intro.lev.2': '入场前选择 ×2–×5。注意: 杠杆越高，爆仓（本金−50%）越近。',
  'hint.partial': '新功能: 部分仓位 — 用25/50/75%的资金进出场',
  'hint.trainq': '本回合结束后立即开始训练回合',
  'intro.partial.t': '部分仓位 — 对冲你的风险',
  'intro.partial.1': '高手很少全仓。只用一部分资金进场，其余留作现金 — 这笔储备就是行情反转时的对冲。',
  'intro.partial.2': '有1000、按75%进场? 750在BTC里工作，250安然无恙。平仓也可以分批: 锁定利润，让剩余继续跑。来一局训练回合试试。',
  'howto.1.enter': '点击入场: 全部余额投入',
  'howto.1.exit': '点击离场: 别太贪心！',
  'howto.short': 'Long 靠上涨赚钱，Short 靠下跌赚钱',
  'howto.lev': '杠杆 ×2–×5 同时放大盈利和亏损',
  'howto.partial': '用部分资金交易: 25 / 50 / 75 / 100%',
  'howto.chart': '图表是比特币实时价格',
  'howto.liq': '−50% 即爆仓 — 失去一颗心',
  'ui.balance': '余额',
  'ui.trade': '交易',
  'ui.leverage': '杠杆',
  'ui.size': '交易规模',
  'ui.upnl': '未实现盈亏',
  'ui.enter': '入场',
  'ui.current': '当前',
  'ui.liq': '爆仓',
  'ui.liqCaption': '价格变动−50%时爆仓',
  'ui.close': '平仓', 'ui.study': '学习',
  'ui.closeFrac': '平仓{0}%',
  'deal.title': '交易',
  'deal.balance': '你的余额',
  'deal.settings': '关卡设置',
  'deal.setup': '开始游戏前先设置关卡',
  'deal.asset': '交易资产',
  'deal.start': '开始游戏',
  'deal.unlock.t': '解锁新机制！',
  'deal.learn': '学习',
  'deal.mech.partial.d': '现在你可以选择仓位大小并控制风险',
  'deal.howto.t': '玩法说明',
  'ui.chartlbl': '{0}图表 ({1}/USD)',
  'ui.gtitle': 'Trade',
},
pt: {
  'stage.badge': 'Fase {0} de {1}',
  'mech.short': 'Shorts', 'mech.lev': 'Alavancagem ×2–×5', 'mech.partial': 'Posições parciais',
  'unlock.band': 'Nova mecânica desbloqueada: {0}',
  'gotit': 'Entendi',
  'intro.short.t': 'Shorts desbloqueados',
  'intro.short.1': 'Até agora você só podia apostar na ALTA (long). O short é o oposto: você lucra quando o preço CAI.',
  'intro.short.2': 'Toque em Short quando esperar queda e em Exit para garantir a diferença. A direção errada joga contra você do mesmo jeito.',
  'intro.lev.t': 'Alavancagem desbloqueada',
  'intro.lev.1': 'A alavancagem multiplica sua posição: com ×5, um movimento de 1% muda sua aposta em 5%.',
  'intro.lev.2': 'Escolha ×2–×5 antes de entrar. Cuidado: a liquidação (−50% da aposta) fica mais perto com alavancagem maior.',
  'hint.partial': 'Novo: posições parciais — entre e saia com 25/50/75% do stack',
  'hint.trainq': 'A rodada de treino começa logo após esta',
  'intro.partial.t': 'Posições parciais — proteja seu risco',
  'intro.partial.1': 'Profissionais raramente vão all-in. Entrar com uma parte deixa o resto em caixa: essa reserva é sua proteção quando o mercado vira.',
  'intro.partial.2': 'Tinha 1000 e entrou com 75%? 750 trabalham em BTC, 250 ficam seguros. Saia em partes também: garanta o lucro e deixe o resto correr. Teste em uma rodada de treino.',
  'howto.1.enter': 'Toque para entrar: todo o seu saldo',
  'howto.1.exit': 'Toque para sair: não seja ganancioso!',
  'howto.short': 'Long ganha na alta, Short ganha na queda',
  'howto.lev': 'Alavancagem ×2–×5 multiplica ganhos E perdas',
  'howto.partial': 'Negocie uma parte do stack: 25 / 50 / 75 / 100%',
  'howto.chart': 'O gráfico é o preço real do Bitcoin',
  'howto.liq': '−50% é liquidação — você perde um coração',
  'ui.balance': 'Saldo',
  'ui.trade': 'Operação',
  'ui.leverage': 'Alavancagem',
  'ui.size': 'Tamanho da operação',
  'ui.upnl': 'P&L não realizado',
  'ui.enter': 'Entrada',
  'ui.current': 'Atual',
  'ui.liq': 'Liquidação',
  'ui.liqCaption': 'Liquidação a −50% da cotação',
  'ui.close': 'Fechar posição', 'ui.study': 'Aprender',
  'ui.closeFrac': 'Fechar {0}%',
  'deal.title': 'Operação',
  'deal.balance': 'Seu saldo',
  'deal.settings': 'Configurações do nível',
  'deal.setup': 'Configure o nível antes de começar o jogo',
  'deal.asset': 'Ativo de trading',
  'deal.start': 'Começar o jogo',
  'deal.unlock.t': 'Nova mecânica desbloqueada!',
  'deal.learn': 'Aprender',
  'deal.mech.partial.d': 'Agora você pode escolher o tamanho da sua posição e controlar o risco',
  'deal.howto.t': 'Como jogar',
  'ui.chartlbl': 'Gráfico de {0} ({1}/USD)',
  'ui.gtitle': 'Trade',
},
ar: {
  'stage.badge': 'المرحلة {0} من {1}',
  'mech.short': 'البيع على المكشوف', 'mech.lev': 'الرافعة ×2–×5', 'mech.partial': 'صفقات جزئية',
  'unlock.band': 'آلية جديدة مفتوحة: {0}',
  'gotit': 'فهمت',
  'intro.short.t': 'فُتح البيع على المكشوف',
  'intro.short.1': 'حتى الآن كان بإمكانك المراهنة فقط على صعود السعر (لونغ). الشورت هو العكس: تربح عندما ينخفض السعر.',
  'intro.short.2': 'اضغط Short عندما تتوقع هبوطاً، ثم Exit لتثبيت الفرق. الاتجاه الخاطئ يعمل ضدك بنفس القدر.',
  'intro.lev.t': 'فُتحت الرافعة المالية',
  'intro.lev.1': 'الرافعة تضاعف صفقتك: مع ×5، تحرك السعر 1% يغيّر رهانك 5%.',
  'intro.lev.2': 'اختر ×2–×5 قبل الدخول. انتبه: التصفية (−50% من الرهان) تقترب مع زيادة الرافعة.',
  'hint.partial': 'جديد: صفقات جزئية — ادخل واخرج بـ 25/50/75% من رصيدك',
  'hint.trainq': 'تبدأ جولة التدريب مباشرة بعد هذه الجولة',
  'intro.partial.t': 'صفقات جزئية — حوّط مخاطرك',
  'intro.partial.1': 'المحترفون نادراً ما يدخلون بكل الرصيد. الدخول بجزء يبقي الباقي نقداً — هذا الاحتياطي هو تحوّطك عندما ينقلب السوق.',
  'intro.partial.2': 'كان معك 1000 ودخلت بـ 75%؟ 750 تعمل في BTC و250 في أمان. اخرج على دفعات أيضاً: ثبّت الربح ودع الباقي يعمل. جرّبها في جولة تدريبية.',
  'howto.1.enter': 'اضغط للدخول: كل رصيدك في الصفقة',
  'howto.1.exit': 'اضغط للخروج: لا تكن جشعاً!',
  'howto.short': 'Long يربح مع الصعود، وShort يربح مع الهبوط',
  'howto.lev': 'الرافعة ×2–×5 تضاعف الأرباح والخسائر معاً',
  'howto.partial': 'تداول بجزء من رصيدك: 25 / 50 / 75 / 100%',
  'howto.chart': 'الرسم البياني هو سعر بيتكوين الحقيقي',
  'howto.liq': '−50% تعني التصفية — تخسر قلباً',
  'ui.balance': 'الرصيد',
  'ui.trade': 'الصفقة',
  'ui.leverage': 'الرافعة المالية',
  'ui.size': 'حجم الصفقة',
  'ui.upnl': 'الأرباح والخسائر غير المحققة',
  'ui.enter': 'الدخول',
  'ui.current': 'الحالي',
  'ui.liq': 'التصفية',
  'ui.liqCaption': 'التصفية عند −50% من السعر',
  'ui.close': 'إغلاق الصفقة', 'ui.study': 'تعلّم',
  'ui.closeFrac': 'إغلاق {0}%',
  'deal.title': 'صفقة',
  'deal.balance': 'رصيدك',
  'deal.settings': 'إعدادات المستوى',
  'deal.setup': 'اضبط المستوى قبل بدء اللعبة',
  'deal.asset': 'أصل التداول',
  'deal.start': 'ابدأ اللعبة',
  'deal.unlock.t': 'آلية جديدة مفتوحة!',
  'deal.learn': 'تعلّم',
  'deal.mech.partial.d': 'يمكنك الآن اختيار حجم صفقتك والتحكم في المخاطر',
  'deal.howto.t': 'طريقة اللعب',
  'ui.chartlbl': 'مخطط {0} ({1}/USD)',
  'ui.gtitle': 'Trade',
},
};
function gt(key) {
  const d = GT_DICT[GLANG] || GT_DICT.en;
  let s = (key in d) ? d[key] : GT_DICT.en[key];
  if (s === undefined) s = key;
  for (let i = 1; i < arguments.length; i++) s = s.split('{' + (i - 1) + '}').join(arguments[i]);
  return s;
}
/* draft-подсветка в игре — по тумблеру хаба (Settings → Show design drafts) */
const DRAFTS_ON = (() => {
  try { const s = JSON.parse(localStorage.getItem('hub.state') || '{}'); return !s || s.drafts !== false; }
  catch (e) { return true; }
})();

// ============================== UTILS ==============================
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
function gauss() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
// монеты/числа: «63 370» (пробел-тысячи, как в макетах онбординга), БЕЗ знака $;
// дроби только у небольших значений
const thou = (n, sep) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, sep);
function fmtCoins(v, sign = false) {
  const a = Math.abs(v);
  const s = v < 0 ? '−' : (sign ? '+' : '');
  const num = a < 1000 && Math.abs(a - Math.round(a)) > 0.005
    ? a.toFixed(2)
    : thou(Math.round(a), ' ');
  return s + num;
}
// шкала графика и флаг цены: «63.370» (точка-тысячи — так в макетах)
const fmtAxis = v => thou(Math.round(v), '.');
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
  short()  { this.tone(640, .09, {type:'square', gain:.08}); this.tone(420, .12, {type:'square', gain:.08, when:.06}); },
  exitWin(){ [523,659,784,1047].forEach((f,i)=>this.tone(f,.14,{type:'triangle',gain:.12,when:i*.06})); },
  exitLoss(){ this.tone(360,.18,{type:'sawtooth',gain:.07,slide:-160}); this.tone(240,.22,{type:'sawtooth',gain:.07,when:.1,slide:-100}); },
  warn()   { this.tone(880,.07,{type:'square',gain:.05}); },
  count()  { this.tone(1200,.06,{type:'square',gain:.06}); },
  liq()    { this.noise(.6,.3); this.tone(110,.7,{type:'sawtooth',gain:.22,slide:-70}); },
  best()   { [659,784,988,1319,1568].forEach((f,i)=>this.tone(f,.18,{type:'triangle',gain:.13,when:i*.09})); },
  unlock() { [523,784,1047,1568].forEach((f,i)=>this.tone(f,.16,{type:'triangle',gain:.13,when:i*.07})); },
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
      try { localStorage.setItem('trade_lastprice', String(this.lastPrice)); } catch (e) {}
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
  fresh() { return this.lastPrice != null && performance.now() - this.lastAt < 5000; },
};
Feed.init();

// ============================== PRICE ENGINE ==============================
// Порт рынка «Сделки» (approved): собственная симуляция режимов + усиленные
// ×GAIN движения живого BTC; vis — глайд; свечи фикс-темпа CANDLE_DUR.
class PriceEngine {
  constructor(p0, live) {
    this.price = p0;
    this.vis = p0;
    this.live = live;
    this.simTime = 0;
    this.tickAcc = 0;
    this.startPrice = p0;
    this.regime = { drift: 0, sigma: 0.011, until: 0 };
    this.trendStreak = 0; this.lastDir = 0;
    this.lastReal = null;
    this.candles = [];
    this.hist = [];
    this.script = null; // сценарий обучающего раунда (п.36) — ставится ПОСЛЕ prefill
    this.nextRegime();
  }
  nextRegime() {
    const rel = this.price / this.startPrice;
    let upW = 0.38, dnW = 0.38;
    if (rel > 1.6) { upW = 0.30; dnW = 0.46; }
    else if (rel < 0.45) { upW = 0.46; dnW = 0.30; }
    const r = Math.random();
    let dir = 0;
    if (r < upW) dir = 1; else if (r < upW + dnW) dir = -1;
    let dur, drift, sigma;
    if (dir === 0) {
      dur = 0.9 + Math.random() * 3.1;
      drift = (Math.random() - 0.5) * 0.008;
      sigma = 0.010 + Math.random() * 0.008;
    } else {
      dur = 1.2 + Math.random() * 5.2;
      drift = dir * (0.010 + Math.random() * 0.017);
      sigma = 0.008 + Math.random() * 0.005;
      const q = Math.random();
      if (q < 0.10) { dur = 0.7 + Math.random() * 0.7; drift *= 2.4; }
      else if (q < 0.28) { dur = 0.5 + Math.random() * 0.9;
        drift *= (Math.random() < 0.5 ? -1 : 1) * (1.4 + Math.random()); }
    }
    this.regime = { drift, sigma, until: this.simTime + dur };
  }
  marketTick(dt) {
    /* сценированный режим обучающих раундов (п.36): сегменты TUT_SCRIPT вместо
       генератора режимов; живой фид и OB_VOL-буст отключены — форма урока
       детерминирована ДАННЫМИ сценария, а не хардкодом рендера */
    if (this.script) {
      const sc = this.script;
      let seg = sc.segs[sc.idx];
      if (this.simTime - sc.segT0 >= seg.dur && sc.idx < sc.segs.length - 1 &&
          (!seg.hold || sc.released(seg.hold))) {
        sc.idx++; sc.segT0 = this.simTime; seg = sc.segs[sc.idx];
        if (seg.emit) postTutEvent('phase:' + seg.emit); // подсказка приходит В МОМЕНТ события
      }
      Feed.pendingReal = null; // реальные тики не подмешиваем в урок
      const dp = seg.drift * dt + seg.sigma * Math.sqrt(dt) * gauss();
      this.price = Math.max(1, this.price * Math.exp(dp));
      return;
    }
    if (this.simTime >= this.regime.until) this.nextRegime();
    let realDp = 0;
    const live = this.live && Feed.fresh();
    if (live && Feed.pendingReal) {
      if (this.lastReal) realDp = clamp(Math.log(Feed.pendingReal / this.lastReal) * CFG.GAIN, -0.02, 0.02);
      this.lastReal = Feed.pendingReal;
      Feed.pendingReal = null;
    }
    const genScale = live ? 0.7 : 1;
    // stage<3 (до анлока плеча): цена ходит ×OB_VOL активнее — новичок ВИДИТ качели
    // на самом графике; вторая половина буста (×2 по очкам) — LEV_BASE (вердикт 26.07)
    const volX = P.stage < 3 ? CFG.OB_VOL : 1;
    const dp = (this.regime.drift * dt * genScale +
               this.regime.sigma * genScale * Math.sqrt(dt) * gauss() + realDp) * volX;
    this.price = Math.max(1, this.price * Math.exp(dp));
  }
  step(dt) {
    if (this.live && !Feed.fresh()) {
      this.live = false;
      G.offline = true;
      $('offlineBadge').classList.remove('hidden');
    }
    this.simTime += dt;
    this.tickAcc += dt;
    while (this.tickAcc >= CFG.SIM_TICK) { this.tickAcc -= CFG.SIM_TICK; this.marketTick(CFG.SIM_TICK); }
    this.vis += (this.price - this.vis) * (1 - Math.exp(-dt / CFG.VIS_EASE));
    let c = this.candles[this.candles.length - 1];
    if (!c || this.simTime - c.t0 >= CFG.CANDLE_DUR) {
      c = { t0: c ? c.t0 + CFG.CANDLE_DUR : this.simTime, o: this.vis, h: this.vis, l: this.vis, c: this.vis };
      this.candles.push(c);
      if (this.candles.length > CFG.VISIBLE + 4) this.candles.shift();
    }
    c.c = this.vis; if (this.vis > c.h) c.h = this.vis; if (this.vis < c.l) c.l = this.vis;
    this.hist.push({ t: this.simTime, p: this.vis });
    while (this.hist.length && this.simTime - this.hist[0].t > 3) this.hist.shift();
  }
  prefill() {
    for (let i = 0; i < (CFG.VISIBLE + 1) * CFG.CANDLE_DUR * 30; i++) this.step(1 / 30);
  }
}

// ============================== FX (конфетти) ==============================
const FX = {
  cv: null, cx: null, parts: [],
  init() { this.cv = $('fx'); this.cx = this.cv.getContext('2d'); this.resize(); },
  resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cv.width = SW * dpr; this.cv.height = SH * dpr;
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
  rain() { for (let i = 0; i < 90; i++) setTimeout(() => this.burst(20 + Math.random() * 335, -10, 1, true), i * 18); },
  update(dt) {
    if (!this.parts.length) { this.cx.clearRect(0, 0, 375, 812); return; }
    this.cx.clearRect(0, 0, 375, 812);
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
  cash: CFG.START_BAL,       // свободные монеты
  dispBal: CFG.START_BAL, seed: CFG.START_BAL,
  pos: null,                 // {dir, lev, frac, entryPrice, stake, entryT, peakPnl}
  hearts: CFG.HEARTS,
  trades: [],
  liqsThisRound: 0,
  streak: 0,                 // подряд закрытых сделок в плюс (сигнал «пика», встреча п.5)
  peakSent: false,
  best: (() => { try { return Number(localStorage.getItem('trade_best') || 0); } catch (e) { return 0; } })(),
  engine: null, offline: false, startPrice: 0,
  dispPrice: 0,
  txtAcc: 9,
  axisTxt: '',
  lastFrame: 0, lastDt: 1 / 60, lastCountSec: 99, melting: false,
  yMin: 0, yMax: 1, yInit: false,
  // выбор игрока (контролы)
  asset: 'BTC',              // Deal-экран (f2055): BTC/ETH/SOL — подпись графика + сид цены
  lev: CFG.LEV_BASE,         // stage<3 — скрытый LEV_BASE; stage 3+ — выбор из LEVS
  frac: 1,                   // stage<4 — всегда 1; stage 4+ — выбор из FRACS
  // возможности ТЕКУЩЕГО раунда (фиксируются на старте; вердикт 30.07 п.23):
  // онбординг-сим 1 — только лонг; сим 2 — +шорт; сим 3 — +плечо; реальные — по стадии
  caps: { short: false, lev: false, frac: false, ob: 0 },
};
/* гейты раунда (вердикт 30.07 п.23): в онбординге механики открываются ПО РАУНДАМ
   (1 лонг / 2 шорт / 3 плечо), частичные позиции — всегда пост-онбординг (п.18 без
   изменений); в реальных раундах — прежняя стадийная логика */
function roundCaps() {
  if (G.simRound && !G.partialTraining) {
    const n = clamp(P.rounds + 1, 1, OB_ROUNDS);
    return { short: n >= 2, lev: n >= 3, frac: false, ob: n };
  }
  return { short: P.stage >= 2, lev: P.stage >= 3, frac: P.stage >= 4 || !!G.partialTraining, ob: 0 };
}
// полный баланс «по себестоимости»: кэш + вложенное в позицию (двигается при закрытии)
function balTotal() { return G.cash + (G.pos ? G.pos.stake : 0); }

const chart = $('chart');
const ctx = chart.getContext('2d');
let chartW = 0, chartH = 0;
// стейдж = фигма-фрейм макетов @1x (375×812); в окне/айфрейме масштабируется
const SW = 375, SH = 812;
let RING_LEN = 220, RING_OFF = 0; // периметр обводки таймера — пересчитывается под скин

/* ---------- тема канваса: цвета/метрика графика живут в ТЕХ ЖЕ CSS-переменных,
   что и остальной скин (--ch-*), канвас их читает через getComputedStyle.
   Пересчитывается на буте, на смене скина и на ресайзе. ---------- */
const TH = {};
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = n => cs.getPropertyValue(n).trim();
  const num = (n, d) => { const x = parseFloat(v(n)); return isFinite(x) ? x : d; };
  const famUI = v('--font-ui') || 'Inter, sans-serif';
  const famNum = v('--font-num') || famUI;
  TH.grid = v('--ch-grid') || 'rgba(0,0,0,.08)';
  const dash = v('--ch-dash').split(/[\s,]+/).map(Number).filter(n => isFinite(n));
  TH.dash = (dash.length && dash.some(n => n > 0)) ? dash : [];
  TH.lines = Math.max(2, num('--ch-lines', 4));
  TH.axis = v('--ch-axis') || 'rgba(0,0,0,.45)';
  TH.axisFont = num('--ch-axis-fw', 400) + ' ' + num('--ch-axis-fs', 10) + 'px ' +
    (v('--ch-axis-font') === 'num' ? famNum : famUI);
  TH.up = v('--ch-up') || '#16C784';
  TH.down = v('--ch-down') || '#EA3943';
  TH.body = num('--ch-body', 0.6);
  TH.wick = num('--ch-wick', 2);
  TH.brad = num('--ch-brad', 2);
  TH.zone = v('--ch-zone') || 'rgba(22,199,132,.10)';
  TH.zoneLine = v('--ch-zone-line') || 'rgba(0,0,0,0)';
  TH.liq = v('--ch-liq') || 'rgba(234,57,67,.85)';
  TH.flag = num('--ch-flag', 0) > 0;
  TH.flagBg = v('--ch-flag-bg') || '#228BEE';
  TH.flagTx = v('--ch-flag-tx') || '#fff';
  TH.flagR = num('--ch-flag-r', 4);
  TH.flagFont = num('--ch-flag-fw', 700) + ' ' + num('--ch-flag-fs', 11) + 'px ' + famUI;
  TH.flagLine = num('--ch-flagline', 0) > 0;
}

/* обводка-прогресс таймера: <rect rx> вместо круга — одна механика работает
   и для пилюли (crypto-light / cream), и для круга (crypto-dark / corporate) */
function layoutTimer() {
  const box = $('timerCircle'), svg = $('timerRing');
  if (!box || !svg) return;
  const w = box.offsetWidth || 58, h = box.offsetHeight || 30;
  const cs = getComputedStyle(box);
  const sw = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--timer-rw')) || 2;
  const rx = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, w / 2, h / 2);
  const ins = sw / 2;
  const rw = Math.max(1, w - sw), rh = Math.max(1, h - sw);
  const rr = clamp(rx - ins, 0, Math.min(rw, rh) / 2);
  svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
  for (const el of svg.querySelectorAll('rect')) {
    el.setAttribute('x', ins); el.setAttribute('y', ins);
    el.setAttribute('width', rw); el.setAttribute('height', rh);
    el.setAttribute('rx', rr);
  }
  const topEdge = Math.max(0, rw - 2 * rr);
  RING_LEN = 2 * topEdge + 2 * Math.max(0, rh - 2 * rr) + 2 * Math.PI * rr;
  RING_OFF = -topEdge / 2; // дуга начинается от 12 часов и растёт по часовой
  const arc = $('ringArc');
  arc.style.strokeDashoffset = RING_OFF;
  arc.style.strokeDasharray = '0 ' + RING_LEN.toFixed(1);
}

function resizeAll() {
  const s = Math.min(window.innerWidth / SW, window.innerHeight / SH);
  $('stage').style.setProperty('--s', s);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const r = $('chartPlot').getBoundingClientRect();
  const st = $('stage').getBoundingClientRect();
  chartW = st.width > 0 ? r.width / (st.width / SW) : SW - 2 * 16;
  chartH = st.height > 0 ? r.height / (st.height / SH) : 200;
  chart.width = Math.max(10, Math.round(chartW * dpr));
  chart.height = Math.max(10, Math.round(chartH * dpr));
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  layoutTimer();
  FX.resize();
}

/* смена скина на живой игре (postMessage hub:skin из дев-переключателя Style) */
function setSkin(s) {
  if (!applySkin(s)) return;
  readTheme();
  resizeAll();
  if (G.screen === 'start') renderStart();
  syncChrome();
}
/* заголовок в navy-баре (corporate): «Deal» на пред-раунде, имя игры в раунде */
function syncChrome() {
  const el = $('gtopTitle');
  // на Deal заголовок рисует сама шапка экрана (.deal-title внутри navy-полосы) —
  // полосу оставляем без подписи, чтобы не было двух «Deal»
  if (el) el.textContent = G.screen === 'start' ? '' : gt('ui.gtitle');
}

/* PnL позиции в % от стейка: dir-осознанный (шорты по модели «Лонг/Шорт»),
   плечо игрока (stage 3+) или скрытый буст ×4 (stage 1–2) */
function pnlNow() {
  if (!G.pos) return 0;
  return G.pos.dir * (G.dispPrice / G.pos.entryPrice - 1) * 100 * G.pos.lev;
}
function liqPriceOf(pos) {
  // pnl = dir*(p/e−1)*lev*100 = LIQ_PNL → p = e*(1 + LIQ_PNL/(100*lev*dir))
  return pos.entryPrice * (1 + CFG.LIQ_PNL / (100 * pos.lev * pos.dir));
}

// ---------- screens ----------
function show(name) {
  G.screen = name;
  $('screen-start').classList.toggle('hidden', name !== 'start');
  $('screen-game').classList.toggle('hidden', name !== 'game');
  $('screen-result').classList.toggle('hidden', name !== 'result');
  if (name === 'start') renderStart();
  syncChrome();
  resizeAll();
}

// hub integration: из хаба раунд играется котлетой кошелька (hub.balance)
function hubStartBal() {
  if (window.parent === window) return null;
  try {
    const v = parseInt(localStorage.getItem('hub.balance'), 10);
    if (Number.isFinite(v)) return Math.max(0, v);
  } catch (e) {}
  return null;
}

// ---------- start screen: «Deal» — пред-раундовые настройки уровня (f2055) ----------
function renderStart() {
  // баланс: онбординг/тренировка = симуляция с фикс-сидом, иначе кошелёк хаба
  const hb = hubStartBal();
  const sim = onboarding() || !!P.pendingPartial;
  $('dealBal').textContent = fmtCoins(sim || hb === null ? CFG.START_BAL : hb);
  // селектор актива
  document.querySelectorAll('#assetChips .asset-chip').forEach(b =>
    b.classList.toggle('on', b.dataset.asset === G.asset));
  // баннер «новая механика»: ровно кейс макета — частичные позиции доступны к
  // изучению (stage 3, онбординг пройден). ★draft: других механик Deal-баннер не
  // объявляет (шорты/плечо анлочатся внутри онбординга, Deal там пропускается)
  const showUnlock = !onboarding() && P.stage === 3;
  $('dealUnlock').classList.toggle('hidden', !showUnlock);
  if (showUnlock) {
    $('duName').textContent = gt('mech.partial');
    $('duDesc').textContent = gt('deal.mech.partial.d');
    $('dealUnlock').classList.toggle('draftable', DRAFTS_ON);
  }
  // правила игры для (i)-оверлея (бывший стартовый howto-список)
  const list = $('howtoList');
  const rows = [['👆', gt('howto.1.enter')], ['📈', gt('howto.chart')], ['✋', gt('howto.1.exit')]];
  if (P.stage >= 2) rows.push(['↕️', gt('howto.short')]);
  if (P.stage >= 3) rows.push(['⚡', gt('howto.lev')]);
  if (P.stage >= 4) rows.push(['🧩', gt('howto.partial')]);
  rows.push(['💥', gt('howto.liq')]);
  list.innerHTML = rows.map(([i, s]) => `<li><span class="how-ico">${i}</span> ${s}</li>`).join('');
}

// ---------- intro overlays (one-time онбординг ступеней; решение встречи п.3) ----------
function introDue() {
  if (P.stage >= 2 && !P.intros.short) return 'short';
  if (P.stage >= 3 && !P.intros.lev) return 'lev';
  return null;
}
function showIntro(kind, onDone) {
  // пауза на время интро: без неё раунд дотикивал и ликвидировался ПОД оверлеем (QA 25.07)
  const wasPaused = G.paused;
  G.paused = true;
  const ov = $('introOverlay');
  $('introTitle').textContent = gt('intro.' + kind + '.t');
  $('introBody').innerHTML =
    `<p>${gt('intro.' + kind + '.1')}</p><p>${gt('intro.' + kind + '.2')}</p>` +
    (kind === 'short'
      ? `<div class="intro-demo"><span class="demo-pill long">Long ▲</span><span class="demo-pill short">Short ▼</span></div>`
      : kind === 'partial'
      ? `<div class="intro-demo"><span class="demo-pill lev">25%</span><span class="demo-pill lev">50%</span><span class="demo-pill lev">75%</span><span class="demo-pill lev on">100%</span></div>` // активный 100% — мокап 761:31253
      : `<div class="intro-demo"><span class="demo-pill lev">×1</span><span class="demo-pill lev on">×2</span><span class="demo-pill lev">×3</span><span class="demo-pill lev">×4</span><span class="demo-pill lev">×5</span></div>`);
  $('introDraft').classList.toggle('hidden', !DRAFTS_ON);
  ov.classList.remove('hidden');
  $('btnIntroOk').textContent = gt('gotit');
  const closeIntro = () => {
    ov.classList.add('hidden');
    G.paused = wasPaused;
    P.intros[kind] = true;
    saveP();
    if (onDone) onDone();
  };
  $('btnIntroOk').onclick = closeIntro;
  $('btnIntroX').onclick = closeIntro; // X по макету 761:31253 = то же закрытие
}

function startRound() {
  // интро-модалки шортов/плеча в онбординге НЕ показываются (вердикт 30.07 п.23:
  // их заменяют хабовые баблы туториала); путь для игрока, миновавшего онбординг
  // (миграция со старых порогов), оставлен рабочим
  if (!onboarding()) {
    const intro = introDue();
    if (intro) { showIntro(intro, startRound); return; }
  }

  // актив раунда (Deal-экран): BTC — живой фид Binance; ETH/SOL — генератор от
  // типичного сида (★draft, см. ASSETS); подписи графика/тикера — от актива
  const A = ASSETS[G.asset] || ASSETS.BTC;
  const liveOk = A.live && Feed.ready && Feed.fresh();
  const seed = A.live
    ? (Feed.lastPrice || (() => { try { return Number(localStorage.getItem('trade_lastprice')); } catch (e) { return 0; } })() || A.seed)
    : A.seed;
  G.offline = !liveOk;
  // ⚡-бейдж — только когда живой фид ОЖИДАЛСЯ и пропал; ETH/SOL офлайновы по дизайну
  $('offlineBadge').classList.toggle('hidden', liveOk || !A.live);
  $('chartTag').textContent = gt('ui.chartlbl', A.name, A.ticker);
  $('tickerAsset').textContent = A.ticker;
  G.engine = new PriceEngine(seed, liveOk);
  G.engine.prefill();

  // онбординг = СИМУЛЯЦИЯ (вердикт 25.07): сид всегда 1000, кошелёк игрока не трогаем;
  // обучающий раунд частичных позиций (тап по 🔒) — тоже симуляция, тем же контуром.
  // Флаги фиксируем на старте, чтобы финиш раунда судился по тому, чем раунд БЫЛ
  G.partialTraining = !!P.pendingPartial;
  if (P.pendingPartial) { P.pendingPartial = false; saveP(); }
  G.simRound = onboarding() || G.partialTraining;
  const hb = hubStartBal();
  G.seed = G.simRound ? CFG.START_BAL : (hb !== null ? hb : CFG.START_BAL);
  G.gameT = 0; G.cash = G.seed; G.dispBal = G.seed;
  G.pos = null; G.trades = []; G.over = false; G.paused = false;
  G.hubReported = false;
  G.hearts = CFG.HEARTS; G.lastCountSec = 99; G.melting = false; G.yInit = false;
  G.liqsThisRound = 0; G.streak = 0; G.peakSent = false;
  // длительность зафиксирована на старте (обучающие 15с / обычный 60с); плашки не врут
  G.roundMs = (G.simRound ? CFG.OB_ROUND_SEC : CFG.ROUND_SEC) * 1000;
  document.querySelectorAll('.js-roundlen').forEach(el => { el.textContent = (G.roundMs / 1000) + ' sec'; });
  // таймер сразу показывает ДЛИНУ ЭТОГО раунда (QA 30.07: замороженный за баблами
  // онбординг-раунд светил статикой «1:00» при 15-секундном раунде)
  $('timerText').textContent = fmtTimer(G.roundMs / 1000);
  $('timerText').classList.remove('hot');
  layoutTimer();
  G.startPrice = G.engine.vis;
  G.dispPrice = G.engine.vis;
  G.txtAcc = 9; G.axisTxt = '';
  // гейты раунда — по типу раунда (онбординг-сим N / реальный), фиксируются на старте
  G.caps = roundCaps();
  // дефолт плеча (вердикт 25.07 ×2; в ОБУЧАЮЩИХ раундах ×3 — решение Павла 31.07 п.36б):
  // пока игрок сам не выбрал сегмент (G.levUserSet живёт в рамках iframe) — LEV_BASE
  // входит в LEVS, поэтому проверка принадлежности дефолт не чинила (находка QA 25.07)
  if (G.caps.lev) {
    if (!G.levUserSet || !CFG.LEVS.includes(G.lev))
      G.lev = G.simRound ? CFG.TUT_LEV_DEF : CFG.LEV_DEF;
  } else G.lev = CFG.LEV_BASE;
  G.frac = 1;

  // сценарий обучающего раунда (п.36): онбординг-симы 1–3 и тренировка частичных —
  // на сценированной последовательности сегментов; реальные раунды живут прежним движком
  G.timeHold = false;
  G.tutGo = false;
  const scriptKey = G.partialTraining ? 'p' : (G.caps.ob > 0 ? G.caps.ob : null);
  if (scriptKey && TUT_SCRIPT[scriptKey]) {
    G.engine.script = {
      segs: TUT_SCRIPT[scriptKey], idx: 0, segT0: G.engine.simTime,
      released: h => h === 'go' ? G.tutGo
        : h === 'frac' ? G.frac !== 1 || !!G.pos
        : h === 'enter' ? !!G.pos
        : !G.pos,
    };
  }

  // сим-раунды (онбординг + тренировка частичных): сердца скрыты, справа кебаб
  // (макеты onb1–onb3 и 558:10599 — у тренировки частичных тоже кебаб; данные
  // сердец живут, кебаб открывает существующее пауза-меню; в реальных раундах — сердца)
  const obSim = G.caps.ob > 0 || G.partialTraining;
  $('hearts').classList.toggle('hidden', obSim);
  $('btnKebab').classList.toggle('hidden', !obSim);
  document.querySelectorAll('#hearts .heart').forEach(h => h.classList.remove('lost', 'pop'));
  $('pnlBox').classList.add('hidden');
  $('tickerBox').classList.remove('hidden');
  $('tradeCell').classList.add('hidden');
  $('liqOverlay').classList.add('hidden');
  $('meltWarn').classList.add('hidden');
  renderControls();
  show('game');

  // обучающий раунд частичных позиций: в хабе туториал ведёт оболочка (интерактивные
  // баблы по событию 'partial-start', п.36 — 4-й туториал в том же стиле);
  // standalone-запуск остаётся на старой плашке-подсказке
  if (G.partialTraining) {
    if (window.parent !== window) postTutEvent('partial-start');
    else hintFloat(gt('hint.partial'));
  }
}

/* тап по залоченным Size (вердикт 25.07): интро про хеджирование → обучающий сим-раунд.
   Живой раунд НЕ перезапускаем (QA 25.07: сжигал fee и результат) — тренировка встаёт
   в очередь (P.pendingPartial, переживает закрытие iframe) и стартует следующим раундом. */
function startPartialTraining() {
  showIntro('partial', () => {
    // рефанд входа (вердикт 27.07 вечер): игрок ПЛАТНОГО раунда проваливается в обучение —
    // просим хаб вернуть fee. Только реальный раунд (!G.simRound: онбординг/повтор
    // тренировки бесплатны) и один запрос на заказ (гейт !P.pendingPartial); хаб сам
    // дополнительно гардит «ровно один рефанд на платный раунд» (hub:feeRefund в shell.js)
    if (!G.simRound && !P.pendingPartial && window.parent !== window) {
      try { window.parent.postMessage({ type: 'hub:feeRefund', game: 'trade' }, '*'); } catch (e) {}
    }
    P.pendingPartial = true;
    saveP();
    // ★draft: заказ с Deal-экрана (кнопка Learn, f2055) — раунд ещё не начат,
    // тренировка уедет в ближайший Start game; баланс на Deal станет сим-сидом
    if (G.screen === 'start') { renderStart(); return; }
    if (G.over) { startRound(); return; }
    hintFloat(gt('hint.trainq'));
  });
}

// ---------- controls (кнопки + ряды Leverage / Trade size по гейтам раунда) ----------
function renderControls() {
  const inPos = !!G.pos;
  const caps = G.caps;
  // кнопки действий: раунд без шортов = одна зелёная Buy (макет onb1-1);
  // с шортами — пара Long/Short; в позиции — синяя Close position
  $('btnLong').classList.toggle('hidden', inPos);
  $('btnShort').classList.toggle('hidden', inPos || !caps.short);
  $('btnExit').classList.toggle('hidden', !inPos);
  $('lblLong').textContent = caps.short ? 'Long' : 'Buy';
  if (inPos) {
    $('lblExit').textContent = (caps.frac && G.frac < 1)
      ? gt('ui.closeFrac', Math.round(G.frac * 100))
      : gt('ui.close');
  }
  // ряд плеча: всегда виден вне позиции; до анлока — залочен (замок + пилюли 30%,
  // «выбран» показывается x1 — макеты onb1-4/onb2-4)
  const levCtl = $('levCtl');
  const levLocked = !caps.lev;
  levCtl.classList.toggle('locked', levLocked);
  levCtl.querySelector('.lock-ico').classList.toggle('hidden', !levLocked);
  levCtl.querySelectorAll('button[data-lev]').forEach(b =>
    b.classList.toggle('on', +b.dataset.lev === (levLocked ? 1 : G.lev)));
  // ряд доли: весь онбординг залочен (100% «выбран»); в основной игре на stage 3 —
  // залочен + кнопка 🔒 Open (обучающий раунд, вердикт 25.07 / п.18); stage 4+ открыт
  const fracCtl = $('fracCtl');
  const fracLocked = !caps.frac;
  const fracUnlockable = fracLocked && P.stage >= 3 && !onboarding() && !G.simRound;
  fracCtl.classList.toggle('locked', fracLocked);
  fracCtl.querySelector('.lock-ico').classList.toggle('hidden', !fracLocked);
  fracCtl.querySelectorAll('button[data-frac]').forEach(b =>
    b.classList.toggle('on', +b.dataset.frac === (fracLocked ? 1 : G.frac)));
  $('fracUnlock').classList.toggle('hidden', !fracUnlockable);
  // разлоченный ряд: фактическая сумма входа рядом с лейблом — «Trade size ◑ 1 000»
  // (п.35, мокап 558:10455); сумма = доля × свободный кэш
  const showAmt = !fracLocked && !inPos;
  $('fracAmt').classList.toggle('hidden', !showAmt);
  if (showAmt) $('fracAmtV').textContent = fmtCoins(Math.round(G.cash * G.frac));
  // в позиции ряды скрыты — карточка PnL раскрывается на их место (макеты onb1-5/onb3-5)
  $('ctlBar').classList.toggle('hidden', inPos);
  $('infoCard').classList.toggle('inpos', inPos);
  $('liqBlock').classList.toggle('hidden', !inPos || !caps.lev);
  // ★draft: карточка цены под графиком — в макетах 31.07 её нет (цена там живёт в шапке
  // карточки графика), но живой игре нужен тикер и на неё якорится бабл онбординга
  // ob1.1 (#tickerBox в shell.js) — помечаем драфтом, ряды Leverage/Size канон макета
  $('infoCard').classList.toggle('draftable', DRAFTS_ON && !inPos);
}

// ---------- позиция ----------
/* комиссия за вход: 0.5% вложенного стейка (душит микро-скальпинг; решение 24.07) */
const TRADE_FEE = 0.005;
function feeFloat(txt) { floatMsg(txt, '#e8b64e'); }
function hintFloat(txt) { floatMsg(txt, '#4a63e7', 2600); }
function floatMsg(txt, color, life = 950) {
  const d = document.createElement('div');
  d.textContent = txt;
  d.style.cssText = 'position:fixed;left:50%;top:26%;transform:translate(-50%,0);color:' + color + ';' +
    'font:700 15px -apple-system,Arial;opacity:1;transition:all ' + (life / 1000) + 's ease-out;z-index:60;' +
    'pointer-events:none;text-shadow:0 1px 3px rgba(0,0,0,.45);max-width:320px;text-align:center;';
  document.body.appendChild(d);
  requestAnimationFrame(() => { d.style.opacity = '0'; d.style.transform = 'translate(-50%,-30px)'; });
  setTimeout(() => d.remove(), life + 60);
}

/* вход: stake = frac × кэш (частичные позиции, stage 4), плечо игрока (stage 3+).
   Математика: позиция = frac × stack × lev (номинал); PnL в % считается от стейка.
   Пример-эталон (встреча): 1000 монет, вход 75% → 750 в позиции, 250 в кэше. */
function enterPos(dir) {
  if (G.pos || G.cash < 1) return;
  if (dir === -1 && !G.caps.short) return; // шорт закрыт до его гейта (сим 2 / stage 2)
  const frac = G.caps.frac ? G.frac : 1;
  const gross = G.cash * frac;
  const fee = gross * TRADE_FEE;
  const stake = gross - fee;
  G.cash -= gross;
  if (fee > 0) feeFloat('fee −' + fmtCoins(Math.max(1, Math.round(fee))));
  G.pos = {
    dir,
    lev: G.caps.lev ? G.lev : CFG.LEV_BASE,
    frac,
    entryPrice: G.dispPrice,
    stake,
    entryT: G.gameT,
    peakPnl: 0,
  };
  G.melting = false;
  G.frac = 1; // после входа селектор доли = доля ВЫХОДА, дефолт 100%
  $('pnlBox').classList.remove('hidden');
  $('tickerBox').classList.add('hidden');
  $('entryPriceEl').textContent = fmtCoins(G.pos.entryPrice);
  // полоса сверху при открытой позиции (п.35, мокап 558:10599): Balance = свободный
  // кэш (updateHUD), Trade = монеты в позиции — статично на всю жизнь позиции
  $('tradeCell').classList.remove('hidden');
  $('tradeTop').textContent = fmtCoins(Math.round(G.pos.stake));
  renderPosMeta();
  renderControls();
  if (G.simRound) postTutEvent('enter:' + dir); // интерактивный туториал (п.36)
  if (dir === 1) Sound.enter(); else Sound.short();
}

/* бейджи карточки позиции (макет onb3-5): слева синий xN, справа Long/Short —
   только с открытым плечом (онбординг-сим 3 / stage 3+); в ранних симах карточка чистая */
function renderPosMeta() {
  const p = G.pos;
  if (!p) return;
  const showB = G.caps.lev;
  const lb = $('posLevBadge'), db = $('posDirBadge');
  lb.classList.toggle('hidden', !showB);
  db.classList.toggle('hidden', !showB);
  if (showB) {
    lb.textContent = 'x' + p.lev;
    db.textContent = p.dir === 1 ? 'Long' : 'Short';
    db.classList.toggle('long', p.dir === 1);
    db.classList.toggle('short', p.dir === -1);
  }
}

/* сим-панель открытой позиции для шага туториала про −50% (мокап 568:15209, Павел
   01.08): рисуем in-position UI с фейковыми числами БЕЗ реальной G.pos — Long x3,
   PnL −16% (треть пути до ликвидации → полоса заполнена на 32%). Значения статичны:
   шаг read-типа, график под chartHold. Off возвращает flat-UI через renderControls. */
function tutSimPos(on) {
  if (!!G.tutSim === !!on) return;
  G.tutSim = !!on;
  if (G.pos) return; // реальная позиция главнее — сим не трогает её UI
  if (on) {
    const px = Math.round(G.dispPrice || G.startPrice || 63370);
    $('pnlBox').classList.remove('hidden');
    $('pnlBox').classList.add('neg');
    $('tickerBox').classList.add('hidden');
    $('infoCard').classList.add('inpos');
    $('ctlBar').classList.add('hidden');
    $('btnLong').classList.add('hidden');
    $('btnShort').classList.add('hidden');
    $('btnExit').classList.remove('hidden');
    $('lblExit').textContent = gt('ui.close');
    const lb = $('posLevBadge'), db = $('posDirBadge');
    lb.textContent = 'x3'; lb.classList.remove('hidden');
    db.textContent = 'Long'; db.classList.add('long'); db.classList.remove('short'); db.classList.remove('hidden');
    $('liqBlock').classList.remove('hidden');
    $('uPnlUsd').textContent = fmtCoins(-160, true);
    $('uPnlUsd').style.transform = '';
    $('uPnlPct').textContent = fmtPct(-16);
    $('entryPriceEl').textContent = fmtCoins(px);
    $('curPriceEl').textContent = fmtCoins(Math.round(px * 0.947));
    $('liqFill').style.width = '32%';
  } else {
    $('pnlBox').classList.add('hidden');
    $('pnlBox').classList.remove('neg');
    $('tickerBox').classList.remove('hidden');
    $('liqFill').style.width = '0%';
    renderControls(); // вернёт ряды/кнопки/inpos по фактическому состоянию (без позиции)
  }
}

/* выход: доля fracExit реализуется в кэш; остаток позиции живёт с той же ценой входа */
function exitPos(auto = false) {
  if (!G.pos) return;
  const fracExit = (G.caps.frac && !auto) ? G.frac : 1;
  const pnl = clamp(pnlNow(), CFG.LIQ_PNL, 99999);
  const part = G.pos.stake * fracExit;
  const realized = Math.max(0, part * (1 + pnl / 100));
  G.cash += realized;
  G.pos.stake -= part;
  recordTrade(pnl, realized - part, false, auto);
  if (fracExit === 0.5) Tasks.set('partial50'); // practice task №3
  const closedAll = fracExit >= 1 || G.pos.stake < 1;
  if (closedAll) {
    if (G.pos.stake > 0) { G.cash += Math.max(0, G.pos.stake * (1 + pnl / 100)); G.pos.stake = 0; }
    closePosUI();
  } else {
    renderPosMeta();
    renderControls();
  }
  if (G.simRound && !auto) postTutEvent('exit'); // интерактивный туториал (п.36)
  if (pnl >= 0) Sound.exitWin(); else Sound.exitLoss();
  if (pnl >= 30) FX.burst(188, 370, 36);
  flash(false);
}

function recordTrade(pnl, usd, liq, auto) {
  const p = G.pos;
  G.trades.push({
    pnl, usd,
    dir: p ? p.dir : 1,
    lev: p ? p.lev : CFG.LEV_BASE,
    dur: Math.max(1, Math.round((G.gameT - (p ? p.entryT : G.gameT)) / 1000)),
    liq: !!liq, auto: !!auto,
  });
  if (usd > 0 && !liq) {
    P.profitTrades++;
    saveP();
    Tasks.set('profit'); // practice task №1
    G.streak++;
    // (вердикт 25.07) пик-триггер «4 профитных закрытия подряд» ОТМЕНЁН — теперь пик
    // считается по РАУНДАМ (3 выигранных подряд с PnL ≥ +30%, см. finishRound)
  } else if (usd < 0 || liq) {
    G.streak = 0;
  }
}

function closePosUI() {
  G.pos = null; G.melting = false;
  $('pnlBox').classList.add('hidden');
  $('tickerBox').classList.remove('hidden');
  $('tradeCell').classList.add('hidden');
  $('meltWarn').classList.add('hidden');
  G.frac = 1;
  renderControls();
}

function flash(red) {
  const f = $('flash');
  f.classList.toggle('red', red);
  f.classList.remove('on'); void f.offsetWidth; f.classList.add('on');
}

// ---------- ликвидация / конец раунда ----------
function liquidate() {
  const part = G.pos.stake;
  const realized = Math.max(0, part * (1 + CFG.LIQ_PNL / 100));
  G.cash += realized;
  G.pos.stake = 0;
  recordTrade(CFG.LIQ_PNL, realized - part, true, false);
  closePosUI();
  if (G.simRound) postTutEvent('liq'); // интерактивный туториал (п.36)
  G.liqsThisRound++;
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
  if (G.pos) exitPos(true);
  // 450 → 200 (Павел 01.08: «пролаг секунду и потом только результаты»);
  // в паре с 900 → 300 на стороне шелла
  setTimeout(() => finishRound(), 200);
}

// hub integration: результат раунда + лесенка (stage/stagedUp) — контракт hub:roundEnd.
// sim=true (раунд онбординга) → шелл НЕ зачисляет фишки; peak=true → прайм-момент
// «пика» по вердикту 25.07 (3 выигранных раунда подряд с PnL ≥ +30%)
function reportToHub(earned, stagedUp) {
  if (window.parent === window) return;
  try {
    window.parent.postMessage({
      type: 'hub:roundEnd', game: 'trade', earned: Math.round(earned),
      stage: P.stage, stagedUp: !!stagedUp,
      sim: !!G.simRound, peak: !G.simRound && P.hotStreak >= 3,
      // АДДИТИВНЫЕ поля (30.07, под новый Round Complete хаба; старые не переименованы):
      // obRound — номер только что сыгранного онбординг-сима (1..3, 0 = не онбординг);
      // trades/wins/liqs — закрытия за раунд; bestTradePnl — лучший PnL сделки, %
      obRound: G.caps.ob || 0,
      trades: G.trades.length,
      wins: G.trades.filter(t => t.usd > 0 && !t.liq).length,
      liqs: G.liqsThisRound,
      bestTradePnl: G.trades.length ? Math.round(Math.max(...G.trades.map(t => t.pnl))) : 0,
    }, '*');
  } catch (e) {}
}

function finishRound() {
  $('liqOverlay').classList.add('hidden');
  if (Feed.lastPrice) localStorage.setItem('trade_lastprice', String(Feed.lastPrice));
  const profit = Math.round(G.cash - G.seed);

  // прогресс лесенки: раунды двигают стадии 2–3 (онбординг), cumEarned копит ПЛЮСОВЫЕ
  // раунды для порога stage 4; стадия применяется в конце раунда
  P.rounds++;
  if (profit > 0) P.cumEarned += profit;
  // «пик» (вердикт 25.07): 3 выигранных раунда ПОДРЯД с PnL ≥ +30% («на деле будет позже»).
  // Считаем ТОЛЬКО реальные раунды с живым сидом (находка QA: симы и сид 0 кормили серию)
  if (!G.simRound && G.seed > 0) P.hotStreak = profit >= G.seed * 0.30 ? (P.hotStreak || 0) + 1 : 0;
  const before = P.stage;
  const tgt = targetStage();
  if (tgt > P.stage) P.stage = tgt;
  if (G.partialTraining) P.stage = MAX_STAGE; // обучение пройдено → частичные открыты (вердикт 25.07)
  const stagedUp = P.stage > before;
  // онбординг-сим: механику уже научили хаб-баблы этого раунда (вердикт 30.07 п.23) —
  // старые интро-модалки шортов/плеча гасим навсегда; для миновавших онбординг путь жив
  if (G.caps.ob > 0) {
    if (P.stage >= 2) P.intros.short = true;
    if (P.stage >= 3) P.intros.lev = true;
  }
  saveP();

  // practice task №2: раунд с ≥1 закрытой сделкой и без единой ликвидации
  if (G.trades.length > 0 && G.liqsThisRound === 0) Tasks.set('survive');

  if (!G.hubReported) { G.hubReported = true; reportToHub(profit, stagedUp); }
  const isBest = profit > G.best;
  if (isBest) { G.best = profit; localStorage.setItem('trade_best', String(profit)); }

  // в хабе СВОЙ экран результатов НЕ показываем (слово Павла 31.07: «два экрана резов —
  // надо чтобы был второй»): раунд уже отчитан hub:roundEnd, шелл через ~0.9с закроет
  // iframe и покажет Round Complete — игра остаётся замороженной под ним без вспышки.
  // Standalone (window.parent === window) живёт по-старому
  if (window.parent !== window) return;

  $('resScore').textContent = fmtCoins(profit, true);
  $('resScore').style.color = profit < 0 ? 'var(--red)' : 'var(--ink)';
  $('resMult').textContent = '×' + (Math.max(0, G.cash) / (G.seed || 1)).toFixed(1) + ' from start';
  $('resBest').textContent = 'Best result: ' + fmtCoins(G.best, true);
  $('resBestBadge').classList.toggle('hidden', !isBest);
  $('tradesAll').textContent = `View all (${G.trades.length})`;

  // плашка «открыта новая механика» (черновой дизайн; draft-помечена)
  const ub = $('unlockBand');
  if (stagedUp) {
    const names = [];
    for (let s = before + 1; s <= P.stage; s++) {
      names.push(gt(s === 2 ? 'mech.short' : s === 3 ? 'mech.lev' : 'mech.partial'));
    }
    ub.querySelector('.ub-text').textContent = gt('unlock.band', names.join(' + '));
    ub.classList.remove('hidden');
    ub.classList.toggle('draftable', DRAFTS_ON);
    Sound.unlock();
    FX.rain();
  } else {
    ub.classList.add('hidden');
  }

  // шапка результата: актив раунда (пилюля с 3D-монетой из Deal-селектора)
  const rA = ASSETS[G.asset] || ASSETS.BTC;
  $('resAssetIco').dataset.coin = rA.ticker; // монета-заливка (все четыре варианта рисуют кружок)
  $('resAssetLbl').textContent = rA.ticker;

  // история сделок
  const tr = $('resTrades');
  tr.innerHTML = '';
  if (!G.trades.length) tr.innerHTML = '<div class="res-none">No trades — be bolder!</div>';
  G.trades.slice(-7).reverse().forEach(t => {
    const d = document.createElement('div');
    d.className = 'trade-row';
    const dirTag = `<span class="dir-badge ${t.dir === 1 ? 'long' : 'short'}">${t.dir === 1 ? '▲ Long' : '▼ Short'}</span>`;
    const levTag = G.caps.lev ? ` ×${t.lev}` : ''; // до анлока плеча скрытый буст не светим
    d.innerHTML =
      `<div class="trade-ico">${t.dir === 1 ? '📈' : '📉'}</div>` +
      `<div class="trade-main"><div class="trade-pair">${rA.ticker}/USD${levTag}</div><div class="trade-dur">${dirTag} ${t.dur}s${t.auto ? ' · auto' : ''}</div></div>` +
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
  if (isBest && profit > 0 && !stagedUp) { Sound.best(); FX.rain(); }
}

// ============================== CHART RENDER ==============================
/* Одна отрисовка на все четыре скина: ВСЕ цвета и метрика берутся из --ch-* токенов
   (см. readTheme). По макетам различаются: плотность сетки (--ch-lines), пунктир или
   солид (--ch-dash), ширина тела свечи (--ch-body), наличие флага текущей цены
   (--ch-flag: у crypto-light и corporate цена живёт в шапке карточки графика,
   у crypto-dark и cream — флагом на плоте) и горизонтальная линия цены (--ch-flagline).
   Зелёная зона профита, линия ликвидации, шкала — есть во всех, цветами варианта. */
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
  const plotW = W;
  const candles = e.candles;
  const slot = plotW / CFG.VISIBLE;
  const bodyW = Math.max(3, slot * TH.body);
  const cur = candles[candles.length - 1];
  const progress = clamp((e.simTime - cur.t0) / CFG.CANDLE_DUR, 0, 1);
  const first = Math.max(0, candles.length - (CFG.VISIBLE + 1));

  let lo = Infinity, hi = -Infinity;
  for (let i = first; i < candles.length; i++) {
    if (candles[i].l < lo) lo = candles[i].l;
    if (candles[i].h > hi) hi = candles[i].h;
  }
  if (G.pos) { lo = Math.min(lo, G.pos.entryPrice); hi = Math.max(hi, G.pos.entryPrice); }
  const pad = Math.max((hi - lo) * 0.22, e.price * 0.004);
  const tLo = lo - pad, tHi = hi + pad;
  if (!G.yInit) { G.yMin = tLo; G.yMax = tHi; G.yInit = true; }
  const kY = 1 - Math.exp(-6 * G.lastDt);
  G.yMin += (tLo - G.yMin) * kY;
  G.yMax += (tHi - G.yMax) * kY;

  const Y = p => H - ((p - G.yMin) / (G.yMax - G.yMin)) * H;
  const xOf = i => plotW - (candles.length - 1 - i + progress) * slot + slot * 0.5;

  const pnl = pnlNow();

  // зона профита: от уровня входа до текущей цены (лонг — выше входа, шорт — ниже);
  // в минусе зоны нет
  if (G.pos && pnl >= 0 && Math.abs(Y(G.pos.entryPrice) - Y(e.vis)) >= 3) {
    const eY = Y(G.pos.entryPrice), cY = Y(e.vis);
    const top = Math.min(eY, cY), hgt = Math.abs(cY - eY);
    ctx.fillStyle = TH.zone;
    ctx.fillRect(0, top, plotW, hgt);
    ctx.strokeStyle = TH.zoneLine;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, top + 0.5); ctx.lineTo(plotW, top + 0.5);
    ctx.moveTo(0, top + hgt - 0.5); ctx.lineTo(plotW, top + hgt - 0.5);
    ctx.stroke();
  }

  // сетка + подписи шкалы у правого края
  const range = G.yMax - G.yMin;
  const step = Math.max(niceStep(range / (TH.lines + 0.5)), 1);
  const firstLine = Math.ceil(G.yMin / step) * step;
  const lines = [];
  for (let p = firstLine; p < G.yMax; p += step) lines.push([p, Y(p)]);
  ctx.setLineDash(TH.dash);
  ctx.strokeStyle = TH.grid;
  ctx.lineWidth = 1;
  for (const [, y] of lines) {
    ctx.beginPath(); ctx.moveTo(0, Math.round(y) + 0.5); ctx.lineTo(plotW, Math.round(y) + 0.5); ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.font = TH.axisFont;
  ctx.fillStyle = TH.axis;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'bottom';
  /* подпись оси, попавшую под флаг текущей цены, НЕ рисуем: флаг кладётся поверх и
     оставлял торчащие половинки цифр (QA 31.07). Полосу флага считаем заранее — он
     отрисовывается ниже, у него та же curY. */
  const flagBand = TH.flag ? (() => { const cy = clamp(Y(e.vis), 14, H - 14); return [cy - 13, cy + 13]; })() : null;
  for (const [p, y] of lines) {
    if (flagBand && y - 2 > flagBand[0] && y - 2 < flagBand[1] + 12) continue;
    ctx.fillText(fmtAxis(p), plotW - 1, y - 2);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // линия ликвидации: пунктир на всю ширину, без подписи; только с открытым плечом
  // (в симах 1–2 ликвидацию ещё не учили — скрытый LEV_BASE не светим)
  if (G.pos && G.caps.lev) {
    const lY = Y(liqPriceOf(G.pos));
    if (lY > 0 && lY < H) {
      ctx.setLineDash([6, 6]);
      ctx.strokeStyle = TH.liq;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, lY); ctx.lineTo(plotW, lY); ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // свечи
  for (let i = first; i < candles.length; i++) {
    const cd = candles[i];
    const x = xOf(i);
    if (x < -slot || x > plotW + slot) continue;
    const col = cd.c >= cd.o ? TH.up : TH.down;
    ctx.fillStyle = col;
    ctx.fillRect(x - TH.wick / 2, Y(cd.h), TH.wick, Math.max(1, Y(cd.l) - Y(cd.h)));
    const y1 = Y(Math.max(cd.o, cd.c)), y2 = Y(Math.min(cd.o, cd.c));
    const bh = Math.max(3, y2 - y1);
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath(); ctx.roundRect(x - bodyW / 2, y1, bodyW, bh, TH.brad); ctx.fill();
    } else ctx.fillRect(x - bodyW / 2, y1, bodyW, bh);
  }

  // флаг текущей цены (crypto-dark / cream): прижат к правому краю, ширина от ТЕКСТА
  if (TH.flag) {
    const curY = clamp(Y(e.vis), 14, H - 14);
    ctx.font = TH.flagFont;
    const label = G.axisTxt || fmtAxis(e.vis);
    const tw = ctx.measureText(label).width;
    const fH = 19, fW = Math.round(tw + 12), fX = Math.round(plotW - fW);
    if (TH.flagLine) {
      ctx.strokeStyle = TH.flagBg;
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(0, Math.round(curY) + .5); ctx.lineTo(fX, Math.round(curY) + .5); ctx.stroke();
    }
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') ctx.roundRect(fX, curY - fH / 2, fW, fH, TH.flagR);
    else ctx.rect(fX, curY - fH / 2, fW, fH);
    ctx.fillStyle = TH.flagBg;
    ctx.fill();
    ctx.fillStyle = TH.flagTx;
    ctx.textBaseline = 'middle';
    ctx.fillText(label, fX + 6, curY + 1);
    ctx.textBaseline = 'alphabetic';
  }
}

// ============================== HUD ==============================
function updateHUD(dt) {
  // при открытой позиции Balance = СВОБОДНЫЙ кэш (вложенное показывает ячейка Trade —
  // п.35, мокап 558:10599); вне позиции — весь баланс по себестоимости
  const bt = G.pos ? G.cash : balTotal();
  G.dispBal += (bt - G.dispBal) * Math.min(1, dt * 9);
  $('balTop').textContent = fmtCoins(Math.abs(G.dispBal - Math.round(G.dispBal)) < 0.005 ? Math.round(G.dispBal) : G.dispBal);

  const total = (G.roundMs || CFG.ROUND_SEC * 1000) / 1000;
  const left = Math.max(0, total - G.gameT / 1000);
  const sec = Math.ceil(left);
  $('timerText').textContent = fmtTimer(left);
  // кольцо по макету: синяя дуга = ПРОЙДЕННОЕ время, растёт по часовой от 12 часов
  const elapsed = clamp(1 - left / total, 0, 1);
  $('ringArc').style.strokeDasharray = (elapsed * RING_LEN).toFixed(1) + ' ' + RING_LEN.toFixed(1);
  const hot = left <= 10;
  $('timerText').classList.toggle('hot', hot);
  if (hot && sec !== G.lastCountSec && sec <= 5 && sec > 0) Sound.count();
  G.lastCountSec = sec;

  G.txtAcc += dt;
  const txtTick = G.txtAcc >= CFG.TXT_EVERY;
  if (txtTick) {
    G.txtAcc = 0;
    G.axisTxt = fmtAxis(G.dispPrice);
    // цена в шапке карточки графика (crypto-light / cream / corporate; в crypto-dark
    // строка скрыта токеном --chprice-display, там цена идёт флагом на плоте)
    $('chartPrice').textContent = G.axisTxt;
  }

  if (G.pos) {
    const pnl = pnlNow();
    if (pnl > G.pos.peakPnl) G.pos.peakPnl = pnl;
    if (txtTick) {
      const usd = G.pos.stake * pnl / 100;
      $('uPnlUsd').textContent = fmtCoins(usd, true);
      $('uPnlPct').textContent = fmtPct(pnl);
      $('curPriceEl').textContent = fmtCoins(G.dispPrice);
      // полоса ликвидации (со стадии плеча): красный градиент растёт по мере
      // приближения PnL к −50% (макеты onb3-3/onb3-5)
      if (G.caps.lev) $('liqFill').style.width = (clamp(pnl / CFG.LIQ_PNL, 0, 1) * 100).toFixed(1) + '%';
    }

    const drop = G.pos.peakPnl - pnl;
    const meltNow = G.pos.peakPnl >= CFG.MELT_MIN_PEAK && drop >= Math.max(CFG.MELT_DROP, G.pos.peakPnl * 0.35) && pnl > -20;
    if (meltNow && !G.melting) Sound.warn();
    G.melting = meltNow;
    $('meltWarn').classList.toggle('hidden', !meltNow);
    const box = $('pnlBox');
    box.classList.toggle('neg', pnl < 0 && !meltNow);
    box.classList.toggle('melt', meltNow);
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
  let j = h.length - 1;
  while (j > 0 && e.simTime - h[j].t < 0.5) j--;
  const lev = G.caps.lev ? G.lev : CFG.LEV_BASE;
  const mLev = (e.vis - h[j].p) / h[j].p * lev * 100;
  if (!G.pos) {
    if (mLev > 2.2) { enterPos(1); demoCooldown = 0.8; }
    else if (G.caps.short && mLev < -2.2) { enterPos(-1); demoCooldown = 0.8; }
  } else {
    const pnl = pnlNow(), drop = G.pos.peakPnl - pnl;
    if ((G.pos.peakPnl > 10 && drop > G.pos.peakPnl * 0.3) || pnl < -16) {
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

  // timeHold (туториал п.36): таймер раунда придержан за баблом/подсказкой, но график
  // ЖИВЁТ («игрок должен видеть, что график живёт» — слово Павла) — в отличие от
  // G.paused, который морозит всё (пауза-меню)
  if (!G.timeHold) G.gameT += dt * 1000;
  // chartHold (слово Павла 01.08): на read-шагах туториала (виден Next) морозим и
  // ЦЕНУ — «спокойно прочитать текст»; экшн-шаги живут (timeHold им таймер держит)
  if (!G.chartHold) {
    G.engine.step(dt);
    G.dispPrice = G.engine.vis;
  }

  // ликвидация проверяется ДО бота/ввода — её нельзя «переиграть» выходом
  if (G.pos && pnlNow() <= CFG.LIQ_PNL) { liquidate(); drawChart(); updateHUD(dt); return; }
  if (DEMO) demoBot(dt);
  if (G.gameT >= (G.roundMs || CFG.ROUND_SEC * 1000)) { endRound(); return; }

  drawChart();
  updateHUD(dt);
}

// ============================== INPUT ==============================
function onAction(dir) {
  Sound.ensure();
  if (G.screen !== 'game' || G.paused || G.over) return;
  // tutLock (баг Павла 02.08: в туторе 2 успел взять Long до сценарного «пора шортить»):
  // на on-фазах туториала обе кнопки залочены — игрок «за ручку» смотрит на график
  if (G.tutLock) return;
  if (!G.pos) enterPos(dir || 1); else exitPos();
}

function bind() {
  $('btnPlay').addEventListener('click', () => { Sound.ensure(); startRound(); });
  $('btnAgain').addEventListener('click', () => { Sound.ensure(); startRound(); });
  // Deal-экрана больше нет во флоу: ⌂ со standalone-результата сразу запускает новый раунд
  $('btnHome').addEventListener('click', () => { Sound.ensure(); startRound(); });
  // Deal-экран: селектор актива (f2055)
  $('assetChips').addEventListener('click', e => {
    const b = e.target.closest('.asset-chip');
    if (!b || !ASSETS[b.dataset.asset]) return;
    G.asset = b.dataset.asset;
    renderStart();
  });
  // ★draft: (i) — правила игры (контент кнопки в макете не задан)
  $('btnInfo').addEventListener('click', () => $('infoOverlay').classList.remove('hidden'));
  $('btnInfoOk').addEventListener('click', () => $('infoOverlay').classList.add('hidden'));
  // ★draft: кебаб на Deal — меню в макете не задано; звук + выход в хаб
  $('btnDealKebab').addEventListener('click', () => {
    $('btnDealSound').textContent = Sound.on ? '🔊 Sound: on' : '🔇 Sound: off';
    $('btnDealExit').classList.toggle('hidden', window.parent === window);
    $('dealMenu').classList.remove('hidden');
  });
  $('btnDealSound').addEventListener('click', () => {
    Sound.on = !Sound.on;
    $('btnDealSound').textContent = Sound.on ? '🔊 Sound: on' : '🔇 Sound: off';
    $('btnSound').textContent = $('btnDealSound').textContent;
  });
  $('btnDealExit').addEventListener('click', () => {
    try { window.parent.postMessage({ type: 'hub:exit', game: 'trade' }, '*'); } catch (e) {}
  });
  $('btnDealMenuOk').addEventListener('click', () => $('dealMenu').classList.add('hidden'));
  // «Изучить»/Learn на баннере механики → интро частичных позиций + заказ тренировки
  // (тот же контур, что тап по 🔒 Size; рефанд fee платного раунда — гарды внутри)
  $('btnLearn').addEventListener('click', () => { Sound.ensure(); startPartialTraining(); });
  $('btnLong').addEventListener('pointerdown', e => { e.preventDefault(); onAction(1); });
  $('btnShort').addEventListener('pointerdown', e => { e.preventDefault(); onAction(-1); });
  $('btnExit').addEventListener('pointerdown', e => { e.preventDefault(); onAction(); });
  window.addEventListener('keydown', e => {
    if (e.code === 'Space') { e.preventDefault(); onAction(1); }
  });
  // сегменты плеча и доли
  $('levCtl').addEventListener('pointerdown', e => {
    const b = e.target.closest('button[data-lev]');
    if (!b || G.pos) return;
    G.lev = +b.dataset.lev;
    G.levUserSet = true;
    renderControls();
  });
  $('fracCtl').addEventListener('pointerdown', e => {
    // залочено (stage 3, основная игра) — любой тап по сегменту/🔒 = старт обучения (вердикт 25.07)
    if (!$('fracUnlock').classList.contains('hidden')) { startPartialTraining(); return; }
    const b = e.target.closest('button[data-frac]');
    if (!b) return;
    G.frac = +b.dataset.frac;
    if (G.simRound && !G.pos) postTutEvent('frac:' + G.frac); // интерактивный туториал (п.36)
    renderControls();
  });
  $('btnPause').addEventListener('click', () => {
    if (G.over) return;
    G.paused = true;
    $('pauseOverlay').classList.remove('hidden');
  });
  // кебаб ⋮ (онбординг-симы, макеты onb1–onb3): ★draft — своего меню в макетах нет,
  // открывает существующее пауза-меню игры (Resume / End round / Sound / Exit)
  $('btnKebab').addEventListener('click', () => {
    if (G.over) return;
    G.paused = true;
    $('pauseOverlay').classList.remove('hidden');
  });
  const resumeGame = () => {
    G.paused = false;
    $('pauseOverlay').classList.add('hidden');
  };
  $('btnResume').addEventListener('click', resumeGame);
  $('btnPauseX').addEventListener('click', resumeGame); // X по макету 761:31147 = Resume
  $('btnExitRound').addEventListener('click', () => {
    G.paused = false;
    $('pauseOverlay').classList.add('hidden');
    endRound();
  });
  $('btnSound').addEventListener('click', () => {
    Sound.on = !Sound.on;
    $('btnSound').textContent = Sound.on ? '🔊 Sound: on' : '🔇 Sound: off';
  });
  // «Exit to menu» (мокап 761:31147): выход в хаб; standalone-запуску прятать
  $('btnExitMenu').classList.toggle('hidden', window.parent === window);
  $('btnExitMenu').addEventListener('click', () => {
    try { window.parent.postMessage({ type: 'hub:exit', game: 'trade' }, '*'); } catch (e) {}
  });
  window.addEventListener('resize', resizeAll);
  /* Канвас графика привязан к размеру #chartPlot, а тот устаканивается ПОЗЖЕ первого
     resizeAll() (шрифты, иконки, разная высота хрома у скинов). Без наблюдателя
     crypto-dark стартовал с нулевой геометрией и график оставался пустым до первого
     ресайза окна (найдено QA 31.07). ResizeObserver лечит весь класс: любое изменение
     плота — пересчёт канваса. */
  if (window.ResizeObserver) {
    let lastW = 0, lastH = 0;
    const ro = new ResizeObserver(entries => {
      const r = entries[0] && entries[0].contentRect;
      if (!r) return;
      // без дребезга: реагируем только на реальное изменение
      if (Math.abs(r.width - lastW) < 0.5 && Math.abs(r.height - lastH) < 0.5) return;
      lastW = r.width; lastH = r.height;
      resizeAll();
      drawChart();
    });
    ro.observe($('chartPlot'));
  }
}

// ============================== BOOT ==============================
/* локализация статичного хрома (data-gt в index.html): Balance / Leverage /
   Trade size / Unrealized P&L / Enter / Current / Liquidation / подпись −50% */
function applyGT() {
  document.querySelectorAll('[data-gt]').forEach(el => { el.textContent = gt(el.dataset.gt); });
}
window.__trade = { G, CFG, Feed, P, saveP, targetStage, roundCaps, startRound, enterPos, exitPos, Tasks, OB_ROUNDS,
  get skin() { return SKIN; }, setSkin,
  /* API туториала для оболочки (same-origin, как tutBoot): таймер-холд за баблами,
     отпуск стартового hold-сегмента сценария, полный сброс сценария на Skip */
  setTimeHold(v) { G.timeHold = !!v; },
  setChartHold(v) { G.chartHold = !!v; }, // read-шаги морозят график (Павел 01.08)
  // лок действий на on-фазах туториала (Павел 02.08 «за ручку вести»): кнопки гаснут
  // визуально и не принимают тапы, пока сценарий не дойдёт до своего события
  setTutLock(v) {
    G.tutLock = !!v;
    try { document.querySelector('.game-action').classList.toggle('tutlock', G.tutLock); } catch (e) {}
  },
  tutSimPos,                              // сим-панель позиции для шага −50% (568:15209)
  tutGo() { G.tutGo = true; },
  tutFree() {
    G.tutGo = true; G.timeHold = false; G.chartHold = false; tutSimPos(false);
    G.tutLock = false;
    try { document.querySelector('.game-action').classList.remove('tutlock'); } catch (e) {}
    if (G.engine) G.engine.script = null;
  },
}; // QA hook
applyGT();
readTheme();

/* живая смена скина из хаба (дев-переключатель Style в Settings). Сообщение —
   ДАННЫЕ, а не команда: принимаем только известный ключ из белого списка (К27). */
window.addEventListener('message', ev => {
  const d = ev.data;
  if (!d || d.type !== 'hub:skin') return;
  if (window.parent !== window && ev.source !== window.parent) return;
  setSkin(d.skin);
});
/* онбординг-сим из хаба (?tut=1): Deal-экран пропускается — шелл сам зовёт startRound()
   через __trade (★draft: контент Deal прячем, чтобы он не мигал и не ловил тап Start
   в окне ожидания фида; вне iframe класс не вешаем — прямое открытие живёт как обычно) */
if (_qs.has('tut') && window.parent !== window) $('stage').classList.add('tutboot');
FX.init();
bind();
/* Deal-экран убран из флоу (слово Павла 31.07 «выбор актива пока нахуй; убрать»):
   вход сразу в раунд, актив всегда BTC (ETH/SOL спят до отдельного решения по пп.33-34).
   DOM экрана оставлен спящим — макет 635:15427 отложен, не удалён. В ?tut шелл
   сам зовёт startRound() (онбординг), там автостарта нет. */
if (_qs.has('tut') && window.parent !== window) {
  show('start');
} else {
  show('start'); // renderStart держит хром консистентным, экран тут же сменится раундом
  (function autoStart() {
    let n = 0;
    const iv = setInterval(() => {
      if (Feed.ready || ++n > 12) { clearInterval(iv); if (G.screen === 'start') startRound(); }
    }, 100);
  })();
}
resizeAll();
// второй проход после первой раскладки: к этому моменту шрифты/иконки применены,
// геометрия плота финальная (страховка к ResizeObserver выше)
requestAnimationFrame(() => { resizeAll(); drawChart(); });
requestAnimationFrame(frame);
if (DEMO) {
  const t0 = performance.now();
  const w = setInterval(() => {
    if ((Feed.ready && Feed.fresh()) || performance.now() - t0 > 6000) {
      clearInterval(w); startRound();
    }
  }, 200);
}

/* hub: выход в меню из паузы (только в iframe хаба) */
(function(){
  if (window.parent === window) return;
  function mount(){
    if (document.getElementById('hubExitBtn')) return;
    var anchor = document.getElementById('btnSound');
    if (!anchor) return;
    var b = document.createElement('button');
    b.id = 'hubExitBtn'; b.className = 'ghostbtn'; b.textContent = 'Exit to menu';
    b.addEventListener('click', function(){
      try { window.parent.postMessage({type:'hub:exit', game:'trade'}, '*'); } catch(e){}
    });
    anchor.insertAdjacentElement('afterend', b);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
