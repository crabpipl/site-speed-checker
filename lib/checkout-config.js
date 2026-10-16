// Настройки теста оформления заказа — файл checkout.txt.
// Секция [сайт] — один сценарий: товар, вход, способ получения и оплаты, тексты кнопок.
// Действия перечисляются через «;»: видимый текст кнопки или CSS-селектор с приставкой «css:».
// Если в списке несколько вариантов, нажимается первый найденный на странице.
import { readFileSync } from 'node:fs';

// ключ в файле → [поле, вид значения]
const KEYS = {
  'товар': ['product', 'url'],
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
  'адрес профиля': ['profileUrl', 'url'],
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
      const site = sec[1].trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      cur = sites[site] = { site, line: i + 1 };
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
    if (kind === 'url') {
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
    } else if (kind === 'text') {
      cur[field] = val;
    } else {
      cur[field] = val.split(';').map((x) => x.trim()).filter(Boolean).map(toAction);
    }
  });
  for (const s of Object.values(sites)) {
    if (!s.product) warnings.push(`checkout.txt, [${s.site}]: не указан «товар = адрес карточки товара»`);
    if (!s.delivery) warnings.push(`checkout.txt, [${s.site}]: не указано «получение = …» (текст способа получения, как на сайте)`);
    if (!s.payment) warnings.push(`checkout.txt, [${s.site}]: не указано «оплата = …» (текст способа оплаты, как на сайте)`);
  }
  return { sites, warnings };
}

// Сценарий с подставленными значениями по умолчанию
export function scenarioOf(s) {
  const out = { ...s };
  for (const [k, v] of Object.entries(DEFAULTS)) {
    if (out[k] == null) out[k] = Array.isArray(v) ? v.map(toAction) : v;
  }
  out.login ??= 'ask';
  return out;
}

export const actionText = (list) => (list || []).map((a) => a.text ?? `css: ${a.css}`).join(' / ');
