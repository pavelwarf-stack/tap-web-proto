'use strict';
/* ============================================================
   Tap Trading Hub — shell logic.
   Shared wallet, first-run tutorial, dailies, stats, shop,
   achievements, guides. Vanilla JS, localStorage persistence.
   ============================================================ */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const fmt = n => {
  if (!Number.isFinite(n)) n = 0; // никогда не показывать NaN/Infinity
  const s = Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (n < 0 ? '-' : '') + s;
};
const pad2 = n => String(n).padStart(2, '0');
const dateStr = d => d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
const todayStr = () => dateStr(new Date());
const yesterdayStr = () => dateStr(new Date(Date.now() - 864e5));
/* UTC-даты — для daily challenge (ставка на дневную свечу BTC, день = UTC) */
const dateStrUTC = d => d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
const todayUTCStr = () => dateStrUTC(new Date());
const addDaysUTC = (ds, n) => {
  const [y, m, d] = String(ds).split('-').map(Number);
  return dateStrUTC(new Date(Date.UTC(y, m - 1, d) + n * 864e5));
};

/* ---------- persistent state ---------- */
const OFFER_CYCLE = ((14 * 60 + 24) * 60 + 32) * 1000; // 14:24:32
const STARTER_WINDOW = 2 * 60 * 60 * 1000; // 2ч витрины стартер-пака на Home (622-мокап, ★draft)

const DEF_STATE = {
  seenWelcome: false,
  tutorialDone: false,
  firstWin: false,          // first-win modal shown (first ever hub:roundEnd)
  started: 0,               // ts of first launch
  stats: {},                // per game: {sessions, bestWin, total}
  // daily challenge = реальная ставка на дневную свечу BTC (UTC-день):
  //   last = UTC-дата последней ВЫИГРАННОЙ ставки (якорь серии), day = её день серии,
  //   claims = всего выигранных дней, bet = {dateUTC, dir, open} — нерешённая ставка,
  //   result = последний результат {dateUTC, dir, win, open, close, reward}
  daily: { last: null, day: 0, claims: 0, bet: null, result: null },
  shopDaily: { last: null, day: 0 },            // shop daily reward
  ach: { done: {}, claimed: {} },
  promoShown: false,        // home guides promo (once, after 4th session)
  savepShown: false,        // save-progress sheet auto-trigger (once, after 3rd session)
  starterShown: false,      // starter pack 1.99$ auto-sheet (once, from 2nd visit; вердикт 31.07 п.27)
  starterEnd: 0,            // 2ч-окно витрины стартер-пака на Home (622-мокап «Истекает через 2ч», ★draft)
  visit: { n: 0, last: 0 }, // сессии-ВИЗИТЫ приложения (n) + ts последней активности (last)
  progressSaved: false,
  notifPermShown: false,
  offerEnd: 0,
  drafts: true,
  bellSeen: false,
  homeVisits: { date: null, n: 0 }, // визиты на Home за сегодня (для авто-оффера дейлика)
  dailyOffer: null,         // дата последнего авто-оффера дейлика (once per day)
  lang: 0,                  // выбранный язык в Settings (visual only)
  setFlags: { notif: true, music: true }, // editorial row toggles (mockup B; prototype-only master flags)
  skin: 'narodny',          // визуальный скин (вердикт 29.07: один скелет, три стиля)
  btc: null,                // кэш цен BTC {open, price, openDate, ts, live} — оффлайн-фолбэк
  peakDay: null,            // дата последнего «пикового» оффера (max 1/день; webv1 п.5)
};

function loadState() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('hub.state') || '{}') || {}; } catch (e) {}
  const out = JSON.parse(JSON.stringify(DEF_STATE));
  for (const k of Object.keys(out)) if (k in s) out[k] = s[k];
  // гигиена вложенных структур: битое/старое хранилище не должно давать NaN в логике
  for (const k of ['daily', 'shopDaily', 'ach', 'homeVisits', 'setFlags', 'visit']) {
    if (typeof out[k] !== 'object' || out[k] === null) out[k] = {};
    out[k] = Object.assign(JSON.parse(JSON.stringify(DEF_STATE[k])), out[k]);
  }
  if (typeof out.stats !== 'object' || out.stats === null) out.stats = {};
  out.daily.day = +out.daily.day || 0;
  out.daily.claims = +out.daily.claims || 0;
  if (typeof out.daily.bet !== 'object') out.daily.bet = null;
  if (typeof out.daily.result !== 'object') out.daily.result = null;
  out.shopDaily.day = +out.shopDaily.day || 0;
  out.homeVisits.n = +out.homeVisits.n || 0;
  out.visit.n = +out.visit.n || 0;
  out.visit.last = +out.visit.last || 0;
  out.offerEnd = Number.isFinite(+out.offerEnd) ? +out.offerEnd : 0;
  out.started = Number.isFinite(+out.started) ? +out.started : 0;
  out.lang = +out.lang || 0;
  if (out.skin !== 'terminal' && out.skin !== 'editorial') out.skin = 'narodny';
  if (typeof out.btc !== 'object') out.btc = null;
  return out;
}
const S = loadState();
function save() {
  try { localStorage.setItem('hub.state', JSON.stringify(S)); } catch (e) {}
}

let balance = (() => {
  let v = NaN;
  try { v = parseInt(localStorage.getItem('hub.balance'), 10); } catch (e) {}
  return Number.isFinite(v) ? v : 1000; // seed 1 000
})();

/* ---------- economy knobs ----------
   Экономика = мягкий чистый слив: фарм в играх слабее фонтанов (дейлики/видео/ачивки),
   стимул к донату и рекламе, но не душит. Числа сведены симуляцией (см. QA-LOGIC-REPORT). */
const ENTRY_FEE = 100;                                // фишек за вход в КАЖДЫЙ реальный раунд (вердикт 27.07 вечер: «все раунды по 100»; было 150)
/* Вердикт владельца 25.07: три раунда онбординга (базовый → шорты → плечи) идут ПОДРЯД
   на СИМУЛЯЦИИ фишек — бесплатно, кошелёк не трогаем, сид всегда 1000. Fee включается
   после онбординга (сыграны все OB-раунды).
   Вердикт 27.07 (вечер): fee = 100 за каждый реальный раунд; провал из платного раунда
   в обучающий раунд 4-й механики (тап по 🔒 Size) → хаб возвращает fee (hub:feeRefund). */
const OB_ROUNDS = 3;
const FEE_GAMES = ['trade'];
const TRADE_RATE = 0.2;                               // $-дельта раунда → фишки (только FEE_GAMES)
const FLAPPY_ENTRY = 500;                             // архив (flappy без точки входа в webv1)
const FLAPPY_MIN_TOTAL = 30;
/* Краны срезаны (вердикт владельца 27.07): видео 1000→100, рефералка 5000→500.
   Реферальные +500 — только вёрстка/строки (начислений за рефералов в прототипе нет). */
const VIDEO_REWARD = 100;

/* ---------- skins (вердикт владельца 29.07: ОДИН скелет, три визуальных стиля) ----------
   Скин = body[data-skin] + CSS-токены в shell.css; DOM не ветвится.
   Вердикт 31.07 (п.25): скин = разметка КОГОРТЫ, не выбор юзера. ?skin= приходит из
   пролива (МЛМ-ленд → narodny, крипто-ленд → terminal и т.д.), применяется И ПЕРСИСТИТСЯ
   (S.skin): юзер пришёл по когортной ссылке один раз — скин остаётся и без параметра.
   (Раньше ?skin= был симуляцией когорт и НЕ персистился — семантика изменена п.25.)
   Приоритет: ?skin= в URL > сохранённый скин > narodny. Строка «Style» в Settings —
   дев-инструмент за drafts-тумблером (юзерского переключателя в проде нет);
   игра скин НЕ получает — дизайн игры един для всех скинов (вердикт 29.07, п.21). */
const SKINS = ['narodny', 'terminal', 'editorial'];
const URL_SKIN = (() => {
  try {
    const s = new URLSearchParams(location.search).get('skin');
    return SKINS.includes(s) ? s : null;
  } catch (e) { return null; }
})();
let SKIN = URL_SKIN || (SKINS.includes(S.skin) ? S.skin : 'narodny');
function applySkin(skin, opts = {}) {
  if (!SKINS.includes(skin)) return;
  SKIN = skin;
  document.body.dataset.skin = skin;
  if (opts.persist) { S.skin = skin; save(); }
}
// сразу, до первого рендера (скрипт стоит в конце <body>); когортный ?skin=
// закрепляется в S.skin (вердикт 31.07 п.25: разметка когорты = назначение скина)
applySkin(SKIN, { persist: !!URL_SKIN });

/* ---------- i18n ----------
   S.lang (index into the Settings language list) → LANGS code → I18N dictionary.
   Kept in English across ALL languages (product decision): game titles, Long/Short
   trade terms, legacy guide article titles/bodies, «★ draft» dev helpers, currency/digits.
   ★ draft 30.07: кейсы «Chart patterns» — ПЕРЕВЕДЕНЫ ×8 (pat.* в I18N; Long/Short
   остаются английскими и внутри переводов — конвенция продукта).
   Arabic: translated strings, NO RTL layout flip (prototype convention). */
const LANGS = ['en', 'es', 'fr', 'de', 'ja', 'zh', 'pt', 'ar'];
let LANG = 'en';

