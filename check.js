// Аудит скорости загрузки страниц.
// Запуск: node check.js [pages.txt | sites.json] [--runs=3] [--mobile | --both] [--quick | --no-blocktest --no-coverage --no-warm --no-inp --no-seo --no-crux --no-filmstrip] [--summary | --no-summary] [--tasks | --no-tasks] [--competitors | --no-competitors] [--test] [--slow=1000] [--timeout=45000] [--idle=3000] [--concurrency=1] [--headed]
import { chromium } from 'playwright';
import { writeFile, mkdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { measurePage, measureCoverage, measureWarm, measureInteractions, PROFILES } from './lib/collect.js';
import { checkSeo } from './lib/seo.js';
import { makeInternalMatcher, serviceOf } from './lib/services.js';
import { findPrevious, comparePages } from './lib/compare.js';
import {
  lcpBreakdown, serverInfo, imagesAudit, fontsAudit, domInfo, clsSources, coverageSummary,
  pickBlockCandidates, blockTestSummary, seoSummary, extraRecs, mergeRecs, warmSummary, interactionsSummary, filmstripSummary,
} from './lib/extras.js';
import { analyzePage, summarizeServices, fmtMs, kb, isError } from './lib/analyze.js';
import { renderReport } from './lib/report.js';
import { renderSummary } from './lib/summary.js';
import { loadSettings, summaryEnabled, tasksEnabled, competitorsEnabled } from './lib/settings.js';
import { loadCompetitors, groupsFor, rivalResult, compareGroup, hostOf, prodPair, prodDigest } from './lib/competitors.js';
import { buildTasks, tasksCsv, tasksHtml } from './lib/tasks.js';
import { Progress, WEIGHT } from './lib/progress.js';
import { runKey, Checkpoint, findResumable, describeResumable, pruneCheckpoints, decideResume, PROFILE_LABEL } from './lib/resume.js';
import { listenKeys } from './lib/keys.js';
import { printFinal } from './lib/finish.js';
import { loadActions, actionsFor } from './lib/actions.js';
import { Crux, loadCruxKey, fieldSummary } from './lib/crux.js';
import { loadBudgets, budgetsFor, checkBudget, fmtBudget, budgetDigest, BUDGET_KEYS } from './lib/budgets.js';

const args = process.argv.slice(2);
// Отчёты: reports/<сайт>/<дата_время запуска>/<desktop|mobile>, например reports/shop.example.com/2026-10-12_14-09/desktop
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
// Пути считаются от папки агента, поэтому запускать можно из любой папки терминала
const PROJECT = dirname(fileURLToPath(import.meta.url));
const REPORTS = resolve(process.env.REPORTS_ROOT ?? `${PROJECT}/reports`);
// При --both оба этапа получают одну и ту же метку времени от родительского процесса
let STAMP = process.env.AUDIT_STAMP ?? `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
// Папка сайта — домен без www: www.site.ru и site.ru попадают в одну папку
const siteKey = (url) => new URL(url).hostname.replace(/^www\./, '');
// Группировка с сохранением порядка (Map.groupBy есть только в Node 21+)
const groupBy = (items, key) => items.reduce((m, x) => m.set(key(x), [...(m.get(key(x)) || []), x]), new Map());

const num = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split('=')[1]) : def;
};
const opts = {
  runs: num('runs', 3),
  slow: num('slow', 1000), // ресурс медленный, если грузится дольше (мс)
  timeout: num('timeout', 45000), // ожидание события load
  idle: num('idle', 3000), // ожидание отложенных запросов после load
  // Параллельные замеры конкурируют за CPU и сеть и искажают тайминги — по умолчанию по одной странице
  concurrency: num('concurrency', 1),
  // Углублённые проверки (--quick отключает самые долгие: тест без внешних сервисов и покрытие кода)
  blocktest: !args.includes('--no-blocktest') && !args.includes('--quick'),
  blockRuns: num('block-runs', 2), // прогонов «без всех внешних сервисов»
  blockServices: num('block-services', 3), // сколько самых тяжёлых сервисов блокировать по одному
  coverage: !args.includes('--no-coverage') && !args.includes('--quick'),
  // Повторный визит: прогрев кэша + замеры в том же браузере
  warm: !args.includes('--no-warm') && !args.includes('--quick'),
  warmRuns: num('warm-runs', 2),
  // Тест отклика на нажатия (INP в лабораторном замере)
  inp: !args.includes('--no-inp') && !args.includes('--quick'),
  seo: !args.includes('--no-seo'),
  // Тестовый контур (pages-test.txt): без SEO-индексации, данных реальных посетителей и конкурентов, со сравнением с продом
  test: args.includes('--test'),
  // Данные реальных посетителей из Chrome UX Report (нужен ключ в crux-key.txt); быстрый запрос, в --quick тоже
  crux: !args.includes('--no-crux'),
  // Раскадровка: кадры экрана в первом обычном прогоне, лишних загрузок не требует
  filmstrip: !args.includes('--no-filmstrip'),
};
const profileName = args.includes('--mobile') ? 'mobile' : 'desktop';
const profile = PROFILES[profileName];
const configPath = resolve(args.find((x) => !x.startsWith('--')) ?? `${PROJECT}/pages.txt`);
const { jobs, internalNote } = configPath.endsWith('.json') ? loadJson(configPath) : loadPagesTxt(configPath);
if (!jobs.length) {
  console.error(`В файле ${configPath} нет ни одной страницы для проверки.`);
  process.exit(1);
}

// --list: только показать, какие страницы будут проверены
if (args.includes('--list')) {
  console.log(`Файл: ${configPath}\nСтраниц к проверке: ${jobs.length}`);
  let n = 0;
  for (const [site, list] of groupBy(jobs, (j) => siteKey(j.url))) {
    console.log(`\n${site} → отчёты в reports/${site}/`);
    list.forEach((j) => console.log(`  ${++n}. ${j.url}`));
  }
  process.exit(0);
}

// pages.txt: одна строка — один полный URL; # — комментарий; пустые строки пропускаются
function loadPagesTxt(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); } catch {
    console.error(`Не найден файл со списком страниц: ${path}`);
    process.exit(1);
  }
  const jobs = [];
  const seen = new Set();
  // Секция [тестовый домен = прод-домен] — для тестового контура: страницы под ней сравниваются с теми же путями на проде
  let mapping = null;
  const bare = (h) => h.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/[/:].*$/, '');
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.replace(/\s#.*$/, '').trim();
    if (!line || line.startsWith('#')) return;
    const sec = /^\[(.+)\]$/.exec(line);
    if (sec) {
      const [t, pr] = sec[1].split('=');
      mapping = pr ? { test: bare(t), prod: bare(pr) } : null;
      if (!pr) console.warn(`${basename(path)}, строка ${i + 1}: «${line}» — нужен формат [тестовый домен = прод-домен]`);
      return;
    }
    let u;
    try { u = new URL(line); } catch {}
    if (!u || !/^https?:$/.test(u.protocol)) {
      console.warn(`${basename(path)}, строка ${i + 1}: «${line}» — не похоже на адрес страницы (нужно начинать с https://), пропускаю`);
      return;
    }
    if (seen.has(u.href)) return;
    seen.add(u.href);
    const host = u.hostname.replace(/^www\./, '');
    if (mapping && mapping.test !== host) console.warn(`${basename(path)}, строка ${i + 1}: ${u.hostname} не совпадает с тестовым доменом секции [${mapping.test} = ${mapping.prod}] — страница проверится без сравнения с продом`);
    const prod = mapping?.test === host ? mapping.prod : null;
    // Прод-домен тестового сайта считается «своим»: файлы с прод-CDN — не внешние сервисы
    jobs.push({ site: u.origin, url: u.href, internal: prod ? [prod] : [], prod });
  });
  return { jobs, internalNote: '' };
}

