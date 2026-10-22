// Общий отчёт по двум замерам: node combine.js reports/<запуск>/desktop reports/<запуск>/mobile
// По умолчанию all_report.html кладётся в папку запуска (на уровень выше профилей).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { renderCombined } from './lib/report.js';
import { renderSummary } from './lib/summary.js';
import { loadSettings, summaryEnabled, tasksEnabled } from './lib/settings.js';
import { buildTasks, tasksCsv, tasksHtml } from './lib/tasks.js';
import { reanalyze } from './lib/reanalyze.js';
import { fileURLToPath } from 'node:url';

const dirs = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const runs = [];
let site = '';
for (const dir of dirs) {
  const name = (d0 => d0.profileName ?? (/mobile\/?$/.test(dir) ? 'mobile' : 'desktop'));
  const raw = JSON.parse(await readFile(`${dir}/data.json`, 'utf8'));
  // Выводы пересчитываются по сохранённым замерам — так в отчёт попадают исправления агента
  const d = reanalyze(raw, name(raw));
  site ||= d.site ?? '';
  runs.push({
    name: name(d),
    profile: { label: d.profile }, opts: d.opts, pages: d.pages, services: d.services, compare: d.compare, competitors: d.competitors, prodCompare: d.prodCompare,
    startedAt: new Date(d.startedAt ?? Date.now()), finishedAt: new Date(d.finishedAt ?? Date.now()),
  });
}
const out = process.env.OUT_DIR ?? dirname(dirs[0].replace(/\/$/, ''));
await mkdir(out, { recursive: true });
await writeFile(`${out}/all_report.html`, renderCombined(runs));
// Краткая сводка для руководства — рядом с полным отчётом (если включена в settings.txt или флагом --summary)
const settings = loadSettings(fileURLToPath(new URL('./settings.txt', import.meta.url)));
const summary = summaryEnabled(settings);
const tasks = tasksEnabled(settings);
if (summary) await writeFile(`${out}/summary.html`, renderSummary(runs, { site, fullReport: 'all_report.html' }));
// Задачи для трекера: одинаковые проблемы обоих разрешений — одной задачей
if (tasks) {
  const list = buildTasks(runs);
  await writeFile(`${out}/tasks.html`, tasksHtml(list, { site, report: 'all_report.html', startedAt: runs[0]?.startedAt }));
  await writeFile(`${out}/tasks.csv`, tasksCsv(list, { site, report: 'all_report.html' }));
}
console.log(`Общий отчёт: ${out}/all_report.html${summary ? `\nКраткая сводка: ${out}/summary.html` : ''}${tasks ? `\nЗадачи для трекера: ${out}/tasks.html` : ''}`);
