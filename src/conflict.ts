// AI Styled Authorship — sync conflict detection and merge.
//
// Detects sync-tool conflict copies of sidecar files and merges them
// into the canonical sidecar by union of events + dedup by id. Safety:
// never deletes a file we cannot parse and verify as belonging to a
// known canonical note path.

import type { DataAdapter } from "obsidian";
import {
  AnySidecarData,
  RangeEvent,
  SidecarDataV1,
  SidecarDataV2,
  SnapshotRange,
  authorOf,
  maybeCompact,
  parseSidecar,
  upgradeV1,
} from "./schema";
import { decodeSidecarFilename, encodeSidecarPath } from "./storage";

const README_FILENAME = "README.md";

// ---- Conflict-name patterns ----

// Each entry: a regex that matches conflict copies of `<stem>.json`
// where ${escStem} is the regex-escaped basename without extension.
//
// Pattern strings use `${escStem}` as a placeholder substituted at
// build time.

interface ConflictPatternSource {
  label: string;
  pattern: string; // regex source, with `${escStem}` placeholder
}

const PATTERN_SOURCES: ConflictPatternSource[] = [
  // Syncthing: "<stem>.sync-conflict-YYYYMMDD-HHMMSS-DEVICEID.json"
  { label: "Syncthing", pattern: "^${escStem}\\.sync-conflict-.+\\.json$" },
  // iCloud: "<stem> 2.json", "<stem> 3.json", etc. Numeric suffix.
  { label: "iCloud", pattern: "^${escStem} \\d+\\.json$" },
  // Dropbox: "<stem> (Device's conflicted copy 2026-04-17).json"
  { label: "Dropbox", pattern: "^${escStem} \\(.+ conflicted copy.*\\)\\.json$" },
  // OneDrive: "<stem>-DEVICENAME.json" (uppercase device name).
  { label: "OneDrive", pattern: "^${escStem}-[A-Z][A-Z0-9-]+\\.json$" },
  // Obsidian Sync: "<stem>.conflict.json".
  { label: "Obsidian Sync", pattern: "^${escStem}\\.conflict\\.json$" },
];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Returns true iff `candidate` looks like a conflict copy of `canonical`.
// `canonical` and `candidate` are both bare filenames (no folder).
export function isConflictOf(canonical: string, candidate: string): boolean {
  if (!canonical.endsWith(".json")) return false;
  if (candidate === canonical) return false;
  const stem = canonical.slice(0, -5);
  const escStem = escapeRegex(stem);
  for (const src of PATTERN_SOURCES) {
    const re = new RegExp(src.pattern.replace("${escStem}", escStem));
    if (re.test(candidate)) return true;
  }
  return false;
}

// Inverse: given a candidate filename, try to find its canonical
// counterpart. Returns the canonical filename (e.g. "Notes__foo.json")
// or null if the candidate doesn't look like a conflict copy.
export function canonicalOf(candidate: string): string | null {
  if (!candidate.endsWith(".json")) return null;
  // Try each pattern. The shape that matches tells us how to strip
  // back to the canonical stem.

  // Syncthing
  const sct = candidate.match(/^(.+)\.sync-conflict-.+\.json$/);
  if (sct) return `${sct[1]}.json`;

  // Obsidian Sync
  const obs = candidate.match(/^(.+)\.conflict\.json$/);
  if (obs) return `${obs[1]}.json`;

  // Dropbox: "<stem> (... conflicted copy ...).json"
  const dbx = candidate.match(/^(.+) \(.+ conflicted copy.*\)\.json$/);
  if (dbx) return `${dbx[1]}.json`;

  // OneDrive: "<stem>-DEVICENAME.json" — lazy match so the SHORTEST
  // valid stem wins (otherwise "stem-MACBOOK-PRO.json" would yield
  // stem="stem-MACBOOK", device="PRO"). False positives still possible
  // for legitimate notes containing uppercase suffixes; the safety
  // check in resolveConflict catches those by comparing file fields.
  const od = candidate.match(/^(.+?)-([A-Z][A-Z0-9-]+)\.json$/);
  if (od) return `${od[1]}.json`;

  // iCloud: "<stem> N.json" where N is integer. False positives possible
  // for legit names; safety check happens later.
  const ic = candidate.match(/^(.+) \d+\.json$/);
  if (ic) return `${ic[1]}.json`;

  return null;
}

