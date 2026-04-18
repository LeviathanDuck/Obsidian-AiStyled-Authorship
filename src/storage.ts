// AI Styled Authorship — storage backends.
//
// Two implementations of the StorageBackend interface:
//
//   SidecarStorage — one JSON file per note, in a vault-relative folder.
//                    Default. Best multi-device conflict isolation.
//
//   DataJsonStorage — all notes in one record stored as the
//                     "authorshipV2" key inside the plugin's data.json.
//                     Single-file convenience; loses data on simultaneous
//                     multi-device edits without a sync conflict file.

import type { DataAdapter, Plugin } from "obsidian";
import { normalizePath } from "obsidian";
import {
  AIRange,
  AnySidecarData,
  DEFAULT_AUTHOR,
  RangeEvent,
  SidecarDataV1,
  SidecarDataV2,
  authorOf,
  ensureUnderCap,
  estimateSerializedBytes,
  foldEvents,
  maybeCompact,
  parseSidecar,
  upgradeV1,
} from "./schema";

// ---- Backend interface ----

export interface LoadResult {
  ranges: AIRange[];
  raw: SidecarDataV2 | null;
}

export interface AppendResult {
  written: boolean;
  bytes: number;
  aggressivelyCompacted: boolean;
  exceededCap: boolean;
}

export interface CacheSize {
  bytes: number;
  fileCount: number;
}

export interface StorageBackend {
  load(notePath: string): Promise<LoadResult>;
  appendEvents(notePath: string, events: RangeEvent[]): Promise<AppendResult>;
  putRecord(notePath: string, record: SidecarDataV2): Promise<AppendResult>;
  rename(fromPath: string, toPath: string): Promise<void>;
  delete(notePath: string): Promise<void>;
  listAll(): Promise<string[]>;
  sidecarFolder(): string | null;
  cacheSize(): Promise<CacheSize>;
  deleteAll(): Promise<{ deleted: number }>;
}

// ---- Sidecar path encoding (mirrors main.ts) ----

const SIDECAR_README_FILENAME = "README.md";

