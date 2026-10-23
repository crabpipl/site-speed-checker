// Тест скорости оформления заказа с входом по коду из SMS или письма.
// Запуск: node checkout.js [checkout.txt] [--site=shop.example.com] [--mobile | --desktop] [--check | --no-order | --record] [--headless] [--no-cursor] [--timeout=45000]
// ВНИМАНИЕ: без --no-order создаётся НАСТОЯЩИЙ заказ — отмените его после теста.
import { chromium } from 'playwright';
import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { PROFILES } from './lib/collect.js';
import { loadCheckout, scenarioOf, actionText, KEY_OF, siteName as sectionName, domainOf } from './lib/checkout-config.js';
import { runCheckout, Prompt, Secrets, fmt } from './lib/checkout.js';
import { renderCheckout, checkoutRecs, LOGIN_STEPS, markLegacy } from './lib/report-checkout.js';
import { checkoutTasks, checkoutTasksHtml, checkoutTasksCsv, conditionsOf } from './lib/checkout-tasks.js';
import { ensureFromExample } from './lib/settings.js';
import { runRecord, sectionText, saveSection } from './lib/checkout-record.js';

const args = process.argv.slice(2);
const PROJECT = dirname(fileURLToPath(import.meta.url));
const REPORTS = resolve(process.env.REPORTS_ROOT ?? `${PROJECT}/reports`);
const flag = (name) => args.find((x) => x.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const pad = (n) => String(n).padStart(2, '0');
const now = new Date();
const STAMP = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}`;
const color = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const log = (s) => console.log(s);

const configPath = resolve(args.find((x) => !x.startsWith('--')) ?? `${PROJECT}/checkout.txt`);

// --rebuild=<папка отчёта>: пересобрать checkout_report.html и задачи по сохранённому data.json (текущей версией агента)
if (flag('rebuild')) {
  const dir = resolve(flag('rebuild'));
  const d = markLegacy(JSON.parse(await readFile(`${dir}/data.json`, 'utf8')));
  d.recs = checkoutRecs(d.steps, d.order);
  await writeFile(`${dir}/checkout_report.html`, renderCheckout(d, null));
  const t = checkoutTasks(d);
  const ctx = { site: d.site, report: 'checkout_report.html', date: new Date(d.startedAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }), device: d.profile, kind: d.stoppedAt, conditions: d.conditions };
  await writeFile(`${dir}/tasks.html`, checkoutTasksHtml(t, ctx));
  await writeFile(`${dir}/tasks.csv`, checkoutTasksCsv(t, ctx));
  const bad = d.steps.filter((s) => s.invalid).map((s) => s.name);
  log(`Пересобрано: ${dir}\n  рекомендаций: ${d.recs.length}, задач: ${t.length}${bad.length ? `\n  шаги не в счёт: ${bad.join('; ')}` : ''}`);
  process.exit(0);
}

// --record: запись сценария — человек проходит оформление в открытом браузере, агент запоминает нажатия
if (args.includes('--record')) {
  const created = ensureFromExample(configPath);
  const { sites } = loadCheckout(configPath);
  const prompt = new Prompt();
  let site = flag('site')?.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  while (!site) site = (await prompt.ask('Адрес сайта, например shop.example.com: ').catch(() => process.exit(1))).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '');
  const device = args.includes('--desktop') ? 'desktop' : args.includes('--mobile') ? 'mobile' : sites[site]?.device || 'mobile';
  log(`\n${color('1', `Запись сценария оформления: ${site}`)} · ${PROFILES[device].label}`);
  log('Откроется окно браузера. Проходите оформление как покупатель, а в Терминале нажимайте Enter после каждого шага.');
  log('Записываются только нажатия и адрес товара — то, что вы вводите (телефон, код), не записывается. Заказ не создаётся.');
  if (created) log(`Создан файл ${basename(configPath)} из образца — секция сайта будет добавлена в него.`);
  // Окно браузера всегда видно: по нему человек и проходит оформление
  const browser = await chromium.launch({ headless: false, handleSIGINT: false });
  let rec;
  try {
    rec = await runRecord({ browser, profile: PROFILES[device], startUrl: `https://${site}/`, prompt, log, color });
  } catch (e) {
    await browser.close().catch(() => {});
    log(color('33', `\nЗапись остановлена: ${e.message.split('\n')[0]}`));
    process.exit(1);
  }
  await browser.close().catch(() => {});
  const text = sectionText(site, rec, device);
  log(`\n${color('1', 'Записанная секция:')}\n\n${text}`);
  const exists = !!sites[site];
  const a = (await prompt.ask(exists ? `Заменить секцию [${site}] в ${basename(configPath)} этой записью? (Д/н): ` : `Добавить секцию в ${basename(configPath)}? (Д/н): `).catch(() => 'н')).trim().toLowerCase();
  if (/^(н|n|нет)/.test(a)) {
    log('Не сохранено. Секцию выше можно скопировать в checkout.txt вручную.');
  } else {
    const r = saveSection(configPath, site, text);
    log(color('32', `✓ ${r.replaced ? 'Секция заменена' : 'Секция добавлена'}: ${configPath}${r.backup ? `\n  Копия прежнего файла: ${r.backup}` : ''}`));
    log('Проверьте сценарий без входа и без заказа:');
    log(`  npm run audit:checkout -- --check --site=${site}`);
  }
  process.exit(0);
}

