// Доставка курьером в тесте оформления: адрес с подсказками, квартира и получатель, дата и интервал доставки.
// Поля ищутся по подписи рядом (placeholder, label, плавающая надпись), даты и интервалы — по тексту
// («завтра», «23 октября», «10:00 – 18:00») среди радиокнопок, кнопок и карточек.
// Функции страницы передаются в page.evaluate как функции (не строки).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Подписи полей формы доставки → поле checkout.txt
export const COURIER_FIELDS = [
  { field: 'flat', re: /кв\.?\s*\/?\s*офис|квартир|^кв\.?$|^офис$/i },
  { field: 'entrance', re: /подъезд/i },
  { field: 'floor', re: /этаж/i },
  { field: 'intercom', re: /домофон/i },
  { field: 'courierComment', re: /комментар.*(курьер|адрес)|комментар/i },
  { field: 'recipient', re: /имя получателя|получател.*(имя|фио)|^фио$|^имя$|ваше имя|^имя и фамилия/i, not: /телефон|почт|mail/i },
  { field: 'recipientPhone', re: /телефон получателя/i },
];
const ADDRESS_RE = /адрес|улиц|город|address|street/i;
const NOT_ADDRESS_RE = /mail|почт|комментар|подъезд|этаж|квартир|домофон|поиск|search|промокод|сертификат/i;

// Пометить видимые поля ввода (data-ssa-f=номер) и вернуть их подписи
function markFieldsFn() {
  const vis = (e) => { const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden'; };
  const out = [];
  document.querySelectorAll('[data-ssa-f]').forEach((e) => e.removeAttribute('data-ssa-f'));
  for (const e of document.querySelectorAll('input, textarea')) {
    if (/^(hidden|radio|checkbox|submit|button|number|file|range|color)$/.test(e.type) || e.disabled || e.readOnly || !vis(e)) continue;
    if (e.closest('header, footer, [role=search]')) continue;
    const parts = [e.placeholder, e.getAttribute('aria-label'), e.name, e.id, ...[...(e.labels || [])].map((l) => l.innerText)];
    // Плавающая надпись рядом с полем: текст ближайшего маленького блока-обёртки
    for (let n = e.parentElement, up = 0; n && up < 3; n = n.parentElement, up++) {
      const t = (n.innerText || '').replace(e.value || '', '').trim();
      if (t && t.length <= 50 && n.querySelectorAll('input, textarea').length === 1) { parts.push(t); break; }
    }
    const i = out.length;
    e.setAttribute('data-ssa-f', String(i));
    const fixed = (() => { for (let n = e; n && n !== document.body; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.position === 'fixed' || n.getAttribute('role') === 'dialog' || n.getAttribute('aria-modal') === 'true') return true; } return false; })();
    out.push({ i, label: parts.filter(Boolean).join(' | ').replace(/\s+/g, ' ').slice(0, 200), value: e.value || '', tag: e.tagName.toLowerCase(), type: e.type, inModal: fixed });
  }
  return out;
}

export async function markFields(page) {
  return page.evaluate(markFieldsFn).catch(() => []);
}

export async function findAddressField(page) {
  const fields = await markFields(page);
  const f = fields.find((x) => ADDRESS_RE.test(x.label) && !NOT_ADDRESS_RE.test(x.label));
  return f ? { ...f, el: page.locator(`[data-ssa-f="${f.i}"]`) } : null;
}

// Слова адреса для сравнения с подсказками: улица и номер дома
const STOP = new Set(['г', 'город', 'ул', 'улица', 'д', 'дом', 'пр', 'пр-т', 'проспект', 'пер', 'переулок', 'ш', 'шоссе', 'наб', 'набережная', 'бульвар', 'б-р', 'пл', 'площадь', 'обл', 'область', 'россия', 'стр', 'корп', 'к']);
export function addressTokens(addr) {
  const words = addr.toLowerCase().replace(/ё/g, 'е').split(/[\s,.]+/).filter(Boolean);
  const house = [...words].reverse().find((w) => /\d/.test(w)) || '';
  const names = words.filter((w) => !STOP.has(w) && !/\d/.test(w) && w.length >= 3);
  return { house, names };
}

