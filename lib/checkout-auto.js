// Универсальные приёмы теста оформления для любого сайта:
//  1) всплывающие окна — окно выбора региона, плашка cookies, промо и подписки — закрываются сами;
//     если нужную кнопку перекрывает окно, оно закрывается перед нажатием;
//  2) кнопки ищутся не только по тексту: иконки входа и корзины — по адресу ссылки, подписи, картинке;
//     адрес корзины находится сам по ссылкам на странице;
//  4) если кнопка не найдена — подсказка: похожие элементы на странице и готовые строки для checkout.txt.

// ── 2. Запасные варианты поиска (добавляются после текстов из checkout.txt и типовых текстов) ──
// { auto: поле } — иконка ищется скриптом на странице: по адресу ссылки, подписи (aria-label, title),
// data-testid, классу и имени картинки из набора иконок (<use href="#icon-user">, в том числе xlink:href).
export const AUTO = {
  openLogin: [
    'css: :is(a, button, [role=button])[aria-label*="войти" i]',
    'css: :is(a, button, [role=button])[aria-label*="профил" i]',
    'css: :is(a, button, [role=button])[aria-label*="кабинет" i]',
    'css: :is(a, button, [role=button])[title*="войти" i]',
    { auto: 'openLogin' },
  ],
  // Только ссылки и явные подписи «Корзина»: кнопки «Добавить в корзину» у других товаров не подходят
  toCart: [
    'css: :is(a, button, [role=button])[aria-label="Корзина" i]',
    'css: :is(a, button, [role=button])[aria-label^="Перейти в корзину" i]',
    'css: :is(a, button, [role=button])[title="Корзина" i]',
    { auto: 'toCart' },
  ],
};

const ICON_WORDS = {
  openLogin: 'login|auth|personal|profile|account|cabinet|/lk\\b|user|person|войти|вход|профил|кабинет|аккаунт',
  toCart: 'cart|basket|korzin|корзин',
};
// Помечает самую подходящую иконку атрибутом data-ssa-auto; приоритет — шапка и нижняя панель
const ICON_FN = `(field, words) => {
  const re = new RegExp(words, 'i');
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  document.querySelectorAll('[data-ssa-auto]').forEach((e) => e.removeAttribute('data-ssa-auto'));
  // Кроме ссылок и кнопок — небольшие блоки с говорящим классом (на части сайтов вход — это <div class="…auth…">)
  const CLS = '[class*=auth i], [class*=login i], [class*=profile i], [class*=user i], [class*=account i], [class*=cabinet i], [class*=basket i], [class*=cart i]';
  const small = (el) => { const r = el.getBoundingClientRect(); return r.width < 160 && r.height < 120; };
  const pool = [...new Set([...document.querySelectorAll('a, button, [role=button]'), ...[...document.querySelectorAll(CLS)].filter(small)])];
  const found = pool.filter(vis).filter((el) => {
    const use = el.querySelector('use');
    const hay = [el.getAttribute('href'), el.getAttribute('aria-label'), el.getAttribute('title'), el.getAttribute('data-testid'),
      typeof el.className === 'string' ? el.className : '', use?.getAttribute('href'), use?.getAttribute('xlink:href'),
      el.querySelector('img')?.getAttribute('alt'), el.querySelector('svg')?.getAttribute('class')].filter(Boolean).join(' ');
    const text = (el.innerText || '').trim();
    if (!re.test(hay)) return false;
    // Кнопки «В корзину» у товаров — не переход в корзину; длинный текст — не иконка
    if (field === 'toCart' && /в корзину|добав|купить/i.test(text + ' ' + (el.getAttribute('aria-label') || ''))) return false;
    return text.length < 30;
  });
  const edge = (el) => { const r = el.getBoundingClientRect(); return r.top < 160 || r.top > innerHeight - 110 ? 0 : 1; };
  // Внешний элемент важнее вложенного иконочного блока: нажимаем то, на что нажал бы человек
  // Для корзины лучше всего настоящая ссылка на корзину — она точно открывает страницу корзины, а не выпадающее окно
  const cartLink = (el) => (field === 'toCart' && el.tagName === 'A' && /cart|basket|korzin|[/]order[/]?$/i.test(el.getAttribute('href') || '') ? 0 : 1);
  const outer = found.filter((el) => cartLink(el) === 0 || !found.some((o) => o !== el && o.contains(el)));
  const best = outer.sort((a, b) => cartLink(a) - cartLink(b) || edge(a) - edge(b))[0];
  if (best) best.setAttribute('data-ssa-auto', field);
  return !!best;
}`;

