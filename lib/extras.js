// Углублённая аналитика страницы: разбор LCP и ответа сервера, картинки, шрифты, DOM,
// источники сдвигов вёрстки, неиспользуемый код, тест «без внешних сервисов», SEO.
import { makeInternalMatcher, serviceOf } from './services.js';
import { fmtMs, kb, shortUrl } from './analyze.js';
import { fieldGrade } from './crux.js';

const median = (arr) => {
  const a = arr.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

// ── Разбор LCP на 4 части (методика web.dev) ───────────────────────────────
export function lcpBreakdown(p) {
  const m = p.repMetrics;
  if (!m?.lcp) return null;
  const ttfb = m.ttfb || 0;
  const r = p.lcpUrl ? p.resources.find((x) => x.url === p.lcpUrl) : null;
  if (!r) {
    return { kind: 'text', parts: { ttfb, loadDelay: 0, loadTime: 0, renderDelay: Math.max(0, m.lcp - ttfb) }, total: m.lcp };
  }
  const start = Math.max(r.start, ttfb);
  const end = Math.min(Math.max(r.end, start), m.lcp);
  return {
    kind: 'image', url: r.url, bytes: r.bytes, internal: r.internal,
    parts: { ttfb, loadDelay: Math.max(0, start - ttfb), loadTime: Math.max(0, end - start), renderDelay: Math.max(0, m.lcp - end) },
    total: m.lcp,
  };
}
export const LCP_PART = {
  ttfb: ['Ответ сервера (TTFB)', 'Ускорить генерацию HTML и включить его кэширование (CDN, full-page cache).'],
  loadDelay: ['Задержка до начала загрузки', 'Браузер поздно узнаёт о картинке: она вставляется JavaScript-ом или стоит в очереди за скриптами. Выводите её прямо в HTML и добавьте <link rel="preload" as="image" fetchpriority="high">.'],
  loadTime: ['Загрузка ресурса LCP', 'Файл тяжёлый или медленно отдаётся: WebP/AVIF, правильный размер под экран (srcset), отдача с CDN.'],
  renderDelay: ['Задержка отрисовки', 'Ресурс уже загружен, но отрисовка ждёт CSS/JS или основной поток занят. Уберите блокирующие стили и скрипты, разгрузите основной поток.'],
};

// ── Ответ сервера на запрос HTML ───────────────────────────────────────────
export function serverInfo(rep) {
  const n = rep.navPhases || {};
  const h = rep.docHeaders || {};
  const cacheHeader = h['x-cache'] || h['cf-cache-status'] || h['x-cache-status'] || h['x-proxy-cache'] || '';
  let cache = 'unknown';
  if (/hit/i.test(cacheHeader) || Number(h.age) > 0) cache = 'hit';
  else if (/miss|expired|bypass|dynamic/i.test(cacheHeader)) cache = 'miss';
  else if (/no-store|private/i.test(h['cache-control'] || '')) cache = 'nostore';
  return { phases: n, headers: h, cache, cacheHeader };
}

// ── Картинки ───────────────────────────────────────────────────────────────
const LEGACY_SAVE = { 'image/png': 0.5, 'image/jpeg': 0.3, 'image/jpg': 0.3, 'image/gif': 0.5, 'image/bmp': 0.8 };
export function imagesAudit(p, rep) {
  const x = rep.extras;
  if (!x) return null;
  const byUrl = new Map(p.resources.map((r) => [r.url, r]));
  const dpr = x.dpr || 1;
  const items = [];
  for (const img of x.imgs) {
    const r = byUrl.get(img.src);
    const bytes = r?.bytes || 0;
    const ct = r?.contentType || (/\.png(\?|$)/i.test(img.src) ? 'image/png' : /\.jpe?g(\?|$)/i.test(img.src) ? 'image/jpeg' : '');
    const issues = [];
    let sizeSave = 0;
    let fmtRate = 0;
    const isLcp = img.src === p.lcpUrl;
    if (img.nw > 0 && img.visible && bytes > 10 * 1024) {
      const shown = img.w * img.h * dpr * dpr;
      const natural = img.nw * img.nh;
      if (shown > 0 && natural > shown * 1.5) {
        sizeSave = Math.round(bytes * (1 - shown / natural));
        issues.push({ k: 'oversized', t: `больше нужного: ${img.nw}×${img.nh}, показывается ${img.w}×${img.h}${dpr > 1 ? ` (×${dpr})` : ''}` });
      }
    }
    if (LEGACY_SAVE[ct] && bytes > 15 * 1024) {
      fmtRate = LEGACY_SAVE[ct];
      issues.push({ k: 'format', t: `формат ${ct.replace('image/', '').toUpperCase()} → WebP/AVIF` });
    }
    // Сначала уменьшение до нужного размера, затем смена формата для оставшегося объёма
    const save = Math.round(bytes - (bytes - sizeSave) * (1 - fmtRate));
    if (img.visible && !img.hasDims && !img.aspect) issues.push({ k: 'dims', t: 'нет width/height — сдвигает вёрстку при загрузке' });
    if (img.aboveFold && img.loading === 'lazy') issues.push({ k: 'lazyTop', t: 'loading="lazy" на первом экране — грузится позже нужного' });
    if (!img.aboveFold && img.visible && img.nw > 0 && img.loading !== 'lazy' && bytes > 10 * 1024) issues.push({ k: 'eager', t: 'ниже первого экрана, но грузится сразу — добавить loading="lazy"' });
    if (isLcp && img.fetchpriority !== 'high' && !x.preloads.some((l) => l.href === img.src)) issues.push({ k: 'lcpPrio', t: 'главная картинка (LCP) без fetchpriority="high" и preload' });
    if (issues.length) items.push({ src: img.src, desc: img.desc, bytes, ct, issues, save, isLcp, internal: r?.internal ?? true });
  }
  const all = p.resources.filter((r) => r.type === 'image');
  items.sort((a, b) => Number(b.isLcp) - Number(a.isLcp) || b.save - a.save || b.bytes - a.bytes);
  return {
    count: x.imgs.length, requests: all.length, bytes: all.reduce((a, r) => a + r.bytes, 0),
    save: items.reduce((a, i) => a + i.save, 0), items,
    counts: items.reduce((acc, i) => { i.issues.forEach((s) => (acc[s.k] = (acc[s.k] || 0) + 1)); return acc; }, {}),
  };
}

// ── Шрифты ─────────────────────────────────────────────────────────────────
export function fontsAudit(p, rep) {
  const x = rep.extras;
  if (!x) return null;
  const files = p.resources.filter((r) => r.type === 'font');
  const preloaded = x.preloads.filter((l) => l.as === 'font').length;
  const noSwap = x.fontFaces.filter((f) => !['swap', 'optional', 'fallback'].includes(f.display));
  const gf = p.resources.filter((r) => /fonts\.googleapis\.com\/css/.test(r.url));
  const gfNoSwap = gf.filter((r) => !/display=(swap|optional|fallback)/.test(r.url));
  return {
    files: files.length, bytes: files.reduce((a, r) => a + r.bytes, 0),
    hosts: [...new Set(files.map((r) => r.host))], families: [...new Set(x.fontFaces.map((f) => f.family))].length,
    preloaded, noSwap: [...new Set(noSwap.map((f) => f.family))], googleFonts: gf.length, gfNoSwap: gfNoSwap.length,
    slowest: [...files].sort((a, b) => b.end - a.end).slice(0, 5),
  };
}

// ── DOM ────────────────────────────────────────────────────────────────────
export function domInfo(rep) {
  const d = rep.extras?.dom;
  if (!d) return null;
  return { ...d, level: d.nodes > 1400 || d.maxDepth > 32 ? 'bad' : d.nodes > 800 ? 'warn' : 'ok' };
}

// ── Источники сдвигов вёрстки (по всем прогонам) ───────────────────────────
export function clsSources(okRuns) {
  const map = new Map();
  for (const run of okRuns) {
    for (const s of run.shifts || []) {
      const src = s.src.length ? s.src : ['(элемент удалён из DOM)'];
      for (const el of src) {
        const e = map.get(el) || { el, value: 0, count: 0, firstAt: Infinity };
        e.value += s.v / src.length / okRuns.length;
        e.count++;
        e.firstAt = Math.min(e.firstAt, s.t);
        map.set(el, e);
      }
    }
  }
  return [...map.values()].map((e) => ({ ...e, value: Math.round(e.value * 1000) / 1000 })).sort((a, b) => b.value - a.value).slice(0, 8);
}

// ── Неиспользуемый JS/CSS ──────────────────────────────────────────────────
export function coverageSummary(job, cov) {
  if (!cov?.files?.length) return cov?.error ? { error: cov.error } : null;
  const isInternal = makeInternalMatcher(job.site, job.internal);
  const files = cov.files.map((f) => {
    const host = new URL(f.url).hostname;
    const internal = isInternal(host);
    return { ...f, unused: f.total - f.used, usedPct: pct(f.used, f.total), internal, service: internal ? 'Сайт' : serviceOf(f.url).name, inline: f.url === job.url };
  }).sort((a, b) => b.unused - a.unused);
  const sum = (kind, fn = () => true) => files.filter((f) => f.kind === kind && fn(f)).reduce((a, f) => ({ total: a.total + f.total, unused: a.unused + f.unused }), { total: 0, unused: 0 });
  return { files: files.slice(0, 20), js: sum('js'), css: sum('css'), jsInternal: sum('js', (f) => f.internal), jsExternal: sum('js', (f) => !f.internal) };
}

// ── Тест «без внешних сервисов» ────────────────────────────────────────────
// Кандидаты для поштучной блокировки: те, кто сильнее всего влияет на загрузку
export function pickBlockCandidates(p, n) {
  const culprit = p.holders?.[0];
  return p.services.filter((s) => !s.internal).map((s) => {
    let score = s.cpu / 10 + s.slowCritical * 10 + s.blocking * 50 + s.errors * 20;
    if (culprit && !culprit.internal && culprit.service === s.service && culprit.duration > 2000) score += 200;
    return { service: s.service, score };
  }).filter((s) => s.score >= 5).sort((a, b) => b.score - a.score).slice(0, n).map((s) => s.service);
}

const BT_KEYS = ['fcp', 'lcp', 'tbt', 'load'];
export function blockTestSummary(p, scenarios) {
  if (!scenarios?.length) return null;
  const base = p.metrics;
  const spread = (k) => (p.range[k] ? p.range[k][1] - p.range[k][0] : 0);
  const baseCpu = p.totals.cpu;
  const rows = scenarios.map((sc) => {
    const ok = sc.runs.filter((r) => r.metrics);
    if (!ok.length) return { ...sc, runs: undefined, error: sc.runs[0]?.error || 'нет данных' };
    const m = {};
    for (const k of BT_KEYS) {
      const vals = ok.map((r) => (k === 'load' ? r.metrics.load ?? r.metrics.observed : r.metrics[k]));
      m[k] = median(vals);
    }
    m.loadMissing = ok.filter((r) => r.metrics.load == null).length > ok.length / 2;
    m.requests = median(ok.map((r) => r.resources.length));
    m.bytes = median(ok.map((r) => r.resources.reduce((a, x) => a + x.bytes, 0)));
    m.cpu = median(ok.map((r) => Object.entries(r.cpuByUrl || {}).filter(([u]) => /^https?:/.test(u)).reduce((a, [, v]) => a + v, 0)));
    const delta = {};
    const sig = {};
    for (const k of BT_KEYS) {
      const b = k === 'load' ? base.load ?? base.observed : base[k];
      if (b == null || m[k] == null) continue;
      delta[k] = m[k] - b;
      // Один прогон шумнее медианы нескольких — для него порог значимости выше
      const single = ok.length === 1;
      const thr = k === 'tbt'
        ? Math.max(single ? 100 : 50, spread(k) * (single ? 2 : 1))
        : Math.max(single ? 400 : 150, spread(k) * (single ? 2 : 1), Math.abs(b) * (single ? 0.2 : 0.1));
      sig[k] = Math.abs(delta[k]) > thr;
    }
    delta.cpu = m.cpu - baseCpu;
    return { key: sc.key, label: sc.label, service: sc.service, runsCount: ok.length, m, delta, sig };
  });
  return { rows, baseLoadMissing: base.load == null };
}

// ── SEO ────────────────────────────────────────────────────────────────────
const norm = (u) => { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, '') + x.search; } catch { return u; } };
export function seoSummary(p, seo) {
  if (!seo) return null;
  const checks = [];
  const add = (level, title, detail) => checks.push({ level, title, detail });
  const raw = seo.raw;
  const rend = seo.rendered;
  const bots = seo.agents.filter((a) => a.key !== 'browser');
  const browser = seo.agents.find((a) => a.key === 'browser');

  if (!raw) add('bad', 'Исходный HTML не получен', browser?.error || `статус ${browser?.status}`);
  if (raw && rend) {
    const ratio = rend.textLen ? raw.textLen / rend.textLen : 1;
    if (ratio < 0.3) add('bad', 'Контент страницы формируется JavaScript-ом', `В исходном HTML ${raw.textLen.toLocaleString('ru-RU')} символов текста и ${raw.links} ссылок, после выполнения JS — ${rend.textLen.toLocaleString('ru-RU')} и ${rend.links}. Пользователь видит пустую страницу, пока не загрузится и не выполнится JS; это напрямую задерживает FCP/LCP.`);
    else if (ratio < 0.7) add('warn', 'Часть контента появляется только после JS', `Текста в исходном HTML ${pct(raw.textLen, rend.textLen)}% от итогового.`);
    else add('ok', 'Контент есть в исходном HTML', `${pct(raw.textLen, rend.textLen)}% текста доступно без JS.`);
    if (!raw.h1.filter(Boolean).length && rend.h1.filter(Boolean).length) add('warn', 'H1 появляется только после JS', `После рендеринга: «${rend.h1[0]}».`);
    if (raw.title && rend.title && raw.title !== rend.title) add('warn', 'Title меняется JavaScript-ом', `В HTML: «${raw.title}», после JS: «${rend.title}».`);
  }
  if (raw && raw.inlineScriptBytes > 100 * 1024) add('warn', `Встроенные скрипты занимают ${kb(raw.inlineScriptBytes)} HTML`, `Крупнейший — ${kb(raw.largestInlineScript)} (обычно это JSON состояния приложения). Браузер должен скачать и разобрать его до отрисовки: уменьшите состав данных или грузите их отдельным запросом.`);

  // Роботы
  for (const b of bots) {
    if (b.error) add('bad', `${b.label}: нет ответа`, b.error);
    else if (b.blocked) add('bad', `${b.label}: доступ заблокирован (${b.status})`, 'Похоже на защиту от ботов. Проверьте, что настоящие роботы (по reverse DNS) не блокируются — иначе страница выпадет из индекса.');
    else if (b.status !== 200) add('bad', `${b.label}: ответ ${b.status}`, b.chain.map((c) => `${c.status} ${shortUrl(c.url, 70)}`).join(' → '));
    else {
      if (b.redirects) add('warn', `${b.label}: ${b.redirects} редирект(а)`, b.chain.map((c) => `${c.status} ${shortUrl(c.url, 70)}`).join(' → '));
      if (b.ttfb > 2000) add('warn', `${b.label}: медленный ответ ${fmtMs(b.ttfb)}`, 'Медленный ответ роботу уменьшает число страниц, которые он обходит за визит (краулинговый бюджет), и замедляет переиндексацию.');
      const h1 = b.h1.filter(Boolean);
      if (!b.h1.length) add('warn', `${b.label}: нет H1`, 'В версии страницы для робота нет заголовка H1.');
      else if (!h1.length) add('bad', `${b.label}: H1 пустой`, `В версии для робота ${b.h1.length} тег(а) H1 без текста.`);
      else if (b.h1.length > 1) add('warn', `${b.label}: ${b.h1.length} заголовка H1`, b.h1.map((x) => `«${x || 'пусто'}»`).join(', '));
      if (b.xRobots && /noindex/i.test(b.xRobots)) add('bad', `${b.label}: X-Robots-Tag: ${b.xRobots}`, 'Страница закрыта от индексации заголовком ответа.');
    }
  }
  const okBots = bots.filter((b) => !b.error && b.status === 200);
  if (browser?.bytes && okBots.length) {
    const diff = okBots.some((b) => b.bytes < browser.bytes * 0.6 || b.bytes > browser.bytes * 1.6 || Math.abs(b.textLen - (raw?.textLen || 0)) > 500);
    if (diff) add('info', 'Роботам отдаётся отдельная версия страницы (динамический рендеринг)', `Браузеру: ${kb(browser.bytes)} HTML, ${raw?.textLen || 0} символов текста; роботам: ${okBots.map((b) => `${kb(b.bytes)}, ${b.textLen} символов`).join(' / ')}. Google считает такой подход временным обходным решением и рекомендует серверный рендеринг (SSR) для всех. Следите, чтобы версии совпадали по контенту.`);
  }
  // robots.txt и мета-теги
  const rt = seo.robotsTxt;
  if (!rt.google.allowed) add('bad', 'robots.txt закрывает страницу для Google', rt.google.rule);
  if (!rt.yandex.allowed) add('bad', 'robots.txt закрывает страницу для Яндекса', rt.yandex.rule);
  const src = rend || raw;
  if (src) {
    const robots = `${raw?.robots || ''} ${rend?.robots || ''}`;
    if (/noindex/i.test(robots)) add('bad', 'Мета-тег robots: noindex', robots.trim());
    if (!src.title) add('bad', 'Нет title', '');
    else if (src.title.length > 70) add('warn', `Длинный title (${src.title.length} символов)`, `«${src.title}» — в выдаче обрежется после ~60–70 символов.`);
    else if (src.title.length < 15) add('warn', `Короткий title (${src.title.length} символов)`, `«${src.title}»`);
    if (!src.description) add('warn', 'Нет meta description', '');
    const canon = raw?.canonical || rend?.canonical;
    if (!canon) add('warn', 'Нет canonical', 'Без canonical поисковик сам выбирает основной адрес среди дублей (UTM-метки, сортировки, фильтры).');
    else if (norm(new URL(canon, p.page).href) !== norm(p.page)) add('warn', 'Canonical указывает на другой адрес', canon);
    if (!src.viewport) add('bad', 'Нет meta viewport', 'Страница не адаптирована для мобильных — критично для mobile-first индексации.');
    const types = [...new Set([...(raw?.jsonld || []), ...(rend?.jsonld || [])])];
    if (!types.length) add('warn', 'Нет микроразметки JSON-LD', 'Product/Offer/BreadcrumbList дают расширенные сниппеты в выдаче.');
    else add('ok', 'Микроразметка JSON-LD', types.join(', '));
  }
  const order = { bad: 0, warn: 1, info: 2, ok: 3 };
  checks.sort((a, b) => order[a.level] - order[b.level]);
  return { checks, agents: seo.agents, raw, rendered: rend, robotsTxt: rt };
}

