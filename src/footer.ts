/**
 * Footer surface: the optional replacement for Pi's native footer.
 *
 * This module owns the whole `setFooter` boundary. Nothing else in `src/` may call that
 * host API, and `scripts/check.mjs` enforces it. The footer factory is a single
 * replacement slot, so ownership - not registration - is the lifecycle rule:
 *
 * - the controller installs a component and remembers that it owns the slot;
 * - when the host disposes the component because another extension or the host itself
 *   replaced it, the component reports that loss and the controller must not clear the
 *   later footer on `off`/`dispose`, and must not steal the slot back on a refresh;
 * - when the controller releases its own slot it restores the native footer explicitly.
 *
 * Rendering is pure and bounded: rows come from the same field layout as the widget, and
 * extension statuses are compared with a fixed-capacity snapshot inside `render()` - the
 * host calls `requestRender()` after `setStatus()`, and its status `Map` is mutated in
 * place, so nothing smaller than a value comparison can detect a change.
 */
import { clip, safeText, visibleWidth } from "./text.ts";
import { LABELS, activityField, agentsField, assembleRow, bridgeFields, compactionField, contextField, costField, field, hudSegment, quotaField, speedField, tasksField, thinkingField, tokensField, toolCategoriesField } from "./render.ts";
import type { HudField, HudRow, HudSegment, HudWords, WidgetTui } from "./render.ts";
import { createStyler } from "./palette.ts";
import type { HudStyler, HudThemeLike } from "./palette.ts";
import type { HudConfig, HudPreset } from "./config.ts";
import type { HudSnapshot } from "./state.ts";

/** Fixed body row counts per preset; tool activity never changes them. */
export const FOOTER_BODY_ROWS: Readonly<Record<HudPreset, number>> = Object.freeze({ minimal: 2, balanced: 3, full: 4 });
/** Hard cap on the separate, bounded extension-status area. */
export const MAX_STATUS_ROWS = 2;
/** Maximum statuses read and shown per render; further entries fold into `+N`. */
export const MAX_STATUS_COUNT = 8;
/** Sanitized status key/text limits; longer values are truncated, never retained whole. */
export const MAX_STATUS_KEY = 32;
export const MAX_STATUS_TEXT = 64;
/** Hard cap for the whole footer: four body rows plus two status rows. */
export const MAX_FOOTER_ROWS = 6;

/** Read-only host footer data surface (Pi 0.85.1–1.0.2 `ReadonlyFooterDataProvider`). */
export interface FooterDataLike {
  getGitBranch(): string | null;
  onBranchChange(callback: () => void): () => void;
  getExtensionStatuses(): ReadonlyMap<string, string>;
}

/** Cached identity data. Never re-read from the host during render. */
export interface HudIdentity {
  cwd: string;
  provider: string;
  title: string;
  branch: string | null;
  branchDirty: boolean;
}

export const EMPTY_IDENTITY: HudIdentity = Object.freeze({ cwd: "", provider: "", title: "", branch: null, branchDirty: false });

