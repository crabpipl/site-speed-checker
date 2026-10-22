// Аналитика по замерам: агрегация прогонов, классификация ресурсов, рекомендации.
import { makeInternalMatcher, serviceOf } from './services.js';

// Пороги Google Core Web Vitals (good / poor); load — ориентир, официального порога нет.
export const THRESHOLDS = {
  ttfb: [800, 1800],
  fcp: [1800, 3000],
  lcp: [2500, 4000],
  cls: [0.1, 0.25],
  tbt: [200, 600],
  load: [3000, 6000],
};

export function grade(metric, v) {
  if (v == null) return metric === 'load' ? 'poor' : 'na';
  const [g, p] = THRESHOLDS[metric];
  return v <= g ? 'good' : v <= p ? 'ni' : 'poor';
}

const median = (arr) => {
  const a = arr.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// Типы ресурсов, которых ждёт событие load. Фоновые fetch/XHR/beacon его не задерживают.
const LOAD_TYPES = new Set(['document', 'script', 'stylesheet', 'image', 'media', 'font', 'texttrack']);

// Порог, после которого незавершённый запрос считается зависшим, а не «не успел к концу замера»
const HANG_MS = 5000;

export function statusClass(r) {
  const s = r.status;
  if (s === 200) return 'ok';
  if (s === 'FAILED') return /ERR_ABORTED/.test(r.statusText) ? 'aborted' : 'failed';
  // Незавершённый запрос — ошибка («висит»), только если его ждёт загрузка страницы (скрипт, картинка, стиль…).
  // Фоновый fetch/XHR, не закончившийся к концу замера (счётчики, долгие соединения), — не ошибка: ответа просто не дождались
  if (s === 'PENDING') return r.duration >= HANG_MS && (!r.type || LOAD_TYPES.has(r.type)) ? 'pending' : 'inflight';
  if (s === 204) return 'empty';
  if (s >= 300 && s < 400) return 'redirect';
  if (s >= 400 && s < 500) return 'client';
  if (s >= 500) return 'server';
  return 'other';
}
export const isError = (cls) => ['failed', 'pending', 'client', 'server'].includes(cls);

const keyOf = (url) => {
  try { const u = new URL(url); return u.origin + u.pathname; } catch { return url; }
};


function phaseOf(r, m) {
  if (r.renderBlocking) return 'blocking';
  if (!LOAD_TYPES.has(r.type)) return 'async';
  if (m.dcl && r.end <= m.dcl) return 'dcl';
  if (m.load != null) return r.start < m.load && r.end <= m.load + 5 ? 'load' : 'after';
  return r.status === 'PENDING' ? 'hanging' : 'noload';
}
export const PHASE_LABEL = {
  blocking: 'Блокирует отрисовку',
  dcl: 'До DOMContentLoaded',
  load: 'До события load',
  after: 'После load',
  noload: 'До окончания замера (load не наступил)',
  hanging: 'Висит — не дождались ответа',
  async: 'Фоновый запрос (не задерживает load)',
};
const CRITICAL = new Set(['blocking', 'dcl', 'load', 'noload', 'hanging']);

const fmtMs = (v) => (v == null ? '—' : v >= 1000 ? (v / 1000).toFixed(2) + ' с' : Math.round(v) + ' мс');

// Условия замера словами: по ним видно, откуда на смартфоне берутся десятки секунд
export function conditionsText(opts) {
  const n = opts?.network;
  if (n?.downloadThroughput) {
    const mbit = (n.downloadThroughput * 8 / 1024 / 1024).toFixed(1).replace('.', ',');
    return `смартфон (эмуляция): канал ${mbit} Мбит/с, задержка ${n.latency} мс${opts.cpu > 1 ? `, процессор в ${opts.cpu} раза медленнее` : ''}`;
  }
  if (opts?.profileName === 'mobile') return 'смартфон (эмуляция): канал 1,6 Мбит/с, задержка 150 мс, процессор в 4 раза медленнее';
  return 'компьютер: сеть этого компьютера без ограничений';
}
// Ресурс долгий из-за ожидания ответа (сервер), а не из-за скачивания (канал, вес страницы)
export const waitBound = (r) => r.ttfb != null && r.ttfb >= r.duration * 0.5;
const splitText = (r) => (r.ttfb != null ? `ожидание ответа ${fmtMs(r.ttfb)} + скачивание ${fmtMs(Math.max(0, r.duration - r.ttfb))}` : `${fmtMs(r.duration)}`);
const shortUrl = (u, n = 90) => (u.length > n ? u.slice(0, n) + '…' : u);

export function analyzePage(job, runs, opts) {
  const isInternal = makeInternalMatcher(job.site, job.internal);
  const okRuns = runs.filter((r) => r.metrics);
  const res = { site: job.site, page: job.url, runs: runs.length, okRuns: okRuns.length };
  if (!okRuns.length) {
    res.error = runs[0]?.error || 'Страница не загрузилась';
    res.grade = 'poor';
    res.recs = [{ prio: 'high', title: 'Страница не открылась', detail: res.error }];
    return res;
  }

  // Метрики — медиана по прогонам
  const keys = ['ttfb', 'fcp', 'lcp', 'cls', 'tbt', 'dcl', 'load', 'observed', 'longTasks', 'htmlBytes', 'redirects'];
  const m = {};
  const range = {};
  for (const k of keys) {
    const vals = okRuns.map((r) => r.metrics[k]);
    m[k] = median(vals);
    const nums = vals.filter((v) => v != null);
    range[k] = nums.length ? [Math.min(...nums), Math.max(...nums)] : null;
  }
  const loadMissing = okRuns.filter((r) => r.metrics.load == null).length;
  if (loadMissing > okRuns.length / 2) m.load = null;
  res.metrics = m;
  res.range = range;
  res.loadMissing = loadMissing;
  res.status = okRuns[0].status;

  // Представительный прогон — медианный по времени загрузки
  const sorted = [...okRuns].sort((a, b) => (a.metrics.load ?? a.metrics.observed) - (b.metrics.load ?? b.metrics.observed));
  const rep = sorted[Math.floor((sorted.length - 1) / 2)];
  const rm = rep.metrics;
  res.repMetrics = rm;
  res.lcpElement = rep.lcpElement;
  res.lcpUrl = rep.lcpUrl;
  // Кто вставил главную картинку — записывается только в первом прогоне; берём, если там та же картинка
  res.lcpOrigin = okRuns.find((r) => r.lcpOrigin && r.lcpUrl === rep.lcpUrl)?.lcpOrigin ?? null;
  res.internalDomains = job.internal ?? [];

  const resources = rep.resources.map((r) => {
    const host = (() => { try { return new URL(r.url).hostname; } catch { return ''; } })();
    const internal = r.url.startsWith('data:') || isInternal(host);
    const svc = serviceOf(r.url);
    const cls = statusClass(r);
    const phase = phaseOf(r, rm);
    return {
      ...r, host, internal,
      service: internal ? 'Сайт' : svc.name,
      category: internal ? 'Собственные ресурсы' : svc.category,
      cls, phase, critical: CRITICAL.has(phase),
      slow: r.duration >= opts.slow,
    };
  }).filter((r) => !r.url.startsWith('data:'));
  res.resources = resources;

  // Ошибки (не 200) — по всем прогонам, т.к. сбои внешних сервисов плавают
  const errMap = new Map();
  for (const run of okRuns) {
    const seen = new Set();
    for (const r of run.resources) {
      const cls = statusClass(r);
      if (cls === 'ok' || cls === 'inflight' || r.url.startsWith('data:')) continue;
      const k = keyOf(r.url) + '|' + r.status;
      const host = (() => { try { return new URL(r.url).hostname; } catch { return ''; } })();
      const e = errMap.get(k) || {
        url: r.url, key: keyOf(r.url), type: r.type, status: r.status, statusText: r.statusText, cls,
        internal: isInternal(host), service: isInternal(host) ? 'Сайт' : serviceOf(r.url).name,
        waits: [], runs: 0, phases: new Set(),
      };
      e.waits.push(r.duration);
      e.phases.add(phaseOf(r, run.metrics));
      if (!seen.has(k)) { e.runs++; seen.add(k); }
      errMap.set(k, e);
    }
  }
  res.errors = [...errMap.values()]
    .map((e) => ({ ...e, phases: [...e.phases], wait: median(e.waits), waitMax: Math.max(...e.waits), waits: undefined }))
    .sort((a, b) => sevRank(a.cls) - sevRank(b.cls) || b.wait - a.wait);

  // Сводка по сервисам (внешним) и по своим ресурсам
  const svcMap = new Map();
  for (const r of resources) {
    const s = svcMap.get(r.service) || {
      service: r.service, category: r.category, internal: r.internal, hosts: new Set(),
      requests: 0, bytes: 0, cpu: 0, errors: 0, redirects: 0, slowCritical: 0, blocking: 0, maxDuration: 0, lastEnd: 0,
    };
    s.hosts.add(r.host);
    s.requests++;
    s.bytes += r.bytes;
    s.errors += isError(r.cls) ? 1 : 0;
    s.redirects += r.cls === 'redirect' ? 1 : 0;
    s.slowCritical += r.slow && r.critical ? 1 : 0;
    s.blocking += r.renderBlocking ? 1 : 0;
    s.maxDuration = Math.max(s.maxDuration, r.duration);
    if (r.critical) s.lastEnd = Math.max(s.lastEnd, r.end);
    svcMap.set(r.service, s);
  }
  // CPU по URL скриптов (включая инлайн-код, который атрибутируется URL страницы)
  for (const [url, ms] of Object.entries(rep.cpuByUrl || {})) {
    if (!/^https?:/.test(url)) continue;
    const host = new URL(url).hostname;
    const name = isInternal(host) ? 'Сайт' : serviceOf(url).name;
    const s = svcMap.get(name);
    if (s) s.cpu += ms;
  }
  res.services = [...svcMap.values()]
    .map((s) => ({ ...s, hosts: [...s.hosts], cpu: Math.round(s.cpu) }))
    .sort((a, b) => b.maxDuration - a.maxDuration);

  res.cpuTop = Object.entries(rep.cpuByUrl || {})
    .filter(([u]) => /^https?:/.test(u))
    .map(([url, ms]) => {
      const host = new URL(url).hostname;
      return { url, ms: Math.round(ms), internal: isInternal(host), service: isInternal(host) ? 'Сайт' : serviceOf(url).name };
    })
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 15);

  // Что держит загрузку: самые поздние ресурсы на критическом пути
  res.holders = resources
    .filter((r) => r.critical)
    .sort((a, b) => b.end - a.end)
    .slice(0, 8);

  res.totals = {
    requests: resources.length,
    bytes: resources.reduce((a, r) => a + r.bytes, 0),
    jsBytes: resources.filter((r) => r.type === 'script').reduce((a, r) => a + r.bytes, 0),
    extRequests: resources.filter((r) => !r.internal).length,
    extServices: res.services.filter((s) => !s.internal).length,
    extDomains: new Set(resources.filter((r) => !r.internal).map((r) => r.host)).size,
    cpu: Math.round(Object.entries(rep.cpuByUrl || {}).filter(([u]) => /^https?:/.test(u)).reduce((a, [, v]) => a + v, 0)),
  };

  const grades = ['ttfb', 'fcp', 'lcp', 'cls', 'tbt', 'load'].map((k) => grade(k, m[k]));
  res.grade = grades.includes('poor') ? 'poor' : grades.includes('ni') ? 'ni' : 'good';
  res.recs = recommend(res, opts);
  return res;
}