// ── Рекомендации по углублённым данным ─────────────────────────────────────
export function extraRecs(p, opts) {
  const recs = [];
  const add = (prio, title, detail, items) => recs.push({ prio, title, detail, items });
  const x = p.extras || {};

  const bt = x.blockTest;
  if (bt) {
    const all = bt.rows.find((r) => r.key === 'noext');
    if (all && !all.error) {
      const parts = [];
      for (const [k, n] of [['lcp', 'LCP'], ['fcp', 'FCP'], ['tbt', 'TBT'], ['load', 'полная загрузка']]) {
        if (all.sig[k] && all.delta[k] < 0) parts.push(`${n} ${fmtMs(-all.delta[k])}`);
      }
      if (parts.length) add('high', `Внешние сервисы замедляют страницу: ${parts.join(', ')}`,
        'Столько выигрывает страница, если не загружать внешние сервисы вообще (тест с блокировкой). Это верхняя граница выигрыша от их оптимизации.',
        bt.rows.filter((r) => r.key !== 'noext' && !r.error && Object.keys(r.sig).some((k) => r.sig[k] && r.delta[k] < 0))
          .map((r) => `Без «${r.service}»: ${BT_KEYS.filter((k) => r.sig[k] && r.delta[k] < 0).map((k) => `${k.toUpperCase()} −${fmtMs(-r.delta[k])}`).join(', ')}`));
    }
  }

  const lb = x.lcpBreakdown;
  if (lb && p.metrics.lcp > 2500) {
    const [key, val] = Object.entries(lb.parts).sort((a, b) => b[1] - a[1])[0];
    add('high', `Главное в LCP — «${LCP_PART[key][0]}»: ${fmtMs(val)} из ${fmtMs(lb.total)}`, LCP_PART[key][1],
      Object.entries(lb.parts).map(([k, v]) => `${LCP_PART[k][0]}: ${fmtMs(v)} (${pct(v, lb.total)}%)`));
  }

  const srv = x.server;
  if (srv && p.metrics.ttfb > 800) {
    const ph = srv.phases;
    const conn = (ph.dns || 0) + (ph.connect || 0) + (ph.tls || 0);
    const repTtfb = p.repMetrics?.ttfb || p.metrics.ttfb;
    if (conn > repTtfb * 0.5 && conn > 500) {
      // Время ушло не на генерацию HTML, а на установление соединения
      add('high', `Медленное подключение к серверу: из TTFB ${fmtMs(repTtfb)} соединение заняло ${fmtMs(conn)}`,
        `DNS ${fmtMs(ph.dns || 0)}, TCP ${fmtMs(ph.connect || 0)}, TLS ${fmtMs(ph.tls || 0)}, генерация HTML — ${fmtMs(ph.server || 0)}. Долгое TCP/TLS-подключение обычно означает перегрузку балансировщика или защиты от DDoS (в том числе ограничение частых подключений с одного адреса — проверьте, не срабатывает ли оно на реальных посетителей), сетевые потери или удалённость сервера. Проверьте настройки защиты, включите TLS 1.3 и возобновление сессий, рассмотрите CDN ближе к посетителям.`);
    } else if (srv.cache !== 'hit') {
      add('high', `HTML не кэшируется, сервер генерирует его ${fmtMs(ph.server)}`,
        `Cache-Control: «${srv.headers['cache-control'] || 'нет'}»${srv.cacheHeader ? `, кэш прокси: ${srv.cacheHeader}` : ''}. Для каталога и карточек подойдёт кэш HTML на 1–5 минут на CDN/nginx с инвалидацией при изменении цен и остатков — TTFB снизится до 100–300 мс.`);
    }
  }

  const im = x.images;
  if (im && im.save > 100 * 1024) {
    add(im.save > 500 * 1024 ? 'high' : 'medium', `Картинки: можно сэкономить ~${kb(im.save)}`,
      'Оценка по формату (WebP/AVIF) и размерам относительно показа на экране.',
      im.items.filter((i) => i.save > 0).slice(0, 10).map((i) => `${i.isLcp ? '[LCP] ' : ''}${kb(i.bytes)} → −${kb(i.save)}: ${i.issues.map((s) => s.t).join('; ')} — ${shortUrl(i.src, 70)}`));
  }
  if (im?.counts.dims) add('medium', `Картинки без размеров: ${im.counts.dims}`, 'Без width/height браузер не резервирует место и вёрстка прыгает при загрузке (CLS).',
    im.items.filter((i) => i.issues.some((s) => s.k === 'dims')).slice(0, 6).map((i) => `<${i.desc}> ${shortUrl(i.src, 70)}`));
  if (im?.counts.lazyTop) add('medium', 'loading="lazy" у картинок первого экрана', 'Ленивая загрузка откладывает картинки, которые пользователь видит сразу. Уберите lazy для первого экрана.',
    im.items.filter((i) => i.issues.some((s) => s.k === 'lazyTop')).slice(0, 6).map((i) => shortUrl(i.src, 80)));
  if (im?.counts.eager > 3) add('low', `${im.counts.eager} картинок ниже первого экрана грузятся сразу`, 'Добавьте loading="lazy" — они перестанут конкурировать за сеть с важными ресурсами.');

  const cs = x.clsSources;
  if (cs?.length && p.metrics.cls > 0.1) add('high', 'Что вызывает сдвиги вёрстки (CLS)',
    'Элементы, которые сдвигаются при загрузке, и их вклад в CLS. Зарезервируйте место (min-height, aspect-ratio, скелетоны) под содержимое, которое подгружается позже.',
    cs.slice(0, 6).map((c) => `<${c.el}> — ${c.value} (первый сдвиг на ${fmtMs(c.firstAt)})`));

  const cov = x.coverage;
  if (cov?.js && cov.js.unused > 300 * 1024) add('medium', `Неиспользуемый JavaScript: ${kb(cov.js.unused)} из ${kb(cov.js.total)}`,
    'Код загружен и разобран браузером, но не выполнялся при загрузке страницы. Разделите бандлы по страницам, грузите редко нужные модули по требованию (dynamic import).',
    cov.files.filter((f) => f.kind === 'js').slice(0, 8).map((f) => `${f.internal ? 'Свой' : f.service}: ${kb(f.total)}, используется ${f.usedPct}% — ${shortUrl(f.url, 70)}`));
  if (cov?.css && cov.css.unused > 100 * 1024) add('low', `Неиспользуемый CSS: ${kb(cov.css.unused)} из ${kb(cov.css.total)}`,
    'Стили для других страниц и компонентов. Выделите критический CSS страницы, остальное грузите асинхронно.',
    cov.files.filter((f) => f.kind === 'css').slice(0, 5).map((f) => `${kb(f.total)}, используется ${f.usedPct}% — ${shortUrl(f.url, 70)}`));

  const fo = x.fonts;
  if (fo?.noSwap.length) add('medium', 'Шрифты без font-display: swap', 'Пока шрифт грузится, текст невидим. Добавьте font-display: swap в @font-face.', fo.noSwap);
  if (fo && fo.files > 6) add('low', `Много файлов шрифтов: ${fo.files} (${kb(fo.bytes)})`, 'Оставьте 2–3 начертания, используйте variable-шрифт и WOFF2, предзагрузите основной (<link rel="preload" as="font" crossorigin>).');

  const dom = x.dom;
  if (dom?.level === 'bad') add('medium', `Большой DOM: ${dom.nodes.toLocaleString('ru-RU')} элементов (норма до 1 400)`,
    'Большое дерево дольше отрисовывается и пересчитывается при каждом действии — страдает отклик на клики (INP). Виртуализация длинных списков, подгрузка товаров порциями, упрощение вёрстки карточек.');

  const wm = x.warm;
  if (wm && !wm.error) {
    if (wm.refetched.length >= 3 || wm.refetchedBytes > 50 * 1024) {
      add(wm.refetchedBytes > 300 * 1024 ? 'high' : 'medium',
        `Повторный визит: ${wm.refetched.length} своих файлов снова загружаются по сети (${kb(wm.refetchedBytes)})`,
        'Вернувшийся покупатель заново скачивает или перепроверяет файлы, которые могли бы взяться из кэша браузера. Для статики с версией в имени или параметре (hash, ?id=…) ставьте Cache-Control: public, max-age=31536000, immutable; для картинок — минимум несколько дней.',
        wm.refetched.slice(0, 10).map((r) => `${r.type}: ${r.status}, ${kb(r.netBytes)} — ${r.reason} — ${shortUrl(r.url, 70)}`));
    }
    if (wm.m.lcp > 2500) {
      add('medium', `Даже при повторном визите LCP ${fmtMs(wm.m.lcp)} — кэш браузера не решает проблему`,
        `При повторном визите файлы берутся из кэша, но страница всё равно отрисовывается медленно. Значит, главное — не вес файлов, а ${wm.m.ttfb > 800 ? `ответ сервера (TTFB повторного визита ${fmtMs(wm.m.ttfb)})` : 'выполнение JavaScript и порядок загрузки'}.`);
    }
  }

  const ia = x.interactions;
  if (ia && !ia.error && ia.inp > INP_THRESHOLDS[0]) {
    add(ia.inp > INP_THRESHOLDS[1] ? 'high' : 'medium',
      `Медленный отклик на действия: до ${fmtMs(ia.inp)} (норма INP ≤ 200 мс)`,
      'Покупатель нажимает — и страница какое-то время не реагирует. INP входит в Core Web Vitals. Разбейте долгие обработчики на части, переносите тяжёлую работу после отрисовки (requestAnimationFrame / setTimeout), разгрузите основной поток от сторонних скриптов.',
      ia.rows.filter((r) => r.dur > INP_THRESHOLDS[0]).map((r) => `${r.label}: ${fmtMs(r.dur)} (задержка ввода ${fmtMs(r.inputDelay)}, обработка ${fmtMs(r.processing)}, отрисовка ${fmtMs(r.presentation)})${r.scripts.length ? ` — выполнялись: ${r.scripts.map((sc) => `${sc.internal ? 'свой' : sc.service} ${fmtMs(sc.dur)}`).join(', ')}` : ''}`));
  }
  if (ia?.overlays?.length) {
    add('medium', `Всплывающие окна перекрывают элементы страницы (${ia.overlays.length})`,
      'Во время теста окна закрывали кнопки, фильтры или меню — покупателю тоже приходится сначала их закрывать. Показывайте такие окна не сразу, не поверх ключевых элементов и с заметной кнопкой закрытия.',
      ia.overlays.map((o) => `<${o.overlay}> — ${o.action}`));
  }

  const f = x.field;
  if (f?.level) {
    const where = f.level === 'url' ? 'этой страницы' : 'сайта в целом (у страницы мало визитов)';
    const dev = f.formFactor === 'PHONE' ? 'смартфонах' : 'компьютерах';
    const fv = (k, v) => (k === 'cls' ? v : fmtMs(v));
    const NAME = { lcp: 'LCP', inp: 'INP', cls: 'CLS', fcp: 'FCP', ttfb: 'TTFB' };
    const bad = ['lcp', 'inp', 'cls'].filter((k) => f.metrics[k]?.p75 != null && fieldGrade(k, f.metrics[k].p75) !== 'good');
    if (f.cwvPass === false) {
      const items = bad.map((k) => {
        const m = f.metrics[k];
        return `${NAME[k]}: ${fv(k, m.p75)} у 75% визитов (норма ≤ ${k === 'cls' ? '0,1' : k === 'inp' ? '200 мс' : '2,5 с'}); хороших визитов ${Math.round((m.dist[0] || 0) * 100)}%, плохих ${Math.round((m.dist[2] || 0) * 100)}%`;
      });
      // Полевой разбор LCP: какая из 4 частей у реальных посетителей самая долгая
      const lp = f.lcpParts || {};
      if (bad.includes('lcp') && Object.keys(lp).length === 4) {
        const [k, v] = Object.entries(lp).sort((a, b) => b[1] - a[1])[0];
        items.push(`У реальных посетителей в LCP дольше всего — «${LCP_PART[k][0]}»: ${fmtMs(v)}. ${LCP_PART[k][1]}`);
      }
      if (bad.includes('inp') && x.interactions && !x.interactions.error && (x.interactions.inp ?? 0) <= INP_THRESHOLDS[0]) {
        items.push('В тесте отклика INP был в норме — значит, посетители нажимают другие элементы или их устройства медленнее. Задайте ключевые действия сайта в actions.txt.');
      }
      add('high', `Реальные посетители: Core Web Vitals не пройдены на ${dev} — ${bad.map((k) => NAME[k]).join(', ')}`,
        `Данные Chrome UX Report за 28 дней по ${where}. Именно эти значения Google использует в ранжировании: метрика должна быть в зелёной зоне у 75% визитов.`, items);
    }
    const labBetter = f.gaps.filter((g) => g.kind === 'labBetter');
    if (labBetter.length) {
      add('medium', `В замере страница быстрее, чем у реальных посетителей: ${labBetter.map((g) => `${NAME[g.k]} ${fmtMs(g.lab)} в замере, ${fmtMs(g.field)} у посетителей`).join('; ')}`,
        'Обычно причины: у посетителей слабее устройства и сеть, чем в профиле замера; они приходят с рекламы и из поиска с параметрами в адресе (другой кэш), у них cookies, авторизация и персонализация, больше внешних скриптов (согласие на cookies, A/B-тесты). Ориентируйтесь на полевые значения, а лабораторный замер используйте для поиска причин.');
    }
    const worse = Object.entries(f.trend || {}).filter(([, t]) => t.sig && !t.better);
    if (worse.length) {
      add(worse.some(([k, t]) => fieldGrade(k, t.to) !== 'good') ? 'medium' : 'low',
        `У реальных посетителей ${f.level === 'url' ? '' : 'сайта '}ухудшилось за полгода: ${worse.map(([k, t]) => `${NAME[k]} ${fv(k, t.from)} → ${fv(k, t.to)}`).join(', ')}`,
        'Сравнение среднего за первые и последние 4 недели истории CrUX. Найдите, что менялось на сайте в этот период: релизы, новые внешние сервисы, баннеры, рост каталога.');
    }
  }

  for (const c of x.seo?.checks || []) {
    if (c.level === 'bad') add('high', `SEO: ${c.title}`, c.detail);
  }
  return recs;
}

