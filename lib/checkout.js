// Тест оформления заказа: вход по коду из SMS или письма, карточка → корзина → оформление → заказ.
// Каждый шаг замеряется: время от нажатия до готовности, запросы, ошибки, отклик кнопки, кадры экрана.
// Телефон, почта и код нигде не сохраняются; на кадрах поля ввода и личные данные размыты.
import readline from 'node:readline';
import { makeInternalMatcher, serviceOf } from './services.js';
import { actionText } from './checkout-config.js';

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

// Размытие полей ввода и текста, похожего на телефон или почту, — прямо на странице, поэтому кадры экрана уже без них
const MASK_INIT = (secrets) => `(() => {
  if (window.__ssaMask) return; window.__ssaMask = true;
  const secrets = ${JSON.stringify(secrets)};
  // Почта и телефон, в том числе частично скрытый сайтом: +7 (***) ***-12-34
  const re = /[\\w.+-]+@[\\w-]+\\.[\\w.-]+|(?:\\+7|8)[\\s(-]*[\\d*•xX]{3}[\\s)-]*[\\d*•xX]{3}[\\s-]*[\\d*•]{2}[\\s-]*\\d{2}/;
  // Форма входа (data-ssa-nomask) не размывается — видно, какой телефон или почту ввёл агент
  const no = ':not([data-ssa-nomask]):not([data-ssa-nomask] *)';
  const css = 'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit])' + no + ',textarea' + no + ',[data-ssa-mask]' + no + '{filter:blur(6px)!important}';
  const scan = () => {
    if (!document.body) return;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = n.nodeValue;
      if (t && t.length > 3 && (re.test(t) || secrets.some((s) => t.includes(s)))) n.parentElement?.setAttribute('data-ssa-mask', '');
    }
  };
  const start = () => {
    const st = document.createElement('style'); st.textContent = css; document.documentElement.appendChild(st);
    scan();
    let timer; new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(scan, 60); }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
  };
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
})();`;

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
export async function findFirst(scope, actions, { timeout = 15000 } = {}) {
  const until = Date.now() + timeout;
  do {
    for (const a of actions || []) {
      for (const loc of candidates(scope, a)) {
        const n = await loc.count().catch(() => 0);
        for (let i = 0; i < Math.min(n, 6); i++) {
          const el = loc.nth(i);
          if (await el.isVisible().catch(() => false)) return { el, label: labelOf(a) };
        }
      }
    }
    await sleep(250);
  } while (Date.now() < until);
  return null;
}

const labelOf = (a) => a.text ?? `css: ${a.css}`;

