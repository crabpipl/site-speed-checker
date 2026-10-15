// SEO-проверки без браузера: исходный HTML (до выполнения JS), ответ поисковым роботам, robots.txt.

export const USER_AGENTS = {
  browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  googlebot: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  yandexbot: 'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
};
const BOT_LABEL = { browser: 'Браузер (Chrome)', googlebot: 'Googlebot (смартфон)', yandexbot: 'YandexBot' };

// Запрос с ручным прохождением редиректов, чтобы увидеть всю цепочку и время ответа
async function fetchChain(url, ua, timeout = 30000) {
  const chain = [];
  let current = url;
  const t0 = performance.now();
  let ttfb = null;
  for (let i = 0; i < 6; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    let res;
    try {
      res = await fetch(current, { redirect: 'manual', headers: { 'user-agent': ua, 'accept-language': 'ru-RU,ru;q=0.9', accept: 'text/html,*/*' }, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(timer);
      return { error: e.name === 'AbortError' ? `нет ответа за ${timeout / 1000} с` : e.cause?.code || e.message, chain, time: Math.round(performance.now() - t0) };
    }
    if (ttfb == null) ttfb = Math.round(performance.now() - t0);
    chain.push({ url: current, status: res.status });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      clearTimeout(timer);
      current = new URL(loc, current).href;
      continue;
    }
    let body = '';
    try { body = await res.text(); } catch {}
    clearTimeout(timer);
    return {
      status: res.status, finalUrl: current, chain, ttfb, time: Math.round(performance.now() - t0), bytes: body.length, body,
      xRobots: res.headers.get('x-robots-tag'), server: res.headers.get('server'),
    };
  }
  return { error: 'слишком много редиректов', chain, time: Math.round(performance.now() - t0) };
}

const decode = (s) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
const attr = (tag, name) => decode(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i').exec(tag)?.[1] ?? '');

// Разбор исходного HTML регулярными выражениями — без выполнения JS, как видит его робот до рендеринга
export function parseHtml(html) {
  const head = html.slice(0, 300000);
  const metaTags = head.match(/<meta\b[^>]*>/gi) || [];
  const meta = (n) => {
    const t = metaTags.find((m) => attr(m, 'name').toLowerCase() === n);
    return t ? attr(t, 'content') : null;
  };
  const linkTags = head.match(/<link\b[^>]*>/gi) || [];
  const canonical = linkTags.find((l) => attr(l, 'rel').toLowerCase().split(/\s+/).includes('canonical'));
  const jsonld = [];
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (o) => { if (!o || typeof o !== 'object') return; if (o['@type']) jsonld.push([].concat(o['@type']).join(',')); if (Array.isArray(o)) o.forEach(walk); else if (o['@graph']) walk(o['@graph']); };
      walk(JSON.parse(m[1]));
    } catch {}
  }
  const bodyHtml = /<body[\s\S]*$/i.exec(html)?.[0] ?? html;
  const text = decode(bodyHtml
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template[\s\S]*?<\/template>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  // Встроенные <script> без src: часто это JSON состояния приложения, который раздувает HTML
  const inline = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1].length);
  return {
    title: decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]?.trim() ?? ''),
    htmlBytes: html.length,
    inlineScriptBytes: inline.reduce((a, b) => a + b, 0),
    largestInlineScript: inline.length ? Math.max(...inline) : 0,
    description: meta('description'),
    robots: meta('robots'),
    canonical: canonical ? attr(canonical, 'href') : null,
    h1: [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].map((m) => decode(m[1].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim().slice(0, 120)),
    textLen: text.length,
    links: (bodyHtml.match(/<a\b[^>]*\bhref=/gi) || []).length,
    jsonld: [...new Set(jsonld)],
    viewport: meta('viewport'),
  };
}

// robots.txt: группы User-agent → правила Allow/Disallow, выбор самого длинного совпадения
const robotsCache = new Map();
async function loadRobots(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  const p = (async () => {
    try {
      const res = await fetch(`${origin}/robots.txt`, { headers: { 'user-agent': USER_AGENTS.browser } });
      if (!res.ok) return { status: res.status, groups: [] };
      const groups = [];
      let cur = null;
      let lastWasAgent = false;
      for (const raw of (await res.text()).split(/\r?\n/)) {
        const line = raw.replace(/#.*$/, '').trim();
        const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
        if (!m) continue;
        const key = m[1].toLowerCase();
        const val = m[2].trim();
        if (key === 'user-agent') {
          if (!lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
          cur.agents.push(val.toLowerCase());
          lastWasAgent = true;
        } else {
          lastWasAgent = false;
          if (cur && (key === 'allow' || key === 'disallow')) cur.rules.push({ allow: key === 'allow', path: val });
        }
      }
      return { status: res.status, groups };
    } catch (e) {
      return { status: 0, error: e.message, groups: [] };
    }
  })();
  robotsCache.set(origin, p);
  return p;
}

function robotsAllowed(robots, agentToken, pathAndQuery) {
  const token = agentToken.toLowerCase();
  const group = robots.groups.find((g) => g.agents.some((a) => a !== '*' && token.startsWith(a)))
    || robots.groups.find((g) => g.agents.includes('*'));
  if (!group) return { allowed: true, rule: null };
  let best = null;
  for (const r of group.rules) {
    if (!r.path) continue; // пустой Disallow = разрешено всё
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(pathAndQuery) && (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow))) best = r;
  }
  return { allowed: !best || best.allow, rule: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` : null };
}

const BLOCK_RE = /captcha|ddos-guard|qrator|cf-challenge|cloudflare.*attention|доступ ограничен|access denied|are you a robot|проверка браузера|checking your browser/i;

export async function checkSeo(url, rendered) {
  const u = new URL(url);
  const [browser, googlebot, yandexbot, robots] = await Promise.all([
    fetchChain(url, USER_AGENTS.browser), fetchChain(url, USER_AGENTS.googlebot), fetchChain(url, USER_AGENTS.yandexbot), loadRobots(u.origin),
  ]);
  const raw = browser.body ? parseHtml(browser.body) : null;

  const agents = Object.entries({ browser, googlebot, yandexbot }).map(([k, r]) => {
    const blocked = !r.error && (r.status >= 400 || (BLOCK_RE.test(r.body?.slice(0, 20000) || '') && r.bytes < (browser.bytes || 0) * 0.5));
    const parsed = r.body ? parseHtml(r.body) : null;
    return {
      key: k, label: BOT_LABEL[k], status: r.status ?? null,
      title: parsed?.title ?? null, h1: parsed?.h1 ?? [], textLen: parsed?.textLen ?? 0, links: parsed?.links ?? 0, error: r.error ?? null, ttfb: r.ttfb ?? null, time: r.time,
      bytes: r.bytes ?? 0, redirects: Math.max(0, r.chain.length - 1), chain: r.chain, xRobots: r.xRobots ?? null, blocked,
    };
  });

  const pq = u.pathname + u.search;
  const robotsTxt = {
    status: robots.status,
    google: robots.groups.length ? robotsAllowed(robots, 'googlebot', pq) : { allowed: true, rule: null },
    yandex: robots.groups.length ? robotsAllowed(robots, 'yandex', pq) : { allowed: true, rule: null },
  };
  for (const r of [browser, googlebot, yandexbot]) delete r.body;
  return { raw, rendered, agents, robotsTxt };
}