// sites.json — расширенный формат (общие страницы для нескольких сайтов, доп. «свои» домены)
function loadJson(path) {
  const config = JSON.parse(readFileSync(path, 'utf8'));
  const jobs = [];
  for (const s of config.sites) {
    const site = typeof s === 'string' ? { url: s } : s;
    const internal = [...(config.internal ?? []), ...(site.internal ?? [])];
    for (const p of site.pages ?? config.pages ?? ['/']) {
      jobs.push({ site: site.url, url: new URL(p, site.url).href, internal });
    }
  }
  return { jobs, internalNote: (config.internal ?? []).join(', ') };
}
opts.internalNote = internalNote;
// Действия для теста отклика по сайтам (необязательный файл actions.txt рядом с pages.txt)
const actionsConfig = loadActions(process.env.ACTIONS_FILE ?? `${PROJECT}/actions.txt`);
// Тестовый контур: проверки, бессмысленные для закрытого от поиска сайта без посетителей, выключаются
if (opts.test) {
  opts.seo = false;
  opts.crux = false;
}
// Ключ CrUX API: без него раздел «Реальные посетители» в отчёте подскажет, как его получить
const cruxKey = opts.crux ? loadCruxKey(PROJECT) : null;
const crux = cruxKey ? new Crux(cruxKey) : null;
opts.cruxState = !opts.crux ? 'off' : crux ? 'on' : 'nokey';
// Общие настройки (settings.txt): нужна ли краткая сводка для руководства и т. п.
const settings = loadSettings(process.env.SETTINGS_FILE ?? `${PROJECT}/settings.txt`);
opts.summary = summaryEnabled(settings, args);
opts.tasks = tasksEnabled(settings, args);
// Сравнение с конкурентами (страницы из competitors.txt) — по умолчанию выключено
opts.competitors = competitorsEnabled(settings, args) && !opts.test;
// Тест против прода: те же пути на прод-домене замеряются в этой же проверке
opts.prodCompare = opts.test && settings.prodCompare && !args.includes('--no-prod');
const competitorsConfig = opts.competitors ? loadCompetitors(process.env.COMPETITORS_FILE ?? `${PROJECT}/competitors.txt`) : { groups: [], warnings: [] };
const competitorGroups = groupsFor(competitorsConfig, jobs);
// Бюджеты скорости по сайтам (необязательный файл budgets.txt рядом с pages.txt)
const budgetsConfig = loadBudgets(process.env.BUDGETS_FILE ?? `${PROJECT}/budgets.txt`);