// Найти иконку для поля; возвращает локатор или null (scope — страница)
export async function autoLocator(page, field) {
  if (!ICON_WORDS[field] || typeof page.mainFrame !== 'function') return null;
  const ok = await page.evaluate(`(${ICON_FN})(${JSON.stringify(field)}, ${JSON.stringify(ICON_WORDS[field])})`).catch(() => false);
  return ok ? page.locator(`[data-ssa-auto="${field}"]`).first() : null;
}
export const AUTO_LABEL = { openLogin: 'иконка входа (найдена автоматически)', toCart: 'иконка корзины (найдена автоматически)' };

// Типовые тексты, которых не было в ранних версиях DEFAULTS, — общие для большинства магазинов
export const MORE_TEXTS = {
  openLogin: ['Войти / Зарегистрироваться', 'Вход и регистрация', 'Войти в личный кабинет', 'Мой профиль', 'Кабинет', 'Аккаунт'],
  addToCart: ['Положить в корзину', 'Добавить', 'Купить сейчас'],
  // «В корзину» сюда не входит: на многих сайтах так называется кнопка добавления товара
  toCart: ['Перейти в корзину', 'Оформить заказ'],
  toCheckout: ['Перейти к оформлению', 'Перейти к оформлению заказа', 'К оформлению заказа', 'Продолжить оформление', 'Оформить заказ'],
};

// ── 1. Всплывающие окна ──
// Известные окна: выбор региона/города и согласие на cookies. Кнопка помечается data-ssa-pop, по ней агент нажимает.
const KNOWN_POPUPS_FN = `() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && r.bottom > 0 && r.top < innerHeight && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  const txt = (el) => (el.innerText || el.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ');
  const KINDS = [
    { kind: 'регион', text: /ваш (регион|город)|ваш город|это ваш город|город (указан|определ)|регион определ/i,
      yes: /^(да|да,? верно|верно|всё верно|все верно|да,? это (мой|мой город)|да,? всё верно|подтвердить|ок|ok)$/i },
    { kind: 'cookies', text: /cookie|куки|файл(ов|ы) cookie/i,
      yes: /^(принять|принимаю|хорошо|согласен|согласна|я согласен|ок|ok|понятно|accept|принять все|принять всё|закрыть|×|✕)$/i },
  ];
  document.querySelectorAll('[data-ssa-pop]').forEach((e) => e.removeAttribute('data-ssa-pop'));
  const out = [];
  const nodes = [...document.querySelectorAll('body *')].filter((el) => el.children.length < 40 && vis(el));
  for (const k of KINDS) {
    // Самый «тесный» видимый блок с нужным текстом
    const box = nodes.filter((el) => k.text.test(txt(el)) && txt(el).length < 400).sort((a, b) => txt(a).length - txt(b).length)[0];
    if (!box) continue;
    // Кнопка согласия — в этом блоке или до 4 уровней выше
    let btn = null;
    for (let n = box, up = 0; n && up < 5 && !btn; n = n.parentElement, up++) {
      // Кнопкой бывает и простой блок (<div>Да</div>) — подходит любой небольшой элемент с точным текстом
      btn = [...n.querySelectorAll('button, a, [role=button], input[type=button], input[type=submit], div, span')].filter(vis)
        .find((b) => k.yes.test(txt(b) || b.value || '') && b.getBoundingClientRect().width < 400);
    }
    if (!btn) continue;
    btn.setAttribute('data-ssa-pop', String(out.length));
    out.push({ kind: k.kind, button: txt(btn) || btn.value || '' });
  }
  return out;
}`;

