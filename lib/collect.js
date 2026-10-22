// Один замер одной страницы: метрики браузера, все сетевые запросы с таймингами,
// процессорное время JS по каждому скрипту. Плюс отдельный замер покрытия кода.
import { devices } from 'playwright';

export const PROFILES = {
  desktop: { label: 'Десктоп, реальная сеть', device: devices['Desktop Chrome'] },
  mobile: {
    label: 'Мобильный (Pixel 7, канал 1,6 Мбит/с, задержка 150 мс, CPU ×4)',
    device: devices['Pixel 7'],
    // Сопоставимо с «Slow 4G» Lighthouse
    network: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
    cpu: 4,
  },
};

// Краткое описание DOM-элемента: tag#id.class1.class2
const DESC_FN = `(el) => {
  if (!el || !el.tagName) return '';
  let d = el.tagName.toLowerCase();
  if (el.id) d += '#' + el.id;
  if (typeof el.className === 'string' && el.className.trim()) d += '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.');
  return d;
}`;

const PERF_INIT = `(() => {
  if (window.top !== window) return;
  const desc = ${DESC_FN};
  const P = (window.__perf = { lcp: null, lcpEl: '', lcpUrl: '', cls: 0, longTasks: [], shifts: [] });
  const obs = (type, fn) => { try { new PerformanceObserver((l) => l.getEntries().forEach(fn)).observe({ type, buffered: true }); } catch (e) {} };
  obs('largest-contentful-paint', (e) => { P.lcp = e.startTime; P.lcpUrl = e.url || ''; P.lcpEl = desc(e.element); });
  obs('layout-shift', (e) => {
    if (e.hadRecentInput) return;
    P.cls += e.value;
    P.shifts.push({ v: e.value, t: e.startTime, src: (e.sources || []).map((s) => desc(s.node)).filter(Boolean) });
  });
  obs('longtask', (e) => P.longTasks.push([e.startTime, e.duration]));
})();`;

// Сведения о странице после загрузки: картинки, шрифты, DOM, SEO-теги отрисованной страницы
const EXTRAS_FN = `() => {
  const desc = ${DESC_FN};
  const vh = innerHeight;
  const imgs = [...document.images].map((img) => {
    const r = img.getBoundingClientRect();
    const cs = getComputedStyle(img);
    return {
      src: img.currentSrc || img.src, nw: img.naturalWidth, nh: img.naturalHeight,
      w: Math.round(r.width), h: Math.round(r.height),
      visible: r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && cs.display !== 'none',
      aboveFold: r.width > 1 && r.top < vh && r.bottom > 0,
      loading: img.getAttribute('loading') || '', fetchpriority: img.getAttribute('fetchpriority') || '',
      hasDims: img.hasAttribute('width') && img.hasAttribute('height'),
      aspect: cs.aspectRatio !== 'auto', desc: desc(img),
    };
  }).filter((i) => i.src && !i.src.startsWith('data:'));

  const links = (rel) => [...document.querySelectorAll('link[rel~="' + rel + '"]')];
  const preloads = links('preload').map((l) => ({ as: l.getAttribute('as') || '', href: l.href, fp: l.getAttribute('fetchpriority') || '' }));
  const preconnects = [...links('preconnect'), ...links('dns-prefetch')].map((l) => l.href);

  const fontFaces = [];
  let blockedSheets = 0;
  for (const ss of document.styleSheets) {
    let rules;
    try { rules = ss.cssRules; } catch (e) { blockedSheets++; continue; }
    for (const r of rules) if (r.type === 5) fontFaces.push({
      family: r.style.getPropertyValue('font-family').replace(/["']/g, '').trim(),
      display: r.style.getPropertyValue('font-display') || 'auto', sheet: ss.href || 'inline',
    });
  }

  let nodes = 0, maxDepth = 0, maxChildren = 0, maxChildrenEl = '';
  const stack = [[document.documentElement, 1]];
  while (stack.length) {
    const [el, d] = stack.pop();
    nodes++;
    if (d > maxDepth) maxDepth = d;
    if (el.children.length > maxChildren) { maxChildren = el.children.length; maxChildrenEl = desc(el); }
    for (const c of el.children) stack.push([c, d + 1]);
  }

  const meta = (n) => document.querySelector('meta[name="' + n + '"]')?.getAttribute('content') ?? null;
  const jsonld = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const walk = (o) => { if (!o || typeof o !== 'object') return; if (o['@type']) jsonld.push([].concat(o['@type']).join(',')); if (Array.isArray(o)) o.forEach(walk); else if (o['@graph']) walk(o['@graph']); };
      walk(JSON.parse(s.textContent));
    } catch (e) {}
  }
  const seo = {
    title: document.title || '', description: meta('description'), robots: meta('robots'),
    canonical: links('canonical')[0]?.href ?? null,
    h1: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim().replace(/\\s+/g, ' ').slice(0, 120)),
    textLen: (document.body?.innerText || '').replace(/\\s+/g, ' ').length,
    links: document.querySelectorAll('a[href]').length,
    hreflang: links('alternate').filter((l) => l.hreflang).length,
    jsonld: [...new Set(jsonld)], viewport: meta('viewport'),
  };
  return { imgs, preloads, preconnects, fontFaces, blockedSheets, dom: { nodes, maxDepth, maxChildren, maxChildrenEl }, seo, dpr: devicePixelRatio, vw: innerWidth, vh };
}`;

