// Тест скорости оформления заказа с входом по коду из SMS или письма.
// Запуск: node checkout.js [checkout.txt] [--site=shop.example.com] [--mobile | --desktop] [--check | --no-order] [--headless] [--timeout=45000]
// ВНИМАНИЕ: без --no-order создаётся НАСТОЯЩИЙ заказ — отмените его после теста.
import { chromium } from 'playwright';
import { writeFile, mkdir, readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';
import { PROFILES } from './lib/collect.js';
import { loadCheckout, scenarioOf, actionText } from './lib/checkout-config.js';
import { runCheckout, Prompt, Secrets, fmt } from './lib/checkout.js';
import { renderCheckout, checkoutRecs } from './lib/report-checkout.js';
import { ensureFromExample } from './lib/settings.js';

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
let siteName = flag('site')?.toLowerCase().replace(/^www\./, '');
if (siteName && !sites[siteName]) { console.error(`Сайта «${siteName}» нет в ${basename(configPath)}. Есть: ${names.join(', ')}`); process.exit(1); }
if (!siteName && names.length === 1) siteName = names[0];
while (!siteName) {
  names.forEach((x, i) => log(`  ${i + 1}. ${x}`));
  const a = (await prompt.ask('Какой сайт проверить (номер): ').catch(() => process.exit(1))).trim();
  siteName = names[Number(a) - 1];
}
const raw = sites[siteName];
if (!raw.product || !raw.delivery || !raw.payment) {
  console.error(`В секции [${siteName}] не хватает настроек (товар, получение, оплата) — см. предупреждения выше.`);
  process.exit(1);
}
const sc = scenarioOf(raw);
const device = args.includes('--desktop') ? 'desktop' : args.includes('--mobile') ? 'mobile' : sc.device;
const profile = PROFILES[device];
// --check: проверка сценария гостем — без входа и без заказа (проверить, что кнопки из checkout.txt находятся на сайте)
const check = args.includes('--check');
const opts = { timeout: Number(flag('timeout') ?? 45000), noOrder: check || args.includes('--no-order'), check };

log(`\n${color('1', `Тест оформления заказа: ${siteName}`)} · ${profile.label}`);
log(sc.products.length > 1 ? `Товары (${sc.products.length}):\n${sc.products.map((u) => `  • ${u}`).join('\n')}` : `Товар: ${sc.product}`);
if (sc.cleanCart) log('Товары, которые уже лежат в корзине аккаунта, будут удалены из неё — в заказ попадут только товары из checkout.txt.');
log(`Получение: «${actionText(sc.delivery)}»${sc.store ? `, магазин «${actionText(sc.store)}»` : ''} · оплата: «${actionText(sc.payment)}»`);
log(check
  ? color('36', 'Проверка сценария (--check): без входа в аккаунт и без заказа — агент проверит, что кнопки из настроек находятся на сайте.')
  : opts.noOrder
  ? color('36', 'Режим без заказа (--no-order): агент дойдёт до кнопки «Оформить заказ» и не нажмёт её.')
  : color('1;33', '⚠ Будет оформлен НАСТОЯЩИЙ заказ. После теста отмените его в личном кабинете или попросите оператора.'));
log('Остановить тест в любой момент: Ctrl+C (агент выйдет из аккаунта и закроет браузер).\n');

const secrets = new Secrets();
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
let outDir = `${REPORTS}/${siteName}/${STAMP}/checkout`;
for (let i = 2; existsSync(outDir); i++) outDir = `${REPORTS}/${siteName}/${STAMP}_${i}/checkout`;
await mkdir(outDir, { recursive: true });
const data = {
  kind: 'checkout', site: siteName, device, profile: profile.label, startedAt, finishedAt: new Date(),
  product: sc.product, products: result.products ?? sc.products.map((url) => ({ url, title: '' })), removed: result.removed ?? [], productTitle: result.productTitle, login: result.method,
  delivery: actionText(sc.delivery), store: sc.store ? actionText(sc.store) : '', payment: actionText(sc.payment), placeOrder: sc.placeOrder,
  order: result.order, error: result.error, stoppedAt: check && !result.error ? 'проверка сценария' : result.stoppedAt, check, loggedOut: result.loggedOut, notes: result.notes,
  steps: result.steps,
};
data.recs = checkoutRecs(data.steps, data.order);
const prev = await findPrevious(siteName, STAMP);
await writeFile(`${outDir}/data.json`, JSON.stringify(data));
await writeFile(`${outDir}/checkout_report.html`, renderCheckout(data, prev));

const line = '─'.repeat(Math.min(process.stdout.columns || 70, 70));
log(`\n${line}`);
if (result.error) log(color('1;33', `⚠ Тест прерван на шаге «${result.stoppedAt}»: ${result.error}`));
else if (result.stoppedAt === 'остановлено вручную') log(color('1;33', '⏹ Тест остановлен вручную'));
else log(color('1;32', '✅ Тест оформления завершён'));
const flow = data.steps.filter((s) => !/^(Главная страница|Форма входа|Отправка кода|Проверка кода|Проверка, что корзина пуста|Удаление других товаров|Карточка товара.* — первый заход)/.test(s.name) && !s.error);
if (flow.length) {
  const slow = [...flow].sort((a, b) => b.dur - a.dur)[0];
  log(`   От карточки товара до ${opts.noOrder ? 'выбора оплаты' : 'заказа'}: ${fmt(flow.reduce((a, s) => a + s.dur, 0))}; самый медленный шаг — «${slow.name}» (${fmt(slow.dur)})`);
}
if (result.order?.confirmed) log(color('1;33', `   Заказ ${result.order.number ? `№ ${result.order.number} ` : ''}создан — не забудьте отменить его.`));
log(`   Рекомендаций: ${data.recs.length}`);
log(`   Отчёт: ${outDir}/checkout_report.html`);
log(line);
process.exit(result.error ? 2 : 0);

// Прошлый тест оформления того же сайта — для сравнения шагов
async function findPrevious(site, stamp) {
  try {
    const dirs = (await readdir(`${REPORTS}/${site}`)).filter((x) => x < stamp).sort().reverse();
    for (const d of dirs) {
      try {
        const x = JSON.parse(await readFile(`${REPORTS}/${site}/${d}/checkout/data.json`, 'utf8'));
        // Сравниваем только с тестом на том же устройстве, где оформление дошло хотя бы до карточки товара
        if (x.device === device && x.steps?.some((s) => s.name.startsWith('Карточка товара') && !s.error)) return x;
      } catch {}
    }
  } catch {}
  return null;
}
