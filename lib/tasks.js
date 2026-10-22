// Рекомендации в виде задач для трекера: одинаковые проблемы на разных страницах
// и в разных разрешениях объединяются в одну задачу со списком страниц и значениями по каждой.
// runs: [{ name: 'desktop'|'mobile', pages }] — одно или оба разрешения.
// Выгрузка: tasks.html (карточки с кнопками «Копировать» — переносить в трекер вручную) и tasks.csv (таблица для Excel).

const FRONT = 'Фронтенд';
const BACK = 'Бэкенд / администраторы';
const MARKET = 'Маркетинг + фронтенд';
const SEO = 'SEO-специалист';
const CONTENT = 'Фронтенд / контент';

import { conditionsText } from './analyze.js';

// Семейства рекомендаций: по заголовку рекомендации — заголовок задачи и исполнитель.
// gain(title) — выигрыш, измеренный в этой проверке (тест без внешних сервисов);
// now(title) — сколько проблема занимает сейчас (без обещаний, сколько удастся выиграть).
const num = (re) => (t) => re.exec(t)?.[1];
const lcpPart = (re) => (t) => (num(re)(t) ? `эта часть LCP — ${num(re)(t)}` : '');
const SERVER = 'Ускорить ответ сервера на запрос страницы (ожидание первого байта HTML)';
const FAMILIES = [
  { re: /^Внешние сервисы замедляют страницу/, title: 'Ускорить загрузку внешних сервисов: отключить лишние, остальные грузить отложенно', who: MARKET, gain: (t) => (/LCP ([\d.,]+ (?:мс|с))/.exec(t) ? `LCP быстрее на ${/LCP ([\d.,]+ (?:мс|с))/.exec(t)[1]}` : num(/полная загрузка ([\d.,]+ (?:мс|с))/)(t) ? `полная загрузка быстрее на ${num(/полная загрузка ([\d.,]+ (?:мс|с))/)(t)}` : '') },
  { re: /^Внешние сервисы отвечают ошибкой/, title: 'Починить или отключить внешние сервисы, которые отвечают ошибкой', who: MARKET },
  { re: /^Медленные внешние сервисы на критическом пути/, title: 'Убрать медленные внешние сервисы с критического пути загрузки', who: MARKET },
  { re: /^Внешние ресурсы блокируют отрисовку/, title: 'Убрать внешние скрипты и стили, блокирующие отрисовку', who: MARKET },
  { re: /^Тяжёлые внешние скрипты по нагрузке/, title: 'Снизить нагрузку внешних скриптов на процессор', who: MARKET },
  { re: /^Много внешних доменов/, title: 'Сократить число внешних доменов', who: MARKET },
  { re: /^Редиректы внешних сервисов/, title: 'Убрать редиректы при загрузке внешних сервисов', who: MARKET },
  { re: /^Всплывающие окна перекрывают/, title: 'Не показывать всплывающие окна поверх ключевых элементов при загрузке', who: MARKET },
  { re: /^Событие load не наступило|^Полная загрузка/, title: 'Добиться завершения полной загрузки страницы', who: MARKET, now: (t) => (num(/^Полная загрузка ([\d.,]+ (?:мс|с))/)(t) ? `полная загрузка ${num(/^Полная загрузка ([\d.,]+ (?:мс|с))/)(t)}` : 'полная загрузка не наступает') },
  { re: /^Страница весит|^Много данных на странице/, title: 'Сократить вес и число файлов первого экрана', who: 'Фронтенд + маркетинг', now: (t) => num(/^Страница весит ([\d.,]+ (?:КБ|МБ))/)(t) ? `вес ${num(/^Страница весит ([\d.,]+ (?:КБ|МБ))/)(t)}${num(/скачивание ≈ ([\d.,]+ (?:мс|с))/)(t) ? `, одно скачивание ≈ ${num(/скачивание ≈ ([\d.,]+ (?:мс|с))/)(t)}` : ''}` : '' },

  { re: /^Медленное подключение к серверу/, title: 'Ускорить подключение к серверу (TLS, балансировщик, защита от DDoS, CDN)', who: BACK },
  { re: /^Медленный ответ сервера|^HTML не кэшируется|^Ответ сервера без признаков кэша/, title: SERVER, who: BACK, now: (t) => (num(/TTFB ([\d.,]+ (?:мс|с))/)(t) ? `TTFB ${num(/TTFB ([\d.,]+ (?:мс|с))/)(t)}` : '') },
  { re: /^Свои JS\/CSS без сжатия/, title: 'Включить сжатие (brotli/gzip) для своих JS и CSS', who: BACK },
  { re: /^Свои JS\/CSS с коротким кэшем|^Повторный визит:/, title: 'Настроить долгий кэш браузера для статических файлов', who: BACK },
  { re: /^Свои ресурсы с ошибками/, title: 'Исправить ошибки загрузки своих файлов', who: BACK },
  { re: /^Свои запросы долго ждут ответа сервера/, title: 'Ускорить ответ сервера на свои запросы на критическом пути', who: BACK },
  { re: /^Медленные собственные ресурсы/, title: 'Ускорить свои медленные ресурсы на критическом пути', who: FRONT },

  // Главная картинка от внешнего сервиса — задача для тех, кто отвечает за сервис, а не для вёрстки сайта
  { re: /главная картинка — (с|от) внешнего сервиса|^Главная картинка \(LCP\) — (с|от) внешнего сервиса/, title: 'LCP: главная картинка страницы загружается с внешнего сервиса', who: MARKET, now: (t) => num(/^LCP ([\d.,]+ (?:мс|с))/)(t) ? `LCP ${num(/^LCP ([\d.,]+ (?:мс|с))/)(t)}` : '' },
  // Ответ сервера в разборе LCP — та же причина, что «Медленный ответ сервера»: одна задача
  { re: /больше всего — «Ответ сервера/, title: SERVER, who: BACK, secondary: true, now: lcpPart(/«Ответ сервера \(TTFB\)»: ([\d.,]+ (?:мс|с))/) },
  { re: /больше всего — «Задержка до начала загрузки/, title: 'LCP: начинать загрузку главной картинки раньше', who: FRONT, now: lcpPart(/«Задержка до начала загрузки»: ([\d.,]+ (?:мс|с))/) },
  { re: /больше всего — «Загрузка ресурса LCP/, title: 'LCP: ускорить загрузку главной картинки', who: FRONT, now: lcpPart(/«Загрузка ресурса LCP»: ([\d.,]+ (?:мс|с))/) },
  { re: /больше всего — «Задержка отрисовки/, title: 'LCP: убрать задержку отрисовки главного элемента (блокирующие CSS/JS)', who: FRONT, now: lcpPart(/«Задержка отрисовки»: ([\d.,]+ (?:мс|с))/) },
  { re: /^Долгая отрисовка основного контента/, title: 'Ускорить отрисовку основного контента (LCP)', who: FRONT },
  { re: /^Даже при повторном визите/, title: 'Ускорить страницу при повторном визите (сервер / JavaScript)', who: FRONT },
  { re: /^Сдвиги (вёрстки|макета)|^Что вызывает сдвиги/, title: 'Убрать сдвиги вёрстки при загрузке (CLS)', who: FRONT },
  { re: /^Основной поток заблокирован/, title: 'Разгрузить основной поток: долгие задачи JavaScript (TBT)', who: FRONT },
  { re: /^Медленный отклик на действия/, title: 'Ускорить отклик на нажатия (INP)', who: FRONT },
  { re: /^Свои блокирующие CSS\/JS/, title: 'Убрать свои блокирующие CSS/JS из <head>', who: FRONT },
  { re: /^Много JavaScript/, title: 'Уменьшить объём JavaScript', who: FRONT },
  { re: /^Неиспользуемый JavaScript/, title: 'Убрать неиспользуемый JavaScript (разделение бандлов)', who: FRONT, now: (t) => (num(/^Неиспользуемый JavaScript: ([\d.,]+ (?:КБ|МБ))/)(t) ? `не используется ${num(/^Неиспользуемый JavaScript: ([\d.,]+ (?:КБ|МБ))/)(t)} JS` : '') },
  { re: /^Неиспользуемый CSS/, title: 'Убрать неиспользуемый CSS (критический CSS)', who: FRONT },
  { re: /^Большой DOM/, title: 'Уменьшить размер DOM', who: FRONT },
  { re: /^Шрифты без font-display/, title: 'Добавить font-display: swap шрифтам', who: FRONT },
  { re: /^Много файлов шрифтов/, title: 'Сократить число файлов шрифтов', who: FRONT },
  { re: /^Картинки: можно сэкономить/, title: 'Оптимизировать картинки (WebP/AVIF, размер под экран)', who: CONTENT, now: (t) => (num(/сэкономить ~?([\d.,]+ (?:КБ|МБ))/)(t) ? `оценка экономии ${num(/сэкономить ~?([\d.,]+ (?:КБ|МБ))/)(t)} на странице` : '') },
  { re: /^Картинки без размеров/, title: 'Указать width/height у картинок', who: FRONT },
  { re: /^loading="lazy" у картинок первого экрана/, title: 'Убрать loading="lazy" у картинок первого экрана', who: FRONT },
  { re: /картинок ниже первого экрана грузятся сразу/, title: 'Добавить loading="lazy" картинкам ниже первого экрана', who: FRONT },

  { re: /^Реальные посетители: Core Web Vitals не пройдены/, title: 'Довести Core Web Vitals реальных посетителей до нормы Google', who: FRONT },
  { re: /^В замере страница быстрее, чем у реальных/, title: 'Разобраться, почему у реальных посетителей страница медленнее, чем в замере', who: FRONT },
  { re: /^У реальных посетителей.*ухудшилось/, title: 'Найти причину ухудшения скорости у реальных посетителей', who: FRONT },
];

