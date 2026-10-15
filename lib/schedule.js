// Установка расписания в планировщик операционной системы:
// macOS — launchd (агент пользователя), Windows — Планировщик заданий (schtasks), Linux — cron пользователя.
// Каждая функция возвращает { ok, message, details? }; при dryRun ничего не меняет, а показывает, что было бы сделано.
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

const LABEL = 'com.site-speed-checker.check';
const WIN_TASK = 'SiteSpeedChecker';
const DAY_NAMES = ['', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const pad = (n) => String(n).padStart(2, '0');
export const describeSchedule = (s) => `${s.days.length === 7 ? 'ежедневно' : s.days.map((d) => DAY_NAMES[d]).join(', ')} в ${pad(s.hour)}:${pad(s.minute)}`;

const run = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input });
  return { code: r.status ?? (r.error ? -1 : 0), out: `${r.stdout || ''}${r.stderr || ''}`.trim(), error: r.error };
};

// ── macOS: launchd ─────────────────────────────────────────────────────────
const plistPath = () => join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function macPlist({ node, script, project, logDir }, sch) {
  // launchd: Weekday 0 и 7 — воскресенье, 1 — понедельник; пропущенный из-за сна запуск выполняется после пробуждения
  const intervals = sch.days.map((d) => `    <dict><key>Weekday</key><integer>${d % 7}</integer><key>Hour</key><integer>${sch.hour}</integer><key>Minute</key><integer>${sch.minute}</integer></dict>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(node)}</string>
    <string>${xml(script)}</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(project)}</string>
  <key>StartCalendarInterval</key>
  <array>
${intervals}
  </array>
  <key>StandardOutPath</key><string>${xml(join(logDir, 'launchd.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(join(logDir, 'launchd.log'))}</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function macOn(ctx, sch, dryRun) {
  const file = plistPath();
  const body = macPlist(ctx, sch);
  if (dryRun) return { ok: true, message: `Будет создан файл ${file}:\n${body}` };
  mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(ctx.logDir, { recursive: true });
  const uid = userInfo().uid;
  run('launchctl', ['bootout', `gui/${uid}/${LABEL}`]); // старое расписание, если было
  writeFileSync(file, body);
  let r = run('launchctl', ['bootstrap', `gui/${uid}`, file]);
  if (r.code !== 0) r = run('launchctl', ['load', '-w', file]); // старые версии macOS
  return r.code === 0 ? { ok: true, message: `Расписание включено (launchd, ${file}).` } : { ok: false, message: `launchctl не принял расписание: ${r.out}` };
}

function macOff(dryRun) {
  const file = plistPath();
  if (!existsSync(file)) return { ok: true, message: 'Расписание не было включено.' };
  if (dryRun) return { ok: true, message: `Будет удалён ${file}` };
  run('launchctl', ['bootout', `gui/${userInfo().uid}/${LABEL}`]);
  run('launchctl', ['unload', '-w', file]);
  rmSync(file, { force: true });
  return { ok: true, message: 'Расписание выключено.' };
}

const macStatus = () => (existsSync(plistPath()) ? { on: true, where: plistPath() } : { on: false });

// ── Windows: Планировщик заданий ───────────────────────────────────────────
const WIN_DAYS = ['', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];
export function winArgs({ node, script }, sch) {
  const tr = `"${node}" "${script}" run`;
  const when = sch.days.length === 7 ? ['/SC', 'DAILY'] : ['/SC', 'WEEKLY', '/D', sch.days.map((d) => WIN_DAYS[d]).join(',')];
  return ['/Create', '/F', '/TN', WIN_TASK, '/TR', tr, ...when, '/ST', `${pad(sch.hour)}:${pad(sch.minute)}`];
}

function winOn(ctx, sch, dryRun) {
  const args = winArgs(ctx, sch);
  if (dryRun) return { ok: true, message: `Будет выполнено: schtasks ${args.map((a) => (/\s/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')}` };
  const r = run('schtasks', args);
  return r.code === 0 ? { ok: true, message: `Расписание включено (Планировщик заданий Windows, задача «${WIN_TASK}»).` } : { ok: false, message: `Планировщик заданий не принял задачу: ${r.out}` };
}

function winOff(dryRun) {
  if (dryRun) return { ok: true, message: `Будет выполнено: schtasks /Delete /F /TN ${WIN_TASK}` };
  const r = run('schtasks', ['/Delete', '/F', '/TN', WIN_TASK]);
  return { ok: true, message: r.code === 0 ? 'Расписание выключено.' : 'Расписание не было включено.' };
}

const winStatus = () => (run('schtasks', ['/Query', '/TN', WIN_TASK]).code === 0 ? { on: true, where: `Планировщик заданий, задача «${WIN_TASK}»` } : { on: false });

// ── Linux: cron пользователя ───────────────────────────────────────────────
// Строка помечается комментарием с папкой агента — так её можно найти и заменить, не трогая чужие задания
const marker = (project) => `# site-speed-checker: ${project}`;
const sq = (s) => `'${String(s).replace(/'/g, `'\\''`).replace(/%/g, '\\%')}'`;
export function cronLine({ node, script, project }, sch) {
  const dow = sch.days.length === 7 ? '*' : sch.days.map((d) => d % 7).join(',');
  return `${sch.minute} ${sch.hour} * * ${dow} cd ${sq(project)} && ${sq(node)} ${sq(script)} run ${marker(project)}`;
}

const readCron = () => {
  const r = run('crontab', ['-l']);
  if (r.error) return { error: 'не найдена программа crontab: установите и включите cron — команды для вашего дистрибутива в README, раздел 3.1 (например, Ubuntu: sudo apt install cron && sudo systemctl enable --now cron)' };
  return { lines: r.code === 0 ? r.out.split('\n') : [] }; // код 1 — у пользователя ещё нет crontab
};

function linuxOn(ctx, sch, dryRun) {
  const line = cronLine(ctx, sch);
  if (dryRun) return { ok: true, message: `В crontab пользователя будет добавлена строка:\n${line}` };
  const cur = readCron();
  if (cur.error) return { ok: false, message: cur.error };
  const lines = cur.lines.filter((l) => l && !l.endsWith(marker(ctx.project)));
  const r = run('crontab', ['-'], [...lines, line, ''].join('\n'));
  return r.code === 0 ? { ok: true, message: 'Расписание включено (cron пользователя).' } : { ok: false, message: `crontab не принял расписание: ${r.out}` };
}

function linuxOff(ctx, dryRun) {
  const cur = readCron();
  if (cur.error) return { ok: false, message: cur.error };
  const lines = cur.lines.filter((l) => l);
  const keep = lines.filter((l) => !l.endsWith(marker(ctx.project)));
  if (keep.length === lines.length) return { ok: true, message: 'Расписание не было включено.' };
  if (dryRun) return { ok: true, message: 'Из crontab будет удалена строка агента.' };
  run('crontab', ['-'], [...keep, ''].join('\n'));
  return { ok: true, message: 'Расписание выключено.' };
}

function linuxStatus(ctx) {
  const cur = readCron();
  const line = cur.lines?.find((l) => l.endsWith(marker(ctx.project)));
  return line ? { on: true, where: `cron: ${line}` } : { on: false };
}

// ── Общий вход ─────────────────────────────────────────────────────────────
export const PLATFORM_LABEL = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };

export function scheduleOn(platform, ctx, sch, { dryRun = false } = {}) {
  if (platform === 'darwin') return macOn(ctx, sch, dryRun);
  if (platform === 'win32') return winOn(ctx, sch, dryRun);
  if (platform === 'linux') return linuxOn(ctx, sch, dryRun);
  return { ok: false, message: `Система ${platform} не поддерживается — расписание можно настроить вручную: команда «node schedule.js run» в папке агента.` };
}

export function scheduleOff(platform, ctx, { dryRun = false } = {}) {
  if (platform === 'darwin') return macOff(dryRun);
  if (platform === 'win32') return winOff(dryRun);
  if (platform === 'linux') return linuxOff(ctx, dryRun);
  return { ok: false, message: `Система ${platform} не поддерживается.` };
}

export function scheduleStatus(platform, ctx) {
  if (platform === 'darwin') return macStatus();
  if (platform === 'win32') return winStatus();
  if (platform === 'linux') return linuxStatus(ctx);
  return { on: false };
}
