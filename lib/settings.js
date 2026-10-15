// Общие настройки агента — файл settings.txt (необязательный): строки «настройка = значение».
// Флаги командной строки важнее файла: --summary / --no-summary и т. п.
import { readFileSync } from 'node:fs';

const YES = /^(да|yes|вкл|on|1|true)$/i;
const NO = /^(нет|no|выкл|off|0|false)$/i;
const yesNo = (v) => (YES.test(v) ? true : NO.test(v) ? false : { error: 'значение должно быть «да» или «нет»' });

// Расписание: «пн 03:00», «пн, чт 03:00», «ежедневно 02:30», «будни 04:00», «выходные 03:00».
// Результат: { days: [1..7] (1 — понедельник), hour, minute, text }
const DAYS = { 'пн': 1, 'вт': 2, 'ср': 3, 'чт': 4, 'пт': 5, 'сб': 6, 'вс': 7 };
// Полные названия — по первым трём буквам: «понедельник», «среда», «воскресенье»
const DAYS_FULL = { 'пон': 1, 'вто': 2, 'сре': 3, 'чет': 4, 'пят': 5, 'суб': 6, 'вос': 7 };
const DAY_SETS = { 'ежедневно': [1, 2, 3, 4, 5, 6, 7], 'каждый день': [1, 2, 3, 4, 5, 6, 7], 'будни': [1, 2, 3, 4, 5], 'выходные': [6, 7] };
export function parseSchedule(v) {
  const m = /^(.+?)\s+(\d{1,2}):(\d{2})$/.exec(v.trim().toLowerCase().replace(/ё/g, 'е'));
  const bad = { error: 'пример: «пн 03:00», «пн, чт 03:00», «ежедневно 02:30», «будни 04:00»' };
  if (!m) return bad;
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) return bad;
  const dayText = m[1].trim();
  let days = DAY_SETS[dayText];
  if (!days) {
    days = dayText.split(/[\s,;]+/).filter(Boolean).map((d) => (d.length === 2 ? DAYS[d] : DAYS_FULL[d.slice(0, 3)]));
    if (!days.length || days.some((d) => !d)) return bad;
  }
  return { days: [...new Set(days)].sort(), hour, minute, text: v.trim() };
}

// Известные настройки: название в файле → ключ, значение по умолчанию, разбор значения
const KNOWN = {
  'сводка для руководства': { key: 'summary', def: true, parse: yesNo },
  'задачи для трекера': { key: 'tasks', def: true, parse: yesNo },
  'сравнение с конкурентами': { key: 'competitors', def: false, parse: yesNo },
  'сравнение теста с продом': { key: 'prodCompare', def: true, parse: yesNo },
  'расписание': { key: 'schedule', def: null, parse: parseSchedule },
  'проверка по расписанию': {
    key: 'scheduleMode', def: 'full',
    parse: (v) => (/^полн/i.test(v) ? 'full' : /^быстр/i.test(v) ? 'quick' : { error: 'значение должно быть «полная» или «быстрая»' }),
  },
};

export function loadSettings(path) {
  const out = {};
  const warnings = [];
  let text;
  try { text = readFileSync(path, 'utf8'); } catch { text = ''; }
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const kv = /^([^=]+)=(.*)$/.exec(line);
    const name = kv?.[1].trim().toLowerCase().replace(/\s+/g, ' ');
    const where = `settings.txt, строка ${i + 1}: «${line}»`;
    if (!kv || !KNOWN[name]) return warnings.push(`${where} — неизвестная настройка (можно: ${Object.keys(KNOWN).join(', ')})`);
    const v = KNOWN[name].parse(kv[2].trim());
    if (v?.error) warnings.push(`${where} — ${v.error}`);
    else out[KNOWN[name].key] = v;
  });
  for (const d of Object.values(KNOWN)) if (!(d.key in out)) out[d.key] = d.def;
  return { ...out, warnings };
}

// Сравнивать ли с конкурентами (страницы из competitors.txt): флаг --competitors / --no-competitors > settings.txt
export function competitorsEnabled(settings, args = process.argv.slice(2)) {
  if (args.includes('--competitors')) return true;
  if (args.includes('--no-competitors')) return false;
  return settings.competitors;
}

// Выгружать ли задачи для трекера: флаг --tasks / --no-tasks > AUDIT_TASKS > settings.txt
export function tasksEnabled(settings, args = process.argv.slice(2)) {
  if (args.includes('--tasks')) return true;
  if (args.includes('--no-tasks')) return false;
  if (process.env.AUDIT_TASKS === '1') return true;
  if (process.env.AUDIT_TASKS === '0') return false;
  return settings.tasks;
}

// Создавать ли краткую сводку для руководства: флаг запуска > переменная AUDIT_SUMMARY (от родительского процесса) > settings.txt
export function summaryEnabled(settings, args = process.argv.slice(2)) {
  if (args.includes('--summary')) return true;
  if (args.includes('--no-summary')) return false;
  if (process.env.AUDIT_SUMMARY === '1') return true;
  if (process.env.AUDIT_SUMMARY === '0') return false;
  return settings.summary;
}