async function newPage(browser, profile, { throttle = true } = {}) {
  const context = await browser.newContext({ ...profile.device, ignoreHTTPSErrors: true, locale: 'ru-RU' });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (throttle && profile.network) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', profile.network);
  }
  if (throttle && profile.cpu) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  return { context, page, cdp };
}

async function navigate(page, url, { timeout, idle }, out) {
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    out.status = resp?.status() ?? null;
    out.finalUrl = page.url();
    if (resp) {
      const h = await resp.allHeaders();
      const pick = ['cache-control', 'age', 'x-cache', 'x-cache-status', 'cf-cache-status', 'x-proxy-cache', 'x-cache-hits',
        'server', 'server-timing', 'content-encoding', 'vary', 'via', 'x-powered-by', 'x-robots-tag'];
      out.docHeaders = Object.fromEntries(pick.filter((k) => h[k] != null).map((k) => [k, h[k]]));
    }
    await page.waitForLoadState('load', { timeout }).catch(() => (out.loadFired = false));
    await page.waitForLoadState('networkidle', { timeout: idle }).catch(() => {});
  } catch (e) {
    out.error = e.message.split('\n')[0];
  }
}

// opts.block(url) → true: запрос отменяется (тест «без внешних сервисов»)
// opts.extras: собрать сведения о картинках, шрифтах, DOM, SEO (достаточно одного прогона)
// opts.screencast: записать кадры экрана во время загрузки (раскадровка, достаточно одного прогона); 'warm' — повторный визит в той же вкладке
// Каждый вызов — новый чистый профиль браузера: первый визит, холодный кэш
export async function measurePage(browser, url, profile, opts) {
  const { context, page, cdp } = await newPage(browser, profile);
  await context.addInitScript(PERF_INIT);
  if (opts.block) {
    await context.route('**/*', (route) => (opts.block(route.request().url()) ? route.abort('blockedbyclient') : route.continue()));
  }
  try {
    return await measureNav(page, cdp, url, opts);
  } finally {
    await context.close();
  }
}

// Повторный визит: в одном профиле браузера страница сначала открывается для прогрева кэша,
// затем n раз с замером. step(label) / done() — для панели прогресса.
export async function measureWarm(browser, url, profile, opts, n, { step, done } = {}) {
  const { context, page, cdp } = await newPage(browser, profile);
  await context.addInitScript(PERF_INIT);
  const out = { prime: { loadFired: true }, runs: [] };
  try {
    await step?.('повторный визит: прогрев кэша');
    await navigate(page, url, opts, out.prime);
    done?.();
    for (let i = 0; i < n; i++) {
      await step?.(`повторный визит ${i + 1} из ${n}`);
      // Кадры экрана — в первом замере повторного визита (для сравнения с раскадровкой первого визита)
      out.runs.push(await measureNav(page, cdp, url, { ...opts, extras: false, screencast: opts.filmstrip && i === 0 ? 'warm' : false }));
      done?.();
    }
  } finally {
    await context.close();
  }
  return out;
}