const sevRank = (cls) => ({ failed: 0, pending: 0, server: 1, client: 2, redirect: 3, aborted: 4, empty: 5, other: 6 })[cls] ?? 7;

function recommend(p, opts) {
  const recs = [];
  const m = p.metrics;
  const add = (prio, title, detail, items) => recs.push({ prio, title, detail, items });

  if (m.ttfb > THRESHOLDS.ttfb[0]) {
    add(m.ttfb > THRESHOLDS.ttfb[1] ? 'high' : 'medium',
      `Медленный ответ сервера: TTFB ${fmtMs(m.ttfb)} (норма ≤ 0,8 с)`,
      'Браузер ждёт первый байт HTML — всё остальное стоит в очереди. Проверьте время генерации страницы на бэкенде (медленные SQL-запросы, внешние API в момент рендера), включите кэширование HTML (full-page cache, кэш блоков, Varnish/nginx microcache) и раздачу через CDN.');
  }
  if (m.lcp > THRESHOLDS.lcp[0]) {
    const items = [];
    if (p.lcpUrl) items.push(`Ресурс LCP: ${p.lcpUrl}`);
    if (p.lcpElement) items.push(`Элемент LCP: <${p.lcpElement}>`);
    if (m.ttfb > 800) items.push('Значительная часть LCP — ожидание HTML (см. TTFB)');
    add(m.lcp > THRESHOLDS.lcp[1] ? 'high' : 'medium',
      `Долгая отрисовка основного контента: LCP ${fmtMs(m.lcp)} (норма ≤ 2,5 с)`,
      'LCP — время, когда виден главный элемент страницы, одна из метрик Core Web Vitals. Google оценивает её по данным реальных посетителей; лабораторный замер показывает причины.', items);
  }
  const blocking = p.resources.filter((r) => r.renderBlocking);
  const extBlocking = blocking.filter((r) => !r.internal);
  if (extBlocking.length) {
    add('high', `Внешние ресурсы блокируют отрисовку страницы (${extBlocking.length})`,
      'Пока они не загрузятся, пользователь видит белый экран. Если сервис упадёт или затормозит — страница «зависнет» вместе с ним. Подключайте их с async/defer или после загрузки страницы.',
      extBlocking.map((r) => `${r.service}: ${shortUrl(r.url)} — ${fmtMs(r.duration)}`));
  }
  const intBlocking = blocking.filter((r) => r.internal);
  if (intBlocking.length > 2 || intBlocking.some((r) => r.duration > 500)) {
    add('medium', `Свои блокирующие CSS/JS в <head> (${intBlocking.length})`,
      'Для скриптов — атрибут defer (или type="module"); критический CSS первого экрана инлайнить, остальной загружать асинхронно (media="print" onload / preload).',
      intBlocking.sort((a, b) => b.duration - a.duration).slice(0, 8).map((r) => `${r.type}: ${shortUrl(r.url)} — ${fmtMs(r.duration)}`));
  }

  if (m.load == null) {
    add('high', 'Событие load не наступило за время замера',
      `Событие полной загрузки (load) не наступило за ${fmtMs(opts.timeout)}: всё это время индикатор загрузки в браузере крутится, а скрипты сайта, которые ждут этого события, не запускаются. Ниже — ресурсы, которые грузились последними или так и не ответили.`,
      p.holders.slice(0, 6).map((r) => `${r.internal ? 'Свой' : r.service}: ${shortUrl(r.url)} — ${r.status}, ${fmtMs(r.duration)}`));
  } else if (m.load > THRESHOLDS.load[0]) {
    const culprit = p.holders.find((r) => r.end >= p.repMetrics.load - 300 && r.duration >= 2000);
    add(m.load > THRESHOLDS.load[1] ? 'high' : 'medium', `Полная загрузка ${fmtMs(m.load)}`,
      (culprit
        ? `Главная причина — ${culprit.internal ? 'собственный ресурс' : `внешний сервис ${culprit.service}`}: запрос ${culprit.type} ждали ${fmtMs(culprit.duration)} (${culprit.status} ${culprit.statusText}), и только после этого сработало событие load. `
        : '') + 'Последними перед событием load загружались:',
      p.holders.slice(0, 6).map((r) => `${r.internal ? 'Свой' : r.service}: ${shortUrl(r.url)} — ${fmtMs(r.duration)}, закончился на ${fmtMs(r.end)}`));
  }

  // Внешние сервисы с ошибками
  const extErr = p.errors.filter((e) => !e.internal && isError(e.cls));
  if (extErr.length) {
    add('high', `Внешние сервисы отвечают ошибкой или не отвечают (${extErr.length})`,
      'Каждый такой запрос — потраченное время сети и, если он на критическом пути, задержка загрузки. Отключите сервис или исправьте интеграцию (неверный URL/ID, истёкший договор, блокировка).',
      extErr.map((e) => `${e.service}: ${e.status} ${e.statusText} — ждали ${fmtMs(e.wait)} (в ${e.runs} из ${p.okRuns} прогонов) — ${shortUrl(e.url, 80)}`));
  }
  const intErr = p.errors.filter((e) => e.internal && isError(e.cls));
  if (intErr.length) {
    add('high', `Свои ресурсы с ошибками (${intErr.length})`,
      'Битые ссылки на собственные файлы/API: лишние запросы и потенциально сломанный функционал. Удалите или исправьте.',
      intErr.map((e) => `${e.status} ${e.statusText} — ${e.type}, ${fmtMs(e.wait)} — ${shortUrl(e.url, 80)}`));
  }
  const extRedir = p.errors.filter((e) => !e.internal && e.cls === 'redirect');
  if (extRedir.length) {
    add('low', `Редиректы внешних сервисов (${extRedir.length})`,
      'Каждый редирект — дополнительный сетевой круг. Там, где URL прописан в коде сайта, замените его на конечный адрес.',
      extRedir.map((e) => `${e.service}: ${e.status} — ${fmtMs(e.wait)} — ${shortUrl(e.url, 80)}`));
  }

  // Медленные 200 на критическом пути. Время делится на ожидание ответа (сервер) и скачивание:
  // если основное время — скачивание, причина не в сервисе, а в общем канале и весе страницы
  const slowCrit = p.resources.filter((r) => r.cls === 'ok' && r.slow && r.critical);
  const slowExt = slowCrit.filter((r) => !r.internal && waitBound(r));
  if (slowExt.length) {
    add('high', `Медленные внешние сервисы на критическом пути загрузки (${slowExt.length})`,
      'Сервис долго отвечает (основное время — ожидание ответа, а не скачивание), и загрузка страницы его ждёт. Перенесите подключение на событие load или первое взаимодействие пользователя (в GTM — триггер «Окно загружено»), используйте async.',
      slowExt.sort((a, b) => b.duration - a.duration).map((r) => `${r.service}: ${fmtMs(r.duration)} = ${splitText(r)} (${PHASE_LABEL[r.phase]}) — ${shortUrl(r.url, 80)}`));
  }
  const slowInt = slowCrit.filter((r) => r.internal && r.type !== 'document' && waitBound(r));
  if (slowInt.length) {
    add('medium', `Свои запросы долго ждут ответа сервера на критическом пути (${slowInt.length})`,
      'Основное время этих запросов — ожидание ответа, а не скачивание: для API — время работы бэкенда, для файлов — раздача (кэш на сервере, CDN).',
      slowInt.sort((a, b) => b.duration - a.duration).slice(0, 10).map((r) => `${r.type}: ${fmtMs(r.duration)} = ${splitText(r)}, ${kb(r.bytes)} — ${shortUrl(r.url, 80)}`));
  }
  // Долгие из-за скачивания: файлы стоят в общей очереди канала — причина в весе и числе файлов страницы
  const slowDl = slowCrit.filter((r) => !waitBound(r));
  const tput = opts.network?.downloadThroughput;
  const dlAll = tput ? p.totals.bytes / tput * 1000 : null;
  if (slowDl.length >= 5 || (dlAll != null && dlAll > 5000)) {
    const sum = (f) => p.resources.filter(f).reduce((a, r) => a + r.bytes, 0);
    const parts = [
      ['картинки', sum((r) => r.type === 'image')], ['JavaScript', sum((r) => r.type === 'script')], ['CSS', sum((r) => r.type === 'stylesheet')],
      ['шрифты', sum((r) => r.type === 'font')], ['внешние сервисы (все типы)', sum((r) => !r.internal)],
    ].filter(([, b]) => b > 50 * 1024).map(([n, b]) => `${n}: ${kb(b)}`);
    add(dlAll > 10000 ? 'high' : 'medium',
      dlAll != null
        ? `Страница весит ${kb(p.totals.bytes)}: при условиях замера одно только скачивание ≈ ${fmtMs(dlAll)}`
        : `Много данных на странице: ${kb(p.totals.bytes)} в ${p.totals.requests} запросах — файлы ждут в общей очереди`,
      `Условия замера — ${conditionsText(opts)}. Все файлы страницы делят один канал, поэтому даже небольшие файлы долго скачиваются в очереди: у ${slowDl.length} из ${slowCrit.length} долгих ресурсов на критическом пути основное время — скачивание, а не ожидание ответа сервера. Сократите вес и число файлов первого экрана, остальное загружайте позже.`,
      [...parts, ...slowDl.sort((a, b) => b.duration - a.duration).slice(0, 6).map((r) => `${r.internal ? 'Свой' : r.service} ${r.type}: ${fmtMs(r.duration)} = ${splitText(r)}, ${kb(r.bytes)} — ${shortUrl(r.url, 70)}`)]);
  }

  // Основной поток
  if (m.tbt > THRESHOLDS.tbt[0]) {
    add(m.tbt > THRESHOLDS.tbt[1] ? 'high' : 'medium',
      `Основной поток заблокирован JavaScript: TBT ${fmtMs(m.tbt)} (норма ≤ 200 мс)`,
      'Страница видна, но не реагирует на клики — это ухудшает INP (метрика Core Web Vitals). Главные потребители процессора:',
      p.cpuTop.slice(0, 6).map((c) => `${c.internal ? 'Свой' : c.service}: ${fmtMs(c.ms)} — ${shortUrl(c.url, 80)}`));
  }
  const heavyExt = p.services.filter((s) => !s.internal && s.cpu >= 150);
  if (heavyExt.length) {
    add('medium', 'Тяжёлые внешние скрипты по нагрузке на процессор',
      'Рассмотрите отказ, отложенную загрузку или облегчённую версию интеграции.',
      heavyExt.sort((a, b) => b.cpu - a.cpu).map((s) => `${s.service}: ${fmtMs(s.cpu)} процессорного времени`));
  }
  if (m.cls > THRESHOLDS.cls[0]) {
    add(m.cls > THRESHOLDS.cls[1] ? 'high' : 'medium', `Сдвиги макета: CLS ${m.cls} (норма ≤ 0,1)`,
      'Резервируйте место под изображения (width/height, aspect-ratio), баннеры и виджеты; не вставляйте контент над уже отрисованным.');
  }

  // Своя статика: сжатие и кэш
  const staticInt = p.resources.filter((r) => r.internal && r.cls === 'ok' && ['script', 'stylesheet'].includes(r.type));
  const noGzip = staticInt.filter((r) => !r.encoding && r.bytes > 10 * 1024);
  if (noGzip.length) {
    add('medium', `Свои JS/CSS без сжатия (${noGzip.length})`, 'Включите brotli или gzip на сервере/CDN — обычно это уменьшает файлы в 3–5 раз.',
      noGzip.map((r) => `${kb(r.bytes)} — ${shortUrl(r.url, 80)}`));
  }
  const badCache = staticInt.filter((r) => {
    const ma = /max-age=(\d+)/.exec(r.cacheControl);
    return /no-store|no-cache/.test(r.cacheControl) || !ma || Number(ma[1]) < 86400;
  });
  if (badCache.length) {
    add('low', `Свои JS/CSS с коротким кэшем (${badCache.length})`,
      'Для версионированных файлов (с хешем/параметром версии в имени) ставьте Cache-Control: public, max-age=31536000, immutable — повторные заходы будут быстрее.',
      badCache.slice(0, 8).map((r) => `«${r.cacheControl || 'нет заголовка'}» — ${shortUrl(r.url, 80)}`));
  }
  if (p.totals.jsBytes > 1024 * 1024) {
    add('medium', `Много JavaScript: ${kb(p.totals.jsBytes)} (сжатого трафика)`,
      'Разделите бандлы по страницам (code splitting), уберите неиспользуемые библиотеки, загружайте тяжёлые модули по требованию.');
  }
  if (p.totals.extDomains > 15) {
    add('medium', `Много внешних доменов: ${p.totals.extDomains}`,
      'Каждый новый домен — отдельное подключение (DNS, TCP, TLS). Сверьте список с маркетингом: отключите сервисы, которые не используются, для оставшихся критичных добавьте <link rel="preconnect">.');
  }
  const order = { high: 0, medium: 1, low: 2 };
  return recs.sort((a, b) => order[a.prio] - order[b.prio]);
}