// Нажатие как у человека; если кнопку перекрывает плашка (cookies, баннер приложения), — нажатие прямо по элементу
async function press(el) {
  await el.scrollIntoViewIfNeeded().catch(() => {});
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

async function clickFirst(scope, actions, what, opts) {
  const f = await findFirst(scope, actions, opts);
  if (!f) throw new StepError(`не найдена кнопка «${actionText(actions)}» (${what}). Проверьте текст в checkout.txt — он должен совпадать с надписью на сайте`);
  await press(f.el);
  return f.label;
}

export class StepError extends Error {}

// Форма входа не размывается — ни на экране, ни на кадрах отчёта: видно, какой телефон или почту ввёл агент
async function nomask(el, box) {
  await el.evaluate((e) => e.setAttribute('data-ssa-nomask', '')).catch(() => {});
  if (box && box.evaluate) await box.evaluate((e) => e.setAttribute?.('data-ssa-nomask', '')).catch(() => {});
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
    context.on('requestfinished', (r) => { const x = this.byReq.get(r); if (x) x.end = Date.now(); });
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
  phone: 'input[type=tel], input[name*=phone i], input[autocomplete=tel], input[id*=phone i]',
  email: 'input[type=email], input[name*=mail i], input[autocomplete=email], input[id*=mail i]',
};
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
  await context.addInitScript(MASK_INIT(secrets.list));
  await context.addInitScript(PERF_INIT);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (profile.network) { await cdp.send('Network.enable'); await cdp.send('Network.emulateNetworkConditions', profile.network); }
  if (profile.cpu) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  const rec = new Recorder(context, page, cdp, isInternal, secrets);
  await rec.startScreencast(profile.device.viewport.width > 600 ? 480 : 300);
  prompt.onAbort = () => {};

  let n = 0;
  const step = async (name, fn, { cap = 30000, quiet = 800 } = {}) => {
    if (prompt.aborted) throw new Abort('остановлено');
    n++;
    log(`Шаг ${n}: ${name} …`);
    const t0 = Date.now();
    const navBefore = rec.navs.length;
    const s = { n, name, action: '', error: null };
    let soft = null;
    await dismiss(page, sc.dismiss);
    try {
      const r = await fn();
      // Функция шага может вернуть { label, soft }: soft — ошибка, после которой сценарий продолжается (например, неверный код)
      if (r && typeof r === 'object') { s.action = r.label || ''; soft = r.soft || null; } else s.action = r || '';
      await rec.settle(page, t0, { cap, quiet });
    } catch (e) {
      s.error = secrets.clean(e.message.split('\n')[0]);
    }
    const t1 = Date.now();
    s.navigated = rec.navs.length > navBefore;
    s.url = secrets.url(page.url());
    s.requests = rec.slice(t0, t1);
    const intEnds = s.requests.filter((r) => r.internal && !r.pending).map((r) => r.start + r.dur);
    // Время шага: от нажатия до последнего завершившегося своего запроса (или события load при переходе на новую страницу)
    const m = s.navigated ? await navMetrics(page) : null;
    const navT = s.navigated && m?.load ? rec.navs.at(-1) - t0 + m.load : 0;
    s.dur = Math.round(Math.max(200, ...intEnds, navT, s.error ? t1 - t0 : 0));
    s.metrics = m;
    s.visual = rec.lastFrame(t0, t0 + s.dur + 300);
    Object.assign(s, await perfSince(page, t0));
    s.frames = rec.framesFor(t0, t0 + s.dur);
    if (soft) s.error = soft;
    result.steps.push(s);
    log(s.error ? `  ✗ ${s.error}` : `  ✓ ${fmt(s.dur)}${s.action ? ` · «${s.action}»` : ''}`);
    if (soft) return s;
    if (s.error) throw new StepError(s.error);
    return s;
  };

  try {
    // 1. Вход
    await step('Главная страница', async () => { await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: opts.timeout }); });
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

      await nomask(idField, await scopeOf(page, idField));
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
      await nomask(idField, form);
      let codeField;
      // Поля, которые были на странице до отправки, — не поле кода (на некоторых сайтах поле кода того же типа, что и телефон)
      await page.evaluate(() => document.querySelectorAll('input').forEach((e) => e.setAttribute('data-ssa-pre2', ''))).catch(() => {});
      await step('Отправка кода', async () => {
        const label = await clickFirst(form, sc.sendCode, 'получить код', { timeout: 8000 }).catch(async (e) => {
          if (form === page) throw e;
          return clickFirst(page, sc.sendCode, 'получить код', { timeout: 3000 });
        });
        codeField = await waitCode(page, sc, method, 20000);
        if (codeField) await nomask(codeField, await scopeOf(page, codeField));
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
    if (sc.cleanCart) {
      // проверка не нужна: после добавления наших товаров остальные будут удалены из корзины
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
      await step(`Карточка товара${nn}`, async () => { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.timeout }); });
      const title = secrets.clean(((await page.locator('h1').first().innerText({ timeout: 3000 }).catch(() => '')) || (await page.title())).trim().replace(/\s+/g, ' ').slice(0, 140));
      result.products.push({ url, title });
      await step(`Добавление в корзину${nn}`, () => clickFirst(page, sc.addToCart, 'в корзину'));
    }
    result.productTitle = result.products.map((x) => x.title).join('; ');
    await step('Корзина', async () => {
      const f = await findFirst(page, sc.toCart, { timeout: 6000 });
      if (f) {
        const before = page.url();
        await press(f.el).catch(() => {});
        // Если по кнопке в корзину не перешли — открываем адрес корзины из настроек
        await page.waitForURL((u) => u.href !== before, { timeout: 8000 }).catch(() => {});
        if (page.url() !== before || !sc.cartUrl) return f.label;
      }
      if (!sc.cartUrl) throw new StepError(`не найдена кнопка «${actionText(sc.toCart)}» — укажите в checkout.txt «перейти в корзину = …» или «адрес корзины = …»`);
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
          result.removed = r.removed;
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
    await step('Переход к оформлению', () => clickFirst(page, sc.toCheckout, 'к оформлению'));
    await step('Способ получения', () => clickFirst(page, sc.delivery, 'способ получения'));
    if (sc.store) {
      await step('Выбор магазина / пункта', async () => {
        // Список вместо карты, если сайт сначала показывает карту
        if (sc.storeList) { const l = await findFirst(page, sc.storeList, { timeout: 5000 }); if (l) { await l.el.click().catch(() => {}); await sleep(800); } }
        const st = await findFirst(page, sc.store, { timeout: 15000 });
        if (!st) throw new StepError(`не найден магазин или пункт «${actionText(sc.store)}» — проверьте «магазин = …» в checkout.txt`);
        await st.el.scrollIntoViewIfNeeded().catch(() => {});
        if (!sc.storeConfirm) { await press(st.el); return st.label; }
        // Кнопка подтверждения («Забрать здесь») — в карточке именно этого магазина: ищем её, поднимаясь от названия вверх
        for (let up = 1; up <= 8; up++) {
          const box = st.el.locator(`xpath=ancestor::*[${up}]`);
          const b = await findFirst(box, sc.storeConfirm, { timeout: 0 });
          if (b) { await press(b.el); return `${st.label} → ${b.label}`; }
        }
        throw new StepError(`рядом с магазином «${st.label}» не найдена кнопка «${actionText(sc.storeConfirm)}»`);
      });
    }
    await step('Способ оплаты', () => clickFirst(page, sc.payment, 'способ оплаты'));
    // Имя клиента из формы — тоже в секреты, чтобы размыть его на кадрах следующих шагов
    for (const v of await page.locator('input:visible').evaluateAll((els) => els.map((e) => e.value).filter((x) => x && x.length > 2 && x.length < 80)).catch(() => [])) secrets.add(v);
    await context.addInitScript(MASK_INIT(secrets.list));
    for (const a of sc.beforeOrder || []) await step(`Действие перед оформлением: ${a.text ?? a.css}`, () => clickFirst(page, [a], 'перед оформлением'));

    if (opts.noOrder) {
      result.stoppedAt = 'без заказа';
      const b = await findFirst(page, sc.placeOrder, { timeout: 5000 });
      log(b ? `Кнопка «${b.label}» найдена и не нажата — заказ не создан.` : `⚠ Кнопка «${actionText(sc.placeOrder)}» не найдена на странице — проверьте «оформить = …» в checkout.txt. Заказ не создан.`);
      if (!b) result.notes.push(`Кнопка оформления «${actionText(sc.placeOrder)}» не найдена на последнем шаге — проверьте «оформить = …» в checkout.txt.`);
    } else {
      const s = await step('Оформление заказа', () => clickFirst(page, sc.placeOrder, 'оформить заказ'), { cap: 60000, quiet: 1200 });
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
  await page.evaluate((sel) => document.querySelectorAll(sel).forEach((e) => e.setAttribute('data-ssa-pre', '')), ID_SEL[method]).catch(() => {});
  const sel = ID_SEL[method].split(',').map((x) => `${x.trim()}:not([data-ssa-pre])`).join(', ');
  const by = method === 'phone' ? sc.byPhone : sc.byEmail;
  const clicked = new Set();
  const labels = [];
  for (let round = 0; round < 5; round++) {
    const field = await visible(page, sel, { timeout: round ? 2000 : 0 });
    if (field) return { field, label: labels.join(' → ') };
    const b = await findFirst(page, by.filter((a) => !clicked.has(labelOf(a))), { timeout: round ? 1500 : 0 });
    if (b) { clicked.add(b.label); labels.push(b.label); await press(b.el); continue; }
    const o = await findFirst(page, sc.openLogin.filter((a) => !clicked.has(labelOf(a))), { timeout: round ? 3000 : 8000 });
    if (!o) break;
    clicked.add(o.label); labels.push(o.label);
    await press(o.el);
  }
  throw new StepError(`не найдено поле ${method === 'phone' ? 'телефона' : 'почты'} в форме входа${labels.length ? ` (нажато: ${labels.join(' → ')})` : ''} — проверьте «открыть вход» и «вход по ${method === 'phone' ? 'телефону' : 'почте'}» в checkout.txt`);
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