// Объединение базовых и углублённых рекомендаций без дублей: углублённая версия заменяет общую
export function mergeRecs(base, extra, p) {
  const out = [...base];
  const take = (prefix) => {
    const i = out.findIndex((r) => r.title.startsWith(prefix));
    return i >= 0 ? out.splice(i, 1)[0] : null;
  };
  for (const r of extra) {
    if (r.title.startsWith('Главное в LCP')) {
      const old = take('Долгая отрисовка основного контента');
      if (old) {
        r.title = `LCP ${fmtMs(p.metrics.lcp)} (норма ≤ 2,5 с): больше всего — ${r.title.replace(/^Главное в LCP — /, '')}`;
        r.items = [...(r.items || []), ...(old.items || []).filter((x) => !x.startsWith('Значительная часть LCP'))];
      }
    } else if (r.title.startsWith('Что вызывает сдвиги')) {
      if (take('Сдвиги макета')) r.title = `Сдвиги вёрстки: CLS ${p.metrics.cls} (норма ≤ 0,1) — что их вызывает`;
    } else if (r.title.startsWith('Повторный визит:')) {
      take('Свои JS/CSS с коротким кэшем'); // углублённая версия: с фактическим поведением кэша
    } else if (r.title.startsWith('Медленное подключение к серверу')) {
      take('Медленный ответ сервера'); // общая рекомендация про генерацию HTML здесь неверна — время ушло на соединение
    } else if (r.title.startsWith('HTML не кэшируется')) {
      const old = take('Медленный ответ сервера');
      if (old) {
        r.title = `Медленный ответ сервера: TTFB ${fmtMs(p.metrics.ttfb)} — ${r.title.replace(/^HTML не кэшируется, сервер/, 'HTML не кэшируется, сервер')}`;
        r.detail = `${old.detail} ${r.detail}`;
      }
    }
    out.push(r);
  }
  const order = { high: 0, medium: 1, low: 2 };
  return out.sort((a, b) => order[a.prio] - order[b.prio]);
}

