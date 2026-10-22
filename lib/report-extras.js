// Разделы отчёта по углублённой аналитике: тест без внешних сервисов, разбор LCP, сервер,
// неиспользуемый код, картинки, сдвиги вёрстки, шрифты/DOM, SEO, сравнение с прошлой проверкой.
import { fmtMs, kb, shortUrl } from './analyze.js';
import { LCP_PART, lcpChangedText } from './extras.js';
import { fieldGrade, FIELD_THRESHOLDS } from './crux.js';
import { BUDGET_KEYS, fmtBudget } from './budgets.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const LVL = { bad: ['bad', 'Критично'], warn: ['warn', 'Внимание'], info: ['info', 'Инфо'], ok: ['good', 'ОК'] };

export const EXTRA_CSS = `
.stack{display:flex;height:26px;border-radius:6px;overflow:hidden;margin:8px 0 6px;min-width:0}
.stack>div{display:flex;align-items:center;justify-content:center;font-size:11px;color:#fff;white-space:nowrap;overflow:hidden;min-width:2px}
.s1{background:#7a6cd6}.s2{background:#e08a00}.s3{background:#2f8f6a}.s4{background:#c2477a}.s5{background:#5b8fd6}.s6{background:#9a9a92}
.stack-legend{display:flex;flex-wrap:wrap;gap:6px 16px;font-size:12.5px;margin-bottom:6px}.stack-legend i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;vertical-align:-1px}
.d-good{color:var(--good);font-weight:600}.d-bad{color:var(--bad);font-weight:600}.d-none{color:var(--muted)}
.delta{display:block;font-size:11px}
.bar{height:8px;border-radius:4px;background:var(--line);overflow:hidden;min-width:60px}.bar>i{display:block;height:100%;background:var(--bad)}
.grid2{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
.dist{display:flex;height:10px;border-radius:5px;overflow:hidden;min-width:140px;margin:3px 0 2px}.dist>i{display:block;height:100%}
.dist .g{background:var(--good)}.dist .n{background:var(--slow)}.dist .p{background:var(--bad)}
.film{display:flex;flex-wrap:wrap;gap:10px 6px;padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.film figure{margin:0;flex:0 0 auto;text-align:center;font-size:11px;color:var(--muted)}
.film img{display:block;width:var(--fw);border:1px solid var(--line);border-radius:4px;background:#fff}
.film figure.lcp img{outline:3px solid var(--good);outline-offset:-1px}.film figure.fcp img{outline:2px solid var(--info);outline-offset:-1px}
.budget .chip{margin:2px 0;white-space:nowrap}.budget .chip small{color:inherit;opacity:.75;font-weight:500}
tr.ours td{background:var(--hl)}td.best b{color:var(--good)}td.best b::after{content:' ★';font-size:10px}
.vs{display:grid;gap:4px 8px;align-items:end;overflow-x:auto;padding:8px;border:1px solid var(--line);border-radius:10px;background:var(--card)}
.vs .site{font-size:12px;font-weight:600;white-space:nowrap;align-self:center}.vs .t{font-size:11px;color:var(--muted);text-align:center}
.vs img,.vs .none{display:block;width:var(--fw);border:1px solid var(--line);border-radius:4px;background:#fff}.vs .none{height:var(--fh);background:transparent;border-style:dashed}
.film .blank{width:var(--fw);height:var(--fh);display:flex;align-items:center;justify-content:center;text-align:center;font-size:10px;padding:4px;border:1px dashed var(--line);border-radius:4px;color:var(--muted);white-space:normal}
.film figcaption{margin-top:3px;white-space:nowrap}.film figcaption b{color:var(--fg)}.film .fm{display:block;min-height:15px}
.film .fm span{display:inline-block;font-size:10px;font-weight:600;padding:0 5px;border-radius:99px;margin:1px}
.fm .FCP{background:var(--info-bg);color:var(--info)}.fm .LCP{background:var(--good-bg);color:var(--good)}.fm .load{background:var(--line);color:var(--fg)}.fm .shift{background:var(--bad-bg);color:var(--bad)}
svg.spark{display:block;overflow:visible}svg.spark polyline{fill:none;stroke-width:1.6;stroke-linejoin:round;stroke-linecap:round}svg.spark line{stroke:var(--line);stroke-dasharray:3 3}
`;

// Подпись изменения метрики: «▲ 0.80 с» красным (хуже) или «▼» зелёным (лучше)
export function deltaBadge(row, key) {
  const d = row?.delta?.[key];
  if (!d || !d.sig) return '';
  if (d.d == null) return `<span class="delta ${d.better ? 'd-good' : 'd-bad'}">${esc(d.text)}</span>`;
  const v = key === 'cls' ? Math.abs(d.d).toFixed(3) : fmtMs(Math.abs(d.d));
  return `<span class="delta ${d.better ? 'd-good' : 'd-bad'}" title="было ${key === 'cls' ? d.prev : fmtMs(d.prev)}">${d.better ? '▼' : '▲'} ${v}</span>`;
}

export function compareSection(compare) {
  if (!compare) return '<p class="muted">Это первая проверка этого набора страниц в этом разрешении — сравнивать пока не с чем. В следующий раз здесь появятся изменения.</p>';
  const date = compare.prevStartedAt ? new Date(compare.prevStartedAt).toLocaleString('ru-RU') : compare.prevName;
  // Страница без замера в одной из проверок (не открылась) — сравнивать нечего
  const rows = compare.rows.filter((r) => !r.isNew && r.delta);
  const changed = rows.filter((r) => Object.values(r.delta || {}).some((d) => d.sig) || r.newServices.length || r.goneServices.length || r.newErrors.length || r.fixedErrors.length);
  const names = { ttfb: 'TTFB', fcp: 'FCP', lcp: 'LCP', tbt: 'TBT', cls: 'CLS', load: 'Load' };
  const newPages = compare.rows.filter((r) => r.isNew).length;
  return `<p class="muted">Сравнение с проверкой от ${esc(date)} (папка ${esc(compare.prevName)}). Показаны только изменения больше обычного разброса замеров.${newPages ? ` Новых страниц без прошлых данных: ${newPages}.` : ''}</p>
${changed.length ? `<div class="tbl"><table><thead><tr><th>Страница</th><th>Метрики</th><th>Внешние сервисы</th><th>Ошибки</th></tr></thead><tbody>
${changed.map((r) => `<tr><td class="url">${esc(r.page)}</td>
<td>${Object.entries(r.delta || {}).filter(([, d]) => d.sig).map(([k]) => `${names[k]}: ${deltaBadge(r, k).replace('class="delta', 'class="')}`).join('<br>') || '—'}</td>
<td><small>${r.newServices.length ? `<span class="d-bad">+ ${esc(r.newServices.join(', '))}</span><br>` : ''}${r.goneServices.length ? `<span class="d-good">− ${esc(r.goneServices.join(', '))}</span>` : ''}${!r.newServices.length && !r.goneServices.length ? '—' : ''}</small></td>
<td><small>${r.newErrors.length ? `<span class="d-bad">новые: ${esc(r.newErrors.join(', '))}</span><br>` : ''}${r.fixedErrors.length ? `<span class="d-good">исправлены: ${esc(r.fixedErrors.join(', '))}</span>` : ''}${!r.newErrors.length && !r.fixedErrors.length ? '—' : ''}</small></td></tr>`).join('')}
</tbody></table></div>` : '<p>Существенных изменений нет.</p>'}`;
}

function signed(v, sig, key) {
  if (v == null) return '—';
  const txt = key === 'cpu' || key === 'tbt' ? fmtMs(Math.abs(v)) : fmtMs(Math.abs(v));
  const cls = !sig ? 'd-none' : v < 0 ? 'd-good' : 'd-bad';
  return `<span class="${cls}">${v < 0 ? '−' : '+'}${txt}</span>`;
}