// --both: десктоп, затем мобильный (последовательно, чтобы замеры не мешали друг другу) + общий отчёт
if (args.includes('--both')) {
  const { execFileSync } = await import('node:child_process');
  const { readdirSync, existsSync } = await import('node:fs');
  const rest = args.filter((a) => !['--both', '--mobile', '--resume', '--fresh'].includes(a));
  // Ctrl+C обрабатывает дочерний процесс (он и пишет сообщение), здесь — только не упасть с трассировкой
  process.on('SIGINT', () => {});
  const run = (script, extra, env) => {
    try {
      execFileSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...extra], { stdio: 'inherit', env: { ...process.env, ...env } });
    } catch (e) {
      if (e.status !== 130 && e.signal !== 'SIGINT') console.error(`\nПроверка завершилась с ошибкой (код ${e.status ?? e.signal}).`);
      process.exit(e.status ?? 1);
    }
  };

  // Незавершённая проверка того же списка в том же режиме — предложить продолжить
  const key = runKey(jobs, opts);
  const profiles = ['desktop', 'mobile'];
  pruneCheckpoints(REPORTS);
  const found = findResumable(REPORTS, key, profiles);
  let resume = false;
  if (found) {
    console.log(`\n${describeResumable(found, profiles)}`);
    resume = await decideResume(args, 'Продолжить с места остановки? [Д/н] (н — начать заново): ');
    if (resume) STAMP = found.stamp;
  }
  if (!resume) profiles.forEach((p) => new Checkpoint(REPORTS, key, p).remove());

  const common = { AUDIT_STAMP: STAMP, AUDIT_COMBINED: '1', AUDIT_RESUME: resume ? '1' : '0' };
  run('check.js', rest, { ...common, AUDIT_STAGE: 'Этап 1/2', AUDIT_NEXT: 'mobile' });
  run('check.js', [...rest, '--mobile'], { ...common, AUDIT_STAGE: 'Этап 2/2' });
  // Общий отчёт для каждого сайта, у которого в этом запуске есть оба разрешения
  const reportsMade = [];
  const failed = [];
  const budgetEntries = [];
  const prodEntries = [];
  let pagesTotal = 0;
  for (const site of readdirSync(REPORTS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const dir = `${REPORTS}/${site}/${STAMP}`;
    if (existsSync(`${dir}/desktop/data.json`) && existsSync(`${dir}/mobile/data.json`)) {
      run('combine.js', [`${dir}/desktop`, `${dir}/mobile`], { OUT_DIR: dir, AUDIT_SUMMARY: opts.summary ? '1' : '0', AUDIT_TASKS: opts.tasks ? '1' : '0' });
      for (const prof of profiles) {
        const d = JSON.parse(readFileSync(`${dir}/${prof}/data.json`, 'utf8'));
        for (const x of d.prodCompare || []) prodEntries.push({ ...x, profile: PROFILE_LABEL[prof] });
      }
      reportsMade.push(`${dir}/all_report.html`, ...(opts.summary ? [`${dir}/summary.html`] : []), ...(opts.tasks ? [`${dir}/tasks.html`] : []));
      for (const prof of profiles) {
        const d = JSON.parse(readFileSync(`${dir}/${prof}/data.json`, 'utf8'));
        pagesTotal += d.pages.length;
        for (const p of d.pages) if (!p.metrics) failed.push({ profile: PROFILE_LABEL[prof], page: p.page, error: p.error || 'страница не открылась' });
        for (const p of d.pages) budgetEntries.push({ profile: PROFILE_LABEL[prof], page: p.page, budget: p.budget });
      }
    }
  }
  // Проверка завершена целиком — сохранения для продолжения больше не нужны
  profiles.forEach((p) => new Checkpoint(REPORTS, key, p).remove());
  printFinal({ startedAt: now.getTime(), pagesTotal, failed, reports: reportsMade, budget: budgetDigest(budgetEntries), prod: prodDigest(prodEntries) });
  process.exit(0);
}


// Сохранение прогресса: каждая проверенная страница записывается сразу.
// В режиме --both решение «продолжить / заново» принимает родительский процесс (AUDIT_RESUME),
// при проверке одного разрешения — этот процесс сам.
const checkpoint = new Checkpoint(REPORTS, runKey(jobs, opts), profileName);
let state = null;
if (process.env.AUDIT_STAGE) {
  if (process.env.AUDIT_RESUME === '1') state = checkpoint.load();
} else {
  pruneCheckpoints(REPORTS);
  const found = findResumable(REPORTS, runKey(jobs, opts), [profileName]);
  if (found) {
    console.log(`\n${describeResumable(found, [profileName])}`);
    if (await decideResume(args, 'Продолжить с места остановки? [Д/н] (н — начать заново): ')) state = checkpoint.load();
  }
  if (!state) checkpoint.remove();
}
if (state?.complete) {
console.log(`\n${process.env.AUDIT_STAGE ? `${process.env.AUDIT_STAGE}. ` : ''}${PROFILE_LABEL[profileName]}: этап уже выполнен в прерванной проверке — пропускаю.`);
  process.exit(0);
}
if (state) STAMP = state.stamp;
const startedAt = state ? new Date(state.startedAt) : new Date();
state ??= { stamp: STAMP, startedAt, total: jobs.length, complete: false, done: {} };
const doneCount = () => Object.keys(state.done).length;

