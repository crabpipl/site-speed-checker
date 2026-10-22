// Настройки теста оформления заказа — файл checkout.txt.
// Секция [сайт] — один сценарий: товар, вход, способ получения и оплаты, тексты кнопок.
// Действия перечисляются через «;»: видимый текст кнопки или CSS-селектор с приставкой «css:».
// Если в списке несколько вариантов, нажимается первый найденный на странице.
import { readFileSync } from 'node:fs';
import { AUTO, MORE_TEXTS, AUTO_LABEL } from './checkout-auto.js';

// ключ в файле → [поле, вид значения]
const KEYS = {
  'товар': ['products', 'urls'],
  'разрешение': ['device', 'device'],
  'вход': ['login', 'login'],
  'телефон': ['phone', 'phone'],
  'почта': ['email', 'email'],
  'открыть вход': ['openLogin', 'actions'],
  'вход по телефону': ['byPhone', 'actions'],
  'вход по почте': ['byEmail', 'actions'],
  'получить код': ['sendCode', 'actions'],
  'поле кода': ['codeField', 'actions'],
  'подтвердить код': ['submitCode', 'actions'],
  'код повторно': ['resendCode', 'actions'],
  'адрес корзины': ['cartUrl', 'url'],
  'пустая корзина': ['emptyCart', 'text'],
  'в корзину': ['addToCart', 'actions'],
  'перейти в корзину': ['toCart', 'actions'],
  'к оформлению': ['toCheckout', 'actions'],
  'получение': ['delivery', 'actions'],
  'показать магазины': ['storeList', 'actions'],
  'магазин': ['store', 'actions'],
  'подтвердить магазин': ['storeConfirm', 'actions'],
  'оплата': ['payment', 'actions'],
  'перед оформлением': ['beforeOrder', 'actions'],
  'оформить': ['placeOrder', 'actions'],
  'признак заказа': ['success', 'text'],
  'выход': ['logout', 'actions'],
  'закрывать': ['dismiss', 'actions'],
  'удалять другие товары': ['cleanCart', 'yesno'],
  'обновлять карточку': ['reloadProduct', 'yesno'],
  'меню товара': ['itemMenu', 'actions'],
  'удалить товар': ['removeItem', 'actions'],
  'подтвердить удаление': ['removeConfirm', 'actions'],
  'адрес профиля': ['profileUrl', 'url'],
  'вариант': ['variant', 'variant'],
  // Тип покупки на карточке (несколько цен: обычная, специальная, партнёра): текст или цена карточки; нет — не выбирать
  'тип покупки': ['purchaseType', 'text'],
  // Доставка курьером (обычно — в отдельной секции [сайт: курьер])
  'адрес доставки': ['address', 'text'],
  'квартира': ['flat', 'text'],
  'подъезд': ['entrance', 'text'],
  'этаж': ['floor', 'text'],
  'домофон': ['intercom', 'text'],
  'комментарий курьеру': ['courierComment', 'text'],
  'получатель': ['recipient', 'text'],
  'телефон получателя': ['recipientPhone', 'text'],
  'дата доставки': ['deliveryDate', 'text'],
  'интервал': ['deliveryTime', 'text'],
  'подтвердить адрес': ['addressConfirm', 'actions'],
  'основа': ['base', 'base'],
};

