// Plans for destructive or order-changing operations: remove, reorder, and details (name, description).
// Follows curatune commit b3531aa, src/curatune/plans.py. Differences, all deliberate:
// - Plans live in memory (a PlanRegistry in the app), not in files; backups go to an async KeyValueStore
//   (IndexedDB in the app), and those older than BACKUP_RETENTION_DAYS are deleted when the app starts, as
//   curatune's retention.py (commit 60aff60) does with its files; here the period is fixed.
// - Besides curatune's explicit order, move, and order by recording date (from the recordings store), a
//   deterministic sort by title, artist, album, edition date, or duration (sortedOrder).
// - Checksums use SHA-256 from Web Crypto over the same canonical JSON (sorted keys, no spaces), over the
//   same fields as curatune commit 2877459 (what the plan card shows, too).
//
// Building a plan never touches Spotify beyond reading the playlist. A plan records the playlist's
// snapshot_id, the items before, the items after, and the exact low-level operations that turn one into
// the other. applyPlan refuses to run unless the live playlist still has the same snapshot_id and item
// URIs, then executes the operations, verifies the result, and records the outcome in the plan.
// Only the UI applies plans; tools and the agent never import applyPlan (tests/invariants.test.ts).

import { CuratuneError } from "../spotify/errors";
import type { SpotifyClient } from "../spotify/http";
import type { PlaylistItem } from "../spotify/models";
import { getPlaylist, getPlaylistMeta, listPlaylists, type PlaylistState, type Warning } from "../spotify/playlists";
import { requireEditable } from "../spotify/writes";
import { chronologicalOrder, type RecordingMap } from "../recordings/recordings";
import type { KeyValueStore } from "../storage/kv";
import { DETAIL_FIELDS, insertUris, moveRange, removeUris, setDetails, type DetailField } from "./ops";

export const PLAN_SCHEMA_VERSION = 1;
export const PLAN_KINDS = ["remove", "reorder", "details"] as const;
export const MAX_RANGE_LENGTH = 100;
export const MAX_URIS_PER_REQUEST = 100;
const DETAILS_VERIFY_ATTEMPTS = 3;
const DETAILS_VERIFY_DELAY_MS = 2000;

// --- Types ---------------------------------------------------------------------------------------

export interface CompactItem {
  position: number;
  uri: string | null;
  name: string | null;
  artists: string[];
  album: string | null;
  duration: string | null;
}

export type AfterItem = CompactItem & { from_position: number };

export type Operation =
  | { op: "delete_uris"; uris: string[] }
  | { op: "insert"; uris: string[]; position: number }
  | { op: "move"; range_start: number; insert_before: number; range_length: number }
  | { op: "set_details"; fields: Partial<Record<DetailField, string>> };

export interface PlanPlaylist {
  id: string;
  uri: string | null;
  name: string | null;
  snapshot_id: string | null;
  item_count?: number;
}

export interface Applied {
  applied_at: string;
  verified: boolean;
  snapshot_id?: string;
  backup_key: string;
}

interface PlanBase {
  schema_version: number;
  plan_id: string;
  created_at: string;
  reason: string | null;
  playlist: PlanPlaylist;
  operations: Operation[];
  warnings: Warning[];
  checksum: string;
  applied?: Applied;
}

export interface MoveChange {
  op: "move";
  range_start: number;
  insert_before: number;
  range_length: number;
  items: { from_position: number; name: string | null; artists: string[] }[];
}

export interface ItemPlan extends PlanBase {
  kind: "remove" | "reorder";
  before: CompactItem[];
  after: AfterItem[];
  changes: { remove?: CompactItem[]; new_order?: number[]; moves?: MoveChange[] };
}

export interface DetailsPlan extends PlanBase {
  kind: "details";
  before: Partial<Record<DetailField, string>>;
  after: Partial<Record<DetailField, string>>;
  changes: Partial<Record<DetailField, { from: string; to: string }>>;
}

export type Plan = ItemPlan | DetailsPlan;

export interface ApplyResult {
  applied: true;
  plan_id: string;
  playlist_id: string;
  operations_done: number;
  verified: boolean;
  snapshot_id?: string;
  current?: Partial<Record<DetailField, string>>;
  backup_key: string;
  warnings: Warning[];
}

