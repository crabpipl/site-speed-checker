// Настройки теста отклика по сайтам — файл actions.txt (необязательный).
// Секция [сайт] задаёт, что нажимать на каталоге, карточке товара и других страницах, слово для поиска
// и (если автоматика ошибается) по каким адресам страница считается каталогом или карточкой.
import { readFileSync } from 'node:fs';

const TYPE_KEYS = { 'каталог': 'catalog', 'карточка': 'product', 'другие': 'other' };

export function loadActions(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return { sites: {}, warnings: [] }; }
  const sites = {};
  const warnings = [];
  let cur = null;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      const site = sec[1].trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
      cur = sites[site] ??= { actionsByType: {}, typeByUrl: [] };
      return;
    }
    const kv = /^([^=]+)=(.*)$/.exec(line);
    if (!cur || !kv) {
      warnings.push(`actions.txt, строка ${i + 1}: «${line}» — ${cur ? 'нужен формат «ключ = значение»' : 'сначала укажите сайт в квадратных скобках, например [site.ru]'}`);
      return;
    }
    const key = kv[1].trim().toLowerCase();
    const items = kv[2].split(/[;|]/).map((x) => x.trim()).filter(Boolean);
    if (TYPE_KEYS[key]) {
      cur.actionsByType[TYPE_KEYS[key]] = items.map((x) => (/^css\s*:/i.test(x) ? { css: x.replace(/^css\s*:/i, '').trim() } : { text: x }));
    } else if (key === 'поиск') {
      cur.search = /^(нет|no|off|-)$/i.test(items[0] || '') ? false : items[0];
    } else if (key === 'адреса каталога' || key === 'адреса карточки') {
      for (const frag of kv[2].split(/[;,|]/).map((x) => x.trim()).filter(Boolean)) {
        cur.typeByUrl.push({ frag, type: key === 'адреса каталога' ? 'catalog' : 'product' });
      }
    } else {
      warnings.push(`actions.txt, строка ${i + 1}: неизвестный ключ «${kv[1].trim()}» (можно: каталог, карточка, другие, поиск, адреса каталога, адреса карточки)`);
    }
  });
  return { sites, warnings };
}

// Настройки для конкретной страницы: тип по адресу (если задан), действия по типам, слово для поиска
export function actionsFor(config, url) {
  const u = new URL(url);
  const s = config.sites[u.hostname.replace(/^www\./, '')];
  if (!s) return {};
  const path = u.pathname + u.search;
  const byUrl = s.typeByUrl.find((t) => path.includes(t.frag));
  const cfg = { actionsByType: s.actionsByType };
  if (byUrl) cfg.type = byUrl.type;
  if (s.search !== undefined) cfg.search = s.search;
  return cfg;
}