/** Structural `Component` surface required by Pi's footer slot. */
export interface HudFooterComponent {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

/** Structural host UI surface; `setFooter` is optional so an older/limited host falls back. */
export interface InstallFooterHost {
  setFooter?(factory?: (tui: WidgetTui, theme: HudThemeLike, footerData: FooterDataLike) => HudFooterComponent): void;
}

/* surface-boundary:start */
/**
 * Install the HUD footer into the host's single replacement slot.
 * Returns false when the host cannot provide the interface, so the caller can fall back.
 */
export function installFooter(ui: InstallFooterHost | null | undefined, factory: (tui: WidgetTui, theme: HudThemeLike, footerData: FooterDataLike) => HudFooterComponent): boolean {
  if (!ui || typeof ui.setFooter !== "function") return false;
  ui.setFooter(factory);
  return true;
}

/**
 * Restore the host's native footer. Only call this while the HUD still owns the slot:
 * after another extension replaced the component, clearing the slot would delete that
 * extension's footer.
 */
export function releaseFooter(ui: InstallFooterHost | null | undefined): boolean {
  if (!ui || typeof ui.setFooter !== "function") return false;
  ui.setFooter(undefined);
  return true;
}
/* surface-boundary:end */

const clampWidth = (rawWidth: number): number =>
  Math.max(0, Math.min(4_096, Math.floor(Number.isFinite(rawWidth) ? rawWidth : 0)));

const toRow = (segments: HudSegment[]): HudRow => ({ text: segments.map((segment) => segment.text).join(""), segments });

// ---------------------------------------------------------------------------
// Footer body layout
// ---------------------------------------------------------------------------

function modelField(snapshot: HudSnapshot, config: HudConfig, width: number): HudField | null {
  const budget = Math.max(4, Math.min(40, Math.floor(width / 2)));
  return field(100, [hudSegment("model", `[${clip(snapshot.model, budget, config.ascii)}]`)]);
}

function providerField(identity: HudIdentity, config: HudConfig): HudField | null {
  if (!identity.provider) return null;
  return field(60, [hudSegment("label", clip(identity.provider, 24, config.ascii))]);
}

function cwdField(identity: HudIdentity, config: HudConfig, width: number): HudField | null {
  if (!identity.cwd) return null;
  const budget = Math.max(8, Math.min(56, Math.floor(width * 0.6)));
  return field(85, [hudSegment("path", clip(identity.cwd, budget, config.ascii))]);
}

function branchField(identity: HudIdentity, config: HudConfig): HudField | null {
  if (!identity.branch) return null;
  return field(30, [hudSegment("git", `git:${clip(identity.branch, 32, config.ascii)}${identity.branchDirty ? "*" : ""}`)]);
}

/** Session title: useful but long, so it is the first identity field to fold. */
function titleField(identity: HudIdentity, config: HudConfig, width: number): HudField | null {
  if (!identity.title) return null;
  const budget = Math.max(8, Math.min(48, Math.floor(width / 3)));
  return field(22, [hudSegment("body", clip(identity.title, budget, config.ascii))]);
}

function identityRowFields(snapshot: HudSnapshot, config: HudConfig, width: number, identity: HudIdentity): (HudField | null)[] {
  return [
    modelField(snapshot, config, width),
    thinkingField(snapshot, config, 45),
    providerField(identity, config),
    cwdField(identity, config, width),
    branchField(identity, config),
    titleField(identity, config, width),
    quotaField(snapshot.quota, config, LABELS[config.language]),
  ];
}

/**
 * Context and observed usage. `ctx(last)` stays the cached last observation, never the
 * host's live estimate. `minimal` merges the activity summary here so its second row still
 * carries current activity and error alerts when the width allows it.
 */
function usageRowFields(snapshot: HudSnapshot, config: HudConfig, width: number, words: HudWords, minimal: boolean): (HudField | null)[] {
  const narrow = width < 45;
  return [
    contextField(snapshot, config, width, words.context, narrow ? 110 : 95),
    tokensField(snapshot, config, words),
    costField(snapshot, config, words),
    speedField(snapshot, config, words),
    ...(minimal ? activityRowFields(snapshot, config, width, words) : []),
  ];
}

/** Activity, alerts and bounded tool categories; balanced and full give this its own row. */
function activityRowFields(snapshot: HudSnapshot, config: HudConfig, width: number, words: HudWords): (HudField | null)[] {
  return [
    activityField(snapshot, config, words),
    snapshot.interrupted ? field(93, [hudSegment("warning", `${words.stopped} ${snapshot.interrupted}`)]) : null,
    toolCategoriesField(snapshot, config, words),
    snapshot.dropped ? field(45, [hudSegment("warning", "limited*")]) : null,
  ];
}

/** Bridge agents/tasks and compaction history; full only. */
function summaryRowFields(snapshot: HudSnapshot, config: HudConfig, width: number, words: HudWords): (HudField | null)[] {
  const agents = agentsField(snapshot, words);
  const tasks = tasksField(snapshot, words);
  return [
    ...bridgeFields(snapshot, config, width, words, agents, tasks),
    compactionField(snapshot, words),
  ];
}

/**
 * Fixed body rows: minimal 2, balanced 3, full 4. Pure and bounded; identity values are
 * already sanitized and cached by the controller.
 */
export function formatFooter(snapshot: HudSnapshot, config: HudConfig, rawWidth: number, identity: HudIdentity = EMPTY_IDENTITY): HudRow[] {
  const width = clampWidth(rawWidth);
  const words = LABELS[config.language];
  const minimal = config.preset === "minimal";
  const rows: HudRow[] = [
    assembleRow(identityRowFields(snapshot, config, width, identity), width, config),
    assembleRow(usageRowFields(snapshot, config, width, words, minimal), width, config),
  ];
  if (!minimal) rows.push(assembleRow(activityRowFields(snapshot, config, width, words), width, config));
  if (config.preset === "full") rows.push(assembleRow(summaryRowFields(snapshot, config, width, words), width, config));
  return rows;
}

// ---------------------------------------------------------------------------
// Bounded extension-status area
// ---------------------------------------------------------------------------

/**
 * The status area is separate from the body rows and bounded in every dimension:
 * at most `MAX_STATUS_COUNT` entries are read, keys and texts are sanitized and
 * truncated, the result never exceeds `MAX_STATUS_ROWS`, and folding is explicit (`+N`).
 * Control characters and ANSI sequences are stripped by `safeText`; nothing is parsed.
 */
export function formatStatusRows(statuses: ReadonlyMap<string, string> | null | undefined, config: HudConfig, rawWidth: number): HudRow[] {
  const width = clampWidth(rawWidth);
  if (width <= 0 || !statuses || typeof statuses.size !== "number" || statuses.size <= 0) return [];
  const separator = config.ascii ? " | " : " · ";
  const separatorWidth = visibleWidth(separator);
  const entries: { key: string; text: string }[] = [];
  let read = 0;
  for (const entry of statuses) {
    if (read >= MAX_STATUS_COUNT) break;
    read++;
    const value = Array.isArray(entry) ? entry[1] : undefined;
    if (typeof value !== "string") continue;
    const text = safeText(value, MAX_STATUS_TEXT);
    if (!text) continue;
    const key = Array.isArray(entry) ? entry[0] : "";
    entries.push({ key: safeText(key, MAX_STATUS_KEY) || "?", text });
  }
  if (!entries.length) return [];
  // Deterministic display order for the bounded sample (the host map itself is insertion-ordered).
  entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const rows: HudRow[] = [];
  let segments: HudSegment[] = [];
  let used = 0;
  let index = 0;
  for (; index < entries.length; index++) {
    const text = entries[index].text;
    const gap = segments.length ? separatorWidth : 0;
    const itemWidth = visibleWidth(text);
    if (used + gap + itemWidth <= width) {
      if (gap) segments.push(hudSegment("separator", separator));
      segments.push(hudSegment("body", text));
      used += gap + itemWidth;
      continue;
    }
    if (segments.length) {
      if (rows.length + 1 >= MAX_STATUS_ROWS) break;
      rows.push(toRow(segments));
      segments = [];
      used = 0;
      index--;
      continue;
    }
    // One status wider than the whole row: clip it and fold whatever follows it.
    segments.push(hudSegment("body", clip(text, width, config.ascii)));
    index++;
    break;
  }
  if (segments.length) rows.push(toRow(segments));
  if (!rows.length) return rows;
  // Everything the host holds but this bounded area did not display gets one explicit marker.
  const hidden = Math.max(0, statuses.size - Math.min(index, entries.length));
  if (hidden > 0) {
    const marker = `+${hidden}`;
    const markerWidth = visibleWidth(marker);
    const last = rows[rows.length - 1];
    const gap = separatorWidth;
    if (visibleWidth(last.text) + gap + markerWidth <= width) {
      rows[rows.length - 1] = toRow([...last.segments, hudSegment("separator", separator), hudSegment("label", marker)]);
    } else if (rows.length < MAX_STATUS_ROWS) {
      rows.push(toRow([hudSegment("label", marker)]));
    } else {
      const budget = width - gap - markerWidth;
      if (budget > 0) {
        const kept: HudSegment[] = [];
        let keptWidth = 0;
        for (const segment of last.segments) {
          const size = visibleWidth(segment.text);
          if (keptWidth + size > budget) {
            const clipped = clip(segment.text, budget - keptWidth, config.ascii);
            if (clipped) kept.push(hudSegment(segment.role, clipped));
            break;
          }
          kept.push(segment);
          keptWidth += size;
        }
        kept.push(hudSegment("separator", separator), hudSegment("label", marker));
        rows[rows.length - 1] = toRow(kept);
      }
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Footer component
// ---------------------------------------------------------------------------

const sameValues = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return false;
  return true;
};

/**
 * The installed footer component. Rendering reuses the widget's cached-view contract
 * (unchanged width/state/theme returns the same array) and adds the bounded status check
 * that the host's in-place `setStatus` path requires.
 */
export class HudFooterView implements HudFooterComponent {
  declare tui: WidgetTui;
  declare theme: HudThemeLike | (() => HudThemeLike | undefined) | null | undefined;
  declare footerData: FooterDataLike | null;
  declare snapshot: HudSnapshot | null;
  declare config: HudConfig;
  declare identity: HudIdentity;
  declare onError: () => void;
  declare onDispose: ((component: HudFooterView) => void) | null;
  declare width: number;
  declare dirty: boolean;
  declare lines: string[];
  declare styler: HudStyler | null;
  declare stylerTheme: unknown;
  declare stylerKey: string;
  declare disposed: boolean;
  declare paintRequests: number;
  declare computations: number;
  declare statusChecks: number;
  declare statusChanges: number;
  declare statusKeys: string[];
  declare statusTexts: string[];
  declare statusSize: number;

  constructor(
    tui: WidgetTui,
    theme: HudThemeLike | (() => HudThemeLike | undefined) | null | undefined,
    footerData: FooterDataLike | null,
    snapshot: HudSnapshot,
    config: HudConfig,
    identity: HudIdentity,
    onError: () => void = () => {},
    onDispose: ((component: HudFooterView) => void) | null = null,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.footerData = footerData;
    this.snapshot = snapshot;
    this.config = config;
    this.identity = identity;
    this.onError = onError;
    this.onDispose = onDispose;
    this.width = -1;
    this.dirty = true;
    this.lines = [];
    this.styler = null;
    this.stylerTheme = undefined;
    this.stylerKey = "";
    this.disposed = false;
    this.paintRequests = 0;
    this.computations = 0;
    this.statusChecks = 0;
    this.statusChanges = 0;
    this.statusKeys = [];
    this.statusTexts = [];
    this.statusSize = 0;
  }

  /**
   * Bounded status comparison. Called from `render()`, which the host invokes after
   * `setStatus()` -> `requestRender()`; there is no host revision or change notification.
   * At most `MAX_STATUS_COUNT` entries are read per check, each comparison is a plain
   * string compare against the cached sample, and the number of statuses is compared too,
   * so an addition, change or deletion beyond the sample still invalidates the frame.
   */
  statusChanged(): boolean {
    this.statusChecks++;
    const statuses = this.footerData?.getExtensionStatuses?.();
    if (!statuses || typeof statuses.size !== "number" || statuses.size === 0) {
      if (!this.statusSize && !this.statusKeys.length && !this.statusTexts.length) return false;
      this.statusSize = 0;
      this.statusKeys = [];
      this.statusTexts = [];
      this.statusChanges++;
      return true;
    }
    const keys: string[] = [];
    const texts: string[] = [];
    let read = 0;
    for (const entry of statuses) {
      if (read >= MAX_STATUS_COUNT) break;
      read++;
      const value = Array.isArray(entry) ? entry[1] : undefined;
      if (typeof value !== "string") continue;
      keys.push(typeof entry[0] === "string" ? entry[0] : "");
      texts.push(value);
    }
    if (statuses.size === this.statusSize && sameValues(keys, this.statusKeys) && sameValues(texts, this.statusTexts)) return false;
    this.statusSize = statuses.size;
    this.statusKeys = keys;
    this.statusTexts = texts;
    this.statusChanges++;
    return true;
  }

  /** Rebuild only when the palette inputs change; a theme switch clears it via invalidate(). */
  stylerFor(theme: HudThemeLike | null | undefined): HudStyler {
    const key = `${this.config.palette}|${this.config.color}`;
    if (!this.styler || this.stylerTheme !== theme || this.stylerKey !== key) {
      this.styler = createStyler(theme, this.config);
      this.stylerTheme = theme;
      this.stylerKey = key;
    }
    return this.styler;
  }

  render(width: number): string[] {
    if (this.disposed) return [];
    width = clampWidth(width);
    let statusDirty = false;
    try { statusDirty = this.statusChanged(); } catch { statusDirty = false; }
    if (!this.dirty && !statusDirty && width === this.width) return this.lines;
    this.width = width;
    this.dirty = false;
    this.computations++;
    const body = this.compute(width);
    // The status area is supplementary: a broken provider degrades to "no status rows"
    // instead of blanking the body, and the failure is counted for /hud status.
    let statusRows: HudRow[] = [];
    try { statusRows = formatStatusRows(this.footerData?.getExtensionStatuses?.(), this.config, width); }
    catch { statusRows = []; try { this.onError(); } catch { /* No throw. */ } }
    const rows = body.concat(statusRows);
    if (rows.length > MAX_FOOTER_ROWS) rows.length = MAX_FOOTER_ROWS;
    this.lines = this.style(rows);
    return this.lines;
  }

  /** Body rows only; separated so a status-area failure cannot blank the frame. */
  compute(width: number): HudRow[] {
    try {
      return formatFooter(this.snapshot!, this.config, width, this.identity);
    } catch {
      try { this.onError(); } catch { /* Never propagate observer failures. */ }
      return [];
    }
  }

  /** Apply the resolved palette to already-laid-out rows. Never changes visible width. */
  style(rows: HudRow[]): string[] {
    try {
      const theme = typeof this.theme === "function" ? this.theme() : this.theme;
      const styler = this.stylerFor(theme);
      return rows.map((row) => {
        let line = "";
        for (const segment of row.segments) line += styler.style(segment.role, segment.text);
        return line;
      });
    } catch {
      try { this.onError(); } catch { /* No throw. */ }
      return [clip("pi-hud unavailable", this.width, true)];
    }
  }

  publish(snapshot: HudSnapshot, config: HudConfig, identity: HudIdentity) {
    if (this.disposed) return;
    const previous = this.lines;
    this.snapshot = snapshot;
    this.config = config;
    this.identity = identity;
    this.dirty = true;
    const next = this.render(this.width < 0 ? 80 : this.width);
    if (previous.length === next.length && previous.every((line, index) => line === next[index])) return;
    this.paintRequests++;
    try { this.tui.requestRender(); } catch { try { this.onError(); } catch { /* No throw. */ } }
  }

  invalidate() { this.dirty = true; this.styler = null; }

  /**
   * Called by the host when this component is replaced or the extension UI is reset, and by
   * the controller during its own release. The controller decides which case it is by
   * checking whether it still holds this component, so repeated disposal never restores the
   * native footer twice or clears a footer that was installed later.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.lines = [];
    this.snapshot = null;
    this.styler = null;
    this.statusKeys = [];
    this.statusTexts = [];
    this.statusSize = 0;
    const callback = this.onDispose;
    this.onDispose = null;
    try { callback?.(this); } catch { try { this.onError(); } catch { /* No throw. */ } }
  }
}