// Замер одной загрузки страницы в уже открытой вкладке
async function measureNav(page, cdp, url, { timeout, idle, extras, screencast }) {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  await cdp.send('Profiler.start');

  // Откуда получен каждый ресурс (кэш браузера или сеть) и сколько байт реально пришло по сети
  await cdp.send('Network.enable');
  const net = new Map();
  const cdpHandlers = {
    'Network.requestWillBeSent': (e) => net.set(e.requestId, { url: e.request.url, cache: '', netBytes: 0 }),
    'Network.requestServedFromCache': (e) => { const x = net.get(e.requestId); if (x && !x.cache) x.cache = 'memory'; },
    'Network.responseReceived': (e) => {
      const x = net.get(e.requestId);
      if (!x) return;
      if (e.response.fromDiskCache) x.cache = 'disk';
      else if (e.response.fromPrefetchCache) x.cache = 'prefetch';
      else if (e.response.fromServiceWorker) x.cache = 'sw';
    },
    'Network.loadingFinished': (e) => { const x = net.get(e.requestId); if (x) x.netBytes = e.encodedDataLength || 0; },
  };
  for (const [ev, fn] of Object.entries(cdpHandlers)) cdp.on(ev, fn);

  const recs = new Map();
  const pending = [];
  const startOf = (req) => {
    const t = req.timing().startTime;
    return t > 0 ? t : Date.now();
  };
  let closing = false; // отмены при закрытии вкладки или уходе со страницы — не сбои сервисов
  const pageHandlers = {
    request: (req) => {
      recs.set(req, { url: req.url(), type: req.resourceType(), method: req.method(), start: startOf(req) });
    },
    response: (res) => {
      const rec = recs.get(res.request());
      if (!rec) return;
      rec.status = res.status();
      rec.statusText = res.statusText();
      const h = res.headers();
      rec.encoding = h['content-encoding'] || '';
      rec.cacheControl = h['cache-control'] || '';
      rec.contentType = (h['content-type'] || '').split(';')[0];
    },
    requestfinished: (req) => {
      const rec = recs.get(req);
      if (!rec) return;
      const t = req.timing();
      rec.end = t.responseEnd > 0 ? t.startTime + t.responseEnd : Date.now();
      rec.ttfb = t.responseStart > 0 ? t.responseStart : null;
      pending.push(req.sizes().then((s) => (rec.bytes = s.responseBodySize + s.responseHeadersSize)).catch(() => {}));
    },
    requestfailed: (req) => {
      const rec = recs.get(req);
      if (!rec || closing) return;
      rec.end = Date.now();
      rec.failed = req.failure()?.errorText || 'unknown';
    },
  };
  for (const [ev, fn] of Object.entries(pageHandlers)) page.on(ev, fn);

  // Раскадровка: браузер присылает кадр при каждом изменении экрана. Кадр нужно подтвердить, иначе поток встанет.
  // Хранится не больше одного кадра на 100 мс — анимации и карусели иначе дают десятки кадров в секунду.
  const frames = [];
  const onFrame = (e) => {
    cdp.send('Page.screencastFrameAck', { sessionId: e.sessionId }).catch(() => {});
    const ts = e.metadata.timestamp * 1000;
    if (frames.length && ts - frames.at(-1).ts < 100) frames[frames.length - 1] = { ts, data: e.data };
    else frames.push({ ts, data: e.data });
  };
  if (screencast) {
    cdp.on('Page.screencastFrame', onFrame);
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 45, maxWidth: 320, maxHeight: 400, everyNthFrame: 1 }).catch(() => {});
  }

  const out = { url, error: null, loadFired: true };
  await navigate(page, url, { timeout, idle }, out);
  const obsEnd = Date.now();
  closing = true;
  if (screencast) {
    await cdp.send('Page.stopScreencast').catch(() => {});
    cdp.off('Page.screencastFrame', onFrame);
  }

  let browserData = null;
  try {
    browserData = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0]?.toJSON() || {};
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
      const res = performance.getEntriesByType('resource').map((r) => ({
        name: r.name, rb: r.renderBlockingStatus, start: r.startTime, end: r.responseEnd, initiator: r.initiatorType,
      }));
      return { timeOrigin: performance.timeOrigin, nav, fcp, perf: window.__perf || {}, res };
    });
    if (extras) out.extras = await page.evaluate(`(${EXTRAS_FN})()`);
  } catch {}

  let cpuByUrl = {};
  try {
    const { profile: prof } = await cdp.send('Profiler.stop');
    const byId = new Map(prof.nodes.map((n) => [n.id, n]));
    prof.samples.forEach((id, i) => {
      const cf = byId.get(id).callFrame;
      const key = cf.url || cf.functionName;
      if (key === '(idle)' || key === '(program)' || !key) return;
      cpuByUrl[key] = (cpuByUrl[key] || 0) + (prof.timeDeltas[i] || 0) / 1000;
    });
  } catch {}

  await Promise.all(pending);
  for (const [ev, fn] of Object.entries(pageHandlers)) page.off(ev, fn);
  for (const [ev, fn] of Object.entries(cdpHandlers)) cdp.off(ev, fn);
  const netByUrl = new Map();
  for (const x of net.values()) {
    const prev = netByUrl.get(x.url);
    if (!prev || (x.cache && !prev.cache) || x.netBytes > prev.netBytes) netByUrl.set(x.url, x);
  }

  if (!browserData) {
    out.error ??= 'Не удалось получить метрики страницы';
    return out;
  }
  const t0 = browserData.timeOrigin;
  const nav = browserData.nav;
  const rbByUrl = new Map();
  for (const r of browserData.res) if (r.rb === 'blocking') rbByUrl.set(r.name, true);

  const tasks = browserData.perf.longTasks || [];
  const fcp = browserData.fcp;
  out.metrics = {
    ttfb: nav.responseStart || null,
    fcp,
    lcp: browserData.perf.lcp,
    cls: Math.round((browserData.perf.cls || 0) * 1000) / 1000,
    tbt: tasks.filter(([s]) => fcp == null || s >= fcp).reduce((a, [, d]) => a + Math.max(0, d - 50), 0),
    longTasks: tasks.length,
    dcl: nav.domContentLoadedEventEnd || null,
    load: out.loadFired && nav.loadEventEnd ? nav.loadEventEnd : null,
    observed: obsEnd - t0,
    htmlBytes: nav.transferSize || 0,
    redirects: nav.redirectCount || 0,
  };
  // Фазы получения HTML (Navigation Timing), мс
  const ph = (a, b) => (nav[a] > 0 && nav[b] > 0 ? Math.max(0, nav[b] - nav[a]) : 0);
  out.navPhases = {
    redirect: ph('redirectStart', 'redirectEnd'),
    dns: ph('domainLookupStart', 'domainLookupEnd'),
    connect: nav.secureConnectionStart > 0 ? ph('connectStart', 'secureConnectionStart') : ph('connectStart', 'connectEnd'),
    tls: nav.secureConnectionStart > 0 ? ph('secureConnectionStart', 'connectEnd') : 0,
    server: ph('requestStart', 'responseStart'),
    download: ph('responseStart', 'responseEnd'),
    protocol: nav.nextHopProtocol || '',
    serverTiming: (nav.serverTiming || []).map((s) => ({ name: s.name, dur: Math.round(s.duration), desc: s.description })),
  };
  // Время кадра — от начала навигации; кадры до неё (пустая вкладка) не нужны, кроме последнего — это «белый экран» в момент 0
  if (screencast) {
    const rel = frames.map((f) => ({ t: Math.round(f.ts - t0), data: f.data }));
    // В первом визите кадр до навигации — пустая вкладка. При повторном визите в той же вкладке на экране ещё прежняя страница:
    // браузер держит её, пока не придёт ответ сервера на новую, — такие кадры (до TTFB) не показываем
    if (screencast === 'warm') {
      const cut = nav.responseStart || 0;
      out.frames = rel.filter((f) => f.t >= cut);
    } else {
      const before = rel.filter((f) => f.t < 0).at(-1);
      out.frames = [...(before ? [{ ...before, t: 0 }] : []), ...rel.filter((f) => f.t >= 0)];
    }
  }
  out.lcpElement = browserData.perf.lcpEl;
  out.lcpUrl = browserData.perf.lcpUrl;
  out.shifts = browserData.perf.shifts || [];

  out.resources = [...recs.values()].map((r) => {
    const end = r.end ?? obsEnd;
    return {
      url: r.url,
      type: r.type,
      status: r.failed ? 'FAILED' : r.end == null ? 'PENDING' : r.status ?? 0,
      statusText: r.failed || r.statusText || '',
      start: Math.round(r.start - t0),
      end: Math.round(end - t0),
      duration: Math.max(0, Math.round(end - r.start)),
      ttfb: r.ttfb != null ? Math.round(r.ttfb) : null,
      bytes: r.bytes || 0,
      encoding: r.encoding || '',
      cacheControl: r.cacheControl || '',
      contentType: r.contentType || '',
      renderBlocking: rbByUrl.has(r.url),
      cpu: Math.round(cpuByUrl[r.url] || 0),
      cache: netByUrl.get(r.url)?.cache || '',
      netBytes: netByUrl.get(r.url)?.netBytes ?? 0,
    };
  });
  out.cpuByUrl = cpuByUrl;
  return out;
}

