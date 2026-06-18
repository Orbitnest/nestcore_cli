const enabled = !!process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (enabled ? `\x1b[${code}m${s}\x1b[0m` : s);

export const color = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  cyan: wrap('36'),
  gray: wrap('90'),
};

export const log = (msg = '') => console.log(msg);
export const heading = (msg: string) => console.log('\n' + color.bold(msg));
export const success = (msg: string) => console.log(`${color.green('✓')} ${msg}`);
export const warn = (msg: string) => console.log(`${color.yellow('!')} ${msg}`);
export const info = (msg: string) => console.log(`${color.cyan('›')} ${msg}`);

/**
 * Signals a clean process exit. Thrown by `fail()` (after the message has
 * already been printed) so the top-level handler can schedule a graceful
 * shutdown instead of a hard `process.exit()`, which races with closing
 * libuv handles on Windows.
 */
export class ExitSignal extends Error {
  constructor(public readonly code = 1) {
    super('exit');
  }
}

export function fail(msg: string): never {
  console.error(`${color.red('✗')} ${msg}`);
  throw new ExitSignal(1);
}

/** Render an array of objects as a compact aligned table. */
export function table(rows: Array<Record<string, string>>, columns: string[]): void {
  if (rows.length === 0) {
    log(color.dim('  (none)'));
    return;
  }
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => (r[c] ?? '').length)));
  const line = (cells: string[]) => '  ' + cells.map((c, i) => c.padEnd(widths[i])).join('   ');
  log(color.dim(line(columns)));
  for (const r of rows) log(line(columns.map((c) => r[c] ?? '')));
}
