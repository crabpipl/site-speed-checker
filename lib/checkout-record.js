// Запись сценария теста оформления: человек один раз проходит путь в открытом браузере,
// агент по шагам запоминает нажатия (текст кнопки, подпись, ссылку или класс) и адрес товара
// и сохраняет секцию сайта в checkout.txt. Что человек вводит в поля (телефон, код) — не записывается.
// На шаге «Оформить заказ» нажатие перехватывается: кнопка запоминается, но до сайта нажатие не доходит.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

// Шаги записи по порядку оформления; key — строка в checkout.txt
export const STAGES = [
  { key: 'открыть вход', title: 'Вход в аккаунт', optional: true,
    hint: 'Нажмите на сайте кнопку или иконку входа (и, если есть, «Войти по телефону»). Телефон и код вводить не нужно — после этого закройте форму входа.' },
  { key: 'товар', title: 'Товар', url: true,
    hint: 'Откройте карточку товара, который будете заказывать при тесте (недорогой, в наличии). Нажатия на этом шаге не записываются — запомнится адрес страницы.' },
  { key: 'вариант', title: 'Размер / цвет', optional: true, firstLine: true,
    hint: 'Если у товара есть размер, цвет или объём — выберите его. Если вариантов нет — просто нажмите Enter.' },
  { key: 'в корзину', title: 'Добавление в корзину',
    hint: 'Нажмите «В корзину» / «Купить».' },
  { key: 'перейти в корзину', title: 'Переход в корзину', cart: true,
    hint: 'Перейдите в корзину: кнопкой в окне «Товар добавлен» или иконкой корзины. Адрес корзины тоже запомнится.' },
  { key: 'к оформлению', title: 'К оформлению',
    hint: 'Нажмите кнопку перехода к оформлению заказа.' },
  { key: 'получение', title: 'Способ получения',
    hint: 'Выберите способ получения (например, самовывоз из магазина).' },
  { key: 'показать магазины', title: 'Список магазинов', optional: true,
    hint: 'Если магазины показаны на карте, нажмите переключатель «Списком». Если такого нет — Enter.' },
  { key: 'магазин', title: 'Магазин или пункт выдачи', optional: true, firstLine: true,
    hint: 'Нажмите на нужный магазин или пункт выдачи в списке (запомнится его название).' },
  { key: 'подтвердить магазин', title: 'Подтверждение магазина', optional: true,
    hint: 'Нажмите кнопку выбора магазина («Забрать здесь», «Выбрать»).' },
  { key: 'оплата', title: 'Способ оплаты',
    hint: 'Выберите способ оплаты (например, «При получении»).' },
  { key: 'оформить', title: 'Кнопка оформления заказа', block: true,
    hint: 'Нажмите кнопку оформления заказа. Нажатие НЕ дойдёт до сайта — заказ не создастся, агент только запомнит кнопку.' },
];