// Семейство рекомендации; для SEO и неизвестных — сам заголовок без чисел
function familyOf(title) {
  const f = FAMILIES.find((x) => x.re.test(title));
  if (f) return { key: f.title, ...f };
  if (title.startsWith('SEO: ')) {
    const t = title.replace(/^SEO: /, '');
    return { key: `SEO: ${t.replace(/\d+/g, '#')}`, title: `SEO: ${t}`, who: SEO };
  }
  const t = title.replace(/~?\d+(?:[.,]\d+)?(?:\s*(?:мс|с|КБ|МБ|%))?/g, '#');
  return { key: t, title, who: FRONT };
}

const PRIO = { high: 0, medium: 1, low: 2 };
export const PRIO_LABEL = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };
const DEV = { desktop: 'десктоп', mobile: 'мобильный' };
const short = (u) => u.replace(/^https?:\/\/[^/]+/, '') || '/';

export function buildTasks(runs) {
  const tasks = new Map();
  for (const r of runs) {
    for (const p of r.pages) {
      for (const rec of p.recs || []) {
        const fam = familyOf(rec.title);
        const t = tasks.get(fam.key) ?? {
          title: fam.title, who: fam.who, prio: rec.prio, detail: rec.detail, secondary: Boolean(fam.secondary), gains: [], nows: [], hits: [], items: new Set(), devices: new Set(), pages: new Set(),
        };
        // Описание — из основной рекомендации семейства (у вспомогательной, например разбора LCP, оно короче)
        const better = (t.secondary && !fam.secondary) || (t.secondary === Boolean(fam.secondary) && PRIO[rec.prio] < PRIO[t.prio]);
        if (better) {
          t.detail = rec.detail;
          t.secondary = Boolean(fam.secondary);
        }
        if (PRIO[rec.prio] < PRIO[t.prio]) t.prio = rec.prio;
        t.hits.push({ page: p.page, device: r.name, title: rec.title });
        t.devices.add(r.name);
        t.pages.add(p.page);
        for (const it of rec.items || []) t.items.add(it);
        const g = fam.gain?.(rec.title);
        if (g) t.gains.push({ g, device: r.name });
        const nw = fam.now?.(rec.title);
        if (nw) t.nows.push({ g: nw, device: r.name });
        tasks.set(fam.key, t);
      }
    }
  }
  const total = new Set(runs.flatMap((r) => r.pages.filter((p) => p.metrics).map((p) => p.page))).size;
  const conditions = Object.fromEntries(runs.map((r) => [r.name, conditionsText(r.opts ?? { profileName: r.name })]));
  // Порядок: приоритет, затем на скольких страницах проблема
  return [...tasks.values()].sort((a, b) => PRIO[a.prio] - PRIO[b.prio] || b.pages.size - a.pages.size).map((t) => ({
    ...t, total, conditions: [...t.devices].map((d) => conditions[d]).filter(Boolean),
    // Значения — по смартфону, если есть (Google ранжирует по мобильной версии)
    gain: (t.gains.find((x) => x.device === 'mobile') ?? t.gains[0])?.g ?? '',
    now: (t.nows.find((x) => x.device === 'mobile') ?? t.nows[0])?.g ?? '',
  }));
}