// ---- Scanner ----

export interface ScanResult {
  scanned: number;
  merged: number;
  skipped: number;
}

export class ConflictScanner {
  constructor(
    private adapter: DataAdapter,
    private getFolder: () => string | null,
    private onMerged: (notePath: string) => void,
  ) {}

  // Single-file check, called from the create/modify hooks.
  // Returns true if the file was a recognized conflict and was merged.
  async scanPath(filePath: string): Promise<boolean> {
    const folder = this.getFolder();
    if (!folder) return false;
    if (!filePath.startsWith(folder + "/")) return false;
    const filename = filePath.slice(folder.length + 1);
    if (filename === README_FILENAME) return false;

    const canonicalName = canonicalOf(filename);
    if (!canonicalName) return false;
    const canonicalPath = `${folder}/${canonicalName}`;

    return this.resolveConflict(canonicalPath, filePath);
  }

  // Sweep the entire sidecar folder. Called on plugin load, on app
  // focus, and on the explicit Rescan Conflicts button.
  async scanAll(): Promise<ScanResult> {
    const folder = this.getFolder();
    if (!folder) return { scanned: 0, merged: 0, skipped: 0 };

    let scanned = 0;
    let merged = 0;
    let skipped = 0;

    try {
      if (!(await this.adapter.exists(folder))) {
        return { scanned: 0, merged: 0, skipped: 0 };
      }
      const listing = await this.adapter.list(folder);

      // Build a set of canonical filenames present in the folder so we
      // can verify candidates point to a real canonical sibling.
      const allFilenames = new Set<string>();
      for (const f of listing.files) {
        const filename = f.split("/").pop() ?? "";
        allFilenames.add(filename);
      }

      for (const f of listing.files) {
        const filename = f.split("/").pop() ?? "";
        if (filename === README_FILENAME) continue;
        scanned++;
        const canonicalName = canonicalOf(filename);
        if (!canonicalName) continue;
        if (!allFilenames.has(canonicalName)) {
          // Conflict copy without a canonical sibling. Promote the
          // conflict copy to canonical name (rename) — assumes the
          // canonical was deleted on this device but the conflict
          // arrived from another device.
          if (await this.promoteOrphan(folder, filename, canonicalName)) {
            merged++;
          } else {
            skipped++;
          }
          continue;
        }
        const canonicalPath = `${folder}/${canonicalName}`;
        const ok = await this.resolveConflict(canonicalPath, f);
        if (ok) merged++; else skipped++;
      }
    } catch (err) {
      console.warn("AiStyled-Authorship: conflict scan failed", err);
    }

    return { scanned, merged, skipped };
  }