const I18N = {
en: {
  /* webv1: одна игра + лестница механик (решения встречи 24.07) */
  'game.trade.desc': 'Buy and sell Bitcoin on the live chart',
  'home.stage': 'Stage {0} of {1}', 'home.next': 'Next unlock: {0}', 'home.max': 'All mechanics unlocked',
  'stage.1': 'Buy & sell', 'stage.2': 'Shorts', 'stage.3': 'Leverage ×2–×5', 'stage.4': 'Partial positions',
  'prof.intents': 'Purchase intents',
  'peak.title': 'You’re on fire!', 'peak.sub': 'Level up for real — pick your next step',
  'peak.course': 'Crypto trading course', 'peak.course.d': 'Structured basics, from zero to system',
  'peak.academy': 'Binance Academy', 'peak.academy.d': 'Free lessons from the partner',
  'peak.prop': 'Prop-trading quests', 'peak.prop.d': 'Trade a funded account',
  'peak.later': 'Not now', 't.peaklogged': 'Choice logged (prototype)',
  /* payment stubs + course tiers + referral course hook (вердикты 27.07) */
  'stub.pay': 'Pay', 'stub.processing': 'Payment processing…', 'stub.notify': 'We’ll notify you when it’s done',
  'stub.redirect': 'Redirecting to partner… (prototype)',
  'stub.item.chips': '{0} chips', 'stub.item.prop': 'Prop-trading quest: qualification round',
  'stub.item.refcourse': 'In-depth Long/Short course by an expert',
  'tiers.sub': 'Choose your level',
  'tiers.basic.d': 'Charts, orders and first trades', 'tiers.pro.d': 'Strategies, leverage and risk management',
  'tiers.expert.d': 'Advanced system and expert feedback',
  'ref.course.t': 'Free expert course',
  'ref.course.d': 'Your first friend who makes a purchase unlocks a free in-depth Long/Short course by an expert',
  'tasks.title': 'Practice tasks', 'tasks.sub': 'Play the game — checkmarks light up by themselves',
  'tasks.1': 'Close a trade in profit', 'tasks.2': 'Survive a round without liquidation', 'tasks.3': 'Use a partial 50% exit',
  'ach.shorts.t': 'Short seller', 'ach.shorts.d': 'Unlock shorts (stage 2)', 'ach.shorts.done': 'You unlocked shorts',
  'ach.ladder.t': 'Full arsenal', 'ach.ladder.d': 'Unlock all 4 mechanics', 'ach.ladder.done': 'You unlocked all 4 mechanics',
  'welcome.title': 'Welcome to Reptiloid Capital!', 'welcome.sub': 'You\'re our new trainee trader. Training starts right now – first practice round is on us.', 'welcome.start': 'Start game →', 'welcome.skip': 'Skip',
  /* onboarding bubbles ×9 (mockups onb1..3, verbatim) + new Round Complete (onb1-6) */
  'ob1.1': 'Analyze the Bitcoin chart and make a decision.',
  'ob1.2': 'Open a long position based on the chart and levels. Close it when you deem appropriate — either to take your profit or accept the loss.',
  'ob1.3': 'A position is in profit when it is above the entry point; try to close it at maximum profit.',
  'ob2.1': 'In the market, you can profit not only from a position rising in value but also from it falling - if you know how.',
  'ob2.2': 'When opening a long position, profit increases if the asset\'s value is above the entry point.',
  'ob2.3': 'When opening a short position, profit increases if the asset\'s price is below the entry point.',
  'ob3.1': 'As your confidence in your skills grows, you can act more boldly - this is where leverage comes in; it multiplies returns but also increases risk.',
  'ob3.2': 'Leverage allows you to increase the entry amount.',
  'ob3.3': 'Keep an eye on the liquidation levels. If you get liquidated, 50% of the trade amount will be deducted.',
  'rc.next': 'Next round', 'rc.repeat': 'Repeat round', 'rc.unlock': 'New mechanic unlocked!', 'rc.fwbonus': 'First win bonus',
  'mech.short': 'Short selling', 'mech.short.d': 'Now you can open short positions and bet on the price falling',
  'mech.lev': 'Leverage', 'mech.lev.d': 'Now you can multiply your entry with ×2–×5 leverage',
  'play': 'Play', 'diff.easy': 'Easy', 'diff.medium': 'Medium', 'diff.hard': 'Hard',
  'game.prognoz.desc': 'Guess the next candle direction',
  'game.sdelka.desc': 'Full trade cycle, take your profit',
  'game.longshort.desc': 'Open a position and close on time',
  'game.plechi.desc': 'Open a position and close on time with leverage',
  'game.flappy.desc': 'Fly along the chart and guess its direction',
  'tab.home': 'Home', 'tab.shop': 'Shop', 'tab.referrals': 'Referrals', 'tab.achievements': 'Achievements', 'tab.settings': 'Settings',
  'offer.badge': 'Special offer', 'offer.t': 'Starter chip pack', 'offer.d': 'Get {0} chips for just {1} and speed up your progress.', 'chips': 'chips', 'shop.packs': 'Chip packages', 'bar.home': 'Main',
  'shop.title': 'Shop', 'shop.personal': 'Personal offer', 'shop.endsin': 'Ends in', 'savePct': 'Save {0}%',
  'buy': 'Buy', 'hot': 'Hot', 'shop.free': 'Free',
  'shop.invite.t': 'Invite a friend', 'shop.invite.d': 'Get chips for each referral', 'invite': 'Invite',
  'shop.video.t': 'Watch video', 'shop.video.d': 'Earn chips for each view', 'shop.video.btn': 'Watch',
  'shop.fb.t': 'Feedback', 'shop.fb.d': 'Get chips for an honest review', 'shop.fb.btn': 'Leave a review',
  'shop.dr.t': 'Daily reward', 'shop.dr.d': 'Come back every day for a bigger bonus',
  'claim': 'Claim', 'claimed': 'Claimed',
  'ref.title': 'Referrals', 'ref.h2': 'Invite friends', 'ref.sub': 'and get 500 chips for each one',
  'ref.banner': 'Invite your first friend and get a free trading guide.',
  'ref.fld': 'Enter the ID of the player who invited you', 'ref.ph': 'Paste ID here…', 'paste': 'Paste', 'ref.your': 'Your referrals',
  'ref.copy': 'Copy your ID: {0}', 'ref.invite': 'Invite a friend',
  'ach.title': 'Achievements', 'ach.reward': 'Reward', 'newach': 'New achievement!', 'newach.claim': 'Claim reward',
  'ach.first.t': 'First trade', 'ach.first.d': 'Complete your first game round', 'ach.first.done': 'You completed your first game round',
  'ach.avid.t': 'Avid player', 'ach.avid.d': 'Complete 3 game rounds', 'ach.avid.done': 'You completed 3 game rounds',
  'ach.bigwin.t': 'Big win', 'ach.bigwin.d': 'Earn 500+ chips in one round', 'ach.bigwin.done': 'You earned 500+ chips in one round',
  'ach.daily2.t': 'Daily forecaster', 'ach.daily2.d': 'Claim the daily challenge on 2 days', 'ach.daily2.done': 'You claimed the daily challenge on 2 days',
  'ach.explorer.t': 'Explorer', 'ach.explorer.d': 'Play all 5 games', 'ach.explorer.done': 'You played all 5 games',
  'ach.flappy100.t': '100 games in FlappyGraph', 'ach.flappy100.d': 'Complete 100 games', 'ach.flappy100.done': 'You completed 100 games',
  'set.guides': 'Guides & lessons', 'set.title': 'Settings', 'sub.notifications': 'Notifications', 'sub.language': 'Language', 'sub.music': 'Music and vibration', 'sub.style': 'Style',
  'sub.help': 'Help & Support', 'sub.about': 'About app', 'sub.agreements': 'Agreements', 'sub.terms': 'Terms of Service',
  'set.logout': 'Log out', 'set.delete': 'Delete account',
  'subitem.dcrem': 'Daily challenge reminder', 'subitem.offers': 'Personal offers', 'subitem.tourn': 'Tournament alerts',
  'subitem.music': 'Music', 'subitem.sfx': 'Sound effects', 'subitem.vibro': 'Vibration',
  'sub.help.text': 'Support chat and FAQ are not part of the prototype yet. For now — poke the team directly.',
  'sub.about.text': 'Tap Trading Hub — interactive wireframe prototype. Built for concept review: no real money, no real market orders. All balances are play chips.',
  'sub.agreements.text': 'Placeholder for legal agreements. Final texts are not part of the prototype.',
  'sub.terms.text': 'Placeholder for the Terms of Service. Final texts are not part of the prototype.',
  'sub.stub': 'This section is a stub in the prototype.',
  'prof.title': 'Profile', 'prof.edit': 'Edit', 'prof.stats': 'Statistics', 'prof.games': 'Games played',
  'prof.fav': 'Favorite game', 'prof.best': 'Best win', 'prof.started': 'Started playing',
  'prof.share': 'Share statistics', 'prof.savep': 'Save your progress',
  'days.one': '{0} day', 'days.many': '{0} days',
  'guides.title': 'Guides', 'search.ph': 'Search', 'guides.empty': 'Nothing found',
  'cat.Long': 'Long', 'cat.Short': 'Short', 'cat.Psychology': 'Psychology',
  'cat.patterns': 'Chart patterns',
  /* ★ draft 30.07 — Chart patterns case set (title + 3 paragraphs each) */
  'pat.pullback.t': 'Uptrend pullback: buying the dip in a rising market',
  'pat.pullback.p1': 'A healthy uptrend climbs in steps: a push up, a small slide back, another push. That small slide is called a pullback — the market catching its breath, not changing its mind.',
  'pat.pullback.p2': 'A trader lets the slide finish: when the chart stops dipping and turns back up, that turn is the entry for a Long. You buy cheaper than everyone who chased the top of the last push.',
  'pat.pullback.p3': 'What usually goes wrong: buying while the price is still falling because “it looks cheap now”. Half of those dips keep dipping. Wait for the turn — a pullback is only your friend after it ends.',
  'pat.support.t': 'Support bounce: the floor the price keeps respecting',
  'pat.support.p1': 'Sometimes the price falls to the same level again and again — and every time it bounces back up. That level is support: a floor where buyers keep showing up.',
  'pat.support.p2': 'The play: when the price returns to a floor that has already held twice, get ready — and open a Long when the bounce actually starts. The level itself is your one clear reason to enter.',
  'pat.support.p3': 'What usually goes wrong: treating the floor as a guarantee. No support holds forever — if the price lies flat on the level and stops bouncing, the floor is cracking. Exit fast instead of hoping.',
  'pat.breakout.t': 'Resistance breakout: when the ceiling finally gives way',
  'pat.breakout.p1': 'Resistance is a ceiling: a level the chart taps several times and slides back down from every time. Sellers are waiting there — until one day they run out.',
  'pat.breakout.p2': 'When the price finally pushes through and holds above the ceiling, that is a breakout. A trader opens a Long above the level: the old ceiling now works as a floor under the trade.',
  'pat.breakout.p3': 'What usually goes wrong: buying the very first poke through the line. Give it a moment — if the price can’t stay above the level, it wasn’t a breakout, it was noise. Or a trap: see the next case.',
  'pat.fakeout.t': 'False breakout: the trap above the level',
  'pat.fakeout.p1': 'The price jumps above a well-watched ceiling, everyone rushes to buy — and moments later it drops right back below the level, taking the buyers’ chips with it. That is a false breakout, a fakeout.',
  'pat.fakeout.p2': 'A calm trader treats the first jump as a question, not an answer: wait and see whether the price holds above the line. And once it falls back, the trap itself becomes a signal — a Short after a failed breakout often works well.',
  'pat.fakeout.p3': 'What usually goes wrong: chasing the jump instantly, out of fear of missing out. Missing a real breakout costs you nothing; getting caught in a fake one costs real chips. The fastest tap gets the worst price.',
  'pat.panic.t': 'Panic dip: the V-shaped recovery',
  'pat.panic.p1': 'Out of nowhere the chart falls like a stone — a wall of red candles in seconds. Then buyers step in just as suddenly, and the price climbs back, drawing the letter V.',
  'pat.panic.p2': 'The craft is to not catch the falling knife. Wait for the first strong green candle after the drop — the sign that the panic ran out of sellers — and only then take a Long to ride the recovery.',
  'pat.panic.p3': 'What usually goes wrong: buying mid-fall because “it can’t go lower” (it can), or opening a Short at the very bottom, after the drop already happened. In a panic, being deliberately a few seconds late is a strategy.',
  'pat.range.t': 'Range and chop: when the best trade is no trade',
  'pat.range.p1': 'Sometimes the chart just wanders sideways: a small candle up, a small candle down, no direction at all. That is a range, or chop — the market can’t make up its mind.',
  'pat.range.p2': 'The honest play is unpopular: mostly, don’t trade it. Moves are tiny, so the entry fee eats the profit, and every “trend” dies in seconds. If you do trade, take only the very edges of the range — and expect little.',
  'pat.range.p3': 'What usually goes wrong: boredom. Chop tempts you into tapping just to do something, and ten tiny losses add up to one big one. Recognizing chop and sitting on your hands is a real trading skill.',
  'art.consolidate': 'Consolidate your knowledge in games',
  'ntf.t1': 'Tournament starting soon', 'ntf.d1': 'Join the tournament and get a chance to win 1,000 chips', 'ntf.join': 'Join',
  'ntf.t2': 'Welcome bonus for a friend', 'ntf.d2': 'Get 500 welcome chips for invited friends',
  'su.title': 'Sign up', 'su.createacct': 'Create account', 'su.sub': 'Start playing and trading right now', 'vf.verification': 'Verification', 'vf.err': 'Invalid code. Try again.', 'vf.changemail': 'Use another email', 'su.email': 'Email', 'su.pass': 'Password', 'su.or': 'Or continue with',
  'su.login': 'Already have an account? Log in', 'su.legal': 'By continuing, you agree to the Terms and Privacy Policy.',
  'vf.title': 'Enter verification code', 'vf.sub': '6-digit code sent to', 'vf.expires': 'Code expires in {0}',
  'vf.confirm': 'Confirm', 'vf.resend': 'Didn’t receive the code? Resend', 'vf.enter4': 'Enter the 4-digit code',
  'rc.title': 'ROUND COMPLETE', 'rc.earned': 'Earned', 'rc.balance': 'Your balance',
  'tile.guessed': 'Guessed', 'tile.streak': 'Best streak', 'tile.mult': 'Best modifier',
  'tile.final': 'Final balance', 'tile.fromstart': 'From start', 'tile.score': 'Round score',
  'rc.guides.t': 'Interested in this topic?', 'rc.guides.d': 'Check out our guides and start trading more effectively.',
  'rc.guides.btn': 'Read guides', 'rc.again': 'Play again',
  'tut.skip': 'Skip the tutorial', 'tut.next': 'Next',
  'dc.kicker': 'Daily challenge', 'dc.title': 'Candle of the day (BTC)',
  'dc.sub': 'Open a trade on BTC’s daily close and earn a reward',
  'dc.placed': 'Trade placed!', 'dc.comeback': 'Come back tomorrow to see the result and keep your streak going.', 'done': 'Done',
  'dc.open': 'Today’s open, 00:00 GMT', 'dc.now': 'BTC now',
  'dc.won': 'You won day {0}!', 'dc.winrest': 'BTC closed {0} · +{1} chips',
  'dc.lost': 'Not this time.', 'dc.lostrest': 'BTC closed {0} — streak reset. Try again today!',
  'higher': 'higher', 'lower': 'lower', 'today': 'Today', 'dayN': 'Day {0}',
  'dc.pick': 'Your pick:',
  'dc.betline.long': 'BTC closes higher than today’s open {0} (00:00 GMT)',
  'dc.betline.short': 'BTC closes lower than today’s open {0} (00:00 GMT)',
  'dc.betline2.long': 'BTC closes higher than today’s 00:00 GMT open',
  'dc.betline2.short': 'BTC closes lower than today’s 00:00 GMT open',
  'dc.result': 'Result in {0}', 'dc.stale': 'Your {0} bet from {1} is waiting for the result · offline', 'offline': 'offline',
  'np.title': 'Want to predict how the day will close in the daily challenge?', 'np.sub': 'Allow notifications',
  'np.allow': 'Allow', 'np.deny': 'Deny', 'np.predict': 'Make a prediction', 'close': 'Close',
  'sp.have': 'You have', 'sp.days': 'and {0} of wins in the daily challenge', 'sp.register': 'Register',
  'ooc.title': 'Out of chips', 'ooc.tomorrow': 'Or come back tomorrow for the daily reward',
  'dr.todays': 'Today’s reward', 'dr.claim': 'Claim bonus', 'dr.claimed': 'Claimed ✓',
  'lo.title': 'Log out?', 'lo.sub': 'Are you sure you want to log out of your account?', 'cancel': 'Cancel',
  'gp.title': 'Interested in this type of trading?', 'gp.sub': 'Check out our guides on this topic',
  'del.title': 'Delete account?', 'del.text': 'This action is permanent and cannot be undone. All your data, achievements, and history will be lost.',
  'fw.title': 'Congratulations on your first successful trade', 'fw.earned': 'You earned', 'fw.continue': 'Continue playing',
  't.stub': 'Not in the prototype yet', 't.fee': 'Entry fee −{0}', 't.feeback': 'Training round — entry refunded +{0}', 't.coins': 'Coins {0}% → {1} chips',
  't.traderes': 'Trading result {0} → {1} chips', 't.dailywon': 'Daily challenge won · +{0} chips',
  't.placed': '{0} placed · result at 00:00 GMT', 't.dreward': 'Daily reward +{0} chips',
  't.achreward': '“{0}” reward +{1} chips', 't.video': 'Video watched · +{0} chips',
  't.nopurch': 'Purchases are not in the prototype', 't.pasted': 'Pasted', 't.clipempty': 'Clipboard is empty',
  't.clipna': 'Clipboard is not available — type the ID', 't.idcopied': 'Your ID is copied', 't.yourid': 'Your ID: {0}',
  't.invitecopied': 'Invite link copied (prototype)', 't.logoutstub': 'Log out is visual-only in the prototype',
  't.progsaved': 'Progress saved', 't.progalready': 'Progress already saved',
  't.tournstub': 'Tournaments are not in the prototype yet', 't.statscopied': 'Statistics copied to clipboard',
  't.stats': 'Statistics: {0}', 't.sharestats': 'My Tap Trading stats: {0} games, best win {1} chips, favorite — {2}.',
},
es: {
  'game.trade.desc': 'Compra y vende Bitcoin en el gráfico en vivo',
  'home.stage': 'Etapa {0} de {1}', 'home.next': 'Próximo desbloqueo: {0}', 'home.max': 'Todas las mecánicas desbloqueadas',
  'stage.1': 'Comprar y vender', 'stage.2': 'Shorts', 'stage.3': 'Apalancamiento ×2–×5', 'stage.4': 'Posiciones parciales',
  'prof.intents': 'Intenciones de compra',
  'peak.title': '¡Estás en racha!', 'peak.sub': 'Sube de nivel de verdad: elige tu siguiente paso',
  'peak.course': 'Curso de trading de cripto', 'peak.course.d': 'Bases estructuradas, de cero a sistema',
  'peak.academy': 'Binance Academy', 'peak.academy.d': 'Lecciones gratis del partner',
  'peak.prop': 'Retos de prop trading', 'peak.prop.d': 'Opera una cuenta fondeada',
  'peak.later': 'Ahora no', 't.peaklogged': 'Elección registrada (prototipo)',
  'stub.pay': 'Pagar', 'stub.processing': 'Procesando el pago…', 'stub.notify': 'Te avisaremos cuando esté listo',
  'stub.redirect': 'Redirigiendo al partner… (prototipo)',
  'stub.item.chips': '{0} fichas', 'stub.item.prop': 'Reto de prop trading: ronda de calificación',
  'stub.item.refcourse': 'Curso Long/Short en profundidad de un experto',
  'tiers.sub': 'Elige tu nivel',
  'tiers.basic.d': 'Gráficos, órdenes y primeros trades', 'tiers.pro.d': 'Estrategias, apalancamiento y gestión del riesgo',
  'tiers.expert.d': 'Sistema avanzado y feedback del experto',
  'ref.course.t': 'Curso de experto gratis',
  'ref.course.d': 'Tu primer amigo que haga una compra desbloquea gratis un curso Long/Short en profundidad de un experto',
  'tasks.title': 'Tareas prácticas', 'tasks.sub': 'Juega y las marcas se encienden solas',
  'tasks.1': 'Cierra un trade en ganancia', 'tasks.2': 'Sobrevive una ronda sin liquidación', 'tasks.3': 'Usa una salida parcial del 50%',
  'ach.shorts.t': 'Vendedor en corto', 'ach.shorts.d': 'Desbloquea los shorts (etapa 2)', 'ach.shorts.done': 'Desbloqueaste los shorts',
  'ach.ladder.t': 'Arsenal completo', 'ach.ladder.d': 'Desbloquea las 4 mecánicas', 'ach.ladder.done': 'Desbloqueaste las 4 mecánicas',
  'welcome.title': '¡Bienvenido a Reptiloid Capital!', 'welcome.sub': 'Eres nuestro nuevo trader en prácticas. La formación empieza ya – la primera ronda de práctica corre por nuestra cuenta.', 'welcome.start': 'Empezar el juego →', 'welcome.skip': 'Omitir',
  'ob1.1': 'Analiza el gráfico de Bitcoin y toma una decisión.',
  'ob1.2': 'Abre una posición Long según el gráfico y los niveles. Ciérrala cuando lo creas oportuno: para tomar tu beneficio o asumir la pérdida.',
  'ob1.3': 'Una posición está en beneficio cuando está por encima del punto de entrada; intenta cerrarla en el máximo beneficio.',
  'ob2.1': 'En el mercado puedes ganar no solo cuando una posición sube de valor, sino también cuando cae, si sabes cómo.',
  'ob2.2': 'Al abrir una posición Long, el beneficio crece si el valor del activo está por encima del punto de entrada.',
  'ob2.3': 'Al abrir una posición Short, el beneficio crece si el precio del activo está por debajo del punto de entrada.',
  'ob3.1': 'A medida que crece la confianza en tus habilidades puedes actuar con más audacia: aquí entra el apalancamiento; multiplica las ganancias pero también aumenta el riesgo.',
  'ob3.2': 'El apalancamiento te permite aumentar el importe de entrada.',
  'ob3.3': 'Vigila los niveles de liquidación. Si te liquidan, se descontará el 50% del importe de la operación.',
  'rc.next': 'Siguiente ronda', 'rc.repeat': 'Repetir ronda', 'rc.unlock': '¡Nueva mecánica desbloqueada!', 'rc.fwbonus': 'Bono por primera victoria',
  'mech.short': 'Venta Short', 'mech.short.d': 'Ahora puedes abrir posiciones Short y apostar a la caída del precio',
  'mech.lev': 'Apalancamiento', 'mech.lev.d': 'Ahora puedes multiplicar tu entrada con apalancamiento ×2–×5',
  'play': 'Jugar', 'diff.easy': 'Fácil', 'diff.medium': 'Media', 'diff.hard': 'Difícil',
  'game.prognoz.desc': 'Adivina la dirección de la próxima vela',
  'game.sdelka.desc': 'Ciclo completo de trade, toma tu ganancia',
  'game.longshort.desc': 'Abre una posición y ciérrala a tiempo',
  'game.plechi.desc': 'Abre una posición con apalancamiento y ciérrala a tiempo',
  'game.flappy.desc': 'Vuela sobre el gráfico y adivina su dirección',
  'tab.home': 'Inicio', 'tab.shop': 'Tienda', 'tab.referrals': 'Referidos', 'tab.achievements': 'Logros', 'tab.settings': 'Ajustes',
  'offer.badge': 'Oferta especial', 'offer.t': 'Pack de fichas inicial', 'offer.d': 'Consigue {0} fichas por solo {1} y acelera tu progreso.', 'chips': 'fichas', 'shop.packs': 'Paquetes de fichas', 'bar.home': 'Inicio',
  'shop.title': 'Tienda', 'shop.personal': 'Oferta personal', 'shop.endsin': 'Termina en', 'savePct': '−{0}%',
  'buy': 'Comprar', 'hot': 'Hot', 'shop.free': 'Gratis',
  'shop.invite.t': 'Invita a un amigo', 'shop.invite.d': 'Recibe fichas por cada referido', 'invite': 'Invitar',
  'shop.video.t': 'Ver video', 'shop.video.d': 'Gana fichas por cada visualización', 'shop.video.btn': 'Ver',
  'shop.fb.t': 'Opinión', 'shop.fb.d': 'Recibe fichas por una reseña honesta', 'shop.fb.btn': 'Dejar reseña',
  'shop.dr.t': 'Bono diario', 'shop.dr.d': 'Vuelve cada día por un bono mayor',
  'claim': 'Reclamar', 'claimed': 'Reclamado',
  'ref.title': 'Referidos', 'ref.h2': 'Invita a tus amigos', 'ref.sub': 'y recibe 500 fichas por cada uno',
  'ref.banner': 'Invita a tu primer amigo y recibe una guía de trading gratis.',
  'ref.fld': 'Introduce el ID del jugador que te invitó', 'ref.ph': 'Pega el ID aquí…', 'paste': 'Pegar', 'ref.your': 'Tus referidos',
  'ref.copy': 'Copiar tu ID: {0}', 'ref.invite': 'Invitar a un amigo',
  'ach.title': 'Logros', 'ach.reward': 'Premio', 'newach': '¡Nuevo logro!', 'newach.claim': 'Reclamar premio',
  'ach.first.t': 'Primer trade', 'ach.first.d': 'Completa tu primera ronda', 'ach.first.done': 'Completaste tu primera ronda',
  'ach.avid.t': 'Jugador ávido', 'ach.avid.d': 'Completa 3 rondas', 'ach.avid.done': 'Completaste 3 rondas',
  'ach.bigwin.t': 'Gran victoria', 'ach.bigwin.d': 'Gana 500+ fichas en una ronda', 'ach.bigwin.done': 'Ganaste 500+ fichas en una ronda',
  'ach.daily2.t': 'Pronosticador diario', 'ach.daily2.d': 'Gana el reto diario 2 días', 'ach.daily2.done': 'Ganaste el reto diario 2 días',
  'ach.explorer.t': 'Explorador', 'ach.explorer.d': 'Juega los 5 juegos', 'ach.explorer.done': 'Jugaste los 5 juegos',
  'ach.flappy100.t': '100 partidas en FlappyGraph', 'ach.flappy100.d': 'Completa 100 partidas', 'ach.flappy100.done': 'Completaste 100 partidas',
  'set.guides': 'Guías y lecciones', 'set.title': 'Ajustes', 'sub.notifications': 'Notificaciones', 'sub.language': 'Idioma', 'sub.music': 'Música y vibración', 'sub.style': 'Estilo',
  'sub.help': 'Ayuda y soporte', 'sub.about': 'Sobre la app', 'sub.agreements': 'Acuerdos', 'sub.terms': 'Términos de servicio',
  'set.logout': 'Cerrar sesión', 'set.delete': 'Eliminar cuenta',
  'subitem.dcrem': 'Recordatorio del reto diario', 'subitem.offers': 'Ofertas personales', 'subitem.tourn': 'Avisos de torneos',
  'subitem.music': 'Música', 'subitem.sfx': 'Efectos de sonido', 'subitem.vibro': 'Vibración',
  'sub.help.text': 'El chat de soporte y las FAQ aún no forman parte del prototipo. Por ahora, contacta al equipo directamente.',
  'sub.about.text': 'Tap Trading Hub: prototipo interactivo de wireframes. Hecho para revisar el concepto: sin dinero real ni órdenes reales. Todos los saldos son fichas de juego.',
  'sub.agreements.text': 'Marcador de posición para los acuerdos legales. Los textos finales no forman parte del prototipo.',
  'sub.terms.text': 'Marcador de posición para los Términos de servicio. Los textos finales no forman parte del prototipo.',
  'sub.stub': 'Esta sección es un stub en el prototipo.',
  'prof.title': 'Perfil', 'prof.edit': 'Editar', 'prof.stats': 'Estadísticas', 'prof.games': 'Partidas jugadas',
  'prof.fav': 'Juego favorito', 'prof.best': 'Mejor premio', 'prof.started': 'Empezaste a jugar',
  'prof.share': 'Compartir estadísticas', 'prof.savep': 'Guarda tu progreso',
  'days.one': '{0} día', 'days.many': '{0} días',
  'guides.title': 'Guías', 'search.ph': 'Buscar', 'guides.empty': 'Nada encontrado',
  'cat.Long': 'Long', 'cat.Short': 'Short', 'cat.Psychology': 'Psicología',
  'cat.patterns': 'Patrones del gráfico',
  'pat.pullback.t': 'Pullback en tendencia alcista: comprar el retroceso en un mercado que sube',
  'pat.pullback.p1': 'Una tendencia alcista sana sube por escalones: un impulso arriba, un pequeño retroceso, otro impulso. Ese retroceso se llama pullback — el mercado toma aire, no cambia de opinión.',
  'pat.pullback.p2': 'El trader deja que el retroceso termine: cuando el gráfico deja de caer y vuelve a girar hacia arriba, ese giro es la entrada para un Long. Compras más barato que quienes persiguieron el techo del último impulso.',
  'pat.pullback.p3': 'Lo que suele salir mal: comprar mientras el precio todavía cae porque «ya parece barato». La mitad de esos retrocesos sigue cayendo. Espera el giro — el pullback solo es tu amigo cuando termina.',
  'pat.support.t': 'Rebote en el soporte: el suelo que el precio sigue respetando',
  'pat.support.p1': 'A veces el precio cae una y otra vez hasta el mismo nivel — y cada vez rebota hacia arriba. Ese nivel es el soporte: un suelo donde los compradores siempre aparecen.',
  'pat.support.p2': 'La jugada: cuando el precio vuelve a un suelo que ya aguantó dos veces, prepárate — y abre un Long cuando el rebote empiece de verdad. El nivel mismo es tu única razón clara para entrar.',
  'pat.support.p3': 'Lo que suele salir mal: tratar el suelo como una garantía. Ningún soporte aguanta para siempre — si el precio se queda pegado al nivel y deja de rebotar, el suelo se está agrietando. Sal rápido en vez de esperar un milagro.',
  'pat.breakout.t': 'Ruptura de resistencia: cuando el techo por fin cede',
  'pat.breakout.p1': 'La resistencia es un techo: un nivel que el gráfico toca varias veces y del que siempre vuelve a caer. Ahí esperan los vendedores — hasta que un día se agotan.',
  'pat.breakout.p2': 'Cuando el precio por fin atraviesa el techo y se mantiene encima, eso es una ruptura. El trader abre un Long por encima del nivel: el viejo techo ahora funciona como suelo bajo la operación.',
  'pat.breakout.p3': 'Lo que suele salir mal: comprar el primer pinchazo de la línea. Dale un momento — si el precio no logra quedarse arriba, no era una ruptura, era ruido. O una trampa: mira el siguiente caso.',
  'pat.fakeout.t': 'Falsa ruptura: la trampa encima del nivel',
  'pat.fakeout.p1': 'El precio salta por encima de un techo que todos vigilan, la gente corre a comprar — y momentos después cae de vuelta bajo el nivel, llevándose las fichas de los compradores. Eso es una falsa ruptura, un fakeout.',
  'pat.fakeout.p2': 'Un trader tranquilo trata el primer salto como una pregunta, no una respuesta: espera a ver si el precio se mantiene sobre la línea. Y cuando cae de vuelta, la propia trampa se vuelve señal — un Short tras una ruptura fallida suele funcionar bien.',
  'pat.fakeout.p3': 'Lo que suele salir mal: perseguir el salto al instante por miedo a quedarse fuera. Perderte una ruptura real no cuesta nada; quedar atrapado en una falsa cuesta fichas reales. El tap más rápido consigue el peor precio.',
  'pat.panic.t': 'Caída de pánico: la recuperación en V',
  'pat.panic.p1': 'De la nada el gráfico cae como una piedra — un muro de velas rojas en segundos. Luego, igual de repente, entran los compradores y el precio vuelve a subir dibujando una letra V.',
  'pat.panic.p2': 'El oficio está en no atrapar el cuchillo que cae. Espera la primera vela verde fuerte después del desplome — la señal de que al pánico se le acabaron los vendedores — y solo entonces toma un Long para subirte a la recuperación.',
  'pat.panic.p3': 'Lo que suele salir mal: comprar a mitad de la caída porque «ya no puede bajar más» (sí puede), o abrir un Short en el mismísimo fondo, cuando la caída ya pasó. En el pánico, llegar unos segundos tarde a propósito es una estrategia.',
  'pat.range.t': 'Rango y lateral: cuando el mejor trade es no operar',
  'pat.range.p1': 'A veces el gráfico solo deambula de lado: una vela pequeña arriba, otra abajo, sin dirección. Eso es un rango o mercado lateral — el mercado no se decide.',
  'pat.range.p2': 'La jugada honesta es impopular: la mayoría de las veces, no lo operes. Los movimientos son mínimos, la comisión de entrada se come la ganancia y cada «tendencia» muere en segundos. Si operas, hazlo solo en los bordes del rango — y espera poco.',
  'pat.range.p3': 'Lo que suele salir mal: el aburrimiento. El lateral te tienta a tocar botones solo por hacer algo, y diez pérdidas pequeñas suman una grande. Reconocer el lateral y sentarte sobre tus manos es una habilidad real de trading.',
  'art.consolidate': 'Refuerza tus conocimientos en los juegos',
  'ntf.t1': 'El torneo empieza pronto', 'ntf.d1': 'Únete al torneo y opta a ganar 1.000 fichas', 'ntf.join': 'Unirse',
  'ntf.t2': 'Bono de bienvenida por un amigo', 'ntf.d2': 'Recibe 500 fichas por los amigos invitados',
  'su.title': 'Crear cuenta', 'su.createacct': 'Crear cuenta', 'su.sub': 'Empieza a jugar y a operar ahora mismo', 'vf.verification': 'Verificación', 'vf.err': 'Código no válido. Inténtalo de nuevo.', 'vf.changemail': 'Usar otro correo', 'su.email': 'Correo', 'su.pass': 'Contraseña', 'su.or': 'O continúa con',
  'su.login': '¿Ya tienes cuenta? Inicia sesión', 'su.legal': 'Al continuar aceptas los Términos y la Política de privacidad.',
  'vf.title': 'Introduce el código', 'vf.sub': 'Código de 6 dígitos enviado a', 'vf.expires': 'El código expira en {0}',
  'vf.confirm': 'Confirmar', 'vf.resend': '¿No recibiste el código? Reenviar', 'vf.enter4': 'Introduce el código de 4 dígitos',
  'rc.title': 'RONDA COMPLETADA', 'rc.earned': 'Ganado', 'rc.balance': 'Tu saldo',
  'tile.guessed': 'Aciertos', 'tile.streak': 'Mejor racha', 'tile.mult': 'Mejor multiplicador',
  'tile.final': 'Saldo final', 'tile.fromstart': 'Desde el inicio', 'tile.score': 'Puntos de ronda',
  'rc.guides.t': '¿Te interesa este tema?', 'rc.guides.d': 'Lee nuestras guías y opera con más eficacia.',
  'rc.guides.btn': 'Leer guías', 'rc.again': 'Jugar otra vez',
  'tut.skip': 'Saltar el tutorial', 'tut.next': 'Siguiente',
  'dc.kicker': 'Reto diario', 'dc.title': 'Vela del día (BTC)',
  'dc.sub': 'Predice el cierre diario de BTC y gana una recompensa',
  'dc.placed': '¡Trade abierto!', 'dc.comeback': 'Vuelve mañana para ver el resultado y mantener tu racha.', 'done': 'Listo',
  'dc.open': 'Apertura de hoy, 00:00 GMT', 'dc.now': 'BTC ahora',
  'dc.won': '¡Ganaste el día {0}!', 'dc.winrest': 'BTC cerró {0} · +{1} fichas',
  'dc.lost': 'Esta vez no.', 'dc.lostrest': 'BTC cerró {0}: racha reiniciada. ¡Inténtalo hoy!',
  'higher': 'más alto', 'lower': 'más bajo', 'today': 'Hoy', 'dayN': 'Día {0}',
  'dc.pick': 'Tu elección:',
  'dc.betline.long': 'BTC cierra por encima de la apertura de hoy {0} (00:00 GMT)',
  'dc.betline.short': 'BTC cierra por debajo de la apertura de hoy {0} (00:00 GMT)',
  'dc.betline2.long': 'BTC cierra por encima de la apertura de las 00:00 GMT',
  'dc.betline2.short': 'BTC cierra por debajo de la apertura de las 00:00 GMT',
  'dc.result': 'Resultado en {0}', 'dc.stale': 'Tu apuesta {0} del {1} espera el resultado · offline', 'offline': 'offline',
  'np.title': '¿Quieres predecir cómo cerrará el día en el reto diario?', 'np.sub': 'Permite las notificaciones',
  'np.allow': 'Permitir', 'np.deny': 'Rechazar', 'np.predict': 'Hacer predicción', 'close': 'Cerrar',
  'sp.have': 'Tienes', 'sp.days': 'y {0} de victorias en el reto diario', 'sp.register': 'Registrarse',
  'ooc.title': 'Sin fichas', 'ooc.tomorrow': 'O vuelve mañana por el bono diario',
  'dr.todays': 'Premio de hoy', 'dr.claim': 'Reclamar bono', 'dr.claimed': 'Reclamado ✓',
  'lo.title': '¿Cerrar sesión?', 'lo.sub': '¿Seguro que quieres cerrar sesión?', 'cancel': 'Cancelar',
  'gp.title': '¿Te interesa este tipo de trading?', 'gp.sub': 'Mira nuestras guías sobre el tema',
  'del.title': '¿Eliminar cuenta?', 'del.text': 'Esta acción es permanente y no se puede deshacer. Perderás todos tus datos, logros e historial.',
  'fw.title': 'Felicidades por tu primer trade exitoso', 'fw.earned': 'Has ganado', 'fw.continue': 'Seguir jugando',
  't.stub': 'Aún no está en el prototipo', 't.fee': 'Cuota de entrada −{0}', 't.feeback': 'Ronda de práctica — cuota devuelta +{0}', 't.coins': 'Monedas {0}% → {1} fichas',
  't.traderes': 'Resultado del trade {0} → {1} fichas', 't.dailywon': 'Reto diario ganado · +{0} fichas',
  't.placed': '{0} abierto · resultado a las 00:00 GMT', 't.dreward': 'Bono diario +{0} fichas',
  't.achreward': 'Premio de «{0}» +{1} fichas', 't.video': 'Video visto · +{0} fichas',
  't.nopurch': 'Las compras no están en el prototipo', 't.pasted': 'Pegado', 't.clipempty': 'El portapapeles está vacío',
  't.clipna': 'Portapapeles no disponible: escribe el ID', 't.idcopied': 'Tu ID está copiado', 't.yourid': 'Tu ID: {0}',
  't.invitecopied': 'Enlace de invitación copiado (prototipo)', 't.logoutstub': 'Cerrar sesión es solo visual en el prototipo',
  't.progsaved': 'Progreso guardado', 't.progalready': 'Progreso ya guardado',
  't.tournstub': 'Los torneos aún no están en el prototipo', 't.statscopied': 'Estadísticas copiadas',
  't.stats': 'Estadísticas: {0}', 't.sharestats': 'Mis stats de Tap Trading: {0} partidas, mejor premio {1} fichas, favorito — {2}.',
},
fr: {
  'game.trade.desc': 'Achète et vends du Bitcoin sur le graphique en direct',
  'home.stage': 'Étape {0} sur {1}', 'home.next': 'Prochain déblocage : {0}', 'home.max': 'Toutes les mécaniques débloquées',
  'stage.1': 'Acheter et vendre', 'stage.2': 'Shorts', 'stage.3': 'Levier ×2–×5', 'stage.4': 'Positions partielles',
  'prof.intents': 'Intentions d’achat',
  'peak.title': 'Tu es en feu !', 'peak.sub': 'Passe au niveau réel — choisis ta prochaine étape',
  'peak.course': 'Cours de trading crypto', 'peak.course.d': 'Bases structurées, de zéro au système',
  'peak.academy': 'Binance Academy', 'peak.academy.d': 'Leçons gratuites du partenaire',
  'peak.prop': 'Défis de prop trading', 'peak.prop.d': 'Trade un compte financé',
  'peak.later': 'Pas maintenant', 't.peaklogged': 'Choix enregistré (prototype)',
  'stub.pay': 'Payer', 'stub.processing': 'Paiement en cours…', 'stub.notify': 'On te préviendra quand ce sera fait',
  'stub.redirect': 'Redirection vers le partenaire… (prototype)',
  'stub.item.chips': '{0} jetons', 'stub.item.prop': 'Défi de prop trading : tour de qualification',
  'stub.item.refcourse': 'Cours Long/Short approfondi d’un expert',
  'tiers.sub': 'Choisis ton niveau',
  'tiers.basic.d': 'Graphiques, ordres et premiers trades', 'tiers.pro.d': 'Stratégies, levier et gestion du risque',
  'tiers.expert.d': 'Système avancé et feedback de l’expert',
  'ref.course.t': 'Cours d’expert gratuit',
  'ref.course.d': 'Ton premier ami qui fait un achat débloque gratuitement un cours Long/Short approfondi d’un expert',
  'tasks.title': 'Exercices pratiques', 'tasks.sub': 'Joue — les coches s’allument toutes seules',
  'tasks.1': 'Ferme un trade en profit', 'tasks.2': 'Survis à une manche sans liquidation', 'tasks.3': 'Utilise une sortie partielle de 50%',
  'ach.shorts.t': 'Vendeur à découvert', 'ach.shorts.d': 'Débloque les shorts (étape 2)', 'ach.shorts.done': 'Tu as débloqué les shorts',
  'ach.ladder.t': 'Arsenal complet', 'ach.ladder.d': 'Débloque les 4 mécaniques', 'ach.ladder.done': 'Tu as débloqué les 4 mécaniques',
  'welcome.title': 'Bienvenue chez Reptiloid Capital !', 'welcome.sub': 'Tu es notre nouveau trader stagiaire. La formation commence maintenant – la première manche d\'entraînement est offerte.', 'welcome.start': 'Commencer le jeu →', 'welcome.skip': 'Passer',
  'ob1.1': 'Analyse le graphique du Bitcoin et prends une décision.',
  'ob1.2': 'Ouvre une position Long selon le graphique et les niveaux. Ferme-la quand tu le juges opportun — pour prendre ton profit ou accepter la perte.',
  'ob1.3': 'Une position est gagnante quand elle est au-dessus du point d\'entrée ; essaie de la fermer au profit maximal.',
  'ob2.1': 'Sur le marché, on peut gagner non seulement quand une position monte, mais aussi quand elle baisse — si on sait comment.',
  'ob2.2': 'Avec une position Long, le profit augmente si la valeur de l\'actif est au-dessus du point d\'entrée.',
  'ob2.3': 'Avec une position Short, le profit augmente si le prix de l\'actif est en dessous du point d\'entrée.',
  'ob3.1': 'Plus tu prends confiance en tes compétences, plus tu peux agir audacieusement — c\'est là qu\'intervient le levier ; il multiplie les gains mais augmente aussi le risque.',
  'ob3.2': 'Le levier permet d\'augmenter le montant d\'entrée.',
  'ob3.3': 'Surveille les niveaux de liquidation. En cas de liquidation, 50 % du montant de la position sera déduit.',
  'rc.next': 'Manche suivante', 'rc.repeat': 'Rejouer la manche', 'rc.unlock': 'Nouvelle mécanique débloquée !', 'rc.fwbonus': 'Bonus de première victoire',
  'mech.short': 'Vente Short', 'mech.short.d': 'Tu peux désormais ouvrir des positions Short et parier sur la baisse du prix',
  'mech.lev': 'Levier', 'mech.lev.d': 'Tu peux désormais multiplier ton entrée avec un levier ×2–×5',
  'play': 'Jouer', 'diff.easy': 'Facile', 'diff.medium': 'Moyen', 'diff.hard': 'Difficile',
  'game.prognoz.desc': 'Devine la direction de la prochaine bougie',
  'game.sdelka.desc': 'Cycle de trade complet, prends ton profit',
  'game.longshort.desc': 'Ouvre une position et ferme-la à temps',
  'game.plechi.desc': 'Ouvre une position avec levier et ferme-la à temps',
  'game.flappy.desc': 'Vole le long du graphique et devine sa direction',
  'tab.home': 'Accueil', 'tab.shop': 'Boutique', 'tab.referrals': 'Parrainage', 'tab.achievements': 'Succès', 'tab.settings': 'Réglages',
  'offer.badge': 'Offre spéciale', 'offer.t': 'Pack de jetons de départ', 'offer.d': 'Obtiens {0} jetons pour seulement {1} et accélère ta progression.', 'chips': 'jetons', 'shop.packs': 'Packs de jetons', 'bar.home': 'Accueil',
  'shop.title': 'Boutique', 'shop.personal': 'Offre perso', 'shop.endsin': 'Fin dans', 'savePct': '−{0}%',
  'buy': 'Acheter', 'hot': 'Hot', 'shop.free': 'Gratuit',
  'shop.invite.t': 'Invite un ami', 'shop.invite.d': 'Reçois des jetons par filleul', 'invite': 'Inviter',
  'shop.video.t': 'Regarder une vidéo', 'shop.video.d': 'Gagne des jetons par vue', 'shop.video.btn': 'Regarder',
  'shop.fb.t': 'Avis', 'shop.fb.d': 'Reçois des jetons pour un avis honnête', 'shop.fb.btn': 'Laisser un avis',
  'shop.dr.t': 'Bonus quotidien', 'shop.dr.d': 'Reviens chaque jour pour un bonus plus gros',
  'claim': 'Récupérer', 'claimed': 'Récupéré',
  'ref.title': 'Parrainage', 'ref.h2': 'Invite tes amis', 'ref.sub': 'et reçois 500 jetons par ami',
  'ref.banner': 'Invite ton premier ami et reçois un guide de trading gratuit.',
  'ref.fld': 'Entre l’ID du joueur qui t’a invité', 'ref.ph': 'Colle l’ID ici…', 'paste': 'Coller', 'ref.your': 'Tes filleuls',
  'ref.copy': 'Copier ton ID : {0}', 'ref.invite': 'Inviter un ami',
  'ach.title': 'Succès', 'ach.reward': 'Prime', 'newach': 'Nouveau succès !', 'newach.claim': 'Récupérer la prime',
  'ach.first.t': 'Premier trade', 'ach.first.d': 'Termine ta première manche', 'ach.first.done': 'Tu as terminé ta première manche',
  'ach.avid.t': 'Joueur assidu', 'ach.avid.d': 'Termine 3 manches', 'ach.avid.done': 'Tu as terminé 3 manches',
  'ach.bigwin.t': 'Gros gain', 'ach.bigwin.d': 'Gagne 500+ jetons en une manche', 'ach.bigwin.done': 'Tu as gagné 500+ jetons en une manche',
  'ach.daily2.t': 'Pronostiqueur du jour', 'ach.daily2.d': 'Gagne le défi quotidien 2 jours', 'ach.daily2.done': 'Tu as gagné le défi quotidien 2 jours',
  'ach.explorer.t': 'Explorateur', 'ach.explorer.d': 'Joue aux 5 jeux', 'ach.explorer.done': 'Tu as joué aux 5 jeux',
  'ach.flappy100.t': '100 parties de FlappyGraph', 'ach.flappy100.d': 'Termine 100 parties', 'ach.flappy100.done': 'Tu as terminé 100 parties',
  'set.guides': 'Guides et leçons', 'set.title': 'Réglages', 'sub.notifications': 'Notifications', 'sub.language': 'Langue', 'sub.music': 'Musique et vibration', 'sub.style': 'Style',
  'sub.help': 'Aide et support', 'sub.about': 'À propos', 'sub.agreements': 'Accords', 'sub.terms': 'Conditions d’utilisation',
  'set.logout': 'Se déconnecter', 'set.delete': 'Supprimer le compte',
  'subitem.dcrem': 'Rappel du défi quotidien', 'subitem.offers': 'Offres personnelles', 'subitem.tourn': 'Alertes tournois',
  'subitem.music': 'Musique', 'subitem.sfx': 'Effets sonores', 'subitem.vibro': 'Vibration',
  'sub.help.text': 'Le chat de support et la FAQ ne font pas encore partie du prototype. Pour l’instant, contacte l’équipe directement.',
  'sub.about.text': 'Tap Trading Hub — prototype interactif de wireframes. Conçu pour la revue du concept : pas d’argent réel, pas d’ordres réels. Tous les soldes sont des jetons de jeu.',
  'sub.agreements.text': 'Emplacement réservé aux accords juridiques. Les textes finaux ne font pas partie du prototype.',
  'sub.terms.text': 'Emplacement réservé aux Conditions d’utilisation. Les textes finaux ne font pas partie du prototype.',
  'sub.stub': 'Cette section est un stub dans le prototype.',
  'prof.title': 'Profil', 'prof.edit': 'Modifier', 'prof.stats': 'Statistiques', 'prof.games': 'Parties jouées',
  'prof.fav': 'Jeu préféré', 'prof.best': 'Meilleur gain', 'prof.started': 'Début du jeu',
  'prof.share': 'Partager les stats', 'prof.savep': 'Sauvegarde ta progression',
  'days.one': '{0} jour', 'days.many': '{0} jours',
  'guides.title': 'Guides', 'search.ph': 'Rechercher', 'guides.empty': 'Aucun résultat',
  'cat.Long': 'Long', 'cat.Short': 'Short', 'cat.Psychology': 'Psychologie',
  'cat.patterns': 'Figures du graphique',
  'pat.pullback.t': 'Pullback en tendance haussière : acheter le repli dans un marché qui monte',
  'pat.pullback.p1': 'Une tendance haussière saine monte par paliers : une poussée vers le haut, un petit repli, une nouvelle poussée. Ce petit repli s’appelle un pullback — le marché reprend son souffle, il ne change pas d’avis.',
  'pat.pullback.p2': 'Le trader laisse le repli se terminer : quand le graphique arrête de glisser et repart vers le haut, ce virage est l’entrée pour un Long. Tu achètes moins cher que ceux qui ont couru après le sommet de la dernière poussée.',
  'pat.pullback.p3': 'Ce qui tourne mal d’habitude : acheter pendant que le prix baisse encore parce que « ça a l’air déjà pas cher ». La moitié de ces replis continuent de tomber. Attends le virage — un pullback n’est ton ami qu’une fois terminé.',
  'pat.support.t': 'Rebond sur support : le plancher que le prix continue de respecter',
  'pat.support.p1': 'Parfois le prix retombe encore et encore sur le même niveau — et rebondit à chaque fois. Ce niveau est un support : un plancher où les acheteurs reviennent toujours.',
  'pat.support.p2': 'Le plan : quand le prix revient sur un plancher qui a déjà tenu deux fois, prépare-toi — et ouvre un Long quand le rebond démarre vraiment. Le niveau lui-même est ta seule raison claire d’entrer.',
  'pat.support.p3': 'Ce qui tourne mal : traiter le plancher comme une garantie. Aucun support ne tient éternellement — si le prix s’écrase sur le niveau et arrête de rebondir, le plancher se fissure. Sors vite au lieu d’espérer.',
  'pat.breakout.t': 'Cassure de résistance : quand le plafond finit par céder',
  'pat.breakout.p1': 'Une résistance est un plafond : un niveau que le graphique touche plusieurs fois et d’où il redescend à chaque fois. Les vendeurs y attendent — jusqu’au jour où ils s’épuisent.',
  'pat.breakout.p2': 'Quand le prix traverse enfin le plafond et tient au-dessus, c’est une cassure. Le trader ouvre un Long au-dessus du niveau : l’ancien plafond sert maintenant de plancher sous la position.',
  'pat.breakout.p3': 'Ce qui tourne mal : acheter la toute première percée de la ligne. Laisse-lui un instant — si le prix ne tient pas au-dessus, ce n’était pas une cassure, c’était du bruit. Ou un piège : voir le cas suivant.',
  'pat.fakeout.t': 'Fausse cassure : le piège au-dessus du niveau',
  'pat.fakeout.p1': 'Le prix saute au-dessus d’un plafond que tout le monde surveille, la foule se rue à l’achat — et quelques instants plus tard il retombe sous le niveau, emportant les jetons des acheteurs. C’est une fausse cassure, un fakeout.',
  'pat.fakeout.p2': 'Un trader calme traite le premier saut comme une question, pas une réponse : attends de voir si le prix tient au-dessus de la ligne. Et quand il retombe, le piège devient lui-même un signal — un Short après une cassure ratée marche souvent bien.',
  'pat.fakeout.p3': 'Ce qui tourne mal : courir après le saut par peur de rater le train. Rater une vraie cassure ne coûte rien ; rester piégé dans une fausse coûte de vrais jetons. Le tap le plus rapide obtient le pire prix.',
  'pat.panic.t': 'Chute de panique : la reprise en V',
  'pat.panic.p1': 'Sorti de nulle part, le graphique tombe comme une pierre — un mur de bougies rouges en quelques secondes. Puis les acheteurs reviennent tout aussi brutalement et le prix remonte en dessinant la lettre V.',
  'pat.panic.p2': 'Le métier, c’est de ne pas attraper le couteau qui tombe. Attends la première grosse bougie verte après la chute — le signe que la panique n’a plus de vendeurs — et prends seulement alors un Long pour surfer la reprise.',
  'pat.panic.p3': 'Ce qui tourne mal : acheter en pleine chute parce que « ça ne peut pas descendre plus bas » (si, ça peut), ou ouvrir un Short tout en bas, quand la chute a déjà eu lieu. Dans la panique, être volontairement en retard de quelques secondes est une stratégie.',
  'pat.range.t': 'Range et marché plat : quand le meilleur trade est de ne pas trader',
  'pat.range.p1': 'Parfois le graphique erre simplement de côté : une petite bougie vers le haut, une petite vers le bas, aucune direction. C’est un range, un marché plat — le marché n’arrive pas à se décider.',
  'pat.range.p2': 'Le plan honnête est impopulaire : la plupart du temps, ne le trade pas. Les mouvements sont minuscules, les frais d’entrée mangent le profit, et chaque « tendance » meurt en quelques secondes. Si tu trades quand même, prends seulement les bords extrêmes du range — et n’attends pas grand-chose.',
  'pat.range.p3': 'Ce qui tourne mal : l’ennui. Le marché plat te pousse à tapoter juste pour faire quelque chose, et dix petites pertes finissent par en faire une grosse. Reconnaître le plat et s’asseoir sur ses mains est une vraie compétence de trading.',
  'art.consolidate': 'Consolide tes connaissances en jouant',
  'ntf.t1': 'Le tournoi commence bientôt', 'ntf.d1': 'Rejoins le tournoi et tente de gagner 1 000 jetons', 'ntf.join': 'Rejoindre',
  'ntf.t2': 'Bonus de bienvenue pour un ami', 'ntf.d2': 'Reçois 500 jetons pour les amis invités',
  'su.title': 'Inscription', 'su.createacct': 'Créer un compte', 'su.sub': 'Commence à jouer et à trader dès maintenant', 'vf.verification': 'Vérification', 'vf.err': 'Code invalide. Réessaie.', 'vf.changemail': 'Utiliser un autre e-mail', 'su.email': 'E-mail', 'su.pass': 'Mot de passe', 'su.or': 'Ou continuer avec',
  'su.login': 'Déjà un compte ? Connexion', 'su.legal': 'En continuant, tu acceptes les Conditions et la Politique de confidentialité.',
  'vf.title': 'Entre le code de vérification', 'vf.sub': 'Code à 6 chiffres envoyé à', 'vf.expires': 'Le code expire dans {0}',
  'vf.confirm': 'Confirmer', 'vf.resend': 'Code non reçu ? Renvoyer', 'vf.enter4': 'Entre le code à 4 chiffres',
  'rc.title': 'MANCHE TERMINÉE', 'rc.earned': 'Gagné', 'rc.balance': 'Ton solde',
  'tile.guessed': 'Devinées', 'tile.streak': 'Meilleure série', 'tile.mult': 'Meilleur multi',
  'tile.final': 'Solde final', 'tile.fromstart': 'Depuis le début', 'tile.score': 'Score de manche',
  'rc.guides.t': 'Ce sujet t’intéresse ?', 'rc.guides.d': 'Lis nos guides et trade plus efficacement.',
  'rc.guides.btn': 'Lire les guides', 'rc.again': 'Rejouer',
  'tut.skip': 'Passer le tutoriel', 'tut.next': 'Suivant',
  'dc.kicker': 'Défi quotidien', 'dc.title': 'Bougie du jour (BTC)',
  'dc.sub': 'Parie sur la clôture du jour du BTC et gagne une récompense',
  'dc.placed': 'Trade placé !', 'dc.comeback': 'Reviens demain pour voir le résultat et garder ta série.', 'done': 'OK',
  'dc.open': 'Ouverture du jour, 00:00 GMT', 'dc.now': 'BTC maintenant',
  'dc.won': 'Jour {0} gagné !', 'dc.winrest': 'BTC a clôturé {0} · +{1} jetons',
  'dc.lost': 'Pas cette fois.', 'dc.lostrest': 'BTC a clôturé {0} — série remise à zéro. Retente aujourd’hui !',
  'higher': 'plus haut', 'lower': 'plus bas', 'today': 'Auj.', 'dayN': 'Jour {0}',
  'dc.pick': 'Ton choix :',
  'dc.betline.long': 'BTC clôture au-dessus de l’ouverture du jour {0} (00:00 GMT)',
  'dc.betline.short': 'BTC clôture en dessous de l’ouverture du jour {0} (00:00 GMT)',
  'dc.betline2.long': 'BTC clôture au-dessus de l’ouverture de 00:00 GMT',
  'dc.betline2.short': 'BTC clôture en dessous de l’ouverture de 00:00 GMT',
  'dc.result': 'Résultat dans {0}', 'dc.stale': 'Ton pari {0} du {1} attend le résultat · hors ligne', 'offline': 'hors ligne',
  'np.title': 'Envie de prédire la clôture du jour dans le défi quotidien ?', 'np.sub': 'Autorise les notifications',
  'np.allow': 'Autoriser', 'np.deny': 'Refuser', 'np.predict': 'Faire un pronostic', 'close': 'Fermer',
  'sp.have': 'Tu as', 'sp.days': 'et {0} de victoires au défi quotidien', 'sp.register': 'S’inscrire',
  'ooc.title': 'Plus de jetons', 'ooc.tomorrow': 'Ou reviens demain pour le bonus quotidien',
  'dr.todays': 'Récompense du jour', 'dr.claim': 'Récupérer le bonus', 'dr.claimed': 'Récupéré ✓',
  'lo.title': 'Se déconnecter ?', 'lo.sub': 'Veux-tu vraiment te déconnecter ?', 'cancel': 'Annuler',
  'gp.title': 'Ce type de trading t’intéresse ?', 'gp.sub': 'Découvre nos guides sur le sujet',
  'del.title': 'Supprimer le compte ?', 'del.text': 'Cette action est définitive. Toutes tes données, succès et ton historique seront perdus.',
  'fw.title': 'Félicitations pour ton premier trade réussi', 'fw.earned': 'Tu as gagné', 'fw.continue': 'Continuer à jouer',
  't.stub': 'Pas encore dans le prototype', 't.fee': 'Frais d’entrée −{0}', 't.feeback': 'Manche d’entraînement — frais remboursés +{0}', 't.coins': 'Pièces {0}% → {1} jetons',
  't.traderes': 'Résultat du trade {0} → {1} jetons', 't.dailywon': 'Défi quotidien gagné · +{0} jetons',
  't.placed': '{0} placé · résultat à 00:00 GMT', 't.dreward': 'Bonus quotidien +{0} jetons',
  't.achreward': 'Prime «{0}» +{1} jetons', 't.video': 'Vidéo vue · +{0} jetons',
  't.nopurch': 'Les achats ne sont pas dans le prototype', 't.pasted': 'Collé', 't.clipempty': 'Presse-papiers vide',
  't.clipna': 'Presse-papiers indisponible — saisis l’ID', 't.idcopied': 'Ton ID est copié', 't.yourid': 'Ton ID : {0}',
  't.invitecopied': 'Lien d’invitation copié (prototype)', 't.logoutstub': 'La déconnexion est visuelle dans le prototype',
  't.progsaved': 'Progression sauvegardée', 't.progalready': 'Progression déjà sauvegardée',
  't.tournstub': 'Les tournois ne sont pas encore dans le prototype', 't.statscopied': 'Statistiques copiées',
  't.stats': 'Statistiques : {0}', 't.sharestats': 'Mes stats Tap Trading : {0} parties, meilleur gain {1} jetons, préféré — {2}.',
},
de: {
  'game.trade.desc': 'Kaufe und verkaufe Bitcoin am Live-Chart',
  'home.stage': 'Stufe {0} von {1}', 'home.next': 'Nächste Freischaltung: {0}', 'home.max': 'Alle Mechaniken freigeschaltet',
  'stage.1': 'Kaufen & verkaufen', 'stage.2': 'Shorts', 'stage.3': 'Hebel ×2–×5', 'stage.4': 'Teilpositionen',
  'prof.intents': 'Kaufabsichten',
  'peak.title': 'Du läufst heiß!', 'peak.sub': 'Level up im echten Leben — wähle deinen nächsten Schritt',
  'peak.course': 'Krypto-Trading-Kurs', 'peak.course.d': 'Strukturierte Basics, von null zum System',
  'peak.academy': 'Binance Academy', 'peak.academy.d': 'Gratis-Lektionen vom Partner',
  'peak.prop': 'Prop-Trading-Quests', 'peak.prop.d': 'Handle ein finanziertes Konto',
  'peak.later': 'Nicht jetzt', 't.peaklogged': 'Auswahl protokolliert (Prototyp)',
  'stub.pay': 'Bezahlen', 'stub.processing': 'Zahlung wird verarbeitet…', 'stub.notify': 'Wir benachrichtigen dich, sobald es fertig ist',
  'stub.redirect': 'Weiterleitung zum Partner… (Prototyp)',
  'stub.item.chips': '{0} Chips', 'stub.item.prop': 'Prop-Trading-Quest: Qualifikationsrunde',
  'stub.item.refcourse': 'Long/Short-Vertiefungskurs vom Experten',
  'tiers.sub': 'Wähle dein Level',
  'tiers.basic.d': 'Charts, Orders und erste Trades', 'tiers.pro.d': 'Strategien, Hebel und Risikomanagement',
  'tiers.expert.d': 'Fortgeschrittenes System und Experten-Feedback',
  'ref.course.t': 'Gratis Experten-Kurs',
  'ref.course.d': 'Dein erster Freund, der einen Kauf tätigt, schaltet einen kostenlosen Long/Short-Vertiefungskurs vom Experten frei',
  'tasks.title': 'Praxisaufgaben', 'tasks.sub': 'Spiel einfach — die Haken leuchten von selbst auf',
  'tasks.1': 'Schließe einen Trade im Plus', 'tasks.2': 'Überstehe eine Runde ohne Liquidation', 'tasks.3': 'Nutze einen 50%-Teilausstieg',
  'ach.shorts.t': 'Leerverkäufer', 'ach.shorts.d': 'Schalte Shorts frei (Stufe 2)', 'ach.shorts.done': 'Du hast Shorts freigeschaltet',
  'ach.ladder.t': 'Volles Arsenal', 'ach.ladder.d': 'Schalte alle 4 Mechaniken frei', 'ach.ladder.done': 'Du hast alle 4 Mechaniken freigeschaltet',
  'welcome.title': 'Willkommen bei Reptiloid Capital!', 'welcome.sub': 'Du bist unser neuer Trainee-Trader. Das Training beginnt sofort – die erste Übungsrunde geht auf uns.', 'welcome.start': 'Spiel starten →', 'welcome.skip': 'Überspringen',
  'ob1.1': 'Analysiere den Bitcoin-Chart und triff eine Entscheidung.',
  'ob1.2': 'Eröffne eine Long-Position nach Chart und Levels. Schließe sie, wann du es für richtig hältst — um den Gewinn mitzunehmen oder den Verlust zu akzeptieren.',
  'ob1.3': 'Eine Position ist im Gewinn, wenn sie über dem Einstiegspunkt liegt; versuche, sie beim maximalen Gewinn zu schließen.',
  'ob2.1': 'Am Markt kannst du nicht nur verdienen, wenn eine Position steigt, sondern auch, wenn sie fällt — wenn du weißt, wie.',
  'ob2.2': 'Bei einer Long-Position wächst der Gewinn, wenn der Wert des Assets über dem Einstiegspunkt liegt.',
  'ob2.3': 'Bei einer Short-Position wächst der Gewinn, wenn der Preis des Assets unter dem Einstiegspunkt liegt.',
  'ob3.1': 'Mit wachsendem Vertrauen in deine Fähigkeiten kannst du mutiger handeln — hier kommt der Hebel ins Spiel; er vervielfacht die Gewinne, erhöht aber auch das Risiko.',
  'ob3.2': 'Der Hebel erlaubt dir, den Einstiegsbetrag zu erhöhen.',
  'ob3.3': 'Behalte die Liquidationslevel im Blick. Wirst du liquidiert, werden 50 % des Einsatzbetrags abgezogen.',
  'rc.next': 'Nächste Runde', 'rc.repeat': 'Runde wiederholen', 'rc.unlock': 'Neue Mechanik freigeschaltet!', 'rc.fwbonus': 'Bonus für den ersten Sieg',
  'mech.short': 'Short-Verkauf', 'mech.short.d': 'Jetzt kannst du Short-Positionen eröffnen und auf fallende Preise setzen',
  'mech.lev': 'Hebel', 'mech.lev.d': 'Jetzt kannst du deinen Einstieg mit ×2–×5-Hebel vervielfachen',
  'play': 'Spielen', 'diff.easy': 'Leicht', 'diff.medium': 'Mittel', 'diff.hard': 'Schwer',
  'game.prognoz.desc': 'Errate die Richtung der nächsten Kerze',
  'game.sdelka.desc': 'Kompletter Trade-Zyklus, nimm deinen Gewinn mit',
  'game.longshort.desc': 'Eröffne eine Position und schließe rechtzeitig',
  'game.plechi.desc': 'Eröffne eine Position mit Hebel und schließe rechtzeitig',
  'game.flappy.desc': 'Flieg am Chart entlang und errate die Richtung',
  'tab.home': 'Start', 'tab.shop': 'Shop', 'tab.referrals': 'Freunde', 'tab.achievements': 'Erfolge', 'tab.settings': 'Optionen',
  'offer.badge': 'Sonderangebot', 'offer.t': 'Starter-Chip-Paket', 'offer.d': 'Hol dir {0} Chips für nur {1} und beschleunige deinen Fortschritt.', 'chips': 'Chips', 'shop.packs': 'Chip-Pakete', 'bar.home': 'Start',
  'shop.title': 'Shop', 'shop.personal': 'Dein Angebot', 'shop.endsin': 'Endet in', 'savePct': '−{0}%',
  'buy': 'Kaufen', 'hot': 'Hot', 'shop.free': 'Gratis',
  'shop.invite.t': 'Freund einladen', 'shop.invite.d': 'Chips für jeden Geworbenen', 'invite': 'Einladen',
  'shop.video.t': 'Video ansehen', 'shop.video.d': 'Verdiene Chips pro Ansicht', 'shop.video.btn': 'Ansehen',
  'shop.fb.t': 'Feedback', 'shop.fb.d': 'Chips für eine ehrliche Bewertung', 'shop.fb.btn': 'Bewerten',
  'shop.dr.t': 'Tagesbonus', 'shop.dr.d': 'Komm täglich zurück für mehr Bonus',
  'claim': 'Abholen', 'claimed': 'Abgeholt',
  'ref.title': 'Freunde', 'ref.h2': 'Lade Freunde ein', 'ref.sub': 'und erhalte 500 Chips pro Freund',
  'ref.banner': 'Lade deinen ersten Freund ein und erhalte einen gratis Trading-Guide.',
  'ref.fld': 'Gib die ID des Spielers ein, der dich eingeladen hat', 'ref.ph': 'ID hier einfügen…', 'paste': 'Einfügen', 'ref.your': 'Deine Geworbenen',
  'ref.copy': 'Deine ID kopieren: {0}', 'ref.invite': 'Freund einladen',
  'ach.title': 'Erfolge', 'ach.reward': 'Prämie', 'newach': 'Neuer Erfolg!', 'newach.claim': 'Prämie abholen',
  'ach.first.t': 'Erster Trade', 'ach.first.d': 'Spiel deine erste Runde', 'ach.first.done': 'Du hast deine erste Runde gespielt',
  'ach.avid.t': 'Fleißiger Spieler', 'ach.avid.d': 'Spiel 3 Runden', 'ach.avid.done': 'Du hast 3 Runden gespielt',
  'ach.bigwin.t': 'Großer Gewinn', 'ach.bigwin.d': 'Gewinne 500+ Chips in einer Runde', 'ach.bigwin.done': 'Du hast 500+ Chips in einer Runde gewonnen',
  'ach.daily2.t': 'Tagesprophet', 'ach.daily2.d': 'Gewinne die Tages-Challenge an 2 Tagen', 'ach.daily2.done': 'Du hast die Tages-Challenge an 2 Tagen gewonnen',
  'ach.explorer.t': 'Entdecker', 'ach.explorer.d': 'Spiel alle 5 Spiele', 'ach.explorer.done': 'Du hast alle 5 Spiele gespielt',
  'ach.flappy100.t': '100 Spiele in FlappyGraph', 'ach.flappy100.d': 'Spiel 100 Runden', 'ach.flappy100.done': 'Du hast 100 Runden gespielt',
  'set.guides': 'Guides und Lektionen', 'set.title': 'Einstellungen', 'sub.notifications': 'Mitteilungen', 'sub.language': 'Sprache', 'sub.music': 'Musik und Vibration', 'sub.style': 'Stil',
  'sub.help': 'Hilfe & Support', 'sub.about': 'Über die App', 'sub.agreements': 'Vereinbarungen', 'sub.terms': 'Nutzungsbedingungen',
  'set.logout': 'Abmelden', 'set.delete': 'Konto löschen',
  'subitem.dcrem': 'Erinnerung an die Tages-Challenge', 'subitem.offers': 'Persönliche Angebote', 'subitem.tourn': 'Turnier-Hinweise',
  'subitem.music': 'Musik', 'subitem.sfx': 'Soundeffekte', 'subitem.vibro': 'Vibration',
  'sub.help.text': 'Support-Chat und FAQ sind noch nicht Teil des Prototyps. Wende dich vorerst direkt ans Team.',
  'sub.about.text': 'Tap Trading Hub — interaktiver Wireframe-Prototyp. Für das Konzept-Review: kein echtes Geld, keine echten Orders. Alle Guthaben sind Spielchips.',
  'sub.agreements.text': 'Platzhalter für rechtliche Vereinbarungen. Finale Texte sind nicht Teil des Prototyps.',
  'sub.terms.text': 'Platzhalter für die Nutzungsbedingungen. Finale Texte sind nicht Teil des Prototyps.',
  'sub.stub': 'Dieser Bereich ist im Prototyp ein Stub.',
  'prof.title': 'Profil', 'prof.edit': 'Bearbeiten', 'prof.stats': 'Statistik', 'prof.games': 'Gespielte Runden',
  'prof.fav': 'Lieblingsspiel', 'prof.best': 'Bester Gewinn', 'prof.started': 'Dabei seit',
  'prof.share': 'Statistik teilen', 'prof.savep': 'Fortschritt sichern',
  'days.one': '{0} Tag', 'days.many': '{0} Tage',
  'guides.title': 'Guides', 'search.ph': 'Suchen', 'guides.empty': 'Nichts gefunden',
  'cat.Long': 'Long', 'cat.Short': 'Short', 'cat.Psychology': 'Psychologie',
  'cat.patterns': 'Chartmuster',
  'pat.pullback.t': 'Pullback im Aufwärtstrend: den Rücksetzer im steigenden Markt kaufen',
  'pat.pullback.p1': 'Ein gesunder Aufwärtstrend steigt in Stufen: ein Schub nach oben, ein kleiner Rücksetzer, der nächste Schub. Dieser Rücksetzer heißt Pullback — der Markt holt Luft, er ändert nicht seine Meinung.',
  'pat.pullback.p2': 'Ein Trader lässt den Rücksetzer ausklingen: Wenn der Chart aufhört zu rutschen und wieder nach oben dreht, ist diese Wende der Einstieg für einen Long. Du kaufst billiger als alle, die dem Hoch des letzten Schubs hinterhergejagt sind.',
  'pat.pullback.p3': 'Was meist schiefgeht: kaufen, während der Preis noch fällt, weil er „schon billig aussieht“. Die Hälfte dieser Rücksetzer fällt weiter. Warte auf die Wende — ein Pullback ist erst dein Freund, wenn er vorbei ist.',
  'pat.support.t': 'Abpraller von der Unterstützung: der Boden, den der Preis immer wieder respektiert',
  'pat.support.p1': 'Manchmal fällt der Preis immer wieder auf dasselbe Niveau — und prallt jedes Mal nach oben ab. Dieses Niveau ist die Unterstützung: ein Boden, an dem immer wieder Käufer auftauchen.',
  'pat.support.p2': 'Der Plan: Kommt der Preis zurück an einen Boden, der schon zweimal gehalten hat, mach dich bereit — und eröffne einen Long, wenn der Abpraller wirklich startet. Das Niveau selbst ist dein einer klarer Grund für den Einstieg.',
  'pat.support.p3': 'Was meist schiefgeht: den Boden für eine Garantie halten. Keine Unterstützung hält ewig — liegt der Preis flach auf dem Niveau und prallt nicht mehr ab, bekommt der Boden Risse. Steig schnell aus, statt zu hoffen.',
  'pat.breakout.t': 'Ausbruch über den Widerstand: wenn die Decke endlich nachgibt',
  'pat.breakout.p1': 'Ein Widerstand ist eine Decke: ein Niveau, das der Chart mehrmals antippt und von dem er jedes Mal wieder abrutscht. Dort warten die Verkäufer — bis sie eines Tages ausgehen.',
  'pat.breakout.p2': 'Wenn der Preis endlich durch die Decke stößt und sich darüber hält, ist das ein Ausbruch. Ein Trader eröffnet einen Long über dem Niveau: Die alte Decke dient jetzt als Boden unter dem Trade.',
  'pat.breakout.p3': 'Was meist schiefgeht: den allerersten Stich durch die Linie kaufen. Gib dem Ganzen einen Moment — kann sich der Preis nicht oben halten, war es kein Ausbruch, sondern Rauschen. Oder eine Falle: siehe den nächsten Fall.',
  'pat.fakeout.t': 'Falscher Ausbruch: die Falle über dem Niveau',
  'pat.fakeout.p1': 'Der Preis springt über eine viel beachtete Decke, alle stürzen sich auf den Kauf — und Augenblicke später fällt er zurück unter das Niveau und nimmt die Chips der Käufer mit. Das ist ein falscher Ausbruch, ein Fakeout.',
  'pat.fakeout.p2': 'Ein ruhiger Trader behandelt den ersten Sprung als Frage, nicht als Antwort: Warte ab, ob sich der Preis über der Linie hält. Und fällt er zurück, wird die Falle selbst zum Signal — ein Short nach einem gescheiterten Ausbruch funktioniert oft gut.',
  'pat.fakeout.p3': 'Was meist schiefgeht: dem Sprung sofort hinterherjagen, aus Angst, etwas zu verpassen. Einen echten Ausbruch zu verpassen kostet nichts; in einem falschen gefangen zu sein kostet echte Chips. Der schnellste Tap bekommt den schlechtesten Preis.',
  'pat.panic.t': 'Panik-Absturz: die V-förmige Erholung',
  'pat.panic.p1': 'Aus dem Nichts fällt der Chart wie ein Stein — eine Wand aus roten Kerzen in Sekunden. Dann steigen genauso plötzlich Käufer ein, und der Preis klettert zurück und malt den Buchstaben V.',
  'pat.panic.p2': 'Die Kunst ist, nicht ins fallende Messer zu greifen. Warte auf die erste starke grüne Kerze nach dem Absturz — das Zeichen, dass der Panik die Verkäufer ausgegangen sind — und nimm erst dann einen Long, um die Erholung mitzufahren.',
  'pat.panic.p3': 'Was meist schiefgeht: mitten im Fall kaufen, weil es „nicht tiefer gehen kann“ (kann es), oder ganz unten einen Short eröffnen, wenn der Absturz schon vorbei ist. In der Panik ist es eine Strategie, absichtlich ein paar Sekunden zu spät zu sein.',
  'pat.range.t': 'Range und Seitwärtsmarkt: wenn der beste Trade kein Trade ist',
  'pat.range.p1': 'Manchmal wandert der Chart einfach seitwärts: eine kleine Kerze rauf, eine kleine runter, keine Richtung. Das ist eine Range, ein Seitwärtsmarkt — der Markt kann sich nicht entscheiden.',
  'pat.range.p2': 'Der ehrliche Plan ist unbeliebt: Handle ihn meistens gar nicht. Die Bewegungen sind winzig, die Eintrittsgebühr frisst den Gewinn, und jeder „Trend“ stirbt in Sekunden. Wenn doch, handle nur die äußersten Ränder der Range — und erwarte wenig.',
  'pat.range.p3': 'Was meist schiefgeht: Langeweile. Der Seitwärtsmarkt verführt zum Tippen, nur um etwas zu tun, und zehn kleine Verluste ergeben einen großen. Eine Range zu erkennen und auf den Händen zu sitzen ist eine echte Trading-Fähigkeit.',
  'art.consolidate': 'Festige dein Wissen in den Spielen',
  'ntf.t1': 'Turnier startet bald', 'ntf.d1': 'Mach mit und gewinne bis zu 1.000 Chips', 'ntf.join': 'Mitmachen',
  'ntf.t2': 'Willkommensbonus für einen Freund', 'ntf.d2': 'Erhalte 500 Chips für eingeladene Freunde',
  'su.title': 'Registrieren', 'su.createacct': 'Konto erstellen', 'su.sub': 'Spiele und trade ab sofort', 'vf.verification': 'Verifizierung', 'vf.err': 'Ungültiger Code. Versuch es erneut.', 'vf.changemail': 'Andere E-Mail verwenden', 'su.email': 'E-Mail', 'su.pass': 'Passwort', 'su.or': 'Oder weiter mit',
  'su.login': 'Schon ein Konto? Anmelden', 'su.legal': 'Wenn du fortfährst, akzeptierst du die Bedingungen und die Datenschutzerklärung.',
  'vf.title': 'Bestätigungscode eingeben', 'vf.sub': '6-stelliger Code gesendet an', 'vf.expires': 'Code läuft ab in {0}',
  'vf.confirm': 'Bestätigen', 'vf.resend': 'Kein Code erhalten? Erneut senden', 'vf.enter4': 'Gib den 4-stelligen Code ein',
  'rc.title': 'RUNDE BEENDET', 'rc.earned': 'Verdient', 'rc.balance': 'Dein Guthaben',
  'tile.guessed': 'Erraten', 'tile.streak': 'Beste Serie', 'tile.mult': 'Bester Multi',
  'tile.final': 'Endguthaben', 'tile.fromstart': 'Seit Start', 'tile.score': 'Rundenpunkte',
  'rc.guides.t': 'Thema interessant?', 'rc.guides.d': 'Lies unsere Guides und trade effektiver.',
  'rc.guides.btn': 'Guides lesen', 'rc.again': 'Nochmal spielen',
  'tut.skip': 'Tutorial überspringen', 'tut.next': 'Weiter',
  'dc.kicker': 'Tages-Challenge', 'dc.title': 'Kerze des Tages (BTC)',
  'dc.sub': 'Wette auf den BTC-Tagesschluss und sichere dir eine Belohnung',
  'dc.placed': 'Trade platziert!', 'dc.comeback': 'Komm morgen wieder für das Ergebnis und halte deine Serie am Leben.', 'done': 'Fertig',
  'dc.open': 'Eröffnung heute, 00:00 GMT', 'dc.now': 'BTC jetzt',
  'dc.won': 'Tag {0} gewonnen!', 'dc.winrest': 'BTC schloss {0} · +{1} Chips',
  'dc.lost': 'Diesmal nicht.', 'dc.lostrest': 'BTC schloss {0} — Serie zurückgesetzt. Versuch es heute erneut!',
  'higher': 'höher', 'lower': 'tiefer', 'today': 'Heute', 'dayN': 'Tag {0}',
  'dc.pick': 'Deine Wahl:',
  'dc.betline.long': 'BTC schließt über der heutigen Eröffnung {0} (00:00 GMT)',
  'dc.betline.short': 'BTC schließt unter der heutigen Eröffnung {0} (00:00 GMT)',
  'dc.betline2.long': 'BTC schließt über der Eröffnung um 00:00 GMT',
  'dc.betline2.short': 'BTC schließt unter der Eröffnung um 00:00 GMT',
  'dc.result': 'Ergebnis in {0}', 'dc.stale': 'Deine {0}-Wette vom {1} wartet auf das Ergebnis · offline', 'offline': 'offline',
  'np.title': 'Lust, den Tagesschluss in der Tages-Challenge vorherzusagen?', 'np.sub': 'Erlaube Mitteilungen',
  'np.allow': 'Erlauben', 'np.deny': 'Ablehnen', 'np.predict': 'Prognose abgeben', 'close': 'Schließen',
  'sp.have': 'Du hast', 'sp.days': 'und {0} mit Siegen in der Tages-Challenge', 'sp.register': 'Registrieren',
  'ooc.title': 'Keine Chips mehr', 'ooc.tomorrow': 'Oder komm morgen für den Tagesbonus wieder',
  'dr.todays': 'Heutige Belohnung', 'dr.claim': 'Bonus abholen', 'dr.claimed': 'Abgeholt ✓',
  'lo.title': 'Abmelden?', 'lo.sub': 'Willst du dich wirklich abmelden?', 'cancel': 'Abbrechen',
  'gp.title': 'Interessiert dich diese Art von Trading?', 'gp.sub': 'Schau in unsere Guides zum Thema',
  'del.title': 'Konto löschen?', 'del.text': 'Diese Aktion ist endgültig. Alle Daten, Erfolge und dein Verlauf gehen verloren.',
  'fw.title': 'Glückwunsch zu deinem ersten erfolgreichen Trade', 'fw.earned': 'Du hast verdient', 'fw.continue': 'Weiterspielen',
  't.stub': 'Noch nicht im Prototyp', 't.fee': 'Eintritt −{0}', 't.feeback': 'Trainingsrunde — Eintritt erstattet +{0}', 't.coins': 'Münzen {0}% → {1} Chips',
  't.traderes': 'Trade-Ergebnis {0} → {1} Chips', 't.dailywon': 'Tages-Challenge gewonnen · +{0} Chips',
  't.placed': '{0} platziert · Ergebnis um 00:00 GMT', 't.dreward': 'Tagesbonus +{0} Chips',
  't.achreward': '„{0}“-Prämie +{1} Chips', 't.video': 'Video gesehen · +{0} Chips',
  't.nopurch': 'Käufe sind nicht im Prototyp', 't.pasted': 'Eingefügt', 't.clipempty': 'Zwischenablage ist leer',
  't.clipna': 'Zwischenablage nicht verfügbar — tippe die ID ein', 't.idcopied': 'Deine ID ist kopiert', 't.yourid': 'Deine ID: {0}',
  't.invitecopied': 'Einladungslink kopiert (Prototyp)', 't.logoutstub': 'Abmelden ist im Prototyp nur visuell',
  't.progsaved': 'Fortschritt gespeichert', 't.progalready': 'Fortschritt bereits gespeichert',
  't.tournstub': 'Turniere sind noch nicht im Prototyp', 't.statscopied': 'Statistik kopiert',
  't.stats': 'Statistik: {0}', 't.sharestats': 'Meine Tap-Trading-Stats: {0} Runden, bester Gewinn {1} Chips, Favorit — {2}.',
},
ja: {
  'game.trade.desc': 'ライブチャートでビットコインを売買しよう',
  'home.stage': 'ステージ {0} / {1}', 'home.next': '次の解放: {0}', 'home.max': '全メカニクス解放済み',
  'stage.1': '売買', 'stage.2': 'ショート', 'stage.3': 'レバレッジ ×2–×5', 'stage.4': '部分ポジション',
  'prof.intents': '購入意向',
  'peak.title': '絶好調！', 'peak.sub': '本物のレベルアップへ — 次の一歩を選ぼう',
  'peak.course': '暗号資産トレード講座', 'peak.course.d': 'ゼロから体系まで、構造化された基礎',
  'peak.academy': 'Binance Academy', 'peak.academy.d': 'パートナーの無料レッスン',
  'peak.prop': 'プロップトレードのクエスト', 'peak.prop.d': '資金提供アカウントで取引',
  'peak.later': '今はしない', 't.peaklogged': '選択を記録しました（プロトタイプ）',
  'stub.pay': '支払う', 'stub.processing': '決済処理中…', 'stub.notify': '完了したらお知らせします',
  'stub.redirect': 'パートナーへリダイレクト中…（プロトタイプ）',
  'stub.item.chips': 'チップ {0}枚', 'stub.item.prop': 'プロップトレードクエスト: 予選ラウンド',
  'stub.item.refcourse': 'エキスパートによるLong/Short徹底講座',
  'tiers.sub': 'レベルを選ぼう',
  'tiers.basic.d': 'チャート、注文、最初のトレード', 'tiers.pro.d': '戦略、レバレッジ、リスク管理',
  'tiers.expert.d': '上級システムとエキスパートのフィードバック',
  'ref.course.t': '無料エキスパート講座',
  'ref.course.d': '最初に購入した友達が1人いれば、エキスパートによるLong/Short徹底講座が無料で解放されます',
  'tasks.title': '実践タスク', 'tasks.sub': 'ゲームをプレイすればチェックが自動で付きます',
  'tasks.1': '利益でトレードを閉じる', 'tasks.2': '清算なしでラウンドを乗り切る', 'tasks.3': '50%の部分決済を使う',
  'ach.shorts.t': 'ショートセラー', 'ach.shorts.d': 'ショートを解放（ステージ2）', 'ach.shorts.done': 'ショートを解放しました',
  'ach.ladder.t': 'フルアーセナル', 'ach.ladder.d': '4つのメカニクスを全て解放', 'ach.ladder.done': '4つのメカニクスを全て解放しました',
  'welcome.title': 'Reptiloid Capitalへようこそ！', 'welcome.sub': '君は新しい研修生トレーダーだ。トレーニングは今すぐ開始 – 最初の練習ラウンドは無料。', 'welcome.start': 'ゲームを始める →', 'welcome.skip': 'スキップ',
  'ob1.1': 'ビットコインのチャートを分析して判断しよう。',
  'ob1.2': 'チャートとレベルをもとにLongポジションを開こう。利益を確定するか損失を受け入れるか、好きなタイミングで閉じよう。',
  'ob1.3': 'ポジションはエントリーポイントより上にあれば利益。最大の利益で閉じることを目指そう。',
  'ob2.1': '市場ではポジションの値上がりだけでなく、値下がりでも稼げる――やり方を知っていれば。',
  'ob2.2': 'Longポジションでは、資産の価値がエントリーポイントより上にあるほど利益が増える。',
  'ob2.3': 'Shortポジションでは、資産の価格がエントリーポイントより下にあるほど利益が増える。',
  'ob3.1': 'スキルに自信がついてきたら、もっと大胆に動ける――そこで登場するのがレバレッジ。リターンを倍増させるが、リスクも増える。',
  'ob3.2': 'レバレッジを使えばエントリー額を増やせる。',
  'ob3.3': '清算レベルに注意。清算されると取引額の50%が差し引かれる。',
  'rc.next': '次のラウンド', 'rc.repeat': 'ラウンドをやり直す', 'rc.unlock': '新メカニクス解放！', 'rc.fwbonus': '初勝利ボーナス',
  'mech.short': 'Short（空売り）', 'mech.short.d': 'Shortポジションを開いて価格の下落に賭けられるようになった',
  'mech.lev': 'レバレッジ', 'mech.lev.d': '×2–×5のレバレッジでエントリー額を増やせるようになった',
  'play': 'プレイ', 'diff.easy': '初級', 'diff.medium': '中級', 'diff.hard': '上級',
  'game.prognoz.desc': '次のローソクの方向を当てよう',
  'game.sdelka.desc': '取引の全サイクルで利益を狙おう',
  'game.longshort.desc': 'ポジションを開いて時間内に閉じよう',
  'game.plechi.desc': 'レバレッジ付きでポジションを開いて時間内に閉じよう',
  'game.flappy.desc': 'チャートに沿って飛び、方向を当てよう',
  'tab.home': 'ホーム', 'tab.shop': 'ショップ', 'tab.referrals': '招待', 'tab.achievements': '実績', 'tab.settings': '設定',
  'offer.badge': '特別オファー', 'offer.t': 'スターターチップパック', 'offer.d': '{0}チップがたったの{1}。進化を加速しよう。', 'chips': 'チップ', 'shop.packs': 'チップパック', 'bar.home': 'ホーム',
  'shop.title': 'ショップ', 'shop.personal': '特別オファー', 'shop.endsin': '終了まで', 'savePct': '{0}%お得',
  'buy': '購入', 'hot': 'Hot', 'shop.free': '無料',
  'shop.invite.t': '友達を招待', 'shop.invite.d': '紹介ごとにチップ獲得', 'invite': '招待',
  'shop.video.t': '動画を見る', 'shop.video.d': '視聴ごとにチップ獲得', 'shop.video.btn': '見る',
  'shop.fb.t': 'フィードバック', 'shop.fb.d': '正直なレビューでチップ獲得', 'shop.fb.btn': 'レビューを書く',
  'shop.dr.t': 'デイリー報酬', 'shop.dr.d': '毎日戻ってボーナスアップ',
  'claim': '受け取る', 'claimed': '受取済み',
  'ref.title': '招待', 'ref.h2': '友達を招待して', 'ref.sub': '1人につき500チップをゲット',
  'ref.banner': '最初の友達を招待すると無料のトレードガイドがもらえます。',
  'ref.fld': 'あなたを招待したプレイヤーのIDを入力', 'ref.ph': 'ここにIDを貼り付け…', 'paste': '貼り付け', 'ref.your': 'あなたの紹介',
  'ref.copy': '自分のIDをコピー: {0}', 'ref.invite': '友達を招待',
  'ach.title': '実績', 'ach.reward': '報酬', 'newach': '新しい実績！', 'newach.claim': '報酬を受け取る',
  'ach.first.t': '初トレード', 'ach.first.d': '最初のラウンドを完了しよう', 'ach.first.done': '最初のラウンドを完了しました',
  'ach.avid.t': '熱心なプレイヤー', 'ach.avid.d': 'ラウンドを3回完了しよう', 'ach.avid.done': 'ラウンドを3回完了しました',
  'ach.bigwin.t': '大勝利', 'ach.bigwin.d': '1ラウンドで500+チップ獲得', 'ach.bigwin.done': '1ラウンドで500+チップ獲得しました',
  'ach.daily2.t': 'デイリー予報士', 'ach.daily2.d': 'デイリーチャレンジで2日勝利', 'ach.daily2.done': 'デイリーチャレンジで2日勝利しました',
  'ach.explorer.t': '探検家', 'ach.explorer.d': '5つのゲームを全部プレイ', 'ach.explorer.done': '5つのゲームを全部プレイしました',
  'ach.flappy100.t': 'FlappyGraphで100回', 'ach.flappy100.d': '100回プレイしよう', 'ach.flappy100.done': '100回プレイしました',
  'set.guides': 'ガイドとレッスン', 'set.title': '設定', 'sub.notifications': '通知', 'sub.language': '言語', 'sub.music': '音楽とバイブ', 'sub.style': 'スタイル',
  'sub.help': 'ヘルプとサポート', 'sub.about': 'アプリについて', 'sub.agreements': '規約', 'sub.terms': '利用規約',
  'set.logout': 'ログアウト', 'set.delete': 'アカウント削除',
  'subitem.dcrem': 'デイリーチャレンジの通知', 'subitem.offers': '特別オファー', 'subitem.tourn': 'トーナメント通知',
  'subitem.music': '音楽', 'subitem.sfx': '効果音', 'subitem.vibro': 'バイブレーション',
  'sub.help.text': 'サポートチャットとFAQはまだプロトタイプに含まれていません。今はチームに直接連絡してください。',
  'sub.about.text': 'Tap Trading Hub — インタラクティブなワイヤーフレームのプロトタイプ。コンセプト確認用：実際のお金や注文はありません。残高はすべてゲーム用チップです。',
  'sub.agreements.text': '法的規約のプレースホルダー。最終テキストはプロトタイプに含まれません。',
  'sub.terms.text': '利用規約のプレースホルダー。最終テキストはプロトタイプに含まれません。',
  'sub.stub': 'このセクションはプロトタイプではスタブです。',
  'prof.title': 'プロフィール', 'prof.edit': '編集', 'prof.stats': '統計', 'prof.games': 'プレイ回数',
  'prof.fav': 'お気に入り', 'prof.best': '最高勝利', 'prof.started': '開始日',
  'prof.share': '統計をシェア', 'prof.savep': '進行状況を保存',
  'days.one': '{0}日', 'days.many': '{0}日',
  'guides.title': 'ガイド', 'search.ph': '検索', 'guides.empty': '見つかりません',
  'cat.Long': 'Long', 'cat.Short': 'Short', 'cat.Psychology': '心理学',
  'cat.patterns': 'チャートパターン',
  'pat.pullback.t': '上昇トレンドの押し目：上げ相場での押し目買い',
  'pat.pullback.p1': '健全な上昇トレンドは階段状に上がります。ひと押し上げて、少し下がり、また上げる。この小さな下げが「押し目（プルバック）」です。市場が息継ぎをしているだけで、気が変わったわけではありません。',
  'pat.pullback.p2': 'トレーダーは下げが終わるのを待ちます。チャートが下げ止まり、再び上を向いたその転換点がLongのエントリーです。直前の高値を追いかけた人たちより安く買えます。',
  'pat.pullback.p3': 'よくある失敗は、「もう安く見える」と、まだ落ちている途中で買うこと。押し目の半分はそのまま落ち続けます。転換を待ちましょう。押し目は、終わってはじめて味方になります。',
  'pat.support.t': 'サポートでの反発：価格が何度も守る床',
  'pat.support.p1': '価格が同じ水準まで何度も下がり、そのたびに跳ね返ることがあります。その水準がサポート（支持線）です。買い手が必ず現れる床のようなものです。',
  'pat.support.p2': '狙い方はシンプル。すでに2回守られた床に価格が戻ってきたら準備をして、反発が実際に始まったらLongを開きます。その水準そのものが、エントリーの明確な理由になります。',
  'pat.support.p3': 'よくある失敗は、床を保証だと思い込むこと。永遠に守られるサポートはありません。価格が水準に張り付いて跳ねなくなったら、床はひび割れています。祈らずに素早く撤退しましょう。',
  'pat.breakout.t': 'レジスタンスのブレイクアウト：天井がついに破れるとき',
  'pat.breakout.p1': 'レジスタンス（抵抗線）は天井です。チャートが何度も触れては、そのたびに押し返される水準。そこには売り手が待ち構えています——ある日、彼らが尽きるまで。',
  'pat.breakout.p2': '価格がついに天井を突き抜け、その上で保てたら、それがブレイクアウトです。トレーダーは水準の上でLongを開きます。かつての天井は、今度はトレードを支える床として働きます。',
  'pat.breakout.p3': 'よくある失敗は、線を最初に突いた瞬間に買うこと。少し待ちましょう。上に留まれなければ、それはブレイクではなくノイズです。あるいは罠かもしれません——次のケースへ。',
  'pat.fakeout.t': 'だまし（フェイクアウト）：水準の上に仕掛けられた罠',
  'pat.fakeout.p1': '注目の天井を価格が飛び越え、みんなが買いに殺到——その直後、水準の下へ逆戻りし、買った人たちのチップを持ち去ります。これが「だまし」、フェイクアウトです。',
  'pat.fakeout.p2': '冷静なトレーダーは最初のジャンプを「答え」ではなく「問い」として扱います。価格が線の上で持ちこたえるか見届けましょう。そして下に戻ったら、罠そのものがシグナルになります。失敗したブレイクの後のShortはよく機能します。',
  'pat.fakeout.p3': 'よくある失敗は、乗り遅れが怖くてジャンプに飛びつくこと。本物のブレイクを逃しても損はゼロ。偽物に捕まれば本物のチップを失います。いちばん速いタップが、いちばん悪い価格をつかみます。',
  'pat.panic.t': 'パニックの急落：V字回復',
  'pat.panic.p1': '何の前触れもなくチャートが石のように落ち、数秒で赤いローソクの壁ができます。そして同じくらい突然買い手が入り、価格は戻り、アルファベットのVを描きます。',
  'pat.panic.p2': 'コツは「落ちてくるナイフ」を掴まないこと。急落後の最初の力強い緑のローソクを待ちます。パニックの売り手が尽きたサインです。そこではじめてLongを取り、回復に乗ります。',
  'pat.panic.p3': 'よくある失敗は2つ。「これ以上は下がらない」と落下の途中で買うこと（下がります）、そして落ち切った底でShortを開くこと。パニックでは、わざと数秒遅れることが戦略になります。',
  'pat.range.t': 'レンジと持ち合い：「取引しない」が最善のとき',
  'pat.range.p1': 'チャートがただ横にさまようことがあります。小さな陽線、小さな陰線、方向感なし。これがレンジ（持ち合い）です。市場が決めかねている状態です。',
  'pat.range.p2': 'ここでの正直な戦略は不人気です。基本、手を出さないこと。値幅が小さいので参加料が利益を食い、どんな「トレンド」も数秒で消えます。どうしてもやるなら、レンジの端だけを狙い、多くを期待しないことです。',
  'pat.range.p3': 'よくある失敗は退屈です。持ち合いは「何かしたい」だけのタップを誘い、小さな損が10回で大きな損1回分になります。持ち合いを見分けて手を止めるのは、立派なトレード技術です。',
  'art.consolidate': 'ゲームで知識を定着させよう',
  'ntf.t1': 'まもなくトーナメント開始', 'ntf.d1': 'トーナメントに参加して1,000チップを狙おう', 'ntf.join': '参加',
  'ntf.t2': '友達のウェルカムボーナス', 'ntf.d2': '招待した友達ごとに500チップ',
  'su.title': '登録', 'su.createacct': 'アカウント作成', 'su.sub': '今すぐプレイしてトレードを始めよう', 'vf.verification': '認証', 'vf.err': 'コードが無効です。もう一度お試しください。', 'vf.changemail': '別のメールを使う', 'su.email': 'メール', 'su.pass': 'パスワード', 'su.or': 'または次で続行',
  'su.login': 'アカウントをお持ちですか？ログイン', 'su.legal': '続行すると、利用規約とプライバシーポリシーに同意したことになります。',
  'vf.title': '確認コードを入力', 'vf.sub': '6桁のコードを送信しました：', 'vf.expires': 'コード有効期限 {0}',
  'vf.confirm': '確認', 'vf.resend': 'コードが届かない？再送信', 'vf.enter4': '4桁のコードを入力してください',
  'rc.title': 'ラウンド終了', 'rc.earned': '獲得', 'rc.balance': '残高',
  'tile.guessed': '的中', 'tile.streak': '最高連続', 'tile.mult': '最高倍率',
  'tile.final': '最終残高', 'tile.fromstart': '開始から', 'tile.score': 'スコア',
  'rc.guides.t': 'このテーマに興味は？', 'rc.guides.d': 'ガイドを読んで、もっと上手にトレードしよう。',
  'rc.guides.btn': 'ガイドを読む', 'rc.again': 'もう一度',
  'tut.skip': 'チュートリアルをスキップ', 'tut.next': '次へ',
  'dc.kicker': 'デイリーチャレンジ', 'dc.title': '今日のローソク（BTC）',
  'dc.sub': 'BTCの日足終値を予想して報酬をゲット',
  'dc.placed': 'トレード成立！', 'dc.comeback': '明日戻って結果を確認し、連続記録を続けよう。', 'done': '完了',
  'dc.open': '本日の始値、00:00 GMT', 'dc.now': '現在のBTC',
  'dc.won': '{0}日目に勝利！', 'dc.winrest': 'BTCは始値より{0}で引けました · +{1}チップ',
  'dc.lost': '今回は残念。', 'dc.lostrest': 'BTCは始値より{0}で引けました — 連続記録はリセット。今日また挑戦！',
  'higher': '上', 'lower': '下', 'today': '今日', 'dayN': '{0}日目',
  'dc.pick': 'あなたの予想:',
  'dc.betline.long': 'BTCが本日の始値{0}（00:00 GMT）より上で引ける',
  'dc.betline.short': 'BTCが本日の始値{0}（00:00 GMT）より下で引ける',
  'dc.betline2.long': 'BTCが00:00 GMTの始値より上で引ける',
  'dc.betline2.short': 'BTCが00:00 GMTの始値より下で引ける',
  'dc.result': '結果まで {0}', 'dc.stale': '{1}の{0}ベットは結果待ち · オフライン', 'offline': 'オフライン',
  'np.title': 'デイリーチャレンジで今日の終値を予想してみない？', 'np.sub': '通知を許可してください',
  'np.allow': '許可', 'np.deny': '拒否', 'np.predict': '予想する', 'close': '閉じる',
  'sp.have': '保有チップ', 'sp.days': 'デイリーチャレンジで{0}の勝利', 'sp.register': '登録',
  'ooc.title': 'チップ切れ', 'ooc.tomorrow': 'または明日のデイリー報酬を待とう',
  'dr.todays': '今日の報酬', 'dr.claim': 'ボーナスを受け取る', 'dr.claimed': '受取済み ✓',
  'lo.title': 'ログアウトしますか？', 'lo.sub': '本当にログアウトしますか？', 'cancel': 'キャンセル',
  'gp.title': 'この種のトレードに興味は？', 'gp.sub': 'このテーマのガイドをチェック',
  'del.title': 'アカウントを削除しますか？', 'del.text': 'この操作は取り消せません。データ、実績、履歴はすべて失われます。',
  'fw.title': '初めてのトレード成功おめでとう！', 'fw.earned': '獲得:', 'fw.continue': 'プレイを続ける',
  't.stub': 'プロトタイプには未実装', 't.fee': '参加料 −{0}', 't.feeback': 'トレーニングラウンド — 参加料返金 +{0}', 't.coins': 'コイン{0}% → {1}チップ',
  't.traderes': 'トレード結果 {0} → {1}チップ', 't.dailywon': 'デイリーチャレンジ勝利 · +{0}チップ',
  't.placed': '{0}成立 · 結果は00:00 GMT', 't.dreward': 'デイリー報酬 +{0}チップ',
  't.achreward': '「{0}」報酬 +{1}チップ', 't.video': '動画視聴 · +{0}チップ',
  't.nopurch': '購入はプロトタイプ対象外', 't.pasted': '貼り付けました', 't.clipempty': 'クリップボードは空です',
  't.clipna': 'クリップボード不可 — IDを入力してください', 't.idcopied': 'IDをコピーしました', 't.yourid': 'あなたのID: {0}',
  't.invitecopied': '招待リンクをコピー（プロトタイプ）', 't.logoutstub': 'ログアウトはプロトタイプでは見た目だけ',
  't.progsaved': '進行状況を保存しました', 't.progalready': '保存済みです',
  't.tournstub': 'トーナメントは未実装', 't.statscopied': '統計をコピーしました',
  't.stats': '統計: {0}', 't.sharestats': '私のTap Trading統計: {0}回プレイ、最高勝利{1}チップ、お気に入り — {2}。',
},
zh: {
  'game.trade.desc': '在实时图表上买卖比特币',
  'home.stage': '第 {0} 阶段，共 {1} 阶段', 'home.next': '下一个解锁: {0}', 'home.max': '所有机制已解锁',
  'stage.1': '买入卖出', 'stage.2': '做空', 'stage.3': '杠杆 ×2–×5', 'stage.4': '部分仓位',
  'prof.intents': '购买意向',
  'peak.title': '你火力全开！', 'peak.sub': '来真的升级 — 选择你的下一步',
  'peak.course': '加密交易课程', 'peak.course.d': '结构化基础，从零到体系',
  'peak.academy': 'Binance Academy', 'peak.academy.d': '合作伙伴的免费课程',
  'peak.prop': '自营交易挑战', 'peak.prop.d': '操作资助账户',
  'peak.later': '暂不', 't.peaklogged': '已记录选择（原型）',
  'stub.pay': '支付', 'stub.processing': '支付处理中…', 'stub.notify': '完成后我们会通知你',
  'stub.redirect': '正在跳转到合作伙伴…（原型）',
  'stub.item.chips': '{0}筹码', 'stub.item.prop': '自营交易挑战: 资格赛',
  'stub.item.refcourse': '专家的Long/Short深度课程',
  'tiers.sub': '选择你的级别',
  'tiers.basic.d': '图表、下单和第一笔交易', 'tiers.pro.d': '策略、杠杆和风险管理',
  'tiers.expert.d': '进阶体系与专家反馈',
  'ref.course.t': '免费专家课程',
  'ref.course.d': '你的第一位完成购买的好友将免费解锁专家的Long/Short深度课程',
  'tasks.title': '实战任务', 'tasks.sub': '玩游戏即可，勾选会自动点亮',
  'tasks.1': '盈利平掉一笔交易', 'tasks.2': '整回合不被爆仓', 'tasks.3': '使用50%部分离场',
  'ach.shorts.t': '做空者', 'ach.shorts.d': '解锁做空（第2阶段）', 'ach.shorts.done': '你解锁了做空',
  'ach.ladder.t': '全套武器', 'ach.ladder.d': '解锁全部4种机制', 'ach.ladder.done': '你解锁了全部4种机制',
  'welcome.title': '欢迎加入 Reptiloid Capital！', 'welcome.sub': '你是我们新的实习交易员。培训现在开始 – 第一局练习由我们请客。', 'welcome.start': '开始游戏 →', 'welcome.skip': '跳过',
  'ob1.1': '分析比特币走势图并做出决定。',
  'ob1.2': '根据图表和价位开一个 Long 仓位。在你认为合适的时候平仓——获利了结或接受亏损。',
  'ob1.3': '仓位高于入场点即为盈利；尽量在最大盈利时平仓。',
  'ob2.1': '在市场上，不仅仓位上涨能赚钱，下跌也能——只要你懂方法。',
  'ob2.2': '开 Long 仓位时，资产价值高于入场点，利润就会增加。',
  'ob2.3': '开 Short 仓位时，资产价格低于入场点，利润就会增加。',
  'ob3.1': '随着对自己技能的信心增强，你可以更大胆——这就是杠杆的用武之地；它放大收益，也放大风险。',
  'ob3.2': '杠杆可以放大你的入场金额。',
  'ob3.3': '注意清算线。一旦被清算，将扣除交易金额的 50%。',
  'rc.next': '下一局', 'rc.repeat': '重玩本局', 'rc.unlock': '解锁新机制！', 'rc.fwbonus': '首胜奖励',
  'mech.short': 'Short 卖空', 'mech.short.d': '现在你可以开 Short 仓位，押注价格下跌',
  'mech.lev': '杠杆', 'mech.lev.d': '现在你可以用 ×2–×5 杠杆放大入场金额',
  'play': '开始', 'diff.easy': '简单', 'diff.medium': '中等', 'diff.hard': '困难',
  'game.prognoz.desc': '猜下一根K线的方向',
  'game.sdelka.desc': '完整交易周期，拿走你的利润',
  'game.longshort.desc': '开仓并及时平仓',
  'game.plechi.desc': '带杠杆开仓并及时平仓',
  'game.flappy.desc': '沿着图表飞行并猜方向',
  'tab.home': '首页', 'tab.shop': '商店', 'tab.referrals': '邀请', 'tab.achievements': '成就', 'tab.settings': '设置',
  'offer.badge': '特别优惠', 'offer.t': '新手筹码包', 'offer.d': '仅需{1}即可获得{0}筹码，加速你的进度。', 'chips': '筹码', 'shop.packs': '筹码套餐', 'bar.home': '主页',
  'shop.title': '商店', 'shop.personal': '专属优惠', 'shop.endsin': '剩余时间', 'savePct': '省{0}%',
  'buy': '购买', 'hot': 'Hot', 'shop.free': '免费',
  'shop.invite.t': '邀请好友', 'shop.invite.d': '每邀请一人获得筹码', 'invite': '邀请',
  'shop.video.t': '观看视频', 'shop.video.d': '每次观看获得筹码', 'shop.video.btn': '观看',
  'shop.fb.t': '反馈', 'shop.fb.d': '认真评价即得筹码', 'shop.fb.btn': '写评价',
  'shop.dr.t': '每日奖励', 'shop.dr.d': '每天回来，奖励更多',
  'claim': '领取', 'claimed': '已领取',
  'ref.title': '邀请', 'ref.h2': '邀请好友', 'ref.sub': '每位好友得500筹码',
  'ref.banner': '邀请第一位好友，免费获得交易指南。',
  'ref.fld': '输入邀请你的玩家ID', 'ref.ph': '在此粘贴ID…', 'paste': '粘贴', 'ref.your': '你的邀请',
  'ref.copy': '复制你的ID: {0}', 'ref.invite': '邀请好友',
  'ach.title': '成就', 'ach.reward': '奖励', 'newach': '新成就！', 'newach.claim': '领取奖励',
  'ach.first.t': '首笔交易', 'ach.first.d': '完成第一局', 'ach.first.done': '你完成了第一局',
  'ach.avid.t': '活跃玩家', 'ach.avid.d': '完成3局', 'ach.avid.done': '你完成了3局',
  'ach.bigwin.t': '大赢家', 'ach.bigwin.d': '单局赢得500+筹码', 'ach.bigwin.done': '你单局赢得了500+筹码',
  'ach.daily2.t': '每日预言家', 'ach.daily2.d': '每日挑战获胜2天', 'ach.daily2.done': '你在每日挑战中获胜2天',
  'ach.explorer.t': '探索者', 'ach.explorer.d': '玩遍全部5款游戏', 'ach.explorer.done': '你玩遍了全部5款游戏',
  'ach.flappy100.t': 'FlappyGraph 100局', 'ach.flappy100.d': '完成100局', 'ach.flappy100.done': '你完成了100局',
  'set.guides': '指南与课程', 'set.title': '设置', 'sub.notifications': '通知', 'sub.language': '语言', 'sub.music': '音乐与震动', 'sub.style': '风格',
  'sub.help': '帮助与支持', 'sub.about': '关于应用', 'sub.agreements': '协议', 'sub.terms': '服务条款',
  'set.logout': '退出登录', 'set.delete': '删除账号',
  'subitem.dcrem': '每日挑战提醒', 'subitem.offers': '专属优惠', 'subitem.tourn': '锦标赛提醒',
  'subitem.music': '音乐', 'subitem.sfx': '音效', 'subitem.vibro': '震动',
  'sub.help.text': '客服聊天和FAQ暂未包含在原型中。目前请直接联系团队。',
  'sub.about.text': 'Tap Trading Hub — 交互式线框原型。用于概念评审：无真实资金，无真实订单。所有余额均为游戏筹码。',
  'sub.agreements.text': '法律协议占位符。最终文本不包含在原型中。',
  'sub.terms.text': '服务条款占位符。最终文本不包含在原型中。',
  'sub.stub': '此部分在原型中为占位。',
  'prof.title': '个人资料', 'prof.edit': '编辑', 'prof.stats': '统计', 'prof.games': '游戏局数',
  'prof.fav': '最爱游戏', 'prof.best': '最高赢利', 'prof.started': '开始时间',
  'prof.share': '分享统计', 'prof.savep': '保存进度',
  'days.one': '{0}天', 'days.many': '{0}天',
  'guides.title': '指南', 'search.ph': '搜索', 'guides.empty': '未找到',
  'cat.Long': 'Long', 'cat.Short': 'Short', 'cat.Psychology': '心理',
  'cat.patterns': '图表形态',
  'pat.pullback.t': '上升趋势中的回调：在上涨行情里低吸',
  'pat.pullback.p1': '健康的上升趋势是阶梯式的：先冲一波，再小幅回落，然后再冲。这个小幅回落叫回调（pullback）——市场在喘口气，而不是改变主意。',
  'pat.pullback.p2': '交易者会等回落结束：当图表止跌并重新转头向上，这个转折就是Long的入场点。你买得比那些追高的人更便宜。',
  'pat.pullback.p3': '常见错误：价格还在下跌时就因为“看起来便宜了”而买入。这类回调有一半会继续跌。等转折出现——回调只有结束之后才是你的朋友。',
  'pat.support.t': '支撑位反弹：价格一再尊重的地板',
  'pat.support.p1': '有时价格一次又一次跌到同一水平——每次都反弹上去。这个水平就是支撑位：一个买家总会出现的地板。',
  'pat.support.p2': '打法很简单：当价格回到一个已经守住两次的地板时做好准备，反弹真正开始时再开Long。这个位置本身就是你入场的一个明确理由。',
  'pat.support.p3': '常见错误：把地板当成保证。没有永远守得住的支撑——如果价格贴在支撑上不再反弹，地板正在开裂。快速离场，别抱侥幸。',
  'pat.breakout.t': '阻力位突破：天花板终于被顶破',
  'pat.breakout.p1': '阻力位是天花板：图表多次触碰、每次都被压回去的水平。卖家在那里守着——直到某天他们耗尽。',
  'pat.breakout.p2': '当价格终于顶穿天花板并站稳在上方，这就是突破。交易者在该水平上方开Long：旧天花板现在成了交易下方的地板。',
  'pat.breakout.p3': '常见错误：线刚被捅破第一下就买。给它一点时间——价格站不稳在上方，那就不是突破，只是噪音。或者是陷阱：看下一个案例。',
  'pat.fakeout.t': '假突破：埋伏在水平上方的陷阱',
  'pat.fakeout.p1': '价格跳上一个众人紧盯的天花板，大家蜂拥买入——片刻后它又跌回水平之下，把买家的筹码一并带走。这就是假突破（fakeout）。',
  'pat.fakeout.p2': '冷静的交易者把第一次跳升当作问题而非答案：先看价格能否站稳在线上。而当它跌回去时，陷阱本身就成了信号——突破失败后的Short往往很有效。',
  'pat.fakeout.p3': '常见错误：因为怕错过而立刻追涨。错过真突破不花一分钱；被假突破套住要赔真筹码。手最快的人拿到最差的价格。',
  'pat.panic.t': '恐慌急跌：V形反转',
  'pat.panic.p1': '毫无征兆地，图表像石头一样坠落——几秒钟内一堵红色蜡烛墙。随后买家同样突然地进场，价格爬回来，画出字母V。',
  'pat.panic.p2': '功夫在于不去接下落的刀。等急跌后第一根有力的绿色蜡烛——那是恐慌卖家耗尽的信号——然后再开Long，搭上反弹。',
  'pat.panic.p3': '常见错误有两个：在下跌途中因为“不可能更低了”而买入（可能的），以及在跌完之后的底部开Short。在恐慌里，故意晚几秒入场本身就是策略。',
  'pat.range.t': '震荡与横盘：最好的交易是不交易',
  'pat.range.p1': '有时图表只是横着晃：小阳线、小阴线，毫无方向。这就是震荡区间（横盘）——市场拿不定主意。',
  'pat.range.p2': '这里诚实的打法并不讨喜：大多数时候，别碰它。波动太小，入场费吃掉利润，每个“趋势”几秒就死。真要做，只做区间的最边缘——并且别期待太多。',
  'pat.range.p3': '常见错误：无聊。横盘诱惑你为了“做点什么”而不停点击，十次小亏加起来就是一次大亏。认出横盘并管住手，是一项真正的交易技能。',
  'art.consolidate': '在游戏中巩固知识',
  'ntf.t1': '锦标赛即将开始', 'ntf.d1': '参加锦标赛，有机会赢1,000筹码', 'ntf.join': '参加',
  'ntf.t2': '好友欢迎奖励', 'ntf.d2': '每邀请一位好友得500筹码',
  'su.title': '注册', 'su.createacct': '创建账户', 'su.sub': '立即开始游戏和交易', 'vf.verification': '验证', 'vf.err': '验证码无效，请重试。', 'vf.changemail': '使用其他邮箱', 'su.email': '邮箱', 'su.pass': '密码', 'su.or': '或继续使用',
  'su.login': '已有账号？登录', 'su.legal': '继续即表示你同意条款和隐私政策。',
  'vf.title': '输入验证码', 'vf.sub': '6位验证码已发送至', 'vf.expires': '验证码有效期 {0}',
  'vf.confirm': '确认', 'vf.resend': '没收到验证码？重新发送', 'vf.enter4': '请输入4位验证码',
  'rc.title': '回合结束', 'rc.earned': '获得', 'rc.balance': '你的余额',
  'tile.guessed': '猜中', 'tile.streak': '最长连胜', 'tile.mult': '最高倍数',
  'tile.final': '最终余额', 'tile.fromstart': '相比开局', 'tile.score': '本局得分',
  'rc.guides.t': '对这个话题感兴趣？', 'rc.guides.d': '看看我们的指南，交易更高效。',
  'rc.guides.btn': '阅读指南', 'rc.again': '再玩一局',
  'tut.skip': '跳过教程', 'tut.next': '下一步',
  'dc.kicker': '每日挑战', 'dc.title': '今日K线（BTC）',
  'dc.sub': '预测BTC日线收盘并赢取奖励',
  'dc.placed': '已下单！', 'dc.comeback': '明天回来查看结果，延续你的连胜。', 'done': '完成',
  'dc.open': '今日开盘，00:00 GMT', 'dc.now': 'BTC现价',
  'dc.won': '第{0}天获胜！', 'dc.winrest': 'BTC收盘{0} · +{1}筹码',
  'dc.lost': '这次没中。', 'dc.lostrest': 'BTC收盘{0} — 连胜重置。今天再试一次！',
  'higher': '更高', 'lower': '更低', 'today': '今天', 'dayN': '第{0}天',
  'dc.pick': '你的选择:',
  'dc.betline.long': 'BTC收盘价将高于今日开盘价{0}（00:00 GMT）',
  'dc.betline.short': 'BTC收盘价将低于今日开盘价{0}（00:00 GMT）',
  'dc.betline2.long': 'BTC收盘价将高于00:00 GMT的开盘价',
  'dc.betline2.short': 'BTC收盘价将低于00:00 GMT的开盘价',
  'dc.result': '距结果 {0}', 'dc.stale': '你{1}的{0}下注正在等待结果 · 离线', 'offline': '离线',
  'np.title': '想在每日挑战中预测今天如何收盘吗？', 'np.sub': '请允许通知',
  'np.allow': '允许', 'np.deny': '拒绝', 'np.predict': '去预测', 'close': '关闭',
  'sp.have': '你拥有', 'sp.days': '以及每日挑战中{0}的胜利', 'sp.register': '注册',
  'ooc.title': '筹码不足', 'ooc.tomorrow': '或者明天回来领每日奖励',
  'dr.todays': '今日奖励', 'dr.claim': '领取奖励', 'dr.claimed': '已领取 ✓',
  'lo.title': '退出登录？', 'lo.sub': '确定要退出登录吗？', 'cancel': '取消',
  'gp.title': '对这种交易感兴趣？', 'gp.sub': '看看我们相关的指南',
  'del.title': '删除账号？', 'del.text': '此操作不可撤销。你的所有数据、成就和历史都将丢失。',
  'fw.title': '恭喜完成第一笔成功交易', 'fw.earned': '你获得了', 'fw.continue': '继续游戏',
  't.stub': '原型中暂未实现', 't.fee': '入场费 −{0}', 't.feeback': '训练回合 — 入场费已退还 +{0}', 't.coins': '金币{0}% → {1}筹码',
  't.traderes': '交易结果 {0} → {1}筹码', 't.dailywon': '每日挑战获胜 · +{0}筹码',
  't.placed': '{0}已下单 · 结果在00:00 GMT', 't.dreward': '每日奖励 +{0}筹码',
  't.achreward': '「{0}」奖励 +{1}筹码', 't.video': '视频看完 · +{0}筹码',
  't.nopurch': '原型中不支持购买', 't.pasted': '已粘贴', 't.clipempty': '剪贴板为空',
  't.clipna': '剪贴板不可用 — 请手动输入ID', 't.idcopied': '你的ID已复制', 't.yourid': '你的ID: {0}',
  't.invitecopied': '邀请链接已复制（原型）', 't.logoutstub': '原型中退出登录仅为演示',
  't.progsaved': '进度已保存', 't.progalready': '进度已保存过了',
  't.tournstub': '锦标赛暂未实现', 't.statscopied': '统计已复制',
  't.stats': '统计: {0}', 't.sharestats': '我的Tap Trading统计: {0}局，最高赢利{1}筹码，最爱 — {2}。',
},
pt: {
  'game.trade.desc': 'Compre e venda Bitcoin no gráfico ao vivo',
  'home.stage': 'Fase {0} de {1}', 'home.next': 'Próximo desbloqueio: {0}', 'home.max': 'Todas as mecânicas desbloqueadas',
  'stage.1': 'Comprar e vender', 'stage.2': 'Shorts', 'stage.3': 'Alavancagem ×2–×5', 'stage.4': 'Posições parciais',
  'prof.intents': 'Intenções de compra',
  'peak.title': 'Você está com tudo!', 'peak.sub': 'Suba de nível de verdade — escolha o próximo passo',
  'peak.course': 'Curso de trading de cripto', 'peak.course.d': 'Base estruturada, do zero ao sistema',
  'peak.academy': 'Binance Academy', 'peak.academy.d': 'Aulas grátis do parceiro',
  'peak.prop': 'Desafios de prop trading', 'peak.prop.d': 'Opere uma conta financiada',
  'peak.later': 'Agora não', 't.peaklogged': 'Escolha registrada (protótipo)',
  'stub.pay': 'Pagar', 'stub.processing': 'Processando o pagamento…', 'stub.notify': 'Avisaremos quando estiver pronto',
  'stub.redirect': 'Redirecionando ao parceiro… (protótipo)',
  'stub.item.chips': '{0} fichas', 'stub.item.prop': 'Desafio de prop trading: rodada de qualificação',
  'stub.item.refcourse': 'Curso Long/Short aprofundado de um expert',
  'tiers.sub': 'Escolha seu nível',
  'tiers.basic.d': 'Gráficos, ordens e primeiros trades', 'tiers.pro.d': 'Estratégias, alavancagem e gestão de risco',
  'tiers.expert.d': 'Sistema avançado e feedback do expert',
  'ref.course.t': 'Curso de expert grátis',
  'ref.course.d': 'Seu primeiro amigo que fizer uma compra desbloqueia grátis um curso Long/Short aprofundado de um expert',
  'tasks.title': 'Tarefas práticas', 'tasks.sub': 'Jogue — as marcações acendem sozinhas',
  'tasks.1': 'Feche um trade no lucro', 'tasks.2': 'Sobreviva a uma rodada sem liquidação', 'tasks.3': 'Use uma saída parcial de 50%',
  'ach.shorts.t': 'Vendedor a descoberto', 'ach.shorts.d': 'Desbloqueie os shorts (fase 2)', 'ach.shorts.done': 'Você desbloqueou os shorts',
  'ach.ladder.t': 'Arsenal completo', 'ach.ladder.d': 'Desbloqueie as 4 mecânicas', 'ach.ladder.done': 'Você desbloqueou as 4 mecânicas',
  'welcome.title': 'Bem-vindo à Reptiloid Capital!', 'welcome.sub': 'Você é o nosso novo trader estagiário. O treinamento começa agora – a primeira rodada de prática é por nossa conta.', 'welcome.start': 'Começar o jogo →', 'welcome.skip': 'Pular',
  'ob1.1': 'Analise o gráfico do Bitcoin e tome uma decisão.',
  'ob1.2': 'Abra uma posição Long com base no gráfico e nos níveis. Feche quando achar oportuno — para realizar o lucro ou aceitar a perda.',
  'ob1.3': 'Uma posição está no lucro quando está acima do ponto de entrada; tente fechá-la no lucro máximo.',
  'ob2.1': 'No mercado dá para lucrar não só com a alta de uma posição, mas também com a queda — se você souber como.',
  'ob2.2': 'Ao abrir uma posição Long, o lucro aumenta se o valor do ativo estiver acima do ponto de entrada.',
  'ob2.3': 'Ao abrir uma posição Short, o lucro aumenta se o preço do ativo estiver abaixo do ponto de entrada.',
  'ob3.1': 'Conforme a confiança nas suas habilidades cresce, você pode agir com mais ousadia — é aí que entra a alavancagem; ela multiplica os ganhos, mas também aumenta o risco.',
  'ob3.2': 'A alavancagem permite aumentar o valor de entrada.',
  'ob3.3': 'Fique de olho nos níveis de liquidação. Se for liquidado, 50% do valor da operação será descontado.',
  'rc.next': 'Próxima rodada', 'rc.repeat': 'Repetir rodada', 'rc.unlock': 'Nova mecânica desbloqueada!', 'rc.fwbonus': 'Bônus da primeira vitória',
  'mech.short': 'Venda Short', 'mech.short.d': 'Agora você pode abrir posições Short e apostar na queda do preço',
  'mech.lev': 'Alavancagem', 'mech.lev.d': 'Agora você pode multiplicar sua entrada com alavancagem ×2–×5',
  'play': 'Jogar', 'diff.easy': 'Fácil', 'diff.medium': 'Médio', 'diff.hard': 'Difícil',
  'game.prognoz.desc': 'Adivinhe a direção da próxima vela',
  'game.sdelka.desc': 'Ciclo completo de trade, garanta seu lucro',
  'game.longshort.desc': 'Abra uma posição e feche a tempo',
  'game.plechi.desc': 'Abra uma posição com alavancagem e feche a tempo',
  'game.flappy.desc': 'Voe pelo gráfico e adivinhe a direção',
  'tab.home': 'Início', 'tab.shop': 'Loja', 'tab.referrals': 'Indicações', 'tab.achievements': 'Conquistas', 'tab.settings': 'Ajustes',
  'offer.badge': 'Oferta especial', 'offer.t': 'Pacote inicial de fichas', 'offer.d': 'Receba {0} fichas por apenas {1} e acelere seu progresso.', 'chips': 'fichas', 'shop.packs': 'Pacotes de fichas', 'bar.home': 'Início',
  'shop.title': 'Loja', 'shop.personal': 'Oferta pessoal', 'shop.endsin': 'Termina em', 'savePct': '−{0}%',
  'buy': 'Comprar', 'hot': 'Hot', 'shop.free': 'Grátis',
  'shop.invite.t': 'Convide um amigo', 'shop.invite.d': 'Ganhe fichas por cada indicação', 'invite': 'Convidar',
  'shop.video.t': 'Assistir vídeo', 'shop.video.d': 'Ganhe fichas por visualização', 'shop.video.btn': 'Assistir',
  'shop.fb.t': 'Feedback', 'shop.fb.d': 'Ganhe fichas por uma avaliação honesta', 'shop.fb.btn': 'Avaliar',
  'shop.dr.t': 'Bônus diário', 'shop.dr.d': 'Volte todo dia para um bônus maior',
  'claim': 'Resgatar', 'claimed': 'Resgatado',
  'ref.title': 'Indicações', 'ref.h2': 'Convide amigos', 'ref.sub': 'e ganhe 500 fichas por cada um',
  'ref.banner': 'Convide seu primeiro amigo e ganhe um guia de trading grátis.',
  'ref.fld': 'Digite o ID do jogador que convidou você', 'ref.ph': 'Cole o ID aqui…', 'paste': 'Colar', 'ref.your': 'Suas indicações',
  'ref.copy': 'Copiar seu ID: {0}', 'ref.invite': 'Convidar um amigo',
  'ach.title': 'Conquistas', 'ach.reward': 'Prêmio', 'newach': 'Nova conquista!', 'newach.claim': 'Resgatar prêmio',
  'ach.first.t': 'Primeiro trade', 'ach.first.d': 'Complete sua primeira rodada', 'ach.first.done': 'Você completou sua primeira rodada',
  'ach.avid.t': 'Jogador dedicado', 'ach.avid.d': 'Complete 3 rodadas', 'ach.avid.done': 'Você completou 3 rodadas',
  'ach.bigwin.t': 'Grande vitória', 'ach.bigwin.d': 'Ganhe 500+ fichas em uma rodada', 'ach.bigwin.done': 'Você ganhou 500+ fichas em uma rodada',
  'ach.daily2.t': 'Previsor diário', 'ach.daily2.d': 'Vença o desafio diário em 2 dias', 'ach.daily2.done': 'Você venceu o desafio diário em 2 dias',
  'ach.explorer.t': 'Explorador', 'ach.explorer.d': 'Jogue os 5 jogos', 'ach.explorer.done': 'Você jogou os 5 jogos',
  'ach.flappy100.t': '100 partidas no FlappyGraph', 'ach.flappy100.d': 'Complete 100 partidas', 'ach.flappy100.done': 'Você completou 100 partidas',
  'set.guides': 'Guias e lições', 'set.title': 'Ajustes', 'sub.notifications': 'Notificações', 'sub.language': 'Idioma', 'sub.music': 'Música e vibração', 'sub.style': 'Estilo',
  'sub.help': 'Ajuda e suporte', 'sub.about': 'Sobre o app', 'sub.agreements': 'Acordos', 'sub.terms': 'Termos de serviço',
  'set.logout': 'Sair', 'set.delete': 'Excluir conta',
  'subitem.dcrem': 'Lembrete do desafio diário', 'subitem.offers': 'Ofertas pessoais', 'subitem.tourn': 'Alertas de torneios',
  'subitem.music': 'Música', 'subitem.sfx': 'Efeitos sonoros', 'subitem.vibro': 'Vibração',
  'sub.help.text': 'O chat de suporte e o FAQ ainda não fazem parte do protótipo. Por enquanto, fale direto com a equipe.',
  'sub.about.text': 'Tap Trading Hub — protótipo interativo de wireframes. Feito para revisão de conceito: sem dinheiro real, sem ordens reais. Todos os saldos são fichas de jogo.',
  'sub.agreements.text': 'Espaço reservado para acordos legais. Os textos finais não fazem parte do protótipo.',
  'sub.terms.text': 'Espaço reservado para os Termos de serviço. Os textos finais não fazem parte do protótipo.',
  'sub.stub': 'Esta seção é um stub no protótipo.',
  'prof.title': 'Perfil', 'prof.edit': 'Editar', 'prof.stats': 'Estatísticas', 'prof.games': 'Partidas jogadas',
  'prof.fav': 'Jogo favorito', 'prof.best': 'Maior prêmio', 'prof.started': 'Começou a jogar',
  'prof.share': 'Compartilhar estatísticas', 'prof.savep': 'Salve seu progresso',
  'days.one': '{0} dia', 'days.many': '{0} dias',
  'guides.title': 'Guias', 'search.ph': 'Buscar', 'guides.empty': 'Nada encontrado',
  'cat.Long': 'Long', 'cat.Short': 'Short', 'cat.Psychology': 'Psicologia',
  'cat.patterns': 'Padrões gráficos',
  'pat.pullback.t': 'Pullback na tendência de alta: comprando o recuo num mercado que sobe',
  'pat.pullback.p1': 'Uma tendência de alta saudável sobe em degraus: um impulso para cima, um pequeno recuo, outro impulso. Esse recuo se chama pullback — o mercado tomando fôlego, não mudando de ideia.',
  'pat.pullback.p2': 'O trader deixa o recuo terminar: quando o gráfico para de escorregar e volta a virar para cima, essa virada é a entrada para um Long. Você compra mais barato do que quem correu atrás do topo do último impulso.',
  'pat.pullback.p3': 'O que costuma dar errado: comprar enquanto o preço ainda cai porque «já parece barato». Metade desses recuos continua caindo. Espere a virada — o pullback só é seu amigo depois que termina.',
  'pat.support.t': 'Repique no suporte: o piso que o preço insiste em respeitar',
  'pat.support.p1': 'Às vezes o preço cai várias vezes até o mesmo nível — e toda vez repica para cima. Esse nível é o suporte: um piso onde os compradores sempre aparecem.',
  'pat.support.p2': 'A jogada: quando o preço volta a um piso que já segurou duas vezes, prepare-se — e abra um Long quando o repique realmente começar. O próprio nível é a sua única razão clara para entrar.',
  'pat.support.p3': 'O que costuma dar errado: tratar o piso como garantia. Nenhum suporte segura para sempre — se o preço fica deitado no nível e para de repicar, o piso está rachando. Saia rápido em vez de torcer.',
  'pat.breakout.t': 'Rompimento da resistência: quando o teto finalmente cede',
  'pat.breakout.p1': 'Resistência é um teto: um nível que o gráfico toca várias vezes e do qual sempre escorrega de volta. Os vendedores esperam ali — até que um dia eles acabam.',
  'pat.breakout.p2': 'Quando o preço finalmente atravessa o teto e se segura acima dele, isso é um rompimento. O trader abre um Long acima do nível: o antigo teto agora funciona como piso sob a operação.',
  'pat.breakout.p3': 'O que costuma dar errado: comprar a primeira cutucada na linha. Dê um instante — se o preço não consegue ficar acima, não era rompimento, era ruído. Ou uma armadilha: veja o próximo caso.',
  'pat.fakeout.t': 'Rompimento falso: a armadilha acima do nível',
  'pat.fakeout.p1': 'O preço salta acima de um teto que todos observam, a multidão corre para comprar — e instantes depois ele cai de volta abaixo do nível, levando as fichas dos compradores. Isso é um rompimento falso, um fakeout.',
  'pat.fakeout.p2': 'Um trader calmo trata o primeiro salto como pergunta, não resposta: espere para ver se o preço se segura acima da linha. E quando ele cai de volta, a própria armadilha vira sinal — um Short depois de um rompimento fracassado costuma funcionar bem.',
  'pat.fakeout.p3': 'O que costuma dar errado: perseguir o salto na hora, com medo de ficar de fora. Perder um rompimento verdadeiro não custa nada; ficar preso num falso custa fichas de verdade. O toque mais rápido leva o pior preço.',
  'pat.panic.t': 'Queda de pânico: a recuperação em V',
  'pat.panic.p1': 'Do nada o gráfico despenca como uma pedra — uma parede de velas vermelhas em segundos. Então, com a mesma brusquidão, os compradores entram e o preço volta a subir, desenhando a letra V.',
  'pat.panic.p2': 'O ofício está em não agarrar a faca caindo. Espere a primeira vela verde forte depois do tombo — o sinal de que o pânico ficou sem vendedores — e só então pegue um Long para surfar a recuperação.',
  'pat.panic.p3': 'O que costuma dar errado: comprar no meio da queda porque «não dá para cair mais» (dá), ou abrir um Short bem no fundo, quando a queda já aconteceu. No pânico, atrasar-se alguns segundos de propósito é uma estratégia.',
  'pat.range.t': 'Lateralização: quando o melhor trade é não operar',
  'pat.range.p1': 'Às vezes o gráfico só vagueia de lado: uma vela pequena para cima, outra para baixo, nenhuma direção. Isso é um range, um mercado lateral — o mercado não consegue se decidir.',
  'pat.range.p2': 'A jogada honesta é impopular: na maior parte do tempo, não opere. Os movimentos são minúsculos, a taxa de entrada come o lucro e cada «tendência» morre em segundos. Se for operar, pegue só as bordas extremas do range — e espere pouco.',
  'pat.range.p3': 'O que costuma dar errado: o tédio. O lateral tenta você a ficar tocando só para fazer algo, e dez perdas pequenas somam uma grande. Reconhecer o lateral e sentar nas mãos é uma habilidade real de trading.',
  'art.consolidate': 'Consolide seu conhecimento nos jogos',
  'ntf.t1': 'Torneio começa em breve', 'ntf.d1': 'Participe do torneio e concorra a 1.000 fichas', 'ntf.join': 'Participar',
  'ntf.t2': 'Bônus de boas-vindas por amigo', 'ntf.d2': 'Ganhe 500 fichas pelos amigos convidados',
  'su.title': 'Criar conta', 'su.createacct': 'Criar conta', 'su.sub': 'Comece a jogar e operar agora mesmo', 'vf.verification': 'Verificação', 'vf.err': 'Código inválido. Tente novamente.', 'vf.changemail': 'Usar outro e-mail', 'su.email': 'E-mail', 'su.pass': 'Senha', 'su.or': 'Ou continue com',
  'su.login': 'Já tem conta? Entrar', 'su.legal': 'Ao continuar, você aceita os Termos e a Política de Privacidade.',
  'vf.title': 'Digite o código de verificação', 'vf.sub': 'Código de 6 dígitos enviado para', 'vf.expires': 'O código expira em {0}',
  'vf.confirm': 'Confirmar', 'vf.resend': 'Não recebeu o código? Reenviar', 'vf.enter4': 'Digite o código de 4 dígitos',
  'rc.title': 'RODADA CONCLUÍDA', 'rc.earned': 'Ganho', 'rc.balance': 'Seu saldo',
  'tile.guessed': 'Acertos', 'tile.streak': 'Melhor sequência', 'tile.mult': 'Melhor multiplicador',
  'tile.final': 'Saldo final', 'tile.fromstart': 'Desde o início', 'tile.score': 'Pontos da rodada',
  'rc.guides.t': 'Interessado no tema?', 'rc.guides.d': 'Leia nossos guias e opere com mais eficiência.',
  'rc.guides.btn': 'Ler guias', 'rc.again': 'Jogar de novo',
  'tut.skip': 'Pular tutorial', 'tut.next': 'Próximo',
  'dc.kicker': 'Desafio diário', 'dc.title': 'Vela do dia (BTC)',
  'dc.sub': 'Preveja o fechamento diário do BTC e ganhe uma recompensa',
  'dc.placed': 'Trade feito!', 'dc.comeback': 'Volte amanhã para ver o resultado e manter sua sequência.', 'done': 'Pronto',
  'dc.open': 'Abertura de hoje, 00:00 GMT', 'dc.now': 'BTC agora',
  'dc.won': 'Você venceu o dia {0}!', 'dc.winrest': 'BTC fechou {0} · +{1} fichas',
  'dc.lost': 'Não foi desta vez.', 'dc.lostrest': 'BTC fechou {0} — sequência zerada. Tente de novo hoje!',
  'higher': 'mais alto', 'lower': 'mais baixo', 'today': 'Hoje', 'dayN': 'Dia {0}',
  'dc.pick': 'Sua escolha:',
  'dc.betline.long': 'BTC fecha acima da abertura de hoje {0} (00:00 GMT)',
  'dc.betline.short': 'BTC fecha abaixo da abertura de hoje {0} (00:00 GMT)',
  'dc.betline2.long': 'BTC fecha acima da abertura das 00:00 GMT',
  'dc.betline2.short': 'BTC fecha abaixo da abertura das 00:00 GMT',
  'dc.result': 'Resultado em {0}', 'dc.stale': 'Sua aposta {0} de {1} aguarda o resultado · offline', 'offline': 'offline',
  'np.title': 'Quer prever como o dia vai fechar no desafio diário?', 'np.sub': 'Permita as notificações',
  'np.allow': 'Permitir', 'np.deny': 'Recusar', 'np.predict': 'Fazer previsão', 'close': 'Fechar',
  'sp.have': 'Você tem', 'sp.days': 'e {0} de vitórias no desafio diário', 'sp.register': 'Registrar',
  'ooc.title': 'Sem fichas', 'ooc.tomorrow': 'Ou volte amanhã para o bônus diário',
  'dr.todays': 'Recompensa de hoje', 'dr.claim': 'Resgatar bônus', 'dr.claimed': 'Resgatado ✓',
  'lo.title': 'Sair da conta?', 'lo.sub': 'Tem certeza de que quer sair da sua conta?', 'cancel': 'Cancelar',
  'gp.title': 'Interessado neste tipo de trading?', 'gp.sub': 'Confira nossos guias sobre o tema',
  'del.title': 'Excluir conta?', 'del.text': 'Esta ação é permanente e não pode ser desfeita. Todos os seus dados, conquistas e histórico serão perdidos.',
  'fw.title': 'Parabéns pelo seu primeiro trade de sucesso', 'fw.earned': 'Você ganhou', 'fw.continue': 'Continuar jogando',
  't.stub': 'Ainda não está no protótipo', 't.fee': 'Taxa de entrada −{0}', 't.feeback': 'Rodada de treino — taxa devolvida +{0}', 't.coins': 'Moedas {0}% → {1} fichas',
  't.traderes': 'Resultado do trade {0} → {1} fichas', 't.dailywon': 'Desafio diário vencido · +{0} fichas',
  't.placed': '{0} feito · resultado às 00:00 GMT', 't.dreward': 'Bônus diário +{0} fichas',
  't.achreward': 'Prêmio de “{0}” +{1} fichas', 't.video': 'Vídeo assistido · +{0} fichas',
  't.nopurch': 'Compras não estão no protótipo', 't.pasted': 'Colado', 't.clipempty': 'Área de transferência vazia',
  't.clipna': 'Área de transferência indisponível — digite o ID', 't.idcopied': 'Seu ID foi copiado', 't.yourid': 'Seu ID: {0}',
  't.invitecopied': 'Link de convite copiado (protótipo)', 't.logoutstub': 'Sair é só visual no protótipo',
  't.progsaved': 'Progresso salvo', 't.progalready': 'Progresso já salvo',
  't.tournstub': 'Torneios ainda não estão no protótipo', 't.statscopied': 'Estatísticas copiadas',
  't.stats': 'Estatísticas: {0}', 't.sharestats': 'Minhas estatísticas do Tap Trading: {0} partidas, maior prêmio {1} fichas, favorito — {2}.',
},
ar: {
  'game.trade.desc': 'اشترِ وبِع البيتكوين على الرسم البياني المباشر',
  'home.stage': 'المرحلة {0} من {1}', 'home.next': 'الفتح التالي: {0}', 'home.max': 'كل الآليات مفتوحة',
  'stage.1': 'شراء وبيع', 'stage.2': 'شورت', 'stage.3': 'رافعة ×2–×5', 'stage.4': 'صفقات جزئية',
  'prof.intents': 'نوايا الشراء',
  'peak.title': 'أنت في أوج حماسك!', 'peak.sub': 'ارتقِ فعلاً — اختر خطوتك التالية',
  'peak.course': 'دورة تداول العملات الرقمية', 'peak.course.d': 'أساسيات منظمة، من الصفر إلى النظام',
  'peak.academy': 'Binance Academy', 'peak.academy.d': 'دروس مجانية من الشريك',
  'peak.prop': 'تحديات البروب تريدنغ', 'peak.prop.d': 'تداول بحساب ممول',
  'peak.later': 'ليس الآن', 't.peaklogged': 'سُجّل الاختيار (نموذج أولي)',
  'stub.pay': 'ادفع', 'stub.processing': 'جارٍ معالجة الدفع…', 'stub.notify': 'سنخبرك عند الانتهاء',
  'stub.redirect': 'جارٍ التحويل إلى الشريك… (نموذج أولي)',
  'stub.item.chips': '{0} رقاقة', 'stub.item.prop': 'تحدي البروب تريدنغ: جولة التصفيات',
  'stub.item.refcourse': 'دورة Long/Short معمّقة من خبير',
  'tiers.sub': 'اختر مستواك',
  'tiers.basic.d': 'الرسوم البيانية والأوامر وأولى الصفقات', 'tiers.pro.d': 'الاستراتيجيات والرافعة وإدارة المخاطر',
  'tiers.expert.d': 'نظام متقدم وملاحظات الخبير',
  'ref.course.t': 'دورة خبير مجانية',
  'ref.course.d': 'أول صديق لك يقوم بعملية شراء يفتح لك مجانًا دورة Long/Short معمّقة من خبير',
  'tasks.title': 'مهام تطبيقية', 'tasks.sub': 'العب فحسب — العلامات تُضاء تلقائيًا',
  'tasks.1': 'أغلق صفقة بربح', 'tasks.2': 'أنهِ جولة دون تصفية', 'tasks.3': 'استخدم خروجًا جزئيًا بنسبة 50%',
  'ach.shorts.t': 'بائع على المكشوف', 'ach.shorts.d': 'افتح الشورت (المرحلة 2)', 'ach.shorts.done': 'فتحت الشورت',
  'ach.ladder.t': 'الترسانة الكاملة', 'ach.ladder.d': 'افتح الآليات الأربع كلها', 'ach.ladder.done': 'فتحت الآليات الأربع كلها',
  'welcome.title': 'مرحبًا بك في Reptiloid Capital!', 'welcome.sub': 'أنت متداولنا المتدرب الجديد. يبدأ التدريب الآن – الجولة التدريبية الأولى على حسابنا.', 'welcome.start': 'ابدأ اللعبة →', 'welcome.skip': 'تخطّي',
  'ob1.1': 'حلّل مخطط البيتكوين واتخذ قرارًا.',
  'ob1.2': 'افتح صفقة Long بناءً على المخطط والمستويات. أغلقها عندما ترى ذلك مناسبًا — لجني الربح أو تقبّل الخسارة.',
  'ob1.3': 'تكون الصفقة رابحة عندما تكون فوق نقطة الدخول؛ حاول إغلاقها عند أقصى ربح.',
  'ob2.1': 'في السوق يمكنك الربح ليس فقط من ارتفاع قيمة الصفقة بل ومن انخفاضها أيضًا — إذا كنت تعرف الطريقة.',
  'ob2.2': 'عند فتح صفقة Long يزداد الربح إذا كانت قيمة الأصل فوق نقطة الدخول.',
  'ob2.3': 'عند فتح صفقة Short يزداد الربح إذا كان سعر الأصل تحت نقطة الدخول.',
  'ob3.1': 'مع نمو ثقتك بمهاراتك يمكنك التصرف بجرأة أكبر — وهنا يأتي دور الرافعة المالية؛ فهي تضاعف الأرباح لكنها تزيد المخاطر أيضًا.',
  'ob3.2': 'تتيح لك الرافعة المالية زيادة مبلغ الدخول.',
  'ob3.3': 'راقب مستويات التصفية. إذا تمت تصفيتك فسيُخصم 50% من مبلغ الصفقة.',
  'rc.next': 'الجولة التالية', 'rc.repeat': 'إعادة الجولة', 'rc.unlock': 'فُتحت آلية جديدة!', 'rc.fwbonus': 'مكافأة الفوز الأول',
  'mech.short': 'بيع Short', 'mech.short.d': 'يمكنك الآن فتح صفقات Short والمراهنة على هبوط السعر',
  'mech.lev': 'الرافعة المالية', 'mech.lev.d': 'يمكنك الآن مضاعفة دخولك برافعة ×2–×5',
  'play': 'العب', 'diff.easy': 'سهل', 'diff.medium': 'متوسط', 'diff.hard': 'صعب',
  'game.prognoz.desc': 'خمّن اتجاه الشمعة التالية',
  'game.sdelka.desc': 'دورة تداول كاملة، خذ ربحك',
  'game.longshort.desc': 'افتح صفقة وأغلقها في الوقت المناسب',
  'game.plechi.desc': 'افتح صفقة برافعة مالية وأغلقها في الوقت المناسب',
  'game.flappy.desc': 'حلّق مع الرسم البياني وخمّن اتجاهه',
  'tab.home': 'الرئيسية', 'tab.shop': 'المتجر', 'tab.referrals': 'الدعوات', 'tab.achievements': 'الإنجازات', 'tab.settings': 'الإعدادات',
  'offer.badge': 'عرض خاص', 'offer.t': 'حزمة الرقائق الأولى', 'offer.d': 'احصل على {0} رقاقة مقابل {1} فقط وسرّع تقدمك.', 'chips': 'رقاقة', 'shop.packs': 'حزم الرقائق', 'bar.home': 'الرئيسية',
  'shop.title': 'المتجر', 'shop.personal': 'عرض خاص', 'shop.endsin': 'ينتهي خلال', 'savePct': 'وفّر {0}%',
  'buy': 'شراء', 'hot': 'Hot', 'shop.free': 'مجاني',
  'shop.invite.t': 'ادعُ صديقًا', 'shop.invite.d': 'احصل على رقائق عن كل دعوة', 'invite': 'دعوة',
  'shop.video.t': 'شاهد فيديو', 'shop.video.d': 'اربح رقائق عن كل مشاهدة', 'shop.video.btn': 'مشاهدة',
  'shop.fb.t': 'رأيك', 'shop.fb.d': 'احصل على رقائق مقابل تقييم صادق', 'shop.fb.btn': 'اكتب تقييمًا',
  'shop.dr.t': 'المكافأة اليومية', 'shop.dr.d': 'عُد كل يوم لمكافأة أكبر',
  'claim': 'استلام', 'claimed': 'تم الاستلام',
  'ref.title': 'الدعوات', 'ref.h2': 'ادعُ أصدقاءك', 'ref.sub': 'واحصل على 500 رقاقة عن كل صديق',
  'ref.banner': 'ادعُ صديقك الأول واحصل على دليل تداول مجاني.',
  'ref.fld': 'أدخل معرّف اللاعب الذي دعاك', 'ref.ph': 'الصق المعرّف هنا…', 'paste': 'لصق', 'ref.your': 'دعواتك',
  'ref.copy': 'انسخ معرّفك: {0}', 'ref.invite': 'ادعُ صديقًا',
  'ach.title': 'الإنجازات', 'ach.reward': 'الجائزة', 'newach': 'إنجاز جديد!', 'newach.claim': 'استلام الجائزة',
  'ach.first.t': 'أول صفقة', 'ach.first.d': 'أكمل جولتك الأولى', 'ach.first.done': 'أكملت جولتك الأولى',
  'ach.avid.t': 'لاعب نشيط', 'ach.avid.d': 'أكمل 3 جولات', 'ach.avid.done': 'أكملت 3 جولات',
  'ach.bigwin.t': 'فوز كبير', 'ach.bigwin.d': 'اربح 500+ رقاقة في جولة واحدة', 'ach.bigwin.done': 'ربحت 500+ رقاقة في جولة واحدة',
  'ach.daily2.t': 'متنبئ يومي', 'ach.daily2.d': 'افز بالتحدي اليومي في يومين', 'ach.daily2.done': 'فزت بالتحدي اليومي في يومين',
  'ach.explorer.t': 'مستكشف', 'ach.explorer.d': 'العب الألعاب الخمس كلها', 'ach.explorer.done': 'لعبت الألعاب الخمس كلها',
  'ach.flappy100.t': '100 لعبة في FlappyGraph', 'ach.flappy100.d': 'أكمل 100 لعبة', 'ach.flappy100.done': 'أكملت 100 لعبة',
  'set.guides': 'الأدلة والدروس', 'set.title': 'الإعدادات', 'sub.notifications': 'الإشعارات', 'sub.language': 'اللغة', 'sub.music': 'الموسيقى والاهتزاز', 'sub.style': 'النمط',
  'sub.help': 'المساعدة والدعم', 'sub.about': 'عن التطبيق', 'sub.agreements': 'الاتفاقيات', 'sub.terms': 'شروط الخدمة',
  'set.logout': 'تسجيل الخروج', 'set.delete': 'حذف الحساب',
  'subitem.dcrem': 'تذكير التحدي اليومي', 'subitem.offers': 'عروض خاصة', 'subitem.tourn': 'تنبيهات البطولات',
  'subitem.music': 'الموسيقى', 'subitem.sfx': 'المؤثرات الصوتية', 'subitem.vibro': 'الاهتزاز',
  'sub.help.text': 'دردشة الدعم والأسئلة الشائعة ليست جزءًا من النموذج الأولي بعد. حاليًا تواصل مع الفريق مباشرة.',
  'sub.about.text': 'Tap Trading Hub — نموذج أولي تفاعلي. لمراجعة الفكرة: لا أموال حقيقية ولا أوامر حقيقية. كل الأرصدة رقائق لعب.',
  'sub.agreements.text': 'عنصر نائب للاتفاقيات القانونية. النصوص النهائية ليست جزءًا من النموذج الأولي.',
  'sub.terms.text': 'عنصر نائب لشروط الخدمة. النصوص النهائية ليست جزءًا من النموذج الأولي.',
  'sub.stub': 'هذا القسم مجرد نموذج مبدئي.',
  'prof.title': 'الملف الشخصي', 'prof.edit': 'تعديل', 'prof.stats': 'الإحصائيات', 'prof.games': 'الجولات الملعوبة',
  'prof.fav': 'اللعبة المفضلة', 'prof.best': 'أفضل ربح', 'prof.started': 'بدأ اللعب',
  'prof.share': 'مشاركة الإحصائيات', 'prof.savep': 'احفظ تقدمك',
  'days.one': '{0} يوم', 'days.many': '{0} أيام',
  'guides.title': 'الأدلة', 'search.ph': 'بحث', 'guides.empty': 'لا نتائج',
  'cat.Long': 'Long', 'cat.Short': 'Short', 'cat.Psychology': 'علم النفس',
  'cat.patterns': 'أنماط الرسم البياني',
  'pat.pullback.t': 'التراجع في الاتجاه الصاعد: شراء الانخفاض في سوق يرتفع',
  'pat.pullback.p1': 'الاتجاه الصاعد السليم يتسلق على شكل درجات: دفعة إلى الأعلى، انزلاق صغير إلى الخلف، ثم دفعة جديدة. هذا الانزلاق الصغير يسمى التراجع (pullback) — السوق يلتقط أنفاسه، لا يغيّر رأيه.',
  'pat.pullback.p2': 'المتداول يترك الانزلاق ينتهي: عندما يتوقف الرسم البياني عن الهبوط ويعود للاتجاه صعودًا، يكون هذا الانعطاف هو نقطة الدخول في Long. تشتري أرخص ممن طاردوا قمة الدفعة الأخيرة.',
  'pat.pullback.p3': 'الخطأ الشائع: الشراء بينما السعر ما زال يهبط لأنه «يبدو رخيصًا الآن». نصف هذه التراجعات تواصل الهبوط. انتظر الانعطاف — التراجع لا يصبح صديقك إلا بعد أن ينتهي.',
  'pat.support.t': 'الارتداد من الدعم: الأرضية التي يحترمها السعر مرارًا',
  'pat.support.p1': 'أحيانًا يهبط السعر مرة بعد مرة إلى المستوى نفسه — ويرتد صعودًا في كل مرة. هذا المستوى هو الدعم: أرضية يظهر عندها المشترون دائمًا.',
  'pat.support.p2': 'الخطة: عندما يعود السعر إلى أرضية صمدت مرتين من قبل، استعد — وافتح Long عندما يبدأ الارتداد فعلًا. المستوى نفسه هو سببك الواضح الوحيد للدخول.',
  'pat.support.p3': 'الخطأ الشائع: اعتبار الأرضية ضمانًا. لا يوجد دعم يصمد إلى الأبد — إذا استلقى السعر على المستوى وتوقف عن الارتداد، فالأرضية تتشقق. اخرج بسرعة بدل أن تأمل.',
  'pat.breakout.t': 'اختراق المقاومة: عندما يستسلم السقف أخيرًا',
  'pat.breakout.p1': 'المقاومة سقف: مستوى يلمسه الرسم البياني عدة مرات وينزلق عنه إلى الأسفل في كل مرة. هناك ينتظر البائعون — إلى أن ينفدوا يومًا ما.',
  'pat.breakout.p2': 'عندما يخترق السعر السقف أخيرًا ويثبت فوقه، فهذا اختراق. يفتح المتداول Long فوق المستوى: السقف القديم يعمل الآن كأرضية تحت الصفقة.',
  'pat.breakout.p3': 'الخطأ الشائع: الشراء عند أول وخزة للخط. أمهله لحظة — إذا لم يستطع السعر البقاء في الأعلى، لم يكن اختراقًا بل ضجيجًا. أو فخًا: انظر الحالة التالية.',
  'pat.fakeout.t': 'الاختراق الكاذب: الفخ فوق المستوى',
  'pat.fakeout.p1': 'يقفز السعر فوق سقف يراقبه الجميع، فيندفع الناس للشراء — وبعد لحظات يسقط عائدًا تحت المستوى، آخذًا معه رقاقات المشترين. هذا هو الاختراق الكاذب (fakeout).',
  'pat.fakeout.p2': 'المتداول الهادئ يتعامل مع القفزة الأولى كسؤال لا كجواب: انتظر لترى هل يثبت السعر فوق الخط. وعندما يسقط عائدًا، يتحول الفخ نفسه إلى إشارة — Short بعد اختراق فاشل ينجح غالبًا.',
  'pat.fakeout.p3': 'الخطأ الشائع: مطاردة القفزة فورًا خوفًا من تفويت الفرصة. تفويت اختراق حقيقي لا يكلفك شيئًا؛ أما الوقوع في اختراق كاذب فيكلفك رقاقات حقيقية. أسرع نقرة تحصل على أسوأ سعر.',
  'pat.panic.t': 'هبوط الذعر: التعافي على شكل V',
  'pat.panic.p1': 'من العدم يسقط الرسم البياني كالحجر — جدار من الشموع الحمراء في ثوانٍ. ثم يدخل المشترون بالفجائية نفسها، فيتسلق السعر عائدًا راسمًا حرف V.',
  'pat.panic.p2': 'الحرفة هي ألا تمسك السكين الهابطة. انتظر أول شمعة خضراء قوية بعد السقوط — علامة أن الذعر استنفد بائعيه — وعندها فقط خذ Long لتركب موجة التعافي.',
  'pat.panic.p3': 'الخطآن الشائعان: الشراء في منتصف السقوط لأنه «لا يمكن أن يهبط أكثر» (بل يمكن)، وفتح Short في القاع نفسه بعد أن حدث السقوط فعلًا. في الذعر، التأخر بضع ثوانٍ عمدًا استراتيجية.',
  'pat.range.t': 'النطاق العرضي: عندما تكون أفضل صفقة هي عدم التداول',
  'pat.range.p1': 'أحيانًا يتجول الرسم البياني جانبيًا فحسب: شمعة صغيرة صعودًا، وأخرى هبوطًا، بلا اتجاه. هذا هو النطاق العرضي — السوق عاجز عن اتخاذ قرار.',
  'pat.range.p2': 'الخطة الصادقة هنا غير محبوبة: في الغالب، لا تتداوله. الحركات ضئيلة فتأكل رسوم الدخول الربح، وكل «اتجاه» يموت في ثوانٍ. إن تداولت رغم ذلك، فخذ أطراف النطاق القصوى فقط — ولا تتوقع الكثير.',
  'pat.range.p3': 'الخطأ الشائع: الملل. السوق العرضي يغريك بالنقر لمجرد فعل شيء، وعشر خسائر صغيرة تساوي خسارة كبيرة. تمييز السوق العرضي وإبقاء يديك بعيدًا مهارة تداول حقيقية.',
  'art.consolidate': 'رسّخ معلوماتك في الألعاب',
  'ntf.t1': 'البطولة تبدأ قريبًا', 'ntf.d1': 'انضم إلى البطولة واربح فرصة 1,000 رقاقة', 'ntf.join': 'انضمام',
  'ntf.t2': 'مكافأة ترحيب عن صديق', 'ntf.d2': 'احصل على 500 رقاقة عن الأصدقاء المدعوين',
  'su.title': 'إنشاء حساب', 'su.createacct': 'إنشاء حساب', 'su.sub': 'ابدأ اللعب والتداول الآن', 'vf.verification': 'التحقق', 'vf.err': 'رمز غير صالح. حاول مجددًا.', 'vf.changemail': 'استخدام بريد آخر', 'su.email': 'البريد الإلكتروني', 'su.pass': 'كلمة المرور', 'su.or': 'أو تابع عبر',
  'su.login': 'لديك حساب؟ تسجيل الدخول', 'su.legal': 'بالمتابعة أنت توافق على الشروط وسياسة الخصوصية.',
  'vf.title': 'أدخل رمز التحقق', 'vf.sub': 'أُرسل رمز من 6 أرقام إلى', 'vf.expires': 'ينتهي الرمز خلال {0}',
  'vf.confirm': 'تأكيد', 'vf.resend': 'لم يصلك الرمز؟ إعادة إرسال', 'vf.enter4': 'أدخل الرمز المكوّن من 4 أرقام',
  'rc.title': 'انتهت الجولة', 'rc.earned': 'الربح', 'rc.balance': 'رصيدك',
  'tile.guessed': 'تخمينات صحيحة', 'tile.streak': 'أفضل سلسلة', 'tile.mult': 'أفضل مضاعف',
  'tile.final': 'الرصيد النهائي', 'tile.fromstart': 'منذ البداية', 'tile.score': 'نقاط الجولة',
  'rc.guides.t': 'مهتم بهذا الموضوع؟', 'rc.guides.d': 'اطّلع على أدلتنا وتداول بفعالية أكبر.',
  'rc.guides.btn': 'اقرأ الأدلة', 'rc.again': 'العب مجددًا',
  'tut.skip': 'تخطَّ الشرح', 'tut.next': 'التالي',
  'dc.kicker': 'التحدي اليومي', 'dc.title': 'شمعة اليوم (BTC)',
  'dc.sub': 'تنبأ بإغلاق BTC اليومي واربح مكافأة',
  'dc.placed': 'تم فتح الصفقة!', 'dc.comeback': 'عُد غدًا لرؤية النتيجة وحافظ على سلسلتك.', 'done': 'تم',
  'dc.open': 'افتتاح اليوم، 00:00 GMT', 'dc.now': 'BTC الآن',
  'dc.won': 'فزت باليوم {0}!', 'dc.winrest': 'أغلق BTC {0} · +{1} رقاقة',
  'dc.lost': 'ليس هذه المرة.', 'dc.lostrest': 'أغلق BTC {0} — تم تصفير السلسلة. جرّب اليوم مجددًا!',
  'higher': 'أعلى', 'lower': 'أدنى', 'today': 'اليوم', 'dayN': 'يوم {0}',
  'dc.pick': 'اختيارك:',
  'dc.betline.long': 'يغلق BTC أعلى من افتتاح اليوم {0} (00:00 GMT)',
  'dc.betline.short': 'يغلق BTC أدنى من افتتاح اليوم {0} (00:00 GMT)',
  'dc.betline2.long': 'يغلق BTC أعلى من افتتاح 00:00 GMT',
  'dc.betline2.short': 'يغلق BTC أدنى من افتتاح 00:00 GMT',
  'dc.result': 'النتيجة خلال {0}', 'dc.stale': 'رهانك {0} بتاريخ {1} بانتظار النتيجة · أوفلاين', 'offline': 'أوفلاين',
  'np.title': 'هل تريد توقّع إغلاق اليوم في التحدي اليومي؟', 'np.sub': 'اسمح بالإشعارات',
  'np.allow': 'سماح', 'np.deny': 'رفض', 'np.predict': 'قدّم توقعًا', 'close': 'إغلاق',
  'sp.have': 'لديك', 'sp.days': 'و{0} من الانتصارات في التحدي اليومي', 'sp.register': 'تسجيل',
  'ooc.title': 'نفدت الرقائق', 'ooc.tomorrow': 'أو عُد غدًا للمكافأة اليومية',
  'dr.todays': 'مكافأة اليوم', 'dr.claim': 'استلام المكافأة', 'dr.claimed': 'تم الاستلام ✓',
  'lo.title': 'تسجيل الخروج؟', 'lo.sub': 'هل أنت متأكد أنك تريد تسجيل الخروج؟', 'cancel': 'إلغاء',
  'gp.title': 'مهتم بهذا النوع من التداول؟', 'gp.sub': 'اطّلع على أدلتنا حول الموضوع',
  'del.title': 'حذف الحساب؟', 'del.text': 'هذا الإجراء نهائي ولا يمكن التراجع عنه. ستفقد كل بياناتك وإنجازاتك وسجلك.',
  'fw.title': 'تهانينا على أول صفقة ناجحة', 'fw.earned': 'ربحت', 'fw.continue': 'واصل اللعب',
  't.stub': 'ليست في النموذج الأولي بعد', 't.fee': 'رسم الدخول −{0}', 't.feeback': 'جولة تدريب — تم ردّ رسم الدخول +{0}', 't.coins': 'العملات {0}% → {1} رقاقة',
  't.traderes': 'نتيجة التداول {0} → {1} رقاقة', 't.dailywon': 'فزت بالتحدي اليومي · +{0} رقاقة',
  't.placed': 'تم فتح {0} · النتيجة عند 00:00 GMT', 't.dreward': 'المكافأة اليومية +{0} رقاقة',
  't.achreward': 'جائزة «{0}» +{1} رقاقة', 't.video': 'تمت مشاهدة الفيديو · +{0} رقاقة',
  't.nopurch': 'الشراء غير متاح في النموذج الأولي', 't.pasted': 'تم اللصق', 't.clipempty': 'الحافظة فارغة',
  't.clipna': 'الحافظة غير متاحة — اكتب المعرّف', 't.idcopied': 'تم نسخ معرّفك', 't.yourid': 'معرّفك: {0}',
  't.invitecopied': 'تم نسخ رابط الدعوة (نموذج أولي)', 't.logoutstub': 'تسجيل الخروج شكلي فقط في النموذج الأولي',
  't.progsaved': 'تم حفظ التقدم', 't.progalready': 'التقدم محفوظ بالفعل',
  't.tournstub': 'البطولات ليست في النموذج الأولي بعد', 't.statscopied': 'تم نسخ الإحصائيات',
  't.stats': 'الإحصائيات: {0}', 't.sharestats': 'إحصائياتي في Tap Trading: {0} جولة، أفضل ربح {1} رقاقة، المفضلة — {2}.',
},
};

