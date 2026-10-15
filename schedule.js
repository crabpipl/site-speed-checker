// Проверка по расписанию.
//   node schedule.js on       — включить расписание из settings.txt (строки «расписание» и «проверка по расписанию»)
//   node schedule.js off      — выключить
//   node schedule.js status   — показать расписание и итог последнего запуска
//   node schedule.js run      — запустить проверку так, как её запускает планировщик (журнал, без вопросов)
// --dry-run (для on/off) — показать, что будет сделано, ничего не меняя.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings } from './lib/settings.js';
import { scheduleOn, scheduleOff, scheduleStatus, describeSchedule, PLATFORM_LABEL } from './lib/schedule.js';

const PROJECT = dirname(fileURLToPath(import.meta.url));
const REPORTS = resolve(process.env.REPORTS_ROOT ?? join(PROJECT, 'reports'));
const LOG_DIR = join(REPORTS, '_schedule');
const LAST = join(LOG_DIR, 'last.json');
const LOCK = join(LOG_DIR, 'running.lock');
const KEEP_LOGS = 30;
const platform = process.env.SCHEDULE_PLATFORM ?? process.platform; // подмена — только для проверки команд на другой системе
const args = process.argv.slice(2);
const cmd = args.find((a) => !a.startsWith('--')) ?? 'status';
const dryRun = args.includes('--dry-run');
const settings = loadSettings(process.env.SETTINGS_FILE ?? join(PROJECT, 'settings.txt'));
// Путь к node без номера версии (например, /opt/homebrew/bin/node, а не …/Cellar/node/25.8.1/…), чтобы расписание
// не сломалось после обновления Node; на Windows путь к node.exe и так постоянный
function stableNode() {
  if (process.platform === 'win32') return process.execPath;
  const r = spawnSync('which', ['node'], { encoding: 'utf8' });
  const p = r.status === 0 ? r.stdout.trim().split('\n')[0] : '';
  return p && existsSync(p) ? p : process.execPath;
}
const ctx = { node: stableNode(), script: fileURLToPath(import.meta.url), project: PROJECT, logDir: LOG_DIR };
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}`;
const MODE = { full: 'полная (десктоп и мобильный)', quick: 'быстрая (--quick, десктоп и мобильный)' };

for (const w of settings.warnings) console.warn(w);

if (cmd === 'on') {
  if (!settings.schedule) {
    console.error('В settings.txt не задано расписание. Добавьте строку, например:\n  расписание = пн 03:00\nи запустите команду ещё раз.');
    process.exit(1);
  }
  const r = scheduleOn(platform, ctx, settings.schedule, { dryRun });
  console.log(r.message);
  if (r.ok && !dryRun) {
    console.log(`Когда: ${describeSchedule(settings.schedule)} (${PLATFORM_LABEL[platform] ?? platform}). Проверка: ${MODE[settings.scheduleMode]}.`);
    console.log('Компьютер в это время должен быть включён. Журналы запусков: ' + LOG_DIR);
    console.log('Проверить расписание прямо сейчас, не дожидаясь времени: npm run schedule:run');
  }
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'off') {
  const r = scheduleOff(platform, ctx, { dryRun });
  console.log(r.message);
  process.exit(r.ok ? 0 : 1);
}

if (cmd === 'status') {
  const st = scheduleStatus(platform, ctx);
  console.log(st.on ? `Расписание включено: ${st.where}` : 'Расписание выключено.');
  if (settings.schedule) console.log(`В settings.txt: ${describeSchedule(settings.schedule)}, проверка ${MODE[settings.scheduleMode]}.${st.on ? '' : ' Включить: npm run schedule:on'}`);
  else console.log('В settings.txt расписание не задано (строка «расписание = …»).');
  if (existsSync(LOCK)) console.log('Сейчас идёт проверка по расписанию.');
  if (existsSync(LAST)) {
    const l = JSON.parse(readFileSync(LAST, 'utf8'));
    console.log(`\nПоследний запуск: ${new Date(l.startedAt).toLocaleString('ru-RU')} — ${l.ok ? 'завершён' : `с ошибкой (код ${l.code})`}, ${Math.round((l.finishedAt - l.startedAt) / 60000)} мин.`);
    for (const line of l.final) console.log(`  ${line}`);
    console.log(`  Журнал: ${l.log}`);
  } else console.log('\nПо расписанию ещё не запускалась.');
  process.exit(0);
}

if (cmd !== 'run') {
  console.error(`Неизвестная команда «${cmd}». Можно: on, off, status, run.`);
  process.exit(1);
}

// ── Запуск проверки по расписанию ──────────────────────────────────────────
mkdirSync(LOG_DIR, { recursive: true });
// Предыдущий запуск ещё идёт (долгая проверка, частое расписание) — второй не начинаем
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, 'utf8'));
  let alive = false;
  try { process.kill(pid, 0); alive = true; } catch {}
  if (alive) {
    console.log(`${new Date().toLocaleString('ru-RU')}: предыдущая проверка по расписанию ещё идёт (процесс ${pid}) — пропускаю.`);
    process.exit(0);
  }
}
writeFileSync(LOCK, String(process.pid));
const releaseLock = () => rmSync(LOCK, { force: true });
process.on('exit', releaseLock);

const startedAt = Date.now();
const logFile = join(LOG_DIR, `${stamp()}.log`);
const log = createWriteStream(logFile);
// PAGES_FILE — другой список страниц (по умолчанию pages.txt в папке агента)
const checkArgs = [join(PROJECT, 'check.js'), ...(process.env.PAGES_FILE ? [resolve(process.env.PAGES_FILE)] : []), '--both', '--fresh', ...(settings.scheduleMode === 'quick' ? ['--quick'] : [])];
log.write(`Проверка по расписанию: ${new Date(startedAt).toLocaleString('ru-RU')}\nКоманда: node ${checkArgs.map((a) => a.replace(PROJECT, '.')).join(' ')}\n\n`);

// Не давать компьютеру уснуть, пока идёт проверка: macOS — caffeinate, Linux — systemd-inhibit (если есть)
const has = (bin) => spawnSync(platform === 'win32' ? 'where' : 'which', [bin], { encoding: 'utf8' }).status === 0;
let [exe, exeArgs] = [process.execPath, checkArgs];
if (platform === 'darwin' && has('caffeinate')) [exe, exeArgs] = ['caffeinate', ['-i', process.execPath, ...checkArgs]];
else if (platform === 'linux' && has('systemd-inhibit')) [exe, exeArgs] = ['systemd-inhibit', ['--what=sleep', '--who=site-speed-checker', '--why=Проверка скорости по расписанию', process.execPath, ...checkArgs]];

const child = spawn(exe, exeArgs, { cwd: PROJECT, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, REPORTS_ROOT: REPORTS } });
let tail = '';
const onData = (buf) => {
  log.write(buf);
  tail = (tail + buf.toString()).slice(-20000);
};
child.stdout.on('data', onData);
child.stderr.on('data', onData);
child.on('close', (code) => {
  // Итоговое сообщение проверки — последний блок между линиями «────»
  const blocks = tail.split(/\n─{10,}\n/);
  const final = (blocks.length >= 3 ? blocks.at(-2) : tail.trim().split('\n').slice(-8).join('\n')).split('\n').map((l) => l.trim()).filter(Boolean);
  const res = { startedAt, finishedAt: Date.now(), code, ok: code === 0, log: logFile, final };
  writeFileSync(LAST, JSON.stringify(res, null, 2));
  log.end(`\nЗавершено: ${new Date().toLocaleString('ru-RU')}, код ${code}\n`);
  pruneLogs();
  notify(res);
  releaseLock();
  process.exitCode = code ?? 1;
});

function pruneLogs() {
  const logs = readdirSync(LOG_DIR).filter((f) => /^\d{4}-.*\.log$/.test(f)).sort();
  for (const f of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) rmSync(join(LOG_DIR, f), { force: true });
}

// Уведомление на рабочем столе — по возможности; если система не даёт его показать, итог остаётся в журнале и в «status»
function notify(res) {
  const budget = res.final.find((l) => l.startsWith('🔔'))?.replace(/^🔔\s*/, '');
  const failed = res.final.find((l) => l.startsWith('⚠'));
  const text = !res.ok ? `Проверка завершилась с ошибкой — см. журнал ${res.log}`
    : [failed ? failed.replace(/^⚠\s*/, '') : 'Проверка завершена', budget || 'все страницы в бюджете'].join('. ');
  const title = 'Скорость сайта: проверка по расписанию';
  try {
    if (platform === 'darwin') {
      spawnSync('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`]);
    } else if (platform === 'linux' && has('notify-send')) {
      spawnSync('notify-send', [title, text]);
    } else if (platform === 'win32') {
      const ps = `Add-Type -AssemblyName System.Windows.Forms; $n = New-Object System.Windows.Forms.NotifyIcon; $n.Icon = [System.Drawing.SystemIcons]::Information; $n.Visible = $true; $n.ShowBalloonTip(15000, '${title.replace(/'/g, "''")}', '${text.replace(/'/g, "''")}', 'Info'); Start-Sleep -Seconds 15; $n.Dispose()`;
      spawnSync('powershell', ['-NoProfile', '-Command', ps]);
    }
  } catch {}
}
