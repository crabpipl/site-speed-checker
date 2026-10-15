// HTML-отчёт: сводка, влияние на SEO/UX, детализация по страницам, вердикты по внешним сервисам.
import { grade, fmtMs, kb, shortUrl, PHASE_LABEL, isError } from './analyze.js';
import {
  EXTRA_CSS, deltaBadge, compareSection, blockTestSection, lcpSection, serverSection,
  coverageSection, imagesSection, clsSection, fontsDomSection, seoSection, warmSection, interactionsSection, fieldSection, fieldKeyHint, filmstripSection, budgetSection, competitorsSection, prodSection,
} from './report-extras.js';
import { fieldGrade } from './crux.js';
import { BUDGET_KEYS } from './budgets.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const GRADE_LABEL = { good: 'Хорошо', ni: 'Требует улучшения', poor: 'Плохо', na: '—' };
const PRIO_LABEL = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };
const VERDICT = {
  disable: ['bad', 'Отключить или починить'],
  defer: ['warn', 'Загружать отложенно'],
  review: ['info', 'Проверить'],
  ok: ['good', 'Оставить'],
};
const CLS_CHIP = {
  ok: 'good', empty: 'info', redirect: 'warn', other: 'info',
  client: 'bad', server: 'bad', failed: 'bad', pending: 'bad', aborted: 'warn', inflight: 'info',
};

function metricCell(key, v, range, cmpRow) {
  const g = grade(key, v);
  const txt = key === 'cls' ? (v ?? '—') : v == null && key === 'load' ? 'не наступил' : fmtMs(v);
  const r = range && range[0] !== range[1] && key !== 'cls' ? `<small>${fmtMs(range[0])}–${fmtMs(range[1])}</small>` : '';
  return `<td class="m ${g}"><b>${txt}</b>${r}${deltaBadge(cmpRow, key)}</td>`;
}
const cmpRowOf = (compare, page) => compare?.rows.find((r) => r.page === page);

function waterfall(p) {
  const m = p.repMetrics;
  const st = (r) => (r.status === 'FAILED' ? r.statusText.replace('net::', '') : r.status);
  const pick = p.resources
    .filter((r) => r.critical || r.slow || !['ok', 'inflight'].includes(r.cls) || r.cpu > 50)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 45)
    .sort((a, b) => a.start - b.start);
  // Шкала по 90-му перцентилю окончаний: одиночный зависший запрос не должен сжимать весь график
  const ends = pick.map((r) => r.end).sort((a, b) => a - b);
  const p80 = ends[Math.floor(ends.length * 0.8)] ?? m.observed;
  const span = Math.min(Math.max(m.observed, ...ends), Math.max(p80 * 1.25, (m.lcp ?? 0) * 1.3, (m.dcl ?? 0) * 1.3, 3000)) || 1;
  const pct = (v) => Math.max(0, Math.min(100, (v / span) * 100)).toFixed(2);
  const marks = [['TTFB', m.ttfb], ['FCP', m.fcp], ['LCP', m.lcp], ['DCL', m.dcl], ['load', m.load ?? null]]
    .filter(([, v]) => v != null)
    .map(([n, v], i) => v > span
      ? `<div class="mark out" style="left:100%;top:${(i % 4) * 11}px"><span>${n} ${fmtMs(v)} →</span></div>`
      : `<div class="mark" style="left:${pct(v)}%"><span style="top:${(i % 4) * 11}px">${n} ${fmtMs(v)}</span></div>`).join('');
  const rows = pick.map((r) => {
    const cls = isError(r.cls) ? 'bad' : !['ok', 'inflight'].includes(r.cls) ? 'warn' : r.slow ? 'slow' : r.internal ? 'int' : 'ext';
    return `<div class="wf-row" title="${esc(r.url)}">
      <div class="wf-label"><span class="tag ${r.internal ? 'tint' : 'text'}">${r.internal ? 'свой' : 'внеш'}</span>${esc(r.internal ? r.type : r.service)} <small>${esc(shortUrl(r.url.replace(/^https?:\/\//, ''), 60))}</small></div>
      <div class="wf-track">${r.start >= span
        ? `<div class="wf-bar ${cls} clip" style="left:calc(100% - 8px);width:8px"></div>
      <span class="wf-time" style="right:12px">старт ${fmtMs(r.start)} · ${fmtMs(r.duration)}${r.cls !== 'ok' ? ' · ' + st(r) : ''} →</span></div>`
        : `<div class="wf-bar ${cls}${r.end > span ? ' clip' : ''}" style="left:${pct(r.start)}%;width:max(2px,${(pct(r.end) - pct(r.start)).toFixed(2)}%)"></div>
      <span class="wf-time" style="${r.end > span * 0.8 ? 'right:4px' : `left:calc(${pct(r.end)}% + 4px)`}">${fmtMs(r.duration)}${r.cls !== 'ok' ? ' · ' + st(r) : ''}${r.end > span ? ` → до ${fmtMs(r.end)}` : ''}</span></div>`}
    </div>`;
  }).join('');
  return `<div class="wf"><div class="wf-head"><div class="wf-label"></div><div class="wf-track">${marks}</div></div>${rows}
    <div class="legend"><span><i class="int"></i>свои</span><span><i class="ext"></i>внешние</span><span><i class="slow"></i>≥ порога медленности</span><span><i class="warn"></i>не 200 (редирект/204)</span><span><i class="bad"></i>ошибка / нет ответа</span>${m.observed > span ? `<span>Шкала обрезана на ${fmtMs(span)}; полоски, уходящие в прозрачность, и строки со стрелкой → продолжаются дальше</span>` : ''}</div></div>`;
}

