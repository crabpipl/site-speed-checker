// Сравнение с предыдущей проверкой того же профиля (десктоп/мобильный).
import { readdirSync, existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { isError } from './analyze.js';

// Ищет самую свежую папку запуска раньше текущей, где есть данные этого профиля
export function findPrevious(reportsRoot, currentRunDir, profileName) {
  if (!existsSync(reportsRoot)) return null;
  const cur = basename(currentRunDir);
  const dirs = readdirSync(reportsRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name < cur && existsSync(join(reportsRoot, d.name, profileName, 'data.json')))
    .map((d) => d.name)
    .sort();
  if (!dirs.length) return null;
  const name = dirs.at(-1);
  try {
    return { name, data: JSON.parse(readFileSync(join(reportsRoot, name, profileName, 'data.json'), 'utf8')) };
  } catch {
    return null;
  }
}

// Изменение считается заметным, если выходит за обычный разброс замеров
const SIG = {
  ttfb: (d, b) => Math.abs(d) >= Math.max(200, b * 0.15),
  fcp: (d, b) => Math.abs(d) >= Math.max(200, b * 0.15),
  lcp: (d, b) => Math.abs(d) >= Math.max(250, b * 0.15),
  tbt: (d, b) => Math.abs(d) >= Math.max(100, b * 0.25),
  cls: (d) => Math.abs(d) >= 0.05,
  load: (d, b) => Math.abs(d) >= Math.max(500, b * 0.15),
};

export function comparePages(pages, prev) {
  if (!prev) return null;
  const prevPages = new Map((prev.data.pages || []).map((p) => [p.page, p]));
  const rows = [];
  for (const p of pages) {
    const q = prevPages.get(p.page);
    if (!q?.metrics || !p.metrics) {
      rows.push({ page: p.page, isNew: !q });
      continue;
    }
    const delta = {};
    for (const k of Object.keys(SIG)) {
      const a = p.metrics[k];
      const b = q.metrics[k];
      if (a == null || b == null) {
        if (a == null && b != null && k === 'load') delta[k] = { d: null, sig: true, text: 'перестал наступать' };
        if (a != null && b == null && k === 'load') delta[k] = { d: null, sig: true, text: 'стал наступать', better: true };
        continue;
      }
      const d = a - b;
      delta[k] = { d, prev: b, sig: SIG[k](d, b), better: d < 0 };
    }
    // Только сервисы, которые подключают скрипты: пиксели и синхронизации рекламных бирж меняются от захода к заходу
    const svc = (x) => new Set((x.resources || []).filter((r) => !r.internal && r.type === 'script').map((r) => r.service));
    const now = svc(p);
    const was = svc(q);
    const errKey = (e) => `${e.service}|${e.status}`;
    // Устойчивые ошибки: повторились минимум в 2 прогонах (единичные сбои рекламных пикселей — шум)
    const stable = (x) => (x.errors || []).filter((e) => isError(e.cls) && (e.runs >= 2 || x.okRuns === 1));
    const errNow = new Set(stable(p).map(errKey));
    const errWas = new Set(stable(q).map(errKey));
    rows.push({
      page: p.page, prevGrade: q.grade, grade: p.grade, delta,
      newServices: [...now].filter((s) => !was.has(s)),
      goneServices: [...was].filter((s) => !now.has(s)),
      newErrors: [...errNow].filter((e) => !errWas.has(e)).map((e) => e.replace('|', ': ')),
      fixedErrors: [...errWas].filter((e) => !errNow.has(e)).map((e) => e.replace('|', ': ')),
    });
  }
  return { prevName: prev.name, prevStartedAt: prev.data.startedAt, rows };
}

export const reportsRootOf = (runDir) => dirname(runDir);