// Описание задачи: что не так, как исправить, где и какие значения на каждой странице
function description(t) {
  const lines = [t.detail, ''];
  if (t.conditions?.length) lines.push(`Условия замера: ${t.conditions.join('; ')}.`, '');
  lines.push(`Где (${t.pages.size} из ${t.total} стр.):`);
  for (const h of t.hits) lines.push(`• ${short(h.page)} (${DEV[h.device] ?? h.device}) — ${h.title}`);
  const items = [...t.items];
  if (items.length) {
    lines.push('', 'Подробности:');
    for (const it of items.slice(0, 12)) lines.push(`• ${it}`);
    if (items.length > 12) lines.push(`… и ещё ${items.length - 12} — см. отчёт`);
  }
  return lines.join('\n');
}

// Таблица задач для Excel: разделитель «;», UTF-8 с BOM
export function tasksCsv(tasks, { site, report }) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [
    ['Задача', 'Описание', 'Приоритет', 'Исполнитель', 'Страниц', 'Разрешения', 'Выигрыш (измерен)', 'Сейчас', 'Страницы'],
    ...tasks.map((t) => [
      t.title, `${description(t)}\n\nСайт: ${site}. Полный отчёт: ${report}`, PRIO_LABEL[t.prio], t.who, `${t.pages.size} из ${t.total}`,
      [...t.devices].map((d) => DEV[d] ?? d).join(', '), t.gain, t.now, [...t.pages].map(short).join('\n'),
    ]),
  ];
  return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\n');
}