export function blockTestSection(p) {
  const bt = p.extras?.blockTest;
  if (!bt) return '';
  const m = p.metrics;
  const base = `<tr><td><b>Как есть</b> <small>(${p.okRuns} прогона)</small></td><td class="r">${fmtMs(m.fcp)}</td><td class="r">${fmtMs(m.lcp)}</td><td class="r">${fmtMs(m.tbt)}</td><td class="r">${m.load == null ? 'не наступил' : fmtMs(m.load)}</td><td class="r">${fmtMs(p.totals.cpu)}</td><td class="r">${p.totals.requests}</td><td class="r">${kb(p.totals.bytes)}</td></tr>`;
  const rows = bt.rows.map((r) => r.error
    ? `<tr><td>${esc(r.label)}</td><td colspan="7">${esc(r.error)}</td></tr>`
    : `<tr><td><b>${esc(r.label)}</b> <small>(${r.runsCount})</small></td>
      ${['fcp', 'lcp', 'tbt', 'load'].map((k) => `<td class="r">${k === 'load' && r.m.loadMissing ? 'не наступил' : fmtMs(r.m[k])}<span class="delta">${k === 'lcp' && r.lcpChanged ? '<span class="d-none" title="Главный элемент страницы в этом сценарии другой">другой элемент</span>' : signed(r.delta[k], r.sig[k], k)}</span></td>`).join('')}
      <td class="r">${fmtMs(r.m.cpu)}<span class="delta">${signed(r.delta.cpu, Math.abs(r.delta.cpu) > 100, 'cpu')}</span></td>
      <td class="r">${Math.round(r.m.requests)}</td><td class="r">${kb(r.m.bytes)}</td></tr>`).join('');
  return `<h3>Сколько стоят внешние сервисы</h3>
<p class="muted">Страница открывалась с заблокированными внешними сервисами — сначала всеми сразу, затем самыми тяжёлыми по одному. Цветом выделены изменения больше обычного разброса замеров; серые — в пределах погрешности.</p>
<div class="tbl"><table><thead><tr><th>Сценарий</th><th class="r">FCP</th><th class="r">LCP</th><th class="r">TBT</th><th class="r">Load</th><th class="r">CPU (JS)</th><th class="r">Запросов</th><th class="r">Вес</th></tr></thead><tbody>${base}${rows}</tbody></table></div>
${bt.rows.filter((r) => r.lcpChanged).map((r) => `<p class="muted">${esc(r.label)}: ${esc(lcpChangedText(p, r))}</p>`).join('')}`;
}

export function lcpSection(p) {
  const lb = p.extras?.lcpBreakdown;
  if (!lb) return '';
  const parts = Object.entries(lb.parts);
  const cls = { ttfb: 's1', loadDelay: 's2', loadTime: 's3', renderDelay: 's4' };
  const top = [...parts].sort((a, b) => b[1] - a[1])[0][0];
  return `<h3>Разбор LCP: из чего складываются ${fmtMs(lb.total)}</h3>
<div class="stack">${parts.map(([k, v]) => `<div class="${cls[k]}" style="flex:${Math.max(v, 1)}" title="${LCP_PART[k][0]}: ${fmtMs(v)}">${pct(v, lb.total) >= 8 ? fmtMs(v) : ''}</div>`).join('')}</div>
<div class="stack-legend">${parts.map(([k, v]) => `<span><i class="${cls[k]}"></i>${LCP_PART[k][0]}: <b>${fmtMs(v)}</b> (${pct(v, lb.total)}%)</span>`).join('')}</div>
<p>${lb.kind === 'image' ? `Элемент LCP — картинка ${kb(lb.bytes)}: <code style="word-break:break-all">${esc(lb.url)}</code>.` : 'Элемент LCP — текстовый блок.'} Больше всего времени занимает <b>«${LCP_PART[top][0]}»</b>: ${esc(LCP_PART[top][1])}</p>`;
}

export function serverSection(p) {
  const s = p.extras?.server;
  if (!s?.phases) return '';
  const ph = s.phases;
  const parts = [['redirect', 'Редиректы', 's6'], ['dns', 'DNS', 's5'], ['connect', 'TCP', 's5'], ['tls', 'TLS', 's3'], ['server', 'Генерация на сервере', 's1'], ['download', 'Скачивание HTML', 's2']]
    .filter(([k]) => ph[k] > 0);
  const total = parts.reduce((a, [k]) => a + ph[k], 0);
  const cacheTxt = { hit: ['good', 'HTML отдан из кэша'], miss: ['warn', 'Промах кэша — HTML сгенерирован заново'], nostore: ['bad', 'HTML запрещено кэшировать'], unknown: ['info', 'Признаков кэша нет'] }[s.cache];
  return `<h3>Ответ сервера на запрос HTML</h3>
<div class="stack">${parts.map(([k, n, c]) => `<div class="${c}" style="flex:${Math.max(ph[k], 1)}" title="${n}: ${fmtMs(ph[k])}">${pct(ph[k], total) >= 10 ? fmtMs(ph[k]) : ''}</div>`).join('')}</div>
<div class="stack-legend">${parts.map(([k, n, c]) => `<span><i class="${c}"></i>${n}: <b>${fmtMs(ph[k])}</b></span>`).join('')}</div>
<p><span class="chip ${cacheTxt[0]}">${cacheTxt[1]}</span> ${ph.protocol ? `Протокол: <b>${esc(ph.protocol)}</b>. ` : ''}${Object.entries(s.headers).map(([k, v]) => `<code>${esc(k)}: ${esc(v)}</code>`).join(' · ')}</p>
${ph.serverTiming?.length ? `<p class="muted">Server-Timing: ${ph.serverTiming.map((t) => `${esc(t.name)} ${fmtMs(t.dur)}${t.desc ? ` (${esc(t.desc)})` : ''}`).join(', ')}</p>` : '<p class="muted">Заголовок Server-Timing не передаётся — с ним в отчёте было бы видно, на что уходит время бэкенда (БД, кэш, API).</p>'}`;
}

export function coverageSection(p) {
  const c = p.extras?.coverage;
  if (!c) return '';
  if (c.error) return `<h3>Неиспользуемый код</h3><p class="muted">Не удалось замерить: ${esc(c.error)}</p>`;
  const row = (f) => `<tr><td>${f.internal ? '<b>Свой</b>' : esc(f.service)}</td><td>${f.kind.toUpperCase()}</td><td class="r">${kb(f.total)}</td><td class="r"><b>${kb(f.unused)}</b></td>
    <td><div class="bar" title="не используется ${100 - f.usedPct}%"><i style="width:${100 - f.usedPct}%"></i></div><small>${100 - f.usedPct}% не используется</small></td>
    <td class="url" title="${esc(f.url)}">${f.inline ? '<i>инлайн-код в HTML</i> ' : ''}${esc(shortUrl(f.url, 100))}</td></tr>`;
  return `<h3>Неиспользуемый код при загрузке</h3>
<p>JavaScript: не выполнялось <b>${kb(c.js.unused)}</b> из ${kb(c.js.total)} (${pct(c.js.unused, c.js.total)}%) — своего ${kb(c.jsInternal.unused)}, внешнего ${kb(c.jsExternal.unused)}. CSS: не применялось <b>${kb(c.css.unused)}</b> из ${kb(c.css.total)}.</p>
<p class="muted">Размеры — в несжатом виде. Часть кода может понадобиться позже (клики, прокрутка), но к загрузке страницы он не нужен и его можно подгружать по требованию.</p>
<div class="tbl"><table><thead><tr><th>Источник</th><th>Тип</th><th class="r">Размер</th><th class="r">Не используется</th><th>Доля</th><th>Файл</th></tr></thead><tbody>${c.files.slice(0, 15).map(row).join('')}</tbody></table></div>`;
}