// Ошибки в actions.txt — показать один раз (в режиме --both — только на первом этапе)
if (opts.inp && process.env.AUDIT_STAGE !== 'Этап 2/2') actionsConfig.warnings.forEach((w) => console.warn(w));
if (process.env.AUDIT_STAGE !== 'Этап 2/2') {
  [...budgetsConfig.warnings, ...settings.warnings, ...competitorsConfig.warnings, ...competitorGroups.warnings].forEach((w) => console.warn(w));
  if (opts.competitors && !competitorGroups.active.length) console.warn('Сравнение с конкурентами включено, но в competitors.txt нет групп для страниц этой проверки — конкуренты не замеряются.');
}
console.log(`\n${process.env.AUDIT_STAGE ? `${process.env.AUDIT_STAGE}. ` : ''}Профиль: ${profile.label}; страниц: ${jobs.length}; прогонов на страницу: ${opts.runs}${args.includes('--quick') ? ' (быстрый режим)' : ''}\n`);
// Ctrl+C: аккуратно остановиться. Браузер Playwright закроет сам при выходе процесса;
// его собственная обработка Ctrl+C отключена — иначе он закрывал браузер посреди замера и падал с ошибкой.
let progress;
const stop = () => {
  progress?.finish();
  const n = doneCount();
  // Продолжать есть что, если готова хоть одна страница или (на мобильном этапе) уже выполнен десктопный
  const resumable = n > 0 || process.env.AUDIT_STAGE === 'Этап 2/2';
  console.error(`\nПроверка остановлена (Ctrl+C). ${PROFILE_LABEL[profileName]}: проверено ${n} из ${jobs.length} стр.` +
    (resumable ? '\nРезультаты готовых страниц сохранены — запустите ту же команду ещё раз, агент предложит продолжить с этого места.' : ''));
  process.exit(130);
};
process.once('SIGINT', stop);
const browser = await chromium.launch({ headless: !args.includes('--headed'), handleSIGINT: false });

// Шаги одной страницы с относительными весами — для оценки оставшегося времени
const pagePlan = () => [
  ...Array(opts.runs).fill(WEIGHT.run),
  ...(opts.blocktest ? [...Array(opts.blockRuns).fill(WEIGHT.blockAll), ...Array(opts.blockServices).fill(WEIGHT.blockOne)] : []),
  ...(opts.warm ? Array(1 + opts.warmRuns).fill(WEIGHT.warm) : []),
  ...(opts.inp ? [WEIGHT.inp] : []),
  ...(opts.coverage ? [WEIGHT.coverage] : []),
  ...(opts.seo ? [WEIGHT.seo] : []),
  ...(crux ? [WEIGHT.crux] : []),
];
progress = new Progress({
  total: jobs.length,
  done: doneCount(),
  plan: pagePlan,
  stage: [process.env.AUDIT_STAGE, profileName === 'mobile' ? 'Мобильный' : 'Десктоп'].filter(Boolean).join(' · '),
  unitGuessMs: profileName === 'mobile' ? 40000 : 35000,
  // Мобильный замер с замедлением сети и процессора обычно идёт примерно на 15% дольше десктопного
  nextStage: process.env.AUDIT_NEXT === 'mobile' ? { label: 'мобильный этап', factor: 1.15 } : null,
});
const log = (msg) => progress.log(msg);
// Клавиши: P — пауза/продолжить, Ctrl+C — остановить
const stopKeys = listenKeys({ onPause: () => progress.togglePause(), onStop: stop });
if (doneCount()) log(`Продолжаю прерванную проверку: уже готово ${doneCount()} из ${jobs.length} стр.`);
if (process.stdin.isTTY) log('Во время проверки: P — пауза / продолжить, Ctrl+C — остановить.\n');

const pages = new Array(jobs.length);
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const idx = next++;
    const job = jobs[idx];
    if (state.done[idx]) {
      pages[idx] = state.done[idx];
      continue;
    }
    const runs = [];
    log(`Страница ${idx + 1} из ${jobs.length}: ${job.url}`);
    progress.startPage(idx, job.url);
    for (let i = 0; i < opts.runs; i++) {
      await progress.step(`прогон ${i + 1} из ${opts.runs}`);
      const r = await measurePage(browser, job.url, profile, { ...opts, extras: i === 0, screencast: opts.filmstrip && i === 0 });
      progress.stepDone();
      runs.push(r);
      const m = r.metrics;
      log(`  прогон ${i + 1}/${opts.runs}: ` +
        (m ? `TTFB ${fmtMs(m.ttfb)}, LCP ${fmtMs(m.lcp)}, load ${m.load ? fmtMs(m.load) : 'не наступил'}` : `ошибка: ${r.error}`));
    }
    const p = analyzePage(job, runs, opts);
    pages[idx] = p;
    if (p.metrics) await enrich(p, job, runs);
    progress.endPage();
    state.done[idx] = p;
    checkpoint.save(state);
    const errs = p.errors?.filter((e) => isError(e.cls)).length ?? 0;
    log(`→ [${p.grade}] рекомендаций ${p.recs.length}, ошибок ресурсов ${errs}, не-200 всего ${p.errors?.length ?? 0}\n`);
  }
}