// ── Страница задач для ручного переноса в трекер ──────────────────────────
export const escHtml = (v) => String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
export const PRIO_CHIP = { high: 'bad', medium: 'warn', low: 'info' };

export function tasksHtml(tasks, { site, report, startedAt }) {
  const date = new Date(startedAt ?? Date.now()).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const whos = [...new Set(tasks.map((t) => t.who))];
  const count = (f) => tasks.filter(f).length;
  // Текст для копирования — тот же, что в описании CSV, плюс поля задачи
  const copyText = (t) => [
    `Приоритет: ${PRIO_LABEL[t.prio]}`, `Исполнитель: ${t.who}`, ...(t.gain ? [`Выигрыш (измерен в этой проверке): ${t.gain}`] : []), ...(t.now ? [`Сейчас: ${t.now}`] : []), '',
    description(t), '', `Сайт: ${site}. Проверка от ${date}, полный отчёт: ${report}`,
  ].join('\n');
  const cards = tasks.map((t, i) => {
    const items = [...t.items];
    return `<article class="task" data-who="${escHtml(t.who)}" data-prio="${t.prio}" data-id="${escHtml(t.title)}">
<header><span class="n">${i + 1}</span><h2>${escHtml(t.title)}</h2>
<label class="done"><input type="checkbox"> перенесено</label></header>
<div class="meta"><span class="chip ${PRIO_CHIP[t.prio]}">${PRIO_LABEL[t.prio]}</span><span>Исполнитель: <b>${escHtml(t.who)}</b></span><span>Страниц: <b>${t.pages.size} из ${t.total}</b> · ${[...t.devices].map((d) => DEV[d] ?? d).join(', ')}</span>${t.gain ? `<span>Выигрыш (измерен): <b class="gain">${escHtml(t.gain)}</b></span>` : ''}${t.now ? `<span>Сейчас: <b>${escHtml(t.now)}</b></span>` : ''}</div>
<p>${escHtml(t.detail)}</p>
<details><summary>Где и с какими значениями (${t.hits.length})</summary><ul>${t.hits.map((h) => `<li><code>${escHtml(short(h.page))}</code> <small>(${DEV[h.device] ?? h.device})</small> — ${escHtml(h.title)}</li>`).join('')}</ul></details>
${items.length ? `<details><summary>Подробности (${items.length})</summary><ul>${items.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ul></details>` : ''}
<div class="btns"><button data-copy="title">Копировать заголовок</button><button data-copy="body">Копировать описание</button></div>
<textarea hidden class="c-title">${escHtml(t.title)}</textarea><textarea hidden class="c-body">${escHtml(copyText(t))}</textarea>
</article>`;
  }).join('');
  return taskPage({
    title: `Задачи: ${site}`, key: `tasks|${site}|${startedAt ?? ''}`, cards, filters: filtersHtml(tasks, whos, count),
    intro: `<h1>Задачи по скорости сайта ${escHtml(site)}</h1>
<p class="muted">Проверка от ${escHtml(date)} · задач: ${tasks.length} (высокий приоритет: ${count((t) => t.prio === 'high')}, средний: ${count((t) => t.prio === 'medium')}, низкий: ${count((t) => t.prio === 'low')}) · <a href="${escHtml(report)}">полный отчёт</a></p>
<p class="muted">Одна карточка — одна задача для трекера. Кнопки копируют заголовок и описание (с приоритетом, исполнителем, страницами и значениями) — вставьте их в новую задачу. Отметка «перенесено» запоминается в этом браузере.</p>`,
  });
}

// Фильтры: все, по приоритету, по исполнителю, не перенесённые
export const filtersHtml = (tasks, whos, count) => `<div class="filters"><button class="on" data-f="all">Все</button>${['high', 'medium', 'low'].filter((p) => count((t) => t.prio === p)).map((p) => `<button data-f="prio:${p}">${PRIO_LABEL[p]}</button>`).join('')}${whos.map((w) => `<button data-f="who:${escHtml(w)}">${escHtml(w)}</button>`).join('')}<button data-f="todo">Не перенесённые</button></div>`;

// Страница задач: общий вид, фильтры, кнопки «Копировать», отметки «перенесено» (запоминаются в браузере)
export function taskPage({ title, key, intro, filters, cards }) {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--good:#1a7f4b;--good-bg:#e3f4ea;--warn:#a15c00;--warn-bg:#fdf0d9;--bad:#b42318;--bad-bg:#fde7e4;--info:#2457a6;--info-bg:#e5edfa}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#151514;--card:#1f1f1d;--fg:#ecebe6;--muted:#a3a29b;--line:#34332f;--good:#4cc38a;--good-bg:#173526;--warn:#f0b04a;--warn-bg:#3a2c12;--bad:#ff7b6b;--bad-bg:#3d1c18;--info:#7aa7f0;--info-bg:#1a2740}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:900px;margin:0 auto;padding:24px 16px 48px}h1{font-size:24px;margin:0 0 4px}.muted,small{color:var(--muted)}
.filters{display:flex;flex-wrap:wrap;gap:6px;margin:16px 0;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:2}
.filters button,.btns button{font:inherit;font-size:13px;padding:5px 12px;border-radius:99px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
.filters button.on{background:var(--fg);color:var(--bg);border-color:var(--fg)}
.task{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px 18px;margin:0 0 12px;break-inside:avoid}
.task header{display:flex;gap:10px;align-items:flex-start}.task h2{font-size:17px;margin:0;flex:1}
.n{flex:0 0 auto;width:26px;height:26px;border-radius:50%;background:var(--fg);color:var(--bg);font-weight:700;font-size:13px;display:flex;align-items:center;justify-content:center}
.done{font-size:13px;color:var(--muted);white-space:nowrap;cursor:pointer}
.task.is-done{opacity:.5}.task.is-done h2{text-decoration:line-through}
.meta{display:flex;flex-wrap:wrap;gap:4px 16px;font-size:13px;color:var(--muted);margin:8px 0}.meta b{color:var(--fg)}.gain{color:var(--good)!important}
.chip{display:inline-block;padding:1px 9px;border-radius:99px;font-size:12px;font-weight:600}
.chip.bad{background:var(--bad-bg);color:var(--bad)}.chip.warn{background:var(--warn-bg);color:var(--warn)}.chip.info{background:var(--info-bg);color:var(--info)}
.task p{margin:6px 0}details{margin:6px 0}summary{cursor:pointer;color:var(--info);font-size:14px}
details ul,details ol{margin:6px 0;padding-left:20px;font-size:13.5px}li{overflow-wrap:anywhere}code{font-size:12.5px}
.btns{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}.btns button.ok{background:var(--good-bg);color:var(--good);border-color:var(--good)}
.hidden{display:none}
@media print{:root{--bg:#fff;--card:#fff}.filters,.btns,.done{display:none}details{display:block}details>*{display:block}main{max-width:none;padding:0}}
</style></head><body><main>
${intro}
${filters}
${cards || '<p>Рекомендаций нет — задач тоже.</p>'}
</main>
<script>
(() => {
  const key = ${JSON.stringify(key)};
  let done = {};
  try { done = JSON.parse(localStorage.getItem(key) || '{}'); } catch (e) {}
  const save = () => { try { localStorage.setItem(key, JSON.stringify(done)); } catch (e) {} };
  const cards = [...document.querySelectorAll('.task')];
  let filter = 'all';
  const apply = () => cards.forEach((c) => {
    const [k, v] = filter.split(':');
    const show = filter === 'all' || (k === 'prio' && c.dataset.prio === v) || (k === 'who' && c.dataset.who === filter.slice(4)) || (filter === 'todo' && !done[c.dataset.id]);
    c.classList.toggle('hidden', !show);
  });
  for (const c of cards) {
    const cb = c.querySelector('.done input');
    cb.checked = !!done[c.dataset.id];
    c.classList.toggle('is-done', cb.checked);
    cb.addEventListener('change', () => { done[c.dataset.id] = cb.checked || undefined; c.classList.toggle('is-done', cb.checked); save(); apply(); });
    for (const b of c.querySelectorAll('[data-copy]')) b.addEventListener('click', async () => {
      const text = c.querySelector(b.dataset.copy === 'title' ? '.c-title' : '.c-body').value;
      try { await navigator.clipboard.writeText(text); } catch (e) {
        const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); document.execCommand('copy'); t.remove();
      }
      const was = b.textContent; b.textContent = 'Скопировано ✓'; b.classList.add('ok');
      setTimeout(() => { b.textContent = was; b.classList.remove('ok'); }, 1500);
    });
  }
  for (const b of document.querySelectorAll('.filters button')) b.addEventListener('click', () => {
    filter = b.dataset.f;
    document.querySelectorAll('.filters button').forEach((x) => x.classList.toggle('on', x === b));
    apply();
  });
})();
</script></body></html>`;
}