/* t('key', a, b) — lookup in the current language with EN fallback; {0}/{1} args */
function t(key) {
  const d = I18N[LANG] || I18N.en;
  let s = (key in d) ? d[key] : I18N.en[key];
  if (s === undefined) s = key;
  for (let i = 1; i < arguments.length; i++) s = s.split('{' + (i - 1) + '}').join(arguments[i]);
  return s;
}
const tDays = n => t(n === 1 ? 'days.one' : 'days.many', n);

/* Static texts: [data-i18n] → textContent, [data-i18n-ph] → placeholder.
   Called on boot and on every language pick (live switch, no reload). */
function applyLang() {
  LANG = LANGS[S.lang] || 'en';
  document.documentElement.lang = LANG;
  $$('[data-i18n]').forEach(el => {
    const a = el.dataset.i18nArg;
    el.textContent = a === undefined ? t(el.dataset.i18n) : t(el.dataset.i18n, ...a.split('|'));
  });
  $$('[data-i18n-ph]').forEach(el => { el.placeholder = t(el.dataset.i18nPh); });
  // editorial settings: language row shows the current endonym (mockup B); endonyms are not translated
  const lv = document.getElementById('langVal');
  if (lv && typeof SUBS === 'object') lv.textContent = (SUBS['Language'].items[S.lang]) || 'English';
  if (typeof renderTopbar === 'function' && typeof curScreen === 'string') renderTopbar();
}

