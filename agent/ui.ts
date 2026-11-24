// Minimal terminal styling (no dependencies).
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
export const dim = wrap('2');
export const bold = wrap('1');
export const cyan = wrap('36');
export const green = wrap('32');
export const red = wrap('31');
export const yellow = wrap('33');
export const magenta = wrap('35');

export const write = (s: string) => process.stdout.write(s);
export const line = (s = '') => process.stdout.write(`${s}\n`);
export function status(s: string) {
  if (tty) process.stdout.write(`\r\x1b[2K${s}`);
}
export function clearStatus() {
  if (tty) process.stdout.write('\r\x1b[2K');
}
