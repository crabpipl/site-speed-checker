// Задачи для разработки по тесту оформления заказа: что исправить, где (шаги и запросы с цифрами),
// что сделать по пунктам и когда задача считается готовой. Одна задача — один запрос сервера,
// один внешний сервис или одна группа однотипных проблем фронтенда.
// Выгрузка: tasks.html (карточки с кнопками «Копировать») и tasks.csv (таблица для Excel) рядом с checkout_report.html.
import { fmt } from './checkout.js';
import { readyOf, LOGIN_STEPS } from './report-checkout.js';
import { taskPage, filtersHtml, escHtml, PRIO_CHIP, PRIO_LABEL } from './tasks.js';

const BACK = 'Бэкенд';
const FRONT = 'Фронтенд';
const MARKET = 'Маркетинг + фронтенд';
const PRIO = { high: 0, medium: 1, low: 2 };
const isErr = (r) => r.status === 'FAILED' || (typeof r.status === 'number' && r.status >= 400);
const API_TYPES = /^(xhr|fetch|document|other)$/;
// 1 файл, 2 файла, 5 файлов
const plural = (n, one, few, many) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 10 || n % 100 >= 20) ? few : many}`;

// Адрес запроса без параметров; номера и длинные коды заменяются на {id}, чтобы одинаковые запросы объединялись
export function endpointOf(r) {
  let path = r.url;
  try { const u = new URL(r.url); path = u.pathname; } catch {}
  path = path.split('/').map((p) => (/^\d{3,}$|^[0-9a-f-]{16,}$/i.test(p) ? '{id}' : p)).join('/');
  return `${r.method || 'GET'} ${path}`;
}
const fileOf = (r) => { try { return new URL(r.url).pathname.split('/').pop() || r.url; } catch { return r.url; } };

export function checkoutTasks(d) {
  const steps = d.steps.filter((s) => !LOGIN_STEPS.test(s.name) && !s.error);
  const all = d.steps.filter((s) => !LOGIN_STEPS.test(s.name));
  const site = d.site;
  const verify = `npm run audit:checkout -- --site=${site.includes(' ') ? `"${site}"` : site} --no-order`;
  const tasks = [];
  const add = (t) => tasks.push({ todo: [], where: [], ...t });

  // ── Бэкенд: медленные запросы к своему серверу — задача на каждый адрес ──
  const slowApi = new Map();
  for (const s of steps) for (const r of s.requests) {
    if (!r.internal || r.pending || r.dur < 1000 || !API_TYPES.test(r.type)) continue;
    const key = endpointOf(r);
    const g = slowApi.get(key) ?? { key, max: 0, stepMax: 0, hits: [] };
    g.max = Math.max(g.max, r.dur);
    g.stepMax = Math.max(g.stepMax, readyOf(s));
    g.hits.push(`«${s.name}»: ${fmt(r.dur)}${r.status && r.status !== 200 ? ` (статус ${r.status})` : ''}`);
    slowApi.set(key, g);
  }
  const apis = [...slowApi.values()].sort((a, b) => b.max - a.max);
  for (const g of apis.slice(0, 8)) {
    add({
      title: `Ускорить ответ сервера: ${g.key} — до ${fmt(g.max)}`,
      // Высокий — если запрос сам дольше 3 с или стоит на шаге, где покупатель ждёт 5 с и больше
      who: BACK, prio: g.max >= 3000 || g.stepMax >= 5000 ? 'high' : g.max >= 1500 ? 'medium' : 'low',
      detail: `Запрос к своему серверу на шагах оформления отвечает дольше секунды — всё это время покупатель ждёт.${g.stepMax >= 5000 ? ` Он есть на шаге, где контент готов только через ${fmt(g.stepMax)}.` : ''}`,
      where: g.hits,
      todo: [
        'Снять профиль этого запроса (APM, логи с временем по этапам): где уходит время — база данных, внешние API, блокировки, сериализация.',
        'Проверить запросы к базе: индексы, N+1, лишние выборки; убрать вызовы, которые не нужны для ответа.',
        'Закэшировать данные, которые меняются редко (каталог, наличие, акции, справочники), или вынести тяжёлую часть в фон.',
        'Добавить в ответ заголовок Server-Timing (db, cache, api) — время по этапам будет видно в DevTools браузера и в мониторинге.',
      ],
      done: `ответ ≤ 500 мс на всех шагах в повторном тесте (${verify})`,
    });
  }
  if (apis.length > 8) {
    add({
      title: `Ускорить остальные медленные запросы к серверу (${apis.length - 8})`,
      who: BACK, prio: 'low', detail: 'Ещё несколько запросов к своему серверу дольше секунды — ниже список.',
      where: apis.slice(8).map((g) => `${g.key} — до ${fmt(g.max)} (${g.hits.length} раз)`),
      todo: ['Разобрать по одному, как задачи выше.'], done: `все запросы ≤ 1 с в повторном тесте (${verify})`,
    });
  }

  // ── Бэкенд: ошибки своих запросов ──
  const errs = new Map();
  for (const s of all) for (const r of s.requests) {
    if (!r.internal || !isErr(r)) continue;
    const key = `${endpointOf(r)} → ${r.status}${r.error ? ` ${r.error}` : ''}`;
    const g = errs.get(key) ?? { key, steps: new Set() };
    g.steps.add(s.name);
    errs.set(key, g);
  }
  for (const g of [...errs.values()].slice(0, 6)) {
    add({
      title: `Исправить ошибку запроса: ${g.key}`,
      who: BACK, prio: 'high', detail: 'Ошибка запроса к своему серверу на шагах оформления — частая причина брошенных корзин: часть покупателей видит сбой или пустой блок.',
      where: [...g.steps].map((n) => `шаг «${n}»`),
      todo: ['Найти запрос в логах сервера по времени теста и воспроизвести.', 'Исправить причину (или не отправлять запрос, если он не нужен на этом шаге).', 'Если ошибка ожидаемая (нет данных) — отвечать 200/204 с пустым результатом.'],
      done: `в повторном тесте этот запрос без ошибки (${verify})`,
    });
  }

  // ── Бэкенд: создание заказа ──
  const ord = all.find((s) => s.name.startsWith('Оформление заказа'));
  if (ord && !ord.error && readyOf(ord) >= 2000) {
    add({
      title: `Ускорить создание заказа — ${fmt(readyOf(ord))} после нажатия «${ord.action}»`,
      who: BACK, prio: readyOf(ord) >= 4000 ? 'high' : 'medium',
      detail: 'Последний шаг перед деньгами: долгое ожидание здесь — самое дорогое.',
      where: ord.requests.filter((r) => r.internal && !r.pending).sort((a, b) => b.dur - a.dur).slice(0, 6).map((r) => `${endpointOf(r)} — ${fmt(r.dur)}`),
      todo: ['Перечислить, что выполняется синхронно при создании заказа: резерв на складе, расчёт доставки, CRM, письма и SMS, бонусы.', 'Всё, что не нужно для ответа покупателю, перенести в очередь (фон).', 'Проверить блокировки базы при одновременных заказах.'],
      done: `создание заказа ≤ 2 с в тесте с заказом`,
    });
  }

  // ── Фронтенд: свои скрипты, стили, картинки грузятся долго ──
  const slowStatic = new Map();
  for (const s of steps) for (const r of s.requests) {
    if (!r.internal || r.pending || r.dur < 1500 || API_TYPES.test(r.type)) continue;
    const f = fileOf(r);
    const g = slowStatic.get(f) ?? { f, type: r.type, max: 0, steps: new Set() };
    g.max = Math.max(g.max, r.dur); g.steps.add(s.name);
    slowStatic.set(f, g);
  }
  const statics = [...slowStatic.values()].sort((a, b) => b.max - a.max);
  if (statics.length) {
    add({
      title: `Ускорить загрузку своих файлов (скрипты, стили, картинки): ${plural(statics.length, 'файл', 'файла', 'файлов')} дольше 1,5 с`,
      who: FRONT, prio: statics[0].max >= 3000 ? 'high' : 'medium',
      detail: 'Свои файлы на шагах оформления грузятся долго — страница ждёт их, прежде чем стать готовой.',
      where: statics.slice(0, 10).map((g) => `${g.f} (${g.type}) — до ${fmt(g.max)}, шаги: ${[...g.steps].map((n) => `«${n}»`).join(', ')}`),
      todo: ['Проверить размер файлов: разделить большие бандлы (vendors) по страницам, убрать неиспользуемый код.', 'Проверить сжатие (brotli/gzip) и долгий кэш браузера (Cache-Control, имена файлов с хэшем).', 'Отдавать статику с CDN рядом с покупателями; критичные файлы — с preload.', 'Скрипты, не нужные для первого экрана, грузить с defer/async.'],
      done: `каждый файл ≤ 1 с в повторном тесте (${verify})`,
    });
  }

  // ── Фронтенд: шаг долго готов, хотя сервер отвечает быстро ──
  const render = steps.filter((s) => readyOf(s) >= 3000 && !s.name.startsWith('Оформление заказа') && !s.requests.some((r) => r.internal && !r.pending && r.dur >= 1000 && API_TYPES.test(r.type)));
  if (render.length) {
    add({
      title: `Ускорить загрузку и отрисовку шагов без медленного сервера (${render.length})`,
      who: FRONT, prio: render.some((s) => readyOf(s) >= 5000) ? 'high' : 'medium',
      detail: 'На этих шагах сервер отвечает быстро, а страница всё равно готова не сразу — время уходит на загрузку и выполнение скриптов, картинки и внешние сервисы.',
      where: render.map((s) => `«${s.name}»: контент готов через ${fmt(readyOf(s))}`),
      todo: ['Записать шаг в DevTools → Performance (замедление CPU ×4, сеть 4G) и найти, что держит отрисовку.', 'Убрать блокирующие скрипты и стили из <head>, отложить некритичные.', 'Показывать каркас страницы сразу, данные — по мере загрузки.'],
      done: `каждый шаг ≤ 3 с в повторном тесте (${verify})`,
    });
  }

  // ── Фронтенд: долгие задачи JavaScript ──
  const js = steps.filter((s) => s.longTasks >= 300).sort((a, b) => b.longTasks - a.longTasks);
  if (js.length) {
    add({
      title: `Разгрузить процессор: долгие задачи JavaScript на ${plural(js.length, 'шаге', 'шагах', 'шагах')}`,
      who: FRONT, prio: js[0].longTasks >= 1000 ? 'high' : 'medium',
      detail: 'Пока выполняются долгие задачи JS, страница не реагирует на нажатия и прокрутку — на смартфоне это заметно сильнее.',
      where: js.map((s) => `«${s.name}»: ${fmt(s.longTasks)}${s.longCount ? ` (задач: ${s.longCount})` : ''}`),
      todo: ['Записать шаг в DevTools → Performance (CPU ×4), найти функции в долгих задачах (> 50 мс).', 'Разбить тяжёлую работу на части (scheduler.yield / setTimeout), не делать её при загрузке.', 'Убрать неиспользуемый и дублирующийся JS, отложить сторонние виджеты.'],
      done: `суммарно долгих задач < 200 мс на каждом шаге в повторном тесте (${verify})`,
    });
  }

  // ── Фронтенд: кнопки откликаются с задержкой ──
  const clicks = steps.filter((s) => s.click != null && s.click > 200);
  if (clicks.length) {
    add({
      title: `Ускорить отклик кнопок (${clicks.length}) — норма до 200 мс`,
      who: FRONT, prio: clicks.some((s) => s.click > 500) ? 'high' : 'medium',
      detail: 'После нажатия экран долго не меняется — покупатель думает, что кнопка не сработала, и нажимает ещё раз.',
      where: clicks.map((s) => `«${s.action}» на шаге «${s.name}»: ${fmt(s.click)}`),
      todo: ['Сразу после нажатия показывать реакцию: индикатор, блокировка кнопки.', 'Тяжёлую работу (запросы, перерисовку) выполнять после показа реакции.'],
      done: `отклик ≤ 200 мс в повторном тесте (${verify})`,
    });
  }

  // ── Маркетинг + фронтенд: внешние сервисы на оформлении — задача на сервис ──
  const ext = new Map();
  for (const s of steps) {
    const ready = readyOf(s);
    for (const r of s.requests) {
      if (r.internal) continue;
      const g = ext.get(r.service) ?? { name: r.service, n: 0, max: 0, err: 0, late: 0, steps: new Set() };
      // Запрос без ответа к концу шага (обычно отправка статистики) — не длительность и не ошибка
      g.n++;
      if (!r.pending) { g.max = Math.max(g.max, r.dur); if (isErr(r)) g.err++; if (r.start + r.dur > ready + 500) g.late++; }
      g.steps.add(s.name);
      ext.set(r.service, g);
    }
  }
  const bad = [...ext.values()].filter((g) => g.max >= 1000 || g.err).sort((a, b) => b.err - a.err || b.max - a.max);
  for (const g of bad.slice(0, 6)) {
    add({
      title: `Внешний сервис «${g.name}» на оформлении: до ${fmt(g.max)}${g.err ? `, ошибок ${g.err}` : ''}`,
      who: MARKET, prio: g.err >= 5 || g.max >= 3000 ? 'medium' : 'low',
      detail: 'Сторонний сервис замедляет страницы оформления или отвечает ошибкой. На этих шагах нужно только то, что нужно для заказа (оплата, адреса, антифрод).',
      where: [`запросов: ${g.n}, шаги: ${[...g.steps].map((n) => `«${n}»`).join(', ')}`],
      todo: ['Решить, нужен ли сервис на страницах корзины и оформления; если нет — не подключать его там.', 'Если нужен — грузить после готовности страницы (async/defer, после load) и с тайм-аутом, чтобы зависание не держало загрузку.', g.err ? 'Разобраться с ошибками: неверный ключ/адрес, блокировка, сервис отключён.' : 'Проверить, не загружается ли сервис несколько раз.'],
      done: `в повторном тесте сервис не задерживает шаги и без ошибок (${verify})`,
    });
  }
  if (bad.length > 6) {
    add({
      title: `Остальные медленные внешние сервисы на оформлении (${bad.length - 6})`, who: MARKET, prio: 'low',
      detail: 'Ещё несколько сторонних сервисов отвечают дольше секунды или с ошибками.',
      where: bad.slice(6).map((g) => `${g.name}: до ${fmt(g.max)}${g.err ? `, ошибок ${g.err}` : ''}`),
      todo: ['Разобрать по одному, как задачи выше.'], done: 'в повторном тесте без задержек и ошибок',
    });
  }

  return tasks.sort((a, b) => PRIO[a.prio] - PRIO[b.prio]);
}

// Текст задачи для трекера
export function taskText(t, { site, report, date }) {
  return [
    `Приоритет: ${PRIO_LABEL[t.prio]}`, `Исполнитель: ${t.who}`, '',
    t.detail, '',
    'Где:', ...t.where.map((x) => `• ${x}`), '',
    'Что сделать:', ...t.todo.map((x, i) => `${i + 1}. ${x}`), '',
    `Готово, когда: ${t.done}`, '',
    `Тест оформления заказа: ${site}, ${date}. Отчёт: ${report}`,
  ].join('\n');
}

export function checkoutTasksCsv(tasks, ctx) {
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Задача', 'Описание', 'Приоритет', 'Исполнитель', 'Готово, когда'],
    ...tasks.map((t) => [t.title, taskText(t, ctx), PRIO_LABEL[t.prio], t.who, t.done])];
  return '﻿' + rows.map((r) => r.map(esc).join(';')).join('\n');
}

// Страница задач: как tasks.html обычной проверки, но в карточке — «Что сделать» по пунктам и «Готово, когда»
export function checkoutTasksHtml(tasks, ctx) {
  const whos = [...new Set(tasks.map((t) => t.who))];
  const count = (f) => tasks.filter(f).length;
  const KIND = { 'проверка сценария': 'проверка без входа и без заказа (--check)', 'без заказа': 'со входом, без заказа (--no-order)' };
  const cards = tasks.map((t, i) => `<article class="task" data-who="${escHtml(t.who)}" data-prio="${t.prio}" data-id="${escHtml(t.title)}">