  // Reads two sidecar files (canonical + conflict copy), verifies both
  // are valid v1/v2 records describing the same canonical note, merges
  // them into a single v2 record, writes it to the canonical path, and
  // deletes the conflict copy. Returns true on success, false if any
  // verification or I/O failed (in which case the conflict copy is
  // left in place).
  private async resolveConflict(
    canonicalPath: string,
    conflictPath: string,
  ): Promise<boolean> {
    try {
      if (!(await this.adapter.exists(canonicalPath))) return false;
      if (!(await this.adapter.exists(conflictPath))) return false;

      const canonicalRaw = await this.adapter.read(canonicalPath);
      const conflictRaw = await this.adapter.read(conflictPath);

      const canonical = parseSidecar(canonicalRaw);
      const conflict = parseSidecar(conflictRaw);
      if (!canonical || !conflict) {
        console.warn("AiStyled-Authorship: conflict scan unable to parse one of:", canonicalPath, conflictPath);
        return false;
      }

      // Safety: the conflict copy must reference the same `file` field
      // as the canonical. If they disagree, do NOT delete — could be a
      // false-positive filename match.
      if (canonical.file !== conflict.file) {
        console.warn(
          "AiStyled-Authorship: conflict scan refusing to merge — file fields disagree:",
          canonical.file,
          "≠",
          conflict.file,
        );
        return false;
      }

      const a = await this.coerceToV2(canonical, canonicalPath);
      const b = await this.coerceToV2(conflict, conflictPath);
      const merged = mergeV2(a, b);

      const json = JSON.stringify(merged, null, 2);
      await this.adapter.write(canonicalPath, json);
      await this.adapter.remove(conflictPath);

      const notePath = canonical.file;
      this.onMerged(notePath);
      console.log(
        `AiStyled-Authorship: merged conflict ${conflictPath} into ${canonicalPath}`,
      );
      return true;
    } catch (err) {
      console.warn(
        `AiStyled-Authorship: failed to resolve conflict ${conflictPath} → ${canonicalPath}`,
        err,
      );
      return false;
    }
  }

  // When a conflict copy exists with no canonical sibling (e.g. the
  // canonical file was deleted on this device but the conflict came
  // from another device), promote the conflict copy to the canonical
  // name so the data isn't lost.
  private async promoteOrphan(
    folder: string,
    conflictFilename: string,
    canonicalFilename: string,
  ): Promise<boolean> {
    const conflictPath = `${folder}/${conflictFilename}`;
    const canonicalPath = `${folder}/${canonicalFilename}`;
    try {
      const raw = await this.adapter.read(conflictPath);
      const parsed = parseSidecar(raw);
      if (!parsed) return false;
      // Verify the embedded `file` field decodes back to a sensible
      // path. If we can decode the canonical filename to a note path
      // and it matches `parsed.file`, we're confident this conflict
      // copy belongs at the canonical location.
      const decoded = decodeSidecarFilename(canonicalFilename);
      if (!decoded || decoded !== parsed.file) {
        console.warn(
          "AiStyled-Authorship: orphan promotion refused — file field doesn't match canonical name:",
          parsed.file,
          "vs",
          decoded,
        );
        return false;
      }
      await this.adapter.write(canonicalPath, raw);
      await this.adapter.remove(conflictPath);
      this.onMerged(parsed.file);
      console.log(
        `AiStyled-Authorship: promoted orphan ${conflictPath} → ${canonicalPath}`,
      );
      return true;
    } catch (err) {
      console.warn(
        `AiStyled-Authorship: orphan promotion failed for ${conflictPath}`,
        err,
      );
      return false;
    }
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

// ---- Pure merge function (exported for testing) ----

// Merge two v2 records describing the same note. Strategy:
// 1. Combined snapshot = older timestamp's ranges, plus union with
//    newer timestamp's ranges (snapshot deltas may be missing events
//    from before the older snapshot, so we union to be safe).
// 2. Combined events = union of both event lists, deduped by id.
// 3. Run maybeCompact on the result.
export function mergeV2(a: SidecarDataV2, b: SidecarDataV2): SidecarDataV2 {
  const combinedRanges: SnapshotRange[] = [
    ...a.snapshot.ranges,
    ...b.snapshot.ranges,
  ];
  const combinedSnapshot = {
    ts: Math.min(a.snapshot.ts, b.snapshot.ts),
    ranges: combinedRanges,
  };

  const seen = new Set<string>();
  const combinedEvents: RangeEvent[] = [];
  for (const evt of [...a.events, ...b.events]) {
    if (seen.has(evt.id)) continue;
    seen.add(evt.id);
    combinedEvents.push(evt);
  }
  combinedEvents.sort((x, y) => {
    if (x.ts !== y.ts) return x.ts - y.ts;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });

  const result: SidecarDataV2 = {
    version: 2,
    file: a.file,
    snapshot: combinedSnapshot,
    events: combinedEvents,
  };
  return maybeCompact(result);
}