// ── Повторный визит (прогретый кэш браузера) ───────────────────────────────
const FROM_CACHE = new Set(['disk', 'memory', 'prefetch', 'sw']);
const fmtAge = (sec) => (sec >= 86400 ? `${Math.round(sec / 86400)} дн.` : sec >= 3600 ? `${Math.round(sec / 3600)} ч` : sec >= 60 ? `${Math.round(sec / 60)} мин` : `${sec} с`);

// Почему файл не взялся из кэша — по заголовку Cache-Control
export function cacheReason(cc, status) {
  cc = (cc || '').toLowerCase();
  if (/no-store/.test(cc)) return 'запрещено хранить в кэше (no-store)';
  if (/no-cache|max-age=0\b/.test(cc)) return 'перепроверяется при каждом визите (no-cache / max-age=0)';
  if (!cc) return status === 304 ? 'перепроверка: нет Cache-Control со сроком хранения' : 'нет заголовка Cache-Control';
  const ma = /max-age=(\d+)/.exec(cc);
  if (ma && Number(ma[1]) < 86400) return `короткий срок кэша: ${fmtAge(Number(ma[1]))}`;
  if (status === 304) return 'перепроверка (304)';
  return 'срок кэша не истёк, но файл скачан заново (меняется адрес, Vary или ответ не кэшируется)';
}

