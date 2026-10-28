/**
 * CSV cell encoder shared by the browser export and the tests. Guards against spreadsheet formula
 * injection: a cell starting with = + - @ (or a tab / carriage return) is prefixed with an
 * apostrophe, so a title like "=HYPERLINK(...)" is shown as text, not executed.
 * Written as plain JavaScript-compatible code because its source is embedded in /app.js.
 */
export function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
