// =============================================================================
// Eyes-CLI — neon-red style helpers
//
// All colors are inline ANSI 24-bit escapes so we hit the exact hexes the
// design calls for, regardless of TTY support. picocolors handles the
// standard red/green/yellow/cyan/gray/white we use for status indicators
// and falls back to no-color automatically when not a TTY (we still gate
// on its isColorSupported for the picocolors helpers).
// =============================================================================

import pc from "picocolors";

// -- 24-bit hex helpers -----------------------------------------------------
// ANSI 24-bit foreground: \x1b[38;2;R;G;Bm
// ANSI 24-bit background: \x1b[48;2;R;G;Bm
// Reset: \x1b[0m

/** Neon red foreground (#ff3b5c) — the brand accent. */
export const neon = (s: string): string => `\x1b[38;2;255;59;92m${s}\x1b[0m`;

/** Dim red foreground (#7a1f2e) — for borders, hints, secondary text. */
export const dimRed = (s: string): string => `\x1b[38;2;122;31;46m${s}\x1b[0m`;

/** Neon red background with white text — for a single highlighted pill. */
export const neonBg = (s: string): string =>
  `\x1b[48;2;255;59;92m\x1b[38;2;255;255;255m${s}\x1b[0m`;

/** Gray out a string (faint) — picocolors handles TTY degradation. */
export const dim = (s: string): string => pc.dim(s);

// -- Status indicators -------------------------------------------------------

/** Unicode status symbol: green ✓ or red ✗. */
export function status(ok: boolean): string {
  return ok ? pc.green("✓") : pc.red("✗");
}

/** Green check, red x, yellow warn, cyan play, dim pause. */
export const okMark = (): string => pc.green("✓");
export const failMark = (): string => pc.red("✗");
export const warnMark = (): string => pc.yellow("⚠");
export const playMark = (): string => pc.cyan("⏵");
export const pauseMark = (): string => pc.dim("⏸");

// -- Headers ----------------------------------------------------------------

/** Two-line header: `▸ TITLE` in neon + dim-red separator underneath. */
export function header(title: string): string {
  const line = "─".repeat(Math.min(60, Math.max(8, title.length + 4)));
  return `${neon("▸")} ${neon(title)}\n${dimRed(line)}`;
}

// -- Inline formatting -------------------------------------------------------

/** `key: value` with dim red key + white value. */
export function kv(key: string, value: string): string {
  return `${dimRed(key + ":")} ${value}`;
}

/** Bullet prefix: `▸ ` in dim red. */
export function bullet(s: string): string {
  return `${dimRed("▸")} ${s}`;
}

/** REPL prompt: `▸ ` in neon. */
export function prompt(s = ""): string {
  return s.length > 0 ? `${neon("▸")} ${s}` : neon("▸");
}

// -- Log-prefixed messages --------------------------------------------------

export function info(msg: string): string {
  return `${neon("•")} ${msg}`;
}
export function success(msg: string): string {
  return `${pc.green("✓")} ${msg}`;
}
export function warn(msg: string): string {
  return `${pc.yellow("⚠")} ${msg}`;
}
export function error(msg: string): string {
  return `${pc.red("✗")} ${msg}`;
}

// -- Box drawing ------------------------------------------------------------

export interface BoxOptions {
  title?: string;
  width?: number;
}

/**
 * Wrap `lines` in a rounded box. Width defaults to the current terminal
 * width minus 4 (so the box leaves breathing room). Lines are left-aligned.
 * Borders are dim red; the title (if provided) is neon on the top border.
 */
export function box(lines: ReadonlyArray<string>, opts: BoxOptions = {}): string {
  const cols = opts.width ?? Math.max(40, (process.stdout.columns ?? 80) - 4);
  const innerWidth = Math.max(10, cols - 2);
  const top = opts.title
    ? `${dimRed("╭─ ")}${neon(opts.title)}${dimRed(" " + "─".repeat(Math.max(0, innerWidth - opts.title.length - 3)) + "╮")}`
    : `${dimRed("╭" + "─".repeat(innerWidth) + "╮")}`;
  const bot = dimRed("╰" + "─".repeat(innerWidth) + "╯");
  const body = lines.map((l) => {
    const truncated = truncate(l, innerWidth);
    return `${dimRed("│")} ${padRight(truncated, innerWidth - 1)}${dimRed("│")}`;
  });
  return [top, ...body, bot].join("\n");
}

// -- helpers (private) -------------------------------------------------------

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, Math.max(0, n - 1)) + "…";
}

function padRight(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + " ".repeat(n - s.length);
}