// Отдельный прогон без троттлинга: какая доля загруженного JS/CSS реально выполнилась к концу загрузки
export async function measureCoverage(browser, url, profile, { timeout, idle }) {
  const { context, page } = await newPage(browser, profile, { throttle: false });
  await page.coverage.startJSCoverage({ resetOnNavigation: false });
  await page.coverage.startCSSCoverage({ resetOnNavigation: false });
  const out = { loadFired: true };
  await navigate(page, url, { timeout, idle }, out);
  const files = [];
  try {
    const js = await page.coverage.stopJSCoverage();
    const css = await page.coverage.stopCSSCoverage();
    const add = (kind, url, total, used) => {
      if (!/^https?:/.test(url) || !total) return;
      const f = files.find((x) => x.url === url && x.kind === kind);
      if (f) { f.total += total; f.used += used; } else files.push({ kind, url, total, used });
    };
    for (const e of js) {
      const len = e.source?.length || 0;
      if (!len) continue;
      // Диапазоны идут от внешних функций к вложенным: каждый следующий уточняет предыдущий
      const usedMap = new Uint8Array(len);
      for (const fn of e.functions) for (const r of fn.ranges) usedMap.fill(r.count > 0 ? 1 : 0, r.startOffset, Math.min(r.endOffset, len));
      let used = 0;
      for (let i = 0; i < len; i++) used += usedMap[i];
      add('js', e.url, len, used);
    }
    for (const e of css) {
      const len = e.text?.length || 0;
      const used = e.ranges.reduce((a, r) => a + (r.end - r.start), 0);
      add('css', e.url, len, Math.min(used, len));
    }
  } catch (e) {
    out.error = e.message.split('\n')[0];
  }
  await context.close();
  out.files = files;
  return out;
}

