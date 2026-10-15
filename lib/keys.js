// Клавиши во время проверки: P (или «З» в русской раскладке) — пауза/продолжить, Ctrl+C — остановить.
// Терминал переводится в «сырой» режим, поэтому Ctrl+C приходит как символ, а не как сигнал — обрабатываем сами.
export function listenKeys({ onPause, onStop }) {
  const stdin = process.stdin;
  if (!stdin.isTTY) return () => {};
  stdin.setRawMode(true);
  stdin.setEncoding('utf8');
  stdin.resume();
  const onData = (key) => {
    if (key === '\u0003') onStop();
    else if (/^[pPзЗ]$/.test(key)) onPause();
  };
  stdin.on('data', onData);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stdin.off('data', onData);
    try { stdin.setRawMode(false); } catch {}
    stdin.pause();
  };
  process.on('exit', restore);
  return restore;
}
