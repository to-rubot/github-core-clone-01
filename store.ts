// store.ts — the single in-memory store every surface (git smart HTTP,
// REST, GraphQL, MCP) reads and writes, so an object created through one
// surface is immediately visible through all the others.
//
// Determinism: nothing here reads the wall clock or a random source. Ids
// come from counters and timestamps from a logical clock (a fixed epoch
// plus a per-store sequence), so replaying the same request sequence
// produces byte-identical answers.

import {
  buildCommit,
  flattenTree,
  formatIdentity,
  mergeBase,
  parseCommit,
  storeObject,
  threeWayMergeTrees,
  type GitObject,
} from './git.ts';

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  seq: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[]; // label names, in the order they were attached
  comments: CommentRec[];
  seq: number;
  closedSeq: number | null;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  headRef: string; // short branch name
  baseRef: string; // short branch name
  headSha: string; // tips captured at creation (fallbacks when a branch vanishes)
  baseSha: string;
  merged: boolean;
  mergedSeq: number | null;
  mergeCommitSha: string | null;
  comments: CommentRec[];
  seq: number;
}

export interface RepoRec {
  id: number;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full ref ('refs/heads/main') -> object id
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number; // issues and pull requests share one numbering, as on GitHub
  seq: number;
}

/** The fixed epoch the logical clock starts from: 2025-01-01T00:00:00Z. */
export const EPOCH_SEC = 1735689600;

export class Store {
  readonly repos = new Map<string, RepoRec>(); // by repository name (single tenant)
  /** The viewer's login, learned from the first access that names an existing repo. */
  viewerLogin: string | null = null;
  readonly viewerId = 1000;

  private seq = 0;
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private requestCounter = 0;

  /** The next logical timestamp tick (monotonic across the whole store). */
  tick(): number {
    this.seq += 1;
    return this.seq;
  }

  /** An ISO timestamp for a logical tick. */
  isoOf(seq: number): string {
    return new Date((EPOCH_SEC + seq) * 1000).toISOString();
  }

  /** Epoch seconds for a logical tick (commit timestamps). */
  epochOf(seq: number): number {
    return EPOCH_SEC + seq;
  }

  /** A deterministic, non-empty request id. */
  nextRequestId(): string {
    this.requestCounter += 1;
    return `forge-${this.requestCounter.toString(16).padStart(8, '0')}`;
  }

  /**
   * Resolve a repository addressed as (owner, name). The bearer token does
   * not say who the viewer is, so the store is single-tenant: the first
   * owner under which an *existing* repository is addressed becomes the
   * viewer, and from then on other owners see nothing (which is exactly
   * what a foreign-token probe expects). Learning never happens for a
   * repository that does not exist, so 404 probes cannot claim the tenant.
   */
  repoFor(owner: string, name: string): RepoRec | null {
    const repo = this.repos.get(name);
    if (!repo) return null;
    if (this.viewerLogin === null) {
      this.viewerLogin = owner;
      return repo;
    }
    return owner === this.viewerLogin ? repo : null;
  }

  createRepo(name: string, opts: { description?: string | null; private?: boolean; defaultBranch?: string }): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId++,
      name,
      description: opts.description ?? null,
      private: opts.private ?? false,
      defaultBranch: opts.defaultBranch && opts.defaultBranch !== '' ? opts.defaultBranch : 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      seq: this.tick(),
    };
    this.repos.set(name, repo);
    return repo;
  }

  deleteRepo(repo: RepoRec): void {
    this.repos.delete(repo.name);
  }

  createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
    const issue: IssueRec = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      seq: this.tick(),
      closedSeq: null,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  createPull(
    repo: RepoRec,
    opts: { title: string; body: string; headRef: string; baseRef: string; headSha: string; baseSha: string },
  ): PullRec {
    const pull: PullRec = {
      id: this.nextPullId++,
      number: repo.nextNumber++,
      title: opts.title,
      body: opts.body,
      state: 'open',
      headRef: opts.headRef,
      baseRef: opts.baseRef,
      headSha: opts.headSha,
      baseSha: opts.baseSha,
      merged: false,
      mergedSeq: null,
      mergeCommitSha: null,
      comments: [],
      seq: this.tick(),
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  addComment(target: IssueRec | PullRec, body: string): CommentRec {
    const comment: CommentRec = { id: this.nextCommentId++, body, seq: this.tick() };
    target.comments.push(comment);
    return comment;
  }

  /** The full ref of a repo's HEAD target (its default branch). */
  headRefOf(repo: RepoRec): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  /** The current tip of a branch (short name), or null when it does not exist. */
  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }
}

// ---------------------------------------------------------------- global ids
//
// GraphQL node ids are opaque and stable. They are plain base64 of a typed
// key — crucially never the bare database id, which the suite rejects.

export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function repoGlobalId(repo: RepoRec): string {
  return globalId('Repository', String(repo.id));
}

export function issueGlobalId(repo: RepoRec, issue: IssueRec): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

export function pullGlobalId(repo: RepoRec, pull: PullRec): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