/* ---------- registries ----------
   webv1 (решение встречи 24.07): ОДНА игра «Trade» (лестница механик внутри неё).
   Старые пять игр АРХИВ: папки games/(sdelka|longshort|plechi|prognoz|flappy)
   остаются на диске, но точек входа из UI больше нет. */
const GAMES = {
  trade: { name: 'Trade', descKey: 'game.trade.desc' },
};
// имена архивных игр — для статистики старых сейвов (favorite game и т.п.)
const LEGACY_NAMES = {
  prognoz: 'Prediction', longshort: 'Long/Short', plechi: 'Leverage',
  sdelka: 'Trade', flappy: 'Flappy Graph',
};

/* Round Complete tiles: read the game's own result screen (same-origin, read-only). */
const TILE_EXTRACT = {
  trade: [['tile.score', '#resScore'], ['tile.fromstart', '#resMult']],
};

/* лестница механик игры Trade: стадия из trade.progress (пишет игра, same-origin) */
const TRADE_MAX_STAGE = 4;
function tradeProgress() {
  try { return JSON.parse(localStorage.getItem('trade.progress') || '{}') || {}; } catch (e) { return {}; }
}
function tradeStage() {
  const s = +tradeProgress().stage || 1;
  return Math.min(TRADE_MAX_STAGE, Math.max(1, s));
}

