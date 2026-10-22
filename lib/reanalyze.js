// Пересчёт выводов по сохранённым данным (data.json) — при пересборке отчёта (combine.js, render.js).
// Замеры не меняются: заново строятся только классификация запросов, рекомендации и итог по сервисам,
// поэтому отчёты прошлых проверок после обновления агента получают исправленные выводы.
import { statusClass, recommendFor, summarizeServices } from './analyze.js';
import { extraRecs, mergeRecs } from './extras.js';

// Условия смартфона, если в старом отчёте их нет (до 2026-10-22 они не сохранялись)
const MOBILE = { network: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 }, cpu: 4 };

export function reanalyze(d, name) {
  const opts = { ...(d.opts || {}) };
  opts.profileName ??= name;
  if (!opts.network && name === 'mobile') Object.assign(opts, MOBILE);
  for (const p of d.pages) {
    if (!p.metrics || !p.resources) continue;
    for (const r of p.resources) r.cls = statusClass(r);
    // Старые отчёты не знают, какой элемент был главным в тесте без внешних сервисов. Если главная картинка
    // сама с внешнего домена, без этого сервиса её точно нет — LCP в таком сценарии не сравнивается
    const lcpRes = p.lcpUrl ? p.resources.find((r) => r.url === p.lcpUrl) : null;
    for (const row of p.extras?.blockTest?.rows || []) {
      if (row.error || row.lcpChanged != null || !lcpRes || lcpRes.internal) continue;
      if (row.key === 'noext' || row.service === lcpRes.service) {
        row.lcpChanged = true;
        row.lcp ??= {};
        if (row.sig) row.sig.lcp = false;
      }
    }
    p.errors = (p.errors || []).filter((e) => {
      e.cls = statusClass({ status: e.status, statusText: e.statusText, duration: e.waitMax ?? e.wait, type: e.type });
      return e.cls !== 'ok' && e.cls !== 'inflight';
    });
    p.recs = mergeRecs(recommendFor(p, opts), extraRecs(p, opts), p);
  }
  return { ...d, opts, services: summarizeServices(d.pages, opts) };
}
