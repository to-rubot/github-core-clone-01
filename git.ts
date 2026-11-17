// git.ts — the git object model, pack format and graph walks, implemented
// from the git specification on top of node:crypto and node:zlib only.
// There is no git binary in the runtime; everything the smart-HTTP surface
// speaks is produced and consumed here.
//
// Objects live in a plain Map<oid, GitObject> per repository (see store.ts).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export interface GitObject {
  type: string; // 'commit' | 'tree' | 'blob' | 'tag'
  data: Buffer;
}

export type ObjectMap = Map<string, GitObject>;

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const TYPE_NUMBERS: Readonly<Record<string, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUMBER_TYPES: readonly string[] = ['', 'commit', 'tree', 'blob', 'tag', '', 'ofs-delta', 'ref-delta'];

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The SHA-1 object id of an object: sha1("<type> <length>\0" + data). */
export function hashObject(type: string, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object and return its id (idempotent: the id is content-derived). */
export function storeObject(store: ObjectMap, type: string, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line: 4 hex digits of total length (header included) + payload. */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 65520) throw new Error(`pkt-line payload too large: ${body.length}`);
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'ascii'), body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktPacket {
  kind: PktKind;
  payload: Buffer;
}

/** A cursor over a fully-buffered pkt-line stream (request bodies are read whole). */
export class PktReader {
  private pos = 0;
  private readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }

  /** The next packet, or null at a clean end of buffer. Throws on malformed framing. */
  next(): PktPacket | null {
    if (this.pos >= this.buf.length) return null;
    if (this.pos + 4 > this.buf.length) throw new Error('truncated pkt-line header');
    const hex = this.buf.toString('ascii', this.pos, this.pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length: ${JSON.stringify(hex)}`);
    const length = parseInt(hex, 16);
    if (length === 0) {
      this.pos += 4;
      return { kind: 'flush', payload: Buffer.alloc(0) };
    }
    if (length === 1) {
      this.pos += 4;
      return { kind: 'delim', payload: Buffer.alloc(0) };
    }
    if (length === 2) {
      this.pos += 4;
      return { kind: 'response-end', payload: Buffer.alloc(0) };
    }
    if (length === 3 || length < 4) throw new Error(`reserved pkt-line length: ${length}`);
    if (this.pos + length > this.buf.length) throw new Error('truncated pkt-line payload');
    const payload = this.buf.subarray(this.pos + 4, this.pos + length);
    this.pos += length;
    return { kind: 'data', payload };
  }

  /** Everything not yet consumed (the pack that follows a command list, usually). */
  remaining(): Buffer {
    return this.buf.subarray(this.pos);
  }
}

/** Frame pack bytes as side-band band-1 packets (data chunks of at most 65515 bytes). */
export function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const band = Buffer.from([1]);
  for (let offset = 0; offset < pack.length; offset += 65515) {
    packets.push(pktLine(Buffer.concat([band, pack.subarray(offset, offset + 65515)])));
  }
  return packets;
}

// ---------------------------------------------------------------- objects

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  const info: CommitInfo = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) info.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) info.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) info.author = line.slice(7);
    else if (line.startsWith('committer ')) info.committer = line.slice(10);
  }
  return info;
}

export function buildCommit(opts: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  let head = `tree ${opts.tree}\n`;
  for (const parent of opts.parents) head += `parent ${parent}\n`;
  head += `author ${opts.author}\ncommitter ${opts.committer}\n\n`;
  return Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from(opts.message, 'utf8')]);
}

/** Split an identity line "Name <email> 1735689600 +0000" into its parts. */
export function parseIdentity(line: string): { name: string; email: string; timestamp: number } {
  const match = /^(.*?) <(.*?)> (\d+) [+-]\d{4}$/.exec(line.trim());
  if (!match) return { name: line.trim(), email: '', timestamp: 0 };
  return { name: match[1], email: match[2], timestamp: Number(match[3]) };
}

export function formatIdentity(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

export interface TreeEntry {
  mode: string; // '100644', '100755', '120000', '40000' (tree), '160000' (gitlink)
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let pos = 0;
  while (pos < data.length) {
    const space = data.indexOf(0x20, pos);
    if (space < 0) throw new Error('malformed tree entry');
    const mode = data.toString('ascii', pos, space);
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree entry');
    const name = data.toString('utf8', space + 1, nul);
    const oid = data.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    pos = nul + 21;
  }
  return entries;
}

/** Serialize tree entries in git's order (names compared with '/' appended for trees). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split >= 0 ? text.slice(0, split) : text;
  const info: TagInfo = { object: '', type: '', tag: '', message: split >= 0 ? text.slice(split + 2) : '' };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) info.object = line.slice(7).trim();
    else if (line.startsWith('type ')) info.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) info.tag = line.slice(4).trim();
  }
  return info;
}

/** Follow tag objects until a non-tag object; returns its id, or null when a link is missing. */
export function peelToType(store: ObjectMap, oid: string, wantType: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 32; hops += 1) {
    const obj = store.get(current);
    if (!obj) return null;
    if (obj.type === wantType) return current;
    if (obj.type !== 'tag') return null;
    current = parseTag(obj.data).object;
  }
  return null;
}

export function peelToCommit(store: ObjectMap, oid: string): string | null {
  return peelToType(store, oid, 'commit');
}

// ---------------------------------------------------------------- trees as file maps

export interface FlatEntry {
  oid: string;
  mode: string;
}

/** Flatten a tree (recursively) into a path -> blob map. A missing tree flattens to empty. */
export function flattenTree(store: ObjectMap, treeOid: string): Map<string, FlatEntry> {
  const flat = new Map<string, FlatEntry>();
  const walk = (oid: string, prefix: string): void => {
    const obj = store.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      if (entry.mode === '40000') walk(entry.oid, `${prefix}${entry.name}/`);
      else flat.set(`${prefix}${entry.name}`, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  return flat;
}

/** Build (and store) nested trees from a flattened path map; returns the root tree id. */
export function buildTreeFromFlat(store: ObjectMap, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: [], dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.push({ mode: entry.mode, name: parts[parts.length - 1], oid: entry.oid });
  }
  const emit = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: emit(dir) });
    return storeObject(store, 'tree', buildTree(entries));
  };
  return emit(root);
}

// ---------------------------------------------------------------- graph walks

/** Ancestor commits of a tip with BFS distances (tip = 0). Tags are peeled first. */
export function ancestorsOf(store: ObjectMap, tip: string): Map<string, number> {
  const distances = new Map<string, number>();
  const start = peelToCommit(store, tip);
  if (start === null) return distances;
  const queue: Array<[string, number]> = [[start, 0]];
  while (queue.length) {
    const [oid, distance] = queue.shift()!;
    if (distances.has(oid)) continue;
    distances.set(oid, distance);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push([parent, distance + 1]);
  }
  return distances;
}

/** True when `ancestor` is `descendant` itself or reachable from it through parents. */
export function isAncestor(store: ObjectMap, ancestor: string, descendant: string): boolean {
  const target = peelToCommit(store, ancestor);
  if (target === null) return false;
  return ancestorsOf(store, descendant).has(target);
}

/** The best common ancestor of two commits, or null when their histories are disjoint. */
export function mergeBase(store: ObjectMap, a: string, b: string): string | null {
  const ancA = ancestorsOf(store, a);
  const startB = peelToCommit(store, b);
  if (startB === null) return null;
  const seen = new Set<string>();
  const queue: string[] = [startB];
  while (queue.length) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    if (ancA.has(oid)) return oid;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    queue.push(...parseCommit(obj.data).parents);
  }
  return null;
}

/**
 * Every object reachable from the given tips: commits with their trees and
 * blobs, trees recursively, tags followed. Commits in `stopAt` are included
 * (with their trees) but their parents are not followed — that is how a
 * shallow client's held set is modelled.
 */
export function collectClosure(store: ObjectMap, tips: readonly string[], stopAt?: ReadonlySet<string>): Set<string> {
  const result = new Set<string>();
  const stack = [...tips];
  while (stack.length) {
    const oid = stack.pop()!;
    if (result.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    result.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      if (!stopAt || !stopAt.has(oid)) stack.push(...info.parents);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) stack.push(entry.oid);
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.data).object);
    }
  }
  return result;
}

/** Commits in BFS generation order from a tip (tip first), deduplicated. */
export function commitsInOrder(store: ObjectMap, tip: string): string[] {
  return [...ancestorsOf(store, tip).entries()].sort((x, y) => x[1] - y[1]).map(([oid]) => oid);
}

// ---------------------------------------------------------------- three-way merge

function flatEqual(a: FlatEntry | undefined, b: FlatEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.oid === b.oid && a.mode === b.mode;
}

export type MergeOutcome = { ok: true; tree: string } | { ok: false; conflictPath: string };

/**
 * A per-path three-way merge of two trees against a base tree: a path only
 * one side changed takes that side's version; a path both sides changed
 * differently conflicts. The merged tree is stored and returned.
 */
export function threeWayMergeTrees(
  store: ObjectMap,
  baseTree: string | null,
  oursTree: string,
  theirsTree: string,
): MergeOutcome {
  const base = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(store, baseTree);
  const ours = flattenTree(store, oursTree);
  const theirs = flattenTree(store, theirsTree);
  const merged = new Map<string, FlatEntry>();
  const paths = new Set([...base.keys(), ...ours.keys(), ...theirs.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const o = ours.get(path);
    const t = theirs.get(path);
    let winner: FlatEntry | undefined;
    if (flatEqual(o, t)) winner = o;
    else if (flatEqual(b, o)) winner = t;
    else if (flatEqual(b, t)) winner = o;
    else return { ok: false, conflictPath: path };
    if (winner) merged.set(path, winner);
  }
  return { ok: true, tree: buildTreeFromFlat(store, merged) };
}

// ---------------------------------------------------------------- pack files

/** Inflate the zlib stream starting at `offset`, finding its exact end by bisection. */
function inflateExact(buf: Buffer, offset: number): { out: Buffer; next: number } {
  let lo = offset + 1;
  let hi = buf.length;
  // Invariant: buf.subarray(offset, hi) inflates (trailing bytes past the stream end are ignored).
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { out: inflateSync(buf.subarray(offset, lo)), next: lo };
}

/** Apply a git delta buffer to a base object body. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (pos >= delta.length) throw new Error('delta varint overruns the buffer');
      const byte = delta[pos];
      pos += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if (!(byte & 0x80)) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const chunks: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      chunks.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      chunks.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const out = Buffer.concat(chunks);
  if (out.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return out;
}

interface PackEntry {
  offset: number;
  type: string;
  data: Buffer; // inflated payload (the object body, or the delta program for delta types)
  baseOffset?: number;
  baseOid?: string;
  resolvedOid?: string;
}

/**
 * Read a pack v2 stream into an object map, resolving OFS/REF deltas.
 * `resolveBase` supplies bases that live outside the pack (thin packs).
 * The trailer checksum is verified. Throws on any malformed input.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack is too short');
  if (pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('pack magic is not PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const entries: PackEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const typeNumber = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: PackEntry = { offset: start, type: NUMBER_TYPES[typeNumber] ?? '', data: Buffer.alloc(0) };
    if (typeNumber === 6) {
      byte = pack[offset];
      offset += 1;
      let back = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        back = ((back + 1) << 7) | (byte & 0x7f);
      }
      entry.baseOffset = start - back;
    } else if (typeNumber === 7) {
      entry.baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
    } else if (typeNumber === 0 || typeNumber === 5) {
      throw new Error(`reserved pack object type ${typeNumber}`);
    }
    const inflated = inflateExact(pack, offset);
    offset = inflated.next;
    if (inflated.out.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.out;
    entries.push(entry);
  }
  const trailer = pack.toString('hex', offset, offset + 20);
  const digest = createHash('sha1').update(pack.subarray(0, offset)).digest('hex');
  if (trailer !== digest) throw new Error('pack trailer checksum mismatch');

  const byOffset = new Map<number, PackEntry>();
  for (const entry of entries) byOffset.set(entry.offset, entry);
  const objects = new Map<string, GitObject>();
  const byOid = new Map<string, PackEntry>();

  const resolve = (entry: PackEntry): GitObject => {
    if (entry.resolvedOid) return objects.get(entry.resolvedOid)!;
    let obj: GitObject;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: GitObject | undefined;
      if (entry.baseOffset !== undefined) {
        const baseEntry = byOffset.get(entry.baseOffset);
        if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
        base = resolve(baseEntry);
      } else {
        const baseEntry = byOid.get(entry.baseOid!);
        if (baseEntry) base = resolve(baseEntry);
        else base = resolveBase?.(entry.baseOid!);
        if (!base) throw new Error('ref-delta base is not available');
      }
      obj = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      obj = { type: entry.type, data: entry.data };
    }
    const oid = hashObject(obj.type, obj.data);
    entry.resolvedOid = oid;
    objects.set(oid, obj);
    byOid.set(oid, entry);
    return obj;
  };
  for (const entry of entries) resolve(entry);
  return objects;
}

function packEntryHeader(type: string, size: number): Buffer {
  const typeNumber = TYPE_NUMBERS[type];
  if (typeNumber === undefined) throw new Error(`cannot pack object type ${type}`);
  const bytes: number[] = [];
  let first = (typeNumber << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Write a pack v2 stream holding the given objects whole (no deltas). */
export function writePack(objects: Iterable<{ type: string; data: Buffer }>): Buffer {
  const list = [...objects];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(list.length, 8);
  const parts: Buffer[] = [head];
  for (const obj of list) {
    parts.push(packEntryHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- fetch planning

export interface FetchPlan {
  /** Object ids to put in the pack (already minus everything the client holds). */
  send: string[];
  /** Commits to report as `shallow` in shallow-info. */
  shallow: string[];
  /** Commits to report as `unshallow` in shallow-info. */
  unshallow: string[];
}

/**
 * Decide what a fetch delivers.
 *
 * - The client's held set is the closure of `haves`, except that commits the
 *   client lists as shallow boundaries are held with their trees but their
 *   parents are not followed (the client does not have them).
 * - With a depth, the wanted set is the commits within `depth` generations
 *   of the wants (deepen N therefore means an absolute depth of N from the
 *   want, matching how the suite drives it) plus their tree closures.
 * - A commit is reported shallow when one of its parents is neither sent
 *   nor already held; a former boundary that no longer qualifies is
 *   reported unshallow.
 */
export function planFetch(
  store: ObjectMap,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(clientShallow);
  const hasObjects = collectClosure(store, haves, shallowSet);
  const hasCommits = new Set<string>();
  for (const oid of hasObjects) {
    if (store.get(oid)?.type === 'commit') hasCommits.add(oid);
  }

  const wantCommits = new Set<string>();
  if (depth !== null && depth > 0) {
    const queue: Array<[string, number]> = [];
    for (const want of wants) {
      const commit = peelToCommit(store, want);
      if (commit !== null) queue.push([commit, 0]);
    }
    while (queue.length) {
      const [oid, generation] = queue.shift()!;
      if (wantCommits.has(oid)) continue;
      wantCommits.add(oid);
      if (generation + 1 >= depth) continue;
      const obj = store.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const parent of parseCommit(obj.data).parents) queue.push([parent, generation + 1]);
    }
  } else {
    for (const oid of collectClosure(store, wants)) {
      if (store.get(oid)?.type === 'commit') wantCommits.add(oid);
    }
  }

  // Wanted objects: the full closure of the wants, cut down to the wanted
  // commits when a depth applies (their trees and blobs ride along whole).
  // Passing wantCommits itself as the stop set keeps every wanted commit's
  // own tree while following no parent links at all.
  let wantObjects: Set<string>;
  if (depth !== null && depth > 0) {
    wantObjects = collectClosure(store, [...wantCommits], wantCommits);
    for (const oid of wants) {
      const obj = store.get(oid);
      if (obj && obj.type === 'tag') wantObjects.add(oid); // a wanted tag object itself always ships
    }
  } else {
    wantObjects = collectClosure(store, wants);
  }

  const sendSet = new Set<string>();
  for (const oid of wantObjects) if (!hasObjects.has(oid)) sendSet.add(oid);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  for (const commit of wantCommits) {
    const obj = store.get(commit);
    if (!obj || obj.type !== 'commit') continue;
    const parents = parseCommit(obj.data).parents;
    const cutOff = parents.some((parent) => !wantCommits.has(parent) && !hasCommits.has(parent));
    if (cutOff) shallow.push(commit);
    else if (shallowSet.has(commit)) unshallow.push(commit);
  }

  // Deterministic pack order: commits, then trees, then blobs, then tags.
  const rank = (oid: string): number => {
    const type = store.get(oid)?.type;
    return type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'blob' ? 2 : 3;
  };
  const send = [...sendSet].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
  return { send, shallow, unshallow };
}