/* ★ draft 30.07 — Chart patterns: инлайн-SVG-скетчи мини-графиков (~340×140).
   Цвета ТОЛЬКО из скин-токенов: нейтральная линия/уровни = currentColor
   (контейнер .art-chart красит в var(--tx-soft)), акценты = var(--green)/var(--red)
   через style (var() в презентационных атрибутах SVG не работает). */
const PAT_W = 'stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"';
const PAT_LVL = 'stroke="currentColor" stroke-width="1.5" stroke-dasharray="6 5" opacity=".45"';
const PAT_SVG = {
  pullback:
    `<svg viewBox="0 0 340 140" fill="none" aria-hidden="true">
      <path d="M10 122 L52 84" stroke="currentColor" ${PAT_W}/>
      <path d="M52 84 L76 97" style="stroke:var(--red)" ${PAT_W}/>
      <path d="M76 97 L138 60" stroke="currentColor" ${PAT_W}/>
      <path d="M138 60 L162 74" style="stroke:var(--red)" ${PAT_W}/>
      <path d="M162 74 L230 40 L256 50 L330 18" style="stroke:var(--green)" ${PAT_W}/>
      <circle cx="162" cy="74" r="5" style="fill:var(--green)"/>
    </svg>`,
  support:
    `<svg viewBox="0 0 340 140" fill="none" aria-hidden="true">
      <path d="M10 106 H330" ${PAT_LVL}/>
      <path d="M10 34 L58 103 L92 64 L136 103 L170 68 L212 103" stroke="currentColor" ${PAT_W}/>
      <path d="M212 103 L262 56 L330 30" style="stroke:var(--green)" ${PAT_W}/>
      <circle cx="212" cy="103" r="5" style="fill:var(--green)"/>
    </svg>`,
  breakout:
    `<svg viewBox="0 0 340 140" fill="none" aria-hidden="true">
      <path d="M10 62 H330" ${PAT_LVL}/>
      <path d="M10 118 L46 66 L76 98 L106 64 L134 94 L168 66" stroke="currentColor" ${PAT_W}/>
      <path d="M168 66 L196 46 L224 56 L254 32 L330 18" style="stroke:var(--green)" ${PAT_W}/>
      <circle cx="196" cy="46" r="5" style="fill:var(--green)"/>
    </svg>`,
  fakeout:
    `<svg viewBox="0 0 340 140" fill="none" aria-hidden="true">
      <path d="M10 58 H330" ${PAT_LVL}/>
      <path d="M10 114 L52 62 L82 90 L118 61 L146 86 L180 38" stroke="currentColor" ${PAT_W}/>
      <path d="M180 38 L206 78 L234 110 L268 98 L330 118" style="stroke:var(--red)" ${PAT_W}/>
      <circle cx="206" cy="78" r="5" style="fill:var(--red)"/>
    </svg>`,
  panic:
    `<svg viewBox="0 0 340 140" fill="none" aria-hidden="true">
      <path d="M10 38 L64 44" stroke="currentColor" ${PAT_W}/>
      <path d="M64 44 L96 86 L118 118" style="stroke:var(--red)" ${PAT_W}/>
      <path d="M118 118 L152 74 L172 84 L208 46 L250 38 L330 26" style="stroke:var(--green)" ${PAT_W}/>
      <circle cx="152" cy="74" r="5" style="fill:var(--green)"/>
    </svg>`,
  range:
    `<svg viewBox="0 0 340 140" fill="none" aria-hidden="true">
      <path d="M10 44 H330" ${PAT_LVL}/>
      <path d="M10 102 H330" ${PAT_LVL}/>
      <path d="M10 74 L34 50 L58 96 L82 54 L106 98 L130 52 L154 92 L178 58 L202 96 L226 50 L250 90 L274 56 L298 94 L330 72" stroke="currentColor" ${PAT_W}/>
    </svg>`,
};