// Видимые элементы-подсказки, где есть слова адреса и номер дома
function suggestionsFn({ names, house, before }) {
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const norm = (t) => (t || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  const seen = new Set(before);
  const out = [];
  document.querySelectorAll('[data-ssa-sug]').forEach((e) => e.removeAttribute('data-ssa-sug'));
  for (const e of document.querySelectorAll('li, [role=option], div, span, a, button, p')) {
    if (e.closest('header, footer') || e.matches('input, textarea') || e.querySelector('input, textarea, select')) continue;
    const t = norm(e.innerText);
    if (!t || t.length > 160 || t.includes('\n') || seen.has(t) || !vis(e)) continue;
    // Самый глубокий элемент с этим текстом
    if ([...e.children].some((c) => norm(c.innerText) === t)) continue;
    const words = t.split(/[\s,.]+/);
    const nameHits = names.filter((w) => t.includes(w.slice(0, Math.max(4, w.length - 2)))).length;
    if (!nameHits || (house && !words.includes(house))) continue;
    out.push({ text: e.innerText.trim().replace(/\s+/g, ' '), t, nameHits, endsWithHouse: !!house && new RegExp('(^|[ ,])(д\\.? ?)?' + house.replace(/[^\wа-я]/gi, '') + '$').test(t) });
  }
  // Лучшая: все слова улицы, дом в конце («…, д 7», а не «…, д 7, помещ 1Н»), затем самая короткая
  out.sort((a, b) => (b.nameHits - a.nameHits) || (b.endsWithHouse - a.endsWithHouse) || (a.t.length - b.t.length));
  const uniq = [];
  for (const s of out) if (!uniq.some((u) => u.t === s.t)) uniq.push(s);
  uniq.slice(0, 8).forEach((s, i) => {
    const el = [...document.querySelectorAll('li, [role=option], div, span, a, button, p')].find((e) => norm(e.innerText) === s.t && ![...e.children].some((c) => norm(c.innerText) === s.t) && !e.hasAttribute('data-ssa-sug'));
    if (el) el.setAttribute('data-ssa-sug', String(i));
    s.i = i;
  });
  return uniq.slice(0, 8);
}

function textsNowFn() {
  const norm = (t) => (t || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  return [...document.querySelectorAll('li, [role=option], div, span, a, button, p')].map((e) => norm(e.innerText)).filter((t) => t && t.length <= 160);
}

// Ввод адреса как у человека: по буквам. Поле с подсказками может само подставить часть («г Москва») и
// увести курсор — тогда агент возвращает курсор в конец поля и продолжает ввод
export async function typeAddress(page, field, address, log = () => {}) {
  const el = field.el;
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ timeout: 5000 }).catch(() => el.focus());
  await el.fill('').catch(() => {});
  const before = await page.evaluate(textsNowFn).catch(() => []);
  let refocus = 0;
  let lastKey = Date.now();
  for (const ch of address) {
    const focused = await el.evaluate((e) => document.activeElement === e).catch(() => false);
    if (!focused) {
      refocus++;
      await el.focus().catch(() => {});
      await el.evaluate((e) => { try { e.setSelectionRange(e.value.length, e.value.length); } catch {} }).catch(() => {});
    }
    await page.keyboard.type(ch);
    lastKey = Date.now();
    await sleep(70);
  }
  if (refocus) log(`  Поле адреса само подставляло часть адреса (${refocus} раз) — ввод продолжен`);
  return { lastKey, before, value: await el.inputValue().catch(() => '') };
}