export function warmSummary(p, warm) {
  const ok = (warm?.runs || []).filter((r) => r.metrics);
  if (!ok.length) return warm ? { error: warm.runs?.[0]?.error || warm.prime?.error || 'нет данных' } : null;
  const keys = ['ttfb', 'fcp', 'lcp', 'tbt', 'cls', 'load'];
  const m = {};
  for (const k of keys) m[k] = median(ok.map((r) => r.metrics[k]));
  if (ok.filter((r) => r.metrics.load == null).length > ok.length / 2) m.load = null;
  const rep = [...ok].sort((a, b) => (a.metrics.load ?? a.metrics.observed) - (b.metrics.load ?? b.metrics.observed))[Math.floor((ok.length - 1) / 2)];

  const isCached = (r) => FROM_CACHE.has(r.cache);
  const res = rep.resources.filter((r) => !r.url.startsWith('data:'));
  const internalOf = new Map(p.resources.map((r) => [r.url, r.internal]));
  const siteHost = new URL(p.page).hostname.replace(/^www\./, '');
  const internal = (r) => internalOf.get(r.url) ?? (() => { try { return new URL(r.url).hostname.endsWith(siteHost); } catch { return false; } })();
  const counts = {
    total: res.length,
    cached: res.filter(isCached).length,
    revalidated: res.filter((r) => !isCached(r) && r.status === 304).length,
  };
  counts.network = counts.total - counts.cached - counts.revalidated;

  // Свои статические файлы, которые при повторном визите снова пошли в сеть
  const STATIC = new Set(['script', 'stylesheet', 'font', 'image']);
  const refetched = res.filter((r) => !isCached(r) && STATIC.has(r.type) && internal(r) && r.status !== 'FAILED' && r.status !== 'PENDING')
    .map((r) => ({ url: r.url, type: r.type, status: r.status, netBytes: r.netBytes, cacheControl: r.cacheControl, reason: cacheReason(r.cacheControl, r.status), duration: r.duration }))
    .sort((a, b) => b.netBytes - a.netBytes || b.duration - a.duration);
  const extRefetched = res.filter((r) => !isCached(r) && STATIC.has(r.type) && !internal(r)).length;

  const coldNet = p.resources.reduce((a, r) => a + (r.netBytes || 0), 0);
  const warmNet = res.reduce((a, r) => a + (r.netBytes || 0), 0);
  const coldReq = p.resources.length;
  const delta = {};
  for (const k of keys) {
    const a = m[k];
    const b = p.metrics[k];
    if (a == null || b == null) continue;
    const thr = k === 'cls' ? 0.05 : k === 'tbt' ? Math.max(50, b * 0.2) : Math.max(150, b * 0.1);
    delta[k] = { d: a - b, sig: Math.abs(a - b) >= thr };
  }
  return {
    runs: ok.length, m, delta, counts, refetched, extRefetched,
    net: { cold: coldNet, warm: warmNet }, requests: { cold: coldReq, warm: counts.total, warmNetwork: counts.network + counts.revalidated },
    refetchedBytes: refetched.reduce((a, r) => a + r.netBytes, 0),
  };
}

