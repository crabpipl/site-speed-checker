// Отчёт теста оформления заказа: шаги по времени, медленные запросы, ошибки, отклик кнопок, кадры экрана.
import { htmlPage, esc } from './report.js';
import { shortUrl } from './analyze.js';
import { fmt } from './checkout.js';
import { actionText } from './checkout-config.js';

const PRIO = { high: ['bad', 'Высокий'], medium: ['warn', 'Средний'], low: ['info', 'Низкий'] };
const isErr = (r) => r.status === 'FAILED' || r.status === 'PENDING' || (typeof r.status === 'number' && r.status >= 400);
// Шаги до карточки товара — вход; дальше — само оформление
// Служебные шаги (вход, проверка и очистка корзины) — серым, в итог «от карточки до заказа» не входят
const LOGIN_STEPS = /^(Главная страница|Форма входа|Отправка кода|Проверка кода|Проверка, что корзина пуста|Удаление других товаров)/;

export function checkoutRecs(steps, order) {
  const recs = [];
  const add = (prio, title, detail, items = [], who = '') => recs.push({ prio, title, detail, items, who });
  // Служебные шаги (вход, очистка корзины) — действия агента, а не покупателя: по ним рекомендаций нет
  steps = steps.filter((s) => !LOGIN_STEPS.test(s.name));
  for (const s of steps) {
    if (s.error) continue;
    const intSlow = s.requests.filter((r) => r.internal && !r.pending && r.dur >= 1000).sort((a, b) => b.dur - a.dur);
    if (s.dur >= 3000) {
      add(s.dur >= 5000 ? 'high' : 'medium', `Шаг «${s.name}» занимает ${fmt(s.dur)}`,
        intSlow.length ? 'Большую часть времени страница ждёт ответа своего сервера — ниже самые долгие запросы этого шага.' : 'Долгих запросов к своему серверу нет — время уходит на загрузку и отрисовку страницы (скрипты, картинки, внешние сервисы).',
        intSlow.slice(0, 5).map((r) => `${fmt(r.dur)} — ${shortUrl(r.url, 90)}`), intSlow.length ? 'Бэкенд' : 'Фронтенд');
    } else if (intSlow.length) {
      add('medium', `Медленный ответ сервера на шаге «${s.name}»`, 'Отдельные запросы к своему серверу дольше секунды. Покупатель в это время ждёт с крутящимся индикатором.',
        intSlow.slice(0, 5).map((r) => `${fmt(r.dur)} — ${shortUrl(r.url, 90)}`), 'Бэкенд');
    }
    if (s.click != null && s.click > 200) {
      add(s.click > 500 ? 'high' : 'medium', `Кнопка «${s.action}» откликается с задержкой ${fmt(s.click)}`,
        'После нажатия экран долго не меняется — покупатель думает, что кнопка не сработала, и нажимает ещё раз. Норма отклика — до 200 мс. Покажите реакцию сразу (индикатор, блокировка кнопки), тяжёлую работу — после.', [], 'Фронтенд');
    }
    if (s.longTasks >= 300) {
      add('medium', `JavaScript нагружает процессор на шаге «${s.name}»: ${fmt(s.longTasks)}`, 'Долгие задачи JS блокируют страницу: она не реагирует на нажатия и прокрутку.', [], 'Фронтенд');
    }
  }
  const errs = steps.flatMap((s) => s.requests.filter((r) => isErr(r) && !(r.status === 'PENDING' && !r.internal)).map((r) => ({ s, r })));
  const intErr = errs.filter((x) => x.r.internal);
  if (intErr.length) {
    add('high', `Ошибки запросов к своему серверу при оформлении (${intErr.length})`, 'Ошибки на шагах оформления — частая причина брошенных корзин: часть покупателей видит сбой или пустой блок.',
      intErr.slice(0, 8).map(({ s, r }) => `«${s.name}»: ${r.status}${r.error ? ' ' + r.error : ''} — ${shortUrl(r.url, 80)}`), 'Бэкенд');
  }
  const ext = new Map();
  for (const s of steps.filter((x) => !LOGIN_STEPS.test(x.name))) for (const r of s.requests.filter((x) => !x.internal)) {
    const g = ext.get(r.service) || { n: 0, max: 0, err: 0 };
    g.n++; g.max = Math.max(g.max, r.dur); if (isErr(r)) g.err++;
    ext.set(r.service, g);
  }
  const heavy = [...ext.entries()].filter(([, g]) => g.max >= 1000 || g.err).sort((a, b) => b[1].max - a[1].max);
  if (heavy.length) {
    add('low', `Внешние сервисы на страницах оформления: ${ext.size}, из них медленных или с ошибками — ${heavy.length}`,
      'На шагах оформления лучше оставить только нужное для заказа (оплата, адреса, антифрод). Счётчики и реклама — после оформления или отложенно.',
      heavy.slice(0, 8).map(([n, g]) => `${n}: ${g.n} запр., до ${fmt(g.max)}${g.err ? `, ошибок ${g.err}` : ''}`), 'Маркетинг');
  }
  const ord = steps.find((s) => s.name.startsWith('Оформление заказа'));
  if (ord && !ord.error && ord.dur >= 2000) {
    add(ord.dur >= 4000 ? 'high' : 'medium', `Создание заказа после нажатия «${ord.action}» — ${fmt(ord.dur)}`,
      'Это последний шаг перед деньгами: долгое ожидание здесь — самое дорогое. Проверьте, что синхронно выполняется при создании заказа (резерв на складе, расчёт доставки, CRM, письма) и что можно вынести в фон.', [], 'Бэкенд');
  }
  const rank = { high: 0, medium: 1, low: 2 };
  return recs.sort((a, b) => rank[a.prio] - rank[b.prio]);
}

