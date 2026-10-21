// Тест оформления заказа: вход по коду из SMS или письма, карточка → корзина → оформление → заказ.
// Каждый шаг замеряется: время от нажатия до готовности, запросы, ошибки, отклик кнопки, кадры экрана.
// Телефон, почта и код не сохраняются в текстах отчёта и журнале (в адресах запросов заменены на •••).
// Страница не размывается: на экране и на кадрах отчёта всё видно как есть.
import readline from 'node:readline';
import { makeInternalMatcher, serviceOf } from './services.js';
import { actionText, actionLabel, KEY_OF } from './checkout-config.js';
import { findAddressField, typeAddress, waitSuggestions, addressError, fillCourierFields, dateTimeOptions, pickOption } from './checkout-delivery.js';
import { closeKnownPopups, clearCover, discoverCartUrl, hintsFor, HintedError, Popups, autoLocator, planVariant } from './checkout-auto.js';

// Журнал закрытых всплывающих окон текущего теста (нужен в press, который вызывается из многих мест)
let POPUPS = new Popups();
// Время первого нажатия в текущем шаге: шаг с нажатием считается от него, а поиск кнопки в замер не входит
let FIRST_PRESS = null;

// ───────── Ввод в Терминале ─────────
// Одна очередь строк на весь запуск: работает и в Терминале, и при подаче ответов через stdin (для проверки).
export class Prompt {
  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    this.queue = [];
    this.waiter = null;
    this.muted = false;
    this.prompt = '';
    this.onAbort = null;
    const write = this.rl._writeToOutput?.bind(this.rl);
    // Скрытый ввод: вместо символов — точки; подсказка выводится как есть
    if (write) this.rl._writeToOutput = (s) => {
      if (!this.muted) return write(s);
      if (/^[\r\n]+$/.test(s)) return write(s);
      if (s.startsWith(this.prompt)) return write(this.prompt + '•'.repeat([...s.slice(this.prompt.length)].length));
      write('•'.repeat([...s].length));
    };
    this.rl.on('line', (l) => {
      this.muted = false;
      if (this.waiter) { const w = this.waiter; this.waiter = null; w.resolve(l); } else this.queue.push(l);
    });
    this.rl.on('SIGINT', () => this.abort());
    this.rl.on('close', () => { if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(new Abort('ввод закрыт')); } });
  }
  abort() {
    this.aborted = true;
    process.stdout.write('\n⏹ Остановка по Ctrl+C — выхожу из аккаунта и закрываю браузер…\n');
    if (this.waiter) { const w = this.waiter; this.waiter = null; w.reject(new Abort('остановлено')); }
    this.onAbort?.();
  }
  ask(question, { hidden = false } = {}) {
    if (this.aborted) return Promise.reject(new Abort('остановлено'));
    this.prompt = question;
    process.stdout.write(question);
    if (this.queue.length) {
      const l = this.queue.shift();
      process.stdout.write(hidden ? '•'.repeat(l.length) + '\n' : l + '\n');
      return Promise.resolve(l);
    }
    this.muted = hidden && !!process.stdin.isTTY;
    return new Promise((resolve, reject) => { this.waiter = { resolve, reject }; });
  }
  close() { this.rl.close(); }
}

export class Abort extends Error {}

// ───────── Личные данные ─────────
// Секреты (телефон, почта, код, имя) — только в памяти; ими же чистятся адреса запросов в отчёте
export class Secrets {
  constructor() { this.list = []; }
  add(v) {
    if (!v) return;
    v = String(v).trim();
    if (v.length < 3) return;
    this.list.push(v);
    const digits = v.replace(/\D/g, '');
    // Последние цифры номера сайты показывают открыто («***-12-34») — их тоже прячем
    if (digits.length >= 10) this.list.push(digits, digits.slice(-10), `${digits.slice(-4, -2)}-${digits.slice(-2)}`);
    if (v.includes('@')) this.list.push(encodeURIComponent(v));
  }
  clean(s) {
    let out = String(s ?? '');
    for (const x of [...this.list].sort((a, b) => b.length - a.length)) out = out.split(x).join('•••');
    return out;
  }
  url(u) {
    let x;
    try { x = new URL(u); } catch { return this.clean(u); }
    x.hash = '';
    const keys = /phone|tel|mail|login|name|fio|code|otp|sms|token|pass|session|auth|user|card|pan|cvv/i;
    for (const [k, v] of [...x.searchParams]) {
      if (keys.test(k) || /@|\d{7,}/.test(v)) x.searchParams.set(k, '•••');
    }
    return this.clean(x.href.replace(/%E2%80%A2/g, '•'));
  }
}

// Отклик на нажатие (Event Timing) и долгие задачи JS — с отметкой времени от эпохи, чтобы разложить по шагам
const PERF_INIT = `(() => {
  if (window.top !== window || window.__ssaPerf) return;
  const P = (window.__ssaPerf = { ev: [], lt: [] });
  const t0 = performance.timeOrigin;
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => P.ev.push([e.name, t0 + e.startTime, e.duration]))).observe({ type: 'event', buffered: true, durationThreshold: 16 }); } catch (e) {}
  try { new PerformanceObserver((l) => l.getEntries().forEach((e) => P.lt.push([t0 + e.startTime, e.duration]))).observe({ type: 'longtask', buffered: true }); } catch (e) {}
})();`;

// ───────── Поиск и нажатие кнопок ─────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function candidates(scope, a) {
  if (a.css) return [scope.locator(a.css)];
  const name = a.text;
  return [
    scope.getByRole('button', { name, exact: true }),
    scope.getByRole('link', { name, exact: true }),
    scope.getByText(name, { exact: true }),
    scope.getByRole('button', { name }),
    scope.getByRole('link', { name }),
    scope.getByText(name),
  ];
}

// Первый видимый элемент из списка вариантов; ждёт до timeout
// Кнопка товара из блока рекомендаций («С этим товаром покупают», карусели): у ближайшей карточки — ссылка на другой товар
// с картинкой и нет заголовка h1 страницы. Для «В корзину» такие кнопки пропускаются, чтобы не положить в корзину чужой товар
const RECO_FN = `(el) => {
  const path = location.pathname.replace(/[/]+$/, '');
  const RE = /recommend|similar|related|upsell|cross-?sell|accessor|also|viewed|carousel|slider|swiper|product-?list|products-?list|card-?list|rekomend/i;
  const H = /рекоменд|похожие|с этим товаром|вам может|смотрели|аксессуар|покупают вместе|подойдут/i;
  for (let n = el.parentElement, up = 0; n && n !== document.body && up < 12; n = n.parentElement, up++) {
    if (n.querySelector('h1')) return false;
    const cls = (typeof n.className === 'string' ? n.className : '') + ' ' + (n.id || '');
    if (RE.test(cls)) return true;
    const h = n.querySelector('h2, h3, h4, [class*=title i]');
    if (h && h !== el && H.test((h.innerText || '').slice(0, 80))) return true;
    const other = [...n.querySelectorAll('a[href]')].some((a) => {
      try { const u = new URL(a.href); return u.host === location.host && u.pathname.replace(/[/]+$/, '') !== path && u.pathname.split('/').filter(Boolean).length >= 2 && a.querySelector('img, picture'); } catch { return false; }
    });
    if (other) return true;
  }
  return false;
}`;
const isReco = eval(RECO_FN);

export async function findFirst(scope, actions, { timeout = 15000, mainOnly = false, avoid = null } = {}) {
  // avoid — кнопки, которые на этом шаге нажимать нельзя (например, «Оформить заказ» при переходе к оформлению)
  const avoidRe = avoid?.length ? new RegExp(`^\\s*(${avoid.filter((a) => a.text).map((a) => a.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*$`, 'i') : null;
  const until = Date.now() + timeout;
  do {
    for (const a of actions || []) {
      if (a.auto) {
        const el = await autoLocator(scope, a.auto);
        if (el && (await el.isVisible().catch(() => false))) return { el, label: labelOf(a) };
        continue;
      }
      const locs = candidates(scope, a);
      for (const [li, loc] of locs.entries()) {
        const n = await loc.count().catch(() => 0);
        for (let i = 0; i < Math.min(n, mainOnly ? 30 : 6); i++) {
          const el = loc.nth(i);
          if (!(await el.isVisible().catch(() => false))) continue;
          if (mainOnly && (await el.evaluate(isReco).catch(() => false))) continue;
          if (avoidRe && avoidRe.test((await el.innerText().catch(() => '')) || '')) continue;
          // Частичное совпадение текста («Продолжить» → «Продолжить покупки») не должно уводить с пути оформления
          if (a.text && li >= 3 && STOP_RE.test((await el.innerText().catch(() => '')) || '')) continue;
          return { el, label: labelOf(a) };
        }
      }
    }
    await sleep(250);
  } while (Date.now() < until);
  return null;
}