// Значения по умолчанию — типовые тексты кнопок интернет-магазинов
export const DEFAULTS = {
  device: 'mobile',
  openLogin: ['Войти или зарегистрироваться', 'Войти', 'Вход', 'Профиль', 'Личный кабинет'],
  byPhone: ['Войти по номеру телефона', 'По номеру телефона', 'По телефону', 'Войти по телефону'],
  byEmail: ['Войти по почте', 'По почте', 'По e-mail', 'Войти по e-mail', 'Войти по email'],
  sendCode: ['Получить код', 'Отправить код', 'Войти', 'Продолжить', 'Далее'],
  submitCode: ['Подтвердить', 'Войти', 'Продолжить', 'Далее'],
  resendCode: ['Отправить код повторно', 'Отправить ещё раз', 'Получить новый код', 'Запросить код повторно', 'Выслать код повторно'],
  emptyCart: 'корзина пуста|в корзине нет товаров|в корзине пока нет|ваша корзина пуста',
  addToCart: ['Добавить в корзину', 'В корзину', 'Купить'],
  toCart: ['Оформить', 'Перейти в корзину', 'В корзине', 'Корзина'],
  toCheckout: ['Продолжить', 'Перейти к оформлению', 'К оформлению', 'Оформить', 'Оформить заказ'],
  placeOrder: ['Оформить заказ', 'Подтвердить заказ', 'Заказать', 'Оплатить'],
  success: 'заказ\\s*(№|номер|оформлен|принят|создан)|номер заказа|спасибо за заказ',
  logout: ['Выйти', 'Выход', 'Выйти из аккаунта', 'Выйти из профиля'],
  cleanCart: true,
  // Карточка товара: первый заход, затем обновление страницы — товар кладётся в корзину с прогретым кэшем
  reloadProduct: true,
  // Удаление товара из корзины: кнопка «Удалить» в карточке товара, при необходимости — через меню «⋮», затем подтверждение
  itemMenu: ['css: [aria-label="Действия"]', 'css: [aria-label="Ещё"]', 'css: [aria-label="Меню"]', 'css: [aria-label="Еще"]'],
  // Кнопки удаления из избранного (favorite, wish) — не удаление из корзины; иконка-мусорка без подписи — по классу или ссылке иконки
  removeItem: ['css: [aria-label="Удалить"]', 'css: [aria-label="Удалить товар"]', 'css: [title="Удалить"]',
    'css: button[class*="remove"]:not([class*="favorite" i]):not([class*="wish" i])', 'css: [class*="remove"]:not([class*="favorite" i]):not([class*="wish" i]) > button',
    'css: button[class*="delete"]:not([class*="favorite" i])',
    'css: button:has(svg[class*="trash" i]), button:has(svg[class*="delete" i]), button:has(svg[class*="remove" i]:not([class*="favorite" i])), button:has(use[href*="trash" i]), button:has(use[href*="delete" i])',
    'css: button:has(svg[class*="icon-basket" i]), button:has(use[href*="icon-basket" i])',
    'Удалить', 'Удалить товар'],
  removeConfirm: ['Удалить', 'Да, удалить', 'Да', 'Подтвердить'],
};

const toAction = (x) => (/^css\s*:/i.test(x) ? { css: x.replace(/^css\s*:/i, '').trim() } : { text: x });

