// Сравнение с конкурентами — файл competitors.txt: группы «наша страница + похожие страницы конкурентов».
// Включается настройкой «сравнение с конкурентами = да» в settings.txt (по умолчанию выключено).
// Страницы конкурентов замеряются так же, как свои (те же прогоны, раскадровка, данные реальных посетителей),
// но без углублённых тестов — нужны только цифры для сравнения.
import { readFileSync } from 'node:fs';

const norm = (u) => { try { const x = new URL(u); return (x.origin + x.pathname).replace(/\/$/, '') + x.search; } catch { return u; } };
export const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };

// Строка: «Название = наша страница ; конкурент ; конкурент» или просто адреса через «;» (тогда название — путь нашей страницы)
export function loadCompetitors(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { return { groups: [], warnings: [], missing: true }; }
  const groups = [];
  const warnings = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const kv = /^([^=]*[^=\s])\s*=\s*(.+)$/.exec(line);
    const name = kv && !/^https?:/i.test(kv[1]) ? kv[1].trim() : null;
    const urls = (name ? kv[2] : line).split(/\s*[;|]\s*/).map((x) => x.trim()).filter(Boolean);
    const where = `competitors.txt, строка ${i + 1}`;
    const bad = urls.filter((u) => { try { return !/^https?:$/.test(new URL(u).protocol); } catch { return true; } });
    if (bad.length) return warnings.push(`${where}: «${bad[0]}» — не похоже на адрес страницы (нужно начинать с https://)`);
    if (urls.length < 2) return warnings.push(`${where}: нужна наша страница и хотя бы одна страница конкурента через «;»`);
    const [ours, ...rivals] = urls;
    groups.push({ name: name ?? `${hostOf(ours)}${new URL(ours).pathname}`, ours, rivals: rivals.filter((r) => norm(r) !== norm(ours)) });
  });
  return { groups, warnings };
}

// Группы, наша страница которых есть в этой проверке; для остальных — предупреждение
export function groupsFor(cfg, jobs) {
  const ours = new Set(jobs.map((j) => norm(j.url)));
  const active = cfg.groups.filter((g) => ours.has(norm(g.ours)));
  const skipped = cfg.groups.filter((g) => !ours.has(norm(g.ours)));
  return { active, warnings: skipped.map((g) => `competitors.txt: группа «${g.name}» пропущена — страницы ${g.ours} нет в списке проверки (pages.txt)`) };
}

// Результат замера страницы конкурента — только то, что нужно для сравнения (без списка всех запросов)
export function rivalResult(url, p, extras = {}) {
  if (!p.metrics) return { url, site: hostOf(url), error: p.error || 'страница не открылась' };
  return {
    url, site: hostOf(url), grade: p.grade, metrics: p.metrics, range: p.range, okRuns: p.okRuns,
    totals: { requests: p.totals.requests, bytes: p.totals.bytes, jsBytes: p.totals.jsBytes, extServices: p.totals.extServices },
    errors: (p.errors || []).filter((e) => ['failed', 'pending', 'client', 'server'].includes(e.cls)).length,
    extras,
  };
}

// Наша страница в том же виде, что и конкурентов (из полного замера этой проверки)
export function ownResult(p) {
  const r = rivalResult(p.page, p, { filmstrip: p.extras?.filmstrip, field: p.extras?.field });
  return { ...r, ours: true };
}

// Сводка группы для отчёта: строки «мы + конкуренты», место по LCP, во сколько раз быстрее/медленнее лучшего
export function compareGroup(g, ownPage, rivals) {
  const rows = [ownResult(ownPage ?? { page: g.ours, error: 'страница не открылась' }), ...rivals];
  const ok = rows.filter((r) => r.metrics?.lcp != null).sort((a, b) => a.metrics.lcp - b.metrics.lcp);
  const place = ok.findIndex((r) => r.ours) + 1;
  return { name: g.name, rows, place: place || null, of: ok.length, best: ok[0] ?? null };
}

// ── Тестовый контур против прода ───────────────────────────────────────────
// Разница заметна, если выходит за обычный разброс замеров (те же пороги, что при сравнении с прошлой проверкой)
const SIG = {
  lcp: (d, b) => Math.abs(d) >= Math.max(250, b * 0.15),
  fcp: (d, b) => Math.abs(d) >= Math.max(200, b * 0.15),
  ttfb: (d, b) => Math.abs(d) >= Math.max(200, b * 0.15),
  tbt: (d, b) => Math.abs(d) >= Math.max(100, b * 0.25),
  cls: (d) => Math.abs(d) >= 0.05,
  load: (d, b) => Math.abs(d) >= Math.max(500, b * 0.15),
};
export const PROD_KEYS = Object.keys(SIG);

// testPage — наша тестовая страница (полный замер), prod — результат rivalResult для того же пути на проде
export function prodPair(testPage, prod) {
  const test = ownResult(testPage);
  const out = { page: testPage.page, prodUrl: prod.url, test, prod: { ...prod, prod: true }, delta: {}, verdict: 'na' };
  if (!test.metrics || !prod.metrics) return out;
  for (const k of PROD_KEYS) {
    const a = test.metrics[k];
    const b = prod.metrics[k];
    if (a == null || b == null) continue;
    out.delta[k] = { d: a - b, sig: SIG[k](a - b, b) };
  }
  // Вердикт по LCP — главному показателю; «медленнее», если тест заметно хуже прода
  const l = out.delta.lcp;
  out.verdict = !l ? 'na' : !l.sig ? 'same' : l.d > 0 ? 'slower' : 'faster';
  out.worse = PROD_KEYS.filter((k) => out.delta[k]?.sig && out.delta[k].d > 0);
  return out;
}

// Итог для Терминала: сколько тестовых страниц медленнее прода. entries: prodPair + { profile }
export function prodDigest(entries) {
  if (!entries?.length) return null;
  const fmt = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} с` : `${Math.round(ms)} мс`);
  const slower = entries.filter((e) => e.verdict === 'slower');
  return {
    total: entries.length,
    slower: slower.length,
    faster: entries.filter((e) => e.verdict === 'faster').length,
    failed: entries.filter((e) => e.verdict === 'na').length,
    lines: slower.map((e) => `${e.profile ? `${e.profile}: ` : ''}${e.page.replace(/^https?:\/\/[^/]+/, '') || '/'} — LCP ${fmt(e.test.metrics.lcp)} на тесте против ${fmt(e.prod.metrics.lcp)} на проде (+${fmt(e.delta.lcp.d)})`),
  };
}
