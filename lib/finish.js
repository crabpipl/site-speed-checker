// Итоговое сообщение в конце проверки: явно показывает, завершилась ли проверка полностью и без ошибок.
const color = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);

const duration = (ms) => {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)} ч ${m % 60} мин` : m >= 1 ? `${m} мин` : `${Math.round(ms / 1000)} с`;
};

// failed: [{ page, error, profile }] — страницы, которые не удалось замерить
// budget — сводка budgetDigest(): что вышло за пороги budgets.txt
// prod — итог prodDigest(): тестовый контур против прода
export function printFinal({ startedAt, pagesTotal, failed, reports, budget, prod }) {
  const line = '─'.repeat(Math.min(process.stdout.columns || 70, 70));
  console.log(`\n${line}`);
  if (!failed.length) {
    console.log(color('1;32', '✅ Проверка полностью завершена!'));
  } else {
    console.log(color('1;33', `⚠  Проверка завершена, но с ошибками: ${failed.length} из ${pagesTotal} замеров страниц не удались`));
    for (const f of failed) console.log(color('33', `   • ${f.profile ? `${f.profile}: ` : ''}${f.page} — ${f.error}`));
    console.log('   Остальные страницы проверены, отчёт по ним создан. Не удавшиеся страницы можно проверить ещё раз отдельно.');
  }
  if (prod) {
    if (prod.slower) {
      console.log(color('1;31', `🧪 Тест медленнее прода: ${prod.slower} из ${prod.total} замеров страниц`));
      for (const l of prod.lines.slice(0, 10)) console.log(color('31', `   • ${l}`));
    } else if (prod.failed === prod.total) {
      console.log(color('1;33', `🧪 Тест против прода: не удалось сравнить ни одной страницы — тестовая или прод-страница не открылась (см. раздел «Тест против прода» в отчёте).`));
    } else console.log(color(prod.failed ? '33' : '32', `🧪 Тест против прода: медленнее прода нет (быстрее: ${prod.faster}, на уровне: ${prod.total - prod.faster - prod.failed}${prod.failed ? `, не удалось сравнить: ${prod.failed}` : ''}).`));
  }
  if (budget) {
    if (!budget.bad) console.log(color('32', `   Бюджет: все замеры страниц в бюджете${budget.fixed ? ` (вернулось в норму показателей: ${budget.fixed})` : ''}.`));
    else {
      console.log(color('1;31', `🔔 Вне бюджета: ${budget.bad} из ${budget.total} замеров страниц${budget.fresh ? `, новых нарушений: ${budget.fresh}` : ''}${budget.fixed ? `; вернулось в норму: ${budget.fixed}` : ''}`));
      for (const l of budget.lines.slice(0, 10)) console.log(color('31', `   • ${l}`));
      if (budget.lines.length > 10) console.log(`   … и ещё ${budget.lines.length - 10} — см. блок «Бюджет» в начале отчёта`);
    }
  }
  console.log(`   Время проверки: ${duration(Date.now() - startedAt)}`);
  const label = (r) => (r.endsWith('summary.html') ? 'Краткая сводка для руководства' : r.endsWith('tasks.html') ? 'Задачи для трекера' : 'Отчёт');
  for (const r of reports) console.log(`   ${label(r)}: ${r}`);
  console.log(line);
}
