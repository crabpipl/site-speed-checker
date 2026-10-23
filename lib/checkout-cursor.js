// Видимый курсор в окне браузера во время теста оформления: человек видит, куда и что нажимает агент.
// Курсор, кольцо нажатия, рамка вокруг кнопки и подпись «Нажатие: «В корзину»» рисуются в отдельном слое
// (shadow DOM на <html>, pointer-events: none) — они не перехватывают нажатия, не попадают в поиск кнопок
// (elementFromPoint пропускает такие элементы) и не меняют вёрстку сайта.
// Включается только при видимом окне браузера; выключить — флаг --no-cursor.

export const CURSOR_INIT = `(() => {
  if (window.__ssaCursor) return;
  let host, root, dot, ring, frame, cap, hideT;
  const css = (el, s) => { el.style.cssText = s; return el; };
  const make = () => {
    if (host || !document.documentElement) return !!host;
    host = document.createElement('ssa-cursor');
    css(host, 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;');
    root = host.attachShadow({ mode: 'closed' });
    const base = 'position:fixed;pointer-events:none;z-index:2147483647;';
    dot = css(document.createElement('div'), base + 'left:-100px;top:-100px;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;' +
      'background:rgba(255,45,85,.35);border:2px solid #ff2d55;box-shadow:0 0 0 2px #fff;transition:left .18s ease-out,top .18s ease-out;');
    ring = css(document.createElement('div'), base + 'width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;border:3px solid #ff2d55;opacity:0;');
    frame = css(document.createElement('div'), base + 'border:3px solid #ff2d55;border-radius:6px;box-shadow:0 0 0 2px #fff;opacity:0;transition:opacity .3s;');
    cap = css(document.createElement('div'), base + 'max-width:70vw;padding:4px 8px;border-radius:6px;background:#1c1c1e;color:#fff;' +
      'font:600 13px/1.3 -apple-system,system-ui,sans-serif;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;opacity:0;transition:opacity .3s;');
    root.append(frame, ring, dot, cap);
    document.documentElement.appendChild(host);
    return true;
  };
  const move = (x, y) => { if (!make()) return; dot.style.left = x + 'px'; dot.style.top = y + 'px'; };
  const pulse = (x, y) => {
    if (!make()) return;
    ring.style.left = x + 'px'; ring.style.top = y + 'px';
    ring.animate([{ transform: 'scale(.6)', opacity: 1 }, { transform: 'scale(2.6)', opacity: 0 }], { duration: 600, easing: 'ease-out' });
  };
  // Рамка вокруг элемента и подпись над ним (под ним, если сверху нет места)
  const show = (el, text) => {
    if (!make() || !el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    Object.assign(frame.style, { left: (r.left - 4) + 'px', top: (r.top - 4) + 'px', width: (r.width + 2) + 'px', height: (r.height + 2) + 'px', opacity: '1' });
    cap.textContent = text;
    cap.style.left = Math.max(4, Math.min(r.left, innerWidth - 220)) + 'px';
    cap.style.top = (r.top > 34 ? r.top - 30 : r.bottom + 8) + 'px';
    cap.style.opacity = text ? '1' : '0';
    move(r.left + r.width / 2, r.top + r.height / 2);
    clearTimeout(hideT);
    hideT = setTimeout(() => { frame.style.opacity = '0'; cap.style.opacity = '0'; }, 1500);
  };
  addEventListener('mousemove', (e) => move(e.clientX, e.clientY), true);
  addEventListener('mousedown', (e) => { move(e.clientX, e.clientY); pulse(e.clientX, e.clientY); }, true);
  // Ввод в поле (телефон, код, адрес): рамка вокруг поля
  addEventListener('focusin', (e) => { const t = e.target; if (t && /^(INPUT|TEXTAREA)$/.test(t.tagName) && !/^(checkbox|radio|hidden)$/.test(t.type)) show(t, 'Ввод'); }, true);
  window.__ssaCursor = { show, pulse };
  if (!make()) document.addEventListener('DOMContentLoaded', make, { once: true });
})()`;

// Перед нажатием: подвести курсор к кнопке, обвести её и подписать, что нажимается (текст кнопки, иначе aria-label / title)
export async function showPress(el) {
  await el.evaluate((x) => {
    const t = ((x.innerText || '').trim().split('\n')[0] || x.getAttribute('aria-label') || x.getAttribute('title') || x.value || '').slice(0, 60);
    window.__ssaCursor?.show(x, t ? `Нажатие: «${t}»` : 'Нажатие');
  }).catch(() => {});
}