const labelOf = (a) => actionLabel(a);
// Кнопка меню (☰) — в ней на смартфонах часто спрятан вход
const MENU_ACTIONS = [
  { css: 'button[class*=burger i]' }, { css: '[class*=burger i][role=button]' }, { css: 'button[class*=hamburger i]' },
  { css: '[aria-label="Меню" i]' }, { css: '[aria-label*="открыть меню" i]' }, { css: 'button[class*=menu-toggle i]' }, { css: '[class*=burger i]' },
];
// Кнопки, уводящие с пути оформления: при частичном совпадении текста не нажимаются
const STOP_RE = /продолжить покупки|вернуться|в каталог|на главную|назад|отмен|удалить|очистить|выйти|избранн|сравнени|поделиться|быстрый заказ|купить в 1 клик|в один клик/i;

// Нажатие как у человека; если кнопку перекрывает плашка (cookies, баннер приложения), — нажатие прямо по элементу
async function press(el) {
  await el.scrollIntoViewIfNeeded().catch(() => {});
  // Окно поверх страницы (промо, подписка, регион) перекрывает кнопку — закрыть его, как сделал бы покупатель
  await clearCover(el, POPUPS);
  FIRST_PRESS ??= Date.now();
  try {
    await el.click({ timeout: 5000 });
  } catch (e) {
    // Кнопку перекрыла плашка или она спряталась при прокрутке (дубль в «липкой» панели) — нажатие прямо по элементу
    if (!(await el.evaluate((x) => x.isConnected && !x.disabled).catch(() => false))) throw e;
    await el.evaluate((x) => { x.scrollIntoView({ block: 'center' }); x.click(); });
  }
}

// Плашки, которые мешают нажимать (cookies, «скачайте приложение»): закрываются перед каждым шагом, если видны
async function dismiss(page, list) {
  if (!list?.length) return;
  for (const a of list) {
    const f = await findFirst(page, [a], { timeout: 0 });
    if (f) await f.el.click({ timeout: 2000 }).catch(() => {});
  }
}

async function clickFirst(scope, actions, what, opts = {}) {
  if (!actions?.length && opts.field) throw await notFound(scope, opts.field, `в checkout.txt не указано «${KEY_OF[opts.field]} = …» (${what}) — впишите текст кнопки, как на сайте; варианты с этой страницы — ниже`);
  const f = await findFirst(scope, actions, opts);
  if (!f && opts.field) throw await notFound(scope, opts.field, `не найдена кнопка «${actionText(actions)}» (${what}). Проверьте текст в checkout.txt — он должен совпадать с надписью на сайте`);
  if (!f) throw new StepError(`не найдена кнопка «${actionText(actions)}» (${what}). Проверьте текст в checkout.txt — он должен совпадать с надписью на сайте`);
  await press(f.el);
  return f.label;
}

export class StepError extends Error {}

// Ошибка «не найдено» с подсказкой: похожие элементы на странице и готовые строки для checkout.txt
async function notFound(scope, field, message) {
  const page = typeof scope.mainFrame === 'function' ? scope : scope.page?.();
  return new HintedError(message, field, await hintsFor(page, field));
}

// ───────── Запись сети и кадров ─────────
class Recorder {
  constructor(context, page, cdp, isInternal, secrets) {
    this.reqs = [];
    this.frames = [];
    this.byReq = new Map();
    this.isInternal = isInternal;
    this.secrets = secrets;
    this.navs = [];
    context.on('request', (r) => {
      let host = '';
      try { host = new URL(r.url()).hostname; } catch {}
      const rec = { url: r.url(), host, type: r.resourceType(), method: r.method(), start: Date.now(), end: null, status: null, failed: null };
      this.byReq.set(r, rec);
      this.reqs.push(rec);
    });
    context.on('response', (res) => { const x = this.byReq.get(res.request()); if (x) x.status = res.status(); });
    context.on('requestfinished', (r) => {
      const x = this.byReq.get(r);
      if (!x) return;
      x.end = Date.now();
      // Ожидание первого байта ответа (сервер + задержка сети) и скачивание — чтобы отличать медленный сервер от большого ответа
      const t = r.timing();
      if (t && t.requestStart >= 0 && t.responseStart > t.requestStart) {
        x.wait = Math.round(t.responseStart - t.requestStart);
        if (t.responseEnd > t.responseStart) x.download = Math.round(t.responseEnd - t.responseStart);
      }
      r.sizes().then((z) => { x.size = z.responseBodySize; }).catch(() => {});
    });
    context.on('requestfailed', (r) => { const x = this.byReq.get(r); if (x) { x.end = Date.now(); x.failed = r.failure()?.errorText || 'ошибка'; } });
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) this.navs.push(Date.now()); });
    this.cdp = cdp;
    cdp.on('Page.screencastFrame', (e) => {
      cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
      const ts = Date.now();
      if (this.frames.length && ts - this.frames.at(-1).ts < 120) this.frames[this.frames.length - 1] = { ts, data: e.data };
      else this.frames.push({ ts, data: e.data });
      if (this.frames.length > 4000) this.frames.splice(0, 1000);
    });
  }
  async startScreencast(width) {
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 45, maxWidth: width, maxHeight: 560, everyNthFrame: 1 }).catch(() => {});
  }
  // Ждём, пока затихнут свои запросы (кроме долгих фоновых) — это и есть «шаг готов»
  async settle(page, t0, { cap = 30000, quiet = 800 } = {}) {
    const until = t0 + cap;
    await sleep(150);
    if (this.navs.some((t) => t >= t0)) await page.waitForLoadState('load', { timeout: Math.max(1000, until - Date.now()) }).catch(() => {});
    let calm = null;
    while (Date.now() < until) {
      const now = Date.now();
      const busy = this.reqs.some((r) => r.end == null && r.start >= t0 - 50 && now - r.start < 10000 && this.isInternal(r.host) && !['websocket', 'eventsource', 'media'].includes(r.type));
      const fresh = this.reqs.some((r) => r.start >= now - quiet && r.start >= t0 && this.isInternal(r.host));
      if (!busy && !fresh) { if (calm == null) calm = now; if (now - calm >= quiet) break; } else calm = null;
      await sleep(100);
    }
  }
  slice(t0, t1) {
    const reqs = this.reqs.filter((r) => r.start >= t0 - 20 && r.start <= t1).map((r) => {
      const svc = serviceOf(r.url);
      return {
        url: this.secrets.url(r.url), host: r.host, internal: this.isInternal(r.host), service: this.isInternal(r.host) ? 'свой' : svc.name,
        type: r.type, method: r.method, status: r.failed ? 'FAILED' : r.end == null ? 'PENDING' : r.status ?? 0, error: r.failed ? this.secrets.clean(r.failed) : '',
        start: r.start - t0, dur: (r.end ?? t1) - r.start, pending: r.end == null,
        ...(r.wait != null ? { wait: r.wait } : {}), ...(r.download != null ? { download: r.download } : {}), ...(r.size != null ? { size: r.size } : {}),
      };
    });
    return reqs;
  }
  // До maxN кадров за шаг: первый, последний и равномерно между ними; одинаковые подряд не повторяются
  framesFor(t0, t1, maxN = 8) {
    const before = this.frames.filter((f) => f.ts < t0).at(-1);
    const inside = this.frames.filter((f) => f.ts >= t0 && f.ts <= t1 + 300);
    const all = [...(before ? [{ ...before, ts: t0 }] : []), ...inside];
    if (all.length <= maxN) return all.map((f) => ({ t: f.ts - t0, data: f.data }));
    const pick = new Set([0, all.length - 1]);
    for (let i = 1; pick.size < maxN && i < maxN - 1; i++) pick.add(Math.round((i * (all.length - 1)) / (maxN - 1)));
    return [...pick].sort((a, b) => a - b).map((i) => ({ t: all[i].ts - t0, data: all[i].data }));
  }
  lastFrame(t0, t1) {
    const f = this.frames.filter((x) => x.ts >= t0 && x.ts <= t1).at(-1);
    return f ? f.ts - t0 : null;
  }
}

async function perfSince(page, t0) {
  try {
    const p = await page.evaluate(() => window.__ssaPerf || { ev: [], lt: [] });
    const ev = p.ev.filter(([n, s]) => s >= t0 - 30 && ['pointerdown', 'pointerup', 'click', 'keydown', 'keyup', 'input'].includes(n));
    const lt = p.lt.filter(([s]) => s >= t0 - 30);
    return { click: ev.length ? Math.round(Math.max(...ev.map((e) => e[2]))) : null, longTasks: Math.round(lt.reduce((a, [, d]) => a + d, 0)), longCount: lt.length };
  } catch { return { click: null, longTasks: 0, longCount: 0 }; }
}

async function navMetrics(page) {
  try {
    return await page.evaluate(() => {
      const n = performance.getEntriesByType('navigation')[0];
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
      return n ? { ttfb: Math.round(n.responseStart), fcp: fcp == null ? null : Math.round(fcp), dcl: Math.round(n.domContentLoadedEventEnd), load: n.loadEventEnd ? Math.round(n.loadEventEnd) : null } : null;
    });
  } catch { return null; }
}