/* Гайды: реальные мини-уроки (директива владельца 24.07). body — абзацы статьи,
   первый абзац рендерится лидом. Порядок: стартовая статья про лонг — первой
   (естественное «почитать после туториала», онбординг теперь на Long/Short).
   ★ draft 30.07 — кейсы категории patterns: у них title/body живут в I18N
   (g.key → 'pat.*.t' / 'pat.*.p1..p3', ×8 языков) + g.svg — инлайн-скетч паттерна. */
const GUIDES = [
  { cat: 'Long', title: 'Choosing an asset for a long position: what to look for before entering',
    body: [
      'A long is the simplest trade there is: you expect the price to go up, so you enter first and close later — the difference is yours.',
      'Before you enter, look at where the price has already been. A chart that climbs calmly with small pullbacks is friendlier for a long than one that just shot straight up — vertical spikes love to cool off right after.',
      'Check how nervous the asset is. Big wild candles mean big wins and big losses; smooth candles mean slower but steadier moves. In a Long/Short round you can feel this in seconds — watch the chart breathe before you tap.',
      'Give your entry one clear reason. “It fell a lot” is not a plan; “it bounced off the same level twice” is. One good reason beats five vague ones.',
      'And decide in advance where you are wrong — the point at which you close and move on. If you decide it after entering, emotions will decide it for you.',
      'Practice in the Long/Short game: open a long only when you can say the reason out loud. Your balance will feel the difference quickly.',
    ] },
  { cat: 'Long', title: 'Long as a life strategy: Why patient players are more likely to win Gold in leagues',
    body: [
      'Markets spend most of their time grinding slowly upward — and patient players are the ones who collect that grind.',
      'Impatient trading means paying for every extra move: each entry costs a fee, and each hasty exit gives away part of a trend that was just getting started. Patient players simply make fewer, better trades.',
      'In league terms: the leaderboard is a marathon. One lucky rocket trade feels great, but Gold usually goes to the player whose balance grows a little every day — dailies claimed, streak alive, no all-in disasters.',
      'A practical habit: when your long is in profit and the trend is intact, let it work. Closing a winner two seconds after it turns green is the most expensive reflex in trading.',
      'Try it tonight: one Long/Short round where you hold the winning position until the timer, not until your first flinch. Compare the result with your usual style.',
    ] },
  { cat: 'Short', title: 'Shorting as Rocket Fuel: Outperforming Half the League in a Falling Market',
    body: [
      'A short is a bet that the price will go down: you sell first, buy back cheaper, and keep the difference.',
      'Why bother? Because markets fall faster than they rise. Fear is a stronger fuel than hope — a drop often covers in minutes the distance a rally crawled in hours.',
      'That is exactly why shorts feel like rocket fuel in the league: while half the players sit and wait for the market to “come back”, a good short is earning on the way down.',
      'The craft is in the entry: the best shorts come after the market has clearly broken down and every bounce looks weaker than the last. Chasing the very bottom of a panic candle is how shorts get burned.',
      'In the Long/Short and Leverage games the falling rounds are your free training ground — tap Short on a weak bounce and watch how much faster red candles pay.',
    ] },
  { cat: 'Short', title: 'Panic in the general club is your chance: we catch the best spots for a short while everyone is shouting “everything is lost”',
    body: [
      'When the whole chat is shouting “everything is lost”, most players freeze. That is usually the moment a calm short earns the most.',
      'Panic moves in waves: a sharp drop, a nervous bounce, another drop. The bounce is the gift — it lets you enter a short at a better price while the crowd hopes the worst is over.',
      'Watch the bounces closely: if each one is smaller and dies faster than the last, sellers are still in charge and the road down is likely not finished.',
      'Keep your size honest. Panic candles are huge in both directions — a short taken in panic mode with your whole balance is just panic pointed the other way.',
      'Next time a round turns into a waterfall, don’t close your eyes. Wait for the weak bounce, tap Short, and let the crowd’s fear pay your streak.',
    ] },
  { cat: 'Short', title: '60-Second Duel: Why Short is the King of Speed Battles and How to Use It',
    body: [
      'In a 60-second round you don’t have time for a slow, polite trend. You need moves that happen NOW — and drops are the fastest moves in any market.',
      'Up-moves need buyers to keep agreeing on higher prices; down-moves only need a moment of doubt. That asymmetry makes the short a natural weapon for speed battles.',
      'The play: don’t predict the fall — recognize it. The first strong red candle after a tired, flattening rise is worth more than ten guesses about the top.',
      'Exits win duels. In a minute-long round a profit that melts back is a loss with extra steps: when the drop pauses and the candle shrinks, lock it in.',
      'Drill it in the Long/Short game: one round where you only trade shorts, entering on weakness and closing on the first stall. It rewires your reflexes fast.',
    ] },
  { cat: 'Psychology', title: 'Greed vs. Fear: Who’s Really Driving Your Trades at the League’s Biggest Moment',
    body: [
      'Every trade you make has three participants: you, greed, and fear. The chart just shows the score.',
      'Greed talks you into staying “one more candle” after the move is clearly over, doubling after a win, going all-in because today feels lucky. Its favourite phrase: “imagine how much more”.',
      'Fear does the opposite: it closes winners the second they turn green and refuses to close losers because “it will come back”. Its favourite phrase: “just wait”.',
      'The fix is boring and works: decide before the trade what would make you exit — a level, a profit, a timer. Then the decision is made by the calm version of you, not the one watching the candle.',
      'Watch yourself in the games here: if you close wins in two seconds but ride losses to the end of the round, that’s fear driving. Name it, and it loses half its power.',
    ] },
  { cat: 'Psychology', title: 'The Club Effect: How to Avoid Being Part of the Crowd and Keep a Cool Head When Everyone Says "Buy"',
    body: [
      'When everyone around you says “buy”, your brain hears “safe”. The market hears “late”.',
      'That is the club effect: decisions feel safer in a crowd, but by the time the whole club agrees the price should go up, most of that move has already happened — you are buying someone’s exit.',
      'A cool head starts with one question: “would I make this trade if nobody was talking about it?” If the only reason is the noise, it is not a reason.',
      'Contrarian doesn’t mean stubborn. Sometimes the crowd is right and the trend is real — the skill is entering on your own signal (a level, a pullback, a fresh breakout), not on the loudest message in the chat.',
      'Small exercise: next daily challenge, write down your pick BEFORE looking at what others say. Do it for a week — you’ll be surprised whose calls were better.',
    ] },
  // ★ draft 30.07 — набор кейсов «Chart patterns» (встреча 24.07: кейсы/примеры паттернов)
  { cat: 'patterns', key: 'pat.pullback', svg: PAT_SVG.pullback },
  { cat: 'patterns', key: 'pat.support',  svg: PAT_SVG.support },
  { cat: 'patterns', key: 'pat.breakout', svg: PAT_SVG.breakout },
  { cat: 'patterns', key: 'pat.fakeout',  svg: PAT_SVG.fakeout },
  { cat: 'patterns', key: 'pat.panic',    svg: PAT_SVG.panic },
  { cat: 'patterns', key: 'pat.range',    svg: PAT_SVG.range },
];
const GUIDE_CATS = ['Long', 'Short', 'Psychology', 'patterns'];
const GUIDE_GAME = { Long: 'trade', Short: 'trade', Psychology: 'trade', patterns: 'trade' }; // одна игра (webv1)
/* заголовок/абзацы гайда: у кейсов паттернов — из I18N по g.key, у старых — строкой */
function guideTitle(g) { return g.key ? t(g.key + '.t') : g.title; }
function guideBody(g)  { return g.key ? [1, 2, 3].map(n => t(g.key + '.p' + n)) : (g.body || []); }

/* titles/descs live in I18N as ach.<id>.t / .d / .done */
/* Награды ребалансированы 25.07 (слово владельца «не по-охуевшему»): было 19 000 фишек
   суммарно при кошельке 1000 и fee 150 — ачивки обесценивали фишки и Out of chips был
   недостижим. После вердиктов 26.07 (минус shorts, ladder 500→100) потолок 1 500. */
const ACH = [
  { id: 'first',     target: 1,   reward: 200, prog: () => Math.min(1, totalSessions()) },
  { id: 'avid',      target: 3,   reward: 400, prog: totalSessions },
  { id: 'bigwin',    target: 1,   reward: 500, prog: () => (bestWinAll() >= 500 ? 1 : 0) },
  { id: 'daily2',    target: 2,   reward: 300, prog: () => S.daily.claims },
  // webv1: ачивка лесенки вместо explorer/flappy100 (архив 5 игр)
  // (вердикт 26.07 поздний) 'shorts' УБРАНА: за базовое обучение из 3 шагов ачивки нет.
  // Остаётся Full arsenal = открыл ВСЕ механики (вкл. частичные 25/50/75), награда 100.
  { id: 'ladder',    target: 4,   reward: 100, play: 'trade', prog: () => (tradeStage() >= 3 ? tradeStage() : 0) },
];

/* keys of SUBS = data-sub values in index.html (stable English ids);
   displayed strings resolve through I18N (titleKey/textKey/item keys) */
const SUBS = {
  'Notifications':       { type: 'toggles', titleKey: 'sub.notifications', items: ['subitem.dcrem', 'subitem.offers', 'subitem.tourn'] },
  // Figma node 440:21476 — ровно эти 8, без русского; endonyms are NOT translated
  'Language':            { type: 'list',    titleKey: 'sub.language', items: ['English', 'Español', 'Français', 'Deutsch', '日本語', '中文', 'Português', 'العربية'], checked: () => S.lang },
  // skin names stay English in all languages (same convention as course tiers Basic/Pro/Expert)
  'Style':               { type: 'list',    titleKey: 'sub.style', items: ['Narodny', 'Terminal', 'Editorial'], checked: () => SKINS.indexOf(SKIN), act: 'skin-pick' },
  'Music and vibration': { type: 'toggles', titleKey: 'sub.music', items: ['subitem.music', 'subitem.sfx', 'subitem.vibro'] },
  'Help & Support':      { type: 'text', titleKey: 'sub.help', textKey: 'sub.help.text' },
  'About app':           { type: 'text', titleKey: 'sub.about', textKey: 'sub.about.text' },
  'Agreements':          { type: 'text', titleKey: 'sub.agreements', textKey: 'sub.agreements.text' },
  'Terms of Service':    { type: 'text', titleKey: 'sub.terms', textKey: 'sub.terms.text' },
};

/* ---------- stats helpers ---------- */
function gstat(g) { return S.stats[g] || (S.stats[g] = { sessions: 0, bestWin: 0, total: 0 }); }
function totalSessions() { return Object.values(S.stats).reduce((a, b) => a + (b.sessions || 0), 0); }
function bestWinAll() { return Object.values(S.stats).reduce((a, b) => Math.max(a, b.bestWin || 0), 0); }
function favoriteGame() {
  let best = null, bs = 0;
  for (const [g, st] of Object.entries(S.stats)) if ((st.sessions || 0) > bs) { bs = st.sessions; best = g; }
  return best;
}
function dailyStreakDays() {
  // серия дейлика живёт по UTC-датам выигранных ставок
  const t = todayUTCStr();
  if (S.daily.last === t || S.daily.last === addDaysUTC(t, -1)) return S.daily.day;
  return 0;
}

/* ---------- toast ---------- */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; t.classList.remove('show'); }, 2400);
}
const stubToast = () => toast(t('t.stub'));

/* ---------- navigation ---------- */
const TAB_SCREEN = {
  home: 'scr-home', shop: 'scr-shop', referrals: 'scr-referrals',
  achievements: 'scr-achievements', settings: 'scr-settings',
};
const TAB_IDS = Object.values(TAB_SCREEN);
/* editorial top app bar: заголовок по активному табу (mockup B: «Main»/«Shop»/…) */
const TOPBAR_KEYS = {
  'scr-home': 'bar.home', 'scr-shop': 'shop.title', 'scr-referrals': 'ref.title',
  'scr-achievements': 'ach.title', 'scr-settings': 'set.title',
};
function renderTopbar() {
  const bar = $('#topbar'); if (!bar) return;
  bar.hidden = !TAB_IDS.includes(curScreen);
  if (TOPBAR_KEYS[curScreen]) $('#topbarTitle').textContent = t(TOPBAR_KEYS[curScreen]);
}
let curScreen = 'scr-home';
let curTab = 'home';
let navStack = [];

function activate(id) {
  $$('.screen').forEach(s => s.classList.toggle('active', s.id === id));
  curScreen = id;
  const node = document.getElementById(id);
  if (node) node.scrollTop = 0;
  $('#tabbar').hidden = !TAB_IDS.includes(id);
  renderTopbar();
}
function showTab(name) {
  const prevScreen = curScreen; // экран, С КОТОРОГО уходим (до activate)
  curTab = name;
  navStack = [];
  if (name === 'achievements') renderAch();
  if (name === 'shop') renderShopDailyStrip();
  activate(TAB_SCREEN[name]);
  $$('#tabbar .tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  if (name === 'home') {
    renderHomeHero(); // стадия лесенки могла вырасти за раунд
    renderStarterCard();
    // «приземление» на Home: максимум ОДИН попап, и не мгновенно, а через ~1.2s
    homePopupUsed = false;
    // приземление сразу после игры ИЛИ с экрана результатов — не «идл»:
    // авто-офферы (дейлик и т.п.) там запрещены, очередь — можно
    landingIdle = !justExitedGame && prevScreen !== 'scr-roundcomplete';
    justExitedGame = false;
    const t = todayStr();
    if (S.homeVisits.date !== t) { S.homeVisits.date = t; S.homeVisits.n = 0; }
    S.homeVisits.n++;
    save();
    clearTimeout(homeLandTimer);
    homeLandTimer = setTimeout(processQueue, 1200);
  } else {
    setTimeout(processQueue, 400); // на других табах — только отложенный Out-of-chips
  }
}
function pushScreen(id) { navStack.push(curScreen); activate(id); }
function goBack() {
  const prev = navStack.pop();
  if (prev) activate(prev);
  else showTab('home');
}

/* ---------- sheets & modals ---------- */
let sheetCloseCb = null;
function openSheet(id, onClose) {
  $$('#sheetlayer .sheet').forEach(s => { s.hidden = s.id !== id; });
  $('#sheetlayer').hidden = false;
  sheetCloseCb = onClose || null;
}
function closeSheet() {
  if ($('#sheetlayer').hidden) return;
  $('#sheetlayer').hidden = true;
  const cb = sheetCloseCb; sheetCloseCb = null;
  if (cb) cb();
  else setTimeout(processQueue, 400);
}
function openModal(id) {
  $$('#modallayer .modal').forEach(m => { m.hidden = m.id !== id; });
  $('#modallayer').hidden = false;
}
function closeModal() {
  $('#modallayer').hidden = true;
  setTimeout(processQueue, 400);
}

/* ---------- popup queue (пейсинг: максимум один попап на приземление на Home,
   с задержкой ~1.2s; остальные ждут СЛЕДУЮЩЕГО возврата на Home). Не троттлятся:
   Out-of-chips (жёсткий гейт) и модалка первой победы. ---------- */
const popupQueue = [];
let homePopupUsed = true;   // слот попапа текущего приземления израсходован
let landingIdle = false;    // приземление «идл» (не сразу после игры/раунда)
let justExitedGame = false; // только что вышли из игры — следующий Home не «идл»
let homeLandTimer = null;

function queuePopup(p) { popupQueue.push(p); }
function processQueue() {
  if (gameOpen) return;
  if (!$('#sheetlayer').hidden || !$('#modallayer').hidden) return;
  if (!TAB_IDS.includes(curScreen)) return;
  // отложенный Out-of-chips важнее очереди попапов (и не троттлится)
  if (pendingOOC && balance <= 0) { pendingOOC = false; openSheet('sh-outofchips'); return; }
  if (curScreen !== TAB_SCREEN.home) return; // очередь показываем только на Home
  if (homePopupUsed) return;                 // один попап на приземление
  const p = popupQueue.shift();
  if (!p) {
    // «пиковый» оффер (вердикт 31.07 п.28): всегда на первом Home после Round Complete,
    // НЕ поверх RC — «чистый экран» между праздником и оффером
    if (pendingPeak) { homePopupUsed = true; openPeakSheet(); return; }
    maybeAutoPopups();
    return;
  }
  if (p.type === 'ach') {
    const a = ACH.find(x => x.id === p.id);
    if (!a || S.ach.claimed[a.id]) { processQueue(); return; } // неактуальное не тратит слот
    homePopupUsed = true;
    $('#naTitle').textContent = t('ach.' + a.id + '.t');
    $('#naSub').textContent = t('ach.' + a.id + '.done');
    $('#naReward').textContent = fmt(a.reward);
    $('#md-newach').dataset.ach = a.id;
    openModal('md-newach');
  } else if (p.type === 'savep') {
    if (S.progressSaved) { processQueue(); return; } // уже зарегистрирован — не переспрашивать
    homePopupUsed = true;
    openSaveProgress();
  } else if (p.type === 'promo') {
    homePopupUsed = true;
    openSheet('sh-guidespromo');
  }
}

/* авто-попапы без очереди: пермишен-промо дейлика и авто-оффер дейлика.
   Только на «идл»-приземлении (не сразу после игры — живой фидбек владельца 24.07). */
function dailyBettedToday() { return !!(S.daily.bet && S.daily.bet.dateUTC === todayUTCStr()); }
/* онбординг завершён = сыграны все 3 сим-раунда Trade (та же формула, что в openGame).
   До этого НИКАКИХ авто-попапов: дейлик-оффер выдёргивал игрока посреди обучения (QA 30.07) */
function onboardingDone() {
  return Math.min(OB_ROUNDS, +tradeProgress().rounds || 0) >= OB_ROUNDS;
}
function maybeAutoPopups() {
  if (!landingIdle || !S.seenWelcome) return;
  if (!onboardingDone()) return;
  // стартер-пак 1.99$ (вердикт 31.07 п.27): авто-шит СО ВТОРОЙ сессии-визита (не первой),
  // ровно один раз; никогда во время онбординга (гейт onboardingDone выше) и не поверх
  // RC/игры (этот путь работает только на «идл»-приземлении на Home). Дальше — заглушка
  // оплаты + intent-лог по общей схеме п.15 (см. ACT['starter-buy'])
  if (!S.starterShown && S.visit.n >= 2) {
    S.starterShown = true;
    S.starterEnd = Date.now() + STARTER_WINDOW; // витрина на Home живёт 2ч после авто-шита
    save();
    renderStarterCard();
    homePopupUsed = true;
    openSheet('sh-starter');
    return;
  }
  // «Want to predict...» — один раз, после первой ставки, когда сегодня ещё не ставил
  if (!S.notifPermShown && (S.daily.claims > 0 || S.daily.result || S.daily.bet) && !S.daily.bet) {
    S.notifPermShown = true;
    save();
    homePopupUsed = true;
    openNotifPerm();
    return;
  }
  // авто-оффер дейлика: со ВТОРОГО визита на Home за день, раз в день
  const t = todayStr();
  if (S.dailyOffer === t) return;
  if (S.homeVisits.date !== t || S.homeVisits.n < 2) return;
  if (S.daily.bet) return; // сегодня уже ставил или висит нерешённая ставка
  S.dailyOffer = t;
  save();
  homePopupUsed = true;
  openDaily();
}

/* ---------- balance ---------- */
function renderBalance() { $$('[data-balance]').forEach(el => { el.textContent = fmt(balance); }); }
let balAnimId = 0;
const BAL_CAP = 999999999; // санитарный кап кошелька (защита от мусорных сообщений)
function setBalance(v, opts = {}) {
  const from = balance;
  v = Number.isFinite(+v) ? Math.round(+v) : from; // мусор на входе → баланс не трогаем
  balance = Math.max(-BAL_CAP, Math.min(BAL_CAP, v));
  try { localStorage.setItem('hub.balance', String(balance)); } catch (e) {}
  const d = balance - from;
  if (opts.silent || d === 0) {
    renderBalance();
  } else {
    animateBalance(from, balance);
    flashDelta(d);
  }
  if (balance <= 0) scheduleOutOfChips();
  else pendingOOC = false; // фишки появились — отложенный Out-of-chips не актуален
}
const credit = d => setBalance(balance + d);

function animateBalance(from, to) {
  const id = ++balAnimId;
  const t0 = performance.now(), dur = 550;
  const pill = $('#balancePill');
  pill.classList.remove('pop'); void pill.offsetWidth; pill.classList.add('pop');
  (function step(t) {
    if (id !== balAnimId) return;
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3);
    $$('[data-balance]').forEach(el => { el.textContent = fmt(from + (to - from) * e); });
    if (k < 1) requestAnimationFrame(step);
  })(t0);
}
function flashDelta(d) {
  const old = $('#balDelta');
  if (old) old.remove();
  const el = document.createElement('span');
  el.id = 'balDelta';
  el.className = d > 0 ? 'plus' : 'minus';
  el.textContent = (d > 0 ? '+' : '') + fmt(d);
  $('#balancePill').appendChild(el);
  setTimeout(() => el.remove(), 1500);
}
let pendingOOC = false;
function scheduleOutOfChips() {
  if (gameOpen || curScreen === 'scr-roundcomplete') { pendingOOC = true; return; }
  if (!$('#sheetlayer').hidden) {
    if (!$('#sh-outofchips').hidden) return; // уже показан
    pendingOOC = true; return;               // не выдёргивать чужой sheet — дождаться закрытия
  }
  if (!$('#modallayer').hidden) { pendingOOC = true; return; }
  openSheet('sh-outofchips');
}

/* ---------- game layer ---------- */
let gameOpen = false, curGame = null, tutMode = false, tutStep = 0, tutPaused = false;
let lastRound = null;
let roundSettled = false; // раунд текущего iframe уже зачтён кошельком
let roundStartBal = 0;    // кошелёк на старте раунда (после fee) — для peak-сигнала ×2
let roundFee = 0;         // fee, реально списанный за текущий раунд (0 = бесплатный: онбординг/тренировка)
let feeRefunded = false;  // рефанд обучения за ЭТОТ платный раунд уже выдан (гард от двойного рефанда)

/* ---------- intent log (webv1, встреча п.4–5): docupка/апселл-намерения ----------
   Каждый клик Buy/pack/offer и клики опций «пикового» шита пишутся в
   localStorage 'hub.intents' [{t, source, pack}]; счётчик — в Profile (★ draft). */
function logIntent(source, pack) {
  let log = [];
  try { log = JSON.parse(localStorage.getItem('hub.intents') || '[]') || []; } catch (e) {}
  log.push({ t: Date.now(), source, pack: pack || null });
  if (log.length > 500) log = log.slice(-500);
  try { localStorage.setItem('hub.intents', JSON.stringify(log)); } catch (e) {}
}
function intentLog() {
  try { return JSON.parse(localStorage.getItem('hub.intents') || '[]') || []; } catch (e) { return []; }
}
// «Purchase intents» в профиле = покупательные клики (peak- и skin-записи — служебные,
// в счётчик не входят: peak считается отдельно, skin-* = экспозиция/выбор стиля)
function purchaseIntentCount() {
  return intentLog().filter(x => x && typeof x.source === 'string' &&
    !x.source.startsWith('peak-') && !x.source.startsWith('skin-')).length;
}

/* ---------- заглушки платежей (вердикт владельца 27.07: в веб-прототипе только заглушки) ----------
   Любой покупательный тап → шит sh-paystub: название + цена → «Pay» → вечное
   «Payment processing… we'll notify you» (спиннер не разрешается, закрытие руками).
   В intent-лог идут ОБА шага: источник тапа (шаг 1, исторические теги shop-pack/ooc-pack/
   offer-sheet/course-tierN/referral-course/peak-prop) и 'stub-pay:<item>' (шаг 2). */
const PACKS = { // паки фишек из вёрстки (data-pack → имя/цена для заглушки)
  '50k-4.99':        { amt: '50 000',  price: '4.99$' },
  '150k-hot-8.99':   { amt: '150 000', price: '8.99$' },
  '300k-10.99':      { amt: '300 000', price: '10.99$' },
  'offer-150k-1.99': { amt: '150 000', price: '1.99$' },
};
/* тиры курса (вердикт 27.07): имена английские во всех языках (конвенция продукта);
   цены USD 9.99/29.99/99.99 и проп-квест 49.99 — УТВЕРЖДЕНЫ владельцем 27.07 (вечер),
   больше не плейсхолдеры (★ draft с цен снят; шиты остаются draft — вёрстка/описания мои) */
const TIER_NAMES = ['Basic', 'Pro', 'Expert'];
const TIER_PRICES = ['9.99$', '29.99$', '99.99$'];
let payStubTag = null; // <item> текущей заглушки — для 'stub-pay:<item>'
function openPayStub(tag, itemName, price) {
  payStubTag = tag;
  $('#psItem').textContent = itemName;
  $('#psPrice').textContent = price;
  $('#psConfirm').hidden = false;
  $('#psWait').hidden = true;
  openSheet('sh-paystub');
}

/* ---------- «пик тупизны» (Даннинг–Крюгер; встреча п.5) ----------
   Триггер (вердикт 25.07): 3 выигранных раунда подряд с PnL ≥ +30% (флаг из игры).
   Показ (вердикт 31.07 п.28, «чистый экран»): триггер взводится на Round Complete,
   но шит открывается только ПОСЛЕ возврата на Home (первый Home после того RC),
   НИКОГДА поверх RC — между праздником и оффером минимум один нейтральный экран.
   Частота без изменений: не чаще 1 раза за сессию и 1 раза в день. */
let pendingPeak = null;     // причина ('streak'|'double'|'stageup') — ждёт показа
let peakShownSession = false;
function maybeTriggerPeak(reason) {
  if (peakShownSession || pendingPeak) return;
  if (S.peakDay === todayStr()) return;
  pendingPeak = reason;
}
function openPeakSheet() {
  if (!pendingPeak) return;
  // показы пик-шита — в intent-лог (аналитик 25.07: без этого CTR оффера не посчитать)
  logIntent('peak-view:' + pendingPeak);
  pendingPeak = null;
  peakShownSession = true;
  S.peakDay = todayStr();
  save();
  openSheet('sh-peak');
}

