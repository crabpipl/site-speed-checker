// Пересобрать desktop_report.html / mobile_report.html из data.json без повторного замера: node render.js reports/<папка>
import { readFile, writeFile } from 'node:fs/promises';
import { renderReport } from './lib/report.js';
import { renderSummary } from './lib/summary.js';
import { loadSettings, summaryEnabled, tasksEnabled } from './lib/settings.js';
import { buildTasks, tasksCsv, tasksHtml } from './lib/tasks.js';
import { reanalyze } from './lib/reanalyze.js';
import { fileURLToPath } from 'node:url';

const dir = process.argv.slice(2).find((a) => !a.startsWith('--'));
const raw = JSON.parse(await readFile(`${dir}/data.json`, 'utf8'));
const name = raw.profileName ?? (/mobile\/?$/.test(dir) ? 'mobile' : 'desktop');
// Выводы пересчитываются по сохранённым замерам — так в отчёт попадают исправления агента
const d = reanalyze(raw, name);
const file = `${dir}/${name}_report.html`;
await writeFile(file, renderReport({
  pages: d.pages, services: d.services, opts: d.opts, profile: { label: d.profile }, compare: d.compare, competitors: d.competitors, prodCompare: d.prodCompare,
  startedAt: new Date(d.startedAt ?? Date.now()), finishedAt: new Date(d.finishedAt ?? Date.now()),
}));
// Краткая сводка — если включена в settings.txt или флагом --summary
const settings = loadSettings(fileURLToPath(new URL('./settings.txt', import.meta.url)));
const summary = summaryEnabled(settings);
const tasks = tasksEnabled(settings);
if (tasks) {
  const list = buildTasks([{ name, opts: d.opts, pages: d.pages }]);
  await writeFile(`${dir}/tasks.html`, tasksHtml(list, { site: d.site ?? '', report: `${name}_report.html`, startedAt: d.startedAt }));
  await writeFile(`${dir}/tasks.csv`, tasksCsv(list, { site: d.site ?? '', report: `${name}_report.html` }));
}
if (summary) await writeFile(`${dir}/summary.html`, renderSummary(
  [{ name, profile: { label: d.profile }, opts: d.opts, pages: d.pages, compare: d.compare, competitors: d.competitors, startedAt: new Date(d.startedAt ?? Date.now()) }],
  { site: d.site ?? '', fullReport: `${name}_report.html` },
));
console.log(`Отчёт: ${file}${summary ? `\nКраткая сводка: ${dir}/summary.html` : ''}${tasks ? `\nЗадачи для трекера: ${dir}/tasks.html` : ''}`);