// Тот же путь на прод-домене (для тестового контура)
function prodUrlOf(job) {
  const u = new URL(job.url);
  u.protocol = 'https:';
  u.hostname = job.prod;
  u.port = ''; // порт тестового стенда к проду не относится
  return u.href;
}

// Дополнительные страницы — конкуренты или прод для тестового контура: те же прогоны, раскадровка и данные
// реальных посетителей, без углублённых тестов. Готовые сохраняются сразу — прерванная проверка продолжится с того же места.
async function measureRivals(urls, stageLabel, itemLabel) {
  if (!urls.length) return;
  state.rivals ??= {};
  progress.finish();
  progress = new Progress({
    total: urls.length,
    done: urls.filter((u) => state.rivals[u]).length,
    plan: () => [...Array(opts.runs).fill(WEIGHT.run), ...(crux ? [WEIGHT.crux] : [])],
    stage: [process.env.AUDIT_STAGE, profileName === 'mobile' ? 'Мобильный' : 'Десктоп', stageLabel].filter(Boolean).join(' · '),
    unitGuessMs: profileName === 'mobile' ? 40000 : 35000,
    nextStage: process.env.AUDIT_NEXT === 'mobile' ? { label: 'мобильный этап', factor: 1.15 } : null,
  });
  log(`Дополнительные страницы (${stageLabel}): ${urls.length}`);
  for (const [i, url] of urls.entries()) {
    if (state.rivals[url]) continue;
    log(`${itemLabel} ${i + 1} из ${urls.length}: ${url}`);
    progress.startPage(i, url);
    const runs = [];
    for (let k = 0; k < opts.runs; k++) {
      await progress.step(`прогон ${k + 1} из ${opts.runs}`);
      runs.push(await measurePage(browser, url, profile, { ...opts, extras: false, screencast: opts.filmstrip && k === 0 }));
      progress.stepDone();
      const m = runs.at(-1).metrics;
      log(`  прогон ${k + 1}/${opts.runs}: ` + (m ? `TTFB ${fmtMs(m.ttfb)}, LCP ${fmtMs(m.lcp)}, load ${m.load ? fmtMs(m.load) : 'не наступил'}` : `ошибка: ${runs.at(-1).error}`));
    }
    const p = analyzePage({ site: new URL(url).origin, url, internal: [] }, runs, opts);
    const extras = {};
    if (p.metrics && opts.filmstrip) extras.filmstrip = filmstripSummary(runs.find((r) => r.frames), { mobile: profileName === 'mobile' });
    if (p.metrics && crux) {
      await progress.step('данные реальных посетителей (CrUX)');
      extras.field = fieldSummary(p, await crux.query(url, profileName));
      progress.stepDone();
    }
    state.rivals[url] = rivalResult(url, p, extras);
    checkpoint.save(state);
    progress.endPage();
  }
}