export function loadCheckout(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return { sites: {}, warnings: [], missing: true }; }
  const sites = {};
  const warnings = [];
  let cur = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      const site = siteName(sec[1]);
      // Повторная секция того же сайта дополняет первую
      cur = sites[site] ??= { site, line: i + 1 };
      return;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    const where = `checkout.txt, строка ${i + 1}`;
    if (!cur || !kv) {
      warnings.push(`${where}: «${line}» — ${cur ? 'нужен формат «ключ = значение»' : 'сначала укажите сайт в квадратных скобках, например [shop.example.com]'}`);
      return;
    }
    const key = kv[1].trim().toLowerCase().replace(/ё/g, 'е');
    const val = kv[2].trim();
    const def = KEYS[key];
    if (!def) {
      warnings.push(`${where}: неизвестный ключ «${kv[1].trim()}» (можно: ${Object.keys(KEYS).join(', ')})`);
      return;
    }
    const [field, kind] = def;
    if (kind === 'urls') {
      // Несколько товаров: «товар = адрес1; адрес2» или несколько строк «товар = …»
      for (const u of val.split(/[;\s]+/).filter(Boolean)) {
        try { (cur.products ??= []).push(new URL(u).href); } catch { warnings.push(`${where}: «${u}» — нужен полный адрес товара с https://`); }
      }
    } else if (kind === 'yesno') {
      if (/^(да|yes|1|вкл)$/i.test(val)) cur[field] = true;
      else if (/^(нет|no|0|выкл)$/i.test(val)) cur[field] = false;
      else warnings.push(`${where}: значение — «да» или «нет»`);
    } else if (kind === 'url') {
      try { cur[field] = new URL(val).href; } catch { warnings.push(`${where}: «${val}» — нужен полный адрес с https://`); }
    } else if (kind === 'device') {
      if (/^(моб|mobile|смартфон|телефон)/i.test(val)) cur.device = 'mobile';
      else if (/^(деск|desktop|компьютер|пк)/i.test(val)) cur.device = 'desktop';
      else warnings.push(`${where}: разрешение — «мобильный» или «десктоп»`);
    } else if (kind === 'login') {
      if (/^(тел|phone)/i.test(val)) cur.login = 'phone';
      else if (/^(почт|e-?mail|email)/i.test(val)) cur.login = 'email';
      else if (/^(спрашивать|выбор|-)?$/i.test(val)) cur.login = 'ask';
      else warnings.push(`${where}: вход — «телефон», «почта» или «спрашивать»`);
    } else if (kind === 'phone') {
      // 10 цифр без кода страны (9001234567); +7 или 8 в начале тоже подходят
      const d = val.replace(/\D/g, '');
      if (d.length === 10) cur.phone = d;
      else if (d.length === 11 && /^[78]/.test(d)) cur.phone = d.slice(1);
      else if (val) warnings.push(`${where}: телефон — 10 цифр без кода страны, например 9001234567`);
    } else if (kind === 'email') {
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(val)) cur.email = val;
      else if (val) warnings.push(`${where}: почта — адрес вида name@example.com`);
    } else if (kind === 'base') {
      // основа = другой сайт из этого файла: его настройки берутся целиком, здесь — только отличия
      if (cur.site === '*') warnings.push(`${where}: в общей секции «основа» не нужна — она и так действует на все сайты`);
      else cur.base = siteName(val);
    } else if (kind === 'variant') {
      // авто — первый доступный размер/вариант; нет — не выбирать; иначе — значения через «;» (42; Чёрный)
      if (/^(авто|auto|-)?$/i.test(val)) cur.variant = 'auto';
      else if (/^(нет|no|выкл)$/i.test(val)) cur.variant = 'none';
      else cur.variant = val.split(';').map((x) => x.trim()).filter(Boolean);
    } else if (kind === 'text') {
      cur[field] = val;
    } else {
      cur[field] = val.split(';').map((x) => x.trim()).filter(Boolean).map(toAction);
    }
  });
  inherit(sites, warnings);
  for (const s of Object.values(sites)) {
    s.product = s.products?.[0];
    if (!s.product) warnings.push(`checkout.txt, [${s.site}]: не указан «товар = адрес карточки товара»`);
    if (!s.delivery) warnings.push(`checkout.txt, [${s.site}]: не указано «получение = …» (текст способа получения, как на сайте)`);
    if (!s.payment) warnings.push(`checkout.txt, [${s.site}]: не указано «оплата = …» (текст способа оплаты, как на сайте)`);
  }
  return { sites, warnings };
}