// Скрипт на странице: на каждое нажатие — описание элемента для checkout.txt.
// Когда window.__ssaBlock = true, нажатия перехватываются и до сайта не доходят.
const RECORDER_INIT = `(() => {
  if (window.top !== window || window.__ssaRecInit) return;
  window.__ssaRecInit = true;
  const CLICK = 'button, a, [role=button], [role=radio], [role=tab], [role=option], [role=checkbox], label, li, summary, [onclick], input[type=submit], input[type=button], input[type=radio], input[type=checkbox]';
  const esc = (s) => s.replace(/"/g, '\\\\"');
  const first = (el) => (((el.innerText || el.value || '').trim().split(String.fromCharCode(10))[0]) || '').trim();
  const describe = (raw) => {
    let el = raw.closest(CLICK) || raw;
    // Нажатие на радиокнопку/флажок — описываем по подписи
    if (el.matches('input[type=radio], input[type=checkbox]')) el = el.closest('label') || (el.id && document.querySelector('label[for="' + el.id + '"]')) || el;
    // Элемент без текста и признаков (картинка, иконка) — описываем ближайшего родителя, у которого они есть
    const bare = (x) => !first(x) && !x.getAttribute('aria-label') && !x.getAttribute('data-testid') && !x.getAttribute('href') && !(typeof x.className === 'string' && x.className.trim()) && !(x.tagName === 'IMG' && x.getAttribute('alt'));
    for (let up = 0; bare(el) && el.parentElement && el.parentElement !== document.body && up < 4; up++) el = el.parentElement;
    const alt = el.tagName === 'IMG' ? (el.getAttribute('alt') || '').trim() : '';
    const text = first(el), aria = el.getAttribute('aria-label') || '', testid = el.getAttribute('data-testid') || '';
    const href = el.getAttribute('href') || '', cls = typeof el.className === 'string' ? el.className.trim() : '';
    const same = (t) => [...document.querySelectorAll(CLICK)].filter((x) => first(x) === t).length;
    let line = '';
    if (text && text.length <= 40 && (same(text) <= 1 || (!testid && !aria))) line = text;
    else if (testid) line = 'css: [data-testid="' + esc(testid) + '"]';
    else if (aria) line = 'css: [aria-label="' + esc(aria) + '"]';
    else if (text && text.length <= 40) line = text;
    else if (href && href !== '#' && !/^javascript/i.test(href)) line = 'css: a[href="' + esc(href) + '"]';
    else if (alt) line = 'css: img[alt="' + esc(alt) + '"]';
    else if (cls) {
      const sel = el.tagName.toLowerCase() + '.' + cls.split(/[ ]+/).filter(Boolean).slice(0, 2).join('.');
      line = 'css: ' + sel;
    } else line = '';
    const what = text ? '«' + text.slice(0, 50) + '»' : alt ? 'картинка «' + alt.slice(0, 40) + '»' : aria ? 'подпись «' + aria.slice(0, 40) + '»' : href ? 'ссылка ' + href.slice(0, 50) : '<' + el.tagName.toLowerCase() + (cls ? '.' + cls.split(/[ ]+/)[0] : '') + '>';
    // Окна региона и cookies и кнопки закрытия — не шаги сценария: при тесте агент закрывает такие окна сам
    let popup = /закрыть|close/i.test(aria + ' ' + cls) || /^[×✕✖]$/.test(text);
    for (let n = el, up = 0; n && up < 6 && !popup; n = n.parentElement, up++) {
      const t = (n.innerText || '').slice(0, 400);
      if (t.length < 400 && /ваш (регион|город)|это ваш город|cookie|куки/i.test(t)) popup = true;
    }
    return { line, what, popup, text: text.slice(0, 60), field: !!raw.closest('input:not([type=radio]):not([type=checkbox]):not([type=submit]):not([type=button]), textarea, select') };
  };
  const stop = (e) => { if (window.__ssaBlock) { e.preventDefault(); e.stopImmediatePropagation(); } };
  for (const t of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'touchstart', 'touchend', 'submit']) document.addEventListener(t, stop, true);
  document.addEventListener('click', (e) => {
    const d = describe(e.target);
    stop(e);
    if (window.__ssaRec) window.__ssaRec({ ...d, url: location.href, blocked: !!window.__ssaBlock });
  }, true);
})();`;