export function imagesSection(p) {
  const im = p.extras?.images;
  if (!im) return '';
  const counts = { format: 'устаревший формат', oversized: 'больше нужного размера', dims: 'без размеров (CLS)', lazyTop: 'lazy на первом экране', eager: 'ниже экрана без lazy', lcpPrio: 'LCP без приоритета' };
  return `<h3>Картинки</h3>
<p>На странице ${im.count} картинок, загружено ${im.requests} файлов на ${kb(im.bytes)}. Оценка возможной экономии: <b>${kb(im.save)}</b>.
${Object.entries(im.counts).map(([k, v]) => `<span class="chip warn">${counts[k]}: ${v}</span>`).join(' ')}</p>
${im.items.length ? `<div class="tbl"><table><thead><tr><th>Картинка</th><th class="r">Размер</th><th class="r">Экономия</th><th>Проблемы</th></tr></thead><tbody>
${im.items.slice(0, 20).map((i) => `<tr${i.isLcp ? ' class="hl"' : ''}><td class="url" title="${esc(i.src)}">${i.isLcp ? '<span class="chip bad">LCP</span> ' : ''}${esc(shortUrl(i.src, 90))}<br><small>&lt;${esc(i.desc)}&gt;</small></td>
<td class="r">${kb(i.bytes)}</td><td class="r">${i.save ? kb(i.save) : '—'}</td><td><small>${i.issues.map((s) => esc(s.t)).join('<br>')}</small></td></tr>`).join('')}
</tbody></table></div>` : '<p>Замечаний нет.</p>'}`;
}

export function clsSection(p) {
  const cs = p.extras?.clsSources;
  if (!cs?.length) return '';
  return `<h3>Источники сдвигов вёрстки (CLS ${p.metrics.cls})</h3>
<p class="muted">Элементы, которые сдвигались при загрузке, и их средний вклад в CLS. Если в одном сдвиге участвовало несколько элементов, вклад поделён между ними.</p>
<div class="tbl"><table><thead><tr><th>Элемент</th><th class="r">Вклад в CLS</th><th class="r">Первый сдвиг</th><th class="r">Сдвигов</th></tr></thead><tbody>
${cs.map((c) => `<tr><td><code>&lt;${esc(c.el)}&gt;</code></td><td class="r"><b>${c.value}</b></td><td class="r">${fmtMs(c.firstAt)}</td><td class="r">${c.count}</td></tr>`).join('')}
</tbody></table></div>`;
}

export function fontsDomSection(p) {
  const f = p.extras?.fonts;
  const d = p.extras?.dom;
  if (!f && !d) return '';
  return `<div class="grid2">
${f ? `<div class="card"><h4 style="margin:0 0 6px">Шрифты</h4>
<p>Файлов: <b>${f.files}</b> (${kb(f.bytes)}), семейств в @font-face: ${f.families}, предзагружено: ${f.preloaded}${f.googleFonts ? `, Google Fonts: ${f.googleFonts}` : ''}.</p>
<p>${f.noSwap.length ? `<span class="chip warn">без font-display: swap</span> ${esc(f.noSwap.join(', '))}` : '<span class="chip good">font-display настроен</span>'}${f.gfNoSwap ? ' <span class="chip warn">Google Fonts без display=swap</span>' : ''}</p>
${f.slowest.length ? `<p class="muted">Позже всех загрузился: ${esc(shortUrl(f.slowest[0].url.replace(/^https?:\/\//, ''), 60))} — на ${fmtMs(f.slowest[0].end)}</p>` : ''}</div>` : ''}
${d ? `<div class="card"><h4 style="margin:0 0 6px">Размер DOM</h4>
<p><span class="chip ${d.level === 'ok' ? 'good' : d.level}">${d.nodes.toLocaleString('ru-RU')} элементов</span> глубина ${d.maxDepth}, максимум дочерних — ${d.maxChildren} у <code>&lt;${esc(d.maxChildrenEl)}&gt;</code>.</p>
<p class="muted">Ориентир Lighthouse: до 800 элементов — хорошо, больше 1 400 — плохо. Большой DOM замедляет отрисовку и отклик на действия (INP).</p></div>` : ''}
</div>`;
}

export function seoSection(p) {
  const s = p.extras?.seo;
  if (!s) return '';
  const ag = s.agents;
  return `<h3>SEO: что видят поисковые роботы</h3>
<div class="tbl"><table><thead><tr><th>Кто запрашивает</th><th>Статус</th><th class="r">Ответ (TTFB)</th><th class="r">HTML</th><th class="r">Текст</th><th class="r">Ссылок</th><th>H1</th></tr></thead><tbody>
${ag.map((a) => `<tr><td><b>${esc(a.label)}</b></td><td>${a.error ? `<span class="chip bad">${esc(a.error)}</span>` : `<span class="chip ${a.blocked || a.status !== 200 ? 'bad' : 'good'}">${a.status}${a.blocked ? ' блок' : ''}</span>${a.redirects ? ` <small>${a.redirects} редир.</small>` : ''}`}</td>
<td class="r ${a.ttfb > 2000 ? 'txt-bad' : ''}">${fmtMs(a.ttfb)}</td><td class="r">${kb(a.bytes)}</td><td class="r">${(a.textLen || 0).toLocaleString('ru-RU')}</td><td class="r">${a.links}</td>
<td><small>${a.h1.length ? a.h1.map((h) => `«${esc(h) || '<i>пусто</i>'}»`).join(', ') : '<i>нет</i>'}</small></td></tr>`).join('')}
${s.rendered ? `<tr><td><b>Браузер после выполнения JS</b></td><td>—</td><td class="r">—</td><td class="r">—</td><td class="r">${s.rendered.textLen.toLocaleString('ru-RU')}</td><td class="r">${s.rendered.links}</td><td><small>${s.rendered.h1.map((h) => `«${esc(h)}»`).join(', ') || '<i>нет</i>'}</small></td></tr>` : ''}
</tbody></table></div>
<p class="muted">Текст — число символов видимого текста в HTML без выполнения JavaScript. Роботы Google и Яндекса умеют выполнять JS, но делают это с задержкой и не всегда полностью, поэтому контент в исходном HTML надёжнее для индексации.</p>
<div class="tbl"><table><thead><tr><th>Проверка</th><th>Результат</th></tr></thead><tbody>
${s.checks.map((c) => `<tr><td style="white-space:nowrap"><span class="chip ${LVL[c.level][0]}">${LVL[c.level][1]}</span></td><td><b>${esc(c.title)}</b>${c.detail ? `<br><small>${esc(c.detail)}</small>` : ''}</td></tr>`).join('')}
</tbody></table></div>`;
}