// Промо и подписки: большое окно поверх страницы со словами про скидки/подписку, без полей ввода
// (окна с полями — это форма входа, выбор магазина и т. п., их закрывать нельзя)
const PROMO_FN = `() => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05; };
  const txt = (el) => (el.innerText || '').trim().replace(/\\s+/g, ' ');
  document.querySelectorAll('[data-ssa-pop]').forEach((e) => e.removeAttribute('data-ssa-pop'));
  const boxes = [...document.querySelectorAll('body *')].filter((el) => {
    const pos = getComputedStyle(el).position;
    if (pos !== 'fixed' || !vis(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width * r.height > innerWidth * innerHeight * 0.15;
  });
  for (const box of boxes) {
    const t = txt(box);
    if (box.querySelector('input:not([type=hidden]):not([type=checkbox]), select, textarea')) continue;
    if (!/скидк|промокод|подпис|акци|бонус|подар|приложени|−\\s?\\d+\\s?%|-\\s?\\d+\\s?%|%\\s*off|распродаж/i.test(t) && t.length > 15) continue;
    const close = [...box.querySelectorAll('button, a, [role=button], span, div, i, svg')].filter(vis).find((b) =>
      /закрыть|close|^\\s*[×✕✖]\\s*$/i.test(((b.getAttribute('aria-label') || '') + ' ' + (typeof b.className === 'string' ? b.className : '') + ' ' + (b.textContent || '')).trim()) && b.children.length < 4);
    if (close) { close.setAttribute('data-ssa-pop', '0'); return { kind: 'промо', button: (close.textContent || '').trim() || close.getAttribute('aria-label') || '×', text: t.slice(0, 60) }; }
  }
  return null;
}`;

// Перекрыт ли элемент (el) другим — окном поверх страницы. Возвращает описание перекрывающего окна,
// кнопку закрытия в нём помечает data-ssa-pop.
const COVER_FN = `(el) => {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  const x = Math.min(Math.max(r.left + r.width / 2, 1), innerWidth - 1), y = Math.min(Math.max(r.top + r.height / 2, 1), innerHeight - 1);
  const top = document.elementFromPoint(x, y);
  if (!top || el === top || el.contains(top) || top.contains(el)) return null;
  let box = null;
  for (let n = top; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).position === 'fixed') { box = n; break; }
  if (!box || box.contains(el)) return null;
  // Закреплённая панель навигации (нижнее меню, шапка) — не окно: кнопку нужно просто прокрутить в середину экрана
  const br = box.getBoundingClientRect();
  if (box.tagName === 'NAV' || box.tagName === 'HEADER' || (br.height < 150 && box.querySelectorAll('a').length >= 3)) return { nav: true };
  // Окно с полями ввода — это форма (вход, выбор магазина, адрес): его не закрываем
  if (box.querySelector('input:not([type=hidden]):not([type=checkbox]):not([type=radio]), select, textarea')) return null;
  document.querySelectorAll('[data-ssa-pop]').forEach((e) => e.removeAttribute('data-ssa-pop'));
  const vis = (b) => { const q = b.getBoundingClientRect(); return q.width > 2 && q.height > 2; };
  const label = (b) => ((b.getAttribute('aria-label') || '') + ' ' + (typeof b.className === 'string' ? b.className : '') + ' ' + (b.textContent || '')).trim();
  const btn = [...box.querySelectorAll('button, [role=button], a, span, div, i, svg')].filter(vis).find((b) =>
    (/закрыть|close|^\\s*[×✕✖]\\s*$/i.test(label(b)) && b.children.length < 4) ||
    (/^(да|да,? верно|ок|ok|понятно|хорошо|принять|согласен)$/i.test((b.textContent || '').trim()) && b.matches('button, [role=button], a')));
  if (btn) btn.setAttribute('data-ssa-pop', '0');
  const text = (box.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 60);
  // Escape закрывает верхнее окно на странице. Если сама кнопка — в окне (вход, адрес) или «перекрытие» — пустой
  // прозрачный слой, Escape закрыл бы нужное окно: тогда не закрываем ничего, кнопка нажимается напрямую
  let inModal = false;
  for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) if (getComputedStyle(n).position === 'fixed' || n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true') { inModal = true; break; }
  return { text, noEscape: inModal || !text, button: btn ? ((btn.textContent || '').trim() || btn.getAttribute('aria-label') || '×').slice(0, 30) : '' };
}`;

// Журнал закрытых окон для отчёта (одинаковые окна — один раз)
export class Popups {
  constructor(log = () => {}) { this.list = []; this.log = log; }
  add(kind, button, text = '') {
    const key = `${kind}|${button}|${text.slice(0, 30)}`;
    if (this.list.some((x) => x.key === key)) return;
    this.list.push({ key, kind, button, text });
    this.log(`  Закрыто окно (${kind}): «${button || 'Escape'}»${text ? ` — ${text}` : ''}`);
  }
}