// ───────── Сценарий ─────────
const ID_SEL = {
  phone: 'input[type=tel], input[name*=phone i], input[autocomplete=tel], input[id*=phone i], input[inputmode=tel], input[placeholder*="телефон" i], input[placeholder*="+7"], input[aria-label*="телефон" i], input[data-ssa-id=phone]',
  email: 'input[type=email], input[name*=mail i], input[autocomplete=email], input[id*=mail i], input[inputmode=email], input[placeholder*="почт" i], input[placeholder*="mail" i], input[aria-label*="почт" i], input[data-ssa-id=email]',
};
// Поле без явных признаков (type=text, без name и placeholder): распознаётся по надписи рядом —
// «Номер телефона», «Телефон», «E-mail». Подходят только поля, появившиеся после нажатий (без data-ssa-pre).
const MARK_ID_FN = `(method) => {
  const re = method === 'phone' ? /телефон|номер|phone/i : /почт|e-?mail|mail/i;
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; };
  for (const el of document.querySelectorAll('input:not([data-ssa-pre]):not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit]):not([type=button])')) {
    if (!vis(el)) continue;
    let label = [el.getAttribute('aria-label'), el.placeholder, el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')?.innerText, el.closest('label')?.innerText].filter(Boolean).join(' ');
    // Надпись рядом: ближайший небольшой контейнер вокруг поля
    for (let n = el.parentElement, up = 0; n && up < 3 && !re.test(label); n = n.parentElement, up++) if ((n.innerText || '').length < 120) label += ' ' + n.innerText;
    if (re.test(label) || (method === 'phone' && el.inputMode === 'numeric')) { el.setAttribute('data-ssa-id', method); return true; }
  }
  return false;
}`;
const CODE_SEL = 'input[autocomplete="one-time-code"], input[name*=code i], input[id*=code i], input[name*=otp i], input[name*=sms i], input[name*=pin i], input[inputmode=numeric]:not([type=tel]), input[maxlength="1"]';

async function visible(page, sel, { timeout = 0, not } = {}) {
  const until = Date.now() + timeout;
  do {
    const loc = page.locator(sel);
    const n = await loc.count().catch(() => 0);
    for (let i = 0; i < Math.min(n, 10); i++) {
      const el = loc.nth(i);
      if (await el.isVisible().catch(() => false)) {
        if (not && (await el.evaluate((e, ids) => ids.some((x) => e.matches(x)), not).catch(() => false))) continue;
        return el;
      }
    }
    if (timeout) await sleep(250);
  } while (Date.now() < until);
  return null;
}

// Контейнер формы (диалог/форма) вокруг поля — кнопки ищем сначала в нём, чтобы не нажать «Войти» в шапке сайта
async function scopeOf(page, el) {
  const box = el.locator('xpath=ancestor::*[self::form or @role="dialog" or contains(@class,"modal") or contains(@class,"popup") or contains(@class,"auth")][1]');
  return (await box.count().catch(() => 0)) ? box : page;
}