// ── Отклик на действия (INP в лабораторном замере) ─────────────────────────
export function interactionsSummary(job, raw) {
  if (!raw) return null;
  if (!raw.targets?.length) return { error: raw.error || 'на странице не найдено подходящих элементов для нажатия — задайте их для сайта в actions.txt', rows: [], overlays: (raw.overlays || []).filter((o) => !o.byTest), pageType: raw.pageType, pageTypeSource: raw.pageTypeSource };
  const isInternal = makeInternalMatcher(job.site, job.internal);
  const rows = raw.targets.map((t) => {
    const base = { kind: t.kind, label: t.label, text: t.text, desc: t.desc, source: t.source };
    if (t.notFound) return { ...base, error: 'элемент не найден на странице (проверьте текст или селектор в actions.txt)', notFound: true };
    if (t.error) return { ...base, error: t.error };
    // События одного взаимодействия (pointerdown, pointerup, click, keydown…) объединяются по interactionId
    const byId = new Map();
    for (const e of raw.events.filter((x) => x.start >= t.from - 1 && x.start <= t.to)) {
      const g = byId.get(e.id) || { start: e.start, dur: 0, ps: Infinity, pe: 0 };
      g.start = Math.min(g.start, e.start);
      g.dur = Math.max(g.dur, e.dur);
      g.ps = Math.min(g.ps, e.ps);
      g.pe = Math.max(g.pe, e.pe);
      byId.set(e.id, g);
    }
    const worst = [...byId.values()].sort((a, b) => b.dur - a.dur)[0];
    if (!worst) return { ...base, fast: true, dur: null };
    // Какие скрипты выполнялись в кадрах, пересекающихся с этим взаимодействием
    const end = worst.start + worst.dur;
    const scripts = new Map();
    for (const f of raw.loaf.filter((f) => f.start < end && f.start + f.dur > worst.start)) {
      for (const sc of f.scripts) {
        if (!sc.url) continue;
        scripts.set(sc.url, (scripts.get(sc.url) || 0) + sc.dur);
      }
    }
    const top = [...scripts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([url, dur]) => {
      let host = '';
      try { host = new URL(url).hostname; } catch {}
      const internal = isInternal(host);
      return { url, dur: Math.round(dur), internal, service: internal ? 'Сайт' : serviceOf(url).name };
    });
    return {
      ...base, dur: Math.round(worst.dur),
      inputDelay: Math.max(0, Math.round(worst.ps - worst.start)),
      processing: Math.max(0, Math.round(worst.pe - worst.ps)),
      presentation: Math.max(0, Math.round(end - worst.pe)),
      scripts: top,
    };
  });
  const measured = rows.filter((r) => !r.error);
  const inp = measured.length ? Math.max(...measured.map((r) => r.dur ?? 0)) : null;
  // Окна сайта — те, что перекрывали элементы до первого нажатия; открытые самим тестом (меню, панель фильтра) не в счёт
  const overlays = (raw.overlays || []).filter((o) => !o.byTest);
  return { rows, inp, tested: measured.length, overlays, testOverlays: (raw.overlays || []).filter((o) => o.byTest), pageType: raw.pageType, pageTypeSource: raw.pageTypeSource };
}