const planError = (message: string, details: Record<string, unknown> = {}, code: "PLAN_INVALID" | "PLAN_INCONSISTENT" | "PLAN_CHECKSUM_MISMATCH" | "PLAN_ALREADY_APPLIED" | "NO_CHANGES" = "PLAN_INVALID") =>
  new CuratuneError(code, message, details);

/**
 * Backups hold copies of Spotify metadata (track names, artists), which Spotify's Developer Terms (IV.3)
 * don't allow storing indefinitely.
 */
export const BACKUP_RETENTION_DAYS = 90;

/** Delete backups made more than BACKUP_RETENTION_DAYS ago; returns how many. */
export async function pruneBackups(backups: KeyValueStore, now: number = Date.now()): Promise<number> {
  const cutoff = now - BACKUP_RETENTION_DAYS * 86_400_000;
  let removed = 0;
  for (const key of await backups.keys()) {
    const backup = await backups.get<{ created_at?: string }>(key);
    const made = Date.parse(backup?.created_at ?? "");
    if (Number.isFinite(made) && made < cutoff) {
      await backups.delete(key);
      removed += 1;
    }
  }
  return removed;
}

function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function chunks<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += size) out.push(values.slice(i, i + size));
  return out;
}

export function compactItem(item: PlaylistItem): CompactItem {
  return {
    position: item.position,
    uri: item.uri,
    name: item.name,
    artists: item.artists.map((a) => a.name ?? ""),
    album: item.album?.name ?? null,
    duration: item.duration,
  };
}

// --- Pure helpers (no I/O) ---------------------------------------------------------------------------

/** New order (as original positions) after moving one item to `to`. */
export function orderFromMove(count: number, from: number, to: number): number[] {
  if (!(Number.isInteger(from) && Number.isInteger(to) && from >= 0 && from < count && to >= 0 && to < count)) {
    throw planError("Move positions out of range.", { from, to, item_count: count });
  }
  const order = Array.from({ length: count }, (_, i) => i);
  order.splice(to, 0, order.splice(from, 1)[0]!);
  return order;
}

/**
 * Range moves that turn [0..n-1] into `newOrder`. Walks target positions left to right; when the wrong
 * item is in place, moves the longest contiguous block that already has the target sequence up to that
 * position. Blocks only move upward, so insert_before is simply the target position.
 */
export function computeMoves(newOrder: number[]): Extract<Operation, { op: "move" }>[] {
  const n = newOrder.length;
  const current = Array.from({ length: n }, (_, i) => i);
  const ops: Extract<Operation, { op: "move" }>[] = [];
  let i = 0;
  while (i < n) {
    if (current[i] === newOrder[i]) {
      i += 1;
      continue;
    }
    const j = current.indexOf(newOrder[i]!, i);
    let length = 1;
    while (i + length < n && j + length < n && length < MAX_RANGE_LENGTH && current[j + length] === newOrder[i + length]) length += 1;
    ops.push({ op: "move", range_start: j, insert_before: i, range_length: length });
    const block = current.splice(j, length);
    current.splice(i, 0, ...block);
    i += length;
  }
  return ops;
}

/**
 * Operations that remove exactly the items at `positions`. The API removes every occurrence of a URI, so
 * occurrences of the same URI that must stay are re-inserted at their final positions afterwards.
 */
export function computeRemoveOperations(beforeUris: string[], positions: Set<number>): Operation[] {
  const targets: string[] = [];
  for (const p of [...positions].sort((a, b) => a - b)) if (!targets.includes(beforeUris[p]!)) targets.push(beforeUris[p]!);
  const ops: Operation[] = chunks(targets, MAX_URIS_PER_REQUEST).map((uris) => ({ op: "delete_uris", uris }));
  const affected = new Set(targets);
  const after = beforeUris.filter((_, idx) => !positions.has(idx));
  after.forEach((uri, newPos) => {
    if (!affected.has(uri)) return;
    const last = ops.at(-1)!;
    if (last.op === "insert" && last.position + last.uris.length === newPos && last.uris.length < MAX_URIS_PER_REQUEST) last.uris.push(uri);
    else ops.push({ op: "insert", uris: [uri], position: newPos });
  });
  return ops;
}

