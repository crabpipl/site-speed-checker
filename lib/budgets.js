// Бюджеты скорости — файл budgets.txt (необязательный): пороги метрик, веса и числа запросов.
// Общие строки действуют для всех сайтов, секция [сайт] переопределяет их; «(десктоп)» / «(мобильный)» после
// названия показателя — порог только для одного разрешения. Результат: что вышло за бюджет, впервые или повторно.
import { readFileSync } from 'node:fs';
import { isError, fmtMs, kb } from './analyze.js';

// Показатели: как называются в файле, как подписываются в отчёте, единицы и откуда берётся значение страницы
const KIND = { time: 'time', size: 'size', count: 'count', cls: 'cls' };
export const BUDGET_KEYS = {
  ttfb: { names: ['ttfb', 'ответ сервера'], label: 'TTFB — ответ сервера', kind: KIND.time, get: (p) => p.metrics.ttfb },
  fcp: { names: ['fcp', 'первая отрисовка'], label: 'FCP — первая отрисовка', kind: KIND.time, get: (p) => p.metrics.fcp },
  lcp: { names: ['lcp', 'главный контент'], label: 'LCP — главный контент', kind: KIND.time, get: (p) => p.metrics.lcp },
  tbt: { names: ['tbt', 'блокировка js'], label: 'TBT — блокировка JS', kind: KIND.time, get: (p) => p.metrics.tbt },
  cls: { names: ['cls', 'сдвиги вёрстки', 'сдвиги верстки'], label: 'CLS — сдвиги вёрстки', kind: KIND.cls, get: (p) => p.metrics.cls },
  // null — событие load не наступило: это всегда выход за бюджет
  load: { names: ['load', 'полная загрузка'], label: 'Полная загрузка', kind: KIND.time, get: (p) => p.metrics.load ?? Infinity },
  inp: {
    names: ['inp', 'отклик'], label: 'Отклик на нажатия (INP, замер)', kind: KIND.time,
    get: (p) => (p.extras?.interactions && !p.extras.interactions.error ? (p.extras.interactions.inp ?? 0) : undefined),
  },
  bytes: { names: ['вес страницы'], label: 'Вес страницы', kind: KIND.size, get: (p) => p.totals.bytes },
  jsBytes: { names: ['вес js', 'вес javascript'], label: 'Вес JavaScript', kind: KIND.size, get: (p) => p.totals.jsBytes },
  imgBytes: { names: ['вес картинок'], label: 'Вес картинок', kind: KIND.size, get: (p) => (p.resources || []).filter((r) => r.type === 'image').reduce((a, r) => a + r.bytes, 0) },
  requests: { names: ['запросов'], label: 'Запросов', kind: KIND.count, get: (p) => p.totals.requests },
  extServices: { names: ['внешних сервисов'], label: 'Внешних сервисов', kind: KIND.count, get: (p) => p.totals.extServices },
  // Только устойчивые ошибки (повторились минимум в 2 прогонах): единичные сбои рекламных пикселей — шум
  errors: { names: ['ошибок'], label: 'Ошибок загрузки ресурсов', kind: KIND.count, get: (p) => (p.errors || []).filter((e) => isError(e.cls) && (e.runs >= 2 || p.okRuns === 1)).length },
  dom: { names: ['dom', 'элементов dom'], label: 'Элементов DOM', kind: KIND.count, get: (p) => p.extras?.dom?.nodes },
  fieldLcp: { names: ['lcp посетителей'], label: 'LCP у реальных посетителей', kind: KIND.time, get: (p) => p.extras?.field?.metrics?.lcp?.p75 },
  fieldInp: { names: ['inp посетителей'], label: 'INP у реальных посетителей', kind: KIND.time, get: (p) => p.extras?.field?.metrics?.inp?.p75 },
  fieldCls: { names: ['cls посетителей'], label: 'CLS у реальных посетителей', kind: KIND.cls, get: (p) => p.extras?.field?.metrics?.cls?.p75 },
};
const BY_NAME = new Map(Object.entries(BUDGET_KEYS).flatMap(([k, d]) => d.names.map((n) => [n.replace(/ё/g, 'е'), k])));
const PROFILE = { 'десктоп': 'desktop', 'компьютер': 'desktop', 'мобильный': 'mobile', 'смартфон': 'mobile' };

// «2,5 с», «2500 мс», «3 МБ», «500 КБ», «0.1», «15» → число в мс / байтах / штуках
function parseValue(kind, raw) {
  const m = /^(\d+(?:[.,]\d+)?)\s*([a-zа-яё]*)\.?$/i.exec(raw.trim());
  if (!m) return null;
  const n = Number(m[1].replace(',', '.'));
  const u = m[2].toLowerCase();
  if (kind === KIND.time) {
    if (!u || u === 'мс' || u === 'ms') return n;
    if (['с', 'сек', 's', 'sec', 'c'].includes(u)) return n * 1000; // латинская «c» — частая опечатка
    return null;
  }
  if (kind === KIND.size) {
    if (['мб', 'mb'].includes(u)) return n * 1024 * 1024;
    if (!u || ['кб', 'kb'].includes(u)) return n * 1024;
    return null;
  }
  return u ? null : n;
}