export async function runCheckout({ browser, profile, sc, prompt, secrets, opts, log }) {
  const origin = new URL(sc.product).origin;
  const isInternal = makeInternalMatcher(sc.product);
  const result = { steps: [], order: null, loggedIn: false, loggedOut: null, stoppedAt: null, error: null, productTitle: '', notes: [] };

  // Способ входа и логин — до открытия браузера, чтобы код не «протух», пока человек вводит телефон
  // В режиме --check (проверка сценария) вход не выполняется: гость, без кода и без заказа
  let method = null, ident = '';
  if (!opts.check) {
    method = sc.login;
    // Если в checkout.txt указан только телефон или только почта — способ входа понятен без вопроса
    if (method === 'ask' && sc.phone && !sc.email) method = 'phone';
    if (method === 'ask' && sc.email && !sc.phone) method = 'email';
    while (method === 'ask') {
      const a = (await prompt.ask('Как входить: 1 — по телефону, 2 — по почте: ')).trim().toLowerCase();
      method = /^(1|т)/.test(a) ? 'phone' : /^(2|п|e|m)/.test(a) ? 'email' : 'ask';
    }
    ident = method === 'phone' ? (sc.phone ? '+7' + sc.phone : '') : (sc.email || '');
    if (ident) log(`${method === 'phone' ? 'Телефон' : 'Почта'} из checkout.txt: ${method === 'phone' ? sc.phone : sc.email}`);
    while (!ident) {
      ident = (await prompt.ask(method === 'phone' ? 'Телефон: ' : 'Почта: ')).trim();
      if (method === 'phone' && ident.replace(/\D/g, '').length < 10) { log('  Нужен номер из 10–11 цифр, например +7 900 123-45-67'); ident = ''; }
      if (method === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(ident)) { log('  Нужен адрес почты, например name@example.com'); ident = ''; }
    }
    secrets.add(ident);
    result.method = method;
  }

  const context = await browser.newContext({ ...profile.device, ignoreHTTPSErrors: true, locale: 'ru-RU' });
  await context.addInitScript(PERF_INIT);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (profile.network) { await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', profile.network); }
  if (profile.cpu) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  const rec = new Recorder(context, page, cdp, isInternal, secrets);
  POPUPS = new Popups(log);
  result.popups = POPUPS.list;
  await rec.startScreencast(profile.device.viewport.width > 600 ? 480 : 300);
  prompt.onAbort = () => {};

  let n = 0;
  const step = async (name, fn, { cap = 30000, quiet = 800 } = {}) => {
    if (prompt.aborted) throw new Abort('остановлено');
    n++;
    log(`Шаг ${n}: ${name} …`);
    // Всплывающие окна (регион, cookies, промо и то, что указано в «закрывать») — до начала замера шага
    if (page.url() !== 'about:blank') { await closeKnownPopups(page, POPUPS); await dismiss(page, sc.dismiss); }
    let t0 = Date.now();
    const navBefore = rec.navs.length;
    const s = { n, name, action: '', error: null };
    let soft = null;
    let minDur = 0;
    FIRST_PRESS = null;
    try {
      const r = await fn();
      // Функция шага может вернуть { label, soft }: soft — ошибка, после которой сценарий продолжается (например, неверный код)
      // minDur — время, замеренное самим шагом (например, появление подсказок адреса без запросов к серверу)
      if (r && typeof r === 'object') { s.action = r.label || ''; soft = r.soft || null; minDur = r.minDur || 0; if (r.invalid) s.invalid = r.invalid; } else s.action = r || '';
      // Шаг с нажатием — от момента нажатия: время на поиск кнопки агентом к скорости сайта не относится
      if (FIRST_PRESS && FIRST_PRESS > t0) t0 = FIRST_PRESS;
      await rec.settle(page, t0, { cap, quiet });
    } catch (e) {
      s.error = secrets.clean(e.message.split('\n')[0]);
      if (e.hints?.length) s.hints = e.hints.map((h) => ({ line: `${KEY_OF[e.field] || e.field} = ${secrets.clean(h.line)}`, what: secrets.clean(h.what) }));
    }
    const t1 = Date.now();
    s.navigated = rec.navs.length > navBefore;
    s.url = secrets.url(page.url());
    s.requests = rec.slice(t0, t1);
    const ends = (list) => list.filter((r) => !r.pending).map((r) => r.start + r.dur);
    // Два времени шага:
    //  dur («контент готов») — от нажатия до последнего завершившегося своего запроса, а при переходе на новую страницу —
    //    не раньше, чем она построена (DOMContentLoaded). Зависшие внешние пиксели и счётчики его не раздувают.
    //  full («полная загрузка») — до события load и последних ответов внешних сервисов.
    const m = s.navigated ? await navMetrics(page) : null;
    const navStart = s.navigated ? rec.navs.at(-1) - t0 : 0;
    const navDcl = s.navigated && m?.dcl ? navStart + m.dcl : 0;
    const navLoad = s.navigated && m?.load ? navStart + m.load : 0;
    // Значок сайта и свои запросы, начатые уже после события load, к готовности контента не относятся
    const intEnds = ends(s.requests.filter((r) => r.internal && !/favicon/i.test(r.url) && !(navLoad && r.start > navLoad)));
    s.dur = Math.round(Math.max(200, ...intEnds, navDcl, minDur, s.error ? t1 - t0 : 0));
    s.full = Math.round(Math.max(s.dur, navLoad, ...ends(s.requests)));
    s.metrics = m;
    s.visual = rec.lastFrame(t0, t0 + s.full + 300);
    Object.assign(s, await perfSince(page, t0));
    s.frames = rec.framesFor(t0, t0 + s.full);
    if (soft) s.error = soft;
    result.steps.push(s);
    log(s.error ? `  ✗ ${s.error}` : `  ✓ ${fmt(s.dur)}${s.full - s.dur >= 1000 ? ` (полная загрузка ${fmt(s.full)})` : ''}${s.action ? ` · «${s.action}»` : ''}`);
    if (s.hints?.length) log(`  Похожие элементы на этой странице — можно вписать в checkout.txt (в секцию сайта):\n${s.hints.map((h) => `    ${h.line}      # ${h.what}`).join('\n')}`);
    if (soft) return s;
    if (s.error) throw new StepError(s.error);
    return s;
  };

  try {
    // 1. Вход
    await step('Главная страница', async () => {
      const resp = await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
      // Страница защиты от ботов вместо сайта: обходить её агент не должен — понятное объяснение вместо «кнопка не найдена»
      await sleep(1500);
      const guard = `${await page.title().catch(() => '')} ${((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 600)}`;
      if (/ddos-guard|проверка браузера|checking your browser|just a moment|attention required|captcha|подтвердите, что вы не робот/i.test(guard) || (resp && [401, 403, 429].includes(resp.status()))) {
        throw new StepError(`сайт показал страницу защиты от ботов (${(guard.match(/ddos-guard|cloudflare|qrator|captcha/i) || ['проверка браузера'])[0]}, код ответа ${resp?.status() ?? '—'}) вместо магазина — автоматический тест на нём не пройдёт. Попросите разработчиков сайта добавить ваш IP в разрешённые для защиты или проводите тест на тестовом стенде без защиты`);
      }
    });
    if (!sc.cartUrl) {
      const found = await discoverCartUrl(page);
      if (found) { sc.cartUrl = found; result.notes.push(`Адрес корзины найден автоматически: ${found}. Если он неверный, укажите «адрес корзины = …» в checkout.txt.`); log(`  Адрес корзины найден автоматически: ${found}`); }
    }
    // Проверка сценария: только убедиться, что форма входа открывается и поле находится; ничего не вводится
    if (opts.check) {
      await step('Форма входа (только проверка)', async () => (await openLoginForm(page, sc, sc.login === 'email' ? 'email' : 'phone')).label);
    }
    if (!opts.check) {
      let idField;
      await step('Форма входа', async () => {
        const r = await openLoginForm(page, sc, method);
        idField = r.field;
        return r.label;
      });

      await closeKnownPopups(page, POPUPS);
      await clearCover(idField, POPUPS);
      await idField.click();
      await idField.fill('').catch(() => {});
      await sleep(200);
      const pre = (await idField.inputValue().catch(() => '')) || '';
      let typed = ident;
      if (method === 'phone') {
        const d = ident.replace(/\D/g, '');
        typed = /^\+?7/.test(pre) || /^8/.test(pre) ? d.slice(-10) : d.length === 11 ? '+7' + d.slice(-10) : d;
      }
      await idField.pressSequentially(typed, { delay: 40 });

      const form = await scopeOf(page, idField);
      let codeField;
      // Поля, которые были на странице до отправки, — не поле кода (на некоторых сайтах поле кода того же типа, что и телефон)
      await page.evaluate(() => document.querySelectorAll('input').forEach((e) => e.setAttribute('data-ssa-pre2', ''))).catch(() => {});
      await step('Отправка кода', async () => {
        const label = await clickFirst(form, sc.sendCode, 'получить код', { timeout: 8000 }).catch(async (e) => {
          if (form === page) throw e;
          return clickFirst(page, sc.sendCode, 'получить код', { timeout: 3000, field: 'sendCode' });
        });
        codeField = await waitCode(page, sc, method, 20000);
        if (!codeField) throw new StepError('после отправки не появилось поле для кода — возможно, сайт показал капчу или ошибку (посмотрите в окне браузера)');
        return label;
      });

      for (let attempt = 1; ; attempt++) {
        if (attempt === 1) log(method === 'phone'
          ? '  Код может прийти в SMS, push-уведомлением в приложении сайта или звонком (тогда код — последние цифры номера). Другой способ можно выбрать в окне браузера, например «Запросить звонок» или «Отправить код на e-mail».'
          : '  Код придёт в письме. Если письма нет, проверьте папку «Спам».');
        const code = (await prompt.ask('Код подтверждения (пусто + Enter — отправить код ещё раз): ', { hidden: true })).trim();
        if (!code) {
          const again = await findFirst(page, sc.resendCode, { timeout: 2000 });
          if (again) { await again.el.click().catch(() => {}); log('  Код отправлен повторно'); } else log('  Кнопка повторной отправки пока недоступна — подождите и попробуйте снова');
          continue;
        }
        secrets.add(code);
        let ok = false;
        await step(attempt === 1 ? 'Проверка кода и вход' : `Проверка кода (попытка ${attempt})`, async () => {
          const f = (await waitCode(page, sc, method, 3000)) || codeField;
          await f.click().catch(() => {});
          const many = await page.locator('input[maxlength="1"]:visible').count().catch(() => 0);
          if (many < 2) await f.fill('').catch(() => {});
          await page.keyboard.type(code, { delay: 60 });
          // Многие сайты проверяют код сами после последней цифры; если поле осталось — нажимаем кнопку подтверждения
          await sleep(1200);
          let label = 'ввод кода';
          if (await codeShown(page, sc)) {
            const b = await findFirst(await scopeOf(page, f), sc.submitCode, { timeout: 1500 });
            if (b) { await b.el.click().catch(() => {}); label = b.label; }
          }
          const until = Date.now() + 20000;
          while (Date.now() < until && (await codeShown(page, sc))) await sleep(250);
          // Ещё секунда: сайт может перерисовать форму после неверного кода
          await sleep(1000);
          ok = !(await codeShown(page, sc));
          return { label, soft: ok ? null : 'код не принят' };
        }, { cap: 25000 });
        if (ok) break;
        if (attempt >= 3) throw new StepError('код не принят три раза подряд');
        log('  Поле для кода осталось на экране. Проверьте код и введите ещё раз.');
      }
      result.loggedIn = true;
    }

    // 2. Если удаление чужих товаров выключено, корзина аккаунта должна быть пустой — иначе в заказ попадут чужие товары
    result.phase = 'Проверка, что корзина пуста';
    if (sc.cleanCart && !opts.check && sc.cartUrl) {
      // Корзина аккаунта очищается до теста — и от товаров, оставшихся с прошлых тестов. Иначе на карточке вместо
      // «Добавить в корзину» будет ссылка «В корзину», и шаг «Добавление в корзину» замерит переход в корзину
      await step('Очистка корзины перед тестом', async () => {
        await page.goto(sc.cartUrl, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
        // Корзина дорисовывается скриптами: ждём товары или текст пустой корзины
        const empty = new RegExp(sc.emptyCart, 'i');
        const until = Date.now() + 15000;
        let items = [];
        while (Date.now() < until) {
          items = await cartItems(page, [], sc);
          if (items.length || empty.test((await page.locator('body').innerText().catch(() => '')) || '')) break;
          await sleep(500);
        }
        if (!items.length) return 'корзина пуста';
        const r = await cleanCart(page, sc, [], log);
        (result.removed ??= []).push(...r.removed);
        if (r.left.length) throw new StepError(`не удалось очистить корзину перед тестом: ${r.left.join('; ')} — удалите товары на сайте вручную или укажите в checkout.txt «удалить товар = …» / «меню товара = …»`);
        return `удалено: ${r.removed.length}`;
      }, { cap: 20000 });
      if (result.removed?.length) log(`  Корзина очищена перед тестом: ${result.removed.join('; ')}`);
    } else if (sc.cleanCart) {
      // гость (--check) начинает с пустой корзины; без адреса корзины чужие товары удаляются после добавления наших
    } else if (sc.cartUrl) {
      // Корзина часто дорисовывается скриптами через несколько секунд: ждём либо «корзина пуста», либо кнопку оформления
      let state = 'unknown';
      await step('Проверка, что корзина пуста', async () => {
        await page.goto(sc.cartUrl, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
        const empty = new RegExp(sc.emptyCart, 'i');
        const until = Date.now() + 30000;
        while (Date.now() < until) {
          const body = (await page.locator('body').innerText().catch(() => '')) || '';
          if (empty.test(body)) { state = 'empty'; break; }
          if (await findFirst(page, sc.toCheckout, { timeout: 0 })) { state = 'full'; break; }
          await sleep(500);
        }
        return { label: state === 'empty' ? 'корзина пуста' : state === 'full' ? 'в корзине есть товары' : 'не удалось понять', soft: state === 'empty' ? null : state === 'full' ? 'в корзине есть товары' : 'не удалось понять, пуста ли корзина' };
      }, { cap: 15000 });
      if (state === 'full') {
        throw new StepError('в корзине аккаунта уже есть товары — они попали бы в заказ. Удалите их из корзины на сайте и запустите тест снова (что было в корзине — на кадрах шага в отчёте)');
      }
      if (state === 'unknown') {
        throw new StepError('за 30 секунд на странице корзины не появилось ни «корзина пуста», ни кнопки оформления. Посмотрите кадры шага в отчёте; если корзина пуста, укажите в checkout.txt «пустая корзина = <текст, который сайт пишет в пустой корзине>»');
      }
    } else result.notes.push('Не указан «адрес корзины», а удаление других товаров выключено — агент не проверил, что корзина аккаунта была пустой перед тестом.');

    result.phase = null;
    // 3. Оформление
    const products = sc.products?.length ? sc.products : [sc.product];
    const many = products.length > 1;
    result.products = [];
    for (const [i, url] of products.entries()) {
      const nn = many ? ` ${i + 1} из ${products.length}` : '';
      if (sc.reloadProduct) {
        // Первый заход — холодный кэш; затем обновление страницы: так заходит вернувшийся покупатель (прогретый кэш),
        // и товар кладётся в корзину уже с обновлённой страницы
        await step(`Карточка товара${nn} — первый заход`, async () => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout }); });
        await step(`Карточка товара${nn} — повторно (кэш)`, async () => { await page.reload({ waitUntil: 'domcontentloaded', timeout: opts.timeout }); });
      } else {
        await step(`Карточка товара${nn}`, async () => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout }); });
      }
      const title = secrets.clean(((await page.locator('h1').first().innerText({ timeout: 3000 }).catch(() => '')) || (await page.title())).trim().replace(/\s+/g, ' ').slice(0, 140));
      const item = { url, title };
      result.products.push(item);
      // Размер / цвет / вариант: выбирается на карточке перед «В корзину» (вариант = авто | нет | значения)
      const want = Array.isArray(sc.variant) ? sc.variant : null;
      if (sc.variant !== 'none') {
        const plan = await planVariant(page, want);
        if (plan.found && (plan.missing || plan.unavailable || plan.none)) {
          await step(`Выбор размера / варианта${nn}`, async () => {
            throw new StepError(plan.missing ? `на странице нет варианта «${plan.missing}» — есть: ${plan.all.join(', ')}. Исправьте «вариант = …» в checkout.txt`
              : plan.unavailable ? `вариант «${plan.unavailable}» сейчас недоступен — есть: ${plan.all.join(', ')}. Выберите другой в «вариант = …»`
                : `все варианты товара недоступны (${plan.all.join(', ')}) — возьмите для теста другой товар`);
          });
        } else if (plan.kept) {
          item.variant = plan.kept;
          log(`  Вариант товара уже выбран: ${plan.kept}`);
        } else if (plan.pick) {
          await step(`Выбор размера / варианта${nn}`, async () => {
            await press(page.locator('[data-ssa-var]').first());
            item.variant = plan.pick;
            return `${plan.pick}${want ? '' : ' (первый доступный)'}`;
          });
        }
      }
      await step(`Добавление в корзину${nn}`, async () => {
        const add = await findFirst(page, sc.addToCart, { timeout: 10000, mainOnly: true });
        if (add) {
          const cardPath = pathOf(page.url());
          await press(add.el);
          // Сайт просит выбрать размер/цвет — выбора варианта товара пока нет: остановиться с понятным объяснением,
          // а не закрывать панель выбора как мешающее окно
          await sleep(1500);
          const ask = await page.evaluate(() => {
            const re = /выберите (размер|цвет|вариант|объ[её]м)|укажите (размер|цвет)|сначала выберите/i;
            // Только во всплывшей панели (закреплённой поверх страницы): надпись «Выберите размер» на самой карточке не в счёт
            const inPanel = (el) => { for (let n = el; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') return true; return false; };
            return [...document.querySelectorAll('body *')].some((el) => {
              const r = el.getBoundingClientRect();
              return r.width > 2 && r.height > 2 && el.children.length < 6 && re.test((el.innerText || '').slice(0, 200)) && getComputedStyle(el).visibility !== 'hidden' && inPanel(el);
            });
          }).catch(() => false);
          if (ask) {
            // Панель выбора размера открылась после нажатия: выбрать вариант в ней и нажать «В корзину» ещё раз
            if (sc.variant === 'none') throw new StepError('после «' + add.label + '» сайт просит выбрать размер или вариант, а в checkout.txt указано «вариант = нет» — уберите эту строку или укажите вариант');
            const plan = await planVariant(page, want);
            if (!plan.pick && !plan.kept) {
              throw new StepError('после «' + add.label + '» сайт просит выбрать размер или вариант, но агент не нашёл, что выбрать' +
                (plan.all ? ` (есть: ${plan.all.join(', ')})` : '') + '. Укажите «вариант = …» в checkout.txt (текст размера или цвета, как на сайте)');
            }
            if (plan.pick) { await press(page.locator('[data-ssa-var]').first()); item.variant = plan.pick; }
            await sleep(800);
            const again = await findFirst(page, sc.addToCart, { timeout: 3000, mainOnly: true });
            if (again) await press(again.el);
            return `${add.label} → вариант ${item.variant || plan.kept}${again ? ` → ${again.label}` : ''}`;
          }
          // Кнопка увела в корзину вместо добавления (товар уже лежал в корзине): замерен переход, а не добавление —
          // шаг помечается, по нему нет выводов и сравнения
          const now = pathOf(page.url());
          if (now !== cardPath && (now === pathOf(sc.cartUrl || '') || /\/(cart|basket|korzina)(\/|$)/i.test(now))) {
            result.notes.push(`«${add.label}» на карточке «${title}» открыла корзину, а не добавила товар (он уже был в корзине). Время этого шага — переход в корзину; выводов по нему нет.`);
            log('  Кнопка открыла корзину, а не добавила товар (он уже был в корзине) — шаг помечен, выводов по нему нет');
            return { label: `${add.label} — открылась корзина (товар уже был в корзине)`, invalid: 'кнопка открыла корзину вместо добавления товара' };
          }
          return add.label;
        }
        // Товар уже в корзине (например, остался с прошлого запуска): вместо «Купить» на карточке кнопка «Оформить» / «В корзине»
        const inCart = await findFirst(page, sc.toCart, { timeout: 0 });
        if (inCart) { result.notes.push(`Товар «${title}» уже был в корзине до теста — повторно не добавлялся.`); log('  Товар уже в корзине — повторно не добавляется'); return 'уже в корзине'; }
        throw await notFound(page, 'addToCart', `не найдена кнопка «${actionText(sc.addToCart)}» (в корзину). Проверьте текст в checkout.txt — он должен совпадать с надписью на сайте`);
      });
    }
    result.productTitle = result.products.map((x) => x.title + (x.variant ? ` (вариант: ${x.variant})` : '')).join('; ');
    await step('Корзина', async () => {
      const f = await findFirst(page, sc.toCart, { timeout: 6000 });
      if (f) {
        const before = page.url();
        await press(f.el).catch(() => {});
        // Если по кнопке в корзину не перешли — открываем адрес корзины из настроек
        await page.waitForURL((u) => u.href !== before, { timeout: 8000 }).catch(() => {});
        if (page.url() !== before || !sc.cartUrl) return f.label;
      }
      if (!sc.cartUrl) throw await notFound(page, 'toCart', `не найдена кнопка «${actionText(sc.toCart)}» — укажите в checkout.txt «перейти в корзину = …» или «адрес корзины = …»`);
      // Шаг считается от открытия адреса корзины: ожидание перехода по кнопке — не время сайта
      FIRST_PRESS = Date.now();
      await page.goto(sc.cartUrl, { waitUntil: 'domcontentloaded', timeout: opts.timeout });
      return 'адрес корзины';
    });
    // Корзина дорисовывается скриптами: ждём, пока появятся наши товары
    const ours = result.products;
    const missing = await waitOurItems(page, ours, 15000, sc);
    // Товары, которые лежали в корзине до теста, удаляются — в заказ попадут только товары из checkout.txt
    if (sc.cleanCart) {
      const items = await cartItems(page, ours, sc);
      const foreign = items.filter((x) => !x.ours);
      if (foreign.length) {
        await step('Удаление других товаров из корзины', async () => {
          const r = await cleanCart(page, sc, ours, log);
          (result.removed ??= []).push(...r.removed);
          if (r.left.length) throw new StepError(`не удалось удалить из корзины: ${r.left.join('; ')} — удалите вручную или укажите в checkout.txt «удалить товар = …» / «меню товара = …»`);
          return { label: `удалено: ${r.removed.length}` };
        }, { cap: 20000 });
        log(`  Удалены товары, которые были в корзине до теста: ${result.removed.join('; ')}`);
      }
    }
    // В корзине должны быть именно наши товары: кнопка «Купить» могла сработать у товара из рекомендаций
    const notFound = missing.length ? await waitOurItems(page, ours, 5000, sc) : [];
    if (notFound.length) {
      result.steps.at(-1).error = 'в корзине не найден нужный товар';
      throw new StepError(`в корзине не найден товар «${notFound.map((x) => x.title).join('», «')}» — возможно, кнопка добавила другой товар. Уточните «в корзину = …» в checkout.txt`);
    }
    // Корзина могла сразу открыть оформление (кнопка «Оформить» в окне «Товар добавлен»). Тогда шаг «к оформлению» не нужен:
    // на странице оформления «Оформить» совпало бы с кнопкой «Оформить заказ» и заказ ушёл бы до выбора доставки
    const leftCart = sc.cartUrl ? pathOf(page.url()) !== pathOf(sc.cartUrl) : !!(await findFirst(page, sc.placeOrder, { timeout: 0 }));
    const atCheckout = leftCart && sc.delivery?.length && (await findFirst(page, sc.delivery, { timeout: 2000 }));
    if (atCheckout) log('  Корзина сразу открыла оформление — шаг «Переход к оформлению» не нужен');
    // Не на странице корзины — кнопку «Оформить заказ» на этом шаге не нажимать (на странице корзины она бывает переходом к оформлению)
    else await step('Переход к оформлению', () => clickFirst(page, sc.toCheckout, 'к оформлению', { field: 'toCheckout', avoid: leftCart ? sc.placeOrder : null }));
    await step('Способ получения', () => clickFirst(page, sc.delivery, 'способ получения', { field: 'delivery' }));
    // Доставка курьером: адрес (с подсказками), квартира и получатель, дата и интервал. Магазин в этом сценарии не выбирается
    if (sc.address) await courierSteps(page, sc, step, method === 'phone' ? ident : (sc.phone ? '+7' + sc.phone : ''), log);
    if (sc.store && !sc.address) {
      await step('Выбор магазина / пункта', async () => {
        // Список вместо карты, если сайт сначала показывает карту
        if (sc.storeList) { const l = await findFirst(page, sc.storeList, { timeout: 5000 }); if (l) { await l.el.click().catch(() => {}); await sleep(800); } }
        const st = await findFirst(page, sc.store, { timeout: 15000 });
        if (!st) throw await notFound(page, 'store', `не найден магазин или пункт «${actionText(sc.store)}» — проверьте «магазин = …» в checkout.txt`);
        await st.el.scrollIntoViewIfNeeded().catch(() => {});
        if (!sc.storeConfirm) { await press(st.el); return st.label; }
        // Кнопка подтверждения («Забрать здесь») — в карточке именно этого магазина: ищем её, поднимаясь от названия вверх
        for (let up = 1; up <= 8; up++) {
          const box = st.el.locator(`xpath=ancestor::*[${up}]`);
          const b = await findFirst(box, sc.storeConfirm, { timeout: 0 });
          if (b) { await press(b.el); return `${st.label} → ${b.label}`; }
        }
        throw await notFound(page, 'storeConfirm', `рядом с магазином «${st.label}» не найдена кнопка «${actionText(sc.storeConfirm)}»`);
      });
    }
    await step('Способ оплаты', () => clickFirst(page, sc.payment, 'способ оплаты', { field: 'payment' }));
    // Имя клиента из формы — тоже в секреты, чтобы заменить его на ••• в адресах запросов отчёта
    for (const v of await page.locator('input:visible').evaluateAll((els) => els.map((e) => e.value).filter((x) => x && x.length > 2 && x.length < 80)).catch(() => [])) secrets.add(v);
    for (const a of sc.beforeOrder || []) await step(`Действие перед оформлением: ${a.text ?? a.css}`, () => clickFirst(page, [a], 'перед оформлением'));

    if (opts.noOrder) {
      result.stoppedAt = 'без заказа';
      const b = await findFirst(page, sc.placeOrder, { timeout: 5000 });
      log(b ? `Кнопка «${b.label}» найдена и не нажата — заказ не создан.` : `⚠ Кнопка «${actionText(sc.placeOrder)}» не найдена на странице — проверьте «оформить = …» в checkout.txt. Заказ не создан.`);
      if (!b) result.notes.push(`Кнопка оформления «${actionText(sc.placeOrder)}» не найдена на последнем шаге — проверьте «оформить = …» в checkout.txt.`);
    } else {
      const s = await step('Оформление заказа', () => clickFirst(page, sc.placeOrder, 'оформить заказ', { field: 'placeOrder' }), { cap: 60000, quiet: 1200 });
      const url = page.url();
      const host = new URL(url).hostname;
      const body = (await page.locator('body').innerText().catch(() => '')) || '';
      const num = /(?:заказ[а]?|order)[^\n\d]{0,25}?(?:№|#|номер)?\s*:?\s*([A-ZА-Я]{0,4}-?\d[\d-]{3,})/i.exec(body)?.[1]
        || /(?:order(?:_?id|_?number)?|orderId|ORDER_ID|zakaz)=([\w-]{4,})/i.exec(url)?.[1] || null;
      result.order = {
        number: num,
        paymentForm: !isInternal(host),
        paymentHost: !isInternal(host) ? host : null,
        confirmed: !!num || new RegExp(sc.success, 'i').test(body) || !isInternal(host),
        url: secrets.url(url),
      };
      if (result.order.paymentForm) {
        s.name = 'Оформление заказа и переход к оплате';
        log(`  Открылась форма оплаты (${host}). Данные карты агент не вводит — заказ останется неоплаченным.`);
      }
      log(result.order.confirmed
        ? `✓ Заказ ${num ? `№ ${num} ` : ''}оформлен. Не забудьте отменить его.`
        : '⚠ Не удалось подтвердить, что заказ создан (не найден номер или текст «заказ оформлен»). Проверьте в личном кабинете.');
    }
  } catch (e) {
    if (e instanceof Abort) result.stoppedAt = 'остановлено вручную';
    else { result.error = secrets.clean(e.message.split('\n')[0]); result.stoppedAt = result.phase ?? result.steps.at(-1)?.name ?? 'начало'; }
    if (!(e instanceof Abort) && !(e instanceof StepError)) log(`✗ ${result.error}`);
    else if (e instanceof StepError && !result.steps.at(-1)?.error) log(`✗ ${result.error}`);
  } finally {
    // 4. Выход из аккаунта и закрытие браузера: cookies и данные сайта удаляются вместе с одноразовым профилем
    if (result.loggedIn) result.loggedOut = await logout(page, sc, origin, opts).catch(() => false);
    await context.clearCookies().catch(() => {});
    await context.close().catch(() => {});
    if (result.loggedIn && !result.loggedOut) log('⚠ Кнопка «Выйти» не найдена — сессия на сайте закрыта только удалением cookies. Если нужно, завершите сеансы в личном кабинете.');
    else if (result.loggedIn) log('✓ Выход из аккаунта выполнен');
    log('✓ Браузер закрыт, cookies и данные сайта удалены');
    const left = result.loggedIn && !result.order && result.steps.some((s) => s.name.startsWith('Добавление в корзину') && !s.error);
    if (left) log('⚠ Тест не дошёл до заказа — добавленные товары остались в корзине вашего аккаунта.');
  }
  return result;
}

// Открыть форму входа: на многих сайтах это цепочка («Профиль» → «Войти или зарегистрироваться» → «По телефону»).
// Подходит только поле, которое появилось после нажатий, — не подписка на рассылку в подвале страницы.
async function openLoginForm(page, sc, method) {
  // Поля, видимые до нажатий, — не форма входа (поиск, подписка). Скрытые заранее формы входа (лежат в коде страницы) не помечаются
  await page.evaluate((sel) => document.querySelectorAll(sel).forEach((e) => { const r = e.getBoundingClientRect(); if (r.width > 2 && r.height > 2) e.setAttribute('data-ssa-pre', ''); }), 'input').catch(() => {});
  const sel = ID_SEL[method].split(',').map((x) => `${x.trim()}:not([data-ssa-pre])`).join(', ');
  const by = method === 'phone' ? sc.byPhone : sc.byEmail;
  const clicked = new Set();
  const labels = [];
  for (let round = 0; round < 5; round++) {
    // Форма входа на медленном смартфоне появляется не сразу
    if (round) await sleep(1000);
    await page.evaluate(`(${MARK_ID_FN})(${JSON.stringify(method)})`).catch(() => {});
    const field = await visible(page, sel, { timeout: round ? 4000 : 0 });
    if (field) return { field, label: labels.join(' → ') };
    const b = await findFirst(page, by.filter((a) => !clicked.has(labelOf(a))), { timeout: round ? 1500 : 0 });
    // Если нажатие сорвалось (страница перерисовалась, кнопка заменилась новой) — кнопка ищется заново в следующем круге
    if (b) { if (await press(b.el).then(() => true, () => false)) { clicked.add(b.label); labels.push(b.label); } continue; }
    const o = await findFirst(page, sc.openLogin.filter((a) => !clicked.has(labelOf(a))), { timeout: round ? 3000 : 8000 });
    if (!o) {
      // На смартфонах вход часто спрятан в меню (☰): открыть меню один раз и искать вход в нём
      if (clicked.has('меню')) break;
      const menu = await findFirst(page, MENU_ACTIONS, { timeout: 0 });
      if (!menu) break;
      clicked.add('меню');
      if (await press(menu.el).then(() => true, () => false)) labels.push('меню');
      await sleep(800);
      continue;
    }
    if (await press(o.el).then(() => true, () => false)) { clicked.add(o.label); labels.push(o.label); }
  }
  throw await notFound(page, 'openLogin', `не найдено поле ${method === 'phone' ? 'телефона' : 'почты'} в форме входа${labels.length ? ` (нажато: ${labels.join(' → ')})` : ''} — проверьте «открыть вход» и «вход по ${method === 'phone' ? 'телефону' : 'почте'}» в checkout.txt`);
}

// Поле кода — поле, которое появилось после нажатия «Получить код» (отмечены data-ssa-pre2 до нажатия).
// Найденные поля помечаются data-ssa-code, чтобы потом понять, закрылась ли форма.
async function waitCode(page, sc, method, timeout) {
  if (sc.codeField) {
    const f = await findFirst(page, sc.codeField, { timeout });
    return f?.el ?? null;
  }
  const until = Date.now() + timeout;
  do {
    const found = await page.evaluate((codeSel) => {
      const skip = /^(hidden|checkbox|radio|search|submit|button|file|range|color)$/i;
      const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
      const fresh = [...document.querySelectorAll('input:not([data-ssa-pre2])')].filter((e) => !skip.test(e.type) && !e.disabled && vis(e));
      if (!fresh.length) return false;
      const best = fresh.filter((e) => e.matches(codeSel) || (e.maxLength > 0 && e.maxLength <= 8));
      (best.length ? best : fresh).forEach((e) => e.setAttribute('data-ssa-code', ''));
      return true;
    }, CODE_SEL).catch(() => false);
    if (found) return page.locator('input[data-ssa-code]').first();
    if (timeout) await sleep(250);
  } while (Date.now() < until);
  return null;
}

// Форма ввода кода ещё на экране? Помеченные поля или новые поля внутри окна (если сайт перерисовал форму после неверного кода)
async function codeShown(page, sc) {
  if (sc.codeField) return !!(await findFirst(page, sc.codeField, { timeout: 0 }));
  return page.evaluate(() => {
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
    if ([...document.querySelectorAll('input[data-ssa-code]')].some(vis)) return true;
    return [...document.querySelectorAll('input:not([data-ssa-pre2])')].some((e) => vis(e) && !/^(hidden|checkbox|radio|search|submit|button)$/i.test(e.type)
      && e.closest('[role=dialog], [class*=modal], [class*=popup], [class*=auth]') && (e.maxLength > 0 && e.maxLength <= 8 || /code|otp|sms|pin/i.test(e.name + e.id + e.autocomplete)));
  }).catch(() => false);
}

// ───────── Корзина ─────────
const pathOf = (u) => { try { return new URL(u).pathname.replace(/\/+$/, '').toLowerCase(); } catch { return ''; } };
const norm = (t) => (t || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Товары в корзине: ссылка на карточку и блок вокруг неё (ровно с одной такой ссылкой), в котором есть кнопки.
// ── Доставка курьером ──
async function courierSteps(page, sc, step, phone, log) {
  let field = null;
  let suggest = null;
  // 1. Ввод адреса и подсказки: время — от последней введённой буквы до появления подсказок
  await step('Адрес доставки — подсказки', async () => {
    const until = Date.now() + 10000;
    while (!(field = await findAddressField(page)) && Date.now() < until) await sleep(400);
    if (!field) throw await notFound(page, 'address', 'не найдено поле адреса доставки — проверьте, что «получение = …» выбирает доставку курьером');
    const typed = await typeAddress(page, field, sc.address, log);
    FIRST_PRESS = typed.lastKey;
    suggest = await waitSuggestions(page, sc.address, typed.before, typed.lastKey);
    if (!suggest.list.length) return { label: `${typed.value} — подсказки не появились за 8 с`, minDur: 8000 };
    return { label: `${suggest.list[0].text}${suggest.list.length > 1 ? ` (подсказок: ${suggest.list.length})` : ''}`, minDur: suggest.ms };
  });
  // 2. Выбор подсказки — сайт пересчитывает доставку (цена, даты)
  await step('Адрес доставки — расчёт доставки', async () => {
    if (suggest?.list.length) {
      const best = suggest.list[0];
      await press(page.locator(`[data-ssa-sug="${best.i}"]`).first());
    } else {
      // Подсказок нет — подтверждаем ввод, как человек: Enter и уход из поля
      FIRST_PRESS ??= Date.now();
      await field.el.press('Enter').catch(() => {});
      await field.el.press('Tab').catch(() => {});
    }
    await sleep(600);
    const err = await addressError(page);
    if (err) throw new StepError(`сайт не принял адрес: «${err}» — уточните «адрес доставки = …» в checkout.txt (город, улица, дом — как в подсказках сайта)`);
    const v = (await field.el.inputValue().catch(() => '')).trim();
    return v || sc.address;
  });
  // 3. Квартира, подъезд, этаж, домофон, комментарий, получатель — только пустые поля, без замера
  const filled = await fillCourierFields(page, sc, phone);
  const NAMES = { flat: 'квартира', entrance: 'подъезд', floor: 'этаж', intercom: 'домофон', courierComment: 'комментарий', recipient: 'получатель', recipientPhone: 'телефон получателя' };
  const typed = filled.filter((x) => !x.kept).map((x) => NAMES[x.field]);
  const kept = filled.filter((x) => x.kept).map((x) => NAMES[x.field]);
  if (typed.length || kept.length) log(`  ${typed.length ? `Заполнено: ${typed.join(', ')}` : ''}${typed.length && kept.length ? '; ' : ''}${kept.length ? `уже заполнено сайтом: ${kept.join(', ')}` : ''}`);
  // 4. Дата и интервал
  const opt = await dateTimeOptions(page);
  if (!opt.date.length && !opt.time.length && !opt.selects.length) {
    log('  Выбора даты и интервала на странице нет (например, «дату сообщит оператор») — шаг пропущен');
  } else {
    await step('Дата и интервал доставки', async () => {
      const parts = [];
      for (const [kind, want, what] of [['date', sc.deliveryDate, 'дата'], ['time', sc.deliveryTime, 'интервал']]) {
        const o = await dateTimeOptions(page);
        const list = o[kind];
        let p = pickOption(list, want, kind);
        // Нужной даты нет среди карточек — в списке «Другая дата»
        if (p?.missing && kind === 'date' && o.selects.length) {
          const sel = o.selects.find((x) => x.options.some((t) => t.toLowerCase().includes(want.toLowerCase())));
          if (sel) {
            const label = sel.options.find((t) => t.toLowerCase().includes(want.toLowerCase()));
            FIRST_PRESS ??= Date.now();
            await page.locator(`[data-ssa-dsel="${sel.i}"]`).selectOption({ label });
            parts.push(`${what}: ${label}`);
            continue;
          }
        }
        if (!p) { if (list.length) parts.push(`${what}: все варианты недоступны`); continue; }
        if (p.missing) throw new StepError(`нет варианта «${want}» (${what} доставки). На странице: ${list.map((x) => `«${x.text}»${x.disabled ? ' (недоступно)' : ''}`).join(', ')} — исправьте «${kind === 'date' ? 'дата доставки' : 'интервал'} = …» в checkout.txt`);
        if (!p.kept) { await press(page.locator(`[data-ssa-dt="${p.item.id}"]`).first()); await sleep(400); }
        parts.push(`${what}: ${p.item.text}${p.kept ? ' (уже выбрано)' : ''}`);
      }
      return parts.join(' · ');
    });
  }
  // 5. Подтверждение адреса: кнопка из checkout.txt или «Сохранить / Готово / Привезти сюда» в окне с адресом
  if (sc.addressConfirm?.length) {
    await step('Подтверждение адреса', async () => {
      const btn = await findFirst(page, sc.addressConfirm, { timeout: 10000 });
      if (!btn) throw await notFound(page, 'addressConfirm', `не найдена кнопка «${actionText(sc.addressConfirm)}» (подтвердить адрес)`);
      await confirmAddress(page, btn);
      return btn.label;
    });
  } else if (field?.inModal) {
    // Окно с адресом — ближайший «плавающий» блок над полем адреса
    await field.el.evaluate((e) => {
      document.querySelectorAll('[data-ssa-modal]').forEach((x) => x.removeAttribute('data-ssa-modal'));
      for (let n = e.parentElement; n && n !== document.body; n = n.parentElement) {
        if (getComputedStyle(n).position === 'fixed' || n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true') { n.setAttribute('data-ssa-modal', '1'); return; }
      }
    }).catch(() => {});
    const btn = await findFirst(page.locator('[data-ssa-modal]'), ADDRESS_CONFIRM, { timeout: 2000 });
    if (btn) await step('Подтверждение адреса', async () => { await confirmAddress(page, btn); return btn.label; });
  }
}
// Кнопка подтверждения неактивна, пока сайт ждёт заполнения полей — назвать пустые поля в окне
async function confirmAddress(page, btn) {
  const until = Date.now() + 4000;
  while (await btn.el.isDisabled().catch(() => false)) {
    if (Date.now() > until) {
      const empty = await page.evaluate(() => {
        const box = document.querySelector('[data-ssa-modal]') || document;
        const list = [...box.querySelectorAll('input, textarea')].filter((e) => !/^(hidden|radio|checkbox)$/.test(e.type) && !e.value && e.getBoundingClientRect().height > 0)
          .map((e) => ({ name: (e.placeholder || e.getAttribute('aria-label') || e.labels?.[0]?.innerText || e.parentElement?.innerText || '').trim().split('\n')[0], req: e.required || e.getAttribute('aria-required') === 'true' }))
          .filter((x) => x.name);
        // Сначала обязательные поля, затем телефон; иначе все пустые
        const req = list.filter((x) => x.req || /[*]/.test(x.name));
        const tel = list.filter((x) => /телефон/i.test(x.name));
        return (req.length ? req : tel.length ? tel : list).map((x) => x.name.replace(/[*]/g, '').trim()).slice(0, 6);
      }).catch(() => []);
      const phone = empty.find((x) => /телефон/i.test(x));
      throw new StepError(`кнопка «${btn.label}» неактивна — сайт ждёт заполнения ${empty.length ? empty.map((x) => `«${x}»`).join(', ') : 'полей'}.` +
        (phone ? ' Телефон получателя агент подставляет из телефона для входа (в проверке --check входа нет) — или укажите «телефон получателя = …» в checkout.txt.' : ' Укажите нужные строки в checkout.txt (квартира, получатель и т. п.).'));
    }
    await sleep(300);
  }
  await press(btn.el);
}
const ADDRESS_CONFIRM = ['Сохранить', 'Применить', 'Готово', 'Подтвердить', 'Привезти сюда', 'Доставить сюда', 'Продолжить'].map((text) => ({ text }));

// Блоки помечаются data-ssa-item=<номер>; ours — товар из checkout.txt (по адресу карточки или названию).
export async function cartItems(page, ours, sc) {
  const want = ours.map((x) => ({ path: pathOf(x.url), title: norm(x.title).slice(0, 30) }));
  // Признак товара корзины — кнопка удаления или меню товара (селекторы и тексты из настроек)
  const ctl = [...(sc?.removeItem || []), ...(sc?.itemMenu || [])];
  const css = ctl.filter((a) => a.css).map((a) => a.css);
  const texts = ctl.filter((a) => a.text).map((a) => a.text.toLowerCase());
  return page.evaluate(({ want, css, texts }) => {
    const pathOf = (h) => { try { return new URL(h, location.href).pathname.replace(/\/+$/, '').toLowerCase(); } catch { return ''; } };
    const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const root = document.querySelector('main') || document.body;
    document.querySelectorAll('[data-ssa-item]').forEach((e) => e.removeAttribute('data-ssa-item'));
    const links = [...root.querySelectorAll('a[href]')].filter((a) => vis(a) && a.innerText.trim().length >= 6 && pathOf(a.getAttribute('href')).split('/').filter(Boolean).length >= 1);
    const items = [];
    const seen = new Set();
    for (const a of links) {
      const p = pathOf(a.getAttribute('href'));
      let box = a;
      while (box.parentElement && box.parentElement !== root) {
        const other = [...box.parentElement.querySelectorAll('a[href]')].some((x) => x.innerText.trim().length >= 6 && pathOf(x.getAttribute('href')) !== p && vis(x));
        if (other) break;
        box = box.parentElement;
      }
      if (seen.has(box) || box === a) continue;
      // Товар корзины — блок с кнопкой удаления или меню; рекомендации («В корзину») так не выглядят
      const hasCtl = css.some((c) => { try { return box.querySelector(c); } catch { return false; } })
        || [...box.querySelectorAll('button, [role=button]')].some((b) => texts.includes((b.getAttribute('aria-label') || b.innerText || '').trim().toLowerCase()));
      if (!hasCtl) continue;
      seen.add(box);
      const i = items.length;
      box.setAttribute('data-ssa-item', String(i));
      const name = a.innerText.trim().replace(/\s+/g, ' ').slice(0, 120);
      const ours = want.some((w) => (w.path && w.path === p) || (w.title && name.toLowerCase().replace(/\s+/g, ' ').includes(w.title)));
      items.push({ i, path: p, name, ours });
    }
    return items;
  }, { want, css, texts }).catch(() => []);
}

// Ждём, пока в корзине появятся все наши товары; возвращает те, которых нет
async function waitOurItems(page, ours, timeout, sc) {
  const until = Date.now() + timeout;
  let missing = ours;
  do {
    const body = norm(await page.locator('body').innerText().catch(() => ''));
    const items = await cartItems(page, ours, sc);
    missing = ours.filter((o) => !items.some((x) => x.ours && (x.path === pathOf(o.url) || norm(x.name).includes(norm(o.title).slice(0, 30)))) && !body.includes(norm(o.title).slice(0, 30)));
    if (!missing.length) return [];
    await sleep(500);
  } while (Date.now() < until);
  return missing;
}

// Удаление из корзины всех товаров, которых нет в checkout.txt: «Удалить» в блоке товара (или через меню «⋮»), затем подтверждение
export async function cleanCart(page, sc, ours, log = () => {}) {
  const removed = [];
  const tried = new Map();
  for (let round = 0; round < 40; round++) {
    const foreign = (await cartItems(page, ours, sc)).filter((x) => !x.ours);
    const next = foreign.find((x) => (tried.get(x.path || x.name) || 0) < 2);
    if (!next) return { removed, left: foreign.map((x) => x.name) };
    const key = next.path || next.name;
    tried.set(key, (tried.get(key) || 0) + 1);
    const box = page.locator(`[data-ssa-item="${next.i}"]`);
    await box.scrollIntoViewIfNeeded().catch(() => {});
    // Сначала меню «⋮», если оно есть: на многих сайтах «Удалить» спрятано под ним
    let btn = null;
    const menu = await findFirst(box, sc.itemMenu, { timeout: 0 });
    if (menu) { await press(menu.el).catch(() => {}); await sleep(700); }
    btn = await findFirst(box, sc.removeItem, { timeout: menu ? 3000 : 0 });
    if (btn) await press(btn.el).catch(() => {});
    else {
      // Кнопка есть, но скрыта (например, появляется только при свайпе) — нажатие прямо по элементу
      const hidden = box.locator(sc.removeItem.filter((a) => a.css).map((a) => a.css).join(', ') || '[aria-label="Удалить"]').first();
      if (!(await hidden.count().catch(() => 0))) continue;
      await hidden.evaluate((x) => x.click()).catch(() => {});
    }
    await sleep(600);
    // Окно «Удалить товар?» — подтверждение ищется сначала в окне, потом на всей странице
    const dlg = page.locator('[role=dialog], [class*=modal], [class*=popup], [class*=dialog]');
    const ok = (await findFirst(dlg, sc.removeConfirm, { timeout: 2500 })) || null;
    if (ok) await press(ok.el).catch(() => {});
    // Ждём, пока товар исчезнет из корзины
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const still = (await cartItems(page, ours, sc)).some((x) => (x.path || x.name) === key);
      if (!still) { removed.push(next.name); break; }
      await sleep(400);
    }
  }
  const left = (await cartItems(page, ours, sc)).filter((x) => !x.ours).map((x) => x.name);
  return { removed, left };
}

async function logout(page, sc, origin, opts) {
  const goHome = async () => {
    await page.goto(sc.profileUrl || origin, { waitUntil: 'domcontentloaded', timeout: opts.timeout }).catch(() => {});
    await sleep(1500);
  };
  await goHome();
  let b = await findFirst(page, sc.logout, { timeout: 2500 });
  if (!b) {
    const o = await findFirst(page, sc.openLogin, { timeout: 2500 });
    if (o) { await o.el.click().catch(() => {}); await sleep(1200); }
    b = await findFirst(page, sc.logout, { timeout: 4000 });
  }
  if (!b) return false;
  await b.el.click().catch(() => {});
  await sleep(800);
  // Окно «Вы уверены?» — ещё раз «Выйти»
  const again = await findFirst(page, sc.logout, { timeout: 1500 });
  if (again) await again.el.click().catch(() => {});
  await sleep(1500);
  return true;
}

export const fmt = (ms) => (ms == null ? '—' : ms >= 1000 ? `${(ms / 1000).toFixed(ms >= 10000 ? 1 : 2).replace('.', ',')} с` : `${Math.round(ms)} мс`);