/** Apply operations locally with Spotify's semantics. delete_uris matches by value. */
export function simulate<T>(items: T[], operations: Operation[]): T[] {
  let current = [...items];
  for (const op of operations) {
    if (op.op === "delete_uris") {
      const doomed = new Set<unknown>(op.uris);
      current = current.filter((x) => !doomed.has(x));
    } else if (op.op === "insert") {
      if (!(Number.isInteger(op.position) && op.position >= 0 && op.position <= current.length)) {
        throw planError("Insert position out of range.", { operation: op });
      }
      current.splice(op.position, 0, ...(op.uris as unknown as T[]));
    } else if (op.op === "move") {
      const { range_start: start, insert_before: before, range_length: length } = op;
      if (!(start >= 0 && length >= 1 && start + length <= current.length && before >= 0 && before <= current.length)) {
        throw planError("Move out of range.", { operation: op });
      }
      const block = current.slice(start, start + length);
      const rest = [...current.slice(0, start), ...current.slice(start + length)];
      const dest = before <= start ? before : before - length;
      current = [...rest.slice(0, dest), ...block, ...rest.slice(dest)];
    } else {
      throw planError("Unknown operation.", { operation: op });
    }
  }
  return current;
}

/** JSON with keys sorted at every level and no spaces, like Python's json.dumps(sort_keys=True, separators=(",", ":")). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

const shown = (i: CompactItem) => ({ uri: i.uri, name: i.name, artists: i.artists });

/**
 * Over what the plan does and everything the plan card shows of it: the playlist's name, the items' names and
 * artists, the listed changes, the reason, the warnings, and when it was built (as curatune commit 2877459
 * does, so an edited plan cannot keep its operations and show other text).
 */