export function warmSection(p) {
  const w = p.extras?.warm;
  if (!w) return '';
  if (w.error) return `<h3>Повторный визит (прогретый кэш)</h3><p class="muted">Не удалось замерить: ${esc(w.error)}</p>`;
  const c = p.metrics;
  const grade = (k, v) => (v == null ? (k === 'load' ? 'poor' : '') : ({ ttfb: [800, 1800], fcp: [1800, 3000], lcp: [2500, 4000], cls: [0.1, 0.25], tbt: [200, 600], load: [3000, 6000] }[k].reduce((g, t, i) => (v > t ? ['ni', 'poor'][i] : g), 'good')));
  const val = (k, v) => (k === 'cls' ? (v ?? '—') : v == null && k === 'load' ? 'не наступил' : fmtMs(v));
  const diff = (k) => {
    const d = w.delta[k];
    if (!d) return '—';
    const txt = k === 'cls' ? Math.abs(d.d).toFixed(3) : fmtMs(Math.abs(d.d));
    const pctTxt = k !== 'cls' && c[k] ? ` (${d.d < 0 ? '−' : '+'}${Math.round(Math.abs(d.d) / c[k] * 100)}%)` : '';
    return `<span class="${!d.sig ? 'd-none' : d.d < 0 ? 'd-good' : 'd-bad'}">${d.d < 0 ? '−' : '+'}${txt}${pctTxt}</span>`;
  };
  const rows = [['ttfb', 'TTFB — ответ сервера'], ['fcp', 'FCP — первая отрисовка'], ['lcp', 'LCP — главный контент'], ['tbt', 'TBT — блокировка JS'], ['cls', 'CLS — сдвиги вёрстки'], ['load', 'Полная загрузка']]
    .map(([k, n]) => `<tr><td>${n}</td><td class="r m ${grade(k, c[k])}"><b>${val(k, c[k])}</b></td><td class="r m ${grade(k, w.m[k])}"><b>${val(k, w.m[k])}</b></td><td class="r">${diff(k)}</td></tr>`).join('');
  const netDiff = w.net.cold ? Math.round((1 - w.net.warm / w.net.cold) * 100) : 0;
  return `<h3>Повторный визит (прогретый кэш)</h3>
<p class="muted">Страница открывалась повторно в том же браузере после первого захода — как у покупателя, который вернулся на сайт. Файлы, которые сайт разрешает хранить, браузер берёт из своего кэша. Медиана ${w.runs} замеров. Первый визит — обычный замер с чистым браузером (новый посетитель). TTFB при повторном визите обычно меньше ещё и потому, что браузер не устанавливает соединение с сервером заново.</p>
<div class="tbl"><table><thead><tr><th>Показатель</th><th class="r">Первый визит</th><th class="r">Повторный визит</th><th class="r">Разница</th></tr></thead><tbody>
${rows}
<tr><td>Запросов</td><td class="r">${w.requests.cold}</td><td class="r">${w.requests.warm} <small>(по сети ${w.requests.warmNetwork})</small></td><td class="r">—</td></tr>
<tr><td>Скачано по сети</td><td class="r">${kb(w.net.cold)}</td><td class="r">${kb(w.net.warm)}</td><td class="r"><span class="${netDiff > 0 ? 'd-good' : 'd-none'}">−${netDiff}%</span></td></tr>
</tbody></table></div>
<p><span class="chip good">из кэша браузера: ${w.counts.cached}</span> <span class="chip info">перепроверено (304): ${w.counts.revalidated}</span> <span class="chip warn">снова загружено по сети: ${w.counts.network}</span></p>
<p class="muted">Зелёным в колонке «Разница» отмечено заметное ускорение, серым — изменение в пределах разброса замеров.</p>
${w.refetched.length ? `<h4 style="margin:14px 0 6px">Свои файлы, которые при повторном визите снова идут в сеть</h4>
<div class="tbl"><table><thead><tr><th>Тип</th><th>Ответ</th><th class="r">По сети</th><th>Cache-Control</th><th>Причина</th><th>Файл</th></tr></thead><tbody>
${w.refetched.slice(0, 15).map((r) => `<tr><td>${esc(r.type)}</td><td>${esc(r.status)}</td><td class="r">${kb(r.netBytes)}</td><td><code>${esc(r.cacheControl || '—')}</code></td><td><small>${esc(r.reason)}</small></td><td class="url" title="${esc(r.url)}">${esc(shortUrl(r.url, 90))}</td></tr>`).join('')}
</tbody></table></div>${w.refetched.length > 15 ? `<p class="muted">И ещё ${w.refetched.length - 15}.</p>` : ''}` : '<p>Все свои статические файлы при повторном визите берутся из кэша.</p>'}
${w.extRefetched ? `<p class="muted">Внешние сервисы снова загрузили ${w.extRefetched} файлов — это настраивается на их стороне.</p>` : ''}`;
}