function openGame(g, opts = {}) {
  if (!GAMES[g]) return;
  // платный вход (fee списывается ХАБОМ и не возвращается при выходе).
  // Туториал первого запуска — БЕСПЛАТНЫЙ (директива владельца 24.07); раунды онбординга
  // Trade — симуляция, бесплатно; fee 100 за КАЖДЫЙ реальный раунд ПОСЛЕ онбординга
  // (вердикт 27.07 вечер); заказанная тапом 🔒 тренировка (pendingPartial) — бесплатна
  // онбординг-раунд? (rounds < 3 → сим-раунд N с СВОЕЙ серией баблов — вердикт 30.07 п.23;
  // раньше баблы были только у первого запуска через opts.tutorial)
  const obRounds = FEE_GAMES.includes(g) ? Math.min(OB_ROUNDS, +tradeProgress().rounds || 0) : OB_ROUNDS;
  const obRound = FEE_GAMES.includes(g) && obRounds < OB_ROUNDS;
  const fee = (opts.tutorial || obRound) ? 0 :
    (FEE_GAMES.includes(g) && !tradeProgress().pendingPartial ? ENTRY_FEE : 0);
  if (fee && balance < fee) { openSheet('sh-outofchips'); return; }
  curGame = g;
  gameOpen = true;
  roundSettled = false;
  roundFee = fee;      // для рефанда обучения (hub:feeRefund): платный ли текущий раунд
  feeRefunded = false; // новый раунд = новый лимит «один рефанд на платный раунд»
  tutMode = obRound || !!opts.tutorial;
  tutRound = obRound ? obRounds + 1 : 1;
  if (fee) {
    setBalance(balance - fee, { silent: true }); // до загрузки iframe: игра сидируется уже без fee
    toast(t('t.fee', fmt(fee)));
  }
  roundStartBal = balance; // сид раунда (для «пикового» сигнала ×2 за раунд)
  const frame = $('#gameframe');
  if (tutMode) frame.addEventListener('load', tutBoot, { once: true });
  // онбординг (longshort): игра сама ограничивает раунд 5 закрытыми сделками по ?tut=1.
  // ?skin= в игру НЕ пробрасываем: скины трогают только оболочку хаба, игра одинакова
  // во всех трёх стилях (вердикт владельца 29.07, DESIGN-ADDITIONS п.21)
  const query = g === 'flappy' ? 'hub=1' : (tutMode ? 'tut=1' : (opts.query || ''));
  frame.src = 'games/' + g + '/index.html' + (query ? '?' + query : '');
  $('#tutorial').hidden = true;
  $('#gamelayer').hidden = false;
}
function closeGame() {
  // staged-бабл, не показанный/не закрытый к концу раунда, НЕ блокирует Round Complete:
  // раунд закрылся с живым туториалом → зачесть раунд туториала и погасить poll
  if (tutMode) {
    clearInterval(tutStagedPoll);
    tutStagedPoll = 0;
    if (tutRound >= OB_ROUNDS) { S.tutorialDone = true; save(); }
  }
  gameOpen = false;
  curGame = null;
  tutMode = false;
  justExitedGame = true; // ближайшее приземление на Home — не «идл» для авто-попапов
  $('#gamelayer').hidden = true;
  $('#tutorial').hidden = true;
  $('#gameframe').src = 'about:blank';
}

/* выход в хаб из игры (кнопка «назад» шелла или «Exit to menu» в паузе игры):
   кошелёк не трогаем — entry fee НЕ возвращается (уплачен за вход), сессия не считается.
   Для flappy это тоже так: выход без hub:flappyRound = взнос сгорел (иначе
   пауза-выход был бы бесплатным абортом раунда). */
function exitToHub() {
  closeGame();
  showTab(curTab);
}

const EARN_CAP = 10000000; // кап выигрыша/проигрыша за раунд (мусорные/гигантские числа)
window.addEventListener('message', e => {
  const d = e.data;
  if (!d || !gameOpen) return;
  // сообщения принимает только сам iframe игры — чужие окна/страница игнорируются
  try { if (e.source !== $('#gameframe').contentWindow) return; } catch (err) { return; }
  if (d.type === 'hub:exit') {
    if (d.game !== curGame) return;
    exitToHub();
    return;
  }
  if (d.type === 'hub:feeRefund') {
    // обучение 4-й механики (вердикт 27.07 вечер): игрок ПЛАТНОГО раунда провалился в
    // обучающий раунд хеджирования (тап по 🔒 Size) → вернуть entry fee. Гарды:
    // только игры с fee, только реально платный раунд (roundFee>0 — онбординг/повтор
    // тренировки бесплатны и рефанда не дают), ровно один рефанд на платный раунд.
    if (d.game !== curGame || !FEE_GAMES.includes(curGame)) return;
    if (!roundFee || feeRefunded) return;
    feeRefunded = true;
    setBalance(balance + roundFee, { silent: true });
    toast(t('t.feeback', fmt(roundFee)));
    return;
  }
  if (d.type === 'hub:flappyRound') {
    if (curGame !== 'flappy' || roundSettled) return; // один зачёт на iframe
    roundSettled = true;
    const collected = Math.max(0, Math.round(+d.collected || 0)) || 0;
    // total = заспавнено К МОМЕНТУ смерти: быстрая смерть на первых монетах давала бы
    // высокий pct — знаменатель клампится к спавну полного раунда (FLAPPY_MIN_TOTAL)
    const total = Math.max(Math.round(+d.total || 0) || 0, FLAPPY_MIN_TOTAL);
    const pct = Math.max(0, Math.min(1, collected / total));
    const payout = pct >= 0.25 ? Math.round(FLAPPY_ENTRY * pct / 0.25) : 0;
    const st = gstat('flappy');
    st.sessions++;
    const delta = payout - FLAPPY_ENTRY; // экономика раунда с учётом входа
    st.total += delta;
    if (delta > st.bestWin) st.bestWin = delta;
    sessionTriggers();
    save();
    if (payout > 0) credit(payout);
    toast(t('t.coins', Math.round(pct * 100), payout > 0 ? '+' + fmt(payout) : '+0'));
    checkAch();
    return;
  }
  if (d.type === 'hub:peak') {
    // легаси-сигнал (серия закрытий) — вердиктом 25.07 отменён, игра его больше не шлёт
    return;
  }
  if (d.type !== 'hub:roundEnd') return;
  if (roundSettled || d.game !== curGame) return;
  let earned = Math.round(+d.earned || 0);
  if (!Number.isFinite(earned)) earned = 0;
  earned = Math.max(-EARN_CAP, Math.min(EARN_CAP, earned));
  roundSettled = true;
  // «пик» (вердикт 25.07): ЕДИНСТВЕННЫЙ триггер — 3 выигранных раунда подряд с PnL ≥ +30%
  // (флаг считает игра и передаёт в roundEnd; «на деле будет позже» — примечание владельца)
  if (d.peak) maybeTriggerPeak('streak30');
  handleRoundEnd(d.game, earned, { sim: !!d.sim, stage: +d.stage || 0, stagedUp: !!d.stagedUp });
});

function extractTiles(g) {
  const list = TILE_EXTRACT[g] || [];
  const out = [];
  try {
    const doc = $('#gameframe').contentWindow.document;
    for (const [label, sel] of list) {
      const n = doc.querySelector(sel);
      if (!n) continue;
      const v = n.textContent.replace(' from start', '').replace(/^Best result:\s*/, '').trim();
      if (v) out.push([t(label), v]);
    }
  } catch (err) {}
  return out;
}

// растянутые по флоу триггеры (>=N, а не ===N: N-я сессия могла прийти
// путём без этого хука — тогда сработает на следующей).
// webv1 (встреча п.4): регистрация предлагается уже ПОСЛЕ ПЕРВОГО раунда (n>=1)
function sessionTriggers() {
  // savep/promo считают ВСЕ раунды (вкл. сим): регистрация предлагается после 1-го же
  // (туториального) раунда — это флоу, не ачивка (вердикты 25–26.07 не про него)
  const n = Math.max(S.roundsAll || 0, totalSessions());
  if (n >= 1 && !S.savepShown && !S.progressSaved) { S.savepShown = true; queuePopup({ type: 'savep' }); }
  if (n >= 4 && !S.promoShown) { S.promoShown = true; queuePopup({ type: 'promo' }); }
}

function handleRoundEnd(g, earned, opts = {}) {
  // биржевые игры: внутриигровая дельта — «доллары», в кошелёк идут фишки по курсу TRADE_RATE.
  // Раунд онбординга (sim, вердикт 25.07) — симуляция: в кошелёк НИЧЕГО не зачисляем
  const isTrade = FEE_GAMES.includes(g);
  const rawDelta = isTrade ? earned : null;
  const chips = opts.sim ? 0 : (isTrade ? Math.round(earned * TRADE_RATE) : earned);
  // (вердикт 25.07) прайм-момент «баланс ×2 за раунд» отменён — пик только по streak30

  const st = gstat(g);
  // (вердикт 26.07) сим-раунды (онбординг + тренировка частичных) НЕ копят счётчики:
  // sessions/total/bestWin — только реальные раунды, иначе ачивки закрываются симуляцией
  if (!opts.sim) {
    st.sessions++;
    st.total += chips;
    if (chips > st.bestWin) st.bestWin = chips;
  }
  S.roundsAll = (S.roundsAll || 0) + 1; // все раунды вкл. сим — для savep/promo (регистрация после 1-го раунда)

  // first-win: только РЕАЛЬНЫЙ раунд (QA 25.07: модалка «первый успешный трейд» с +150
  // выстреливала на симуляционном онбординге — и бонус, и модалка ждут первый живой раунд)
  // и только ПОБЕДА (QA 30.07): проигранный первый раунд бонус не даёт — флаг ждёт первого плюса
  const first = !S.firstWin && !opts.sim && chips > 0;
  if (first) S.firstWin = true;

  // анлок-карточка на Round Complete (mockup onb1-6): сим-раунд 1 → «Short selling»,
  // сим-раунд 2 → «Leverage» (★ draft — макета нет, тот же паттерн); после сим-раунда 3
  // и обучения 4-й механики карточки нет (реальные раунды/прежний флоу)
  const unlock = (opts.sim && opts.stagedUp && opts.stage === 2) ? 'short' :
    (opts.sim && opts.stagedUp && opts.stage === 3) ? 'lev' : null;
  lastRound = { game: g, earned: chips, rawDelta, tiles: extractTiles(g), sim: !!opts.sim, first, unlock };

  sessionTriggers();
  save();
  setBalance(balance + chips + (first ? 150 : 0), { silent: true }); // +150 = first-win bonus (карточка на RC)
  if (!opts.sim) checkAch(); // (вердикт 26.07) в сим-раундах ачивки не начисляем

  setTimeout(() => {
    if (!gameOpen || curGame !== g) return; // player already backed out
    closeGame();
    // модалка первой победы ОТМЕНЕНА (26.07), тост заменён зелёной карточкой бонуса
    // прямо на Round Complete (mockup onb1-6) — бонус +150 без изменений
    showRoundComplete();
  }, 900);
}

function showRoundComplete() {
  const r = lastRound;
  if (!r) { showTab('home'); return; }
  if (!r.sim && r.rawDelta !== null && r.rawDelta !== undefined) {
    // пояснить конверсию: внутриигровые $ ≠ фишки кошелька.
    // Сим-раунды тоста НЕ получают (QA 30.07): «+$X → +0 chips» на симуляции читался
    // как баг и заезжал под первый бабл следующего раунда — сим по дизайну платит 0
    const sign = n => (n < 0 ? '−' : '+');
    toast(t('t.traderes', sign(r.rawDelta) + '$' + fmt(Math.abs(r.rawDelta)),
      sign(r.earned) + fmt(Math.abs(r.earned))));
  }
  $('#rcEarned').textContent = fmt(r.earned);
  $('.rc-earn-val').classList.toggle('neg', r.earned < 0);
  $('#rcBalance').textContent = fmt(balance);
  // анлок-карточка (mockup onb1-6) + зелёная карточка бонуса первой победы
  const un = $('#rcUnlock');
  un.hidden = !r.unlock;
  if (r.unlock) {
    $('#rcUnlockName').textContent = t('mech.' + r.unlock);
    $('#rcUnlockDesc').textContent = t('mech.' + r.unlock + '.d');
    un.classList.toggle('draft', r.unlock === 'lev'); // «Leverage» card — no mockup, mine
    un.dataset.draft = r.unlock === 'lev' ? 'Leverage unlock card: same pattern as mockup Short selling — no own mockup' : '';
  }
  $('#rcFw').hidden = !r.first;
  const tiles = $('#rcTiles');
  if (r.tiles.length) {
    tiles.innerHTML = r.tiles.map(([l, v]) => `<div class="rc-tile"><span>${l}</span><b>${v}</b></div>`).join('');
    tiles.hidden = false;
    // labels other than the Figma trio (Guessed / Best streak / Best modifier) are my invention
    tiles.classList.toggle('draft', r.game !== 'prognoz');
  } else {
    tiles.hidden = true;
  }
  navStack = [];
  activate('scr-roundcomplete');
  // «пиковый» оффер здесь НЕ показывается (вердикт 31.07 п.28): взведённый pendingPeak
  // ждёт первого возврата на Home (processQueue), RC остаётся чистым праздником
  setTimeout(() => {
    if (pendingOOC && balance <= 0 && curScreen === 'scr-roundcomplete') { pendingOOC = false; openSheet('sh-outofchips'); }
  }, 1100);
}

/* ---------- onboarding tutorial (вердикт 30.07 п.23; mockups onb1..3) ----------
   3 сим-раунда × 3 бабла: р1 лонг (анализ / открой лонг / профит выше входа),
   р2 шорт (профит на падении / Long / Short), р3 плечо (смелость / больше вход / ликвидация).
   Механика запуска прежняя: шелл стартует раунд в iframe и морозит его (G.paused)
   за баблами; endTutorial размораживает — раунд идёт дальше. «Skip the tutorial»
   гасит ТОЛЬКО баблы ТЕКУЩЕГО раунда (слово Павла): раунды 2/3 получают свои
   последовательности, т.к. каждый сим-раунд = свой iframe-запуск через openGame.
   Якоря/подсветка — по ЖИВОЙ геометрии игры (same-origin); упавший якорь → фолбэк
   (полное затемнение, бабл на CSS-позиции, без стрелки). */
/* Стейджинг (QA 30.07, по макетам): 3-й бабл раундов 1 и 3 — «в середине позиции»
   (onb1-3: профит/Close position; onb3-3: уровни ликвидации) — показывается ПОСЛЕ
   открытия позиции поверх ЖИВОЙ игры (без заморозки); раунд 2 весь до сделки (onb2-1..3).
   win: строка = одно окно в затемнении (запятая внутри строки = фолбэк-селектор),
   массив = несколько окон; dim = сосед в светлой полосе, которого макет держит тёмным
   (onb2-2: Long светлый, Short тёмный — вертикальная полоса не разделит, кладём патч). */
const OB_TUT = [
  [ // round 1 — long (onb1-1..3)
    { key: 'ob1.1', win: '#chartWrap', arrow: ['#tickerBox', 'UL'] },
    { key: 'ob1.2', win: '#btnLong', arrow: ['#btnLong', 'DL'] },
    // ★draft: зелёную зону профита в staged-бабле рисует САМА живая игра (PnL≥0),
    // фейковый tutBand из макета не кладём — он врал бы против живого графика
    { key: 'ob1.3', staged: true, win: ['#chartWrap', '#btnExit'], arrow: ['#btnExit', 'DL'] },
  ],
  [ // round 2 — short (onb2-1..3, все до сделки)
    { key: 'ob2.1' },
    { key: 'ob2.2', win: ['#chartWrap', '#btnLong'], dim: '#btnShort', band: .42, arrow: ['#btnLong', 'DL'] },
    { key: 'ob2.3', win: ['#chartWrap', '#btnShort'], dim: '#btnLong', band: .72, arrow: ['#btnShort', 'DR'] },
  ],
  [ // round 3 — leverage (onb3-1..3)
    { key: 'ob3.1', top: 372, win: '#levCtl' },
    { key: 'ob3.2', win: '#levCtl', arrow: ['#levCtl', 'DL'] },
    { key: 'ob3.3', staged: true, win: '#liqBlock', arrow: ['#liqBlock', 'DL'] },
  ],
];
let tutRound = 1; // 1..3, выставляется в openGame по trade.progress.rounds
function tutBoot() {
  if (!tutMode || !gameOpen) return;
  const t0 = performance.now();
  const iv = setInterval(() => {
    if (!tutMode || !gameOpen) { clearInterval(iv); return; }
    let started = false;
    try {
      const tr = $('#gameframe').contentWindow.__trade;
      // ждём фид (или 4с — оффлайн-генератор), чтобы обучение шло по «живому» рынку
      if (tr && ((tr.Feed.ready && tr.Feed.fresh()) || performance.now() - t0 > 4000)) {
        tr.startRound();
        tr.G.paused = true;
        tutPaused = true;
        started = true;
      }
    } catch (err) { started = true; tutPaused = false; } // фолбэк: баблы без заморозки
    if (started) {
      clearInterval(iv);
      tutStep = 0;
      showTutStep();
    }
  }, 150);
}
function tutLayout() {
  const t = $('#tutorial'), card = $('#tutCard'), band = $('#tutBand');
  const cfg = (OB_TUT[tutRound - 1] || [])[tutStep] || {};
  const arrows = { UL: $('#tutArrowUL'), DL: $('#tutArrowDL'), DR: $('#tutArrowDR') };
  for (const k in arrows) arrows[k].style.display = 'none';
  card.removeAttribute('style');
  t.style.background = '';
  band.hidden = true;
  const lay = $('#gamelayer');
  const H = lay.clientHeight;
  let rect = () => null;
  try {
    const doc = $('#gameframe').contentWindow.document;
    rect = sel => {
      const n = doc.querySelector(sel);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return (r.width > 0 && r.height > 0) ? r : null;
    };
  } catch (err) {}
  // 1) окна в затемнении (mockup: чарт/кнопка-цель/лев-ряд остаются светлыми).
  //    cfg.win: строка = одно окно, массив = несколько горизонтальных полос
  const winSels = cfg.win ? (Array.isArray(cfg.win) ? cfg.win : [cfg.win]) : [];
  const bands = [];
  for (const sel of winSels) {
    const r = rect(sel);
    if (r) bands.push([Math.round(r.top - 4), Math.round(r.bottom + 4)]);
  }
  if (bands.length) {
    bands.sort((a, b) => a[0] - b[0]);
    const DIM = 'rgba(70,70,70,.5)';
    const stops = [];
    let cur = 0;
    for (let [bt, bb] of bands) {
      bt = Math.max(bt, cur); bb = Math.max(bb, bt);
      stops.push(`${DIM} ${cur}px ${bt}px`, `transparent ${bt}px ${bb}px`);
      cur = bb;
    }
    stops.push(`${DIM} ${cur}px 100%`);
    t.style.background = `linear-gradient(${stops.join(',')})`;
  }
  // 1б) патч-затемнение соседа в светлой полосе (onb2-2/3: вторая кнопка пары тёмная)
  const dimEl = $('#tutDim');
  dimEl.hidden = true;
  if (cfg.dim) {
    const dR = rect(cfg.dim);
    if (dR) {
      dimEl.hidden = false;
      dimEl.style.cssText = `top:${Math.round(dR.top - 4)}px;left:${Math.round(dR.left)}px;` +
        `width:${Math.round(dR.width)}px;height:${Math.round(dR.height + 8)}px;`;
    }
  }
  // 2) зелёная зона профита поверх чарта (mockup Rectangle 7271)
  if (cfg.band !== undefined) {
    const ch = rect('#chartWrap');
    if (ch) {
      band.hidden = false;
      band.style.top = Math.round(ch.top + ch.height * cfg.band - 33) + 'px';
    }
  }
  // 3) стрелка + позиция бабла
  const aSpec = cfg.arrow, aR = aSpec ? rect(aSpec[0]) : null;
  if (aSpec && aR) {
    const arr = arrows[aSpec[1]];
    const aw = aSpec[1] === 'UL' ? 67 : 56, ah = aSpec[1] === 'UL' ? 60 : 66;
    if (aSpec[1] === 'UL') {
      // стрелка НАД баблом, указывает вверх-влево в якорь (onb1-1: прайс-кард)
      const aTop = Math.round(aR.top - 2);
      arr.style.cssText = `display:block;top:${aTop}px;left:${Math.round(aR.left + 44)}px;`;
      card.style.cssText = `top:${Math.round(aR.bottom + 26)}px;bottom:auto;`;
    } else {
      // стрелка МЕЖДУ баблом и якорем снизу (кнопки/лев-ряд/ликвидация);
      // кончик КАСАЕТСЯ цели (QA 30.07: раньше зависал на ряд выше — зазор −ah−4)
      const aTop = Math.round(aR.top - ah + 8);
      const ax = aSpec[1] === 'DR'
        ? Math.round(Math.min(aR.left + aR.width * .72, 390 - aw - 8))
        : Math.round(Math.max(aR.left + aR.width * .25 - aw / 2, 8));
      arr.style.cssText = `display:block;top:${aTop}px;left:${ax}px;`;
      card.style.cssText = `bottom:${H - aTop + 4}px;top:auto;`;
    }
  } else if (cfg.top !== undefined) {
    card.style.cssText = `top:${cfg.top}px;bottom:auto;`;
  }
  // фолбэк без якоря: CSS-позиция бабла (bottom:176px), полное затемнение
}
function showTutStep() {
  const t = $('#tutorial');
  t.hidden = false;
  $('#tutText').textContent = window.t(OB_TUT[tutRound - 1][tutStep].key);
  tutLayout();
}
function tutNext() {
  tutStep++;
  const seq = OB_TUT[tutRound - 1] || [];
  if (tutStep >= seq.length) { endTutorial(); return; }
  if (seq[tutStep].staged) { stageTutStep(); return; }
  showTutStep();
}
function unfreezeTut() {
  if (tutPaused) {
    try { $('#gameframe').contentWindow.__trade.G.paused = false; } catch (err) {}
    tutPaused = false;
  }
}
function finishTutRound() {
  if (tutRound >= OB_ROUNDS) { S.tutorialDone = true; save(); }
  tutMode = false;
}
/* staged-бабл (QA 30.07, макеты onb1-3/onb3-3): баблы 1–2 отработали над замороженной
   игрой → разморозка → ждём ОТКРЫТИЯ ПОЗИЦИИ (poll по __trade.G.pos, фолбэк — видимость
   #pnlBox в DOM игры) → бабл 3 поверх ЖИВОЙ игры, без заморозки, Next гасит.
   Позиции за раунд не случилось → бабл 3 молча пропадает (★draft: показывать его на
   конце раунда было бы враньё — контекст «ты в позиции» уже ушёл). */
let tutStagedPoll = 0;
function stageTutStep() {
  $('#tutorial').hidden = true;
  unfreezeTut();
  clearInterval(tutStagedPoll);
  tutStagedPoll = setInterval(() => {
    if (!tutMode || !gameOpen) { clearInterval(tutStagedPoll); tutStagedPoll = 0; return; }
    let pos = false, over = false;
    try {
      const tr = $('#gameframe').contentWindow.__trade;
      pos = !!(tr && tr.G.pos);
      over = !!(tr && tr.G.over);
    } catch (err) {
      try { // фолбэк: судим по карточке позиции в DOM игры (same-origin)
        pos = !$('#gameframe').contentWindow.document
          .querySelector('#pnlBox').classList.contains('hidden');
      } catch (e2) {}
    }
    if (over) { clearInterval(tutStagedPoll); tutStagedPoll = 0; finishTutRound(); return; }
    if (pos) { clearInterval(tutStagedPoll); tutStagedPoll = 0; showTutStep(); }
  }, 200);
}
/* закрыть баблы ТЕКУЩЕГО раунда (Next до конца или Skip) — раунд продолжается.
   Skip гасит и отложенный staged-бабл (poll), не только видимые */
function endTutorial() {
  $('#tutorial').hidden = true;
  clearInterval(tutStagedPoll);
  tutStagedPoll = 0;
  unfreezeTut();
  finishTutRound();
}

/* ---------- daily challenge: реальная ставка на дневную свечу BTC (UTC-день) ----------
   Ставка: закроется ли BTC сегодня ВЫШЕ (Long) или НИЖЕ (Short) открытия дня (00:00 GMT).
   Мгновенного выигрыша нет: после ставки кнопки лочатся, идёт отсчёт до 00:00 GMT.
   Резолв — при заходе в следующий UTC-день: дневная свеча дня ставки (Binance REST),
   win → награда дня серии, lose → серия на день 1. Оффлайн → ставка ждёт сети.
   Все новые строки/таймер рендерятся из JS в существующий DOM шита (index.html не трогаем). */

/* shop daily reward живёт по старой локальной схеме — хелпер оставлен для него */
function dailyProspectiveDay(d) {
  if (d.last === todayStr()) return d.day;             // already claimed today
  if (d.last === yesterdayStr()) return d.day + 1;     // streak continues
  return 1;                                            // new streak
}
/* Дейли-лестница (слово владельца 26.07): старт 500, шаг +200, потолок 1300/день.
   (Отменяет лестницу 25.07 «200…2000 с прыжком на двушку»; ещё раньше было day×1000.) */
const DAY_LADDER = [500, 700, 900, 1100, 1300];
const dayReward = n => DAY_LADDER[Math.min(Math.max(n, 1), 5) - 1];

const BINANCE = 'https://api.binance.com/api/v3';
async function fetchJSON(url, ms) {
  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), ms || 4000);
  try { const r = await fetch(url, { signal: ctl.signal }); return await r.json(); }
  finally { clearTimeout(to); }
}

/* открытие текущего UTC-дня + текущая цена — одной свечой interval=1d&limit=1 */
async function refreshBTC() {
  try {
    const k = await fetchJSON(BINANCE + '/klines?symbol=BTCUSDT&interval=1d&limit=1');
    const open = +k[0][1], price = +k[0][4]; // close бегущей дневной свечи = текущая цена
    if (!Number.isFinite(open) || !Number.isFinite(price)) throw new Error('bad klines');
    S.btc = { open, price, openDate: todayUTCStr(), ts: Date.now(), live: true };
  } catch (e) {
    if (S.btc) S.btc.live = false; // оффлайн: показываем последнее известное с пометкой
  }
  save();
  if (!$('#sheetlayer').hidden && !$('#sh-daily').hidden) renderDailySheet();
}

/* день серии, который принесёт сегодняшняя ставка (или принесла бы) */
function dailyChDay() {
  return (S.daily.last === addDaysUTC(todayUTCStr(), -1)) ? S.daily.day + 1 : 1;
}

let dailyResolving = false;
let dailyResolveLast = 0; // антиспам ретраев резолва в оффлайне
async function resolveDailyBet() {
  const b = S.daily.bet;
  if (!b || b.dateUTC === todayUTCStr() || dailyResolving) return;
  dailyResolving = true;
  dailyResolveLast = Date.now();
  let k = null;
  try {
    const [y, m, d] = String(b.dateUTC).split('-').map(Number);
    const arr = await fetchJSON(BINANCE + '/klines?symbol=BTCUSDT&interval=1d&startTime=' + Date.UTC(y, m - 1, d) + '&limit=1');
    if (Array.isArray(arr) && arr[0]) k = arr[0];
  } catch (e) {}
  dailyResolving = false;
  if (!k) { // оффлайн — ставка остаётся нерешённой, шит покажет «offline»
    if (!$('#sheetlayer').hidden && !$('#sh-daily').hidden) renderDailySheet();
    return;
  }
  const open = +k[1], close = +k[4];
  if (!Number.isFinite(open) || !Number.isFinite(close)) return;
  const win = b.dir === 'long' ? close > open : close < open; // тай (close===open) = проигрыш
  if (win) {
    const day = (S.daily.last === addDaysUTC(b.dateUTC, -1)) ? S.daily.day + 1 : 1;
    S.daily.day = day;
    S.daily.last = b.dateUTC;
    S.daily.claims++;
    S.daily.result = { dateUTC: b.dateUTC, dir: b.dir, win: true, open, close, reward: dayReward(day) };
    S.daily.bet = null;
    save();
    credit(dayReward(day));
    toast(t('t.dailywon', fmt(dayReward(day))));
  } else {
    S.daily.day = 0;
    S.daily.last = null;
    S.daily.result = { dateUTC: b.dateUTC, dir: b.dir, win: false, open, close, reward: 0 };
    S.daily.bet = null;
    save();
  }
  checkAch();
  if (!$('#sheetlayer').hidden && !$('#sh-daily').hidden) renderDailySheet();
}

const fmtUSD = v => '$' + fmt(Math.round(v));

/* контейнеры, которых нет в вёрстке (index.html — у агента вёрстки), создаём из JS */
function ensureDailyDom() {
  const sh = $('#sh-daily');
  let live = sh.querySelector('#dcLive');
  if (!live) {
    live = document.createElement('div');
    live.id = 'dcLive';
    live.style.cssText = 'margin:10px 0 0;display:flex;flex-direction:column;gap:4px;font-size:13px;line-height:18px;';
    sh.querySelector('.daily-chart').insertAdjacentElement('afterend', live);
  }
  let res = sh.querySelector('#dcResult');
  if (!res) {
    res = document.createElement('div');
    res.id = 'dcResult';
    res.style.cssText = 'margin:8px 0 0;';
    live.insertAdjacentElement('afterend', res);
  }
  let bet = $('#dailyVictory').querySelector('#dcBetInfo');
  if (!bet) {
    bet = document.createElement('div');
    bet.id = 'dcBetInfo';
    bet.style.cssText = 'margin:6px 0 10px;font-size:13px;line-height:19px;';
    const doneBtn = $('#dailyVictory').querySelector('[data-act="sheet-close"]');
    if (doneBtn) doneBtn.insertAdjacentElement('beforebegin', bet);
    else $('#dailyVictory').appendChild(bet);
  }
  return { live, res, bet };
}

function renderDailySheet() {
  // candles: deterministic pseudo-random from the date, so the "candle of the day" is stable
  let seed = 0;
  for (const ch of todayStr()) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  // ~9 узких свечей (w12, шаг 26) — геометрия Figma-арта 440:19186 (хендофф вёрстки 24.07)
  let y = 75, parts = [];
  for (let i = 0; i < 9; i++) {
    const up = rnd() > 0.45;
    const body = 14 + rnd() * 26;
    const x = 8 + i * 26;
    const yy = y - (up ? body : 0);
    // цвета свечей — токены скина (style-атрибут: var() в презентационных атрибутах не работает)
    const col = up ? 'var(--green)' : 'var(--red)';
    parts.push(`<line x1="${x + 6}" y1="${yy - 8}" x2="${x + 6}" y2="${yy + body + 8}" style="stroke:${col}" stroke-width="2.5" stroke-linecap="round"/>`);
    parts.push(`<rect x="${x}" y="${yy}" width="12" height="${body}" rx="3" style="fill:${col}"/>`);
    y += (up ? -1 : 1) * body * 0.55;
    y = Math.max(34, Math.min(106, y));
  }
  $('#dailyCandles').innerHTML = parts.join('');

  const { live, res, bet } = ensureDailyDom();
  const tU = todayUTCStr();

  // --- живые цены: открытие дня (00:00 GMT) и текущая, с дельтой ---
  const btc = S.btc;
  const fresh = btc && btc.live && btc.openDate === tU;
  const open = btc ? btc.open : 63370;   // плейсхолдер из макета, помечен offline
  const price = btc ? btc.price : 63370;
  const dpct = open ? (price / open - 1) * 100 : 0;
  const dCol = dpct >= 0 ? 'var(--green)' : 'var(--red)';
  const offMark = fresh ? '' : ` <span style="opacity:.55">· ${t('offline')}</span>`;
  live.innerHTML =
    `<div style="display:flex;justify-content:space-between"><span style="opacity:.65">${t('dc.open')}</span><b>${fmtUSD(open)}${offMark}</b></div>` +
    `<div style="display:flex;justify-content:space-between"><span style="opacity:.65">${t('dc.now')}</span><b>${fmtUSD(price)} <span style="color:${dCol}">${dpct >= 0 ? '+' : ''}${dpct.toFixed(2)}%</span>${offMark}</b></div>`;

  // --- результат вчерашней ставки (до следующей ставки) ---
  const r = S.daily.result;
  const showRes = r && !dailyBettedToday();
  if (showRes && r.win) {
    res.innerHTML = `<div class="dc-res win draft">` +
      `<span class="dc-res-ico">✓</span><span><b>${t('dc.won', Math.min(S.daily.day, 5))}</b> ${t('dc.winrest', t(r.dir === 'long' ? 'higher' : 'lower'), fmt(r.reward))}</span></div>`;
  } else if (showRes && !r.win) {
    res.innerHTML = `<div class="dc-res lose draft">` +
      `<span class="dc-res-ico">▮</span><span><b>${t('dc.lost')}</b> ${t('dc.lostrest', t(r.dir === 'long' ? 'lower' : 'higher'))}</span></div>`;
  } else {
    res.innerHTML = '';
  }

  // --- полоса дней серии ---
  const day = dailyChDay();
  const doneDays = (S.daily.last === addDaysUTC(tU, -1)) ? S.daily.day : 0;
  const days = $('#dailyDays');
  let html = '';
  for (let i = 1; i <= 5; i++) {
    if (i === Math.min(day, 5)) { // сперва «Today» — при серии >5 дней это слот 5
      html += `<div class="dd today"><span>${t('today')}</span><span class="coin-dot"></span><span class="amt">${fmt(dayReward(day))}</span></div>`;
    } else if (i <= doneDays) {
      html += `<div class="dd done"><span>${t('dayN', i)}</span><span class="dd-check">✓</span><span class="amt">${fmt(dayReward(i))}</span></div>`;
    } else {
      html += `<div class="dd"><span>${t('dayN', i)}</span><span class="coin-dot"></span><span class="amt">${fmt(dayReward(i))}</span></div>`;
    }
  }
  days.innerHTML = html;

  // --- состояние ставки ---
  const betToday = dailyBettedToday();
  const betStale = S.daily.bet && !betToday; // старая нерешённая (оффлайн на резолве)
  $('#dailyBtns').hidden = !!S.daily.bet;
  $('#dailyVictory').hidden = !betToday;
  if (betToday) {
    const b = S.daily.bet;
    const bOpen = Number.isFinite(+b.open) && +b.open ? +b.open : (S.btc ? S.btc.open : null);
    const line = bOpen ? t('dc.betline.' + b.dir, fmtUSD(bOpen)) : t('dc.betline2.' + b.dir);
    const m = new Date(); m.setUTCHours(24, 0, 0, 0);
    bet.innerHTML = `${t('dc.pick')} <b style="color:${b.dir === 'long' ? 'var(--green)' : 'var(--red)'}">${b.dir === 'long' ? 'Long ▲' : 'Short ▼'}</b>` +
      ` — ${line}` +
      `<br><span id="dcCountdown" style="opacity:.75">${t('dc.result', fmtHMS(m.getTime() - Date.now()))}</span>`;
  } else {
    bet.innerHTML = '';
  }
  if (betStale) {
    res.innerHTML = `<div class="dc-res lose draft">${t('dc.stale', S.daily.bet.dir, S.daily.bet.dateUTC)}</div>`;
  }

  // слот «свечи дня» на арте: после ставки — свеча НОРМАЛЬНОГО размера внутри слота
  // (класс .done заливает весь слот на всю высоту — «гигантская свеча», фидбек 24.07);
  // рамка слота и колонка цен не трогаются, свеча сидит на белом «фитиле» ::before
  const q = $('#dailyQ');
  q.classList.remove('done');
  if (S.daily.bet) {
    const col = S.daily.bet.dir === 'long' ? 'var(--green)' : 'var(--red)';
    q.innerHTML = `<span style="width:18px;height:54px;background:${col};border-radius:5px;` +
      `display:flex;align-items:center;justify-content:center;color:#fff;font-size:15px;font-weight:900;opacity:1">✓</span>`;
  } else {
    q.innerHTML = '<span>?</span><span class="q-big">?</span><span>?</span>';
  }
}