// Запись: открывает видимый браузер, ведёт человека по шагам в Терминале, возвращает записанные значения
export async function runRecord({ browser, profile, startUrl, prompt, log, color = (c, s) => s, onPage }) {
  const context = await browser.newContext({ ...profile.device, locale: 'ru-RU' });
  let stage = null;
  let block = false;
  await context.exposeBinding('__ssaRec', (_src, d) => {
    if (!stage || stage.url) return;
    // Нажатие в поле ввода (телефон, код, поиск) — это не действие сценария
    if (d.field) return;
    if (!d.line) { log(color('33', `  · ${d.what} — у элемента нет текста, подписи или класса, не записываю. Нажмите на саму кнопку (её текст) или удалите нажатие и пропустите шаг`)); return; }
    if (d.popup && !stage.block) { log(color('90', `  · ${d.what} — окно закрыто, не записываю (при тесте агент закрывает такие окна сам)`)); return; }
    const value = stage.firstLine && d.text ? d.text : d.line;
    if (stage.items.at(-1) === value) return;
    stage.items.push(value);
    log(color('32', `  ✓ записано: ${d.what}${d.blocked ? ' — нажатие перехвачено, заказ не создан' : ''}`));
  });
  await context.addInitScript(RECORDER_INIT);
  // Вторая защита на шаге «Оформить заказ»: любые отправки данных на сайт (не GET) отменяются,
  // даже если сайт обработает нажатие по-своему, — заказ создаться не может
  let blockedPosts = 0;
  await context.route('**/*', (route) => {
    if (block && route.request().method() !== 'GET') { blockedPosts++; return route.abort(); }
    return route.fallback();
  });
  const page = await context.newPage();
  onPage?.(page);
  const setBlock = () => page.evaluate((b) => { window.__ssaBlock = b; }, block).catch(() => {});
  page.on('domcontentloaded', setBlock);

  const result = { stages: [], cartUrl: null, product: null };
  try {
    log(`Открываю ${startUrl} …`);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    log(color('36', 'Окна выбора региона, cookies и промо закрывайте как обычно — агент при тесте закрывает их сам, записывать их не нужно.'));
    for (const [i, st] of STAGES.entries()) {
      stage = { ...st, items: [] };
      block = !!st.block;
      await setBlock();
      log(`\n${color('1', `Шаг ${i + 1} из ${STAGES.length}: ${st.title}${st.optional ? ' (можно пропустить)' : ''}`)}\n  ${st.hint}`);
      for (;;) {
        const a = (await prompt.ask('  Enter — дальше · «у» — удалить последнее нажатие · «п» — пропустить шаг: ')).trim().toLowerCase();
        if (/^(у|u|удалить)$/.test(a)) {
          const gone = stage.items.pop();
          log(gone ? `  удалено: ${gone}` : '  на этом шаге ещё ничего не записано');
          continue;
        }
        if (/^(п|p|пропустить)$/.test(a)) { stage.items = []; stage.skipped = true; break; }
        if (st.url) {
          const u = page.url();
          if (!/^https?:/.test(u)) { log('  Откройте страницу товара в окне браузера, затем нажмите Enter'); continue; }
          stage.items = [u];
          result.product = u;
          log(color('32', `  ✓ товар: ${u}`));
        }
        if (!st.url && !st.optional && !stage.items.length) {
          const b = (await prompt.ask('  На этом шаге ничего не записано. Пропустить его? (д/Н): ')).trim().toLowerCase();
          if (!/^(д|y|да)/.test(b)) continue;
        }
        if (st.cart && stage.items.length) {
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          result.cartUrl = page.url();
          log(color('32', `  ✓ адрес корзины: ${result.cartUrl}`));
        }
        break;
      }
      if (st.block && blockedPosts) log(`  (агент отменил отправку данных на сайт: ${blockedPosts} — заказ не создан)`);
      result.stages.push(stage);
      stage = null;
    }
  } finally {
    block = false;
    await context.close().catch(() => {});
  }
  return result;
}

// Текст секции для checkout.txt из записи
export function sectionText(site, rec, deviceKey) {
  const lines = [`[${site}]`, `# записано ${new Date().toLocaleString('ru-RU')} (npm run audit:checkout -- --record)`];
  if (rec.product) lines.push(`товар = ${rec.product}`);
  lines.push(`разрешение = ${deviceKey === 'desktop' ? 'десктоп' : 'мобильный'}`);
  if (rec.cartUrl) lines.push(`адрес корзины = ${rec.cartUrl}`);
  for (const st of rec.stages) {
    if (st.url || !st.items.length) continue;
    lines.push(`${st.key} = ${st.items.join('; ')}`);
  }
  return lines.join('\n') + '\n';
}

// Записать секцию в checkout.txt: заменить существующую секцию сайта или добавить в конец (с копией прежнего файла).
// При замене строки, которых запись не касается (телефон, вход, основа …), остаются.
export function saveSection(path, site, text) {
  let src = existsSync(path) ? readFileSync(path, 'utf8') : '';
  let replaced = false;
  if (src) {
    copyFileSync(path, path + '.bak');
    const lines = src.split(/\r?\n/);
    const norm = (x) => x.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
    const start = lines.findIndex((l) => /^\[(.+)\]\s*$/.test(l.trim()) && norm(l.trim().slice(1, -1)) === site);
    if (start >= 0) {
      let end = lines.findIndex((l, i) => i > start && /^\[(.+)\]\s*$/.test(l.trim()));
      if (end < 0) end = lines.length;
      // Строки, которые запись не создаёт (телефон, вход, основа и др.), переносятся из прежней секции
      const own = new Set(['товар', 'разрешение', 'адрес корзины', ...STAGES.map((s) => s.key)]);
      const keep = lines.slice(start + 1, end).filter((l) => { const m = l.match(/^\s*([^#=][^=]*?)\s*=/); return m && !own.has(m[1].trim().toLowerCase()); });
      lines.splice(start, end - start, ...text.trimEnd().split('\n'), ...(keep.length ? ['# из прежней секции:', ...keep] : []), '');
      src = lines.join('\n');
      replaced = true;
    } else src = src.replace(/\s*$/, '\n\n') + text;
  } else src = text;
  writeFileSync(path, src);
  return { replaced, backup: existsSync(path + '.bak') ? path + '.bak' : null };
}