// Углублённая аналитика страницы: дополнительные прогоны и проверки
async function enrich(p, job, runs) {
  const okRuns = runs.filter((r) => r.metrics);
  const rep = okRuns.find((r) => r.metrics === p.repMetrics) ?? okRuns[0];
  const first = okRuns.find((r) => r.extras) ?? rep;
  const isInternal = makeInternalMatcher(job.site, job.internal);
  const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
  const x = (p.extras = {
    lcpBreakdown: lcpBreakdown(p),
    server: serverInfo(rep),
    images: imagesAudit(p, first),
    fonts: fontsAudit(p, first),
    dom: domInfo(first),
    clsSources: clsSources(okRuns),
    filmstrip: opts.filmstrip ? filmstripSummary(runs.find((r) => r.frames), { mobile: profileName === 'mobile' }) : undefined,
  });

  if (opts.blocktest) {
    const scenarios = [{ key: 'noext', label: 'Без всех внешних сервисов', block: (u) => /^https?:/.test(u) && !isInternal(hostOf(u)), n: opts.blockRuns }];
    const candidates = pickBlockCandidates(p, opts.blockServices);
    for (const svc of candidates) {
      scenarios.push({ key: `svc:${svc}`, label: `Без «${svc}»`, service: svc, block: (u) => /^https?:/.test(u) && !isInternal(hostOf(u)) && serviceOf(u).name === svc, n: 1 });
    }
    // Теперь известно, сколько сервисов будем блокировать — уточняем план страницы
    progress.setSteps([
      ...Array(opts.blockRuns).fill(WEIGHT.blockAll), ...Array(candidates.length).fill(WEIGHT.blockOne),
      ...(opts.warm ? Array(1 + opts.warmRuns).fill(WEIGHT.warm) : []),
      ...(opts.inp ? [WEIGHT.inp] : []),
      ...(opts.coverage ? [WEIGHT.coverage] : []), ...(opts.seo ? [WEIGHT.seo] : []), ...(crux ? [WEIGHT.crux] : []),
    ]);
    for (const sc of scenarios) {
      sc.runs = [];
      for (let i = 0; i < sc.n; i++) {
        await progress.step(`${sc.label.toLowerCase().replace(/^без/, 'тест без')}${sc.n > 1 ? ` (${i + 1} из ${sc.n})` : ''}`);
        const r = await measurePage(browser, job.url, profile, { ...opts, block: sc.block });
        progress.stepDone();
        sc.runs.push(r);
        const m = r.metrics;
        log(`  ${sc.label}: ` + (m ? `LCP ${fmtMs(m.lcp)}, load ${m.load ? fmtMs(m.load) : 'не наступил'}` : `ошибка: ${r.error}`));
      }
    }
    x.blockTest = blockTestSummary(p, scenarios);
  }
  if (opts.warm) {
    const warm = await measureWarm(browser, job.url, profile, opts, opts.warmRuns, {
      step: (label) => progress.step(label),
      done: () => progress.stepDone(),
    });
    x.warm = warmSummary(p, warm);
    if (opts.filmstrip) x.filmstripWarm = filmstripSummary(warm.runs.find((r) => r.frames), { mobile: profileName === 'mobile', warm: true });
    const w = x.warm;
    log(w.error ? `  Повторный визит: ошибка — ${w.error}` :
      `  Повторный визит: LCP ${fmtMs(w.m.lcp)} (первый визит ${fmtMs(p.metrics.lcp)}), load ${w.m.load ? fmtMs(w.m.load) : 'не наступил'}, по сети ${kb(w.net.warm)} вместо ${kb(w.net.cold)}`);
  }
  if (opts.inp) {
    await progress.step('тест отклика на нажатия');
    x.interactions = interactionsSummary(job, await measureInteractions(browser, job.url, profile, opts, actionsFor(actionsConfig, job.url)));
    progress.stepDone();
    const ia = x.interactions;
    log(ia.error && !ia.rows.length ? `  Отклик на нажатия: ${ia.error}` :
      `  Отклик на нажатия: худший ${ia.inp == null ? '< 16 мс' : fmtMs(ia.inp)} — ${ia.rows.map((r) => `${r.label} ${r.error ? 'не нажалось' : r.fast ? '< 16 мс' : fmtMs(r.dur)}`).join(', ')}`);
  }
  if (opts.coverage) {
    await progress.step('замер неиспользуемого кода');
    const cov = await measureCoverage(browser, job.url, profile, opts);
    progress.stepDone();
    x.coverage = coverageSummary(job, cov);
    if (x.coverage?.js) log(`  Покрытие кода: JS не используется ${kb(x.coverage.js.unused)} из ${kb(x.coverage.js.total)}`);
  }
  if (opts.seo) {
    await progress.step('SEO-проверки');
    x.seo = seoSummary(p, await checkSeo(job.url, first.extras?.seo ?? null));
    progress.stepDone();
    log(`  SEO: ${x.seo.checks.filter((c) => c.level === 'bad').length} критичных, ${x.seo.checks.filter((c) => c.level === 'warn').length} предупреждений`);
  }
  if (crux) {
    await progress.step('данные реальных посетителей (CrUX)');
    x.field = fieldSummary(p, await crux.query(job.url, profileName));
    progress.stepDone();
    const f = x.field;
    log(f.error ? `  Реальные посетители: ${f.error}` : !f.level ? '  Реальные посетители: в CrUX мало данных по этому сайту'
      : `  Реальные посетители (${f.level === 'url' ? 'страница' : 'весь сайт'}): LCP ${fmtMs(f.metrics.lcp?.p75)}, INP ${fmtMs(f.metrics.inp?.p75)}, CLS ${f.metrics.cls?.p75 ?? '—'} — Core Web Vitals ${f.cwvPass ? 'пройдены' : 'не пройдены'}`);
  }
  p.recs = mergeRecs(p.recs, extraRecs(p, opts), p);
}

await Promise.all(Array.from({ length: Math.min(opts.concurrency, jobs.length) }, worker));
await measureRivals([...new Set(competitorGroups.active.flatMap((g) => g.rivals))], 'конкуренты', 'Конкурент');
if (opts.prodCompare) await measureRivals([...new Set(jobs.filter((j) => j.prod).map(prodUrlOf))], 'прод для сравнения', 'Прод');
progress.finish();
stopKeys();

await browser.close();
const finishedAt = new Date();

// Результаты раскладываются по сайтам: у каждого сайта свой отчёт, своя сводка сервисов и своё сравнение
const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csv = (rows) => '\uFEFF' + rows.map((r) => r.map(esc).join(';')).join('\n');
const bySite = groupBy(pages.map((p, i) => [p, jobs[i]]), ([, job]) => siteKey(job.url));
const reportPaths = [];