function resTable(rows, { showService }) {
  if (!rows.length) return '<p class="muted">Нет данных.</p>';
  return `<div class="tbl"><table><thead><tr>${showService ? '<th>Сервис</th>' : ''}<th>Тип</th><th>Статус</th><th class="r">Время</th><th class="r">Старт</th><th class="r">Размер</th><th class="r">CPU</th><th>Влияние</th><th>URL</th></tr></thead><tbody>
  ${rows.map((r) => `<tr class="${r.slow && r.critical ? 'hl' : ''}">
    ${showService ? `<td>${esc(r.service)}<br><small class="muted">${esc(r.category)}</small></td>` : ''}
    <td>${esc(r.type)}</td>
    <td><span class="chip ${CLS_CHIP[r.cls]}">${esc(r.status)}</span></td>
    <td class="r ${r.slow ? 'txt-bad' : ''}"><b>${fmtMs(r.duration)}</b></td>
    <td class="r">${fmtMs(r.start)}</td>
    <td class="r">${kb(r.bytes)}</td>
    <td class="r">${r.cpu ? fmtMs(r.cpu) : '—'}</td>
    <td><small>${PHASE_LABEL[r.phase]}${r.renderBlocking ? ' ⚠' : ''}</small></td>
    <td class="url" title="${esc(r.url)}">${esc(shortUrl(r.url, 110))}</td></tr>`).join('')}
  </tbody></table></div>`;
}

