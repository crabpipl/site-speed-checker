// Определение «свой / внешний» и человекочитаемые имена известных сервисов.

// Двухуровневые публичные суффиксы, для которых регистрируемый домен — три метки.
const MULTI_SUFFIX = new Set([
  'com.ru', 'net.ru', 'org.ru', 'msk.ru', 'spb.ru', 'co.uk', 'org.uk', 'com.ua', 'co.il',
  'com.br', 'com.au', 'co.jp', 'com.tr', 'com.kz', 'org.kz', 'com.by',
]);

export function rootDomain(host) {
  const parts = host.toLowerCase().replace(/\.$/, '').split('.');
  if (parts.length <= 2) return parts.join('.');
  const last2 = parts.slice(-2).join('.');
  return MULTI_SUFFIX.has(last2) ? parts.slice(-3).join('.') : last2;
}

export function makeInternalMatcher(siteUrl, extra = []) {
  const roots = new Set([rootDomain(new URL(siteUrl).hostname), ...extra.map((d) => d.toLowerCase())]);
  return (host) => {
    host = host.toLowerCase();
    if (roots.has(rootDomain(host))) return true;
    for (const r of roots) if (host === r || host.endsWith('.' + r)) return true;
    return false;
  };
}

// [подстрока хоста или хост+путь, название, категория]
const KNOWN = [
  ['mc.yandex.', 'Яндекс Метрика', 'Аналитика'],
  ['mc.webvisor.', 'Яндекс Метрика (Вебвизор)', 'Аналитика'],
  ['yandex.ru/ads', 'Рекламная сеть Яндекса', 'Реклама'],
  ['an.yandex.', 'Рекламная сеть Яндекса', 'Реклама'],
  ['yastatic.net', 'Яндекс (статика)', 'CDN/библиотеки'],
  ['api-maps.yandex', 'Яндекс Карты', 'Виджеты'],
  ['smartcaptcha.yandexcloud', 'Yandex SmartCaptcha', 'Защита'],
  ['googletagmanager.com', 'Google Tag Manager', 'Тег-менеджер'],
  ['google-analytics.com', 'Google Analytics', 'Аналитика'],
  ['analytics.google.com', 'Google Analytics', 'Аналитика'],
  ['doubleclick.net', 'Google Ads / DoubleClick', 'Реклама'],
  ['googleadservices.com', 'Google Ads', 'Реклама'],
  ['googlesyndication.com', 'Google AdSense', 'Реклама'],
  ['google.com/recaptcha', 'Google reCAPTCHA', 'Защита'],
  ['gstatic.com', 'Google (статика)', 'CDN/библиотеки'],
  ['fonts.googleapis.com', 'Google Fonts', 'Шрифты'],
  ['youtube.com', 'YouTube', 'Виджеты'],
  ['connect.facebook.net', 'Facebook Pixel', 'Реклама'],
  ['top-fwz1.mail.ru', 'VK / Top@Mail.ru', 'Аналитика'],
  ['top.mail.ru', 'VK / Top@Mail.ru', 'Аналитика'],
  ['privacy-cs.mail.ru', 'VK / Mail.ru (синхронизация)', 'Реклама'],
  ['ad.mail.ru', 'VK Реклама (myTarget)', 'Реклама'],
  ['vk.com', 'VK пиксель / виджеты', 'Реклама'],
  ['vk.ru', 'VK пиксель / виджеты', 'Реклама'],
  ['ok.ru', 'Одноклассники', 'Реклама'],
  ['adriver.ru', 'AdRiver', 'Реклама'],
  ['hybrid.ai', 'Hybrid', 'Реклама'],
  ['gdeslon.ru', 'Где Слон', 'Партнёрский маркетинг'],
  ['admitad', 'Admitad', 'Партнёрский маркетинг'],
  ['cityads', 'CityAds', 'Партнёрский маркетинг'],
  ['actionpay', 'Actionpay', 'Партнёрский маркетинг'],
  ['criteo', 'Criteo', 'Реклама'],
  ['rutarget', 'Segmento / RuTarget', 'Реклама'],
  ['segmento', 'Segmento', 'Реклама'],
  ['dmp.one', 'DMP.one', 'Реклама'],
  ['tiktok', 'TikTok Pixel', 'Реклама'],
  ['mindbox', 'Mindbox', 'CRM/маркетинг'],
  ['retailrocket', 'Retail Rocket', 'Рекомендации'],
  ['diginetica', 'Diginetica', 'Поиск/рекомендации'],
  ['digi-api', 'Diginetica', 'Поиск/рекомендации'],
  ['flocktory', 'Flocktory', 'CRM/маркетинг'],
  ['jivosite', 'JivoSite', 'Чат'],
  ['jivo.ru', 'Jivo', 'Чат'],
  ['carrotquest', 'Carrot quest', 'Чат'],
  ['usedesk', 'UseDesk', 'Чат'],
  ['roistat', 'Roistat', 'Аналитика'],
  ['calltouch', 'Calltouch', 'Коллтрекинг'],
  ['comagic', 'CoMagic / UIS', 'Коллтрекинг'],
  ['uiscom', 'CoMagic / UIS', 'Коллтрекинг'],
  ['callibri', 'Callibri', 'Коллтрекинг'],
  ['uxfeedback', 'UXFeedback', 'Опросы'],
  ['hotjar', 'Hotjar', 'Аналитика'],
  ['clarity.ms', 'Microsoft Clarity', 'Аналитика'],
  ['sentry', 'Sentry', 'Мониторинг ошибок'],
  ['cdnjs.cloudflare.com', 'cdnjs', 'CDN/библиотеки'],
  ['jsdelivr.net', 'jsDelivr', 'CDN/библиотеки'],
  ['unpkg.com', 'unpkg', 'CDN/библиотеки'],
  ['code.jquery.com', 'jQuery CDN', 'CDN/библиотеки'],
  ['8ctch.com', '8ctch', 'Аналитика/трекинг'],
  ['odatacore', 'odatacore', 'Аналитика/трекинг'],
];

export function serviceOf(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return { name: urlStr.slice(0, 40), category: 'Прочее', host: '' }; }
  const hp = u.hostname + u.pathname;
  for (const [needle, name, category] of KNOWN) {
    if (hp.includes(needle)) return { name, category, host: u.hostname };
  }
  return { name: rootDomain(u.hostname), category: 'Не опознан', host: u.hostname };
}