export function loadBudgets(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return { rules: [], warnings: [], missing: true }; }
  const rules = [];
  const warnings = [];
  let site = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      const name = sec[1].trim().toLowerCase();
      site = ['все', 'все сайты', '*'].includes(name) ? null : name.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      return;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    const where = `budgets.txt, строка ${i + 1}: «${line}»`;
    if (!kv) return warnings.push(`${where} — нужен формат «показатель = значение», например «LCP = 2,5 с»`);
    let name = kv[1].trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ');
    let profile = null;
    const q = /\(([^)]+)\)\s*$/.exec(name);
    if (q) {
      profile = PROFILE[q[1].trim()];
      if (!profile) return warnings.push(`${where} — в скобках можно указать «десктоп» или «мобильный»`);
      name = name.slice(0, q.index).trim();
    }
    const key = BY_NAME.get(name);
    if (!key) return warnings.push(`${where} — неизвестный показатель «${kv[1].trim()}»`);
    const value = parseValue(BUDGET_KEYS[key].kind, kv[2]);
    if (value == null) return warnings.push(`${where} — не понял значение «${kv[2].trim()}» (пример: 2,5 с; 300 мс; 3 МБ; 500 КБ; 0,1; 20)`);
    rules.push({ site, profile, key, value });
  });
  return { rules, warnings };
}

// Пороги для сайта и разрешения: сайт + разрешение > сайт > общий + разрешение > общий
export function budgetsFor(cfg, site, profileName) {
  const rank = (r) => (r.site ? 2 : 0) + (r.profile ? 1 : 0);
  const out = {};
  const best = {};
  for (const r of cfg.rules) {
    if (r.site && r.site !== site) continue;
    if (r.profile && r.profile !== profileName) continue;
    if (best[r.key] == null || rank(r) >= best[r.key]) {
      best[r.key] = rank(r);
      out[r.key] = r.value;
    }
  }
  return out;
}

export const fmtBudget = (key, v) => {
  const kind = BUDGET_KEYS[key].kind;
  if (v == null || v === Infinity) return 'не наступила';
  if (kind === KIND.time) return fmtMs(v);
  if (kind === KIND.size) return kb(v);
  if (kind === KIND.cls) return String(Math.round(v * 1000) / 1000);
  return String(v);
};

// Проверка страницы: какие показатели вышли за бюджет. prevBudget — результат той же страницы в прошлой проверке.
export function checkBudget(p, limits, prevBudget) {
  if (!Object.keys(limits).length) return null;
  if (!p.metrics) return { failed: true, over: [], checked: 0, fixed: [] };
  const over = [];
  let checked = 0;
  for (const [key, limit] of Object.entries(limits)) {
    const v = BUDGET_KEYS[key].get(p);
    if (v == null) continue; // показатель не замерялся (нет теста отклика, нет данных CrUX и т. п.)
    checked++;
    if (v > limit) over.push({ key, value: v === Infinity ? null : v, limit, ratio: v === Infinity ? null : v / limit });
  }
  const prevOver = prevBudget ? new Set((prevBudget.over || []).map((o) => o.key)) : null;
  for (const o of over) o.status = !prevOver ? 'unknown' : prevOver.has(o.key) ? 'repeat' : 'new';
  const nowOver = new Set(over.map((o) => o.key));
  const fixed = prevOver ? [...prevOver].filter((k) => !nowOver.has(k) && limits[k] != null) : [];
  return { over, checked, fixed };
}

// Сводка для итогового сообщения в Терминале. entries: [{ profile, page, budget }]
export function budgetDigest(entries) {
  const withBudget = entries.filter((e) => e.budget);
  if (!withBudget.length) return null;
  const bad = withBudget.filter((e) => e.budget.failed || e.budget.over.length);
  const fresh = bad.reduce((a, e) => a + e.budget.over.filter((o) => o.status === 'new').length, 0);
  const fixed = withBudget.reduce((a, e) => a + (e.budget.fixed?.length || 0), 0);
  // Коротко: по странице — сколько показателей вне бюджета и какие из них впервые (с цифрами)
  const short = (k) => BUDGET_KEYS[k].label.split(' — ')[0];
  const lines = bad.map((e) => {
    const page = `${e.profile ? `${e.profile}: ` : ''}${e.page.replace(/^https?:\/\//, '')}`;
    if (e.budget.failed) return `${page} — страница не открылась`;
    const nw = e.budget.over.filter((o) => o.status === 'new');
    const old = e.budget.over.filter((o) => o.status !== 'new');
    return `${page} — вне бюджета ${e.budget.over.length}` +
      (nw.length ? `; впервые: ${nw.map((o) => `${short(o.key)} ${fmtBudget(o.key, o.value)} > ${fmtBudget(o.key, o.limit)}`).join(', ')}` : '') +
      (old.length ? `${nw.length ? '; и ещё ' : ': '}${old.map((o) => short(o.key)).join(', ')}` : '');
  });
  return { total: withBudget.length, bad: bad.length, fresh, fixed, lines };
}
