// Продолжение прерванной проверки: результат каждой страницы сохраняется сразу после её проверки
// в reports/.resume/<ключ>-<desktop|mobile>.json. Ключ зависит от списка страниц и режима проверки:
// если поменять pages.txt или параметры, старое сохранение к новой проверке не подойдёт.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { createInterface } from 'node:readline';

const KEY_OPTS = ['runs', 'slow', 'timeout', 'idle', 'blocktest', 'blockRuns', 'blockServices', 'coverage', 'seo', 'warm', 'warmRuns', 'inp', 'crux', 'filmstrip', 'competitors'];
export const PROFILE_LABEL = { desktop: 'Десктоп', mobile: 'Мобильный' };

export function runKey(jobs, opts) {
  const o = Object.fromEntries(KEY_OPTS.map((k) => [k, opts[k]]));
  return createHash('sha1').update(JSON.stringify({ urls: jobs.map((j) => j.url), o })).digest('hex').slice(0, 12);
}

export class Checkpoint {
  constructor(reportsRoot, key, profileName) {
    this.dir = `${reportsRoot}/.resume`;
    this.file = `${this.dir}/${key}-${profileName}.json`;
  }

  load() {
    try { return JSON.parse(readFileSync(this.file, 'utf8')); } catch { return null; }
  }

  // Запись через временный файл: если процесс прервут посреди записи, прежнее сохранение не испортится
  save(state) {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(`${this.file}.tmp`, JSON.stringify(state));
    renameSync(`${this.file}.tmp`, this.file);
  }

  remove() {
    rmSync(this.file, { force: true });
  }
}

// Сводка по сохранённым этапам: что можно продолжить
export function findResumable(reportsRoot, key, profiles) {
  const stages = {};
  let any = null;
  for (const name of profiles) {
    const st = new Checkpoint(reportsRoot, key, name).load();
    if (!st) continue;
    any ??= st;
    stages[name] = { done: Object.keys(st.done).length, total: st.total, complete: !!st.complete };
  }
  if (!any) return null;
  const progressMade = Object.values(stages).some((s) => s.done > 0);
  const allComplete = profiles.every((p) => stages[p]?.complete);
  if (!progressMade || allComplete) return null;
  return { stamp: any.stamp, startedAt: any.startedAt, stages };
}

export function describeResumable(found, profiles) {
  const date = new Date(found.startedAt).toLocaleString('ru-RU');
  const lines = profiles.map((p) => {
    const s = found.stages[p];
    return `  ${PROFILE_LABEL[p]}: ${s ? (s.complete ? `готово, ${s.total} из ${s.total}` : `проверено ${s.done} из ${s.total} стр.`) : 'ещё не начат'}`;
  });
  return `Найдена незавершённая проверка этого списка страниц от ${date}:\n${lines.join('\n')}`;
}

// Удалить старые сохранения (больше 14 дней), чтобы папка не копилась
export function pruneCheckpoints(reportsRoot, days = 14) {
  const dir = `${reportsRoot}/.resume`;
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) {
    try { if (Date.now() - statSync(`${dir}/${f}`).mtimeMs > days * 864e5) rmSync(`${dir}/${f}`); } catch {}
  }
}

// Решение «продолжить или начать заново»: флаги --resume / --fresh, иначе вопрос в терминале.
// Если вопрос задать некому (вывод не в терминал), проверка продолжается.
export async function decideResume(args, question) {
  if (args.includes('--fresh')) return false;
  if (args.includes('--resume') || !process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((res) => rl.question(question, res));
  rl.close();
  return !/^\s*[nн]/i.test(answer);
}
