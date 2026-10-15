// Данные реальных посетителей из Chrome UX Report (CrUX API): p75 Core Web Vitals за 28 дней
// по странице (если у неё хватает трафика) и по всему сайту, плюс динамика по неделям (History API).
// Нужен бесплатный ключ Google API: файл crux-key.txt в папке агента или переменная CRUX_API_KEY.
import { readFileSync } from 'node:fs';

const API = 'https://chromeuxreport.googleapis.com/v1/records';
const FORM = { desktop: 'DESKTOP', mobile: 'PHONE' };
// Имена метрик CrUX → ключи отчёта. TTFB в CrUX до сих пор «experimental_», на случай переименования берём оба.
const METRICS = {
  lcp: ['largest_contentful_paint'],
  inp: ['interaction_to_next_paint'],
  cls: ['cumulative_layout_shift'],
  fcp: ['first_contentful_paint'],
  ttfb: ['time_to_first_byte', 'experimental_time_to_first_byte'],
};
const LCP_PARTS = {
  ttfb: 'largest_contentful_paint_image_time_to_first_byte',
  loadDelay: 'largest_contentful_paint_image_resource_load_delay',
  loadTime: 'largest_contentful_paint_image_resource_load_duration',
  renderDelay: 'largest_contentful_paint_image_element_render_delay',
};
// Пороги Google для полевых данных (good / poor), оцениваются по p75
export const FIELD_THRESHOLDS = { lcp: [2500, 4000], inp: [200, 500], cls: [0.1, 0.25], fcp: [1800, 3000], ttfb: [800, 1800] };
export const fieldGrade = (k, v) => (v == null ? 'na' : v <= FIELD_THRESHOLDS[k][0] ? 'good' : v <= FIELD_THRESHOLDS[k][1] ? 'ni' : 'poor');

export function loadCruxKey(projectDir) {
  if (process.env.CRUX_API_KEY) return process.env.CRUX_API_KEY.trim();
  try {
    const line = readFileSync(`${projectDir}/crux-key.txt`, 'utf8').split(/\r?\n/).map((s) => s.trim()).find((s) => s && !s.startsWith('#'));
    return line || null;
  } catch {
    return null;
  }
}

const num = (v) => (v == null || v === 'NaN' ? null : Number(v));
const date = (d) => (d ? `${d.year}-${String(d.month).padStart(2, '0')}-${String(d.day).padStart(2, '0')}` : null);
const metricOf = (metrics, names) => names.map((n) => metrics?.[n]).find(Boolean);

// Ответ queryRecord → { p75, dist: [хорошо, средне, плохо] } по каждой метрике
function parseRecord(rec) {
  const out = { metrics: {}, lcpParts: {}, period: { from: date(rec.collectionPeriod?.firstDate), to: date(rec.collectionPeriod?.lastDate) } };
  for (const [k, names] of Object.entries(METRICS)) {
    const m = metricOf(rec.metrics, names);
    if (!m) continue;
    const p75 = num(m.percentiles?.p75);
    const dist = (m.histogram || []).slice(0, 3).map((b) => num(b.density) ?? 0);
    out.metrics[k] = { p75: k === 'cls' ? p75 : p75 == null ? null : Math.round(p75), dist };
  }
  for (const [k, name] of Object.entries(LCP_PARTS)) {
    const v = num(rec.metrics?.[name]?.percentiles?.p75);
    if (v != null) out.lcpParts[k] = Math.round(v);
  }
  return out;
}

// Ответ queryHistoryRecord → недельные p75 по LCP, INP, CLS
function parseHistory(rec) {
  const periods = (rec.collectionPeriods || []).map((p) => date(p.lastDate));
  const series = {};
  for (const k of ['lcp', 'inp', 'cls']) {
    const m = metricOf(rec.metrics, METRICS[k]);
    const p75s = m?.percentilesTimeseries?.p75s;
    if (p75s) series[k] = p75s.map(num);
  }
  return { periods, series };
}

export class Crux {
  constructor(key) {
    this.key = key;
    this.cache = new Map(); // запросы по сайту целиком повторяются для каждой страницы
    this.fatal = null; // неверный ключ или API не включён — дальше не спрашиваем
  }