const clickPop = (page) => page.locator('[data-ssa-pop]').first().click({ timeout: 2000, force: true }).catch(() => {});

// Перед шагом: окна региона и cookies, а также промо-окна со скидками/подписками
// Возвращает, сколько окон закрыто: после подтверждения региона сайт часто перерисовывает страницу
export async function closeKnownPopups(page, popups) {
  let closed = 0;
  for (let i = 0; i < 4; i++) {
    const found = await page.evaluate(`(${KNOWN_POPUPS_FN})()`).catch(() => []);
    if (!found.length) break;
    for (const f of found) {
      await page.locator(`[data-ssa-pop="${found.indexOf(f)}"]`).first().click({ timeout: 2000, force: true }).catch(() => {});
      popups.add(f.kind, f.button);
      closed++;
      await page.waitForTimeout(300);
    }
  }
  for (let i = 0; i < 3; i++) {
    const promo = await page.evaluate(`(${PROMO_FN})()`).catch(() => null);
    if (!promo) break;
    await clickPop(page);
    popups.add('промо', promo.button, promo.text);
    closed++;
    await page.waitForTimeout(400);
  }
  if (closed) {
    // Дождаться перерисовки страницы (смена региона перестраивает шапку и цены)
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
  }
  return closed;
}

// Перед нажатием: если кнопку перекрывает окно — закрыть его (кнопкой закрытия, иначе Escape)
export async function clearCover(el, popups) {
  const page = el.page();
  const cover = new Function(`return (${COVER_FN})`)();
  for (let i = 0; i < 3; i++) {
    const c = await el.evaluate(cover).catch(() => null);
    if (!c) return;
    if (c.nav) { await el.evaluate((x) => x.scrollIntoView({ block: 'center' })).catch(() => {}); await page.waitForTimeout(300); continue; }
    if (c.button) await clickPop(page);
    else if (c.noEscape) return;
    else await page.keyboard.press('Escape').catch(() => {});
    popups?.add('перекрывало кнопку', c.button || 'Escape', c.text);
    await page.waitForTimeout(400);
  }
}

// ── 2. Адрес корзины по ссылкам на странице ──
export async function discoverCartUrl(page) {
  return page.evaluate(() => {
    const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.href).filter((h) => h.startsWith(location.origin));
    const path = (h) => new URL(h).pathname;
    // Явная корзина; запасной вариант — /order/ (на ряде платформ это и есть корзина)
    return hrefs.find((h) => /\/(order\/)?(cart|basket|korzina)\/?$/i.test(path(h))) || hrefs.find((h) => /^\/order\/?$/i.test(path(h))) || null;
  }).catch(() => null);
}

// ── 4. Подсказки, если кнопка не найдена ──
// Слова, по которым элемент похож на нужный для шага
const HINT_RE = {
  openLogin: /вход|войти|профил|кабинет|аккаунт|регистрац|login|auth|profile|account|personal|cabinet|user|person/i,
  byPhone: /телефон|phone|номер/i,
  byEmail: /почт|e-?mail|mail/i,
  sendCode: /код|получить|отправить|продолжить|далее|войти|code/i,
  addToCart: /корзин|купить|добав|cart|basket|buy/i,
  toCart: /корзин|оформ|cart|basket/i,
  toCheckout: /оформ|продолж|заказ|checkout|order/i,
  delivery: /самовывоз|магазин|достав|курьер|пункт выдачи|забрать|pickup|delivery/i,
  storeList: /списк|список|карт/i,
  store: /магазин|пункт|адрес/i,
  storeConfirm: /забрать|выбрать|здесь|подтверд/i,
  payment: /оплат|получени|карт|налич|онлайн|pay/i,
  placeOrder: /оформ|подтверд|заказ|оплат/i,
};