if (ensureFromExample(configPath)) {
  log(`Создан файл ${basename(configPath)} из образца. Впишите в него товар, способ получения и оплаты для своего сайта и запустите тест снова:\n  ${configPath}`);
  process.exit(0);
}
const { sites, warnings, missing } = loadCheckout(configPath);
if (missing) { console.error(`Не найден файл настроек теста оформления: ${configPath}`); process.exit(1); }
for (const w of warnings) console.warn(color('33', `⚠ ${w}`));
const names = Object.keys(sites);
if (!names.length) { console.error(`В ${basename(configPath)} нет ни одного сайта. Добавьте секцию [сайт] — образец в checkout.example.txt.`); process.exit(1); }

const prompt = new Prompt();
let siteName = flag('site') ? sectionName(flag('site')) : undefined;
if (siteName && !sites[siteName]) { console.error(`Сайта «${siteName}» нет в ${basename(configPath)}. Есть: ${names.join(', ')}`); process.exit(1); }
if (!siteName && names.length === 1) siteName = names[0];
while (!siteName) {
  names.forEach((x, i) => log(`  ${i + 1}. ${x}`));
  const a = (await prompt.ask('Какой сайт проверить (номер): ').catch(() => process.exit(1))).trim();
  siteName = names[Number(a) - 1];
}
const raw = sites[siteName];
// В режиме проверки (--check) для нового сайта достаточно товара: агент дойдёт до выбора способа получения
// и покажет варианты, которые есть на странице, — готовыми строками для checkout.txt
if (!raw.product || (!args.includes('--check') && (!raw.delivery || !raw.payment))) {
  console.error(`В секции [${siteName}] не хватает настроек (${args.includes('--check') ? 'товар' : 'товар, получение, оплата'}) — см. предупреждения выше.` +
    (args.includes('--check') ? '' : '\nЧтобы подобрать тексты «получение» и «оплата», запустите проверку сценария с --check — агент подскажет варианты с сайта.'));
  process.exit(1);
}
if (args.includes('--check') && (!raw.delivery || !raw.payment)) {
  log(color('36', 'Не указаны «получение» и/или «оплата» — агент дойдёт до этих шагов и покажет варианты, которые есть на странице.'));
}
const sc = scenarioOf(raw);
// Один тест — один способ получения: при адресе доставки строки магазина не используются
const storeKeys = ['store', 'storeList', 'storeConfirm'].filter((k) => raw[k] && !raw.inherited?.[k]);
if (raw.address && storeKeys.length) log(color('33', `⚠ В секции [${siteName}] есть и «адрес доставки», и строки самовывоза (${storeKeys.map((k) => KEY_OF[k]).join(', ')}). Проверяется доставка курьером, строки магазина не используются. Чтобы проверить самовывоз — уберите «адрес доставки».`));
// Откуда взяты настройки: общая секция [все сайты] и «основа = …»
if (Object.keys(raw.inherited || {}).length) {
  const by = {};
  for (const [f, src] of Object.entries(raw.inherited)) (by[src] ??= []).push(KEY_OF[f] || f);
  log(color('36', `Настройки из других секций: ${Object.entries(by).map(([src, keys]) => `[${src}] — ${keys.join(', ')}`).join('; ')}`));
}
const device = args.includes('--desktop') ? 'desktop' : args.includes('--mobile') ? 'mobile' : sc.device;
const profile = PROFILES[device];
// --check: проверка сценария гостем — без входа и без заказа (проверить, что кнопки из checkout.txt находятся на сайте)
const check = args.includes('--check');
// Курсор и подсветка нажатий в окне браузера — когда окно видно (без --headless); выключить: --no-cursor
const opts = { timeout: Number(flag('timeout') ?? 45000), noOrder: check || args.includes('--no-order'), check, cursor: args.includes('--cursor') || (!args.includes('--headless') && !args.includes('--no-cursor')) };