function pageSection(p, i, opts, pfx = '') {
  if (p.error && !p.metrics) {
    return `<details class="page" id="${pfx}p${i}"><summary><span class="chip bad">Ошибка</span> ${esc(p.page)}</summary><p>${esc(p.error)}</p></details>`;
  }
  const m = p.metrics;
  const int = p.resources.filter((r) => r.internal && ['script', 'stylesheet', 'xhr', 'fetch', 'document', 'font'].includes(r.type))
    .sort((a, b) => b.duration - a.duration);
  const ext = p.resources.filter((r) => !r.internal).sort((a, b) => b.duration - a.duration);
  const slow200 = p.resources.filter((r) => r.cls === 'ok' && r.duration >= opts.slow / 2).sort((a, b) => b.duration - a.duration);
  const svcRows = p.services.filter((s) => !s.internal);

  return `<details class="page" id="${pfx}p${i}" ${p.grade === 'poor' ? 'open' : ''}>
  <summary><span class="chip ${p.grade === 'good' ? 'good' : p.grade === 'ni' ? 'warn' : 'bad'}">${GRADE_LABEL[p.grade]}</span> ${esc(p.page)}</summary>

  <div class="kpis">
    ${[['TTFB', 'ttfb'], ['FCP', 'fcp'], ['LCP', 'lcp'], ['TBT', 'tbt'], ['CLS', 'cls'], ['Load', 'load']].map(([n, k]) =>
      `<div class="kpi ${grade(k, m[k])}"><div class="kl">${n}</div><div class="kv">${k === 'cls' ? m[k] : k === 'load' && m[k] == null ? 'не наступил' : fmtMs(m[k])}</div></div>`).join('')}
    <div class="kpi"><div class="kl">DOMContentLoaded</div><div class="kv">${fmtMs(m.dcl)}</div></div>
    <div class="kpi"><div class="kl">Запросов / вес</div><div class="kv">${p.totals.requests} / ${kb(p.totals.bytes)}</div></div>
    <div class="kpi"><div class="kl">Внешних сервисов</div><div class="kv">${p.totals.extServices} <small>(${p.totals.extDomains} доменов)</small></div></div>
    <div class="kpi"><div class="kl">JS на CPU</div><div class="kv">${fmtMs(p.totals.cpu)}</div></div>
  </div>
  ${p.loadMissing ? `<p class="note">Событие load не наступило в ${p.loadMissing} из ${p.okRuns} прогонов (лимит ${fmtMs(opts.timeout)}).</p>` : ''}
  ${p.lcpElement ? `<p class="muted">Элемент LCP: <code>&lt;${esc(p.lcpElement)}&gt;</code>${p.lcpUrl ? ` — ${esc(shortUrl(p.lcpUrl, 100))}` : ''}</p>` : ''}

  <h3>Итоги и рекомендации</h3>
  ${p.recs.length ? `<ol class="recs">${p.recs.map((r) => `<li class="${r.prio}"><span class="chip ${r.prio === 'high' ? 'bad' : r.prio === 'medium' ? 'warn' : 'info'}">${PRIO_LABEL[r.prio]}</span> <b>${esc(r.title)}</b>
    <p>${esc(r.detail)}</p>${r.items?.length ? `<ul>${r.items.slice(0, 8).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>${r.items.length > 8 ? `<details class="sub"><summary>ещё ${r.items.length - 8}</summary><ul>${r.items.slice(8).map((x) => `<li>${esc(x)}</li>`).join('')}</ul></details>` : ''}` : ''}</li>`).join('')}</ol>` : '<p>Серьёзных проблем не найдено.</p>'}

  ${fieldSection(p)}
  ${filmstripSection(p)}
  ${blockTestSection(p)}
  ${warmSection(p)}
  ${interactionsSection(p)}
  ${lcpSection(p)}
  ${serverSection(p)}

  <h3>Таймлайн загрузки</h3>
  <p class="muted">Ресурсы на критическом пути, медленные, с ошибками и нагружающие процессор (медианный прогон). Наведите на строку, чтобы увидеть полный URL.</p>
  ${waterfall(p)}

  <h3>Ответы не 200 и сколько их ждали</h3>
  ${p.errors.length ? `<div class="tbl"><table><thead><tr><th>Источник</th><th>Тип</th><th>Статус</th><th class="r">Ожидание (медиана)</th><th class="r">Макс.</th><th class="r">Прогонов</th><th>Влияние</th><th>URL</th></tr></thead><tbody>
    ${p.errors.map((e) => `<tr><td>${e.internal ? '<b>Свой</b>' : esc(e.service)}</td><td>${esc(e.type)}</td>
      <td><span class="chip ${CLS_CHIP[e.cls]}">${esc(e.status)}</span> <small>${esc(e.statusText)}</small></td>
      <td class="r"><b>${fmtMs(e.wait)}</b></td><td class="r">${fmtMs(e.waitMax)}</td><td class="r">${e.runs}/${p.okRuns}</td>
      <td><small>${e.phases.map((x) => PHASE_LABEL[x]).join(', ')}</small></td>
      <td class="url" title="${esc(e.url)}">${esc(shortUrl(e.url, 100))}</td></tr>`).join('')}
  </tbody></table></div>
  <p class="muted">Красные — ошибки и отсутствие ответа. Жёлтые — редиректы (лишний сетевой круг) и ERR_ABORTED (запрос отменила сама страница). Синие — 204 (пустой ответ, обычен для пикселей статистики).</p>` : '<p>Все ресурсы ответили 200.</p>'}

  <h3>Самые долгие ответы 200 OK</h3>
  <p class="muted">Ресурсы с ответом 200 дольше ${fmtMs(opts.slow / 2)}. Подсвечены те, что ≥ ${fmtMs(opts.slow)} и при этом находятся на критическом пути — именно они могли задерживать загрузку страницы.</p>
  ${resTable(slow200.slice(0, 30), { showService: true })}

  <h3>Внешние сервисы на странице</h3>
  <div class="tbl"><table><thead><tr><th>Сервис</th><th>Категория</th><th class="r">Запросов</th><th class="r">Макс. время</th><th class="r">Вес</th><th class="r">CPU</th><th class="r">Ошибок</th><th class="r">Медл. на крит. пути</th><th>Домены</th></tr></thead><tbody>
  ${svcRows.map((s) => `<tr><td><b>${esc(s.service)}</b></td><td>${esc(s.category)}</td><td class="r">${s.requests}</td>
    <td class="r ${s.maxDuration >= opts.slow ? 'txt-bad' : ''}">${fmtMs(s.maxDuration)}</td><td class="r">${kb(s.bytes)}</td><td class="r">${s.cpu ? fmtMs(s.cpu) : '—'}</td>
    <td class="r ${s.errors ? 'txt-bad' : ''}">${s.errors || '—'}</td><td class="r ${s.slowCritical ? 'txt-bad' : ''}">${s.slowCritical || '—'}</td>
    <td><small>${esc(s.hosts.join(', '))}</small></td></tr>`).join('')}
  </tbody></table></div>

  <h3>Процессорное время JavaScript по скриптам</h3>
  <div class="tbl"><table><thead><tr><th>Источник</th><th class="r">CPU</th><th>Скрипт</th></tr></thead><tbody>
  ${p.cpuTop.map((c) => `<tr><td>${c.internal ? '<b>Свой</b>' : esc(c.service)}</td><td class="r">${fmtMs(c.ms)}</td><td class="url" title="${esc(c.url)}">${esc(shortUrl(c.url, 120))}</td></tr>`).join('')}
  </tbody></table></div>
  <p class="muted">Время, когда скрипт выполнялся на основном потоке браузера. Инлайн-код из HTML учитывается по URL самой страницы.</p>

  ${coverageSection(p)}
  ${imagesSection(p)}
  ${clsSection(p)}
  ${fontsDomSection(p)}
  ${seoSection(p)}

  <details class="sub"><summary>Все собственные скрипты, стили и запросы к API (${int.length})</summary>${resTable(int, { showService: false })}</details>
  <details class="sub"><summary>Все внешние запросы (${ext.length})</summary>${resTable(ext, { showService: true })}</details>
</details>`;
}

const STYLE = `<style>
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--good:#1a7f4b;--good-bg:#e3f4ea;--warn:#a15c00;--warn-bg:#fdf0d9;--bad:#b42318;--bad-bg:#fde7e4;--info:#2457a6;--info-bg:#e5edfa;--int:#5b6fd6;--ext:#9a9a92;--slow:#e08a00;--hl:#fff8e6}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#151514;--card:#1f1f1d;--fg:#ecebe6;--muted:#a3a29b;--line:#34332f;--good:#4cc38a;--good-bg:#173526;--warn:#f0b04a;--warn-bg:#3a2c12;--bad:#ff7b6b;--bad-bg:#3d1c18;--info:#7aa7f0;--info-bg:#1a2740;--int:#8796ee;--ext:#77776f;--slow:#f0a020;--hl:#2e2715}}
*{box-sizing:border-box}a{color:var(--info)}td.url a{color:var(--fg);text-decoration-color:var(--muted);text-underline-offset:2px}td.url a:hover{color:var(--info)}p,li{overflow-wrap:anywhere}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:1280px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:20px;margin:36px 0 12px}h3{font-size:16px;margin:28px 0 8px}
.muted{color:var(--muted)}small{color:var(--muted)}code{font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px 18px;margin:12px 0}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}.stat .v{font-size:24px;font-weight:650}.stat .l{color:var(--muted);font-size:12px}
.chip{display:inline-block;padding:1px 8px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap}
.chip.good{background:var(--good-bg);color:var(--good)}.chip.warn{background:var(--warn-bg);color:var(--warn)}.chip.bad{background:var(--bad-bg);color:var(--bad)}.chip.info{background:var(--info-bg);color:var(--info)}
.tbl{overflow-x:auto;border:1px solid var(--line);border-radius:10px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{padding:7px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-weight:600;color:var(--muted);font-size:12px;white-space:nowrap;background:var(--card);position:sticky;top:0}
tr:last-child td{border-bottom:0}.r{text-align:right;white-space:nowrap}td.url{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;word-break:break-all;min-width:260px}
tr.hl td{background:var(--hl)}.txt-bad{color:var(--bad)}
td.m b{display:block;white-space:nowrap}td.m small{font-size:11px;white-space:nowrap}td.m.good b{color:var(--good)}td.m.ni b{color:var(--warn)}td.m.poor b{color:var(--bad)}
details.page{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:0 18px;margin:12px 0}
details.page>summary{cursor:pointer;padding:14px 0;font-weight:600;font-size:15px;word-break:break-all}
details.sub{margin:14px 0}details.sub>summary{cursor:pointer;color:var(--info);margin-bottom:8px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:8px;margin:4px 0 12px}
.kpi{border:1px solid var(--line);border-radius:8px;padding:8px 10px}.kpi .kl{font-size:11px;color:var(--muted)}.kpi .kv{font-weight:650;font-size:17px}
.kpi.good .kv{color:var(--good)}.kpi.ni .kv{color:var(--warn)}.kpi.poor .kv{color:var(--bad)}
.note{background:var(--warn-bg);color:var(--warn);padding:8px 12px;border-radius:8px}
ol.recs{padding-left:20px}ol.recs>li{margin:0 0 14px}ol.recs p{margin:4px 0}ol.recs ul{margin:4px 0;padding-left:18px;font-size:13px;word-break:break-all}
.wf{border:1px solid var(--line);border-radius:10px;padding:8px 10px;overflow-x:auto}
.wf-row,.wf-head{display:grid;grid-template-columns:minmax(220px,32%) 1fr;gap:8px;align-items:center;min-width:720px}
.wf-row{border-top:1px solid var(--line);padding:3px 0;font-size:12px}.wf-label{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
.wf-label small{font-family:ui-monospace,Menlo,monospace;font-size:10.5px}
.wf-track{position:relative;height:18px}.wf-head .wf-track{height:46px}
.wf-bar{position:absolute;top:4px;height:10px;border-radius:3px}.wf-time{position:absolute;top:1px;font-size:11px;color:var(--muted);white-space:nowrap;background:var(--card);padding:0 4px;border-radius:3px;z-index:1}
.wf-bar.int,.legend i.int{background:var(--int)}.wf-bar.ext,.legend i.ext{background:var(--ext)}.wf-bar.slow,.legend i.slow{background:var(--slow)}.wf-bar.warn,.legend i.warn{background:var(--warn)}.wf-bar.bad,.legend i.bad{background:var(--bad)}
.mark{position:absolute;top:0;bottom:-2000px;border-left:1px dashed var(--muted);pointer-events:none}.mark span{position:absolute;top:0;left:3px;font-size:10.5px;color:var(--muted);white-space:nowrap;background:var(--card)}
.wf{position:relative}.wf .mark{bottom:auto;height:46px}.mark.out{border:0}.mark.out span{left:auto;right:0}
.wf-bar.clip{border-top-right-radius:0;border-bottom-right-radius:0;-webkit-mask-image:linear-gradient(90deg,#000 85%,transparent)}
.tag{display:inline-block;font-size:10px;padding:0 5px;border-radius:4px;margin-right:6px}.tag.tint{background:var(--info-bg);color:var(--info)}.tag.text{background:var(--line);color:var(--muted)}
.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--muted);margin-top:8px}.legend i{display:inline-block;width:12px;height:8px;border-radius:2px;margin-right:5px}
.why{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:12px}.why h4{margin:0 0 6px}.why p{margin:0 0 6px}
${EXTRA_CSS}</style>`;

const WHY = `<h2>Почему это важно</h2>
<div class="why">
  <div class="card"><h4>SEO: Google</h4>
    <p>Core Web Vitals (LCP, INP, CLS) — часть сигналов Page Experience, которые Google учитывает при ранжировании; индексация идёт по мобильной версии. Пороги «хорошо»: LCP ≤ 2,5 с, INP ≤ 200 мс, CLS ≤ 0,1 для 75% реальных визитов.</p>
    <p class="muted">Ранжирование идёт по полевым данным реальных посетителей Chrome (Chrome UX Report) — они в разделе «Реальные посетители», если подключён ключ. Лабораторный замер нужен, чтобы найти причины. TTFB и FCP — диагностические метрики: они объясняют, почему плохой LCP.</p></div>
  <div class="card"><h4>SEO: Яндекс</h4>
    <p>Яндекс учитывает поведенческие факторы: отказы, время на сайте, возвраты в выдачу. Медленная страница чаще закрывается до загрузки — это засчитывается как неудовлетворённый визит и тянет позиции вниз.</p></div>
  <div class="card"><h4>Опыт клиента и конверсия</h4>
    <p>По исследованию Google (2017, мобильные страницы) вероятность отказа растёт на 32% при увеличении времени загрузки с 1 до 3 секунд и на 90% — до 5 секунд. Для каталога и карточки товара это прямые потери заказов и рекламного бюджета.</p>
    <p class="muted">Внешний скрипт, который упал или завис, может держать индикатор загрузки и блокировать работу других скриптов — клиент видит «сломанный» сайт, хотя сервер сайта в порядке.</p></div>
</div>`;

const methodNote = (opts) => `<h2>Как проводился замер</h2>
<div class="card"><p>Каждая страница открывалась в Chromium ${opts.runs} раз(а) в чистом профиле (без кэша и cookies). Записывались все сетевые запросы с таймингами и статусами, метрики браузера (Navigation Timing, Paint, LCP, Layout Shift, Long Tasks) и профиль процессора для оценки времени выполнения JS по каждому скрипту. Детализация ресурсов — по медианному прогону, ошибки собраны по всем прогонам.</p>
<p>Дополнительно для каждой страницы: ${opts.blocktest !== false ? `прогоны с заблокированными внешними сервисами (все сразу — ${opts.blockRuns ?? 2} раза, самые тяжёлые по одному — по разу); ` : ''}${opts.inp !== false ? 'тест отклика на нажатия типовых элементов (INP в лабораторном замере); ' : ''}${opts.warm !== false ? `повторный визит в том же браузере после прогрева кэша (${opts.warmRuns ?? 2} замера); ` : ''}${opts.coverage !== false ? 'отдельный прогон для замера неиспользуемого JS/CSS (без замедления сети и процессора); ' : ''}${opts.filmstrip !== false ? 'запись кадров экрана в первом прогоне (раскадровка); ' : ''}анализ картинок, шрифтов и размера DOM; источники сдвигов вёрстки по всем прогонам${opts.seo !== false ? '; запрос HTML без выполнения JS от имени браузера, Googlebot и YandexBot и проверка robots.txt' : ''}. Изменения сравниваются с предыдущей проверкой того же разрешения.</p>
<p>«Свои» ресурсы — домен сайта и его поддомены${opts.internalNote ? ` (а также ${esc(opts.internalNote)})` : ''}; всё остальное — внешние сервисы. «Критический путь» — ресурсы, загрузка которых завершилась до DOMContentLoaded/load или которые блокируют отрисовку.</p>
${opts.cruxState === 'on' ? '<p>Данные реальных посетителей — из Chrome UX Report (CrUX API): 75-й перцентиль за последние 28 дней по визитам из Chrome на устройствах того же типа (компьютеры или смартфоны), по странице или, если у неё мало визитов, по сайту в целом; динамика — по неделям за полгода.</p>' : ''}
<p class="muted">Это лабораторный замер с одного компьютера и одной сети. Google ранжирует по полевым данным реальных пользователей (CrUX), они могут отличаться. Полезно сравнивать замеры в динамике и после каждого изменения.</p></div>`;

const page = (title, body) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
${STYLE}</head><body><main>
${body}
</main></body></html>`;

const TEST_CHIP = '<span class="chip warn">тестовый контур</span> ';
const runLine = (r) => `${r.opts?.test ? TEST_CHIP : ''}${esc(r.profile.label)} · ${r.opts.runs} прогон(а) на страницу, холодный кэш · ${esc(r.startedAt.toLocaleString('ru-RU'))} — ${esc(r.finishedAt.toLocaleTimeString('ru-RU'))} · порог «медленного» ресурса ${fmtMs(r.opts.slow)}`;

// Результаты одного профиля (десктоп или мобильный): сводка, сервисы, детализация
function profileBody({ pages, services, opts, compare, profile, competitors, prodCompare }, pfx = '', { budget = true } = {}) {
  const noext = (p) => p.extras?.blockTest?.rows.find((r) => r.key === 'noext' && !r.error);
  const inpOf = (p) => (p.extras?.interactions && !p.extras.interactions.error ? p.extras.interactions.inp : undefined);
  const inpCell = (v) => (v === undefined ? '<td class="m"><small>—</small></td>' : `<td class="m ${v == null || v <= 200 ? 'good' : v <= 500 ? 'ni' : 'poor'}"><b>${v == null ? '< 16 мс' : fmtMs(v)}</b></td>`);
  const warm = (p) => (p.extras?.warm && !p.extras.warm.error ? p.extras.warm : null);
  const field = (p) => (p.extras?.field?.level ? p.extras.field : null);
  const fieldOn = pages.some((p) => p.extras?.field);
  const fieldCell = (p) => {
    const f = field(p);
    if (!f) return `<td class="m"><small>${p.extras?.field?.error ? 'ошибка' : 'мало данных'}</small></td>`;
    const v = (k) => (f.metrics[k]?.p75 == null ? '—' : `<span class="${fieldGrade(k, f.metrics[k].p75) === 'good' ? 'd-good' : 'd-bad'}">${k === 'cls' ? f.metrics[k].p75 : fmtMs(f.metrics[k].p75)}</span>`);
    return `<td class="m"><b>${v('lcp')} / ${v('inp')} / ${v('cls')}</b><small>${f.level === 'url' ? 'страница' : 'весь сайт'}${f.cwvPass == null ? '' : f.cwvPass ? ' · CWV ✓' : ' · CWV ✗'}</small></td>`;
  };
  const budgetOn = pages.some((p) => p.budget);
  const budgetCell = (p) => (!p.budget ? '<td class="r">—</td>' : p.budget.over.length
    ? `<td class="r"><span class="chip ${p.budget.over.some((o) => o.status === 'new') ? 'bad' : 'warn'}" title="${esc(p.budget.over.map((o) => BUDGET_KEYS[o.key].label.split(' — ')[0]).join(', '))}">вне: ${p.budget.over.length}</span></td>` : '<td class="r"><span class="chip good">ОК</span></td>');
  const seoBad = (p) => p.extras?.seo?.checks.filter((c) => c.level === 'bad').length ?? null;
  const cnt = (g) => pages.filter((p) => p.grade === g).length;
  const toDisable = services.filter((s) => s.verdict === 'disable');
  const toDefer = services.filter((s) => s.verdict === 'defer');
  return `<div class="grid">
  <div class="stat"><div class="v">${pages.length}</div><div class="l">страниц проверено</div></div>
  <div class="stat"><div class="v" style="color:var(--bad)">${cnt('poor')}</div><div class="l">в плохом состоянии</div></div>
  <div class="stat"><div class="v" style="color:var(--warn)">${cnt('ni')}</div><div class="l">требуют улучшения</div></div>
  <div class="stat"><div class="v" style="color:var(--good)">${cnt('good')}</div><div class="l">в норме</div></div>
  <div class="stat"><div class="v" style="color:var(--bad)">${toDisable.length}</div><div class="l">внешних сервисов отключить/починить</div></div>
  <div class="stat"><div class="v" style="color:var(--warn)">${toDefer.length}</div><div class="l">сервисов стоит грузить отложенно</div></div>
</div>
${fieldKeyHint(opts)}
${budget ? prodSection([{ name: 'p', label: profile?.label ?? '', prodCompare }]) : ''}
${budget ? budgetSection([{ name: 'p', label: profile?.label ?? '', pages }]) : ''}
${budget ? competitorsSection([{ name: 'p', label: profile?.label ?? '', competitors }]) : ''}

<h2>Сводка по страницам</h2>
<div class="tbl"><table><thead><tr><th>Страница</th><th>Оценка</th><th>TTFB</th><th>FCP</th><th>LCP</th><th>TBT</th><th>CLS</th><th>DOMContentLoaded</th><th>Load</th><th>Отклик (INP)</th>${fieldOn ? '<th>Реальные посетители: LCP / INP / CLS</th>' : ''}<th>Повторный визит: LCP / Load</th><th>Без внешних: LCP / Load</th><th class="r">Запросов</th><th class="r">Вес</th><th class="r">Внеш. сервисов</th><th class="r">Не 200</th><th class="r">SEO</th>${budgetOn ? '<th class="r">Бюджет</th>' : ''}</tr></thead><tbody>
${pages.map((p, i) => p.metrics ? `<tr><td class="url"><a href="#${pfx}p${i}">${esc(p.page)}</a></td>
  <td><span class="chip ${p.grade === 'good' ? 'good' : p.grade === 'ni' ? 'warn' : 'bad'}">${GRADE_LABEL[p.grade]}</span></td>
  ${['ttfb', 'fcp', 'lcp', 'tbt', 'cls'].map((k) => metricCell(k, p.metrics[k], p.range[k], cmpRowOf(compare, p.page))).join('')}
  <td class="m"><b>${fmtMs(p.metrics.dcl)}</b></td>${metricCell('load', p.metrics.load, p.range.load, cmpRowOf(compare, p.page))}
  ${inpCell(inpOf(p))}${fieldOn ? fieldCell(p) : ''}
  <td class="m">${warm(p) ? `<b>${fmtMs(warm(p).m.lcp)} / ${warm(p).m.load == null ? 'не наступил' : fmtMs(warm(p).m.load)}</b>` : '<small>—</small>'}</td>
  <td class="m">${noext(p) ? `<b>${fmtMs(noext(p).m.lcp)} / ${noext(p).m.loadMissing ? 'не наступил' : fmtMs(noext(p).m.load)}</b>` : '<small>—</small>'}</td>
  <td class="r">${p.totals.requests}</td><td class="r">${kb(p.totals.bytes)}</td><td class="r">${p.totals.extServices}</td>
  <td class="r">${p.errors.filter((e) => isError(e.cls)).length ? `<span class="chip bad">${p.errors.filter((e) => isError(e.cls)).length} ошиб.</span> ` : ''}${p.errors.length}</td>
  <td class="r">${seoBad(p) == null ? '—' : seoBad(p) ? `<span class="chip bad">${seoBad(p)} крит.</span>` : '<span class="chip good">ОК</span>'}</td>${budgetOn ? budgetCell(p) : ''}</tr>`
  : `<tr><td class="url">${esc(p.page)}</td><td><span class="chip bad">Ошибка</span></td><td colspan="${15 + (fieldOn ? 1 : 0) + (budgetOn ? 1 : 0)}">${esc(p.error)}</td></tr>`).join('')}
</tbody></table></div>
<p class="muted">Медиана по прогонам; мелким шрифтом — разброс; ▲/▼ — заметное изменение с прошлой проверки (наведите, чтобы увидеть прежнее значение). Цвет — по порогам Google Core Web Vitals: зелёный хорошо, жёлтый требует улучшения, красный плохо. «Отклик (INP)» — худшее время реакции на нажатия в тесте;${fieldOn ? ' «Реальные посетители» — p75 за 28 дней из Chrome UX Report (зелёный — в норме, красный — нет; CWV ✓ — Core Web Vitals пройдены);' : ''} «Повторный визит» — та же страница при повторном заходе (файлы из кэша браузера); «Без внешних» — с заблокированными внешними сервисами.</p>

<h2>Изменения с прошлой проверки</h2>
${compareSection(compare)}

<h2>Внешние сервисы: что отключить, что отложить</h2>
<div class="tbl"><table><thead><tr><th>Рекомендация</th><th>Сервис</th><th>Категория</th><th>Причина</th><th class="r">Страниц</th><th class="r">Запросов</th><th class="r">Макс. время</th><th class="r">CPU / стр.</th><th class="r">Вес</th></tr></thead><tbody>
${services.map((s) => `<tr><td><span class="chip ${VERDICT[s.verdict][0]}">${VERDICT[s.verdict][1]}</span></td><td><b>${esc(s.service)}</b></td><td>${esc(s.category)}</td>
  <td>${esc(s.reason)}</td><td class="r">${s.pages}</td><td class="r">${s.requests}</td><td class="r">${fmtMs(s.maxDuration)}</td><td class="r">${s.cpuAvg ? fmtMs(s.cpuAvg) : '—'}</td><td class="r">${kb(s.bytes)}</td></tr>`).join('')}
</tbody></table></div>
<p class="muted">Перед отключением уточните у маркетинга, используется ли сервис. «Загружать отложенно» — подключать после события load или по первому взаимодействию (в GTM — триггер «Окно загружено»).</p>

<h2>Детализация по страницам</h2>
${pages.map((p, i) => pageSection(p, i, opts, pfx)).join('')}`;
}

export function renderReport(r) {
  return page(`Скорость загрузки страниц${r.opts?.test ? ': тестовый контур' : ''}`, `<h1>Скорость загрузки страниц${r.opts?.test ? ' — тестовый контур' : ''}</h1>
<p class="muted">${runLine(r)}</p>
${profileBody(r)}
${WHY}
${methodNote(r.opts)}`);
}

const SHORT = { desktop: 'Десктоп', mobile: 'Мобильный' };
const VRANK = { disable: 0, defer: 1, review: 2, ok: 3 };

// Общий отчёт по нескольким профилям: сравнение + вкладки с полной детализацией
export function renderCombined(runs) {
  const pageUrls = [...new Set(runs.flatMap((r) => r.pages.map((p) => p.page)))];
  const keys = [['ttfb', 'TTFB'], ['lcp', 'LCP'], ['tbt', 'TBT'], ['cls', 'CLS'], ['load', 'Load']];
  // Колонка «Посетители» — итог Core Web Vitals по данным Chrome UX Report, если они собирались
  const fieldOn = runs.some((r) => r.pages.some((p) => p.extras?.field));
  const fieldChip = (p) => {
    const f = p.extras?.field;
    if (!f?.level || f.cwvPass == null) return `<td><small class="muted">${f?.error ? 'ошибка' : 'нет данных'}</small></td>`;
    return `<td><span class="chip ${f.cwvPass ? 'good' : 'bad'}" title="LCP ${fmtMs(f.metrics.lcp?.p75)}, INP ${fmtMs(f.metrics.inp?.p75)}, CLS ${f.metrics.cls?.p75 ?? '—'} (${f.level === 'url' ? 'страница' : 'весь сайт'})">${f.cwvPass ? 'CWV ✓' : 'CWV ✗'}</span></td>`;
  };
  const cmpRows = pageUrls.map((u) => `<tr><td class="url">${esc(u)}</td>${runs.map((r) => {
    const p = r.pages.find((x) => x.page === u);
    if (!p?.metrics) return `<td class="sep"><span class="chip bad">Ошибка</span></td>${keys.map(() => '<td></td>').join('')}${fieldOn ? '<td></td>' : ''}`;
    return `<td class="sep"><a href="#${r.name}-p${r.pages.indexOf(p)}" onclick="document.getElementById('t-${r.name}').checked=true"><span class="chip ${p.grade === 'good' ? 'good' : p.grade === 'ni' ? 'warn' : 'bad'}">${GRADE_LABEL[p.grade]}</span></a></td>` +
      keys.map(([k]) => metricCell(k, p.metrics[k], p.range[k], cmpRowOf(r.compare, p.page))).join('') + (fieldOn ? fieldChip(p) : '');
  }).join('')}</tr>`).join('');

  // Сервисы: худший вердикт из профилей
  const svc = new Map();
  for (const r of runs) for (const s of r.services) {
    const g = svc.get(s.service) || { service: s.service, category: s.category, by: {} };
    g.by[r.name] = s;
    svc.set(s.service, g);
  }
  const svcRows = [...svc.values()].map((g) => {
    const worst = Object.values(g.by).sort((a, b) => VRANK[a.verdict] - VRANK[b.verdict])[0];
    return { ...g, worst, maxDuration: Math.max(...Object.values(g.by).map((s) => s.maxDuration)) };
  }).sort((a, b) => VRANK[a.worst.verdict] - VRANK[b.worst.verdict] || b.maxDuration - a.maxDuration);

  const panels = runs.map((r) => `<section class="panel" id="panel-${r.name}"><p class="muted">${runLine(r)}</p>${profileBody(r, r.name + '-', { budget: false })}</section>`).join('');
  const tabCss = `<style>.tab-in{position:absolute;opacity:0}.tabs{display:flex;gap:6px;margin:36px 0 0;position:sticky;top:0;background:var(--bg);padding:8px 0;z-index:5;border-bottom:1px solid var(--line)}
.tab{padding:8px 18px;border:1px solid var(--line);border-radius:8px;cursor:pointer;font-weight:600;background:var(--card)}.panel{display:none}
${runs.map((r) => `#t-${r.name}:checked ~ .tabs label[for=t-${r.name}]{background:var(--fg);color:var(--bg);border-color:var(--fg)}#t-${r.name}:checked ~ #panel-${r.name}{display:block}`).join('')}
td.sep,th.sep{border-left:2px solid var(--line)}</style>`;

  const testMode = runs.some((r) => r.opts?.test);
  return page(`Скорость загрузки: десктоп и мобильный${testMode ? ' (тест)' : ''}`, `${tabCss}<h1>Скорость загрузки страниц: десктоп и мобильный${testMode ? ' — тестовый контур' : ''}</h1>
${runs.map((r) => `<p class="muted">${runLine(r)}</p>`).join('')}

${prodSection(runs.map((r) => ({ name: r.name, label: SHORT[r.name] || r.name, prodCompare: r.prodCompare })))}
${budgetSection(runs.map((r) => ({ name: r.name, label: SHORT[r.name] || r.name, pages: r.pages })))}
${competitorsSection(runs.map((r) => ({ name: r.name, label: SHORT[r.name] || r.name, competitors: r.competitors })))}

<h2>Сравнение по страницам</h2>
<div class="tbl"><table><thead>
<tr><th rowspan="2">Страница</th>${runs.map((r) => `<th class="sep" colspan="${keys.length + 1 + (fieldOn ? 1 : 0)}">${esc(r.profile.label)}</th>`).join('')}</tr>
<tr>${runs.map(() => `<th class="sep">Оценка</th>${keys.map(([, n]) => `<th>${n}</th>`).join('')}${fieldOn ? '<th>Посетители</th>' : ''}`).join('')}</tr>
</thead><tbody>${cmpRows}</tbody></table></div>
<p class="muted">Медиана по прогонам, мелким шрифтом — разброс. Цвет — по порогам Google Core Web Vitals. Google индексирует и ранжирует сайт по мобильной версии, поэтому мобильные значения приоритетнее.${fieldOn ? ' «Посетители» — пройдены ли Core Web Vitals у реальных посетителей Chrome за 28 дней (наведите, чтобы увидеть значения).' : ''}</p>

<h2>Внешние сервисы: итог по обоим разрешениям</h2>
${[svcRows.filter((g) => g.worst.verdict !== 'ok'), svcRows.filter((g) => g.worst.verdict === 'ok')].map((rows, okPart) => !rows.length ? '' : `${okPart ? `<details class="sub"><summary>Сервисы без замечаний (${rows.length})</summary>` : ''}
<div class="tbl"><table><thead><tr><th>Итог</th><th>Сервис</th><th>Категория</th>${runs.map((r) => `<th>${SHORT[r.name] || r.name}</th>`).join('')}<th class="r">Макс. время</th></tr></thead><tbody>
${rows.map((g) => `<tr><td><span class="chip ${VERDICT[g.worst.verdict][0]}">${VERDICT[g.worst.verdict][1]}</span></td><td><b>${esc(g.service)}</b></td><td>${esc(g.category)}</td>
${runs.map((r) => { const s = g.by[r.name]; return s ? `<td><small><span class="chip ${VERDICT[s.verdict][0]}">${VERDICT[s.verdict][1]}</span><br>${esc(s.reason)}</small></td>` : '<td><small class="muted">не загружался</small></td>'; }).join('')}
<td class="r">${fmtMs(g.maxDuration)}</td></tr>`).join('')}
</tbody></table></div>${okPart ? '</details>' : ''}`).join('')}
<p class="muted">Итог — более строгая рекомендация из двух разрешений. Перед отключением уточните у маркетинга, используется ли сервис.</p>

${runs.map((r, i) => `<input type="radio" name="tab" id="t-${r.name}" class="tab-in" ${i === 0 ? 'checked' : ''}>`).join('')}
<nav class="tabs">${runs.map((r) => `<label for="t-${r.name}" class="tab">${SHORT[r.name] || r.name}: детализация</label>`).join('')}</nav>
${panels}

${WHY}
${methodNote(runs[0].opts)}`);
}