const HINTS_FN = `(reSrc) => {
  const re = new RegExp(reSrc, 'i');
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const txt = (el) => (el.innerText || el.value || '').trim().replace(/\\s+/g, ' ');
  const esc = (s) => s.replace(/"/g, '\\\\"');
  const out = [];
  const seen = new Set();
  const CLS = '[class*=auth i], [class*=login i], [class*=profile i], [class*=user i], [class*=account i], [class*=basket i], [class*=cart i]';
  const small = (el) => { const r = el.getBoundingClientRect(); return r.width < 160 && r.height < 120; };
  // Варианты доставки и оплаты часто — нажимаемые карточки-блоки (курсор-«рука»), а не кнопки
  const cards = [...document.querySelectorAll('div, li, section, article')].filter((el) => {
    if (getComputedStyle(el).cursor !== 'pointer') return false;
    const r = el.getBoundingClientRect(), n = (el.innerText || '').trim().length;
    return n >= 3 && n <= 160 && r.height < 220 && r.width * r.height < innerWidth * innerHeight * 0.5;
  });
  const pool = [...new Set([...document.querySelectorAll('a, button, [role=button], [role=tab], [role=radio], label, input[type=submit], input[type=button], [onclick]'), ...[...document.querySelectorAll(CLS)].filter(small), ...cards])];
  for (const el of pool) {
    if (!vis(el) || el.closest('footer, [class*=footer i]')) continue;
    // Ссылки на другие товары — не варианты для шага оформления
    if (/[/](product|catalog|d)[/][^/]+[/]?$/.test(el.getAttribute('href') || '') && !/корзин|cart|basket/i.test(el.getAttribute('href') || '')) continue;
    const t = txt(el), aria = el.getAttribute('aria-label') || '', title = el.getAttribute('title') || '', href = el.getAttribute('href') || '';
    const testid = el.getAttribute('data-testid') || '', cls = typeof el.className === 'string' ? el.className.trim() : '';
    const icon = el.querySelector('use')?.getAttribute('href') || el.querySelector('use')?.getAttribute('xlink:href') || '';
    const hay = [t, aria, title, href, testid, cls, icon].join(' ');
    if (!re.test(hay)) continue;
    // Строка для checkout.txt: короткий текст (у карточки — её первая строка, заголовок), иначе подпись, testid, адрес ссылки или класс
    const first = ((el.innerText || '').trim().split(String.fromCharCode(10))[0] || '').trim();
    let line = '';
    if (t && t.length <= 40) line = t;
    else if (first && first.length <= 40 && first.length >= 3) line = first;
    else if (aria) line = 'css: [aria-label="' + esc(aria) + '"]';
    else if (testid) line = 'css: [data-testid="' + esc(testid) + '"]';
    else if (href && href !== '#' && !/^javascript/i.test(href)) line = 'css: a[href="' + esc(href) + '"]';
    else if (cls) line = 'css: ' + el.tagName.toLowerCase() + '.' + cls.split(/\\s+/)[0];
    if (!line || seen.has(line)) continue;
    seen.add(line);
    const what = t ? '«' + t.slice(0, 40) + '»' : aria ? 'подпись «' + aria.slice(0, 40) + '»' : icon ? 'иконка ' + icon.slice(0, 30) : href ? 'ссылка ' + href.slice(0, 40) : el.tagName.toLowerCase();
    out.push({ line, what, y: Math.round(el.getBoundingClientRect().top) });
    if (out.length >= 8) break;
  }
  return out;
}`;

export async function hintsFor(page, field) {
  const re = HINT_RE[field];
  if (!re || !page) return [];
  return page.evaluate(`(${HINTS_FN})(${JSON.stringify(re.source)})`).catch(() => []);
}

// Ошибка шага с подсказками: какие похожие элементы есть на странице
export class HintedError extends Error {
  constructor(message, field, hints) { super(message); this.field = field; this.hints = hints || []; }
}