export const INP_THRESHOLDS = [200, 500];
export const inpGrade = (v) => (v == null ? 'na' : v <= INP_THRESHOLDS[0] ? 'good' : v <= INP_THRESHOLDS[1] ? 'ni' : 'poor');

// ── Раскадровка загрузки ───────────────────────────────────────────────────
// Кадры приходят только при изменении экрана; на ленту ставится последний кадр к каждому моменту времени.
// Шаг ленты подбирается так, чтобы загрузка уместилась примерно в 30 кадров.
const FILM_STEPS = [250, 500, 1000, 2000, 3000, 5000];
export function filmstripSummary(run, { mobile = false, warm = false } = {}) {
  const frames = run?.frames;
  const m = run?.metrics;
  if (!frames?.length || !m) return null;
  // Конец ленты: чуть позже отрисовки главного элемента (LCP). Полная загрузка включается, только если она ненамного позже:
  // зависшие рекламные скрипты часто откладывают load на десятки секунд, и лента с крупным шагом теряет начало загрузки.
  const main = Math.max(m.lcp ?? 0, m.fcp ?? 0) || m.load || m.observed;
  let end = main + Math.max(1000, main * 0.3);
  if (m.load != null && m.load <= end * 1.5) end = Math.max(end, m.load + 500);
  end = Math.min(end, m.observed);
  const step = FILM_STEPS.find((s) => end / s <= 30) ?? Math.ceil(end / 30 / 1000) * 1000;
  const used = new Map(); // индекс кадра → индекс в сохранённом списке
  const kept = [];
  const slots = [];
  let fi = -1;
  for (let t = 0; t <= end + step - 1; t += step) {
    while (fi + 1 < frames.length && frames[fi + 1].t <= t) fi++;
    // До первого кадра новой страницы — пустой слот (при повторном визите старый экран не показываем)
    if (fi < 0) {
      slots.push({ t, f: null, changed: !slots.length });
      continue;
    }
    if (!used.has(fi)) {
      used.set(fi, kept.length);
      kept.push(frames[fi].data);
    }
    slots.push({ t, f: used.get(fi), changed: slots.length === 0 || slots.at(-1).f !== used.get(fi) });
  }
  // Отметки событий загрузки и сдвигов вёрстки — на первом кадре, снятом после события
  const marks = [['FCP', m.fcp], ['LCP', m.lcp], ['load', m.load]].filter(([, v]) => v != null);
  for (const s of slots) {
    s.marks = marks.filter(([, v]) => v > s.t - step && v <= s.t).map(([n]) => n);
    const cls = (run.shifts || []).filter((x) => x.t > s.t - step && x.t <= s.t).reduce((a, x) => a + x.v, 0);
    if (cls >= 0.01) s.shift = Math.round(cls * 1000) / 1000;
  }
  // Последнее изменение экрана в пределах ленты — «визуально готово» (бесконечные карусели дают изменения и позже)
  const lastChange = frames.filter((f) => f.t <= end).at(-1)?.t ?? null;
  const changedAfter = frames.filter((f) => f.t > end).length;
  return {
    step, end: Math.round(end), frames: kept, slots, lastChange, changedAfter, rawFrames: frames.length,
    metrics: { fcp: m.fcp, lcp: m.lcp, load: m.load, cls: m.cls },
    mobile, warm,
  };
}
