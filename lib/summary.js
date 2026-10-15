// Краткая сводка для руководства: одна страница без технических деталей — общий вердикт, ключевые цифры,
// 3–5 главных проблем с ожидаемым выигрышем и тем, кто их решает, изменения с прошлой проверки.
// runs: [{ name: 'desktop'|'mobile', profile: { label }, pages, compare, startedAt }] — одно или оба разрешения.
import { kb } from './analyze.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const median = (arr) => {
  const a = arr.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
// Секунды по-русски: «2,5 с», «12 с»
const sec = (ms) => (ms == null ? '—' : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0).replace('.', ',')} с`);
const DEV = { mobile: 'смартфоны', desktop: 'компьютеры' };
const DEV_ON = { mobile: 'на смартфонах', desktop: 'на компьютерах' };
const LCP_GOOD = 2500;
const LCP_POOR = 4000;
const lcpGrade = (v) => (v == null ? 'na' : v <= LCP_GOOD ? 'good' : v <= LCP_POOR ? 'ni' : 'poor');
const GRADE = { good: ['good', 'Хорошо'], ni: ['warn', 'Требует улучшения'], poor: ['bad', 'Плохо'], na: ['info', 'Нет данных'] };

// Исследование Google (2017, мобильные страницы): рост вероятности ухода при загрузке дольше 1 секунды
function bounceNote(lcp) {
  const steps = [[10000, 123, 10], [6000, 106, 6], [5000, 90, 5], [3000, 32, 3]];
  const s = steps.find(([t]) => lcp >= t);
  return s ? `По исследованию Google, когда страница грузится ${s[2]} с вместо 1 с, вероятность, что посетитель уйдёт, не дождавшись, выше на ${s[1]}%.` : '';
}

// ── Детекторы проблем ──────────────────────────────────────────────────────
// Для каждой страницы: { gain — ожидаемый выигрыш в мс (если его можно оценить), score — вес для сортировки, detail }
const PROBLEMS = [
  {
    key: 'ext',
    title: 'Чужие скрипты (реклама, счётчики, чаты) замедляют показ страницы',
    customer: 'Пока браузер загружает и выполняет скрипты внешних сервисов, покупатель дольше ждёт товары и цены.',
    who: 'Маркетинг (какие сервисы нужны) и фронтенд (отложенная загрузка)',
    check: (p) => {
      const r = p.extras?.blockTest?.rows.find((x) => x.key === 'noext' && !x.error);
      if (!r?.sig.lcp || !(r.delta.lcp < 0)) return null;
      const svc = p.extras.blockTest.rows.filter((x) => x.key !== 'noext' && !x.error && x.sig.lcp && x.delta.lcp < 0).map((x) => x.service);
      return { gain: -r.delta.lcp, score: -r.delta.lcp, names: svc };
    },
    gainText: (g) => `главный контент быстрее на ~${sec(g)}`,
    extra: (hits) => {
      const names = [...new Set(hits.flatMap((h) => h.names || []))];
      return names.length ? `Сильнее всего мешают: ${names.slice(0, 4).join(', ')}.` : '';
    },
  },
  {
    key: 'hang',
    title: 'Страница «грузится» бесконечно из-за сбоев внешних сервисов',
    customer: 'Индикатор загрузки в браузере крутится десятки секунд, часть функций сайта может ждать окончания загрузки.',
    who: 'Маркетинг и фронтенд: починить или отключить сбойные сервисы',
    check: (p) => (p.metrics.load == null || p.metrics.load > 20000 ? { score: 3000 } : null),
  },
  {
    key: 'server',
    title: 'Сервер долго готовит страницу',
    customer: 'Первые секунды после перехода покупатель видит белый экран — сайт ещё не начал отвечать.',
    who: 'Бэкенд и администраторы: кэширование страниц, CDN',
    check: (p) => (p.metrics.ttfb > 800 ? { gain: p.metrics.ttfb - 300, score: p.metrics.ttfb - 300 } : null),
    gainText: (g) => `до ~${sec(g)} быстрее на каждой странице`,
  },
  {
    key: 'lcpLate',
    title: 'Главная картинка страницы начинает загружаться слишком поздно',
    customer: 'Покупатель видит страницу без главного изображения товара или баннера, пока браузер «не дойдёт» до него.',
    who: 'Фронтенд',
    check: (p) => {
      const lb = p.extras?.lcpBreakdown;
      if (lb?.kind !== 'image' || p.metrics.lcp <= LCP_GOOD || lb.parts.loadDelay < 1000) return null;
      return { gain: lb.parts.loadDelay - 300, score: lb.parts.loadDelay - 300 };
    },
    gainText: (g) => `главная картинка появится на ~${sec(g)} раньше`,
  },
  {
    key: 'cls',
    title: 'Страница «прыгает» во время загрузки',
    customer: 'Блоки сдвигаются, когда покупатель уже начал читать или нажимать, — он промахивается мимо кнопок.',
    who: 'Фронтенд',
    check: (p) => (p.metrics.cls > 0.1 ? { score: Math.min(4000, p.metrics.cls * 10000) } : null),
  },
  {
    key: 'inp',
    title: 'Кнопки реагируют на нажатие с задержкой',
    customer: 'После нажатия «В корзину» или фильтра страница какое-то время не отвечает — кажется, что сайт завис.',
    who: 'Фронтенд',
    check: (p) => {
      const ia = p.extras?.interactions;
      return ia && !ia.error && ia.inp > 200 ? { score: ia.inp * 3, value: ia.inp } : null;
    },
  },
  {
    key: 'images',
    title: 'Картинки тяжелее, чем нужно',
    customer: 'Страница дольше грузится и тратит мобильный трафик покупателя.',
    who: 'Фронтенд и контент: современный формат, правильный размер',
    check: (p) => (p.extras?.images?.save > 300 * 1024 ? { score: (p.extras.images.save / 1024 / 1024) * 1000, bytes: p.extras.images.save } : null),
    gainText: (g, hits) => `экономия ~${kb(median(hits.map((h) => h.bytes)))} на странице`,
  },
  {
    key: 'cache',
    title: 'Вернувшиеся покупатели заново скачивают файлы сайта',
    customer: 'Повторный заход мог бы быть почти мгновенным, но браузеру не разрешено хранить часть файлов.',
    who: 'Администраторы: заголовки кэширования',
    check: (p) => (p.extras?.warm && !p.extras.warm.error && p.extras.warm.refetchedBytes > 300 * 1024 ? { score: 800 + p.extras.warm.refetchedBytes / 1024 } : null),
  },
  {
    key: 'js',
    title: 'Много лишнего кода, который не нужен для показа страницы',
    customer: 'Телефон покупателя тратит время на загрузку и разбор кода, который на этой странице не используется.',
    who: 'Фронтенд',
    check: (p) => (p.extras?.coverage?.js?.unused > 500 * 1024 ? { score: 600 } : null),
  },
  {
    key: 'seo',
    title: 'Поисковые роботы видят проблемы на страницах',
    customer: 'Страницы могут хуже находиться в Google и Яндексе.',
    who: 'SEO-специалист и разработчики',
    check: (p) => {
      const bad = (p.extras?.seo?.checks || []).filter((c) => c.level === 'bad');
      return bad.length ? { score: 2500, items: bad.map((c) => c.title) } : null;
    },
    extra: (hits) => {
      const items = [...new Set(hits.flatMap((h) => h.items || []))];
      return items.length ? `Например: ${items.slice(0, 2).join('; ')}.` : '';
    },
  },
];

// Главные проблемы по всем разрешениям: смартфоны важнее (Google ранжирует по мобильной версии)
function topProblems(runs) {
  const out = [];
  for (const def of PROBLEMS) {
    const byRun = runs.map((r) => {
      const ok = r.pages.filter((p) => p.metrics);
      const hits = ok.map((p) => def.check(p)).filter(Boolean);
      return { r, ok, hits };
    }).filter((x) => x.hits.length);
    if (!byRun.length) continue;
    const main = byRun.find((x) => x.r.name === 'mobile') ?? byRun[0];
    const share = main.hits.length / main.ok.length;
    const gain = median(main.hits.map((h) => h.gain));
    out.push({
      def, share, gain,
      score: median(main.hits.map((h) => h.score)) * (0.4 + 0.6 * share) * (main.r.name === 'mobile' ? 1.2 : 1),
      where: byRun.map((x) => `${DEV_ON[x.r.name] ?? x.r.name} — ${x.hits.length} из ${x.ok.length} стр.`).join(', '),
      hits: byRun.flatMap((x) => x.hits),
      inp: def.key === 'inp' ? Math.max(...byRun.flatMap((x) => x.hits.map((h) => h.value))) : null,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 5);
}

// ── Страница сводки ────────────────────────────────────────────────────────
export function renderSummary(runs, { site, fullReport }) {
  const ordered = [...runs].sort((a, b) => (a.name === 'mobile' ? -1 : 1) - (b.name === 'mobile' ? -1 : 1));
  const main = ordered[0];
  const stats = ordered.map((r) => {
    const ok = r.pages.filter((p) => p.metrics);
    const lcp = median(ok.map((p) => p.metrics.lcp));
    const field = ok.map((p) => p.extras?.field).find((f) => f?.level);
    const warm = median(ok.map((p) => (p.extras?.warm && !p.extras.warm.error ? p.extras.warm.m.lcp : null)));
    const budget = ok.filter((p) => p.budget);
    const rows = r.compare?.rows.filter((x) => x.delta?.lcp?.sig) || [];
    return {
      r, ok, lcp, grade: lcpGrade(lcp), field, warm,
      failed: r.pages.length - ok.length,
      budget: budget.length ? { bad: r.pages.filter((p) => p.budget?.over.length || p.budget?.failed).length, total: r.pages.length, fresh: r.pages.reduce((a, p) => a + (p.budget?.over.filter((o) => o.status === 'new').length || 0), 0) } : null,
      better: rows.filter((x) => x.delta.lcp.better).length,
      worse: rows.filter((x) => !x.delta.lcp.better).length,
      hasCompare: !!r.compare,
    };
  });
  // Вердикт — по смартфонам, а если там страницы не открылись — по компьютерам
  const m = stats.find((x) => x.lcp != null) ?? stats[0];
  const problems = topProblems(ordered);
  const date = new Date(main.startedAt).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const pagesCount = new Set(ordered.flatMap((r) => r.pages.map((p) => p.page))).size;

  // Вердикт одной фразой — по смартфонам, если они проверялись
  const verdict = m.lcp == null ? 'Страницы не удалось открыть — замер не получился.'
    : `${m !== stats[0] ? 'На смартфонах страницы не открылись, поэтому оценка — по компьютерам. ' : ''}${m.r.name === 'mobile' ? 'На смартфонах' : 'На компьютерах'} главное содержимое страницы появляется в среднем через <b>${sec(m.lcp)}</b> (норма Google — до 2,5 с). ${m.grade === 'good' ? 'Это хороший результат.' : m.grade === 'ni' ? 'Это медленнее нормы, но не критично.' : 'Это заметно медленнее нормы: часть посетителей уходит, не дождавшись.'}`;

  const tile = (label, value, cls, note = '') => `<div class="tile"><div class="tl">${label}</div><div class="tv ${cls}">${value}</div>${note ? `<div class="tn">${note}</div>` : ''}</div>`;
  const tiles = stats.flatMap((s) => [
    tile(`Главный контент, ${DEV[s.r.name] ?? s.r.name}`, sec(s.lcp), GRADE[s.grade][0], 'медиана по страницам, норма до 2,5 с'),
    ...(s.warm != null ? [tile(`Повторный заход, ${DEV[s.r.name] ?? s.r.name}`, sec(s.warm), GRADE[lcpGrade(s.warm)][0], 'когда файлы сайта уже в браузере')] : []),
  ]);
  const field = stats.find((s) => s.field);
  if (field) {
    const f = field.field;
    tiles.push(tile(`Реальные посетители, ${DEV[field.r.name]}`, f.cwvPass ? 'В норме' : 'Не в норме', f.cwvPass ? 'good' : 'bad', `оценка Google за 28 дней${f.level === 'origin' ? ' по сайту' : ''}`));
  }
  const b = stats.map((s) => s.budget).filter(Boolean);
  if (b.length) {
    const bad = b.reduce((a, x) => a + x.bad, 0);
    const total = b.reduce((a, x) => a + x.total, 0);
    tiles.push(tile('Вне установленных норм', `${bad} из ${total}`, bad ? 'bad' : 'good', 'замеров страниц'));
  }

  // Изменения с прошлой проверки
  const changes = stats.filter((s) => s.hasCompare).map((s) => {
    const parts = [];
    if (s.worse) parts.push(`<span class="bad">медленнее стали ${s.worse} стр.</span>`);
    if (s.better) parts.push(`<span class="good">быстрее стали ${s.better} стр.</span>`);
    if (s.budget?.fresh) parts.push(`<span class="bad">новых выходов за нормы: ${s.budget.fresh}</span>`);
    const text = parts.length ? parts.join(', ') : 'заметных изменений нет';
    return `<li>${s.r.name === 'mobile' ? 'Смартфоны' : 'Компьютеры'}: ${text}${text.endsWith('.') || text.endsWith('.</span>') ? '' : '.'}</li>`;
  });

  const pageRows = [...new Set(ordered.flatMap((r) => r.pages.map((p) => p.page)))].map((url) => {
    const cells = ordered.map((r) => {
      const p = r.pages.find((x) => x.page === url);
      if (!p?.metrics) return '<td><span class="chip bad">не открылась</span></td>';
      const g = lcpGrade(p.metrics.lcp);
      return `<td><span class="chip ${GRADE[g][0]}">${sec(p.metrics.lcp)}</span></td>`;
    }).join('');
    return `<tr><td class="url">${esc(url.replace(/^https?:\/\/[^/]+/, '') || '/')}</td>${cells}</tr>`;
  }).join('');

  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Сводка: ${esc(site)}</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--fg:#1d1d1b;--muted:#6b6b66;--line:#e4e3de;--good:#1a7f4b;--good-bg:#e3f4ea;--warn:#a15c00;--warn-bg:#fdf0d9;--bad:#b42318;--bad-bg:#fde7e4;--info:#2457a6;--info-bg:#e5edfa}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#151514;--card:#1f1f1d;--fg:#ecebe6;--muted:#a3a29b;--line:#34332f;--good:#4cc38a;--good-bg:#173526;--warn:#f0b04a;--warn-bg:#3a2c12;--bad:#ff7b6b;--bad-bg:#3d1c18;--info:#7aa7f0;--info-bg:#1a2740}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:860px;margin:0 auto;padding:28px 16px 48px}
h1{font-size:26px;margin:0 0 2px}h2{font-size:18px;margin:28px 0 10px}.muted{color:var(--muted)}
.verdict{background:var(--card);border:1px solid var(--line);border-left:6px solid var(--v);border-radius:10px;padding:14px 18px;margin:18px 0}
.verdict .big{font-size:20px;font-weight:700;color:var(--v);margin-bottom:4px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}
.tile{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.tl{font-size:12.5px;color:var(--muted)}.tv{font-size:24px;font-weight:700}.tn{font-size:12px;color:var(--muted)}
.tv.good,.good{color:var(--good)}.tv.warn{color:var(--warn)}.tv.bad,.bad{color:var(--bad)}.tv.info{color:var(--info)}
ol.problems{padding:0;margin:0;list-style:none;counter-reset:n}
ol.problems>li{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 16px 12px 52px;margin:0 0 10px;position:relative;counter-increment:n;break-inside:avoid}
ol.problems>li::before{content:counter(n);position:absolute;left:14px;top:12px;width:26px;height:26px;border-radius:50%;background:var(--fg);color:var(--bg);font-weight:700;display:flex;align-items:center;justify-content:center}
.pt{font-weight:700;font-size:16px}.pm{margin:4px 0}.pf{display:flex;flex-wrap:wrap;gap:6px 18px;font-size:13px;color:var(--muted);margin-top:6px}.pf b{color:var(--fg)}
.gain{color:var(--good);font-weight:600}
.chip{display:inline-block;padding:1px 9px;border-radius:99px;font-size:13px;font-weight:600;white-space:nowrap}
.chip.good{background:var(--good-bg);color:var(--good)}.chip.warn{background:var(--warn-bg);color:var(--warn)}.chip.bad{background:var(--bad-bg);color:var(--bad)}.chip.info{background:var(--info-bg);color:var(--info)}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:14px}
th,td{padding:7px 12px;border-bottom:1px solid var(--line);text-align:left}th{font-size:12.5px;color:var(--muted);font-weight:600}tr:last-child td{border-bottom:0}
td.url{font-family:ui-monospace,Menlo,monospace;font-size:12.5px;word-break:break-all}
ul.changes{margin:0;padding-left:20px}a{color:var(--info)}
@media print{:root{--bg:#fff;--card:#fff}body{font-size:12.5px}main{padding:0;max-width:none}.noprint{display:none}h2{break-after:avoid}}
</style></head><body><main>
<h1>Скорость сайта ${esc(site)}: краткая сводка</h1>
<p class="muted">Проверка от ${esc(date)} · страниц: ${pagesCount} · ${ordered.map((r) => DEV[r.name] ?? r.name).join(' и ')}</p>

<div class="verdict" style="--v:var(--${GRADE[m.grade][0] === 'info' ? 'info' : GRADE[m.grade][0]})"><div class="big">${GRADE[m.grade][1]}</div>
<p style="margin:0">${verdict}</p>${m.lcp != null && m.grade !== 'good' ? `<p class="muted" style="margin:6px 0 0">${bounceNote(m.lcp)}</p>` : ''}
${field?.field ? `<p style="margin:6px 0 0">${field.field.cwvPass ? 'По данным Google о реальных посетителях сайт проходит оценку скорости (Core Web Vitals) — это учитывается в поиске.' : 'По данным Google о реальных посетителях сайт <b>не проходит</b> оценку скорости (Core Web Vitals) — это может снижать позиции в поиске Google.'}</p>` : ''}
${stats.some((s) => s.failed) ? `<p class="bad" style="margin:6px 0 0">Не удалось открыть: ${stats.filter((s) => s.failed).map((s) => `${DEV_ON[s.r.name] ?? s.r.name} — ${s.failed} стр.`).join(', ')} Сайт не ответил агенту вовремя; такие страницы стоит проверить ещё раз.</p>` : ''}</div>

<div class="tiles">${tiles.join('')}</div>

<h2>Что мешает больше всего</h2>
${problems.length ? `<ol class="problems">${problems.map((x) => `<li><div class="pt">${esc(x.def.title)}</div>
<p class="pm">${esc(x.def.customer)}${x.def.key === 'inp' ? ` Задержка — до ${sec(x.inp)} (норма до 0,2 с).` : ''} ${esc(x.def.extra?.(x.hits) || '')}</p>
<div class="pf">${x.def.gainText && (x.gain != null || x.def.key === 'images') ? `<span>Если исправить: <span class="gain">${esc(x.def.gainText(x.gain, x.hits))}</span></span>` : ''}<span>Где: <b>${esc(x.where)}</b></span><span>Кто: <b>${esc(x.def.who)}</b></span></div></li>`).join('')}</ol>
<p class="muted">Выигрыш — оценка по замерам этой проверки, медиана по страницам. Эффекты частично пересекаются, поэтому их нельзя просто сложить.</p>`
    : '<p>Серьёзных проблем не найдено.</p>'}

${(() => {
  // Место среди конкурентов по времени показа главного содержимого (если сравнение включено)
  const items = ordered.flatMap((r) => (r.competitors || []).filter((g) => g.place).map((g) => {
    const ours = g.rows.find((x) => x.ours);
    const where = r.name === 'mobile' ? 'на смартфонах' : 'на компьютерах';
    return `<li><b>${esc(g.name)}</b>, ${where}: ${g.place === 1 ? `<span class="good">быстрее всех</span> (${sec(ours.metrics.lcp)})` : `<span class="${g.place === g.of ? 'bad' : ''}">${g.place}-е место из ${g.of}</span> — у нас ${sec(ours.metrics.lcp)}, у ${esc(g.best.site)} ${sec(g.best.metrics.lcp)}`}</li>`;
  }));
  return items.length ? `<h2>Мы и конкуренты</h2><ul class="changes">${items.join('')}</ul><p class="muted">Место — по времени появления главного содержимого на похожих страницах конкурентов, замеренных в той же проверке.</p>` : '';
})()}

${changes.length ? `<h2>С прошлой проверки</h2><ul class="changes">${changes.join('')}</ul>` : ''}

<h2>Страницы</h2>
<table><thead><tr><th>Страница</th>${ordered.map((r) => `<th>Главный контент, ${DEV[r.name] ?? r.name}</th>`).join('')}</tr></thead><tbody>${pageRows}</tbody></table>
<p class="muted">Зелёный — до 2,5 с (норма Google), жёлтый — до 4 с, красный — дольше.</p>

<p class="muted noprint">Подробности для разработчиков — в <a href="${esc(fullReport)}">полном отчёте</a>. Эту страницу можно распечатать или сохранить в PDF (Cmd + P → «Сохранить как PDF»).</p>
<p class="muted">Замер выполнен агентом в браузере Chrome с одного компьютера${ordered.some((r) => r.name === 'mobile') ? '; смартфон — эмуляция Pixel 7 с мобильным интернетом 4G' : ''}. У реальных посетителей цифры могут отличаться, поэтому важнее динамика от проверки к проверке.</p>
</main></body></html>`;
}