export async function planChecksum(plan: Omit<Plan, "checksum"> & { checksum?: string }): Promise<string> {
  const itemsPlan = plan.kind !== "details"; // details plans hold field values, not item lists
  const core = {
    schema_version: plan.schema_version,
    kind: plan.kind,
    playlist_id: plan.playlist.id,
    playlist_name: plan.playlist.name ?? null,
    snapshot_id: plan.playlist.snapshot_id,
    created_at: plan.created_at ?? null,
    reason: plan.reason ?? null,
    before: itemsPlan ? (plan.before as CompactItem[]).map(shown) : plan.before,
    after: itemsPlan ? (plan.after as AfterItem[]).map(shown) : plan.after,
    changes: plan.changes ?? null,
    operations: plan.operations,
    warnings: plan.warnings ?? null,
  };
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(core)));
  return `sha256:${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// --- Validation ----------------------------------------------------------------------------------------

export async function validatePlan(plan: Plan): Promise<void> {
  const required = ["schema_version", "plan_id", "kind", "playlist", "before", "after", "operations", "checksum"];
  const missing = required.filter((k) => !(k in (plan as unknown as Record<string, unknown>)));
  if (missing.length) throw planError("Plan is missing required fields.", { missing });
  if (plan.schema_version !== PLAN_SCHEMA_VERSION) throw planError("Unsupported plan schema version.", { schema_version: plan.schema_version });
  if (!(PLAN_KINDS as readonly string[]).includes(plan.kind)) throw planError("Unknown plan kind.", { kind: plan.kind });
  if ((await planChecksum(plan)) !== plan.checksum) {
    throw planError("Plan checksum mismatch: the plan was modified after it was generated. Regenerate it.", {}, "PLAN_CHECKSUM_MISMATCH");
  }
  if (plan.kind === "details") {
    checkDetails(plan);
    return;
  }
  const beforeUris = plan.before.map((i) => i.uri);
  const simulated = simulate(beforeUris, plan.operations);
  const afterUris = plan.after.map((i) => i.uri);
  if (simulated.length !== afterUris.length || simulated.some((uri, i) => uri !== afterUris[i])) {
    throw planError("Plan operations do not produce the declared resulting state.", {}, "PLAN_INCONSISTENT");
  }
  checkDescriptions(plan);
}

const sameJson = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/**
 * The human-readable parts of a plan (after positions, changes) must match what it does. The checksum only
 * detects accidental edits, and simulate ties operations to the after URIs. This ties after to before and
 * changes to both, so a plan cannot show one change and apply another.
 */
function checkDescriptions(plan: ItemPlan): void {
  const { before, after } = plan;
  const changes = plan.changes ?? {};
  const inconsistent = (reason: string) => planError(`Plan description is inconsistent: ${reason}.`, {}, "PLAN_INCONSISTENT");

  if (before.some((b, i) => b.position !== i)) throw inconsistent("before positions are not 0..n-1");
  after.forEach((a, i) => {
    const src = a.from_position;
    if (a.position !== i || !Number.isInteger(src) || src < 0 || src >= before.length) throw inconsistent(`after[${i}] has invalid positions`);
    if (a.uri !== before[src]!.uri) throw inconsistent(`after[${i}] does not match before[${src}]`);
  });
  const sources = after.map((a) => a.from_position);

  if (plan.kind === "remove") {
    const kept = new Set(sources);
    if (kept.size !== sources.length || sources.some((s, i) => i > 0 && s < sources[i - 1]!)) {
      throw inconsistent("a removal cannot reorder or duplicate items");
    }
    const described = (changes.remove ?? []).map((r) => [r.position, r.uri]);
    const actual = before.filter((_, p) => !kept.has(p)).map((b) => [b.position, b.uri]);
    if (!sameJson(described, actual)) throw inconsistent("the listed removals differ from what the plan removes");
  } else {
    const sorted = [...sources].sort((a, b) => a - b);
    if (sorted.some((s, i) => s !== i) || sorted.length !== before.length) throw inconsistent("a reorder must keep every item exactly once");
    if (!sameJson(changes.new_order, sources)) throw inconsistent("new_order differs from the resulting order");
    const moves = (changes.moves ?? []).map(({ items: _items, ...rest }) => rest);
    if (!sameJson(moves, plan.operations)) throw inconsistent("the listed moves differ from the operations");
  }
}

/** A details plan changes only name and/or description, and its parts must agree with each other. */
function checkDetails(plan: DetailsPlan): void {
  const { before, after } = plan;
  const inconsistent = (reason: string) => planError(`Plan description is inconsistent: ${reason}.`, {}, "PLAN_INCONSISTENT");
  const isObject = (v: unknown) => v !== null && typeof v === "object" && !Array.isArray(v);
  if (!isObject(before) || !isObject(after) || !Object.keys(after).length) {
    throw inconsistent("before and after must be objects listing the changed fields");
  }
  const afterKeys = Object.keys(after).sort();
  const beforeKeys = Object.keys(before).sort();
  if (!sameJson(afterKeys, beforeKeys) || afterKeys.some((k) => !(DETAIL_FIELDS as readonly string[]).includes(k))) {
    throw inconsistent(`only ${DETAIL_FIELDS.join(" and ")} can change, each with its previous value`);
  }
  const fields = afterKeys as DetailField[];
  if (fields.some((k) => before[k] === after[k])) throw inconsistent("a field is listed as changed but keeps the same value");
  if ("name" in after && !String(after.name).trim()) throw inconsistent("the new name is empty");
  if (!sameJson(plan.operations, [{ op: "set_details", fields: after }])) throw inconsistent("the operations differ from the declared change");
  const expectedChanges = Object.fromEntries(fields.map((k) => [k, { from: before[k], to: after[k] }]));
  if (!sameJson(plan.changes, expectedChanges)) throw inconsistent("the listed changes differ from before and after");
}

// --- Building plans ------------------------------------------------------------------------------------

function randomHex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function planId(kind: string, playlistId: string, createdAt: string): string {
  return `${createdAt.replace(/[-:]/g, "")}-${kind}-${playlistId.slice(0, 8)}-${randomHex(2)}`;
}

async function finalize(
  kind: "remove" | "reorder",
  state: PlaylistState,
  changes: ItemPlan["changes"],
  afterPositions: number[],
  operations: Operation[],
  reason: string | null,
  warnings: Warning[],
): Promise<ItemPlan> {
  const playlist = state.playlist;
  const before = state.items.map(compactItem);
  const after: AfterItem[] = afterPositions.map((orig, newPos) => ({ ...before[orig]!, position: newPos, from_position: orig }));

  // Self-check: the operations must reproduce the declared resulting state.
  const simulated = simulate(before.map((b) => b.uri), operations);
  if (simulated.length !== after.length || simulated.some((uri, i) => uri !== after[i]!.uri)) {
    throw planError("Internal error: computed operations do not reproduce the target state.", {}, "PLAN_INCONSISTENT");
  }
  const createdAt = isoNow();
  const plan: Omit<ItemPlan, "checksum"> = {
    schema_version: PLAN_SCHEMA_VERSION,
    plan_id: planId(kind, playlist.id!, createdAt),
    kind,
    created_at: createdAt,
    reason,
    playlist: { id: playlist.id!, uri: playlist.uri, name: playlist.name, snapshot_id: playlist.snapshot_id, item_count: before.length },
    before,
    changes,
    after,
    operations,
    // Read-time warnings (e.g. SNAPSHOT_READ_LAG) first.
    warnings: [...state.warnings, ...warnings],
  };
  return { ...plan, checksum: await planChecksum(plan) };
}

/** Plan the removal of the items at `positions` (0-based). */
export async function buildRemovePlan(client: SpotifyClient, playlistRef: string, positions: number[], reason: string | null = null): Promise<ItemPlan> {
  const state = await getPlaylist(client, playlistRef); // no market: plans need the stored URIs
  requireEditable(state.playlist);
  const items = state.items;
  const count = items.length;
  if (!positions.length) throw planError("No positions given.");
  if (new Set(positions).size !== positions.length) throw planError("Duplicate positions.", { positions });
  const outOfRange = positions.filter((p) => !(Number.isInteger(p) && p >= 0 && p < count));
  if (outOfRange.length) throw planError("Positions out of range.", { positions: outOfRange, item_count: count });
  const noUri = positions.filter((p) => items[p]!.uri === null);
  if (noUri.length) throw planError("Cannot remove items without a URI (unavailable items).", { positions: noUri });

  const toRemove = new Set(positions);
  const operations = computeRemoveOperations(items.map((i) => i.uri!), toRemove);
  const afterPositions = items.map((_, p) => p).filter((p) => !toRemove.has(p));

  const warnings: Warning[] = [];
  const reinserted = operations.filter((op): op is Extract<Operation, { op: "insert" }> => op.op === "insert");
  if (reinserted.length) {
    warnings.push({
      code: "REINSERTED_DUPLICATES",
      message: "Kept occurrences of duplicated URIs are removed and re-inserted; their added_at resets.",
      count: reinserted.reduce((sum, op) => sum + op.uris.length, 0),
    });
  }
  if (positions.some((p) => items[p]!.is_local)) {
    warnings.push({ code: "LOCAL_FILE_REMOVAL", message: "Removing local files through the API is unverified." });
  }
  const changes = { remove: [...positions].sort((a, b) => a - b).map((p) => compactItem(items[p]!)) };
  return finalize("remove", state, changes, afterPositions, operations, reason, warnings);
}

/**
 * Sort keys computed here, not by the model (small models sort lists unreliably). A web-only addition:
 * curatune only sorts by recording date, which v1 excludes. `released` is the edition's date.
 */
export const SORT_KEYS = ["title", "artist", "album", "released", "duration"] as const;
export type SortKey = (typeof SORT_KEYS)[number];

const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
/** Leading punctuation ("'Round Midnight") and a leading "The " do not count for text sorts. */
const textKey = (value: string | null | undefined) => (value ?? "").replace(/^[^\p{L}\p{N}]+/u, "").replace(/^the\s+/i, "");

/** Stable sort of positions by a key; items without a value go last. */
export function sortedOrder(items: PlaylistItem[], key: SortKey, descending = false): number[] {
  const value = (i: PlaylistItem): string | number | null => {
    if (key === "title") return i.name ? textKey(i.name) : null;
    if (key === "artist") return i.artists[0]?.name ? textKey(i.artists[0].name) : null;
    if (key === "album") return i.album?.name ? textKey(i.album.name) : null;
    if (key === "released") return i.album?.release_date ?? null;
    return i.duration_ms;
  };
  const keyed = items.map((item) => ({ position: item.position, v: value(item) }));
  keyed.sort((a, b) => {
    if (a.v === null || b.v === null) return a.v === null ? (b.v === null ? a.position - b.position : 1) : -1;
    const cmp = typeof a.v === "number" && typeof b.v === "number" ? a.v - b.v : collator.compare(String(a.v), String(b.v));
    return (descending ? -cmp : cmp) || a.position - b.position;
  });
  return keyed.map((k) => k.position);
}

/**
 * Plan a reorder. Exactly one of `newOrder` (a permutation of 0-based positions), `move` [from, to], `sortBy`,
 * or `recordings` (order by recording date; fails with RECORDING_DATES_MISSING if any item has no date).
 */
export async function buildReorderPlan(
  client: SpotifyClient,
  playlistRef: string,
  options: { newOrder?: number[]; move?: [number, number]; sortBy?: SortKey; descending?: boolean; recordings?: RecordingMap },
  reason: string | null = null,
): Promise<ItemPlan> {
  const state = await getPlaylist(client, playlistRef); // no market: plans need the stored URIs
  requireEditable(state.playlist);
  const count = state.items.length;
  const given = [options.newOrder, options.move, options.sortBy, options.recordings].filter((x) => x !== undefined).length;
  if (given !== 1) throw planError("Provide exactly one of new_order, move, sort_by, or recording dates.");
  const newOrder = options.move
    ? orderFromMove(count, options.move[0], options.move[1])
    : options.sortBy
      ? sortedOrder(state.items, options.sortBy, Boolean(options.descending))
      : options.recordings
        ? chronologicalOrder(state.items, options.recordings)
        : options.newOrder!;
  const sorted = [...newOrder].sort((a, b) => a - b);
  if (newOrder.length !== count || sorted.some((p, i) => p !== i)) {
    throw planError("new_order must be a permutation of all current positions.", { item_count: count, given_length: newOrder.length });
  }
  if (newOrder.every((p, i) => p === i)) throw planError("The new order is identical to the current one.", {}, "NO_CHANGES");

  const operations = computeMoves(newOrder);
  // Annotate each move with the items it carries (by original position) for human review.
  const compact = state.items.map(compactItem);
  let tokens = Array.from({ length: count }, (_, i) => i);
  const moves: MoveChange[] = operations.map((op) => {
    const block = tokens.slice(op.range_start, op.range_start + op.range_length);
    tokens = simulate(tokens, [op]);
    return { ...op, items: block.map((t) => ({ from_position: t, name: compact[t]!.name, artists: compact[t]!.artists })) };
  });
  return finalize("reorder", state, { new_order: newOrder, moves }, newOrder, operations, reason, []);
}

function currentDetails(playlist: { name: string | null; description: string | null }, fields: DetailField[]): Partial<Record<DetailField, string>> {
  return Object.fromEntries(fields.map((k) => [k, playlist[k] || ""]));
}

/** Plan a rename and/or a description change. Visibility is never part of it. */
export async function buildDetailsPlan(
  client: SpotifyClient,
  playlistRef: string,
  requested: { name?: string; description?: string },
  reason: string | null = null,
): Promise<DetailsPlan> {
  const playlist = await getPlaylistMeta(client, playlistRef);
  requireEditable(playlist);
  const wanted: Partial<Record<DetailField, string>> = {};
  if (requested.name !== undefined) {
    if (!requested.name.trim()) throw planError("The new name cannot be empty.");
    wanted.name = requested.name.trim();
  }
  if (requested.description !== undefined) wanted.description = requested.description.trim();
  if (!Object.keys(wanted).length) throw planError("Provide a new name, a new description, or both.");

  const fields = Object.keys(wanted) as DetailField[];
  const current = currentDetails(playlist, fields);
  const after = Object.fromEntries(fields.filter((k) => wanted[k] !== current[k]).map((k) => [k, wanted[k]!])) as Partial<Record<DetailField, string>>;
  const changed = Object.keys(after) as DetailField[];
  if (!changed.length) throw planError("The playlist already has that name and description.", {}, "NO_CHANGES");
  const before = Object.fromEntries(changed.map((k) => [k, current[k]!])) as Partial<Record<DetailField, string>>;

  const warnings: Warning[] = [];
  if (after.name !== undefined) {
    const target = after.name.toLocaleLowerCase();
    const others = (await listPlaylists(client, true)).playlists.filter(
      (p) => p.id !== playlist.id && (p.name ?? "").trim().toLocaleLowerCase() === target,
    );
    if (others.length) {
      warnings.push({
        code: "DUPLICATE_NAME",
        message: "You already own another playlist with this name.",
        existing: others.map((p) => ({ id: p.id, name: p.name })),
      });
    }
  }
  const createdAt = isoNow();
  const plan: Omit<DetailsPlan, "checksum"> = {
    schema_version: PLAN_SCHEMA_VERSION,
    plan_id: planId("details", playlist.id!, createdAt),
    kind: "details",
    created_at: createdAt,
    reason,
    playlist: { id: playlist.id!, uri: playlist.uri, name: playlist.name, snapshot_id: playlist.snapshot_id },
    before,
    changes: Object.fromEntries(changed.map((k) => [k, { from: before[k]!, to: after[k]! }])),
    after,
    operations: [{ op: "set_details", fields: after }],
    warnings,
  };
  return { ...plan, checksum: await planChecksum(plan) };
}

// --- Checking and applying ------------------------------------------------------------------------------

export interface PlanCheck {
  applicable: boolean;
  same_snapshot?: boolean;
  same_items?: boolean;
  same_values?: boolean;
  current_snapshot_id?: string | null;
  current?: Partial<Record<DetailField, string>>;
}

/** Compare a plan with the live playlist without changing anything. */
export async function checkPlan(client: SpotifyClient, plan: Plan): Promise<PlanCheck> {
  await validatePlan(plan);
  if (plan.kind === "details") {
    const current = currentDetails(await getPlaylistMeta(client, plan.playlist.id), Object.keys(plan.before) as DetailField[]);
    const sameValues = sameJson(current, plan.before);
    return { applicable: sameValues && !plan.applied, same_values: sameValues, current };
  }
  const state = await getPlaylist(client, plan.playlist.id);
  const sameSnapshot = state.playlist.snapshot_id === plan.playlist.snapshot_id;
  const sameItems = sameJson(state.items.map((i) => i.uri), plan.before.map((i) => i.uri));
  return { applicable: sameSnapshot && sameItems && !plan.applied, same_snapshot: sameSnapshot, same_items: sameItems, current_snapshot_id: state.playlist.snapshot_id };
}

async function execute(client: SpotifyClient, playlistId: string, op: Operation, snapshotId: string): Promise<string> {
  if (op.op === "delete_uris") return removeUris(client, playlistId, op.uris, snapshotId);
  if (op.op === "insert") return insertUris(client, playlistId, op.uris, op.position);
  if (op.op === "move") return moveRange(client, playlistId, op.range_start, op.insert_before, op.range_length, snapshotId);
  throw planError("Unknown operation.", { operation: op });
}

/**
 * Validate, check against the live playlist, back up, execute, and verify. Mutates `plan.applied` on
 * success (also when verification fails, since the operations ran). Called only from the UI.
 */
export async function applyPlan(client: SpotifyClient, plan: Plan, backups: KeyValueStore): Promise<ApplyResult> {
  await validatePlan(plan);
  if (plan.applied) throw planError("This plan was already applied.", { applied: plan.applied }, "PLAN_ALREADY_APPLIED");
  if (plan.kind === "details") return applyDetails(client, plan, backups);

  const playlistId = plan.playlist.id;
  const state = await getPlaylist(client, playlistId);
  const currentUris = state.items.map((i) => i.uri);
  const expectedUris = plan.before.map((i) => i.uri);
  const itemsChanged = !sameJson(currentUris, expectedUris);
  // The URI list must always match. The snapshot (already corrected by getPlaylist for read lag after our
  // own writes) must match too.
  if (state.playlist.snapshot_id !== plan.playlist.snapshot_id || itemsChanged) {
    throw new CuratuneError("SNAPSHOT_MISMATCH", "The playlist changed since the plan was generated. Nothing was modified; ask for a new plan.", {
      plan_snapshot_id: plan.playlist.snapshot_id,
      current_snapshot_id: state.playlist.snapshot_id,
      items_changed: itemsChanged,
    });
  }
  requireEditable(state.playlist);

  const backupKey = `${playlistId}-${isoNow()}-before-${plan.plan_id}`;
  await backups.set(backupKey, { created_at: isoNow(), plan_id: plan.plan_id, playlist: state.playlist, items: state.items });

  let snapshotId = plan.playlist.snapshot_id ?? "";
  let done = 0;
  for (const op of plan.operations) {
    try {
      snapshotId = await execute(client, playlistId, op, snapshotId);
    } catch (exc) {
      if (!(exc instanceof CuratuneError)) throw exc;
      await client.writeLog?.forget(playlistId); // state is unknown now; do not vouch for it
      throw new CuratuneError("APPLY_FAILED", "Applying the plan failed partway; the playlist may be partially modified.", {
        operations_done: done,
        operations_total: plan.operations.length,
        failed_operation: op,
        error: exc.toJSON(),
        backup_key: backupKey,
      });
    }
    done += 1;
  }

  const expectedAfter = plan.after.map((i) => i.uri);
  await client.writeLog?.record(playlistId, snapshotId, expectedAfter);
  const final = await getPlaylist(client, playlistId);
  const finalUris = final.items.map((i) => i.uri);
  const verified = sameJson(finalUris, expectedAfter);
  // The last write's snapshot is authoritative; reads may still return an older one.
  plan.applied = { applied_at: isoNow(), verified, snapshot_id: snapshotId, backup_key: backupKey };
  if (!verified) {
    throw new CuratuneError("VERIFICATION_FAILED", "The plan was applied but the resulting playlist does not match the expected state.", {
      plan_id: plan.plan_id,
      operations_done: done,
      expected_uris: expectedAfter,
      actual_uris: finalUris,
      backup_key: backupKey,
    });
  }
  return { applied: true, plan_id: plan.plan_id, playlist_id: playlistId, operations_done: done, verified, snapshot_id: snapshotId, backup_key: backupKey, warnings: [] };
}

async function applyDetails(client: SpotifyClient, plan: DetailsPlan, backups: KeyValueStore): Promise<ApplyResult> {
  const playlistId = plan.playlist.id;
  const playlist = await getPlaylistMeta(client, playlistId);
  requireEditable(playlist);
  const fieldsBefore = Object.keys(plan.before) as DetailField[];
  const now = currentDetails(playlist, fieldsBefore);
  if (!sameJson(now, plan.before)) {
    // Only the fields being changed matter here; item changes don't affect a rename or description.
    throw new CuratuneError("SNAPSHOT_MISMATCH", "The playlist's name or description changed since the plan was generated. Nothing was modified; ask for a new plan.", {
      expected: plan.before,
      current: now,
    });
  }
  const backupKey = `${playlistId}-${isoNow()}-before-${plan.plan_id}`;
  await backups.set(backupKey, { created_at: isoNow(), plan_id: plan.plan_id, playlist });

  try {
    await setDetails(client, playlistId, plan.after);
  } catch (exc) {
    if (!(exc instanceof CuratuneError)) throw exc;
    throw new CuratuneError("APPLY_FAILED", "Changing the playlist details failed; nothing was changed.", {
      operations_done: 0,
      error: exc.toJSON(),
      backup_key: backupKey,
    });
  }

  // Spotify answers 200 even for changes it ignores (it does so for visibility), so read back.
  const fields = Object.keys(plan.after) as DetailField[];
  let verified = false;
  let current = now;
  for (let attempt = 0; attempt < DETAILS_VERIFY_ATTEMPTS; attempt++) {
    if (attempt) await client.sleep(DETAILS_VERIFY_DELAY_MS);
    current = currentDetails(await getPlaylistMeta(client, playlistId), fields);
    if (sameJson(current, plan.after)) {
      verified = true;
      break;
    }
  }
  plan.applied = { applied_at: isoNow(), verified, backup_key: backupKey };
  const warnings: Warning[] = verified
    ? []
    : [
        {
          code: "DETAILS_NOT_CONFIRMED",
          message: "Spotify accepted the change (HTTP 200), but reads still show other values. Reads can lag for a few minutes; if it persists, Spotify ignored the change. Check it in the Spotify app.",
          current,
        },
      ];
  return { applied: true, plan_id: plan.plan_id, playlist_id: playlistId, operations_done: 1, verified, current, backup_key: backupKey, warnings };
}
