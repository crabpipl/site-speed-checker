// Задачи для разработки по тесту оформления заказа: что исправить, где (шаги и запросы с цифрами),
// что сделать по пунктам и когда задача считается готовой. Одна задача — один запрос сервера,
// один внешний сервис или одна группа однотипных проблем фронтенда.
// Выгрузка: tasks.html (карточки с кнопками «Копировать») и tasks.csv (таблица для Excel) рядом с checkout_report.html.
import { fmt } from './checkout.js';
import { readyOf, LOGIN_STEPS, isAborted, causeOf, kb, reqLine } from './report-checkout.js';
import { taskPage, filtersHtml, escHtml, PRIO_CHIP, PRIO_LABEL } from './tasks.js';

const BACK = 'Бэкенд';
const FRONT = 'Фронтенд';
const MARKET = 'Маркетинг + фронтенд';
const PRIO = { high: 0, medium: 1, low: 2 };
const isErr = (r) => (r.status === 'FAILED' && !isAborted(r)) || (typeof r.status === 'number' && r.status >= 400);
const API_TYPES = /^(xhr|fetch|document|other)$/;
// Запрос к API своего сервера (данные, страницы), а не файл: тип запроса и расширение в адресе
const FILE_EXT = /\.(m?js|css|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|json|map)$/i;
const isApi = (r) => { let path = ''; try { path = new URL(r.url).pathname; } catch {} return API_TYPES.test(r.type) && !FILE_EXT.test(path); };
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
  // Служебные шаги, шаги с ошибкой и помеченные («кнопка открыла корзину вместо добавления») — не основа для задач
  const steps = d.steps.filter((s) => !LOGIN_STEPS.test(s.name) && !s.error && !s.invalid);
  const all = d.steps.filter((s) => !LOGIN_STEPS.test(s.name) && !s.invalid);
  const site = d.site;
  const verify = `npm run audit:checkout -- --site=${site.includes(' ') ? `"${site}"` : site} --no-order`;
  const tasks = [];
  const add = (t) => tasks.push({ todo: [], where: [], ...t });

  // ── Медленные запросы к своему серверу — задача на каждый адрес ──
  const slowApi = new Map();
  for (const s of steps) for (const r of s.requests) {
    if (!r.internal || r.pending || r.dur < 1000 || !isApi(r)) continue;
    const key = endpointOf(r);
    const g = slowApi.get(key) ?? { key, max: 0, wait: null, size: null, server: 0, big: 0, stepMax: 0, hits: [] };
    g.max = Math.max(g.max, r.dur);
    if (r.wait != null) g.wait = Math.max(g.wait ?? 0, r.wait);
    if (r.size != null) g.size = Math.max(g.size ?? 0, r.size);
    if (causeOf(r) === 'server') g.server++; else if (causeOf(r) === 'size') g.big++;
    g.stepMax = Math.max(g.stepMax, readyOf(s));
    g.hits.push(`«${s.name}»: ${fmt(r.dur)}${r.wait != null ? ` (ожидание ответа ${fmt(r.wait)}${r.size != null ? `, ответ ${kb(r.size)}` : ''})` : ''}${r.status && r.status !== 200 ? `, статус ${r.status}` : ''}`);
    slowApi.set(key, g);
  }
  const apis = [...slowApi.values()].sort((a, b) => b.max - a.max);
  for (const g of apis.slice(0, 8)) {
    const cause = g.server ? 'server' : g.big ? 'size' : null;
    const facts = `Запрос длился до ${fmt(g.max)}${g.wait != null ? `, ожидание ответа — до ${fmt(g.wait)} (время сервера плюс задержка сети профиля теста)` : ''}${g.size != null ? `, размер ответа — до ${kb(g.size)}` : ''}.${g.stepMax >= 5000 ? ` Он есть на шаге, где контент готов только через ${fmt(g.stepMax)}.` : ''}`;
    add({
      title: cause === 'server' ? `Ускорить ответ сервера: ${g.key} — ожидание до ${fmt(g.wait)}`
        : cause === 'size' ? `Уменьшить ответ: ${g.key} — ${kb(g.size)}, запрос до ${fmt(g.max)}`
        : `Разобрать долгий запрос: ${g.key} — до ${fmt(g.max)}`,
      // Высокий — если запрос дольше 3 с, сервер отвечал 2 с и дольше или запрос стоит на шаге, где контент готов через 5 с и больше
      who: BACK, prio: g.max >= 3000 || (g.wait ?? 0) >= 2000 || g.stepMax >= 5000 ? 'high' : g.max >= 1500 ? 'medium' : 'low',
      detail: facts + (cause ? '' : ' Разбивки «ожидание / скачивание» в этом отчёте нет — причина не определена.'),
      where: g.hits,
      todo: cause === 'server' ? [
        'Найти, на что сервер тратит время в этом запросе: логи или профилировщик с временем по этапам.',
        'Добавить в ответ заголовок Server-Timing — время по этапам будет видно в DevTools браузера и в мониторинге.',
      ] : cause === 'size' ? [
        `Ответ весит до ${kb(g.size)}: проверить, какие данные из него нужны странице на этом шаге, и не отдавать лишнее.`,
        'Проверить, что ответ сжимается (gzip или brotli).',
      ] : [
        'Посмотреть запрос в DevTools → Network → Timing: ожидание ответа (Waiting) или скачивание (Content Download).',
        'Или повторить тест — новая версия агента записывает эту разбивку сама.',
      ],
      done: `запрос ≤ 500 мс на всех шагах в повторном тесте (${verify})`,
    });
  }
  if (apis.length > 8) {
    add({
      title: `Остальные долгие запросы к своему серверу (${apis.length - 8})`,
      who: BACK, prio: 'low', detail: 'Ещё несколько запросов к своему серверу дольше 1 с.',
      where: apis.slice(8).map((g) => `${g.key} — до ${fmt(g.max)} (${g.hits.length} раз)`),
      todo: ['Разобрать по одному, как задачи выше.'], done: `все запросы ≤ 1 с в повторном тесте (${verify})`,
    });
  }

  // ── Ошибки своих запросов ──
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
      who: BACK, prio: 'high', detail: 'Запрос к своему серверу на шагах оформления завершился ошибкой. Что было на экране — на кадрах шага в отчёте.',
      where: [...g.steps].map((n) => `шаг «${n}»`),
      todo: ['Найти запрос в логах сервера по времени теста и воспроизвести.', 'Исправить причину или не отправлять запрос, если он не нужен на этом шаге.'],
      done: `в повторном тесте этот запрос без ошибки (${verify})`,
    });
  }

  // ── Создание заказа ──
  const ord = all.find((s) => s.name.startsWith('Оформление заказа'));
  if (ord && !ord.error && readyOf(ord) >= 2000) {
    add({
      title: `Ускорить создание заказа — ${fmt(readyOf(ord))} после нажатия «${ord.action}»`,
      who: BACK, prio: readyOf(ord) >= 4000 ? 'high' : 'medium',
      detail: 'Время от нажатия кнопки оформления до готовой страницы после заказа. Ниже — самые долгие запросы к своему серверу на этом шаге.',
      where: ord.requests.filter((r) => r.internal && !r.pending).sort((a, b) => b.dur - a.dur).slice(0, 6).map((r) => reqLine(r)),
      todo: ['Разобрать запросы из списка: что сервер делает до ответа покупателю и что из этого можно выполнять после ответа.'],
      done: `создание заказа ≤ 2 с в тесте с заказом`,
    });
  }

  // ── Свои файлы (скрипты, стили, картинки) грузятся долго ──
  const slowStatic = new Map();
  for (const s of steps) for (const r of s.requests) {
    if (!r.internal || r.pending || r.dur < 1500 || isApi(r)) continue;
    const f = fileOf(r);
    const g = slowStatic.get(f) ?? { f, type: r.type, max: 0, wait: null, size: null, steps: new Set() };
    g.max = Math.max(g.max, r.dur); g.steps.add(s.name);
    if (r.wait != null) g.wait = Math.max(g.wait ?? 0, r.wait);
    if (r.size != null) g.size = Math.max(g.size ?? 0, r.size);
    slowStatic.set(f, g);
  }
  const statics = [...slowStatic.values()].sort((a, b) => b.max - a.max);
  if (statics.length) {
    const known = statics.filter((g) => g.wait != null);
    const slowServer = known.filter((g) => g.wait >= g.max * 0.6);
    const big = known.filter((g) => g.wait < g.max * 0.6);
    const todo = [];
    if (big.length) todo.push(`Файлы, где время ушло на скачивание (${big.map((g) => g.f).slice(0, 4).join(', ')}): уменьшить размер — разделить большие бандлы по страницам, убрать неиспользуемый код, проверить сжатие.`);
    if (slowServer.length) todo.push(`Файлы, где долго ждали ответа (${slowServer.map((g) => g.f).slice(0, 4).join(', ')}): проверить кэширование на сервере статики или CDN.`);
    if (known.length < statics.length) todo.push('Для файлов без разбивки времени — посмотреть DevTools → Network → Timing или повторить тест новой версией агента.');
    add({
      title: `Свои файлы грузятся дольше 1,5 с: ${plural(statics.length, 'файл', 'файла', 'файлов')}`,
      who: FRONT, prio: statics[0].max >= 3000 ? 'high' : 'medium',
      detail: 'Свои скрипты, стили и картинки на шагах оформления. Время — при скорости сети профиля теста; по размеру и ожиданию видно, что занимает время.',
      where: statics.slice(0, 10).map((g) => `${g.f} (${g.type}) — до ${fmt(g.max)}${g.wait != null ? ` (ожидание ${fmt(g.wait)}${g.size != null ? `, размер ${kb(g.size)}` : ''})` : ''}; шаги: ${[...g.steps].map((n) => `«${n}»`).join(', ')}`),
      todo, done: `каждый файл ≤ 1 с в повторном тесте (${verify})`,
    });
  }

  // ── Шаг долго готов, хотя долгих запросов к своему серверу нет ──
  const render = steps.filter((s) => readyOf(s) >= 3000 && !s.name.startsWith('Оформление заказа') && !s.requests.some((r) => r.internal && !r.pending && r.dur >= 1000 && isApi(r)));
  if (render.length) {
    add({
      title: `Шаги готовы через 3 с и дольше без долгих запросов к своему серверу (${render.length})`,
      who: FRONT, prio: render.some((s) => readyOf(s) >= 5000) ? 'high' : 'medium',
      detail: 'Отдельных запросов к своему серверу дольше 1 с на этих шагах нет: время складывается из многих запросов и построения страницы.',
      where: render.map((s) => `«${s.name}»: контент готов через ${fmt(readyOf(s))}`),
      todo: ['Записать шаг в DevTools → Performance с тем же замедлением сети и процессора и найти, что задерживает готовность страницы.'],
      done: `каждый шаг ≤ 3 с в повторном тесте (${verify})`,
    });
  }

  // ── Долгие задачи JavaScript ──
  const js = steps.filter((s) => s.longTasks >= 300).sort((a, b) => b.longTasks - a.longTasks);
  if (js.length) {
    add({
      title: `Долгие задачи JavaScript на ${plural(js.length, 'шаге', 'шагах', 'шагах')}`,
      who: FRONT, prio: js[0].longTasks >= 1000 ? 'high' : 'medium',
      detail: 'Суммарное время задач JS длиннее 50 мс; пока они выполняются, страница не отвечает на нажатия. Замер — при замедлении процессора из профиля теста.',
      where: js.map((s) => `«${s.name}»: ${fmt(s.longTasks)}${s.longCount ? ` (задач: ${s.longCount})` : ''}`),
      todo: ['Записать шаг в DevTools → Performance с тем же замедлением процессора и найти функции в долгих задачах.', 'Разбить найденную работу на части или перенести её после загрузки.'],
      done: `суммарно долгих задач < 200 мс на каждом шаге в повторном тесте (${verify})`,
    });
  }

  // ── Кнопки откликаются с задержкой ──
  const clicks = steps.filter((s) => s.click != null && s.click > 200);
  if (clicks.length) {
    add({
      title: `Отклик кнопок дольше 200 мс (${clicks.length})`,
      who: FRONT, prio: clicks.some((s) => s.click > 500) ? 'high' : 'medium',
      detail: 'От нажатия до первого изменения на экране — больше 200 мс (порог «хорошего» отклика INP у Google).',
      where: clicks.map((s) => `«${s.action}» на шаге «${s.name}»: ${fmt(s.click)}`),
      todo: ['Показывать реакцию на нажатие сразу (индикатор, блокировка кнопки), остальную работу — после.'],
      done: `отклик ≤ 200 мс в повторном тесте (${verify})`,
    });
  }

  // ── Внешние сервисы — задача на сервис (без отменённых страницей запросов и без ожидающих ответа) ──
  const ext = new Map();
  for (const s of steps) for (const r of s.requests) {
    if (r.internal || r.pending || isAborted(r)) continue;
    const g = ext.get(r.service) ?? { name: r.service, n: 0, max: 0, err: 0, steps: new Set() };
    g.n++; g.max = Math.max(g.max, r.dur); if (isErr(r)) g.err++;
    g.steps.add(s.name);
    ext.set(r.service, g);
  }
  const bad = [...ext.values()].filter((g) => g.max >= 1000 || g.err).sort((a, b) => b.err - a.err || b.max - a.max);
  for (const g of bad.slice(0, 6)) {
    add({
      title: `Внешний сервис «${g.name}» на оформлении: до ${fmt(g.max)}${g.err ? `, ошибок ${g.err}` : ''}`,
      who: MARKET, prio: g.err >= 5 || g.max >= 3000 ? 'medium' : 'low',
      detail: `Запросов: ${g.n}, самый долгий — ${fmt(g.max)}${g.err ? `, с ошибкой — ${g.err}` : ''}. Отменённые страницей запросы (ERR_ABORTED) не учитываются.`,
      where: [`шаги: ${[...g.steps].map((n) => `«${n}»`).join(', ')}`],
      todo: ['Решить, нужен ли сервис на страницах корзины и оформления; если нет — не подключать его там.', 'Если нужен — подключать так, чтобы его запросы не задерживали готовность страницы.', ...(g.err ? ['Разобраться с ошибками сервиса (статус и адрес — в таблице запросов шага в отчёте).'] : [])],
      done: `в повторном тесте сервис без запросов дольше 1 с и без ошибок (${verify})`,
    });
  }
  if (bad.length > 6) {
    add({
      title: `Остальные внешние сервисы на оформлении (${bad.length - 6})`, who: MARKET, prio: 'low',
      detail: 'Ещё несколько сторонних сервисов с запросами дольше 1 с или с ошибками.',
      where: bad.slice(6).map((g) => `${g.name}: до ${fmt(g.max)}${g.err ? `, ошибок ${g.err}` : ''}`),
      todo: ['Разобрать по одному, как задачи выше.'], done: 'в повторном тесте без запросов дольше 1 с и без ошибок',
    });
  }

  return tasks.sort((a, b) => PRIO[a.prio] - PRIO[b.prio]);
}