function openDaily() {
  resolveDailyBet(); // асинхронно: решит вчерашнюю ставку и перерисует шит
  refreshBTC();      // асинхронно: подтянет живые цены и перерисует шит
  renderDailySheet();
  openSheet('sh-daily');
}

function dailyPick(dir) {
  if (S.daily.bet) return; // сегодня уже ставил / висит нерешённая ставка
  dir = dir === 'long' ? 'long' : 'short';
  const open = (S.btc && S.btc.openDate === todayUTCStr()) ? S.btc.open : null;
  S.daily.bet = { dateUTC: todayUTCStr(), dir, open };
  save();
  toast(t('t.placed', dir === 'long' ? 'Long' : 'Short'));
  renderDailySheet();
}

/* «Want to predict...» — кнопки переписываются из JS (вёрстка у агента вёрстки):
   primary «Make a prediction» → в дейлик, secondary «Close» → просто закрыть */
function openNotifPerm() {
  const sh = $('#sh-notifperm');
  const prim = sh.querySelector('[data-act="notif-allow"], [data-act="notifperm-predict"]');
  if (prim) { prim.dataset.act = 'notifperm-predict'; prim.textContent = t('np.predict'); }
  const sec = sh.querySelector('.btn[data-act="sheet-close"]');
  if (sec) sec.textContent = t('close');
  openSheet('sh-notifperm');
}

/* ---------- shop daily reward ---------- */
function renderShopDailyStrip() {
  const claimed = S.shopDaily.last === todayStr();
  const day = dailyProspectiveDay(S.shopDaily);
  $('#drStripAmt').textContent = fmt(dayReward(day));
  const btn = $('#drStripBtn');
  btn.textContent = claimed ? t('claimed') : t('claim');
  btn.disabled = claimed;
}
function renderShopDailySheet() {
  const claimed = S.shopDaily.last === todayStr();
  const day = dailyProspectiveDay(S.shopDaily);
  let html = '';
  for (let i = 1; i <= 5; i++) {
    if (i === Math.min(day, 5)) { // сперва «Today» — при серии >5 дней это слот 5
      html += `<div class="dd today"><span>${t('today')}</span><span class="coin-dot"></span><span class="amt">${fmt(dayReward(day))}</span></div>`;
    } else if (i < day) {
      html += `<div class="dd done"><span>${t('dayN', i)}</span><span class="dd-check">✓</span><span class="amt">${fmt(dayReward(i))}</span></div>`;
    } else {
      html += `<div class="dd"><span>${t('dayN', i)}</span><span class="coin-dot"></span><span class="amt">${fmt(dayReward(i))}</span></div>`;
    }
  }
  $('#drDays').innerHTML = html;
  $('#drGiftAmt').textContent = fmt(dayReward(day));
  const btn = $('#drClaimBtn');
  btn.textContent = claimed ? t('dr.claimed') : t('dr.claim');
  btn.disabled = claimed;
}
function claimShopDaily() {
  if (S.shopDaily.last === todayStr()) return;
  const day = dailyProspectiveDay(S.shopDaily);
  S.shopDaily.day = day;
  S.shopDaily.last = todayStr();
  save();
  credit(dayReward(day));
  toast(t('t.dreward', fmt(dayReward(day))));
  renderShopDailySheet();
  renderShopDailyStrip();
  setTimeout(closeSheet, 800);
}

/* ---------- achievements ---------- */
function checkAch() {
  for (const a of ACH) {
    if (!S.ach.done[a.id] && a.prog() >= a.target) {
      S.ach.done[a.id] = true;
      save();
      queuePopup({ type: 'ach', id: a.id });
    }
  }
  setTimeout(processQueue, 600);
}
function claimAch(id) {
  const a = ACH.find(x => x.id === id);
  if (!a || S.ach.claimed[id] || a.prog() < a.target) return;
  S.ach.claimed[id] = true;
  save();
  credit(a.reward);
  toast(t('t.achreward', t('ach.' + id + '.t'), fmt(a.reward)));
  renderAch();
}
/* reskin W2 (mockups A/B/C-achievements): один скелет — иконка-кружок, тексты + бейдж награды
   сверху, прогресс-бар со счётчиком, слот действия (A/B — кнопка справа, C — во всю ширину). */
const ACH_ICON = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10.2" r="5.4"/><path d="M12 7.9l.8 1.6 1.8.3-1.3 1.25.3 1.75-1.6-.85-1.6.85.3-1.75-1.3-1.25 1.8-.3z" fill="currentColor" stroke="none"/><path d="M8.9 14.7L7.4 20.9l4.6-2.2 4.6 2.2-1.5-6.2"/></svg>`;
/* 622-мокап: топ-ряд (иконка+тексты+счётчик), прогресс-бар, футер (Play/Claim + «Reward ◑N»);
   claimed-карта пригашена, справа «Claimed ◑N», футера нет */
function renderAch() {
  const box = $('#achList');
  box.innerHTML = ACH.map(a => {
    const p = Math.min(a.prog(), a.target);
    const done = p >= a.target;
    const claimed = !!S.ach.claimed[a.id];
    const right = claimed
      ? `<span class="ach-claimed">${t('claimed')} <span class="coin-dot"></span><b>${fmt(a.reward)}</b></span>`
      : `<span class="ach-count">${p}/${a.target}</span>`;
    let cta = '';
    if (!claimed && done) {
      cta = `<button class="ach-claim" data-ach="${a.id}">${t('claim')}<span class="ach-claim-amt">&nbsp;${fmt(a.reward)}</span></button>`;
    } else if (!claimed && a.play) {
      cta = `<button class="ach-play" data-act="play" data-game="${a.play}">${t('play')}</button>`;
    }
    const foot = claimed ? '' :
      `<div class="ach-foot">${cta}
        <span class="ach-reward"><em>${t('ach.reward')}</em><span class="coin-dot"></span><b>${fmt(a.reward)}</b></span>
      </div>`;
    return `<div class="ach-row${claimed ? ' claimed' : ''}">
      <div class="ach-top">
        <div class="ach-ico">${ACH_ICON}</div>
        <div class="ach-texts">
          <span class="ach-title">${t('ach.' + a.id + '.t')}</span>
          <span class="ach-desc">${t('ach.' + a.id + '.d')}</span>
        </div>
        ${right}
      </div>
      <div class="ach-bar${done ? ' full' : ''}"><i style="width:${Math.round(p / a.target * 100)}%"></i></div>
      ${foot}
    </div>`;
  }).join('');
}

/* ---------- profile ---------- */
function renderProfile() {
  $('#stGames').textContent = totalSessions();
  const fav = favoriteGame();
  $('#stFav').textContent = fav ? ((GAMES[fav] || {}).name || LEGACY_NAMES[fav] || fav) : '—';
  $('#stBest').textContent = fmt(bestWinAll());
  const d = new Date(S.started || Date.now());
  const days = Math.max(0, Math.floor((Date.now() - d.getTime()) / 864e5));
  $('#stStarted').textContent = `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}, ${tDays(days)}`;
  // webv1 (встреча п.4): счётчик покупательных намерений — ★ draft
  const n = $('#stIntents');
  if (n) n.textContent = purchaseIntentCount();
}

/* ---------- save progress flow ---------- */
let saveReturnScreen = null;
function openSaveProgress() {
  $('#spBalance').textContent = fmt(balance);
  const n = dailyStreakDays();
  $('#spDaysLine').innerHTML = t('sp.days', '<b id="spDays">' + tDays(n) + '</b>');
  openSheet('sh-saveprogress');
}
function startSignup() {
  saveReturnScreen = TAB_IDS.includes(curScreen) ? null : curScreen; // null → home tab
  closeSheet();
  pushScreen('scr-signup');
}
function finishSignupFlow() {
  S.progressSaved = true;
  save();
  navStack = [];
  if (saveReturnScreen === 'scr-profile') { renderProfile(); activate('scr-profile'); }
  else showTab(curTab);
  toast(t('t.progsaved'));
}

/* ---------- витрина стартер-пака на Home (622-мокап, ★draft) ----------
   Видна, пока живо 2ч-окно, открытое авто-шитом со 2-й сессии (п.27), и пак не «куплен»
   (в прототипе покупок нет — витрина гаснет по таймеру). Тап = тот же шит + intent-лог. */
function renderStarterCard() {
  const card = $('#spOfferHome');
  if (!card) return;
  card.hidden = !(S.starterShown && S.starterEnd > Date.now());
}

/* ---------- home hero (webv1: одна игра, большой Play; встреча п.1) ----------
   Индикатор лестницы стадий УБРАН (вердикт владельца 26.07): Home игрок впервые видит
   уже ПОСЛЕ 3 раундов онбординга, а stage 4 открывается изнутри игры — темы обучения
   на главной быть не должно. Вместо неё тут будут дейли-кредит/лимитные офферы
   (референсы Archero/Rush Royale) — зона дизайнера, в прототип пока не кладём. */
function renderHomeHero() {
  const box = $('#heroStage');
  if (box) box.innerHTML = '';
}

/* ---------- practice tasks (обучающий модуль; встреча п.6, ★ draft) ----------
   Живые галочки по реальным событиям игры (localStorage trade.tasks, пишет игра). */
const PRACTICE_TASKS = [
  ['profit', 'tasks.1'],
  ['survive', 'tasks.2'],
  ['partial50', 'tasks.3'],
];
function tradeTasks() {
  try { return JSON.parse(localStorage.getItem('trade.tasks') || '{}') || {}; } catch (e) { return {}; }
}
function renderPracticeTasks() {
  const box = $('#practiceTasks');
  if (!box) return;
  const done = tradeTasks();
  box.innerHTML =
    `<div class="pt-head"><b>${t('tasks.title')}</b><span>${t('tasks.sub')}</span></div>` +
    PRACTICE_TASKS.map(([flag, key]) =>
      `<div class="pt-row${done[flag] ? ' done' : ''}"><span class="pt-check">${done[flag] ? '✓' : ''}</span><span>${t(key)}</span></div>`
    ).join('');
}

/* ---------- guides ---------- */
function renderGuides(filter) {
  const q = (filter || '').trim().toLowerCase();
  const box = $('#guidesBody');
  let html = '';
  for (const cat of GUIDE_CATS) {
    const items = GUIDES.map((g, i) => [g, i]).filter(([g]) => g.cat === cat && (!q || guideTitle(g).toLowerCase().includes(q)));
    if (!items.length) continue;
    // ★ draft: секция кейсов паттернов — моя (копия+SVG), вайрфрейма нет
    const draft = cat === 'patterns' ? ' draft" data-draft="Chart patterns case set (education module, meeting 24.07; copy + SVG sketches mine, no wireframe)' : '';
    html += `<div class="g-sec${draft}">${t('cat.' + cat)} (${items.length})</div>`;
    html += items.map(([g, i]) => `<button class="g-row" data-guide="${i}"><span>${guideTitle(g)}</span></button>`).join('');
    html += '<div class="g-hr"></div>';
  }
  box.innerHTML = html || `<div class="g-empty">${t('guides.empty')}</div>`;
}
function openGuides() {
  closeSheet();
  $('#guideSearch').value = '';
  renderPracticeTasks(); // живые галочки практикума (webv1 п.6)
  renderGuides('');
  pushScreen('scr-guides');
}
/* тело статьи — из данных гайда (стили вёрстки переиспользуются: art-lead / p / art-img).
   Статические плейсхолдеры между <h1> и <h2> вычищаются один раз при первом рендере. */
function renderArticleBody(g) {
  let box = document.getElementById('artBody');
  if (!box) {
    const h1 = $('#artTitle');
    let n = h1.nextElementSibling;
    while (n && n.tagName !== 'H2') { const next = n.nextElementSibling; n.remove(); n = next; }
    box = document.createElement('div');
    box.id = 'artBody';
    h1.insertAdjacentElement('afterend', box);
  }
  const paras = guideBody(g);
  // ★ draft: у кейсов паттернов вместо арт-плейсхолдера — инлайн-SVG-скетч (g.svg)
  const illo = g.svg
    ? `<div class="art-img art-chart draft" data-draft="Pattern mini-chart: inline SVG sketch, skin tokens only (currentColor + --green/--red)">${g.svg}</div>`
    : '<div class="art-img"></div>';
  box.innerHTML = paras.map((p, i) =>
    `<p${i === 0 ? ' class="art-lead"' : ''}>${p}</p>` + (i === 0 ? illo : '')
  ).join('');
}
function openArticle(i) {
  const g = GUIDES[i];
  if (!g) return;
  $('#artCat').textContent = t('cat.' + g.cat);
  $('#artTitle').textContent = guideTitle(g);
  renderArticleBody(g);
  const game = GUIDE_GAME[g.cat];
  $('#artGameName').textContent = GAMES[game].name;
  $('#artGameDesc').textContent = t(GAMES[game].descKey);
  $('#artGameBtn').dataset.game = game;
  pushScreen('scr-article');
}

/* ---------- settings subscreens ---------- */
let curSub = null;
function renderSubBody(name) {
  const def = SUBS[name] || { type: 'text', textKey: 'sub.stub' };
  const body = $('#setsubBody');
  if (def.type === 'text') {
    body.innerHTML = `<div class="stub-card draft" data-draft="Stub subscreen content (no wireframe)"><p>${t(def.textKey)}</p></div>`;
  } else if (def.type === 'toggles') {
    body.innerHTML = `<div class="set-group draft" data-draft="Stub subscreen content (no wireframe)">` +
      def.items.map((k, i) => `<div class="stub-list-row">${t(k)}<label class="switch"><input type="checkbox" ${i === 0 ? 'checked' : ''}><span class="knob"></span></label></div>`).join('') +
      `</div>`;
  } else if (def.type === 'list') {
    // items = language endonyms / style names, NOT translated (product decision)
    const checked = typeof def.checked === 'function' ? def.checked() : (def.checked || 0);
    const act = def.act || 'lang-pick';
    body.innerHTML = `<div class="set-group">` +
      def.items.map((n, i) => `<button class="stub-list-row" data-act="${act}" data-idx="${i}">${n}${i === checked ? '<span class="stub-check">✓</span>' : ''}</button>`).join('') +
      `</div>`;
  }
}
function openSub(name) {
  curSub = name;
  $('#setsubTitle').textContent = SUBS[name] ? t(SUBS[name].titleKey) : name;
  renderSubBody(name);
  pushScreen('scr-setsub');
}

/* ---------- watch video (simulated rewarded ad) ---------- */
const videoBusy = new WeakSet();
function watchVideo(btn) {
  if (videoBusy.has(btn)) return;
  videoBusy.add(btn);
  const orig = btn.innerHTML;
  const inOOC = !!btn.closest('#sh-outofchips');
  let left = 3;
  btn.textContent = left;
  const iv = setInterval(() => {
    left--;
    if (left > 0) { btn.textContent = left; return; }
    clearInterval(iv);
    btn.innerHTML = orig;
    videoBusy.delete(btn);
    credit(VIDEO_REWARD); // вердикт 27.07: +100 (было 1 000)
    toast(t('t.video', fmt(VIDEO_REWARD)));
    if (inOOC && balance > 0) closeSheet();
  }, 1000);
}

/* ---------- timers ---------- */
function fmtHMS(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return pad2(Math.floor(s / 3600)) + ':' + pad2(Math.floor(s / 60) % 60) + ':' + pad2(s % 60);
}
function tickTimers() {
  const now = Date.now();
  // personal offer
  if (!Number.isFinite(S.offerEnd) || S.offerEnd - now <= 0) { S.offerEnd = now + OFFER_CYCLE; save(); }
  // НЕ «const t»: локалка затеняла i18n-функцию t() и роняла отсчёт дейлика
  // исключением каждую секунду, пока висела нерешённая ставка (QA 30.07)
  const left = fmtHMS(S.offerEnd - now);
  $('#offerTimer').textContent = left;
  $('#offerTimer2').textContent = left;
  // витрина стартер-пака на Home живёт по своему 2ч-окну (622-мокап), не по циклу personal offer
  if (S.starterShown) {
    const sLeft = S.starterEnd - now;
    $('#offerTimerHome').textContent = fmtHMS(Math.max(0, sLeft));
    if (sLeft <= 0) renderStarterCard();
  }
  // daily challenge: живой отсчёт до 00:00 GMT (результат ставки)
  const cd = document.getElementById('dcCountdown');
  if (cd) {
    const m = new Date(); m.setUTCHours(24, 0, 0, 0);
    cd.textContent = t('dc.result', fmtHMS(m.getTime() - now));
  }
  // а в новый UTC-день — авто-резолв нерешённой ставки (не чаще раза в минуту в оффлайне)
  if (S.daily.bet && S.daily.bet.dateUTC !== todayUTCStr() && !dailyResolving &&
      now - dailyResolveLast > 60000) resolveDailyBet();
}

/* ---------- long-press on 9:41 = full prototype reset ---------- */
(function initReset() {
  const el = $('#sbTime');
  let timer = null;
  const start = e => {
    e.preventDefault();
    timer = setTimeout(() => {
      try { localStorage.clear(); } catch (err) {}
      location.reload();
    }, 1500);
  };
  const stop = () => { clearTimeout(timer); timer = null; };
  el.addEventListener('pointerdown', start);
  el.addEventListener('pointerup', stop);
  el.addEventListener('pointercancel', stop);
  el.addEventListener('pointerleave', stop);
  el.addEventListener('contextmenu', e => e.preventDefault());
})();

/* ---------- verification code boxes ---------- */
function showVfError() {
  const scr = $('#scr-verify'); if (!scr) return;
  scr.classList.add('vf-error');
  const e = $('#vfError'); if (e) e.hidden = false;
}
function clearVfError() {
  const scr = $('#scr-verify'); if (!scr || !scr.classList.contains('vf-error')) return;
  scr.classList.remove('vf-error');
  const e = $('#vfError'); if (e) e.hidden = true;
}
(function initCodeBoxes() {
  const boxes = $$('.code-box');
  boxes.forEach((b, i) => {
    b.addEventListener('input', () => {
      b.value = b.value.replace(/\D/g, '').slice(0, 1);
      b.classList.toggle('filled', !!b.value); // заливка бокса по макетам B/C
      clearVfError(); // ошибка гаснет при новом вводе (макеты *-code-error)
      if (b.value && i < boxes.length - 1) boxes[i + 1].focus();
    });
    b.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !b.value && i > 0) boxes[i - 1].focus();
    });
  });
})();

/* ---------- editorial settings row toggles (mockup B; prototype-only master flags) ---------- */
(function initSetToggles() {
  const map = { swNotif: 'notif', swMusic: 'music' };
  for (const [id, key] of Object.entries(map)) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.checked = S.setFlags[key] !== false;
    el.addEventListener('change', () => { S.setFlags[key] = el.checked; save(); });
  }
  // a tap on the switch must not open the subscreen under the row
  $$('.set-sw').forEach(sw => sw.addEventListener('click', e => e.stopPropagation()));
})();

/* ---------- actions ---------- */
/* welcome «мелькает и сам пропускается»: первые 600 мс после рендера экрана
   приветствия тапы по Start/Skip игнорируются (случайный даблтап не пробьёт экран) */
let welcomeArmedAt = 0;
const welcomeGhostTap = () => welcomeArmedAt && performance.now() - welcomeArmedAt < 600;

const ACT = {
  /* welcome */
  'welcome-start': () => {
    if (welcomeGhostTap()) return;
    if (gameOpen) return; // защита от даблклика по Start
    S.seenWelcome = true; save();
    showTab('home');
    openGame('trade', { tutorial: true }); // webv1: онбординг = stage 1 игры Trade (buy/sell)
  },
  'welcome-skip': () => {
    if (welcomeGhostTap()) return;
    S.seenWelcome = true; save(); showTab('home');
  },

  /* nav */
  'back': goBack,
  'go-home': () => showTab('home'),
  'open-profile': () => { renderProfile(); pushScreen('scr-profile'); },
  'open-notifications': () => {
    S.bellSeen = true; save();
    const dot = $('#bellDot'); if (dot) dot.hidden = true;
    pushScreen('scr-notifications');
  },
  'open-shop': () => showTab('shop'),
  'goto-referrals': () => { closeSheet(); showTab('referrals'); },
  'open-guides': openGuides,

  /* games */
  'play': el => {
    const g = el.dataset.game;
    if (gameOpen && curGame === g) return; // даблклик по Play — не перезагружать iframe
    closeSheet();
    openGame(g);
  },
  'game-back': exitToHub,
  'play-again': () => { if (lastRound) openGame(lastRound.game); else showTab('home'); }, // legacy alias
  /* Round Complete (mockup onb1-6): «Next round» = следующий раунд как есть;
     «Repeat round» на сим-раунде онбординга откатывает trade.progress на раунд назад,
     чтобы игрок ПОВТОРИЛ тот же обучающий раунд (★ draft: механика отката моя — сим не
     трогает кошелёк, стадия откатывается вместе с раундом). На реальном раунде повтор =
     просто новый раунд той же игры (fee 100 как обычно). */
  'rc-next': () => { if (lastRound) openGame(lastRound.game); else showTab('home'); },
  'rc-repeat': () => {
    if (!lastRound) { showTab('home'); return; }
    if (lastRound.sim && FEE_GAMES.includes(lastRound.game)) {
      try {
        const p = tradeProgress();
        if ((+p.rounds || 0) > 0 && (+p.rounds || 0) <= OB_ROUNDS) {
          p.rounds = (+p.rounds || 0) - 1;
          p.stage = Math.min(+p.stage || 1, Math.min(3, p.rounds + 1));
          localStorage.setItem('trade.progress', JSON.stringify(p));
        }
      } catch (err) {}
    }
    openGame(lastRound.game);
  },

  /* tutorial */
  'tut-next': tutNext,
  'tut-skip': endTutorial,

  /* sheets/modals */
  'sheet-close': closeSheet,
  'modal-close': closeModal,
  // первая победа: Continue ведёт на отложенный Round Complete (см. handleRoundEnd)
  'firstwin-continue': () => { closeModal(); showRoundComplete(); },

  /* daily challenge */
  'open-daily': openDaily,
  'daily-pick': el => dailyPick(el.dataset.dir),
  'notifperm-predict': () => { closeSheet(); openDaily(); },

  /* shop; клики покупательного намерения логируются (webv1, встреча п.4).
     Вердикт 27.07: вместо тоста «покупок нет» — заглушка оплаты (см. openPayStub) */
  'open-offer': el => { logIntent('shop-offer-open', el.dataset.pack || 'offer-150k'); openSheet('sh-offer'); },
  // витрина стартер-пака с Home (622): тот же шит п.27 + свой intent-тег источника
  'open-starter': () => { logIntent('home-starter-open', '5k-1.99'); openSheet('sh-starter'); },
  'buy': el => {
    const pack = el.dataset.pack || null;
    logIntent(el.closest('#sh-outofchips') ? 'ooc-pack' :
      el.closest('#sh-offer') ? 'offer-sheet' : 'shop-pack', pack); // шаг 1
    const p = PACKS[pack];
    if (p) openPayStub(pack, t('stub.item.chips', p.amt), p.price);
    else toast(t('t.nopurch')); // страховка: неизвестный пак — старое поведение
  },
  'paystub-pay': () => {
    if (payStubTag) logIntent('stub-pay:' + payStubTag); // шаг 2
    $('#psConfirm').hidden = true;
    $('#psWait').hidden = false; // «Payment processing…» — не разрешается никогда
  },
  'watch-video': watchVideo,
  'open-dailyreward': () => { renderShopDailySheet(); openSheet('sh-dailyreward'); },
  'claim-dailyreward': claimShopDaily,
  'leave-review': stubToast,
  'simulate-broke': () => setBalance(0),

  /* referrals */
  'paste-ref': async () => {
    try {
      const txt = await navigator.clipboard.readText();
      if (txt) { $('#refInput').value = txt.trim().slice(0, 24); toast(t('t.pasted')); }
      else toast(t('t.clipempty'));
    } catch (err) { toast(t('t.clipna')); }
  },
  'copy-id': async () => {
    try { await navigator.clipboard.writeText('2545265426'); toast(t('t.idcopied')); }
    catch (err) { toast(t('t.yourid', '2545265426')); }
  },
  'invite-friend': async () => {
    try { await navigator.clipboard.writeText('https://tap-trading.example/invite/2545265426'); } catch (err) {}
    toast(t('t.invitecopied'));
  },

  /* peak offer — «You're on fire» (webv1, встреча п.5; клики = intent-лог).
     Вердикт 27.07: опции ведут в заглушки — курс → тиры, проп → пейстаб, академия → редирект */
  'peak-opt': el => {
    const src = el.dataset.src || 'peak-unknown';
    logIntent(src); // клик по опции пик-шита (шаг 1)
    if (src === 'peak-course') { openSheet('sh-tiers'); return; }
    if (src === 'peak-prop') { openPayStub('prop-quest', t('stub.item.prop'), '49.99$'); return; }
    if (src === 'peak-academy') { logIntent('stub-redirect:binance-academy'); openSheet('sh-redirect'); return; }
    closeSheet(); toast(t('t.peaklogged')); // страховка на неизвестный src
  },
  'peak-later': () => { logIntent('peak-later'); closeSheet(); }, // дисмисс тоже сигнал (аналитик 25.07)
  'tier-pick': el => {
    const n = Math.min(3, Math.max(1, +el.dataset.tier || 1));
    logIntent('course-tier' + n); // шаг 1
    openPayStub('course-tier' + n, t('peak.course') + ' — ' + TIER_NAMES[n - 1], TIER_PRICES[n - 1]);
  },

  /* starter pack (вердикт 31.07 п.27): Buy → заглушка оплаты, оба шага в intent-лог
     по общей схеме п.15 ('starter-pack' → 'stub-pay:starter-pack'); сумма 5 000 — ★draft */
  'starter-buy': () => {
    logIntent('starter-pack', '5k-1.99'); // шаг 1
    openPayStub('starter-pack', t('stub.item.chips', '5 000'), '1.99$');
  },

  /* referral course hook (вердикт 27.07): курс за первого заплатившего друга */
  'ref-course': () => {
    logIntent('referral-course'); // шаг 1
    openPayStub('referral-course', t('stub.item.refcourse'), t('shop.free'));
  },

  /* achievements */
  'claim-newach': () => { claimAch($('#md-newach').dataset.ach); closeModal(); },

  /* settings */
  'set-sub': el => openSub(el.dataset.sub),
  'lang-pick': el => {
    const i = +el.dataset.idx || 0;
    if (S.lang !== i) { S.lang = i; save(); }
    applyLang();                       // live switch: statics via [data-i18n]
    rerenderDynamic();                 // + JS-rendered surfaces
    if (curSub) {
      renderSubBody(curSub);           // подсветка выбора
      $('#setsubTitle').textContent = SUBS[curSub] ? t(SUBS[curSub].titleKey) : curSub;
    }
  },
  'skin-pick': el => {
    const skin = SKINS[+el.dataset.idx || 0] || 'narodny';
    if (skin !== SKIN) {
      applySkin(skin, { persist: true });     // мгновенно, без перезагрузки
      logIntent('skin-pick:' + skin);         // экспозиция когорт — тот же лог, что peak-view
    }
    if (curSub) renderSubBody(curSub);        // подсветка выбора
  },
  'open-logout': () => openSheet('sh-logout'),
  'logout-confirm': () => { closeSheet(); toast(t('t.logoutstub')); },
  'open-delete': () => openModal('md-delete'),
  'delete-confirm': () => { try { localStorage.clear(); } catch (err) {} location.reload(); },

  /* profile / save progress */
  'share-stats': async () => {
    const fav = favoriteGame();
    const text = t('t.sharestats', totalSessions(), fmt(bestWinAll()), fav ? ((GAMES[fav] || {}).name || LEGACY_NAMES[fav] || fav) : '—');
    try { await navigator.clipboard.writeText(text); toast(t('t.statscopied')); }
    catch (err) { toast(t('t.stats', text)); }
  },
  'edit-profile': stubToast,
  'open-saveprogress': () => {
    if (S.progressSaved) { toast(t('t.progalready')); return; }
    openSaveProgress();
  },
  'open-signup': startSignup,
  'signup-continue': () => { pushScreen('scr-verify'); setTimeout(() => $('.code-box').focus(), 60); },
  'social': () => { pushScreen('scr-verify'); setTimeout(() => $('.code-box').focus(), 60); },
  'verify-confirm': () => {
    const code = $$('.code-box').map(b => b.value).join('');
    // неполный код -> инлайн-ошибка по макетам *-code-error (тост vf.enter4 заменён, ★draft)
    if (code.length < 6) { showVfError(); return; }
    $$('.code-box').forEach(b => { b.value = ''; b.classList.remove('filled'); });
    clearVfError();
    finishSignupFlow();
  },

  /* misc */
  'join-tournament': () => toast(t('t.tournstub')),
  'toast': stubToast,
};

/* Re-render the JS-built surfaces after a language switch (live, no reload).
   Screens rendered on open (daily sheet, article, profile, subs) re-translate
   themselves on next open; here we refresh what persists between opens. */
function rerenderDynamic() {
  renderAch();
  renderShopDailyStrip();
  renderGuides($('#guideSearch').value);
  renderPracticeTasks();
  renderHomeHero();
  renderStarterCard();
  renderProfile();
  tickTimers();
}

document.addEventListener('click', e => {
  const actEl = e.target.closest('[data-act]');
  if (actEl) {
    const fn = ACT[actEl.dataset.act];
    if (fn) { fn(actEl, e); return; }
    stubToast();
    return;
  }
  // только кнопки Claim в списке достижений: у модалки md-newach тоже есть data-ach,
  // клик по её телу не должен молча зачислять награду
  const achBtn = e.target.closest('.ach-claim');
  if (achBtn) { claimAch(achBtn.dataset.ach); return; }
  const guide = e.target.closest('[data-guide]');
  if (guide) { openArticle(+guide.dataset.guide); return; }
  const tab = e.target.closest('#tabbar .tab');
  if (tab) { showTab(tab.dataset.tab); return; }
  const chip = e.target.closest('#catChips .chip');
  if (chip) {
    $$('#catChips .chip').forEach(c => c.classList.toggle('active', c === chip));
    const cat = chip.dataset.cat;
    $$('#gameCards .gcard').forEach(c => { c.style.display = (cat === 'all' || c.dataset.cat === cat) ? '' : 'none'; });
    return;
  }
  const tut = e.target.closest('#tutorial');
  if (tut) tutNext(); // tap anywhere on the overlay advances
});

$('#guideSearch').addEventListener('input', e => renderGuides(e.target.value));
$('#draftToggle').addEventListener('change', e => {
  S.drafts = e.target.checked;
  save();
  document.body.classList.toggle('drafts-on', S.drafts);
});

/* ---------- boot ---------- */
const VISIT_GAP = 30 * 60 * 1000; // тишина ≥30 мин = новая сессия-визит (вердикт 31.07 п.27)
(function boot() {
  if (!S.started) S.started = Date.now();
  if (!S.offerEnd || S.offerEnd - Date.now() > OFFER_CYCLE) S.offerEnd = Date.now() + OFFER_CYCLE;
  // сессия-ВИЗИТ (вердикт 31.07 п.27, стартер-пак «со второй сессии»): счётчики
  // sessionTriggers/ачивок считают сыгранные РАУНДЫ («session» там = раунд), а стартер-паку
  // нужна сессия-визит. Загрузка после ≥30 мин тишины = новый визит; перезагрузка страницы
  // внутри визита счётчик не наращивает (S.visit.last освежает минутный heartbeat ниже)
  if (Date.now() - S.visit.last > VISIT_GAP) S.visit.n++;
  S.visit.last = Date.now();
  setInterval(() => { S.visit.last = Date.now(); save(); }, 60000);
  save();
  try { localStorage.setItem('hub.balance', String(balance)); } catch (e) {}

  document.body.classList.toggle('drafts-on', S.drafts);
  $('#draftToggle').checked = S.drafts;
  const dot = $('#bellDot'); if (dot) dot.hidden = S.bellSeen;

  // экспозиция скина — в intent-лог по образцу peak-view (когортная симуляция, ★ draft)
  logIntent('skin-view:' + SKIN);

  applyLang(); // statics via [data-i18n] in the persisted S.lang, before first paint of renders below
  renderBalance();
  // home header identity = имя из профиля (у приложения нет username, ★draft вердикта 30.07):
  // «John Carter» в макете — сэмпл; берём живое отображаемое имя профиля + инициалы
  (function syncHomeIdentity() {
    const pn = ($('#profName') && $('#profName').textContent.trim()) || 'John Carter';
    const un = $('#homeUserName'); if (un) un.textContent = pn;
    const av = $('#homeAvatar');
    if (av) av.textContent = pn.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  })();
  renderHomeHero();
  renderStarterCard();
  renderAch();
  renderShopDailyStrip();
  renderGuides('');
  renderPracticeTasks();
  tickTimers();
  setInterval(tickTimers, 1000);

  resolveDailyBet(); // нерешённая ставка дейлика решается при заходе в новый UTC-день
  refreshBTC();      // прогрев цен BTC для шита дейлика (оффлайн — молча, кэш с пометкой)

  if (!S.seenWelcome) { activate('scr-welcome'); welcomeArmedAt = performance.now(); }
  else showTab('home');
})();

/* QA / debug hook (not part of the UI) */
window.HUB = {
  openGame, credit, setBalance,
  state: () => S,
  balance: () => balance,
  daily: { resolve: resolveDailyBet, refresh: refreshBTC, render: renderDailySheet },
};