// Ждать подсказки адреса; вернуть список (лучшая — первая) и время их появления
export async function waitSuggestions(page, address, before, lastKey, timeout = 8000) {
  const { house, names } = addressTokens(address);
  const until = Date.now() + timeout;
  do {
    const list = await page.evaluate(suggestionsFn, { names, house, before }).catch(() => []);
    if (list.length) return { list, ms: Date.now() - lastKey };
    await sleep(150);
  } while (Date.now() < until);
  return { list: [], ms: null };
}

// Текст ошибки адреса на странице
export async function addressError(page) {
  return page.evaluate(() => {
    const re = /уточните адрес|укажите (полный |точный )?адрес|адрес не найден|не удалось определить адрес|дом не найден|введите номер дома|выберите адрес из (списка|подсказ)|доставка по этому адресу (недоступна|невозможна)/i;
    const el = [...document.querySelectorAll('body *')].find((e) => e.children.length === 0 && re.test(e.textContent || '') && e.getBoundingClientRect().height > 0);
    return el ? el.textContent.trim().slice(0, 100) : null;
  }).catch(() => null);
}

// Заполнить квартиру, подъезд, этаж, домофон, комментарий, получателя — только пустые поля
export async function fillCourierFields(page, sc, phone) {
  const fields = await markFields(page);
  const done = [];
  const used = new Set();
  const values = { flat: sc.flat, entrance: sc.entrance, floor: sc.floor, intercom: sc.intercom, courierComment: sc.courierComment, recipient: sc.recipient, recipientPhone: sc.recipientPhone || phone };
  for (const { field, re, not } of COURIER_FIELDS) {
    const v = values[field];
    if (!v) continue;
    // Поле адреса не подходит ни для чего, кроме комментария («Комментарий к адресу»)
    const cand = fields.filter((x) => !used.has(x.i) && re.test(x.label) && !(not && not.test(x.label)) && (field === 'courierComment' || !ADDRESS_RE.test(x.label)));
    const f = field === 'courierComment' ? cand.find((x) => /курьер|адрес/i.test(x.label)) || cand[0] : cand[0];
    if (!f) continue;
    used.add(f.i);
    if (f.value.trim()) { done.push(`${field}: уже заполнено`); continue; }
    const el = page.locator(`[data-ssa-f="${f.i}"]`);
    await el.click({ timeout: 3000 }).catch(() => {});
    // Поля с маской (телефон) принимают только посимвольный ввод
    await page.keyboard.type(String(field === 'recipientPhone' ? v.replace(/^\+?7|^8(?=\d{10}$)/, '') : v), { delay: 30 });
    done.push(field);
  }
  return done;
}