// ── Тест отклика на действия (INP в лабораторном замере) ───────────────────
// Event Timing API записывает каждое взаимодействие: от нажатия до отрисовки результата.
// Long Animation Frames показывает, какие скрипты выполнялись в медленных кадрах.
const INP_INIT = `(() => {
  if (window.top !== window) return;
  const desc = ${DESC_FN};
  const I = (window.__inp = { events: [], loaf: [] });
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => {
      if (!e.interactionId) return;
      I.events.push({ name: e.name, start: e.startTime, dur: e.duration, ps: e.processingStart, pe: e.processingEnd, id: e.interactionId, target: desc(e.target) });
    })).observe({ type: 'event', buffered: true, durationThreshold: 16 });
  } catch (e) {}
  try {
    new PerformanceObserver((l) => l.getEntries().forEach((e) => I.loaf.push({
      start: e.startTime, dur: e.duration,
      scripts: (e.scripts || []).map((s) => ({ url: s.sourceURL || '', inv: s.invoker || '', dur: s.duration })),
    }))).observe({ type: 'long-animation-frame', buffered: true });
  } catch (e) {}
})();`;

// План действий для теста отклика. cfg (из actions.txt): { type?, actionsByType?: { catalog|product|other: [{ text } | { css }] }, search?: false | 'слово' }.
// Без настроек: тип страницы определяется автоматически и берётся сценарий для этого типа.
// Найденные элементы помечаются атрибутом data-sa-inp, по нему потом нажимаем.
const PLAN_FN = `(cfg) => {
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (!(r.width > 4 && r.height > 4 && r.right > 0 && r.left < innerWidth && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0)) return false;
    // Закреплённые (fixed) панели, задвинутые за край экрана (выезжающее меню, скрытая нижняя полоса), прокрутить нельзя
    if (r.bottom < 0 || r.top > innerHeight) {
      for (let n = el; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') return false;
    }
    return true;
  };
  const cls = (el) => (typeof el.className === 'string' ? el.className : '');
  const own = (el) => (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.value || '').trim().replace(/\\s+/g, ' ');
  const text = (el) => own(el).slice(0, 60);
  const desc = ${DESC_FN};
  const disabled = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || /disabled|unavailable|sold-?out|not-?available/i.test(cls(el));
  const pool = [...document.querySelectorAll('button, [role=button], [role=radio], [role=option], [role=tab], a, label, input, select, summary, li, span, div[class*=button i], [class*=burger i], [class*=hamburger i], [class*=next i], [class*=arrow i]')]
    .filter((el) => vis(el) && !el.closest('footer'));
  const short = (el, n) => own(el).length > 0 && own(el).length <= n;

  // ── Тип страницы ──
  const ld = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try { const w = (o) => { if (!o || typeof o !== 'object') return; if (o['@type']) ld.push(...[].concat(o['@type'])); (Array.isArray(o) ? o : o['@graph'] || []).forEach?.(w); }; w(JSON.parse(s.textContent)); } catch (e) {}
  }
  const inCarousel = (n) => !!n?.closest?.('[class*=swiper i], [class*=slider i], [class*=carousel i], [class*=recommend i], [class*=similar i], [class*=recs i]');
  const inRecs = (n) => !!n?.closest?.('[class*=recommend i], [class*=similar i], [class*=recs i], [class*=related i], [class*=also i]');
  const cartRe = /^(в корзину|купить|добавить в корзину|add to cart)/i;
  const cartBtns = pool.filter((el) => el.tagName !== 'A' && short(el, 30) && cartRe.test(own(el)));
  // Карточки товаров вне каруселей (на карточке товара карусели «Похожие товары» не должны делать её каталогом)
  const counts = {};
  for (const el of document.querySelectorAll('[class]')) {
    if (el.closest('[class*=swiper i], [class*=slider i], [class*=carousel i], [class*=recommend i], [class*=similar i]')) continue;
    for (const c of cls(el).split(/\\s+/)) if (/(product|catalog|goods|item)[-_]?(card|item|tile|snippet)$|^(product|item)-?card$/i.test(c)) counts[c] = (counts[c] || 0) + 1;
  }
  const cards = Math.max(0, ...Object.values(counts));
  const sortRe = /^(сортир(овка|овать)|по популярности|по умолчанию|по цене|по возрастанию|по убыванию|по новизне|по рейтингу|сначала (дешев|дорог|популяр|нов))/i;
  let type = cfg.type || null;
  const typeSource = type ? 'config' : 'auto';
  let signals = null;
  if (!type) {
    // Баллы за признаки карточки товара и каталога
    const og = document.querySelector('meta[property="og:type"]')?.content || '';
    const micro = document.querySelectorAll('[itemtype*="schema.org/Product" i]').length;
    // Цены вне каруселей: у карточки товара — одна-две, у каталога — десятки
    let prices = 0;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode.textContent;
      if (t.length < 25 && /^\\s*(от\\s)?\\d[\\d\\s\\u00a0\\u202f]{2,}\\s?(₽|руб\\.?|р\\.)\\s*$/i.test(t) && !inCarousel(walker.currentNode.parentElement) && vis(walker.currentNode.parentElement)) prices++;
    }
    // Цена бывает разбита на части («12 990» и «₽» в разных элементах) — считаем и блоки с price в классе
    const priceBlocks = [...document.querySelectorAll('[class*=price i]')].filter((el) => /\\d/.test(el.textContent) && !el.querySelector('[class*=price i]') && vis(el) && !inCarousel(el)).length;
    prices = Math.max(prices, priceBlocks);
    const cartsOutside = cartBtns.filter((el) => !inCarousel(el)).length;
    let prod = 0, cat = 0;
    if (ld.includes('Product') && !ld.includes('ItemList')) prod += 2;
    // Артикул в адресе (последняя часть из букв и цифр: SM-S942B12256BLU2E1S, MHFE4) — почти всегда карточка товара
    const lastSeg = location.pathname.split('/').filter(Boolean).pop() || '';
    if (lastSeg.length >= 5 && /\\d/.test(lastSeg) && /[a-zа-я]/i.test(lastSeg)) prod += 2;
    if (/product/i.test(og)) prod += 2;
    if (micro === 1) prod += 2;
    if (cartBtns.some((el) => el.getBoundingClientRect().top < innerHeight * 1.5)) prod += 1;
    if (document.querySelector('[class*=size i] button, [class*=sku i] button, [class*=variant i] button, [class*=offer i] [role=radio]')) prod += 1;
    if (ld.includes('ItemList')) cat += 3;
    if (cards >= 6) cat += 2;
    if (prices >= 6) cat += 3;
    if (pool.some((el) => short(el, 35) && sortRe.test(own(el)))) cat += 2;
    if (pool.some((el) => short(el, 25) && /^(все |показать )?фильтр(ы)?$/i.test(own(el)))) cat += 1;
    if (cartsOutside >= 6) cat += 2;
    type = prod >= 2 && prod >= cat ? 'product' : cat >= 2 ? 'catalog' : cartBtns.length ? 'product' : 'other';
    signals = { prod, cat, prices, cards, carts: cartBtns.length, cartsOutside, ld: [...new Set(ld)] };
  }

  // ── Поиск нужных элементов ──
  const first = (test) => pool.find((el) => !el.hasAttribute('data-sa-inp') && !disabled(el) && test(el));
  const finders = {
    filters: ['Открыть фильтры', () => first((el) => short(el, 25) && /^(все |показать )?фильтр(ы)?( и сортировка)?$/i.test(own(el)) && !el.matches('input'))
      || first((el) => el.matches('button, [role=button]') && /filter/i.test(cls(el)) && /фильтр/i.test(own(el) + ' ' + (el.getAttribute('aria-label') || '')))],
    sort: ['Сортировка', () => first((el) => short(el, 35) && sortRe.test(own(el)) && !el.matches('li, input'))
      || first((el) => el.matches('select, button, [role=button]') && /sort/i.test(cls(el) + ' ' + (el.getAttribute('name') || '')))],
    more: ['Показать ещё', () => first((el) => short(el, 40) && /^(показать|загрузить) ещё|^ещё \\d* ?товар/i.test(own(el)))],
    menu: ['Меню / каталог в шапке', () => first((el) => el.matches('[class*=burger i], [class*=hamburger i]'))
      || first((el) => el.matches('button, [role=button]') && short(el, 20) && /^(меню|каталог( товаров)?)$/i.test(own(el)))],
    gallery: ['Галерея / слайдер', () => pool.filter((el) => !el.hasAttribute('data-sa-inp') && !!el.closest('[class*=gallery i], [class*=swiper i], [class*=slider i], [class*=carousel i]') &&
      el.matches('button, [role=button], [class*=next i]:not([class*=slide i]), [class*=arrow i]:not([class*=slide i])'))
      .sort((a, b) => inRecs(a) - inRecs(b) || !!b.closest('[class*=gallery i]') - !!a.closest('[class*=gallery i]'))[0]],
    variant: ['Выбор размера / варианта', () => first((el) => !!el.closest('[class*=size i], [class*=sku i], [class*=variant i], [class*=offer i], [class*=option i], [class*=color i]') &&
      el.matches('button, label, li, [role=radio], [role=option]') && short(el, 15) && !/active|selected|checked|current/i.test(cls(el)) && el.getAttribute('aria-checked') !== 'true')],
    // Только кнопка самого товара: «В корзину» в каруселях и рекомендациях относится к другим товарам
    cart: ['Кнопка «В корзину»', () => cartBtns.filter((el) => !el.hasAttribute('data-sa-inp') && !disabled(el) && !inCarousel(el) && !inRecs(el))
      .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)[0]],
  };
  const SCENARIO = { catalog: ['filters', 'sort', 'more', 'menu'], product: ['variant', 'cart', 'gallery', 'menu'], other: ['menu', 'gallery'] };

  const out = [];
  const mark = (el, t) => {
    if (el && !el.matches('input, select, textarea')) el = el.closest('button, [role=button], [role=radio], [role=option], [role=tab], a, label, summary') || el;
    const id = String(out.length);
    if (el) el.setAttribute('data-sa-inp', id);
    out.push({ id, ...t, text: el ? text(el) : '', desc: el ? desc(el) : '' });
  };
  const actions = (cfg.actionsByType || {})[type];
  if (actions && actions.length) {
    // Действия, заданные для сайта: ищем элемент по видимому тексту (сначала точное совпадение) или по CSS-селектору
    for (const a of actions) {
      let el = null;
      if (a.css) {
        try { el = [...document.querySelectorAll(a.css)].find((x) => vis(x) && !x.hasAttribute('data-sa-inp')) || null; } catch (e) {}
      } else {
        const want = a.text.toLowerCase();
        const cand = pool.filter((x) => !x.hasAttribute('data-sa-inp') && own(x).toLowerCase().includes(want));
        el = cand.find((x) => own(x).toLowerCase() === want) || cand.find((x) => own(x).toLowerCase().startsWith(want)) ||
          cand.sort((x, y) => own(x).length - own(y).length)[0] || null;
      }
      mark(el, { kind: 'custom', label: 'Нажатие «' + (a.text || a.css) + '»', source: 'config', notFound: !el });
    }
  } else {
    for (const k of SCENARIO[type]) {
      const [label, find] = finders[k];
      const el = find();
      if (el) mark(el, { kind: k, label, source: 'auto' });
    }
  }
  // Поиск: слово из настроек, иначе — первые слова заголовка страницы (H1), как запрос реального покупателя
  if (cfg.search !== false) {
    const input = first((el) => el.matches('input[type=search], input[name*=search i], input[name*=query i], input[placeholder*=поиск i], input[placeholder*=найти i], input[placeholder*=search i], [class*=search i] input:not([type=hidden])'));
    const h1 = (document.querySelector('h1')?.innerText || '').trim().replace(/\\s+/g, ' ');
    const word = cfg.search || h1.split(' ').slice(0, 2).join(' ').slice(0, 30).toLowerCase() || 'товар';
    if (input) mark(input, { kind: 'search', label: 'Поиск: «' + word + '»', source: cfg.search ? 'config' : 'auto', word });
  }
  return { type, typeSource, signals, targets: out };
}`;

