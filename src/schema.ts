// AI Styled Authorship — schema, range helpers, event-fold algorithm.
//
// Pure TypeScript. No Obsidian imports. Safe to unit-test in isolation.

// ---- Author identity ----

// v0.2 only emits "ai". v0.3+ may add "human-1", "human-2", "ai-2", etc.
export const DEFAULT_AUTHOR = "ai";

export function authorOf(r: { author?: string }): string {
  return r.author ?? DEFAULT_AUTHOR;
}

// ---- In-memory range type ----

export interface AIRange {
  from: number;
  to: number;
  // Optional in v0.2 (treated as "ai" when undefined). v0.3+ will populate.
  author?: string;
}

// ---- On-disk schemas ----

export interface SidecarDataV1 {
  version: 1;
  file: string;
  ranges: { from: number; to: number; author: "ai" }[];
}

export interface SnapshotRange {
  from: number;
  to: number;
  author: string;
}

export interface Snapshot {
  ts: number;
  ranges: SnapshotRange[];
}

export interface RangeEvent {
  // "${ts}-${dev}-${seq}" — globally unique per device. Used for dedup
  // when merging logs from a sync conflict.
  id: string;
  op: "add" | "remove";
  author: string;
  from: number;
  to: number;
  ts: number;
  dev: string;
}

export interface SidecarDataV2 {
  version: 2;
  file: string;
  snapshot: Snapshot;
  events: RangeEvent[];
}

export type AnySidecarData = SidecarDataV1 | SidecarDataV2;

// ---- Compaction / size constants ----

export const COMPACT_EVENT_THRESHOLD = 200;
export const COMPACT_AGE_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const COMPACT_SAFETY_WINDOW_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// Obsidian Sync caps individual file size at 5 MB. We sit safely below
// it so headers, escaping, and minor growth never push us over.
export const DATA_JSON_SIZE_CAP_BYTES = 3_800_000;
export const DATA_JSON_WARN_THRESHOLD = 3_200_000;

// ---- Author-aware range helpers ----
//
// All helpers preserve the `author` field. Same-author ranges merge
// when adjacent or overlapping. Cross-author ranges never merge — they
// can coexist on the same character offsets.

export function normalizeRanges(ranges: AIRange[]): AIRange[] {
  const byAuthor = new Map<string, AIRange[]>();
  for (const r of ranges) {
    if (!r || r.to <= r.from) continue;
    const a = authorOf(r);
    let list = byAuthor.get(a);
    if (!list) {
      list = [];
      byAuthor.set(a, list);
    }
    list.push({ from: r.from, to: r.to, author: a });
  }
  const result: AIRange[] = [];
  for (const list of byAuthor.values()) {
    list.sort((a, b) => a.from - b.from || a.to - b.to);
    let cur: AIRange | null = null;
    for (const r of list) {
      if (cur && r.from <= cur.to) {
        if (r.to > cur.to) cur.to = r.to;
      } else {
        if (cur) result.push(cur);
        cur = { ...r };
      }
    }
    if (cur) result.push(cur);
  }
  result.sort((a, b) => a.from - b.from || a.to - b.to || authorOf(a).localeCompare(authorOf(b)));
  return result;
}

export function mergeRange(ranges: AIRange[], incoming: AIRange): AIRange[] {
  return normalizeRanges([...ranges, incoming]);
}

// Removes [excFrom, excTo) from `ranges`. When `targetAuthor` is given,
// only ranges with that author are affected (others pass through). When
// undefined, ALL authors at that interval are subtracted — used for
// the "typing inside an AI range produces normal characters" behavior.
export function subtractInterval(
  ranges: AIRange[],
  excFrom: number,
  excTo: number,
  targetAuthor?: string,
): AIRange[] {
  if (excTo <= excFrom) return ranges;
  const result: AIRange[] = [];
  for (const seg of ranges) {
    const segAuthor = authorOf(seg);
    if (targetAuthor !== undefined && segAuthor !== targetAuthor) {
      result.push(seg);
      continue;
    }
    if (seg.to <= excFrom || seg.from >= excTo) {
      result.push(seg);
    } else {
      if (seg.from < excFrom) {
        result.push({ from: seg.from, to: excFrom, author: segAuthor });
      }
      if (seg.to > excTo) {
        result.push({ from: excTo, to: seg.to, author: segAuthor });
      }
    }
  }
  return result;
}