// Имя секции: домен без https:// и www.; [*] или [все сайты] — общая секция для всех сайтов.
// [домен: сценарий] — другой сценарий того же сайта (например [shop.example.com: курьер])
const GLOBAL_NAMES = /^(\*|все сайты|все|общие|общее)$/i;
export function siteName(x) {
  const t = x.trim().toLowerCase();
  if (GLOBAL_NAMES.test(t)) return '*';
  const m = /^([^:\s]+(?::\d+)?)\s*:\s*(\S.*)$/.exec(t.replace(/^https?:\/\//, ''));
  const [host, scen] = m && !/^\d+$/.test(m[2]) ? [m[1], m[2].replace(/\s+/g, ' ')] : [t.replace(/^https?:\/\//, ''), ''];
  const dom = host.replace(/^www\./, '').replace(/\/.*$/, '');
  return scen ? `${dom}: ${scen}` : dom;
}
// Домен секции без сценария: «shop.example.com: курьер» → «shop.example.com»
export const domainOf = (name) => name.split(': ')[0];

// Шаблоны: общая секция [все сайты] → секция из «основа = …» → строки самого сайта (последние важнее).
// Адреса (товар, корзина, профиль) у каждого сайта свои и не наследуются.
const OWN_ONLY = new Set(['site', 'line', 'products', 'product', 'cartUrl', 'profileUrl', 'base', 'inherited']);
function inherit(sites, warnings) {
  const global = sites['*'];
  delete sites['*'];
  const own = Object.fromEntries(Object.entries(sites).map(([k, v]) => [k, { ...v }]));
  const done = new Map();
  const resolve = (name, chain) => {
    if (done.has(name)) return done.get(name);
    const s = own[name];
    const out = {};
    const from = {};
    const take = (src, label) => {
      for (const [k, v] of Object.entries(src || {})) if (!OWN_ONLY.has(k) && v != null) { out[k] = v; from[k] = label; }
    };
    if (global) take(global, 'все сайты');
    // Сценарий того же сайта ([сайт: курьер]) без своей «основы» берёт настройки секции [сайт]
    if (!s.base && name !== domainOf(name) && own[domainOf(name)]) s.base = domainOf(name);
    if (s.base) {
      if (chain.includes(s.base)) warnings.push(`checkout.txt, [${name}]: «основа = ${s.base}» — по кругу (${[...chain, name, s.base].join(' → ')}), основа не применена`);
      else if (!own[s.base]) warnings.push(`checkout.txt, [${name}]: «основа = ${s.base}» — такого сайта нет в файле`);
      else {
        const b = resolve(s.base, [...chain, name]);
        take(b, s.base);
        // У сценария того же сайта товар и адреса корзины/профиля — общие с основной секцией
        if (domainOf(s.base) === domainOf(name)) for (const k of ['products', 'cartUrl', 'profileUrl']) if (b[k] != null) { out[k] = b[k]; from[k] = s.base; }
      }
    }
    for (const [k, v] of Object.entries(s)) { out[k] = v; delete from[k]; }
    out.inherited = from; // поле → откуда взято (для сообщений)
    done.set(name, out);
    return out;
  };
  for (const name of Object.keys(sites)) sites[name] = resolve(name, []);
}

// Поля, где после вариантов из checkout.txt агент пробует и типовые тексты, и автоматический поиск иконок —
// так сайт подключается без настройки, а неверная строка в checkout.txt не ломает шаг
const FLEX = ['openLogin', 'byPhone', 'byEmail', 'sendCode', 'submitCode', 'addToCart', 'toCart', 'toCheckout', 'logout'];
const keyOfAction = (a) => a.auto ? `auto:${a.auto}` : a.css ? `css:${a.css}` : `text:${a.text.toLowerCase()}`;

// Сценарий с подставленными значениями по умолчанию
export function scenarioOf(s) {
  const out = { ...s };
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (out[k] == null) out[k] = Array.isArray(v) ? v.map(toAction) : v;
  }
  for (const k of FLEX) {
    const list = [...(out[k] || []), ...(DEFAULTS[k] || []).map(toAction), ...(MORE_TEXTS[k] || []).map(toAction),
      ...(AUTO[k] || []).map((x) => (typeof x === 'string' ? toAction(x) : x))];
    const seen = new Set();
    out[k] = list.filter((a) => { const key = keyOfAction(a); if (seen.has(key)) return false; seen.add(key); return true; });
  }
  out.login ??= 'ask';
  out.variant ??= 'auto';
  return out;
}

// Для сообщений — только тексты и селекторы из настроек и типовые тексты (без длинного хвоста автоматических вариантов)
export const actionText = (list) => (list || []).filter((a) => !a.auto && !(a.css && /^:is\(a, button/.test(a.css))).slice(0, 6)
  .map((a) => a.text ?? `css: ${a.css}`).join(' / ');
export const actionLabel = (a) => a.auto ? AUTO_LABEL[a.auto] : a.text ?? `css: ${a.css}`;
// Обратная таблица: поле сценария → ключ в checkout.txt (для подсказок «впишите в checkout.txt …»)
export const KEY_OF = Object.fromEntries(Object.entries(KEYS).map(([k, [f]]) => [f, k]));