// Перекрыт ли элемент другим (всплывающее окно, баннер). Если да — найти в окне кнопку закрытия/согласия.
const COVER_FN = `(id) => {
  const desc = ${DESC_FN};
  const el = document.querySelector('[data-sa-inp="' + id + '"]');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  if (!top || el === top || el.contains(top) || top.contains(el)) return null;
  // Окно — ближайший предок с position: fixed, иначе с position: absolute
  let fixed = null, abs = null;
  for (let n = top; n && n !== document.body; n = n.parentElement) {
    const pos = getComputedStyle(n).position;
    if (!fixed && pos === 'fixed') fixed = n;
    if (!abs && pos === 'absolute') abs = n;
  }
  const box = fixed || abs || top;
  const vis = (b) => { const q = b.getBoundingClientRect(); return q.width > 2 && q.height > 2; };
  const label = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (typeof b.className === 'string' ? b.className : '') + ' ' + (b.textContent || '')).trim();
  const btn = [...box.querySelectorAll('button, [role=button], a, span, div, i, svg')].filter(vis).find((b) =>
    /закры|close|^\\s*[×✕✖]\\s*$/i.test(label(b)) && b.children.length < 4 ||
    /^(да|верно|да, верно|ок|ok|понятно|хорошо|согласен|принять|продолжить)\\b/i.test((b.textContent || '').trim()) && b.matches('button, [role=button], a'));
  document.querySelectorAll('[data-sa-close]').forEach((x) => x.removeAttribute('data-sa-close'));
  if (btn) btn.setAttribute('data-sa-close', '1');
  return { overlay: desc(box), closeText: btn ? ((btn.textContent || '').trim() || btn.getAttribute('aria-label') || '×').slice(0, 30) : '' };
}`;