// ── 3. Выбор размера / цвета / варианта товара ──
// Группа вариантов: контейнер с классом про размер/вариант/цвет; варианты — короткие нажимаемые элементы.
// Переключатели шкалы (EU/US/RUS), таблицы размеров и фильтры — не варианты.
// want: null — первый доступный; массив текстов — найти именно их (42; Чёрный). Выбранный вариант помечается data-ssa-var.
const VARIANT_FN = `(want) => {
  const vis = (el) => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && r.right > 0 && r.left < innerWidth && cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const cls = (el) => (typeof el.className === 'string' ? el.className : (el.className && el.className.baseVal) || '');
  const label = (el) => ((el.innerText || '').trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-value') || '').replace(/[ ]+/g, ' ').trim();
  const GROUP = /size|razmer|sku|variant|offer|option|swatch|color|colour|razm|размер|цвет/i;
  const NOT_GROUP = /scale|switch|unit|table|guide|chart|filter|sort|tab[s]?$|select__|dropdown|modal__close|breadcrumb|gallery|slider|swiper|carousel|pagination|bullet|thumb|dots|photo|image|media|review|rating/i;
  // Группа, явно названная «размер», важнее цвета, а цвет — важнее общих «option/offer»
  const SIZE = /size|razmer|razm|размер/i, COLOR = /color|colour|swatch|цвет/i;
  const rank = (el) => (SIZE.test(cls(el)) ? 2 : COLOR.test(cls(el)) ? 1 : 0);
  const OFF = /disabled|unavailable|sold|out-of-stock|outofstock|empty|inactive|not-?avail|absent|no-?stock|missing/i;
  const ON = /active|selected|checked|current|chosen|is-picked/i;
  const off = (el) => el.disabled || el.getAttribute('aria-disabled') === 'true' || OFF.test(cls(el)) || el.getAttribute('data-available') === 'false' ||
    Number(getComputedStyle(el).opacity) < 0.45 || getComputedStyle(el).textDecorationLine.includes('line-through') || getComputedStyle(el).cursor === 'not-allowed';
  const on = (el) => ON.test(cls(el)) || ['aria-checked', 'aria-pressed', 'aria-selected'].some((a) => el.getAttribute(a) === 'true') || !!el.querySelector('input:checked');
  document.querySelectorAll('[data-ssa-var]').forEach((e) => e.removeAttribute('data-ssa-var'));
  let best = null;
  for (const box of document.querySelectorAll('[class]')) {
    if (!GROUP.test(cls(box)) || NOT_GROUP.test(cls(box)) || !vis(box) || box.closest('footer, header, nav')) continue;
    // Кандидаты — небольшие нажимаемые элементы с коротким текстом (или цветные плашки с подписью)
    let items = [...box.querySelectorAll('button, li, label, a, [role=radio], [role=option], div, span')].filter((e) => {
      if (!vis(e) || NOT_GROUP.test(cls(e))) return false;
      const t = label(e);
      if (!t || t.length > 12 || t.includes(String.fromCharCode(10))) return false;
      const r = e.getBoundingClientRect();
      return r.width < 220 && r.height < 120 && (e.matches('button, li, label, a, [role=radio], [role=option]') || getComputedStyle(e).cursor === 'pointer');
    });
    // Внешний элемент варианта, а не вложенная подпись
    items = items.filter((e) => !items.some((o) => o !== e && o.contains(e)));
    if (items.length < 1 || items.length > 60) continue;
    // Не путать с выбором шкалы: в группе вариантов значения разные, а не «EU/US/RUS»
    if (items.every((e) => /^(eu|us|uk|ru|rus|ит|int|см|cm|fr|it)$/i.test(label(e)))) continue;
    const r = rank(box);
    if (!best || r > best.rank || (r === best.rank && (items.length > best.items.length || (items.length === best.items.length && best.box.contains(box))))) best = { box, items, rank: r };
  }
  if (!best) return { found: false };
  const opts = best.items.map((e) => ({ el: e, text: label(e), off: off(e), on: on(e) }));
  const all = opts.map((o) => o.text + (o.off ? ' (нет)' : '') + (o.on ? ' (выбран)' : '')).slice(0, 15);
  let pick = null;
  if (want && want.length) {
    for (const w of want) {
      const lw = w.toLowerCase();
      pick = opts.find((o) => o.text.toLowerCase() === lw) || opts.find((o) => o.text.toLowerCase().startsWith(lw));
      if (pick) break;
    }
    if (!pick) return { found: true, all, missing: want.join('; ') };
    if (pick.off) return { found: true, all, unavailable: pick.text };
  } else {
    const sel = opts.find((o) => o.on && !o.off);
    if (sel) return { found: true, all, kept: sel.text };
    pick = opts.find((o) => !o.off);
    if (!pick) return { found: true, all, none: true };
  }
  if (pick.on) return { found: true, all, kept: pick.text };
  pick.el.setAttribute('data-ssa-var', '1');
  return { found: true, all, pick: pick.text };
}`;

// Найти группу вариантов и (если нужно) пометить вариант для нажатия. want — массив текстов или null.
export async function planVariant(page, want) {
  return page.evaluate(`(${VARIANT_FN})(${JSON.stringify(want || null)})`).catch(() => ({ found: false }));
}