export function commentGlobalId(repo: RepoRec, comment: CommentRec): string {
  return globalId('IssueComment', `${repo.id}:${comment.id}`);
}

export function userGlobalId(store: Store): string {
  return globalId('User', String(store.viewerId));
}

// ---------------------------------------------------------------- pull request operations
//
// Shared by the REST surface, GraphQL and MCP so a merge means the same
// thing everywhere: a three-way squash onto the current base tip.

/** The current tip of a branch (short name), or null when it does not exist. */
export function branchTipOf(repo: RepoRec, branch: string): string | null {
  return repo.refs.get(`refs/heads/${branch}`) ?? null;
}

/**
 * Squash-merge a pull request onto the current tip of its base branch.
 * Returns the merge commit id, or null when the three-way merge conflicts
 * (in which case nothing is written and the pull request stays open).
 */
export function performSquashMerge(store: Store, repo: RepoRec, pull: PullRec): string | null {
  const objects = repo.objects;
  const baseTip = branchTipOf(repo, pull.baseRef) ?? pull.baseSha;
  const headTip = branchTipOf(repo, pull.headRef) ?? pull.headSha;
  const baseCommit = objects.get(baseTip);
  const headCommit = objects.get(headTip);
  if (!baseCommit || baseCommit.type !== 'commit' || !headCommit || headCommit.type !== 'commit') return null;
  const base = mergeBase(objects, baseTip, headTip);
  const baseTree = base === null ? null : parseCommit(objects.get(base)!.data).tree;
  const merged = threeWayMergeTrees(
    objects,
    baseTree,
    parseCommit(baseCommit.data).tree,
    parseCommit(headCommit.data).tree,
  );
  if (!merged.ok) return null;
  const seq = store.tick();
  const identity = formatIdentity('forge', 'forge@localhost', store.epochOf(seq));
  const message = pull.body === '' ? `${pull.title} (#${pull.number})` : `${pull.title} (#${pull.number})\n\n${pull.body}`;
  const commit = buildCommit({ tree: merged.tree, parents: [baseTip], author: identity, committer: identity, message });
  const oid = storeObject(objects, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
  return oid;
}

/** Mark a pull request merged after a successful performSquashMerge. */
export function markMerged(store: Store, pull: PullRec, sha: string): void {
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedSeq = store.tick();
  pull.mergeCommitSha = sha;
}

/** Dry-run mergeability of a pull request against the current branch tips. */
export function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state === 'closed') return 'UNKNOWN';
  const objects = repo.objects;
  const baseTip = branchTipOf(repo, pull.baseRef) ?? pull.baseSha;
  const headTip = branchTipOf(repo, pull.headRef) ?? pull.headSha;
  const baseCommit = objects.get(baseTip);
  const headCommit = objects.get(headTip);
  if (!baseCommit || baseCommit.type !== 'commit' || !headCommit || headCommit.type !== 'commit') return 'UNKNOWN';
  const base = mergeBase(objects, baseTip, headTip);
  const baseTree = base === null ? null : parseCommit(objects.get(base)!.data).tree;
  const merged = threeWayMergeTrees(
    objects,
    baseTree,
    parseCommit(baseCommit.data).tree,
    parseCommit(headCommit.data).tree,
  );
  return merged.ok ? 'MERGEABLE' : 'CONFLICTING';
}

export interface PullFileChange {
  filename: string;
  sha: string | undefined;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line counts of a change via a longest-common-subsequence over lines. */
function lineDiff(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  const lines = (buf: Buffer | null): string[] => {
    if (buf === null) return [];
    const parts = buf.toString('utf8').split('\n');
    if (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts;
  };
  const a = lines(before);
  const b = lines(after);
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(dp[j], dp[j - 1]);
      diagonal = above;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

/** The file-level diff of a pull request: merge-base tree versus head tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): PullFileChange[] {
  const headTip = branchTipOf(repo, pull.headRef) ?? pull.headSha;
  const baseTip = branchTipOf(repo, pull.baseRef) ?? pull.baseSha;
  const base = mergeBase(repo.objects, baseTip, headTip);
  const empty = new Map<string, { oid: string; mode: string }>();
  const baseFlat = base === null ? empty : flattenTree(repo.objects, parseCommit(repo.objects.get(base)!.data).tree);
  const headCommit = repo.objects.get(headTip);
  const headFlat = headCommit && headCommit.type === 'commit'
    ? flattenTree(repo.objects, parseCommit(headCommit.data).tree)
    : empty;
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  const files: PullFileChange[] = [];
  for (const path of [...paths].sort()) {
    const before = baseFlat.get(path);
    const after = headFlat.get(path);
    if (before && after && before.oid === after.oid && before.mode === after.mode) continue;
    const diff = lineDiff(
      before ? repo.objects.get(before.oid)?.data ?? null : null,
      after ? repo.objects.get(after.oid)?.data ?? null : null,
    );
    files.push({
      filename: path,
      sha: after?.oid ?? before?.oid,
      status: !before ? 'added' : !after ? 'removed' : 'modified',
      additions: diff.additions,
      deletions: diff.deletions,
      changes: diff.additions + diff.deletions,
    });
  }
  return files;
}