log(`\n${color('1', `Тест оформления заказа: ${siteName}`)} · ${profile.label}`);
log(sc.products.length > 1 ? `Товары (${sc.products.length}):\n${sc.products.map((u) => `  • ${u}`).join('\n')}` : `Товар: ${sc.product}`);
if (sc.cleanCart) log('Товары, которые уже лежат в корзине аккаунта, будут удалены из неё — в заказ попадут только товары из checkout.txt.');
log(`Получение: ${sc.delivery?.length ? `«${actionText(sc.delivery)}»` : 'не указано'}${sc.address ? `, адрес «${sc.address}»` : sc.store ? `, магазин «${actionText(sc.store)}»` : ''} · оплата: ${sc.payment?.length ? `«${actionText(sc.payment)}»` : 'не указана'}`);
log(check
  ? color('36', 'Проверка сценария (--check): без входа в аккаунт и без заказа — агент проверит, что кнопки из настроек находятся на сайте.')
  : opts.noOrder
  ? color('36', 'Режим без заказа (--no-order): агент дойдёт до кнопки «Оформить заказ» и не нажмёт её.')
  : color('1;33', '⚠ Будет оформлен НАСТОЯЩИЙ заказ. После теста отмените его в личном кабинете или попросите оператора.'));
log('Остановить тест в любой момент: Ctrl+C (агент выйдет из аккаунта и закроет браузер).\n');

const secrets = new Secrets();
secrets.add(sc.recipient);
const startedAt = new Date();
// Окно браузера по умолчанию видно: можно следить за тестом и, если сайт покажет капчу, пройти её самому
const browser = await chromium.launch({ headless: args.includes('--headless'), handleSIGINT: false });
let result;
try {
  result = await runCheckout({ browser, profile, sc, prompt, secrets, opts, log });
} finally {
  await browser.close().catch(() => {});
  prompt.close();
}