// ── Дата и интервал доставки ──
// Варианты — радиокнопки (подпись), кнопки и карточки с коротким текстом даты или времени; без цены («₽»),
// чтобы не перепутать со способами доставки («Курьером — завтра, 499 ₽»)
function dateTimeFn() {
  const DATE_RE = /^(сегодня|завтра|послезавтра)|^(пн|вт|ср|чт|пт|сб|вс)\b|^(понедельник|вторник|среда|четверг|пятница|суббота|воскресенье)|\b\d{1,2}[ .]+(янв|фев|мар|апр|ма[яй]|июн|июл|авг|сен|окт|ноя|дек)|\d{1,2}[.]\d{1,2}([.]\d{2,4})?$/i;
  const TIME_RE = /\d{1,2}[:.]\d{2}\s*[-–—]\s*\d{1,2}[:.]\d{2}|^с\s*\d{1,2}(:\d{2})?\s*до\s*\d{1,2}/i;
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const txt = (e) => (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' ');
  const selected = (e) => {
    const inp = e.matches('input') ? e : e.querySelector('input[type=radio]') || (e.htmlFor && document.getElementById(e.htmlFor));
    if (inp && inp.checked) return true;
    for (let n = e, up = 0; n && up < 3; n = n.parentElement, up++) {
      if (n.getAttribute('aria-checked') === 'true' || n.getAttribute('aria-pressed') === 'true' || n.getAttribute('aria-selected') === 'true') return true;
      if (/(^|[\s_-])(active|selected|checked|current|is-active|is-checked|is-selected)($|[\s_-])|--select(ed)?\b|_select(ed)?\b/i.test(typeof n.className === 'string' ? n.className : '')) return true;
    }
    return false;
  };
  const disabled = (e) => !!(e.disabled || e.getAttribute('aria-disabled') === 'true' || e.querySelector?.('input:disabled') || /disabled|unavailable|inactive/i.test(typeof e.className === 'string' ? e.className : ''));
  document.querySelectorAll('[data-ssa-dt]').forEach((e) => e.removeAttribute('data-ssa-dt'));
  const take = (re) => {
    const items = [];
    const push = (el, text) => {
      if (!text || text.length > 40 || /₽|руб/i.test(text) || !re.test(text) || el.closest('header, footer')) return;
      if (items.some((x) => x.el.contains(el) || el.contains(x.el))) return;
      items.push({ el, text });
    };
    // 1) радиокнопки с подписью
    for (const r of document.querySelectorAll('input[type=radio]')) {
      const lab = r.closest('label') || (r.id && document.querySelector(`label[for="${r.id}"]`)) || r.parentElement;
      if (lab && vis(lab)) push(lab, txt(lab));
    }
    // 2) кнопки, [role=radio], нажимаемые карточки
    if (!items.length) {
      for (const e of document.querySelectorAll('button, [role=radio], [role=option], [role=tab], li, label, div, span')) {
        if (!vis(e)) continue;
        const t = txt(e);
        if (!t || t.length > 40) continue;
        const clickable = e.matches('button, [role=radio], [role=option], [role=tab], label') || getComputedStyle(e).cursor === 'pointer';
        if (!clickable) continue;
        // Внешний нажимаемый элемент: если родитель — тоже нажимаемый с тем же текстом, берём родителя
        let el = e;
        while (el.parentElement && txt(el.parentElement) === t && (getComputedStyle(el.parentElement).cursor === 'pointer' || el.parentElement.matches('button, label, [role=radio]'))) el = el.parentElement;
        push(el, t);
      }
    }
    return items;
  };
  const out = {};
  for (const [kind, re] of [['date', DATE_RE], ['time', TIME_RE]]) {
    out[kind] = take(re).map((x, i) => {
      x.el.setAttribute('data-ssa-dt', `${kind}${i}`);
      return { id: `${kind}${i}`, text: x.text, selected: selected(x.el), disabled: disabled(x.el) };
    });
  }
  // Запасной список дат («Другая дата», «ещё даты»)
  out.selects = [...document.querySelectorAll('select')].filter((s) => [...s.options].some((o) => DATE_RE.test(o.text.trim()) || /\d{2}-\d{2}-\d{4}/.test(o.text))).map((s, i) => {
    s.setAttribute('data-ssa-dsel', String(i));
    return { i, options: [...s.options].map((o) => o.text.trim()) };
  });
  return out;
}

export async function dateTimeOptions(page) {
  return page.evaluate(dateTimeFn).catch(() => ({ date: [], time: [], selects: [] }));
}

const FIRST_RE = /^(первая|первый|первое|ближайш|авто|auto|-)?\s*(доступн\S*)?$/i;
const normTime = (t) => t.replace(/\D/g, '');
// Какой вариант выбрать: заданный текстом или первый доступный (уже выбранный на сайте — оставить)
export function pickOption(list, want, kind) {
  const live = list.filter((x) => !x.disabled);
  if (!want || FIRST_RE.test(want.trim())) {
    const sel = live.find((x) => x.selected);
    return sel ? { item: sel, kept: true } : live[0] ? { item: live[0] } : null;
  }
  const w = want.trim().toLowerCase().replace(/ё/g, 'е');
  const hit = kind === 'time'
    ? live.find((x) => normTime(x.text).startsWith(normTime(w)) || normTime(x.text) === normTime(w))
    : live.find((x) => x.text.toLowerCase().replace(/ё/g, 'е').includes(w));
  return hit ? { item: hit, kept: hit.selected } : { missing: true };
}