const HIDE_FN = `(id) => {
  const el = document.querySelector('[data-sa-inp="' + id + '"]');
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  let box = top;
  for (let n = top; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') { box = n; break; }
  box.style.setProperty('display', 'none', 'important');
}`;

export async function measureInteractions(browser, url, profile, opts, cfg = {}) {
  const { context, page } = await newPage(browser, profile);
  await context.addInitScript(INP_INIT);
  // После загрузки страницы переходы запрещены: нажатие на ссылку не должно уводить со страницы
  let lockNav = false;
  await context.route('**/*', (route) => {
    const req = route.request();
    if (lockNav && req.isNavigationRequest() && req.frame() === page.mainFrame()) return route.abort('aborted');
    return route.continue();
  });
  page.on('popup', (p) => p.close().catch(() => {}));
  page.on('dialog', (d) => d.dismiss().catch(() => {}));

  const out = { loadFired: true, targets: [], events: [], loaf: [], overlays: [] };
  try {
    await navigate(page, url, opts, out);
    if (out.error) return out;
    lockNav = true;
    await page.waitForTimeout(1000);
    const plan = await page.evaluate(`(${PLAN_FN})(${JSON.stringify(cfg)})`);
    out.pageType = plan.type;
    out.pageTypeSource = plan.typeSource;
    out.pageSignals = plan.signals;
    out.targets = plan.targets;
    const now = () => page.evaluate(() => performance.now());
    let pressed = 0; // сколько нажатий уже сделано: окна после них могли открыться от самого теста
    for (const t of out.targets) {
      if (t.notFound) continue;
      const loc = page.locator(`[data-sa-inp="${t.id}"]`).first();
      if (!(await loc.isVisible().catch(() => false))) {
        t.error = 'элемент есть в коде страницы, но скрыт — нажать его нельзя';
        continue;
      }
      try {
        await loc.scrollIntoViewIfNeeded({ timeout: 3000 });
        await page.waitForTimeout(400);
        // Как живой покупатель: сначала закрыть всплывающее окно, которое перекрывает элемент
        for (let k = 0; k < 3; k++) {
          const cover = await page.evaluate(`(${COVER_FN})(${JSON.stringify(t.id)})`);
          if (!cover) break;
          if (cover.closeText) {
            await page.locator('[data-sa-close]').first().click({ timeout: 3000, force: true }).catch(() => {});
            out.overlays.push({ overlay: cover.overlay, action: `закрыто кнопкой «${cover.closeText}»`, byTest: pressed > 0 });
          } else {
            await page.evaluate(`(${HIDE_FN})(${JSON.stringify(t.id)})`);
            out.overlays.push({ overlay: cover.overlay, action: 'скрыто для теста (нет кнопки закрытия)', byTest: pressed > 0 });
          }
          await page.waitForTimeout(600);
          await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
        }
        t.from = await now();
        const press = (o) => (profile.device.hasTouch ? loc.tap(o) : loc.click(o));
        try {
          await press({ timeout: 5000 });
        } catch {
          // Элемент перекрыт своей же обёрткой (кастомное поле, кнопка-иконка): нажимаем в его точку, как пальцем
          t.from = await now();
          await press({ timeout: 3000, force: true });
        }
        if (t.kind === 'search') await page.keyboard.type(t.word, { delay: 120 });
        await page.waitForTimeout(1200);
        t.to = await now();
        pressed++;
      } catch (e) {
        t.error = e.message.split('\n')[0];
      }
      // Закрыть открывшееся окно/меню, чтобы следующее действие шло по исходной странице
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(400);
    }
    const data = await page.evaluate(() => window.__inp || { events: [], loaf: [] });
    out.events = data.events;
    out.loaf = data.loaf;
  } catch (e) {
    out.error ??= e.message.split('\n')[0];
  } finally {
    await context.close();
  }
  return out;
}