<header><span class="n">${i + 1}</span><h2>${escHtml(t.title)}</h2>
<label class="done"><input type="checkbox"> перенесено</label></header>
<div class="meta"><span class="chip ${PRIO_CHIP[t.prio]}">${PRIO_LABEL[t.prio]}</span><span>Исполнитель: <b>${escHtml(t.who)}</b></span></div>
<p>${escHtml(t.detail)}</p>
<details open><summary>Где (${t.where.length})</summary><ul>${t.where.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ul></details>
<details open><summary>Что сделать</summary><ol>${t.todo.map((x) => `<li>${escHtml(x)}</li>`).join('')}</ol></details>
<p><b>Готово, когда:</b> ${escHtml(t.done)}</p>
<div class="btns"><button data-copy="title">Копировать заголовок</button><button data-copy="body">Копировать описание</button></div>
<textarea hidden class="c-title">${escHtml(t.title)}</textarea><textarea hidden class="c-body">${escHtml(taskText(t, ctx))}</textarea>
</article>`).join('');
  return taskPage({
    title: `Задачи оформления: ${ctx.site}`, key: `checkout-tasks|${ctx.site}|${ctx.date}`, cards, filters: filtersHtml(tasks, whos, count),
    intro: `<h1>Задачи по скорости оформления заказа: ${escHtml(ctx.site)}</h1>
<p class="muted">Тест от ${escHtml(ctx.date)} · ${escHtml(ctx.device)}${KIND[ctx.kind] ? ` · ${escHtml(KIND[ctx.kind])}` : ''} · задач: ${tasks.length} (высокий приоритет: ${count((t) => t.prio === 'high')}, средний: ${count((t) => t.prio === 'medium')}, низкий: ${count((t) => t.prio === 'low')}) · <a href="${escHtml(ctx.report)}">отчёт теста</a></p>
<p class="muted">Одна карточка — одна задача для разработки: где проблема (шаги и запросы с цифрами), что сделать по пунктам и когда задача готова. Кнопки копируют заголовок и описание — вставьте их в задачу в трекере. Отметка «перенесено» запоминается в этом браузере.</p>`,
  });
}