export function interactionsSection(p) {
  const ia = p.extras?.interactions;
  if (!ia) return '';
  const TYPE = { catalog: 'каталог', product: 'карточка товара', other: 'другая страница' };
  const typeLine = ia.pageType ? `<p>Тип страницы: <b>${TYPE[ia.pageType]}</b> <small class="muted">(${ia.pageTypeSource === 'config' ? 'задан в actions.txt по адресу' : 'определён автоматически'})</small>.
    ${ia.rows?.some((r) => r.source === 'config') ? 'Нажатия заданы для сайта в <code>actions.txt</code>.' : 'Нажимались стандартные для этого типа элементы; точный список для сайта можно задать в <code>actions.txt</code>.'}</p>` : '';
  const head = '<h3>Отклик на действия (INP, лабораторный замер)</h3>' + typeLine;
  if (ia.error && !ia.rows?.length) return `${head}<p class="muted">${esc(ia.error)}</p>`;
  const g = (v) => (v == null ? 'good' : v <= 200 ? 'good' : v <= 500 ? 'ni' : 'poor');
  const chip = { good: 'good', ni: 'warn', poor: 'bad' };
  const rows = ia.rows.map((r) => {
    if (r.error) return `<tr><td><b>${esc(r.label)}</b></td><td><small>${esc(r.text || r.desc)}</small></td><td colspan="5"><small class="${r.notFound ? 'txt-bad' : 'muted'}">${r.notFound ? '' : 'не удалось нажать: '}${esc(r.error)}</small></td></tr>`;
    if (r.fast) return `<tr><td><b>${esc(r.label)}</b></td><td><small>${esc(r.text || r.desc)}</small></td><td class="r"><span class="chip good">&lt; 16 мс</span></td><td colspan="4"><small class="muted">мгновенный отклик</small></td></tr>`;
    return `<tr><td><b>${esc(r.label)}</b></td><td><small>${esc(r.text || '')}<br><code>&lt;${esc(r.desc)}&gt;</code></small></td>
      <td class="r"><span class="chip ${chip[g(r.dur)]}">${fmtMs(r.dur)}</span></td>
      <td class="r">${fmtMs(r.inputDelay)}</td><td class="r">${fmtMs(r.processing)}</td><td class="r">${fmtMs(r.presentation)}</td>
      <td><small>${r.scripts.length ? r.scripts.map((sc) => `${sc.internal ? '<b>свой</b>' : esc(sc.service)} ${fmtMs(sc.dur)} <span class="muted" title="${esc(sc.url)}">${esc(shortUrl(sc.url.replace(/^https?:\/\//, ''), 45))}</span>`).join('<br>') : '—'}</small></td></tr>`;
  }).join('');
  return `${head}
<p>Худший отклик: <span class="chip ${chip[g(ia.inp)]}">${ia.inp == null ? '—' : fmtMs(ia.inp)}</span> (проверено действий: ${ia.tested}). Норма Google для INP: до 200 мс хорошо, больше 500 мс плохо.</p>
<p class="muted">Агент нажимал элементы по одному, как покупатель, — и замерял время от нажатия до отрисовки результата. Оно складывается из задержки до начала обработки (основной поток занят), работы обработчиков и отрисовки. Переходы по ссылкам во время теста блокировались. Реальный INP у посетителей зависит от их устройств и действий и может отличаться.</p>
<div class="tbl"><table><thead><tr><th>Действие</th><th>Элемент</th><th class="r">Отклик</th><th class="r">Задержка ввода</th><th class="r">Обработка</th><th class="r">Отрисовка</th><th>Что выполнялось</th></tr></thead><tbody>${rows}</tbody></table></div>
${ia.overlays?.length ? `<p class="muted">Перед нажатием пришлось убрать всплывающие окна сайта: ${ia.overlays.map((o) => `<code>&lt;${esc(o.overlay)}&gt;</code> — ${esc(o.action)}`).join('; ')}.</p>` : ''}
${ia.testOverlays?.length ? `<p class="muted">Между действиями закрывались окна, открытые самим тестом (меню, панели фильтров): ${ia.testOverlays.map((o) => `<code>&lt;${esc(o.overlay)}&gt;</code>`).join(', ')}.</p>` : ''}`;
}

// ── Реальные посетители (Chrome UX Report) ────────────────────────────────
const FIELD_NAME = { lcp: 'LCP — главный контент', inp: 'INP — отклик на действия', cls: 'CLS — сдвиги вёрстки', fcp: 'FCP — первая отрисовка', ttfb: 'TTFB — ответ сервера' };
const fieldVal = (k, v) => (v == null ? '—' : k === 'cls' ? String(v) : fmtMs(v));
const GCHIP = { good: 'good', ni: 'warn', poor: 'bad', na: 'info' };

// Мини-график недельных p75; пунктир — порог «хорошо»
function spark(k, series) {
  const vals = (series || []).map((v) => (v == null ? null : Number(v)));
  const known = vals.filter((v) => v != null);
  if (known.length < 3) return '';
  const good = FIELD_THRESHOLDS[k][0];
  const max = Math.max(...known, good) * 1.08;
  const min = Math.min(...known, good) * 0.92;
  const W = 120, H = 26;
  const y = (v) => (H - ((v - min) / (max - min || 1)) * H).toFixed(1);
  const x = (i) => ((i / Math.max(1, vals.length - 1)) * W).toFixed(1);
  const pts = vals.map((v, i) => (v == null ? null : `${x(i)},${y(v)}`)).filter(Boolean).join(' ');
  const last = known.at(-1);
  return `<svg class="spark" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" aria-hidden="true"><line x1="0" x2="${W}" y1="${y(good)}" y2="${y(good)}"/><polyline points="${pts}" stroke="var(--${fieldGrade(k, last) === 'good' ? 'good' : fieldGrade(k, last) === 'ni' ? 'warn' : 'bad'})"/></svg>`;
}

function distBar(m) {
  if (!m?.dist?.length) return '';
  const [g, n, p] = m.dist.map((d) => Math.round(d * 100));
  return `<div class="dist" title="хорошо ${g}%, требует улучшения ${n}%, плохо ${p}%"><i class="g" style="width:${g}%"></i><i class="n" style="width:${n}%"></i><i class="p" style="width:${p}%"></i></div><small>хорошо ${g}% · средне ${n}% · плохо ${p}%</small>`;
}

// Подсказка, если ключа нет: показывается один раз в сводке профиля
export function fieldKeyHint(opts) {
  if (opts?.cruxState !== 'nokey') return '';
  return `<div class="card"><b>Данные реальных посетителей не подключены.</b> Агент может показывать рядом с замером, как сайт работает у настоящих посетителей в Chrome (Chrome UX Report — те же данные, по которым Google ранжирует сайт). Для этого нужен бесплатный ключ Google API в файле <code>crux-key.txt</code> в папке агента — как его получить, написано в инструкции, раздел «Данные реальных посетителей».</div>`;
}

export function fieldSection(p) {
  const f = p.extras?.field;
  if (!f) return '';
  const head = '<h3>Реальные посетители (Chrome UX Report)</h3>';
  if (f.error) return `${head}<p class="muted">Не удалось получить данные: ${esc(f.error)}</p>`;
  const dev = f.formFactor === 'PHONE' ? 'смартфоны' : 'компьютеры';
  if (!f.level) return `${head}<p class="muted">В Chrome UX Report недостаточно визитов (${dev}) ни по этой странице, ни по сайту ${esc(f.originUrl)} в целом — Google публикует данные только при заметном трафике из Chrome. Ориентируйтесь на лабораторный замер.</p>`;
  const lab = f.lab || {};
  const keys = ['lcp', 'inp', 'cls', 'fcp', 'ttfb'].filter((k) => f.metrics[k]);
  const showOrigin = f.level === 'url' && f.origin;
  const rows = keys.map((k) => {
    const m = f.metrics[k];
    const fg = fieldGrade(k, m.p75);
    const l = lab[k];
    const labCell = l === undefined ? '<small class="muted">не замерялся</small>'
      : k === 'inp' && l == null ? '<span class="chip good">&lt; 16 мс</span>'
      : `<span class="chip ${GCHIP[fieldGrade(k, l)]}">${fieldVal(k, l)}</span>`;
    const t = f.trend?.[k];
    const o = showOrigin ? f.origin.metrics[k] : null;
    return `<tr><td>${FIELD_NAME[k]}${['lcp', 'inp', 'cls'].includes(k) ? '' : ' <small>(диагностика)</small>'}</td>
<td class="r">${labCell}</td>
<td class="r"><span class="chip ${GCHIP[fg]}">${fieldVal(k, m.p75)}</span></td>
<td>${distBar(m)}</td>
${showOrigin ? `<td class="r">${o ? `<span class="chip ${GCHIP[fieldGrade(k, o.p75)]}">${fieldVal(k, o.p75)}</span>` : '—'}</td>` : ''}
<td>${spark(k, f.history?.series?.[k])}${t ? `<small class="${!t.sig ? 'd-none' : t.better ? 'd-good' : 'd-bad'}">${fieldVal(k, t.from)} → ${fieldVal(k, t.to)}</small>` : ''}</td></tr>`;
  }).join('');
  const lp = f.lcpParts || {};
  const lpKeys = ['ttfb', 'loadDelay', 'loadTime', 'renderDelay'].filter((k) => lp[k] != null);
  const lpTotal = lpKeys.reduce((a, k) => a + lp[k], 0);
  const scls = { ttfb: 's1', loadDelay: 's2', loadTime: 's3', renderDelay: 's4' };
  const verdict = f.cwvPass == null ? '' : f.cwvPass
    ? '<span class="chip good">Core Web Vitals пройдены</span>' : '<span class="chip bad">Core Web Vitals не пройдены</span>';
  return `${head}
<p>${verdict} ${f.level === 'url' ? 'Данные по этой странице' : `<b>Данные по сайту в целом</b> (${esc(f.originUrl)}) — у самой страницы недостаточно визитов для отдельной статистики`}; ${dev}; период ${esc(f.period.from)} — ${esc(f.period.to)} (28 дней).</p>
<p class="muted">Значение «у посетителей» — 75-й перцентиль: у 75% визитов было не хуже. По нему Google оценивает страницу в ранжировании; Core Web Vitals пройдены, когда LCP, INP и CLS в зелёной зоне. «Замер агента» — медиана лабораторных прогонов этой проверки${f.formFactor === 'PHONE' ? ' (эмуляция Pixel 7 и 4G)' : ''}. Динамика — недельные значения за последние полгода, пунктир — порог «хорошо».</p>
<div class="tbl"><table><thead><tr><th>Метрика</th><th class="r">Замер агента</th><th class="r">У посетителей (p75)</th><th>Доля визитов</th>${showOrigin ? '<th class="r">Весь сайт (p75)</th>' : ''}<th>Динамика за полгода</th></tr></thead><tbody>${rows}</tbody></table></div>
${lpKeys.length === 4 && lpTotal ? `<h4 style="margin:14px 0 6px">LCP у посетителей, когда главный элемент — картинка (p75 каждой части)</h4>
<div class="stack">${lpKeys.map((k) => `<div class="${scls[k]}" style="flex:${Math.max(lp[k], 1)}" title="${LCP_PART[k][0]}: ${fmtMs(lp[k])}">${pct(lp[k], lpTotal) >= 8 ? fmtMs(lp[k]) : ''}</div>`).join('')}</div>
<div class="stack-legend">${lpKeys.map((k) => `<span><i class="${scls[k]}"></i>${LCP_PART[k][0]}: <b>${fmtMs(lp[k])}</b></span>`).join('')}</div>
<p class="muted">Перцентили частей считаются отдельно, поэтому их сумма не равна p75 LCP. Сравните с разбором LCP в замере ниже: если у посетителей больше всего занимает другая часть, причина медленного LCP у них другая.</p>` : ''}
${f.gaps?.length ? `<p class="muted">${f.gaps.map((g) => g.kind === 'labBetter'
    ? `${g.k.toUpperCase()}: в замере ${fmtMs(g.lab)}, у посетителей заметно хуже — ${fmtMs(g.field)}.`
    : `${g.k.toUpperCase()}: в замере ${fmtMs(g.lab)}, у посетителей заметно лучше — ${fmtMs(g.field)}.`).join(' ')}
${f.gaps.some((g) => g.kind === 'fieldBetter') ? ' Замер медленнее реальности, если профиль замера строже условий посетителей, посетителям помогает кэш браузера (они чаще возвращаются, чем приходят впервые) или защита сайта от ботов замедляет запросы агента — проверьте, не попадает ли под неё и часть реальных посетителей.' : ''}</p>` : ''}`;
}

// ── Раскадровка загрузки ──────────────────────────────────────────────────
// Одна лента кадров: одинаковые кадры подряд объединяются в один с подписью-промежутком, отметки событий собираются со всех
function filmStrip(fs, fmtT) {
  const groups = [];
  for (const sl of fs.slots) {
    const g = groups.at(-1);
    if (g && g.f === sl.f) {
      g.to = sl.t;
      g.marks.push(...sl.marks);
      g.shift = (g.shift || 0) + (sl.shift || 0);
    } else groups.push({ f: sl.f, from: sl.t, to: sl.t, marks: [...sl.marks], shift: sl.shift || 0 });
  }
  const lcpG = groups.find((g) => g.marks.includes('LCP'));
  const fcpG = groups.find((g) => g.marks.includes('FCP'));
  const items = groups.map((g) => `<figure class="${g === lcpG ? 'lcp' : g === fcpG ? 'fcp' : ''}">
${g.f == null ? `<div class="blank">${fs.warm ? 'экран ещё не обновился' : 'пустой экран'}</div>` : `<img src="data:image/jpeg;base64,${fs.frames[g.f]}" alt="Экран на ${fmtT(g.from)}">`}
<figcaption><b>${g.to > g.from ? `${fmtT(g.from)} – ${fmtT(g.to)}` : fmtT(g.from)}</b><span class="fm">${g.marks.map((n) => `<span class="${n}">${n}</span>`).join('')}${g.shift >= 0.01 ? `<span class="shift" title="Сдвиг вёрстки за этот промежуток">сдвиг ${Math.round(g.shift * 1000) / 1000}</span>` : ''}</span></figcaption></figure>`).join('');
  const m = fs.metrics;
  return `<div class="film" style="--fw:${fs.mobile ? 96 : 168}px;--fh:${fs.mobile ? 196 : 95}px">${items}</div>
<p class="muted">FCP ${fmtMs(m.fcp)}, LCP ${fmtMs(m.lcp)}, полная загрузка ${m.load == null ? 'не наступила' : fmtMs(m.load)}.${m.load == null || m.load > fs.end ? ` Лента показана до ${fmtT(fs.slots.at(-1).t)}${m.load != null ? `, полная загрузка — на ${fmtMs(m.load)}` : ''}; ${fs.changedAfter ? `после ленты экран менялся ещё ${fs.changedAfter} раз(а)` : 'после ленты экран больше не менялся'}.` : ''}${fs.lastChange != null && m.lcp != null && fs.lastChange > m.lcp + 1500 ? ` Последнее изменение на экране — на ${fmtT(fs.lastChange)}, заметно позже LCP: после отрисовки главного элемента экран продолжает меняться (догружаются баннеры, блоки, всплывающие окна, работают карусели).` : ''}</p>`;
}

export function filmstripSection(p) {
  const fs = p.extras?.filmstrip;
  if (!fs) return '';
  const warm = p.extras?.filmstripWarm;
  const fmtFor = (step) => (t) => (t < 1000 ? `${t} мс` : `${(t / 1000).toFixed(t % 1000 ? (step < 1000 ? 2 : 1) : 0)} с`);
  const fmtT = fmtFor(fs.step);
  const fmtTw = fmtFor(warm?.step ?? fs.step);
  const fmtStep = (st) => (st < 1000 ? `${st} мс` : `${st / 1000} с`);
  // Итог сравнения: на сколько раньше появляется контент у вернувшегося посетителя
  const cmp = (k, n) => {
    const a = fs.metrics[k];
    const b = warm?.metrics[k];
    if (a == null || b == null) return '';
    const d = a - b;
    return `${n}: ${fmtMs(a)} → ${fmtMs(b)} <span class="${Math.abs(d) < 200 ? 'd-none' : d > 0 ? 'd-good' : 'd-bad'}">(${d > 0 ? '−' : '+'}${fmtMs(Math.abs(d))})</span>`;
  };
  return `<h3>Раскадровка загрузки</h3>
<p class="muted">Что видит посетитель на экране во время загрузки. Синей рамкой выделен кадр, где появился первый контент (FCP), зелёной — где отрисован главный элемент (LCP). Если экран какое-то время не менялся, кадры объединены в один, а подпись показывает промежуток; белые кадры в начале — экран ещё пустой. Значения FCP и LCP под лентой — того прогона, в котором сняты кадры, они могут немного отличаться от медианы в сводке.</p>
<h4 style="margin:14px 0 6px">Первый визит — новый посетитель, пустой кэш браузера <small>(кадр каждые ${fmtStep(fs.step)})</small></h4>
${filmStrip(fs, fmtT)}
${warm ? `<h4 style="margin:18px 0 6px">Повторный визит — файлы сайта уже в кэше браузера <small>(кадр каждые ${fmtStep(warm.step)})</small></h4>
${filmStrip(warm, fmtTw)}
<p>Разница: ${[cmp('fcp', 'первый контент (FCP)'), cmp('lcp', 'главный элемент (LCP)')].filter(Boolean).join('; ')}. <span class="muted">${warm.step !== fs.step ? 'Шаг кадров у лент разный — сравнивайте по подписям времени. ' : ''}«Экран ещё не обновился» — браузер ещё показывает прежнюю страницу и не начал рисовать новую.</span></p>` : ''}`;
}

// ── Бюджет скорости ───────────────────────────────────────────────────────
// runs: [{ name, label, pages }] — один профиль или оба (общий отчёт)
export function budgetSection(runs) {
  const all = runs.flatMap((r) => r.pages.map((p) => ({ r, p })));
  const checked = all.filter(({ p }) => p.budget);
  if (!checked.length) return '';
  const multi = runs.length > 1;
  // Строка на страницу: сначала страницы с новыми нарушениями, затем с большим их числом
  const bad = checked.filter(({ p }) => p.budget.failed || p.budget.over.length)
    .map((x) => ({ ...x, fresh: x.p.budget.over.filter((o) => o.status === 'new').length }))
    .sort((a, b) => (b.p.budget.failed ? 1 : 0) - (a.p.budget.failed ? 1 : 0) || b.fresh - a.fresh || b.p.budget.over.length - a.p.budget.over.length);
  const fresh = bad.reduce((a, x) => a + x.fresh, 0);
  const fixed = checked.filter(({ p }) => p.budget.fixed?.length);
  const short = (k) => BUDGET_KEYS[k].label.split(' — ')[0];
  const ST = { new: ['bad', 'впервые'], repeat: ['warn', 'повторно'], unknown: ['warn', ''] };
  // Новые нарушения — первыми
  const chips = (over) => [...over].sort((a, b) => (a.status === 'new' ? 0 : 1) - (b.status === 'new' ? 0 : 1)).map((o) => {
    const times = o.value == null ? '' : BUDGET_KEYS[o.key].kind === 'count' ? `, +${o.value - o.limit}` : `, ×${o.ratio.toFixed(1)}`;
    return `<span class="chip ${ST[o.status][0]}" title="${esc(BUDGET_KEYS[o.key].label)}: ${esc(fmtBudget(o.key, o.value))}, бюджет ${esc(fmtBudget(o.key, o.limit))}${times}${ST[o.status][1] ? ` — ${ST[o.status][1]}` : ''}">${esc(short(o.key))} ${esc(fmtBudget(o.key, o.value))} <small>/ ${esc(fmtBudget(o.key, o.limit))}</small></span>`;
  }).join(' ');
  return `<h2>Бюджет скорости</h2>
${bad.length ? `<p><span class="chip bad">Вне бюджета: ${bad.length} из ${checked.length}</span> ${multi ? 'замеров страниц' : 'страниц'}${fresh ? ` · новых нарушений: <b>${fresh}</b>` : ''}${fixed.length ? ` · вернулось в норму: ${fixed.reduce((a, { p }) => a + p.budget.fixed.length, 0)}` : ''}</p>
<div class="tbl"><table><thead><tr><th>Страница</th>${multi ? '<th>Разрешение</th>' : ''}<th>Что вышло за бюджет <small>(значение / бюджет)</small></th></tr></thead><tbody>
${bad.map(({ r, p }) => `<tr><td class="url">${esc(p.page)}</td>${multi ? `<td>${esc(r.label)}</td>` : ''}<td class="budget">${p.budget.failed ? '<span class="chip bad">Страница не открылась</span>' : chips(p.budget.over)}</td></tr>`).join('')}
</tbody></table></div>
<p class="muted"><span class="chip bad">красные</span> — впервые: в прошлой проверке показатель был в бюджете; <span class="chip warn">жёлтые</span> — повторно или прошлой проверки нет. Наведите на плашку, чтобы увидеть, во сколько раз превышен бюджет.</p>`
    : `<p><span class="chip good">Все ${multi ? 'замеры страниц' : 'страницы'} в бюджете</span></p>`}
${fixed.length ? `<p class="muted">Вернулись в бюджет: ${fixed.map(({ r, p }) => `${esc(p.page.replace(/^https?:\/\//, ''))}${multi ? ` (${esc(r.label)})` : ''} — ${p.budget.fixed.map((k) => esc(short(k))).join(', ')}`).join('; ')}.</p>` : ''}
<p class="muted">Пороги задаются в файле <code>budgets.txt</code> в папке агента (общие и для отдельных сайтов). Сравнивается медиана замера. Показатели, которые в этой проверке не замерялись (например, тест отклика в быстром режиме), не учитываются.</p>`;
}

// ── Сравнение с конкурентами ──────────────────────────────────────────────
const CMP_COLS = [
  ['lcp', 'LCP', (m) => m.lcp], ['fcp', 'FCP', (m) => m.fcp], ['ttfb', 'TTFB', (m) => m.ttfb], ['tbt', 'TBT', (m) => m.tbt],
  ['cls', 'CLS', (m) => m.cls], ['load', 'Полная загрузка', (m) => m.load ?? Infinity],
];
const placeWord = (n) => `${n}-е`;

// Кадр раскадровки на момент t: последний слот не позже t
function frameAt(fs, t) {
  if (!fs?.slots?.length) return null;
  const slot = [...fs.slots].reverse().find((sl) => sl.t <= t) ?? null;
  return slot && slot.f != null ? fs.frames[slot.f] : null;
}

function groupTable(g, label) {
  const ok = g.rows.filter((r) => r.metrics);
  const best = {};
  for (const [k, , get] of CMP_COLS) best[k] = Math.min(...ok.map((r) => get(r.metrics)).filter((v) => v != null));
  const bestOf = (vals) => Math.min(...vals.filter((v) => v != null));
  const bestBytes = bestOf(ok.map((r) => r.totals.bytes));
  const bestReq = bestOf(ok.map((r) => r.totals.requests));
  const bestExt = bestOf(ok.map((r) => r.totals.extServices));
  const cell = (k, v, isBest) => `<td class="r${isBest ? ' best' : ''}"><b>${k === 'cls' ? v : v === Infinity ? 'не наступила' : fmtMs(v)}</b></td>`;
  const cwv = (r) => {
    const f = r.extras?.field;
    if (!f) return '<td><small class="muted">—</small></td>';
    if (f.error || !f.level || f.cwvPass == null) return '<td><small class="muted">нет данных</small></td>';
    return `<td><span class="chip ${f.cwvPass ? 'good' : 'bad'}" title="LCP ${fmtMs(f.metrics.lcp?.p75)}, INP ${fmtMs(f.metrics.inp?.p75)}, CLS ${f.metrics.cls?.p75 ?? '—'}">${f.cwvPass ? 'CWV ✓' : 'CWV ✗'}</span></td>`;
  };
  const GR = { good: ['good', 'Хорошо'], ni: ['warn', 'Требует улучшения'], poor: ['bad', 'Плохо'] };
  // Колонка реальных посетителей — только если данные CrUX запрашивались
  const fieldOn = g.rows.some((r) => r.extras?.field);
  const rows = g.rows.map((r) => `<tr class="${r.ours ? 'ours' : ''}"><td><b>${esc(r.site)}</b>${r.ours ? ' <span class="chip info">мы</span>' : ''}<br><small class="url" title="${esc(r.url)}">${esc(shortUrl(r.url.replace(/^https?:\/\/[^/]+/, '') || '/', 50))}</small></td>${r.metrics
    ? `<td><span class="chip ${GR[r.grade]?.[0] ?? 'info'}">${GR[r.grade]?.[1] ?? '—'}</span></td>${CMP_COLS.map(([k, , get]) => cell(k, get(r.metrics), ok.length > 1 && get(r.metrics) === best[k])).join('')}
<td class="r${ok.length > 1 && r.totals.bytes === bestBytes ? ' best' : ''}"><b>${kb(r.totals.bytes)}</b></td><td class="r${ok.length > 1 && r.totals.requests === bestReq ? ' best' : ''}"><b>${r.totals.requests}</b></td><td class="r${ok.length > 1 && r.totals.extServices === bestExt ? ' best' : ''}"><b>${r.totals.extServices}</b></td>${fieldOn ? cwv(r) : ''}`
    : `<td colspan="${fieldOn ? 11 : 10}"><span class="chip bad">не открылась</span> <small>${esc(r.error || '')}</small></td>`}</tr>`).join('');
  const ours = g.rows.find((r) => r.ours);
  const verdict = !g.place ? '<span class="chip bad">нашу страницу не удалось сравнить</span>'
    : g.place === 1 ? `<span class="chip good">${label}: мы быстрее всех</span> по LCP (${fmtMs(ours.metrics.lcp)})`
    : `<span class="chip ${g.place === g.of ? 'bad' : 'warn'}">${label}: ${placeWord(g.place)} место из ${g.of}</span> по LCP — у нас ${fmtMs(ours.metrics.lcp)}, у лидера (${esc(g.best.site)}) ${fmtMs(g.best.metrics.lcp)}${ours.metrics.lcp && g.best.metrics.lcp ? `, в ${(ours.metrics.lcp / g.best.metrics.lcp).toFixed(1).replace('.', ',')} раза дольше` : ''}`;

  // Что видит посетитель на разных сайтах через одно и то же время
  const withFilm = g.rows.filter((r) => r.extras?.filmstrip);
  let film = '';
  if (withFilm.length > 1) {
    const maxLcp = Math.max(...ok.map((r) => r.metrics.lcp ?? 0));
    // Шкала — до появления главного содержимого на самом медленном сайте (не больше 10 моментов)
    const times = [500, 1000, 2000, 3000, 5000, 8000, 13000, 20000, 30000, 45000, 60000].filter((t, i, a) => t <= maxLcp || (i > 0 && a[i - 1] < maxLcp)).slice(-10);
    const mobile = withFilm[0].extras.filmstrip.mobile;
    film = `<p class="muted" style="margin:12px 0 4px">Что видит посетитель на каждом сайте через одно и то же время (кадры первого прогона):</p>
<div class="vs" style="grid-template-columns:auto repeat(${times.length},max-content);--fw:${mobile ? 64 : 120}px;--fh:${mobile ? 130 : 68}px">
<div></div>${times.map((t) => `<div class="t">${t < 1000 ? `${t} мс` : `${t / 1000} с`}</div>`).join('')}
${withFilm.map((r) => `<div class="site">${esc(r.site)}${r.ours ? ' (мы)' : ''}</div>${times.map((t) => {
      const f = frameAt(r.extras.filmstrip, t);
      return f ? `<img src="data:image/jpeg;base64,${f}" alt="${esc(r.site)} через ${t} мс">` : '<div class="none"></div>';
    }).join('')}`).join('\n')}
</div>`;
  }
  return `<p>${verdict}</p>
<div class="tbl"><table><thead><tr><th>Сайт</th><th>Оценка</th>${CMP_COLS.map(([, n]) => `<th class="r">${n}</th>`).join('')}<th class="r">Вес</th><th class="r">Запросов</th><th class="r">Внешних сервисов</th>${fieldOn ? '<th>Реальные посетители</th>' : ''}</tr></thead><tbody>${rows}</tbody></table></div>${film}`;
}

// runs: [{ name, label, competitors }] — один профиль или оба (общий отчёт)
export function competitorsSection(runs) {
  const withData = runs.filter((r) => r.competitors?.length);
  if (!withData.length) return '';
  const names = [...new Set(withData.flatMap((r) => r.competitors.map((g) => g.name)))];
  return `<h2>Сравнение с конкурентами</h2>
<p class="muted">Похожие страницы конкурентов из файла <code>competitors.txt</code> замерены в той же проверке и в тех же условиях, что и наши (медиана прогонов, без углублённых тестов). ★ — лучшее значение в колонке; место — по LCP, времени показа главного содержимого.</p>
${names.map((n) => `<h3>${esc(n)}</h3>${withData.map((r) => { const g = r.competitors.find((x) => x.name === n); return g ? groupTable(g, r.label) : ''; }).join('')}`).join('')}`;
}

// ── Тестовый контур против прода ───────────────────────────────────────────
const PROD_COLS = [['ttfb', 'TTFB'], ['fcp', 'FCP'], ['lcp', 'LCP'], ['tbt', 'TBT'], ['cls', 'CLS'], ['load', 'Полная загрузка']];
const VERDICT_PROD = { slower: ['bad', 'медленнее прода'], same: ['good', 'на уровне прода'], faster: ['good', 'быстрее прода'], na: ['info', 'не удалось сравнить'] };

function prodBlock(x, label) {
  const v = (k, m) => (m[k] == null ? (k === 'load' ? 'не наступила' : '—') : k === 'cls' ? m[k] : fmtMs(m[k]));
  const head = `<p><b>${esc(x.page.replace(/^https?:\/\/[^/]+/, '') || '/')}</b>${label ? ` · ${esc(label)}` : ''} — <span class="chip ${VERDICT_PROD[x.verdict][0]}">${VERDICT_PROD[x.verdict][1]}</span>${x.verdict === 'slower' ? ` LCP +${fmtMs(x.delta.lcp.d)}` : ''}${x.worse?.length && x.verdict !== 'slower' ? ` <small class="txt-bad">но хуже: ${x.worse.map((k) => PROD_COLS.find((c) => c[0] === k)[1]).join(', ')}</small>` : ''}</p>`;
  if (!x.test.metrics || !x.prod.metrics) {
    return `${head}<p class="muted">${!x.test.metrics ? `Тестовая страница не открылась: ${esc(x.test.error || '')}` : `Прод-страница ${esc(x.prodUrl)} не открылась: ${esc(x.prod.error || '')}`}</p>`;
  }
  const row = (name, r, cls = '') => `<tr class="${cls}"><td><b>${name}</b><br><small class="url">${esc(shortUrl(r.url, 60))}</small></td>${PROD_COLS.map(([k]) => `<td class="r"><b>${v(k, r.metrics)}</b></td>`).join('')}<td class="r">${kb(r.totals.bytes)}</td><td class="r">${r.totals.requests}</td><td class="r">${r.totals.extServices}</td></tr>`;
  const diff = (k) => {
    const d = x.delta[k];
    if (!d) return '<td class="r">—</td>';
    const txt = k === 'cls' ? Math.abs(d.d).toFixed(3) : fmtMs(Math.abs(d.d));
    return `<td class="r"><span class="${!d.sig ? 'd-none' : d.d > 0 ? 'd-bad' : 'd-good'}">${d.d > 0 ? '+' : '−'}${txt}</span></td>`;
  };
  const dn = (a, b, f) => { const d = a - b; return `<td class="r"><span class="d-none">${d > 0 ? '+' : d < 0 ? '−' : ''}${f(Math.abs(d))}</span></td>`; };
  // Кадры теста и прода в одни и те же моменты
  const films = [['тест', x.test], ['прод', x.prod]].filter(([, r]) => r.extras?.filmstrip);
  let film = '';
  if (films.length === 2) {
    const maxLcp = Math.max(x.test.metrics.lcp ?? 0, x.prod.metrics.lcp ?? 0);
    const times = [500, 1000, 2000, 3000, 5000, 8000, 13000, 20000, 30000, 45000, 60000].filter((t, i, a) => t <= maxLcp || (i > 0 && a[i - 1] < maxLcp)).slice(-10);
    const mobile = films[0][1].extras.filmstrip.mobile;
    film = `<div class="vs" style="margin-top:8px;grid-template-columns:auto repeat(${times.length},max-content);--fw:${mobile ? 64 : 120}px;--fh:${mobile ? 130 : 68}px">
<div></div>${times.map((t) => `<div class="t">${t < 1000 ? `${t} мс` : `${t / 1000} с`}</div>`).join('')}
${films.map(([n, r]) => `<div class="site">${n}</div>${times.map((t) => { const f = frameAt(r.extras.filmstrip, t); return f ? `<img src="data:image/jpeg;base64,${f}" alt="${n} через ${t} мс">` : '<div class="none"></div>'; }).join('')}`).join('\n')}
</div>`;
  }
  return `${head}<div class="tbl"><table><thead><tr><th></th>${PROD_COLS.map(([, n]) => `<th class="r">${n}</th>`).join('')}<th class="r">Вес</th><th class="r">Запросов</th><th class="r">Внешних сервисов</th></tr></thead><tbody>
${row('Тест', x.test, 'ours')}${row('Прод', x.prod)}
<tr><td><small>Разница</small></td>${PROD_COLS.map(([k]) => diff(k)).join('')}${dn(x.test.totals.bytes, x.prod.totals.bytes, kb)}${dn(x.test.totals.requests, x.prod.totals.requests, String)}${dn(x.test.totals.extServices, x.prod.totals.extServices, String)}</tr>
</tbody></table></div>${film}`;
}

// runs: [{ name, label, prodCompare }] — один профиль или оба (общий отчёт)
export function prodSection(runs) {
  const withData = runs.filter((r) => r.prodCompare?.length);
  if (!withData.length) return '';
  const all = withData.flatMap((r) => r.prodCompare);
  const slower = all.filter((x) => x.verdict === 'slower').length;
  const pages = [...new Set(all.map((x) => x.page))];
  return `<h2>Тест против прода</h2>
<p>${slower ? `<span class="chip bad">Медленнее прода: ${slower} из ${all.length}</span>` : '<span class="chip good">Медленнее прода нет</span>'} · сравнено ${withData.length > 1 ? `замеров страниц: ${all.length} (оба разрешения)` : `страниц: ${all.length}`}</p>
<p class="muted">Те же пути на прод-домене замерены в этой же проверке и в тех же условиях (прод — без углублённых тестов). Красным — заметно хуже прода, зелёным — заметно лучше, серым — в пределах обычного разброса замеров. Учтите: тестовые серверы часто слабее прода и без CDN — важнее, чтобы разница не росла от релиза к релизу.</p>
${pages.map((pg) => withData.map((r) => { const x = r.prodCompare.find((y) => y.page === pg); return x ? prodBlock(x, withData.length > 1 ? r.label : '') : ''; }).join('')).join('')}`;
}