export function kb(b) {
  if (!b) return '—';
  return b >= 1024 * 1024 ? (b / 1024 / 1024).toFixed(2) + ' МБ' : Math.round(b / 1024) + ' КБ';
}
export { fmtMs, shortUrl };
// Для пересчёта выводов по сохранённым данным (lib/reanalyze.js)
export const recommendFor = (p, opts) => recommend(p, opts);

// Сквозная сводка по внешним сервисам на всех страницах
export function summarizeServices(pages, opts) {
  const map = new Map();
  for (const p of pages) {
    if (!p.services) continue;
    for (const s of p.services) {
      if (s.internal) continue;
      const g = map.get(s.service) || {
        service: s.service, category: s.category, pages: 0, requests: 0, bytes: 0, cpu: 0,
        errors: [], slowCritical: 0, blocking: 0, maxDuration: 0, redirects: 0,
      };
      g.pages++;
      g.requests += s.requests;
      g.bytes += s.bytes;
      g.cpu += s.cpu;
      g.slowCritical += s.slowCritical;
      g.blocking += s.blocking;
      g.redirects += s.redirects;
      g.maxDuration = Math.max(g.maxDuration, s.maxDuration);
      map.set(s.service, g);
    }
    for (const e of p.errors || []) {
      if (e.internal || !isError(e.cls)) continue;
      const g = map.get(e.service);
      if (g) g.errors.push({ status: e.status, wait: e.wait, page: p.page, critical: e.phases.some((x) => CRITICAL.has(x)) });
    }
  }
  return [...map.values()].map((g) => {
    g.cpuAvg = Math.round(g.cpu / g.pages);
    let verdict = 'ok', reason = 'Работает без замечаний';
    const errText = () => `${[...new Set(g.errors.map((e) => e.status))].join(', ')}; ожидание до ${fmtMs(Math.max(...g.errors.map((e) => e.wait)))}`;
    if (g.errors.some((e) => e.critical)) {
      verdict = 'disable';
      reason = `Ошибка/нет ответа на критическом пути загрузки: ${errText()}`;
    } else if (g.errors.length) {
      verdict = 'review';
      reason = `Ошибки в фоновых запросах (на скорость загрузки не влияют): ${errText()}`;
    } else if (g.blocking) {
      verdict = 'defer'; reason = 'Блокирует отрисовку страницы';
    } else if (g.slowCritical) {
      verdict = 'defer'; reason = `Ответ 200, но ≥ ${fmtMs(opts.slow)} на критическом пути (до ${fmtMs(g.maxDuration)})`;
    } else if (g.cpuAvg >= 150) {
      verdict = 'defer'; reason = `Нагружает процессор: ~${fmtMs(g.cpuAvg)} на страницу`;
    } else if (g.redirects) {
      verdict = 'review'; reason = 'Лишние редиректы';
    }
    return { ...g, verdict, reason };
  }).sort((a, b) => vRank(a.verdict) - vRank(b.verdict) || b.maxDuration - a.maxDuration);
}
const vRank = (v) => ({ disable: 0, defer: 1, review: 2, ok: 3 })[v];