export function sameRanges(a: AIRange[], b: AIRange[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].from !== b[i].from || a[i].to !== b[i].to) return false;
    if (authorOf(a[i]) !== authorOf(b[i])) return false;
  }
  return true;
}

// ---- Event-fold algorithm ----

// Folds the event log onto the snapshot, returning the resulting range
// set. Events are sorted by (ts ASC, id ASC) for deterministic LWW
// ordering. Duplicate event IDs (e.g. from a merged conflict log) are
// applied once.
export function foldEvents(
  snapshot: Snapshot,
  events: RangeEvent[],
): AIRange[] {
  let ranges: AIRange[] = normalizeRanges(
    snapshot.ranges.map(r => ({ from: r.from, to: r.to, author: r.author })),
  );

  const sorted = [...events].sort((a, b) => {
    if (a.ts !== b.ts) return a.ts - b.ts;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const seen = new Set<string>();
  for (const evt of sorted) {
    if (seen.has(evt.id)) continue;
    seen.add(evt.id);
    if (evt.op === "add") {
      ranges = mergeRange(ranges, {
        from: evt.from,
        to: evt.to,
        author: evt.author,
      });
    } else {
      ranges = subtractInterval(ranges, evt.from, evt.to, evt.author);
    }
  }

  return normalizeRanges(ranges);
}

// ---- Compaction ----

// Standard compaction: fold events older than the safety window into
// the snapshot, keep recent events for cross-device merge resolution.
export function maybeCompact(record: SidecarDataV2): SidecarDataV2 {
  const now = Date.now();
  const oldest = record.events.length > 0 ? record.events[0].ts : now;
  const shouldCompact =
    record.events.length > COMPACT_EVENT_THRESHOLD ||
    now - oldest > COMPACT_AGE_THRESHOLD_MS;
  if (!shouldCompact) return record;
  return compactWithCutoff(record, now - COMPACT_SAFETY_WINDOW_MS, now);
}

// Aggressive compaction: fold ALL events into the snapshot, ignoring
// the safety window. Used when a write would exceed the size cap.
export function aggressiveCompact(record: SidecarDataV2): SidecarDataV2 {
  const now = Date.now();
  return compactWithCutoff(record, now, now);
}

function compactWithCutoff(
  record: SidecarDataV2,
  cutoffTs: number,
  now: number,
): SidecarDataV2 {
  const toFold: RangeEvent[] = [];
  const toKeep: RangeEvent[] = [];
  for (const evt of record.events) {
    if (evt.ts <= cutoffTs) toFold.push(evt);
    else toKeep.push(evt);
  }
  if (toFold.length === 0) return record;
  const folded = foldEvents(record.snapshot, toFold);
  return {
    version: 2,
    file: record.file,
    snapshot: {
      ts: now,
      ranges: folded.map(r => ({
        from: r.from,
        to: r.to,
        author: authorOf(r),
      })),
    },
    events: toKeep,
  };
}

// ---- v1 → v2 upgrade ----

export function upgradeV1(v1: SidecarDataV1, fileMtimeMs: number): SidecarDataV2 {
  const ranges: SnapshotRange[] = [];
  for (const r of v1.ranges) {
    if (r && typeof r.from === "number" && typeof r.to === "number" && r.to > r.from) {
      ranges.push({ from: r.from, to: r.to, author: DEFAULT_AUTHOR });
    }
  }
  return {
    version: 2,
    file: v1.file,
    snapshot: { ts: fileMtimeMs, ranges },
    events: [],
  };
}

// ---- Parsing helpers ----

// Returns null on parse failure or unrecognized shape. Caller decides
// what to do (typically: log warning and skip).
export function parseSidecar(raw: string): AnySidecarData | null {
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== "object") return null;
    if (data.version === 2 && typeof data.file === "string"
        && data.snapshot && Array.isArray(data.snapshot.ranges)
        && Array.isArray(data.events)) {
      return data as SidecarDataV2;
    }
    if ((data.version === 1 || data.version === undefined)
        && typeof data.file === "string" && Array.isArray(data.ranges)) {
      return { ...data, version: 1 } as SidecarDataV1;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- Event ID generation ----
//
// Per-session monotonic counter so two events emitted in the same ms by
// the same device get distinct IDs.

let seqCounter = 0;

export function nextEventId(deviceId: string, ts: number): string {
  seqCounter = (seqCounter + 1) >>> 0;
  return `${ts}-${deviceId}-${seqCounter}`;
}

// ---- Diff: two range sets → events ----
//
// Given the previously-persisted range set and the current range set,
// emit add/remove events that describe the transition. Used by the
// debounced write path to convert "the editor's current state" into
// LWW-mergeable events.
//
// Operates per-author so multi-author state diffs cleanly: a Human 1
// add doesn't masquerade as an AI remove.

export function diffRangeSets(
  previous: AIRange[],
  current: AIRange[],
  meta: { ts: number; deviceId: string },
): RangeEvent[] {
  const events: RangeEvent[] = [];
  const authors = new Set<string>();
  for (const r of previous) authors.add(authorOf(r));
  for (const r of current) authors.add(authorOf(r));

  for (const author of authors) {
    const prevA = previous.filter(r => authorOf(r) === author);
    const currA = current.filter(r => authorOf(r) === author);

    // added = current minus previous (per author)
    let addedSegments: AIRange[] = currA.map(r => ({ ...r }));
    for (const p of prevA) {
      addedSegments = subtractInterval(addedSegments, p.from, p.to, author);
    }
    for (const seg of addedSegments) {
      events.push({
        id: nextEventId(meta.deviceId, meta.ts),
        op: "add",
        author,
        from: seg.from,
        to: seg.to,
        ts: meta.ts,
        dev: meta.deviceId,
      });
    }

    // removed = previous minus current (per author)
    let removedSegments: AIRange[] = prevA.map(r => ({ ...r }));
    for (const c of currA) {
      removedSegments = subtractInterval(removedSegments, c.from, c.to, author);
    }
    for (const seg of removedSegments) {
      events.push({
        id: nextEventId(meta.deviceId, meta.ts),
        op: "remove",
        author,
        from: seg.from,
        to: seg.to,
        ts: meta.ts,
        dev: meta.deviceId,
      });
    }
  }

  return events;
}

// ---- Device ID generation ----

export function generateDeviceId(hostnameHint?: string): string {
  const slug = (hostnameHint || "device")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16) || "device";
  const rand = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, "0");
  return `${slug}-${rand}`;
}

// ---- Size estimation ----

export function estimateSerializedBytes(record: SidecarDataV2): number {
  // JSON.stringify is fast enough for our scale (< 5 MB by design).
  return JSON.stringify(record).length;
}

// Returns an aggressively-compacted record if the input would exceed
// the cap, otherwise returns the input. Caller should check size again
// after calling — if still over cap, refuse the write.
export function ensureUnderCap(
  record: SidecarDataV2,
  capBytes: number = DATA_JSON_SIZE_CAP_BYTES,
): { record: SidecarDataV2; aggressivelyCompacted: boolean; bytes: number } {
  const initialBytes = estimateSerializedBytes(record);
  if (initialBytes <= capBytes) {
    return { record, aggressivelyCompacted: false, bytes: initialBytes };
  }
  const compacted = aggressiveCompact(record);
  return {
    record: compacted,
    aggressivelyCompacted: true,
    bytes: estimateSerializedBytes(compacted),
  };
}