export function encodeSidecarPath(folder: string, notePath: string): string {
  const encoded = notePath.replace(/\//g, "__");
  return normalizePath(`${folder}/${encoded}.json`);
}

export function decodeSidecarFilename(filename: string): string | null {
  if (!filename.endsWith(".json")) return null;
  if (filename === SIDECAR_README_FILENAME) return null;
  const stem = filename.slice(0, -5);
  return stem.replace(/__/g, "/");
}

// ---- Common merge-then-write helper ----

function mergeEventsIntoRecord(
  notePath: string,
  prior: SidecarDataV2 | null,
  newEvents: RangeEvent[],
): SidecarDataV2 {
  const base: SidecarDataV2 = prior ?? {
    version: 2,
    file: notePath,
    snapshot: { ts: Date.now(), ranges: [] },
    events: [],
  };
  // Dedup-on-merge: union events by id.
  const seen = new Set<string>(base.events.map(e => e.id));
  const additions: RangeEvent[] = [];
  for (const evt of newEvents) {
    if (!seen.has(evt.id)) {
      seen.add(evt.id);
      additions.push(evt);
    }
  }
  return {
    version: 2,
    file: notePath,
    snapshot: base.snapshot,
    events: [...base.events, ...additions],
  };
}

// ---- SidecarStorage ----

export class SidecarStorage implements StorageBackend {
  constructor(
    private adapter: DataAdapter,
    private getFolder: () => string,
  ) {}

  sidecarFolder(): string | null {
    return this.getFolder();
  }

  async load(notePath: string): Promise<LoadResult> {
    const folder = this.getFolder();
    const sidecarPath = encodeSidecarPath(folder, notePath);
    try {
      if (!(await this.adapter.exists(sidecarPath))) {
        return { ranges: [], raw: null };
      }
      const raw = await this.adapter.read(sidecarPath);
      const parsed = parseSidecar(raw);
      if (!parsed) return { ranges: [], raw: null };
      const v2 = await this.coerceToV2(parsed, sidecarPath);
      return { ranges: foldEvents(v2.snapshot, v2.events), raw: v2 };
    } catch (err) {
      console.warn(`AiStyled-Authorship: failed to read sidecar ${sidecarPath}`, err);
      return { ranges: [], raw: null };
    }
  }

  async appendEvents(
    notePath: string,
    events: RangeEvent[],
  ): Promise<AppendResult> {
    if (events.length === 0) {
      return { written: false, bytes: 0, aggressivelyCompacted: false, exceededCap: false };
    }
    const folder = this.getFolder();
    const sidecarPath = encodeSidecarPath(folder, notePath);
    const existing = await this.load(notePath);
    const merged = mergeEventsIntoRecord(notePath, existing.raw, events);
    const compacted = maybeCompact(merged);
    return this.writeRecord(folder, sidecarPath, compacted);
  }

  async putRecord(notePath: string, record: SidecarDataV2): Promise<AppendResult> {
    const folder = this.getFolder();
    const sidecarPath = encodeSidecarPath(folder, notePath);
    return this.writeRecord(folder, sidecarPath, record);
  }

  private async writeRecord(
    folder: string,
    sidecarPath: string,
    record: SidecarDataV2,
  ): Promise<AppendResult> {
    const guarded = ensureUnderCap(record);
    if (guarded.bytes > 3_800_000) {
      console.warn("[AiStyled WRITE] over cap even after aggressive compact, refusing write:", sidecarPath);
      return { written: false, bytes: guarded.bytes, aggressivelyCompacted: true, exceededCap: true };
    }
    try {
      if (!(await this.adapter.exists(folder))) {
        await this.adapter.mkdir(folder);
      }
      const json = JSON.stringify(guarded.record, null, 2);
      await this.adapter.write(sidecarPath, json);
      return {
        written: true,
        bytes: json.length,
        aggressivelyCompacted: guarded.aggressivelyCompacted,
        exceededCap: false,
      };
    } catch (err) {
      console.warn("[AiStyled WRITE] failed:", sidecarPath, err);
      return { written: false, bytes: guarded.bytes, aggressivelyCompacted: guarded.aggressivelyCompacted, exceededCap: false };
    }
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    const folder = this.getFolder();
    const fromSidecar = encodeSidecarPath(folder, fromPath);
    const toSidecar = encodeSidecarPath(folder, toPath);
    try {
      if (!(await this.adapter.exists(fromSidecar))) return;
      const raw = await this.adapter.read(fromSidecar);
      if (!(await this.adapter.exists(folder))) {
        await this.adapter.mkdir(folder);
      }
      // Update the embedded `file` field so the on-disk record matches.
      let payload = raw;
      const parsed = parseSidecar(raw);
      if (parsed) {
        const updated: AnySidecarData = { ...parsed, file: toPath };
        payload = JSON.stringify(updated, null, 2);
      }
      await this.adapter.write(toSidecar, payload);
      await this.adapter.remove(fromSidecar);
    } catch (err) {
      console.warn(`AiStyled-Authorship: failed to move sidecar ${fromSidecar} → ${toSidecar}`, err);
    }
  }

  async delete(notePath: string): Promise<void> {
    const folder = this.getFolder();
    const sidecarPath = encodeSidecarPath(folder, notePath);
    try {
      if (await this.adapter.exists(sidecarPath)) {
        await this.adapter.remove(sidecarPath);
      }
    } catch (err) {
      console.warn(`AiStyled-Authorship: failed to delete sidecar ${sidecarPath}`, err);
    }
  }

  async listAll(): Promise<string[]> {
    const folder = this.getFolder();
    try {
      if (!(await this.adapter.exists(folder))) return [];
      const listing = await this.adapter.list(folder);
      const paths: string[] = [];
      for (const f of listing.files) {
        const filename = f.split("/").pop() ?? "";
        const notePath = decodeSidecarFilename(filename);
        if (notePath) paths.push(notePath);
      }
      return paths;
    } catch (err) {
      console.warn(`AiStyled-Authorship: failed to list sidecar folder ${folder}`, err);
      return [];
    }
  }

  async cacheSize(): Promise<CacheSize> {
    const folder = this.getFolder();
    let bytes = 0;
    let fileCount = 0;
    try {
      if (!(await this.adapter.exists(folder))) return { bytes: 0, fileCount: 0 };
      const listing = await this.adapter.list(folder);
      for (const f of listing.files) {
        const filename = f.split("/").pop() ?? "";
        if (filename === SIDECAR_README_FILENAME) continue;
        if (!filename.endsWith(".json")) continue;
        try {
          const stat = await this.adapter.stat(f);
          if (stat) {
            bytes += stat.size;
            fileCount++;
          }
        } catch {
          // skip files we can't stat
        }
      }
    } catch (err) {
      console.warn(`AiStyled-Authorship: failed to size sidecar folder ${folder}`, err);
    }
    return { bytes, fileCount };
  }

  async deleteAll(): Promise<{ deleted: number }> {
    const folder = this.getFolder();
    let deleted = 0;
    try {
      if (!(await this.adapter.exists(folder))) return { deleted: 0 };
      const listing = await this.adapter.list(folder);
      for (const f of listing.files) {
        const filename = f.split("/").pop() ?? "";
        if (filename === SIDECAR_README_FILENAME) continue;
        if (!filename.endsWith(".json")) continue;
        try {
          await this.adapter.remove(f);
          deleted++;
        } catch (err) {
          console.warn(`AiStyled-Authorship: failed to delete ${f}`, err);
        }
      }
    } catch (err) {
      console.warn(`AiStyled-Authorship: deleteAll failed for ${folder}`, err);
    }
    return { deleted };
  }

  private async coerceToV2(
    parsed: AnySidecarData,
    sidecarPath: string,
  ): Promise<SidecarDataV2> {
    if (parsed.version === 2) return parsed;
    let mtime = Date.now();
    try {
      const stat = await this.adapter.stat(sidecarPath);
      if (stat?.mtime) mtime = stat.mtime;
    } catch {
      // fall back to now
    }
    return upgradeV1(parsed as SidecarDataV1, mtime);
  }
}

// ---- DataJsonStorage ----

// Storage key inside data.json. Settings live at the top level of the
// blob (this is how Obsidian's saveData/loadData work). The authorship
// subtree is a sibling key.
export const DATA_JSON_AUTHORSHIP_KEY = "authorshipV2";

export interface DataJsonShape {
  [DATA_JSON_AUTHORSHIP_KEY]?: { [notePath: string]: SidecarDataV2 };
  // Plus any settings keys.
  [key: string]: unknown;
}

export class DataJsonStorage implements StorageBackend {
  constructor(private plugin: Plugin) {}

  sidecarFolder(): string | null {
    return null;
  }

  async load(notePath: string): Promise<LoadResult> {
    const blob = (await this.readBlob());
    const map = blob[DATA_JSON_AUTHORSHIP_KEY] ?? {};
    const record = map[notePath];
    if (!record) return { ranges: [], raw: null };
    return { ranges: foldEvents(record.snapshot, record.events), raw: record };
  }

  async appendEvents(
    notePath: string,
    events: RangeEvent[],
  ): Promise<AppendResult> {
    if (events.length === 0) {
      return { written: false, bytes: 0, aggressivelyCompacted: false, exceededCap: false };
    }
    const blob = await this.readBlob();
    const map = blob[DATA_JSON_AUTHORSHIP_KEY] ?? {};
    const prior = map[notePath] ?? null;
    const merged = mergeEventsIntoRecord(notePath, prior, events);
    const compacted = maybeCompact(merged);
    const guarded = ensureUnderCap(compacted);
    if (guarded.bytes > 3_800_000) {
      console.warn("[AiStyled WRITE] data.json record over cap even after aggressive compact:", notePath);
      return { written: false, bytes: guarded.bytes, aggressivelyCompacted: true, exceededCap: true };
    }
    map[notePath] = guarded.record;
    blob[DATA_JSON_AUTHORSHIP_KEY] = map;
    await this.writeBlob(blob);
    return {
      written: true,
      bytes: guarded.bytes,
      aggressivelyCompacted: guarded.aggressivelyCompacted,
      exceededCap: false,
    };
  }

  async putRecord(notePath: string, record: SidecarDataV2): Promise<AppendResult> {
    const guarded = ensureUnderCap(record);
    if (guarded.bytes > 3_800_000) {
      return { written: false, bytes: guarded.bytes, aggressivelyCompacted: true, exceededCap: true };
    }
    const blob = await this.readBlob();
    const map = blob[DATA_JSON_AUTHORSHIP_KEY] ?? {};
    map[notePath] = guarded.record;
    blob[DATA_JSON_AUTHORSHIP_KEY] = map;
    await this.writeBlob(blob);
    return {
      written: true,
      bytes: guarded.bytes,
      aggressivelyCompacted: guarded.aggressivelyCompacted,
      exceededCap: false,
    };
  }

  async rename(fromPath: string, toPath: string): Promise<void> {
    const blob = await this.readBlob();
    const map = blob[DATA_JSON_AUTHORSHIP_KEY] ?? {};
    const record = map[fromPath];
    if (!record) return;
    delete map[fromPath];
    map[toPath] = { ...record, file: toPath };
    blob[DATA_JSON_AUTHORSHIP_KEY] = map;
    await this.writeBlob(blob);
  }

  async delete(notePath: string): Promise<void> {
    const blob = await this.readBlob();
    const map = blob[DATA_JSON_AUTHORSHIP_KEY] ?? {};
    if (!(notePath in map)) return;
    delete map[notePath];
    blob[DATA_JSON_AUTHORSHIP_KEY] = map;
    await this.writeBlob(blob);
  }

  async listAll(): Promise<string[]> {
    const blob = await this.readBlob();
    const map = blob[DATA_JSON_AUTHORSHIP_KEY] ?? {};
    return Object.keys(map);
  }

  async cacheSize(): Promise<CacheSize> {
    const blob = await this.readBlob();
    const map = blob[DATA_JSON_AUTHORSHIP_KEY] ?? {};
    const json = JSON.stringify(map);
    return { bytes: json.length, fileCount: Object.keys(map).length };
  }

  async deleteAll(): Promise<{ deleted: number }> {
    const blob = await this.readBlob();
    const map = blob[DATA_JSON_AUTHORSHIP_KEY] ?? {};
    const deleted = Object.keys(map).length;
    delete blob[DATA_JSON_AUTHORSHIP_KEY];
    await this.writeBlob(blob);
    return { deleted };
  }

  private async readBlob(): Promise<DataJsonShape> {
    const raw = await this.plugin.loadData();
    if (raw && typeof raw === "object") return raw as DataJsonShape;
    return {};
  }

  private async writeBlob(blob: DataJsonShape): Promise<void> {
    await this.plugin.saveData(blob);
  }
}

// ---- Helpers exposed for migration code ----

// Convenience: derive a v2 record from raw bytes (for migration from
// sidecar → dataJson where we already have the file contents).
export async function loadRecordFromSidecarBytes(
  raw: string,
  notePath: string,
  fallbackMtime: number,
): Promise<SidecarDataV2 | null> {
  const parsed = parseSidecar(raw);
  if (!parsed) return null;
  if (parsed.version === 2) return parsed;
  return upgradeV1(parsed as SidecarDataV1, fallbackMtime);
}

// Also re-export the helpers main.ts will need so it can import from a
// single module.
export { authorOf, foldEvents, maybeCompact, parseSidecar, upgradeV1, estimateSerializedBytes, DEFAULT_AUTHOR };