// Условия замера из профиля устройства: сеть и замедление процессора
export function conditionsOf(profile) {
  const parts = [];
  if (profile?.network) parts.push(`сеть ${(profile.network.downloadThroughput * 8 / 1024 / 1024).toFixed(1).replace('.', ',')} Мбит/с, задержка ${profile.network.latency} мс`);
  if (profile?.cpu > 1) parts.push(`процессор замедлен в ${profile.cpu} раза`);
  return parts.length ? parts.join(', ') : 'без замедления сети и процессора';
}

// Текст задачи для трекера
export function taskText(t, ctx) {
  const { site, report, date } = ctx;
  return [
    `Приоритет: ${PRIO_LABEL[t.prio]}`, `Исполнитель: ${t.who}`, '',
    t.detail, '',
    'Где:', ...t.where.map((x) => `• ${x}`), '',
    'Что сделать:', ...t.todo.map((x, i) => `${i + 1}. ${x}`), '',
    `Готово, когда: ${t.done}`, '',
    `Тест оформления заказа: ${site}, ${date}${ctx.conditions ? ` (условия: ${ctx.conditions})` : ''}. Отчёт: ${report}`,
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
${ctx.conditions ? `<p class="muted">Условия замера: ${escHtml(ctx.conditions)}. На быстрой сети и мощном устройстве время будет меньше.</p>` : ''}
<p class="muted">Одна карточка — одна задача для разработки: где проблема (шаги и запросы с цифрами), что сделать по пунктам и когда задача готова. Кнопки копируют заголовок и описание — вставьте их в задачу в трекере. Отметка «перенесено» запоминается в этом браузере.</p>`,
  });
}