  async post(method, body) {
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await fetch(`${API}:${method}?key=${encodeURIComponent(this.key)}`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
        });
      } catch (e) {
        if (attempt === 2) return { error: `нет связи с CrUX API (${e.cause?.code || e.name})` };
        continue;
      }
      if (res.ok) return { data: await res.json() };
      // 404 — у страницы или сайта недостаточно визитов из Chrome за 28 дней
      if (res.status === 404) return { none: true };
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      let msg = '';
      try { msg = (await res.json()).error?.message || ''; } catch {}
      if (res.status === 400 && /api key/i.test(msg)) this.fatal = 'ключ CrUX API не подошёл — проверьте файл crux-key.txt';
      else if (res.status === 403) this.fatal = 'Chrome UX Report API не включён для проекта Google Cloud этого ключа (или ключ ограничен другими API)';
      return { error: this.fatal || `CrUX API: ошибка ${res.status} ${msg}` };
    }
    return { error: 'CrUX API не отвечает (превышен лимит запросов или сбой сервиса)' };
  }

  cached(key, fn) {
    if (!this.cache.has(key)) this.cache.set(key, fn());
    return this.cache.get(key);
  }

  // Полевые данные для страницы в разрешении профиля (desktop | mobile)
  async query(url, profileName) {
    if (this.fatal) return { error: this.fatal };
    const formFactor = FORM[profileName];
    const origin = new URL(url).origin;
    const [page, site] = await Promise.all([
      this.post('queryRecord', { url, formFactor }),
      this.cached(`o|${origin}|${formFactor}`, () => this.post('queryRecord', { origin, formFactor })),
    ]);
    const err = [page, site].find((r) => r.error)?.error;
    if (err && !page.data && !site.data) return { error: err };
    // Динамика — по тому уровню, который показываем главным: страница, а если у неё нет данных — сайт
    const level = page.data ? 'url' : site.data ? 'origin' : null;
    let history = null;
    if (level) {
      const body = level === 'url' ? { url, formFactor, collectionPeriodCount: 25 } : { origin, formFactor, collectionPeriodCount: 25 };
      const h = level === 'url' ? await this.post('queryHistoryRecord', body)
        : await this.cached(`h|${origin}|${formFactor}`, () => this.post('queryHistoryRecord', body));
      if (h.data?.record) history = parseHistory(h.data.record);
    }
    return {
      formFactor, level,
      page: page.data?.record ? parseRecord(page.data.record) : null,
      origin: site.data?.record ? parseRecord(site.data.record) : null,
      originUrl: origin,
      history,
    };
  }
}

// Изменение за период истории: сравниваем среднее первых и последних 4 недель, чтобы не реагировать на шум
function trendOf(series, k) {
  const vals = (series || []).filter((v) => v != null);
  if (vals.length < 8) return null;
  const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const from = avg(vals.slice(0, 4));
  const to = avg(vals.slice(-4));
  const d = to - from;
  const sig = k === 'cls' ? Math.abs(d) >= 0.02 : Math.abs(d) >= Math.max(k === 'inp' ? 25 : 150, from * 0.1);
  return { from: k === 'cls' ? +from.toFixed(2) : Math.round(from), to: k === 'cls' ? +to.toFixed(2) : Math.round(to), d, sig, better: d < 0 };
}

// Сводка для отчёта: основной уровень данных, оценка Core Web Vitals, сравнение с лабораторным замером, динамика
export function fieldSummary(p, raw) {
  if (!raw) return null;
  if (raw.error) return { error: raw.error };
  const main = raw.page || raw.origin;
  if (!main) return { level: null, formFactor: raw.formFactor, originUrl: raw.originUrl };
  const m = main.metrics;
  // Core Web Vitals пройдены, если p75 LCP, INP и CLS в зелёной зоне (метрика без данных не учитывается)
  const cwv = ['lcp', 'inp', 'cls'].filter((k) => m[k]?.p75 != null);
  const cwvPass = cwv.length ? cwv.every((k) => fieldGrade(k, m[k].p75) === 'good') : null;
  const lab = { lcp: p.metrics?.lcp, cls: p.metrics?.cls, fcp: p.metrics?.fcp, ttfb: p.metrics?.ttfb, inp: p.extras?.interactions && !p.extras.interactions.error ? p.extras.interactions.inp : undefined };
  // Лаборатория заметно оптимистичнее реальности — значит, у посетителей устройства/сеть хуже профиля замера
  // или их путь по сайту отличается (реклама, персонализация, cookies, переходы из поиска)
  const gaps = [];
  for (const k of ['lcp', 'fcp', 'ttfb']) {
    const f = m[k]?.p75;
    const l = lab[k];
    if (f == null || l == null) continue;
    // Расхождение: разные зоны оценки или разница в 2+ раза (и больше секунды) при одинаковой зоне
    const rank = { good: 0, ni: 1, poor: 2 };
    const far = (a, b) => a >= b * 2 && a - b >= 1000;
    if (rank[fieldGrade(k, f)] > rank[fieldGrade(k, l)] || far(f, l)) gaps.push({ k, lab: l, field: f, kind: 'labBetter' });
    else if (rank[fieldGrade(k, l)] > rank[fieldGrade(k, f)] || far(l, f)) gaps.push({ k, lab: l, field: f, kind: 'fieldBetter' });
  }
  const trend = {};
  for (const k of ['lcp', 'inp', 'cls']) {
    const t = trendOf(raw.history?.series?.[k], k);
    if (t) trend[k] = t;
  }
  return {
    level: raw.page ? 'url' : 'origin', formFactor: raw.formFactor, originUrl: raw.originUrl,
    page: raw.page, origin: raw.origin, metrics: m, lcpParts: main.lcpParts, period: main.period,
    cwvPass, lab, gaps, history: raw.history, trend,
  };
}