const allProd = [];
for (const [site, entries] of bySite) {
  const sitePages = entries.map(([p]) => p);
  markDuplicateTitles(sitePages);
  const services = summarizeServices(sitePages, opts);
  const dir = `${REPORTS}/${site}/${STAMP}/${profileName}`;
  await mkdir(dir, { recursive: true });
  const prev = findPrevious(`${REPORTS}/${site}`, `${REPORTS}/${site}/${STAMP}`, profileName);
  const compare = comparePages(sitePages, prev);
  // Бюджет: что вышло за пороги budgets.txt — впервые или так же, как в прошлой проверке
  const limits = budgetsFor(budgetsConfig, site, profileName);
  const prevByPage = new Map((prev?.data.pages || []).map((q) => [q.page, q]));
  for (const p of sitePages) p.budget = checkBudget(p, limits, prevByPage.get(p.page)?.budget);
  // Сравнение с конкурентами: группы, наша страница которых — на этом сайте
  const sameUrl = (a, b) => a.replace(/\/$/, '') === b.replace(/\/$/, '');
  // Тест против прода: каждая тестовая страница — рядом с тем же путём на проде
  const prodCompare = opts.prodCompare ? entries.filter(([, job]) => job.prod).map(([p, job]) => prodPair(p, state.rivals?.[prodUrlOf(job)] ?? { url: prodUrlOf(job), site: job.prod, error: 'не замерялась' })) : null;
  allProd.push(...(prodCompare || []));
  const competitors = opts.competitors ? competitorGroups.active.filter((g) => siteKey(g.ours) === site).map((g) => compareGroup(g,
    sitePages.find((p) => sameUrl(p.page, g.ours)),
    g.rivals.map((u) => state.rivals?.[u] ?? { url: u, site: hostOf(u), error: 'не замерялась' }))) : null;

  // При полной проверке (оба разрешения) HTML создаётся один — общий, с вкладками; здесь сохраняются только данные и CSV
  const combined = process.env.AUDIT_COMBINED === '1';
  if (!combined) {
    await writeFile(`${dir}/${profileName}_report.html`, renderReport({ pages: sitePages, services, opts, profile, startedAt, finishedAt, compare, competitors, prodCompare }));
    if (opts.tasks) {
      const list = buildTasks([{ name: profileName, pages: sitePages }]);
      await writeFile(`${dir}/tasks.html`, tasksHtml(list, { site, report: `${profileName}_report.html`, startedAt }));
      await writeFile(`${dir}/tasks.csv`, tasksCsv(list, { site, report: `${profileName}_report.html` }));
    }
    if (opts.summary) await writeFile(`${dir}/summary.html`, renderSummary([{ name: profileName, profile, pages: sitePages, compare, startedAt, competitors }], { site, fullReport: `${profileName}_report.html` }));
  }
  await writeFile(`${dir}/data.json`, JSON.stringify({ site, opts, profile: profile.label, profileName, startedAt, finishedAt, compare, pages: sitePages, services, competitors, prodCompare }, null, 2));
  await writeFile(`${dir}/pages.csv`, csv([
    ['page', 'grade', 'ttfb_ms', 'fcp_ms', 'lcp_ms', 'tbt_ms', 'cls', 'dcl_ms', 'load_ms', 'requests', 'bytes', 'ext_services', 'non200', 'errors',
      'repeat_ttfb_ms', 'repeat_lcp_ms', 'repeat_load_ms', 'repeat_network_bytes', 'repeat_from_cache', 'inp_lab_ms',
      'field_level', 'field_lcp_p75_ms', 'field_inp_p75_ms', 'field_cls_p75', 'field_fcp_p75_ms', 'field_ttfb_p75_ms', 'field_cwv', 'over_budget'],
    ...sitePages.map((p) => p.metrics
      ? [p.page, p.grade, p.metrics.ttfb, p.metrics.fcp, p.metrics.lcp, p.metrics.tbt, p.metrics.cls, p.metrics.dcl, p.metrics.load ?? 'не наступил',
        p.totals.requests, p.totals.bytes, p.totals.extServices, p.errors.length, p.errors.filter((e) => isError(e.cls)).length,
        ...((w) => (w && !w.error ? [w.m.ttfb, w.m.lcp, w.m.load ?? 'не наступил', w.net.warm, w.counts.cached] : ['', '', '', '', '']))(p.extras?.warm),
        ((ia) => (ia && !ia.error ? (ia.inp ?? '<16') : ''))(p.extras?.interactions),
        ...((f) => (f?.level ? [f.level === 'url' ? 'страница' : 'сайт', ...['lcp', 'inp', 'cls', 'fcp', 'ttfb'].map((k) => f.metrics[k]?.p75 ?? ''), f.cwvPass == null ? '' : f.cwvPass ? 'пройдены' : 'не пройдены']
          : ['', '', '', '', '', '', '']))(p.extras?.field),
        (p.budget?.over || []).map((o) => `${BUDGET_KEYS[o.key].label}: ${fmtBudget(o.key, o.value)} > ${fmtBudget(o.key, o.limit)}`).join('; ')]
      : [p.page, 'error', '', '', '', '', '', '', '', '', '', '', '', p.error]),
  ]));
  await writeFile(`${dir}/resources.csv`, csv([
    ['page', 'internal', 'service', 'category', 'type', 'status', 'duration_ms', 'start_ms', 'end_ms', 'bytes', 'cpu_ms', 'render_blocking', 'phase', 'url'],
    ...sitePages.flatMap((p) => (p.resources || []).map((r) => [p.page, r.internal ? 'свой' : 'внешний', r.service, r.category, r.type, r.status,
      r.duration, r.start, r.end, r.bytes, r.cpu, r.renderBlocking ? 'да' : '', r.phase, r.url])),
  ]));
  // Нарушения бюджета отдельным файлом — удобно отфильтровать или переслать
  await writeFile(`${dir}/budget.csv`, csv([
    ['page', 'metric', 'value', 'budget', 'times_over', 'status'],
    ...sitePages.flatMap((p) => (p.budget?.failed ? [[p.page, 'страница не открылась', '', '', '', '']] : (p.budget?.over || []).map((o) => [p.page, BUDGET_KEYS[o.key].label, fmtBudget(o.key, o.value), fmtBudget(o.key, o.limit),
      o.ratio ? o.ratio.toFixed(2) : '', { new: 'впервые', repeat: 'повторно', unknown: '' }[o.status]]))),
  ]));
  if (competitors?.length) {
    await writeFile(`${dir}/competitors.csv`, csv([
      ['group', 'site', 'ours', 'url', 'grade', 'ttfb_ms', 'fcp_ms', 'lcp_ms', 'tbt_ms', 'cls', 'load_ms', 'bytes', 'requests', 'ext_services', 'field_lcp_p75_ms', 'field_inp_p75_ms', 'field_cls_p75', 'error'],
      ...competitors.flatMap((g) => g.rows.map((r) => [g.name, r.site, r.ours ? 'да' : '', r.url, r.grade ?? '',
        ...(r.metrics ? [...['ttfb', 'fcp', 'lcp', 'tbt'].map((k) => (r.metrics[k] == null ? '' : Math.round(r.metrics[k]))), r.metrics.cls, r.metrics.load == null ? 'не наступил' : Math.round(r.metrics.load), r.totals.bytes, r.totals.requests, r.totals.extServices] : ['', '', '', '', '', '', '', '', '']),
        ...['lcp', 'inp', 'cls'].map((k) => r.extras?.field?.metrics?.[k]?.p75 ?? ''), r.error ?? ''])),
    ]));
  }
  await writeFile(`${dir}/services.csv`, csv([
    ['service', 'category', 'verdict', 'reason', 'pages', 'requests', 'max_duration_ms', 'cpu_avg_ms', 'bytes'],
    ...services.map((s) => [s.service, s.category, s.verdict, s.reason, s.pages, s.requests, s.maxDuration, s.cpuAvg, s.bytes]),
  ]));

  console.log(`\n${site} (${sitePages.length} стр.)${compare ? ` — сравнение с проверкой ${compare.prevName}` : ' — первая проверка этого сайта'}`);
  const overPages = sitePages.filter((p) => p.budget?.over.length || p.budget?.failed);
  if (Object.keys(limits).length) console.log(`  Бюджет: ${overPages.length ? `вне бюджета ${overPages.length} из ${sitePages.length} стр.` : 'все страницы в бюджете'}`);
  console.log('  Внешние сервисы с ошибками:', services.filter((s) => s.verdict === 'disable').map((s) => s.service).join(', ') || 'нет');
  console.log('  Рекомендуется грузить отложенно:', services.filter((s) => s.verdict === 'defer').map((s) => s.service).join(', ') || 'нет');
  console.log(combined ? `  Данные: ${dir}/ (общий отчёт будет собран после обоих этапов)` : `  Отчёт: ${dir}/${profileName}_report.html${opts.summary ? `\n  Краткая сводка: ${dir}/summary.html` : ''}${opts.tasks ? `\n  Задачи для трекера: ${dir}/tasks.html` : ''}`);
  // В режиме --both эти файлы не создаются — итог печатает родительский процесс
  reportPaths.push(`${dir}/${profileName}_report.html`, ...(opts.summary ? [`${dir}/summary.html`] : []), ...(opts.tasks ? [`${dir}/tasks.html`] : []));
}