const CSS = `<style>
.steps td.sbar{min-width:180px;vertical-align:middle}.steps .sb{height:10px;border-radius:3px;background:var(--int)}.steps .sb.slow{background:var(--slow)}.steps .sb.bad{background:var(--bad)}
.steps tr.login td{color:var(--muted)}.steps tr.login td b{color:var(--fg)}
.flm{display:flex;gap:6px;flex-wrap:wrap;padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--card);margin:8px 0}
.flm figure{margin:0;text-align:center;font-size:11px;color:var(--muted)}.flm img{display:block;width:var(--fw);border:1px solid var(--line);border-radius:4px;background:#fff}
.d-up{color:var(--bad)}.d-down{color:var(--good)}
</style>`;

const delta = (cur, prev) => {
  if (prev == null || cur == null) return '';
  const d = cur - prev;
  if (Math.abs(d) < Math.max(150, prev * 0.15)) return '<small>≈ как прошлый раз</small>';
  return `<small class="${d > 0 ? 'd-up' : 'd-down'}" title="Прошлый раз: ${fmt(prev)}">${d > 0 ? '▲ +' : '▼ −'}${fmt(Math.abs(d))}</small>`;
};

export function renderCheckout(d, prev) {
  const steps = d.steps;
  const prevBy = new Map((prev?.steps || []).map((s) => [s.name, s.dur]));
  const flow = steps.filter((s) => !LOGIN_STEPS.test(s.name));
  const total = flow.filter((s) => !s.error).reduce((a, s) => a + s.dur, 0);
  const prevTotal = prev ? prev.steps.filter((s) => !LOGIN_STEPS.test(s.name) && !s.error).reduce((a, s) => a + s.dur, 0) : null;
  const slowest = [...flow].filter((s) => !s.error).sort((a, b) => b.dur - a.dur)[0];
  const max = Math.max(1, ...steps.map((s) => s.dur));
  const recs = d.recs;
  const errCount = steps.reduce((a, s) => a + s.requests.filter((r) => isErr(r) && r.internal).length, 0);
  const o = d.order;
  const status = d.error ? `<span class="chip bad">Прервано на шаге «${esc(d.stoppedAt)}»</span> ${esc(d.error)}`
    : d.stoppedAt === 'остановлено вручную' ? '<span class="chip warn">Остановлено вручную</span>'
      : d.stoppedAt === 'проверка сценария' ? '<span class="chip info">Проверка сценария (--check)</span> без входа в аккаунт и без заказа: все кнопки из настроек нашлись'
      : d.stoppedAt === 'без заказа' ? '<span class="chip info">Без заказа (--no-order)</span> кнопка оформления не нажималась'
        : o?.confirmed ? `<span class="chip good">Заказ оформлен${o.number ? ` № ${esc(o.number)}` : ''}</span>${o.paymentForm ? ` открылась форма оплаты ${esc(o.paymentHost)} — данные карты не вводились, заказ не оплачен` : ''} · <b>не забудьте отменить заказ</b>`
          : '<span class="chip warn">Заказ не подтверждён</span> не найден номер или текст «заказ оформлен» — проверьте в личном кабинете';
  const fw = d.device === 'mobile' ? 92 : 150;

  const rows = steps.map((s) => {
    const cls = s.error ? 'bad' : s.dur >= 3000 ? 'slow' : '';
    const ints = s.requests.filter((r) => r.internal);
    const top = [...ints].filter((r) => !r.pending).sort((a, b) => b.dur - a.dur)[0];
    const errs = s.requests.filter((r) => isErr(r) && r.internal).length;
    return `<tr class="${LOGIN_STEPS.test(s.name) ? 'login' : ''}"><td class="r">${s.n}</td><td><a href="#st${s.n}"><b>${esc(s.name)}</b></a>${s.action ? `<br><small>«${esc(s.action)}»</small>` : ''}</td>
<td class="r"><b class="${s.error ? 'txt-bad' : ''}">${fmt(s.dur)}</b><br>${s.error ? `<small class="txt-bad">${esc(s.error.length > 40 ? 'ошибка' : s.error)}</small>` : delta(s.dur, prevBy.get(s.name))}</td>
<td class="sbar"><div class="sb ${cls}" style="width:${Math.max(1, (s.dur / max) * 100).toFixed(1)}%"></div></td>
<td class="r">${s.click == null ? '—' : `<span class="${s.click > 200 ? 'txt-bad' : ''}">${fmt(s.click)}</span>`}</td>
<td class="r">${ints.length} / ${s.requests.length - ints.length}</td>
<td class="url">${top ? `<span data-copy="${esc(top.url)}" title="Нажмите, чтобы скопировать полный URL" style="cursor:copy">${fmt(top.dur)} — ${esc(shortUrl(top.url.replace(/^https?:\/\//, ''), 60))}</span>` : '—'}</td>
<td class="r">${errs ? `<span class="chip bad">${errs}</span>` : '—'}</td><td class="r">${s.longTasks ? fmt(s.longTasks) : '—'}</td></tr>`;
  }).join('');

  const details = steps.map((s) => {
    const reqs = [...s.requests].sort((a, b) => Number(isErr(b)) - Number(isErr(a)) || b.dur - a.dur).slice(0, 15);
    return `<details class="page" id="st${s.n}" ${s.error || s.dur >= 3000 ? 'open' : ''}><summary>${s.n}. ${esc(s.name)} — ${s.error ? '<span class="chip bad">ошибка</span>' : fmt(s.dur)}</summary>
${s.error ? `<p class="note">${esc(s.error)}</p>` : ''}
<p class="muted">${s.action ? `Нажато: «${esc(s.action)}». ` : ''}${s.navigated ? 'Открылась новая страница' : 'Страница не перезагружалась'}: <code>${esc(shortUrl(s.url, 100))}</code>.
${s.metrics ? ` TTFB ${fmt(s.metrics.ttfb)}, первый контент ${fmt(s.metrics.fcp)}, load ${fmt(s.metrics.load)}.` : ''}${s.visual != null ? ` Экран последний раз изменился через ${fmt(s.visual)} после нажатия.` : ''}${s.click != null ? ` Отклик на нажатие ${fmt(s.click)}.` : ''}</p>
${s.frames?.length ? `<div class="flm" style="--fw:${fw}px">${s.frames.map((f) => `<figure><img src="data:image/jpeg;base64,${f.data}" alt="Экран через ${fmt(f.t)}"><figcaption>${fmt(f.t)}</figcaption></figure>`).join('')}</div>` : ''}
${reqs.length ? `<div class="tbl"><table><thead><tr><th>Источник</th><th>Тип</th><th>Статус</th><th class="r">Старт</th><th class="r">Время</th><th>URL</th></tr></thead><tbody>
${reqs.map((r) => `<tr><td>${r.internal ? '<b>Свой</b>' : esc(r.service)}</td><td>${esc(r.type)}</td><td>${isErr(r) ? `<span class="chip ${r.internal ? 'bad' : 'warn'}">${esc(String(r.status))}</span> <small>${esc(r.error)}</small>` : esc(String(r.status))}</td>
<td class="r">${fmt(r.start)}</td><td class="r ${r.dur >= 1000 ? 'txt-bad' : ''}">${r.pending ? 'не завершился' : fmt(r.dur)}</td><td class="url"><span data-copy="${esc(r.url)}" title="Нажмите, чтобы скопировать полный URL" style="cursor:copy">${esc(shortUrl(r.url, 110))}</span></td></tr>`).join('')}
</tbody></table></div>${s.requests.length > 15 ? `<p class="muted">Показаны 15 из ${s.requests.length} запросов: сначала ошибки, затем самые долгие.</p>` : ''}` : '<p class="muted">Запросов не было.</p>'}
</details>`;
  }).join('');

  return htmlPage(`Оформление заказа: ${d.site}`, `${CSS}<h1>Оформление заказа: ${esc(d.site)}${d.test ? ' — тестовый контур' : ''}</h1>
<p class="muted">${esc(d.profile)} · ${esc(new Date(d.startedAt).toLocaleString('ru-RU'))} · ${d.login === 'phone' ? 'вход по телефону' : d.login === 'email' ? 'вход по почте' : 'без входа (гость)'}</p>
<p class="muted">${(d.products?.length || 1) > 1 ? `Товары (${d.products.length}): ` : 'Товар: '}${(d.products?.length ? d.products : [{ url: d.product, title: d.productTitle }]).map((x) => esc(x.title || x.url)).join('; ')}${d.removed?.length ? ` · удалены из корзины до теста: ${esc(d.removed.join('; '))}` : ''}</p>
<p class="muted">Получение: «${esc(d.delivery)}»${d.store ? `, магазин «${esc(d.store)}»` : ''} · оплата: «${esc(d.payment)}»</p>
<div class="card">${status}</div>

<div class="grid">
  <div class="stat"><div class="v">${fmt(total)}</div><div class="l">от карточки товара до ${d.order ? 'заказа' : 'выбора оплаты'} — время ожидания${prevTotal ? `<br>${delta(total, prevTotal)}` : ''}</div></div>
  <div class="stat"><div class="v">${slowest ? fmt(slowest.dur) : '—'}</div><div class="l">самый медленный шаг${slowest ? `: ${esc(slowest.name)}` : ''}</div></div>
  <div class="stat"><div class="v" style="color:${errCount ? 'var(--bad)' : 'var(--good)'}">${errCount}</div><div class="l">ошибок запросов к своему серверу</div></div>
  <div class="stat"><div class="v">${recs.length}</div><div class="l">рекомендаций</div></div>
</div>
${d.notes?.length ? d.notes.map((x) => `<p class="note">${esc(x)}</p>`).join('') : ''}

<h2>Шаги</h2>
<div class="tbl"><table class="steps"><thead><tr><th class="r">№</th><th>Шаг</th><th class="r">Время</th><th></th><th class="r">Отклик кнопки</th><th class="r">Запросов: свои / внеш.</th><th>Самый долгий свой запрос</th><th class="r">Ошибок</th><th class="r">Долгие задачи JS</th></tr></thead><tbody>${rows}</tbody></table></div>
<p class="muted">«Время» — от нажатия до момента, когда завершились запросы к своему серверу (а при переходе на новую страницу — до её полной загрузки). Время, пока вы вводили код, не учитывается. Серым — служебные шаги (вход, очистка корзины), в итог «от карточки до заказа» они не входят. «Отклик кнопки» — через сколько после нажатия браузер отрисовал реакцию (норма до 200 мс). ▲/▼ — изменение с прошлого теста. Нажмите на адрес запроса, чтобы скопировать его полностью.</p>

<h2>Рекомендации</h2>
${recs.length ? `<ol class="recs">${recs.map((r) => `<li class="${r.prio}"><span class="chip ${PRIO[r.prio][0]}">${PRIO[r.prio][1]}</span>${r.who ? ` <small>${esc(r.who)}</small>` : ''} <b>${esc(r.title)}</b><p>${esc(r.detail)}</p>${r.items.length ? `<ul>${r.items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}</li>`).join('')}</ol>` : '<p>Серьёзных проблем на шагах оформления не найдено.</p>'}

<h2>Подробно по шагам</h2>
${details}

<h2>Как проводился тест</h2>
<div class="card"><p>Агент открыл сайт в чистом профиле браузера (${esc(d.profile)}), вошёл в личный кабинет по коду, который вы ввели в Терминале, и прошёл оформление по шагам из файла checkout.txt: карточка товара → корзина → оформление → способ получения → способ оплаты → «${esc(actionText(d.placeOrder))}». На каждом шаге записывались все запросы, отклик на нажатие (Event Timing), долгие задачи JavaScript и кадры экрана.</p>
<p>После теста агент вышел из аккаунта, удалил cookies и закрыл браузер — данные входа нигде не сохраняются. Телефон, почта, код и имя в отчёт не попадают: в адресах запросов они заменены на «•••», на кадрах шагов входа форма не размыта — видно, какой телефон или почту ввёл агент (и введённый код); на остальных кадрах поля ввода и похожий на контакты текст размыты. Перед пересылкой отчёта помните: на кадрах входа виден номер телефона или почта.</p>
<p class="muted">Один тест — один заказ, поэтому прогон один, а не медиана нескольких: отдельные шаги могут «прыгать» от запуска к запуску. Сравнивайте несколько тестов в динамике.</p></div>`);
}
