// Прогресс в терминале: общий прогресс-бар по страницам и строка текущего шага с таймером.
// Обычные сообщения выводятся над панелью. Если вывод идёт не в терминал (в файл), панель не рисуется.

const WRAP_OFF = '\x1b[?7l';
const WRAP_ON = '\x1b[?7h';
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
// Относительная длительность шагов: прогон без внешних сервисов и SEO-запросы заметно быстрее обычного прогона
export const WEIGHT = { run: 1, blockAll: 0.35, blockOne: 1, coverage: 1, seo: 0.15, warm: 0.9, inp: 1.3, crux: 0.05 };

const fmt = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s >= 3600) return `${Math.floor(s / 3600)} ч ${Math.round((s % 3600) / 60)} мин`;
  if (s >= 600) return `${Math.round(s / 60)} мин`;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const pick = (cols, variants) => variants.find((v) => v.length <= cols - 1) ?? variants.at(-1);
const bar = (ratio, width) => {
  const full = Math.round(Math.min(1, Math.max(0, ratio)) * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
};

export class Progress {
  // plan(): веса всех шагов одной страницы; stage: «Этап 1/2 · Десктоп»
  constructor({ total, plan, stage, unitGuessMs, nextStage, done = 0 }) {
    this.total = total;
    this.plan = plan;
    this.stage = stage;
    this.nextStage = nextStage; // { label, factor }: следующий этап (мобильный) займёт ≈ factor × этот
    this.tty = process.stdout.isTTY;
    this.unitGuess = unitGuessMs; // оценка длительности обычного прогона до первых замеров
    this.doneUnits = 0; // выполнено «единиц работы» по всем страницам
    this.doneMs = 0; // и сколько на них ушло времени
    this.pagesDone = done; // при продолжении прерванной проверки часть страниц уже готова
    this.pauseRequested = false;
    this.paused = false;
    this.pausedMs = 0;
    this.page = null;
    this.frame = 0;
    this.lines = 0;
    this.t0 = Date.now();
    if (this.tty) {
      this.timer = setInterval(() => this.draw(), 1000);
      this.timer.unref();
      // При выходе (в том числе по Ctrl+C) убрать панель и вернуть терминалу перенос строк
      process.on('exit', () => { this.clear(); process.stdout.write(WRAP_ON); });
    }
  }

  get unitMs() {
    return this.doneUnits >= 0.5 ? this.doneMs / this.doneUnits : this.unitGuess;
  }

  startPage(index, url) {
    this.page = { index, url: url.replace(/^https?:\/\/[^/]+/, '') || '/', steps: this.plan(), done: 0, stepIdx: -1, label: 'подготовка' };
    this.draw();
  }

  // Число шагов страницы уточняется по ходу (например, сколько сервисов будет заблокировано)
  setSteps(steps) {
    if (!this.page) return;
    this.page.steps = [...this.page.steps.slice(0, this.page.stepIdx + 1), ...steps];
    this.draw();
  }

  // Пауза: P нажали — текущий шаг доделывается, перед следующим ждём повторного нажатия P
  togglePause() {
    if (this.paused) {
      this.pauseRequested = false;
      this.resumeFn?.();
    } else {
      this.pauseRequested = !this.pauseRequested;
    }
    this.draw();
  }

  async gate() {
    if (!this.pauseRequested) return;
    this.paused = true;
    const t = Date.now();
    this.draw();
    await new Promise((res) => (this.resumeFn = res));
    this.resumeFn = null;
    this.paused = false;
    this.pausedMs += Date.now() - t;
    this.log('▶ Продолжаю проверку');
  }

  async step(label) {
    await this.gate();
    const p = this.page;
    if (!p) return;
    p.stepIdx++;
    p.label = label;
    p.stepStart = Date.now();
    this.draw();
  }

  stepDone() {
    const p = this.page;
    if (!p || p.stepStart == null) return;
    const w = p.steps[p.stepIdx] ?? 1;
    this.doneUnits += w;
    this.doneMs += Date.now() - p.stepStart;
    p.done += w;
    p.stepStart = null;
    this.draw();
  }

  endPage() {
    this.pagesDone++;
    this.page = null;
    this.draw();
  }

  // Оставшиеся единицы работы: текущая страница + страницы в очереди
  remaining() {
    const per = this.plan().reduce((a, b) => a + b, 0);
    const p = this.page;
    let cur = 0;
    let pageTotal = per;
    if (p) {
      pageTotal = p.steps.reduce((a, b) => a + b, 0);
      cur = pageTotal - p.done;
      if (p.stepStart != null) {
        const w = p.steps[p.stepIdx] ?? 1;
        cur -= Math.min(w * 0.95, (Date.now() - p.stepStart) / this.unitMs);
      }
    }
    const queued = this.total - this.pagesDone - (p ? 1 : 0);
    return { cur: Math.max(0, cur), pageTotal, queued, all: Math.max(0, cur) + queued * per, per };
  }

  log(msg) {
    if (!this.tty) return console.log(msg);
    this.clear();
    console.log(msg);
    this.draw();
  }

  clear() {
    if (!this.tty || !this.lines) return;
    process.stdout.write(`\x1b[${this.lines}A\r\x1b[J`);
    this.lines = 0;
  }

  draw() {
    if (!this.tty) return;
    const r = this.remaining();
    const totalUnits = this.total * r.per;
    const overall = totalUnits ? 1 - r.all / totalUnits : 1;
    const cols = process.stdout.columns || 100;
    const queued = Math.max(0, r.queued);
    const left = r.all * this.unitMs;
    const pctTxt = `${String(Math.round(overall * 100)).padStart(3)}%`;
    const nextMs = this.nextStage ? (Date.now() - this.t0 - this.pausedMs + left) * this.nextStage.factor : 0;
    // Несколько вариантов строки от подробного к краткому — выбирается самый подробный, что помещается в окно
    const line1 = pick(cols, [
      `${bar(overall, 20)} ${pctTxt}  ${this.stage} · проверено ${this.pagesDone} из ${this.total} стр., в очереди ${queued} · осталось ≈ ${fmt(left)}${nextMs ? ` (+ ${this.nextStage.label} ≈ ${fmt(nextMs)})` : ''}`,
      `${bar(overall, 12)} ${pctTxt}  ${this.stage} · стр. ${this.pagesDone}/${this.total}, в очереди ${queued} · осталось ≈ ${fmt(left)}${nextMs ? ` (+ ≈ ${fmt(nextMs)})` : ''}`,
      `${bar(overall, 10)} ${pctTxt} · ${this.stage.split(' · ').at(-1)} · стр. ${this.pagesDone}/${this.total}, очередь ${queued} · ≈ ${fmt(left)}${nextMs ? ` (+ ${fmt(nextMs)})` : ''}`,
      `${pctTxt} · стр. ${this.pagesDone}/${this.total} · очередь ${queued} · ≈ ${fmt(left)}${nextMs ? ` + ${fmt(nextMs)}` : ''}`,
    ]);
    let line2 = `  Прошло ${fmt(Date.now() - this.t0)}`;
    const p = this.page;
    if (this.paused) {
      line2 = pick(cols, [
        '⏸  ПАУЗА — нажмите P, чтобы продолжить · Ctrl+C — остановить (готовые страницы сохранены)',
        '⏸  ПАУЗА — P: продолжить · Ctrl+C: остановить',
        '⏸  ПАУЗА — P: продолжить',
      ]);
    } else if (p) {
      this.frame = (this.frame + 1) % SPIN.length;
      const pagePct = r.pageTotal ? Math.round((1 - r.cur / r.pageTotal) * 100) : 0;
      const stepTime = p.stepStart != null ? ` · ${fmt(Date.now() - p.stepStart)}` : '';
      const curLeft = fmt(r.cur * this.unitMs);
      const hint = this.pauseRequested ? ' · ⏸ пауза после этого шага' : ' · P — пауза';
      line2 = pick(cols, [
        `${SPIN[this.frame]} Стр. ${p.index + 1}: ${p.url} · ${p.label}${stepTime} · готово ${pagePct}%, ещё ≈ ${curLeft}${hint}`,
        `${SPIN[this.frame]} Стр. ${p.index + 1}: ${p.url} · ${p.label}${stepTime} · готово ${pagePct}%, ещё ≈ ${curLeft}${this.pauseRequested ? hint : ''}`,
        `${SPIN[this.frame]} Стр. ${p.index + 1} · ${p.label}${stepTime} · ${pagePct}%, ещё ≈ ${curLeft}`,
        `${SPIN[this.frame]} Стр. ${p.index + 1} · ${pagePct}% · ещё ≈ ${curLeft}${this.pauseRequested ? ' · ⏸' : ''}`,
      ]);
    }
    const cut = (x) => (x.length > cols - 1 ? x.slice(0, cols - 2) + '…' : x);
    this.clear();
    // Панель рисуется с отключённым переносом строк: если строка шире окна (окно сузили или терминал
    // считает часть символов двойной ширины), она обрежется, а не перейдёт на новую строку.
    // Иначе при перерисовке осталась бы лишняя строка — «застрявший» кусок старой панели.
    process.stdout.write(`${WRAP_OFF}${cut(line1)}\n${cut(line2)}\n${WRAP_ON}`);
    this.lines = 2;
  }

  finish() {
    if (this.timer) clearInterval(this.timer);
    this.clear();
  }
}