// Этап завершён: при проверке одного разрешения сохранение больше не нужно;
// в режиме --both оно остаётся до конца второго этапа (родитель удалит его сам)
if (process.env.AUDIT_COMBINED === '1') checkpoint.save({ ...state, complete: true });
else checkpoint.remove();

// Итог для проверки одного разрешения (в режиме --both итог печатает родительский процесс после общего отчёта)
if (process.env.AUDIT_COMBINED !== '1') {
  printFinal({
    startedAt: now.getTime(),
    pagesTotal: pages.length,
    failed: pages.filter((p) => !p.metrics).map((p) => ({ page: p.page, error: p.error || 'страница не открылась' })),
    reports: reportPaths,
    budget: budgetDigest(pages.map((p) => ({ page: p.page, budget: p.budget }))),
    prod: prodDigest(allProd),
  });
}

// Одинаковый title на разных страницах одного сайта — слабый сигнал для поиска
function markDuplicateTitles(sitePages) {
  const byTitle = new Map();
  for (const p of sitePages) {
    const t = p.extras?.seo?.rendered?.title || p.extras?.seo?.raw?.title;
    if (t) byTitle.set(t, [...(byTitle.get(t) || []), p]);
  }
  for (const [t, list] of byTitle) {
    if (list.length < 2) continue;
    for (const p of list) {
      p.extras.seo.checks.unshift({ level: 'warn', title: `Одинаковый title на ${list.length} проверенных страницах`, detail: `«${t}». У каждой страницы должен быть свой title с названием раздела или товара.` });
    }
  }
}