// Два теста в одну минуту не должны затирать друг друга: вторая папка получает суффикс _2, _3…
// Отчёты всех сценариев сайта ([сайт], [сайт: курьер]) — в папке сайта
const domain = domainOf(siteName);
let outDir = `${REPORTS}/${domain}/${STAMP}/checkout`;
for (let i = 2; existsSync(outDir); i++) outDir = `${REPORTS}/${domain}/${STAMP}_${i}/checkout`;
await mkdir(outDir, { recursive: true });
const data = {
  kind: 'checkout', site: siteName, device, profile: profile.label, conditions: conditionsOf(profile), startedAt, finishedAt: new Date(),
  product: sc.product, products: result.products ?? sc.products.map((url) => ({ url, title: '' })), removed: result.removed ?? [], productTitle: result.productTitle, login: result.method,
  delivery: actionText(sc.delivery), store: sc.store && !sc.address ? actionText(sc.store) : '', address: sc.address || '', payment: actionText(sc.payment), placeOrder: sc.placeOrder,
  order: result.order, error: result.error, stoppedAt: check && !result.error ? 'проверка сценария' : result.stoppedAt, check, loggedOut: result.loggedOut, notes: result.notes, popups: (result.popups || []).map(({ kind, button, text }) => ({ kind, button, text })),
  steps: result.steps,
};
data.recs = checkoutRecs(data.steps, data.order);
const prev = await findPrevious(siteName, STAMP);
await writeFile(`${outDir}/data.json`, JSON.stringify(data));
await writeFile(`${outDir}/checkout_report.html`, renderCheckout(data, prev));
// Задачи для разработки: что исправить, где, что сделать, когда готово
const tasks = checkoutTasks(data);
const tctx = { site: siteName, report: 'checkout_report.html', date: startedAt.toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }), device: profile.label, kind: data.stoppedAt, conditions: conditionsOf(profile) };
await writeFile(`${outDir}/tasks.html`, checkoutTasksHtml(tasks, tctx));
await writeFile(`${outDir}/tasks.csv`, checkoutTasksCsv(tasks, tctx));

const line = '─'.repeat(Math.min(process.stdout.columns || 70, 70));
log(`\n${line}`);
if (result.error) log(color('1;33', `⚠ Тест прерван на шаге «${result.stoppedAt}»: ${result.error}`));
else if (result.stoppedAt === 'остановлено вручную') log(color('1;33', '⏹ Тест остановлен вручную'));
else log(color('1;32', '✅ Тест оформления завершён'));
const flow = data.steps.filter((s) => !LOGIN_STEPS.test(s.name) && !s.error && !s.invalid);
if (flow.length) {
  const slow = [...flow].sort((a, b) => b.dur - a.dur)[0];
  const tot = flow.reduce((a, s) => a + s.dur, 0), totFull = flow.reduce((a, s) => a + (s.full ?? s.dur), 0);
  log(`   От карточки товара до ${opts.noOrder ? 'выбора оплаты' : 'заказа'}: ${fmt(tot)} до готового контента${totFull - tot >= 1000 ? ` (с полной загрузкой ${fmt(totFull)})` : ''}; самый медленный шаг — «${slow.name}» (${fmt(slow.dur)})`);
}
if (result.order?.confirmed) log(color('1;33', `   Заказ ${result.order.number ? `№ ${result.order.number} ` : ''}создан — не забудьте отменить его.`));
log(`   Рекомендаций: ${data.recs.length} · задач для разработки: ${tasks.length}`);
log(`   Отчёт: ${outDir}/checkout_report.html`);
log(`   Задачи: ${outDir}/tasks.html`);
log(line);
process.exit(result.error ? 2 : 0);

// Прошлый тест оформления того же сайта — для сравнения шагов
async function findPrevious(site, stamp) {
  try {
    const dirs = (await readdir(`${REPORTS}/${domainOf(site)}`)).filter((x) => x < stamp).sort().reverse();
    for (const d of dirs) {
      try {
        const x = JSON.parse(await readFile(`${REPORTS}/${domainOf(site)}/${d}/checkout/data.json`, 'utf8'));
        // Сравниваем только с тестом того же сценария ([сайт] или [сайт: курьер]) на том же устройстве,
        // где оформление дошло хотя бы до карточки товара
        // Проверку гостем (--check) сравниваем только с проверкой гостем, тест со входом — только с тестом со входом
        if (x.site === site && x.device === device && !!x.check === check && x.steps?.some((s) => s.name.startsWith('Карточка товара') && !s.error)) return x;
      } catch {}
    }
  } catch {}
  return null;
}
