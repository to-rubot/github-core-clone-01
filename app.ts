// app.ts — the forge's HTTP server: routing, bearer auth, the REST v3
// surface and the git smart-HTTP surface. GraphQL (graphql.ts) and MCP
// (mcp.ts) are delegated to with the same store.
//
// Every response carries an X-GitHub-Request-Id; every error is a JSON body
// with a string `message`, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  buildCommit,
  buildTreeFromFlat,
  commitsInOrder,
  flattenTree,
  formatIdentity,
  isAncestor,
  isOid,
  mergeBase,
  parseCommit,
  parseIdentity,
  parseTree,
  peelToCommit,
  pktDelim,
  pktFlush,
  pktLine,
  PktReader,
  planFetch,
  readPack,
  sidebandPackets,
  storeObject,
  threeWayMergeTrees,
  writePack,
  type GitObject,
} from './git.ts';
import {
  Store,
  markMerged,
  performSquashMerge,
  pullFiles,
  type CommentRec,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface Surface {
  store: Store;
  /** Base URL the harness dials (http://host), for absolute URLs in bodies and Link headers. */
  base: string;
  sendJson: (status: number, body: unknown, headers?: Readonly<Record<string, string>>) => void;
  sendRaw: (status: number, body: Buffer, contentType: string, headers?: Readonly<Record<string, string>>) => void;
}

/** The bearer rule: the token is the process's MAKEFUN_SHOP_TOKEN; no token is always a 401. */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (expected !== '') return header === `Bearer ${expected}`;
  return header.startsWith('Bearer ') && header.length > 'Bearer '.length;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function intParam(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

/** Slice a list by GitHub-style page/per_page query parameters. */
function paginate<T>(items: readonly T[], url: URL): T[] {
  const perPage = intParam(url.searchParams.get('per_page'), 30, 1, 100);
  const page = intParam(url.searchParams.get('page'), 1, 1, 1000000);
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---------------------------------------------------------------- rendering

function userJson(surface: Surface): Record<string, unknown> {
  const { store } = surface;
  return {
    login: store.viewerLogin,
    id: store.viewerId,
    type: 'User',
    site_admin: false,
    avatar_url: `${surface.base}/avatars/${store.viewerId}`,
    html_url: `${surface.base}/${store.viewerLogin ?? ''}`,
    url: `${surface.base}/api/v3/users/${store.viewerLogin ?? ''}`,
  };
}

function repoJson(surface: Surface, repo: RepoRec): Record<string, unknown> {
  const { store } = surface;
  const owner = store.viewerLogin ?? '';
  const fullName = `${owner}/${repo.name}`;
  return {
    id: repo.id,
    node_id: `R_${repo.id}`,
    name: repo.name,
    full_name: fullName,
    owner: userJson(surface),
    private: repo.private,
    description: repo.description,
    fork: false,
    homepage: null,
    language: null,
    topics: [],
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pull_requests: true,
    archived: false,
    disabled: false,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    size: 0,
    created_at: store.isoOf(repo.seq),
    updated_at: store.isoOf(repo.seq),
    pushed_at: store.isoOf(repo.seq),
    html_url: `${surface.base}/${fullName}`,
    url: `${surface.base}/api/v3/repos/${fullName}`,
    clone_url: `${surface.base}/${fullName}.git`,
    git_url: `git://${surface.base.replace(/^https?:\/\//, '')}/${fullName}.git`,
    ssh_url: `git@forge:${fullName}.git`,
  };
}

function labelJson(repo: RepoRec, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label ? [...repo.labels.keys()].indexOf(name) + 1 : 0,
    name,
    color: label?.color ?? 'ededed',
    description: label?.description ?? null,
    default: false,
  };
}

function issueJson(surface: Surface, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const { store } = surface;
  return {
    id: issue.id,
    node_id: `I_${issue.id}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(surface),
    assignees: [],
    comments: issue.comments.length,
    locked: false,
    created_at: store.isoOf(issue.seq),
    updated_at: store.isoOf(issue.closedSeq ?? issue.seq),
    closed_at: issue.closedSeq === null ? null : store.isoOf(issue.closedSeq),
    url: `${surface.base}/api/v3/repos/${store.viewerLogin ?? ''}/${repo.name}/issues/${issue.number}`,
    html_url: `${surface.base}/${store.viewerLogin ?? ''}/${repo.name}/issues/${issue.number}`,
    repository_url: `${surface.base}/api/v3/repos/${store.viewerLogin ?? ''}/${repo.name}`,
  };
}

function commentJson(surface: Surface, repo: RepoRec, comment: CommentRec): Record<string, unknown> {
  const { store } = surface;
  return {
    id: comment.id,
    node_id: `IC_${comment.id}`,
    body: comment.body,
    user: userJson(surface),
    created_at: store.isoOf(comment.seq),
    updated_at: store.isoOf(comment.seq),
    html_url: `${surface.base}/${store.viewerLogin ?? ''}/${repo.name}#issuecomment-${comment.id}`,
    url: `${surface.base}/api/v3/repos/${store.viewerLogin ?? ''}/${repo.name}/issues/comments/${comment.id}`,
  };
}

function pullJson(surface: Surface, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const { store } = surface;
  const owner = store.viewerLogin ?? '';
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.headSha;
  const baseSha = store.branchTip(repo, pull.baseRef) ?? pull.baseSha;
  const side = (ref: string, sha: string) => ({
    label: `${owner}:${ref}`,
    ref,
    sha,
    user: userJson(surface),
    repo: repoJson(surface, repo),
  });
  return {
    id: pull.id,
    node_id: `PR_${pull.id}`,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : store.isoOf(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    locked: false,
    user: userJson(surface),
    head: side(pull.headRef, headSha),
    base: side(pull.baseRef, baseSha),
    comments: pull.comments.length,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
    created_at: store.isoOf(pull.seq),
    updated_at: store.isoOf(pull.mergedSeq ?? pull.seq),
    closed_at: pull.state === 'closed' ? store.isoOf(pull.mergedSeq ?? pull.seq) : null,
    url: `${surface.base}/api/v3/repos/${owner}/${repo.name}/pulls/${pull.number}`,
    html_url: `${surface.base}/${owner}/${repo.name}/pull/${pull.number}`,
    diff_url: `${surface.base}/${owner}/${repo.name}/pull/${pull.number}.diff`,
    patch_url: `${surface.base}/${owner}/${repo.name}/pull/${pull.number}.patch`,
  };
}

function commitJson(surface: Surface, repo: RepoRec, oid: string): Record<string, unknown> | null {
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  const renderIdentity = (line: string) => {
    const parsed = parseIdentity(line);
    return { name: parsed.name, email: parsed.email, date: new Date(parsed.timestamp * 1000).toISOString() };
  };
  const owner = surface.store.viewerLogin ?? '';
  return {
    sha: oid,
    node_id: `C_${oid}`,
    commit: {
      author: renderIdentity(info.author),
      committer: renderIdentity(info.committer),
      message: info.message,
      tree: { sha: info.tree, url: `${surface.base}/api/v3/repos/${owner}/${repo.name}/git/trees/${info.tree}` },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: info.parents.map((sha) => ({ sha, url: `${surface.base}/api/v3/repos/${owner}/${repo.name}/commits/${sha}` })),
    url: `${surface.base}/api/v3/repos/${owner}/${repo.name}/commits/${oid}`,
    html_url: `${surface.base}/${owner}/${repo.name}/commit/${oid}`,
  };
}

// ---------------------------------------------------------------- REST helpers

type RestHandler = (surface: Surface, params: Record<string, string>, body: Record<string, unknown>, url: URL) => void;

function notFound(surface: Surface): void {
  surface.sendJson(404, { message: 'Not Found' });
}

function validationFailed(surface: Surface, detail?: string): void {
  surface.sendJson(422, { message: detail ? `Validation Failed: ${detail}` : 'Validation Failed' });
}

/** Resolve a ref-ish value (branch name, full ref, tag name, or object id) to an object id. */
function resolveRef(repo: RepoRec, ref: string): string | null {
  if (repo.refs.has(`refs/heads/${ref}`)) return repo.refs.get(`refs/heads/${ref}`)!;
  if (repo.refs.has(ref)) return repo.refs.get(ref)!;
  if (repo.refs.has(`refs/tags/${ref}`)) return repo.refs.get(`refs/tags/${ref}`)!;
  if (isOid(ref) && repo.objects.has(ref)) return ref;
  return null;
}

/** The commit a contents/commits request starts from: a ref parameter or the default branch tip. */
function startCommit(repo: RepoRec, refParam: string | null): string | null {
  const oid = refParam ? resolveRef(repo, refParam) : repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (oid === null) return null;
  return peelToCommit(repo.objects, oid);
}

const REPO_NAME_OK = /^[A-Za-z0-9._-]+$/;

// ---------------------------------------------------------------- the server

export function createApp(store: Store = new Store()): Server {
  const packCache = new Map<string, Buffer>();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const requestId = store.nextRequestId();
      const host = req.headers.host ?? '127.0.0.1';
      const surface: Surface = {
        store,
        base: `http://${host}`,
        sendJson: (status, body, headers = {}) => {
          const text = `${JSON.stringify(body)}\n`;
          res.writeHead(status, {
            'content-type': JSON_TYPE,
            'content-length': Buffer.byteLength(text),
            'x-github-request-id': requestId,
            ...headers,
          });
          res.end(text);
        },
        sendRaw: (status, body, contentType, headers = {}) => {
          res.writeHead(status, {
            'content-type': contentType,
            'content-length': body.length,
            'x-github-request-id': requestId,
            ...headers,
          });
          res.end(body);
        },
      };
      try {
        const body = await readBody(req);
        route(surface, req, body, packCache);
      } catch (err) {
        // A handler failure must never take the process down: answer 500 and keep serving.
        if (!res.headersSent) {
          surface.sendJson(500, { message: `Internal error: ${err instanceof Error ? err.message : String(err)}` });
        } else if (!res.writableEnded) {
          res.end();
        }
      }
    })();
  });
  return server;
}

function route(surface: Surface, req: IncomingMessage, body: Buffer, packCache: Map<string, Buffer>): void {
  const { store } = surface;
  const method = req.method ?? 'GET';
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://entry');
  } catch {
    surface.sendJson(400, { message: 'Bad Request' });
    return;
  }
  const path = url.pathname;

  if (method === 'GET' && path === '/healthz') {
    surface.sendJson(200, { ok: true });
    return;
  }

  if (path === '/mcp') {
    if (!authorized(req)) {
      surface.sendJson(401, { message: 'Bad credentials' });
      return;
    }
    handleMcp(surface, method, body);
    return;
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') return notFound(surface);
    if (!authorized(req)) {
      surface.sendJson(401, { message: 'Bad credentials' });
      return;
    }
    handleGraphql(surface, body);
    return;
  }

  if (path === '/api/v3' || path.startsWith('/api/v3/')) {
    if (!authorized(req)) {
      surface.sendJson(401, { message: 'Bad credentials' });
      return;
    }
    restRoute(surface, method, path, url, body);
    return;
  }

  const gitMatch = /^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/.exec(path);
  if (gitMatch) {
    if (!authorized(req)) {
      surface.sendJson(401, { message: 'Bad credentials' });
      return;
    }
    gitRoute(surface, req, method, url, body, packCache, decodeSegment(gitMatch[1]), decodeSegment(gitMatch[2]), gitMatch[3] ?? '');
    return;
  }

  notFound(surface);
}

// ---------------------------------------------------------------- REST v3

function restRoute(surface: Surface, method: string, path: string, url: URL, rawBody: Buffer): void {
  const { store } = surface;
  const segments = path.split('/').filter((s) => s !== '').slice(2).map(decodeSegment); // after /api/v3

  // Body-bearing methods must carry a JSON object; malformed JSON is a 400.
  let body: Record<string, unknown> = {};
  if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && rawBody.length > 0) {
    try {
      const parsed: unknown = JSON.parse(rawBody.toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      surface.sendJson(400, { message: 'Problems parsing JSON' });
      return;
    }
  }

  if (segments.length === 0) {
    if (method === 'GET') {
      surface.sendJson(
        200,
        {
          current_user_url: `${surface.base}/api/v3/user`,
          current_user_repositories_url: `${surface.base}/api/v3/user/repos`,
          rate_limit_url: `${surface.base}/api/v3/rate_limit`,
          repository_url: `${surface.base}/api/v3/repos/{owner}/{repo}`,
          issue_search_url: `${surface.base}/api/v3/search/issues`,
        },
        { 'x-oauth-scopes': 'repo, read:org' },
      );
      return;
    }
    return notFound(surface);
  }

  if (segments[0] === 'meta' && segments.length === 1 && method === 'GET') {
    surface.sendJson(200, {
      verifiable_password_authentication: false,
      ssh_key_fingerprints: {},
      installed_version: '1.0.0',
      github_services_sha: 'forge',
    });
    return;
  }

  if (segments[0] === 'user' && segments.length === 1 && method === 'GET') {
    if (store.viewerLogin === null) return notFound(surface);
    surface.sendJson(200, userJson(surface));
    return;
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') return listUserRepos(surface, url);
    if (method === 'POST') return createUserRepo(surface, body);
    return notFound(surface);
  }

  if (segments[0] === 'users' && segments[2] === 'repos' && segments.length === 3 && method === 'GET') {
    if (store.viewerLogin !== null && segments[1] !== store.viewerLogin) {
      surface.sendJson(200, []);
      return;
    }
    return listUserRepos(surface, url);
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = store.repoFor(segments[1], segments[2]);
    if (!repo) return notFound(surface);
    return repoRoute(surface, method, repo, segments.slice(3), url, body);
  }

  notFound(surface);
}

function listUserRepos(surface: Surface, url: URL): void {
  const all = [...surface.store.repos.values()].sort((a, b) => a.id - b.id);
  const perPage = intParam(url.searchParams.get('per_page'), 30, 1, 100);
  const page = intParam(url.searchParams.get('page'), 1, 1, 1000000);
  const slice = all.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (page * perPage < all.length) {
    const lastPage = Math.ceil(all.length / perPage);
    const link = (p: number, rel: string) => `<${surface.base}/api/v3/user/repos?per_page=${perPage}&page=${p}>; rel="${rel}"`;
    headers.link = `${link(page + 1, 'next')}, ${link(lastPage, 'last')}`;
  }
  surface.sendJson(200, slice.map((repo) => repoJson(surface, repo)), headers);
}

function createUserRepo(surface: Surface, body: Record<string, unknown>): void {
  const { store } = surface;
  const name = typeof body.name === 'string' ? body.name : '';
  if (name === '' || name === '.' || name === '..' || !REPO_NAME_OK.test(name)) {
    return validationFailed(surface, 'name is invalid');
  }
  if (store.repos.has(name)) {
    surface.sendJson(422, { message: 'name already exists on this account' });
    return;
  }
  const repo = store.createRepo(name, {
    description: typeof body.description === 'string' ? body.description : null,
    private: body.private === true,
    defaultBranch: typeof body.default_branch === 'string' ? body.default_branch : undefined,
  });
  surface.sendJson(201, repoJson(surface, repo));
}

function repoRoute(
  surface: Surface,
  method: string,
  repo: RepoRec,
  rest: string[],
  url: URL,
  body: Record<string, unknown>,
): void {
  const { store } = surface;

  if (rest.length === 0) {
    if (method === 'GET') {
      surface.sendJson(200, repoJson(surface, repo));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.name === 'string' && body.name !== repo.name) {
        if (!REPO_NAME_OK.test(body.name) || store.repos.has(body.name)) return validationFailed(surface, 'name is invalid');
        store.repos.delete(repo.name);
        repo.name = body.name;
        store.repos.set(repo.name, repo);
      }
      if ('description' in body) repo.description = typeof body.description === 'string' ? body.description : null;
      if (typeof body.private === 'boolean') repo.private = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') repo.defaultBranch = body.default_branch;
      surface.sendJson(200, repoJson(surface, repo));
      return;
    }
    if (method === 'DELETE') {
      store.deleteRepo(repo);
      surface.sendRaw(204, Buffer.alloc(0), JSON_TYPE);
      return;
    }
    return notFound(surface);
  }

  if (rest[0] === 'contents') return contentsRoute(surface, method, repo, rest.slice(1).join('/'), url, body);
  if (rest[0] === 'issues') return issuesRoute(surface, method, repo, rest.slice(1), url, body);
  if (rest[0] === 'labels') return labelsRoute(surface, method, repo, rest.slice(1), body);
  if (rest[0] === 'pulls') return pullsRoute(surface, method, repo, rest.slice(1), url, body);
  if (rest[0] === 'branches') return branchesRoute(surface, method, repo, rest.slice(1));
  if (rest[0] === 'commits') return commitsRoute(surface, method, repo, rest.slice(1), url);
  if (rest[0] === 'git') return gitRestRoute(surface, method, repo, rest.slice(1), body);

  notFound(surface);
}

// ---------------------------------------------------------------- contents API
//
// Contents writes are real git commits on the target branch: the branch
// tip's tree is flattened, the path is set or removed, trees are rebuilt
// and a commit with the caller's message (verbatim) becomes the new tip.

function contentsRoute(
  surface: Surface,
  method: string,
  repo: RepoRec,
  rawPath: string,
  url: URL,
  body: Record<string, unknown>,
): void {
  const { store } = surface;
  const path = rawPath.split('/').map(decodeSegment).filter((s) => s !== '').join('/');

  if (method === 'GET') {
    const commitOid = startCommit(repo, url.searchParams.get('ref'));
    if (commitOid === null) return notFound(surface);
    const commit = parseCommit(repo.objects.get(commitOid)!.data);
    if (path === '') {
      surface.sendJson(200, dirListing(surface, repo, commit.tree, ''));
      return;
    }
    const flat = flattenTree(repo.objects, commit.tree);
    const entry = flat.get(path);
    if (entry) {
      const blob = repo.objects.get(entry.oid);
      if (!blob) return notFound(surface);
      surface.sendJson(200, {
        type: 'file',
        encoding: 'base64',
        name: path.split('/').pop(),
        path,
        sha: entry.oid,
        size: blob.data.length,
        content: blob.data.toString('base64'),
        url: `${surface.base}/api/v3/repos/${store.viewerLogin ?? ''}/${repo.name}/contents/${path}`,
        html_url: `${surface.base}/${store.viewerLogin ?? ''}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
        download_url: null,
      });
      return;
    }
    // A directory: the entries directly under path/.
    const prefix = `${path}/`;
    const isDir = [...flat.keys()].some((key) => key.startsWith(prefix));
    if (!isDir) return notFound(surface);
    const subTree = subtreeAt(repo, commit.tree, path);
    if (subTree === null) return notFound(surface);
    surface.sendJson(200, dirListing(surface, repo, subTree, prefix));
    return;
  }

  if (method === 'PUT' || method === 'DELETE') {
    if (path === '') return validationFailed(surface, 'path is required');
    const message = typeof body.message === 'string' ? body.message : null;
    if (message === null) return validationFailed(surface, 'message is required');
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const refName = `refs/heads/${branch}`;
    const tip = repo.refs.get(refName) ?? null;
    const flat = tip === null
      ? new Map<string, { oid: string; mode: string }>()
      : flattenTree(repo.objects, parseCommit(repo.objects.get(tip)!.data).tree);
    const existing = flat.get(path);

    if (method === 'PUT') {
      if (typeof body.content !== 'string') return validationFailed(surface, 'content is required');
      if (existing && body.sha !== existing.oid) {
        surface.sendJson(409, { message: `sha does not match the current blob for ${path}` });
        return;
      }
      const data = Buffer.from(body.content.replace(/\s+/g, ''), 'base64');
      const blobOid = storeObject(repo.objects, 'blob', data);
      flat.set(path, { oid: blobOid, mode: '100644' });
      const commitOid = commitTreeChange(surface, repo, refName, tip, flat, message);
      surface.sendJson(existing ? 200 : 201, {
        content: {
          type: 'file',
          encoding: 'base64',
          name: path.split('/').pop(),
          path,
          sha: blobOid,
          size: data.length,
          content: data.toString('base64'),
          url: `${surface.base}/api/v3/repos/${store.viewerLogin ?? ''}/${repo.name}/contents/${path}`,
          html_url: `${surface.base}/${store.viewerLogin ?? ''}/${repo.name}/blob/${branch}/${path}`,
          download_url: null,
        },
        commit: commitSummary(surface, repo, commitOid),
      });
      return;
    }

    // DELETE
    if (!existing) return notFound(surface);
    if (body.sha !== existing.oid) {
      surface.sendJson(409, { message: `sha does not match the current blob for ${path}` });
      return;
    }
    flat.delete(path);
    const commitOid = commitTreeChange(surface, repo, refName, tip, flat, message);
    surface.sendJson(200, { content: null, commit: commitSummary(surface, repo, commitOid) });
    return;
  }

  notFound(surface);
}

/** The tree id at a directory path inside a root tree, or null when absent. */
function subtreeAt(repo: RepoRec, rootTree: string, dirPath: string): string | null {
  let current = rootTree;
  for (const segment of dirPath.split('/')) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segment && e.mode === '40000');
    if (!entry) return null;
    current = entry.oid;
  }
  return current;
}

function dirListing(surface: Surface, repo: RepoRec, treeOid: string, prefix: string): Record<string, unknown>[] {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const owner = surface.store.viewerLogin ?? '';
  return parseTree(obj.data)
    .map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: `${prefix}${entry.name}`,
      sha: entry.oid,
      size: 0,
      url: `${surface.base}/api/v3/repos/${owner}/${repo.name}/contents/${prefix}${entry.name}`,
      html_url: `${surface.base}/${owner}/${repo.name}/blob/${repo.defaultBranch}/${prefix}${entry.name}`,
      download_url: null,
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Commit a flattened tree as the new tip of a branch; returns the commit id. */
function commitTreeChange(
  surface: Surface,
  repo: RepoRec,
  refName: string,
  tip: string | null,
  flat: ReadonlyMap<string, { oid: string; mode: string }>,
  message: string,
): string {
  const { store } = surface;
  const tree = buildTreeFromFlat(repo.objects, flat);
  const seq = store.tick();
  const identity = formatIdentity('forge', 'forge@localhost', store.epochOf(seq));
  const commit = buildCommit({
    tree,
    parents: tip === null ? [] : [tip],
    author: identity,
    committer: identity,
    message,
  });
  const commitOid = storeObject(repo.objects, 'commit', commit);
  repo.refs.set(refName, commitOid);
  return commitOid;
}

function commitSummary(surface: Surface, repo: RepoRec, oid: string): Record<string, unknown> {
  const rendered = commitJson(surface, repo, oid);
  if (rendered === null) return { sha: oid };
  const commit = rendered.commit as Record<string, unknown>;
  return {
    sha: oid,
    node_id: rendered.node_id,
    author: commit.author,
    committer: commit.committer,
    message: commit.message,
    tree: commit.tree,
    parents: rendered.parents,
    url: rendered.url,
    html_url: rendered.html_url,
  };
}

// ---------------------------------------------------------------- labels

function labelsRoute(surface: Surface, method: string, repo: RepoRec, rest: string[], body: Record<string, unknown>): void {
  if (rest.length === 0) {
    if (method === 'GET') {
      surface.sendJson(200, [...repo.labels.keys()].sort().map((name) => labelJson(repo, name)));
      return;
    }
    if (method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return validationFailed(surface, 'name is required');
      if (repo.labels.has(name)) return validationFailed(surface, 'name has already been taken');
      const color = (typeof body.color === 'string' ? body.color : 'ededed').replace(/^#/, '');
      repo.labels.set(name, { name, color, description: typeof body.description === 'string' ? body.description : '' });
      surface.sendJson(201, labelJson(repo, name));
      return;
    }
    return notFound(surface);
  }
  if (rest.length === 1 && method === 'GET') {
    if (!repo.labels.has(rest[0])) return notFound(surface);
    surface.sendJson(200, labelJson(repo, rest[0]));
    return;
  }
  notFound(surface);
}

// ---------------------------------------------------------------- issues

function labelNamesOf(surface: Surface, repo: RepoRec, raw: unknown): string[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const names: string[] = [];
  for (const item of raw) {
    const name = typeof item === 'string' ? item : (item as { name?: unknown })?.name;
    if (typeof name !== 'string' || !repo.labels.has(name)) {
      validationFailed(surface, `label ${JSON.stringify(name)} does not exist`);
      return null;
    }
    names.push(name);
  }
  return names;
}

function issuesRoute(
  surface: Surface,
  method: string,
  repo: RepoRec,
  rest: string[],
  url: URL,
  body: Record<string, unknown>,
): void {
  const { store } = surface;

  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return validationFailed(surface, 'title is required');
      const labels = labelNamesOf(surface, repo, body.labels);
      if (labels === null) return;
      const issue = store.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
      surface.sendJson(201, issueJson(surface, repo, issue));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      const direction = url.searchParams.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      surface.sendJson(200, paginate(issues, url).map((issue) => issueJson(surface, repo, issue)));
      return;
    }
    return notFound(surface);
  }

  const number = Number.parseInt(rest[0], 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;

  if (rest.length === 2 && rest[1] === 'comments') {
    const target = issue ?? pull;
    if (!target) return notFound(surface);
    if (method === 'GET') {
      const comments = [...target.comments].sort((a, b) => a.seq - b.seq);
      surface.sendJson(200, comments.map((comment) => commentJson(surface, repo, comment)));
      return;
    }
    if (method === 'POST') {
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return validationFailed(surface, 'body is required');
      const comment = store.addComment(target, text);
      surface.sendJson(201, commentJson(surface, repo, comment));
      return;
    }
    return notFound(surface);
  }

  if (rest.length === 1) {
    if (!issue) return notFound(surface);
    if (method === 'GET') {
      surface.sendJson(200, issueJson(surface, repo, issue));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (body.labels !== undefined) {
        const labels = labelNamesOf(surface, repo, body.labels);
        if (labels === null) return;
        issue.labels = labels;
      }
      if (body.state === 'closed' && issue.state === 'open') {
        issue.state = 'closed';
        issue.closedSeq = store.tick();
      } else if (body.state === 'open' && issue.state === 'closed') {
        issue.state = 'open';
        issue.closedSeq = null;
      }
      surface.sendJson(200, issueJson(surface, repo, issue));
      return;
    }
    return notFound(surface);
  }

  notFound(surface);
}

// ---------------------------------------------------------------- pull requests

function pullsRoute(
  surface: Surface,
  method: string,
  repo: RepoRec,
  rest: string[],
  url: URL,
  body: Record<string, unknown>,
): void {
  const { store } = surface;

  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      if (title === '') return validationFailed(surface, 'title is required');
      const headTip = store.branchTip(repo, head);
      const baseTip = store.branchTip(repo, base);
      if (headTip === null || baseTip === null || head === base) {
        return validationFailed(surface, 'head and base must be existing, different branches');
      }
      const duplicate = [...repo.pulls.values()].some(
        (pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base,
      );
      if (duplicate) return validationFailed(surface, 'a pull request already exists for this head and base');
      const pull = store.createPull(repo, {
        title,
        body: typeof body.body === 'string' ? body.body : '',
        headRef: head,
        baseRef: base,
        headSha: headTip,
        baseSha: baseTip,
      });
      surface.sendJson(201, pullJson(surface, repo, pull));
      return;
    }
    if (method === 'GET') {
      const state = url.searchParams.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.seq - a.seq);
      surface.sendJson(200, paginate(pulls, url).map((pull) => pullJson(surface, repo, pull)));
      return;
    }
    return notFound(surface);
  }

  const number = Number.parseInt(rest[0], 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (!pull) return notFound(surface);

  if (rest.length === 1) {
    if (method === 'GET') {
      surface.sendJson(200, pullJson(surface, repo, pull));
      return;
    }
    if (method === 'PATCH') {
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      if (body.state === 'closed') pull.state = 'closed';
      if (body.state === 'open' && !pull.merged) pull.state = 'open';
      surface.sendJson(200, pullJson(surface, repo, pull));
      return;
    }
    return notFound(surface);
  }

  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    surface.sendJson(200, pullFiles(repo, pull).map((file) => ({ ...file })));
    return;
  }

  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (pull.merged) {
      surface.sendJson(200, { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' });
      return;
    }
    if (pull.state === 'closed') {
      surface.sendJson(405, { message: 'Pull Request is not mergeable' });
      return;
    }
    const sha = performSquashMerge(store, repo, pull);
    if (sha === null) {
      surface.sendJson(405, { message: 'Pull Request is not mergeable' });
      return;
    }
    markMerged(store, pull, sha);
    surface.sendJson(200, { sha, merged: true, message: 'Pull Request successfully merged' });
    return;
  }

  notFound(surface);
}

// ---------------------------------------------------------------- branches, commits, git REST

function branchesRoute(surface: Surface, method: string, repo: RepoRec, rest: string[]): void {
  if (method !== 'GET') return notFound(surface);
  if (rest.length === 0) {
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    surface.sendJson(200, branches);
    return;
  }
  const name = rest.join('/');
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (!sha) return notFound(surface);
  surface.sendJson(200, {
    name,
    commit: { sha, url: `${surface.base}/api/v3/repos/${surface.store.viewerLogin ?? ''}/${repo.name}/commits/${sha}` },
    protected: false,
  });
}

function commitsRoute(surface: Surface, method: string, repo: RepoRec, rest: string[], url: URL): void {
  if (method !== 'GET') return notFound(surface);
  if (rest.length === 1) {
    const rendered = commitJson(surface, repo, rest[0]);
    if (rendered === null) return notFound(surface);
    surface.sendJson(200, rendered);
    return;
  }
  if (rest.length === 0) {
    const tip = startCommit(repo, url.searchParams.get('sha'));
    if (tip === null) {
      surface.sendJson(200, []);
      return;
    }
    const oids = commitsInOrder(repo.objects, tip);
    const rendered = paginate(oids, url)
      .map((oid) => commitJson(surface, repo, oid))
      .filter((entry) => entry !== null);
    surface.sendJson(200, rendered);
    return;
  }
  notFound(surface);
}

function gitRestRoute(surface: Surface, method: string, repo: RepoRec, rest: string[], body: Record<string, unknown>): void {
  if (rest[0] === 'refs') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const refs = [...repo.refs.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([ref, sha]) => ({ ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } }));
        surface.sendJson(200, refs);
        return;
      }
      if (method === 'POST') {
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
          return validationFailed(surface, 'ref and sha must name an existing object');
        }
        if (repo.refs.has(ref)) return validationFailed(surface, 'reference already exists');
        repo.refs.set(ref, sha);
        surface.sendJson(201, { ref, object: { sha, type: repo.objects.get(sha)!.type } });
        return;
      }
      return notFound(surface);
    }
    if (method === 'GET') {
      const joined = rest.slice(1).join('/');
      const full = joined.startsWith('refs/') ? joined : `refs/${joined}`;
      const sha = repo.refs.get(full);
      if (!sha) return notFound(surface);
      surface.sendJson(200, { ref: full, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      return;
    }
    return notFound(surface);
  }
  if (rest[0] === 'commits' && rest.length === 2 && method === 'GET') {
    const obj = repo.objects.get(rest[1]);
    if (!obj || obj.type !== 'commit') return notFound(surface);
    const info = parseCommit(obj.data);
    const renderIdentity = (line: string) => {
      const parsed = parseIdentity(line);
      return { name: parsed.name, email: parsed.email, date: new Date(parsed.timestamp * 1000).toISOString() };
    };
    surface.sendJson(200, {
      sha: rest[1],
      author: renderIdentity(info.author),
      committer: renderIdentity(info.committer),
      message: info.message,
      tree: { sha: info.tree },
      parents: info.parents.map((sha) => ({ sha })),
    });
    return;
  }
  notFound(surface);
}

// ---------------------------------------------------------------- git smart HTTP
//
// Advertisements: v2 when the client sends `Git-Protocol: version=2` (for
// upload-pack), v0 otherwise and always for receive-pack. Fetch is served
// from planFetch (git.ts); receive-pack is v0 with report-status.

const UPLOAD_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=forge/1.0';
const RECEIVE_CAPS_V0 = 'report-status delete-refs side-band-64k quiet ofs-delta agent=forge/1.0';

function gitRoute(
  surface: Surface,
  req: IncomingMessage,
  method: string,
  url: URL,
  body: Buffer,
  packCache: Map<string, Buffer>,
  owner: string,
  repoName: string,
  sub: string,
): void {
  const { store } = surface;
  const repo = store.repoFor(owner, repoName);
  if (!repo) return notFound(surface);

  if (sub === 'info/refs' && method === 'GET') {
    const service = url.searchParams.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      surface.sendJson(400, { message: 'invalid service' });
      return;
    }
    const isUpload = service === 'git-upload-pack';
    const wantsV2 = isUpload && (req.headers['git-protocol'] ?? '').includes('version=2');
    if (wantsV2) {
      const advertisement = Buffer.concat([
        pktLine('# service=git-upload-pack\n'),
        pktFlush(),
        pktLine('version 2\n'),
        pktLine('agent=forge/1.0\n'),
        pktLine('ls-refs=unborn\n'),
        pktLine('fetch=shallow\n'),
        pktLine('object-format=sha1\n'),
        pktFlush(),
      ]);
      surface.sendRaw(200, advertisement, 'application/x-git-upload-pack-advertisement');
      return;
    }
    surface.sendRaw(
      200,
      v0Advertisement(surface, repo, isUpload),
      isUpload ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement',
    );
    return;
  }

  if (sub === 'git-upload-pack' && method === 'POST') {
    try {
      uploadPack(surface, repo, body, packCache);
    } catch {
      surface.sendRaw(400, Buffer.from('bad upload-pack request\n'), 'text/plain; charset=utf-8');
    }
    return;
  }

  if (sub === 'git-receive-pack' && method === 'POST') {
    try {
      receivePack(surface, repo, body);
    } catch {
      surface.sendRaw(400, Buffer.from('bad receive-pack request\n'), 'text/plain; charset=utf-8');
    }
    return;
  }

  notFound(surface);
}

/** Sorted ref lines for an advertisement or listing, tags peeled to their commit in `peeled`. */
function sortedRefs(repo: RepoRec): Array<{ ref: string; oid: string; peeled: string | null }> {
  return [...repo.refs.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([ref, oid]) => {
      const obj = repo.objects.get(oid);
      let peeled: string | null = null;
      if (obj && obj.type === 'tag') peeled = peelToCommit(repo.objects, oid);
      return { ref, oid, peeled };
    });
}

function v0Advertisement(surface: Surface, repo: RepoRec, isUpload: boolean): Buffer {
  const headRef = surface.store.headRefOf(repo);
  const headOid = repo.refs.get(headRef) ?? null;
  const caps = isUpload ? `${UPLOAD_CAPS_V0} symref=HEAD:${headRef}` : RECEIVE_CAPS_V0;
  const lines: Buffer[] = [pktLine(`# service=${isUpload ? 'git-upload-pack' : 'git-receive-pack'}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    lines.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}`));
  } else {
    // The first ref line carries the capabilities after a NUL, and unlike
    // the following lines it has no trailing newline before that NUL.
    let first = true;
    const emit = (text: string) => {
      lines.push(pktLine(first ? `${text}\0${caps}` : `${text}\n`));
      first = false;
    };
    if (isUpload && headOid !== null) emit(`${headOid} HEAD`);
    for (const entry of refs) {
      emit(`${entry.oid} ${entry.ref}`);
      if (entry.peeled !== null && entry.peeled !== entry.oid) emit(`${entry.peeled} ${entry.ref}^{}`);
    }
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

/** Read pkt-line data payloads until a flush; returns the lines and the reader (for the pack tail). */
function readPktLines(reader: PktReader): { lines: string[]; flushed: boolean } {
  const lines: string[] = [];
  for (;;) {
    const packet = reader.next();
    if (packet === null) return { lines, flushed: false };
    if (packet.kind === 'flush') return { lines, flushed: true };
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8'));
    // delim / response-end inside a command stream simply mark boundaries; keep reading.
  }
}

function uploadPack(surface: Surface, repo: RepoRec, body: Buffer, packCache: Map<string, Buffer>): void {
  const reader = new PktReader(body);
  const first = reader.next();
  if (first === null || first.kind !== 'data') throw new Error('empty upload-pack request');
  const firstLine = first.payload.toString('utf8').replace(/\n$/, '');

  if (firstLine === 'command=ls-refs') {
    const { lines } = readPktLines(reader);
    lsRefs(surface, repo, lines);
    return;
  }
  if (firstLine === 'command=fetch') {
    const { lines } = readPktLines(reader);
    fetchV2(surface, repo, lines, packCache);
    return;
  }
  if (firstLine.startsWith('want ') || firstLine.startsWith('want-')) {
    // v0 fetch: the first line was a want; gather the rest of the want section, then negotiation.
    const wantsSection = readPktLines(reader);
    const negotiation = readPktLines(reader);
    fetchV0(surface, repo, [firstLine, ...wantsSection.lines], negotiation.lines, packCache);
    return;
  }
  throw new Error(`unknown upload-pack command: ${firstLine.slice(0, 40)}`);
}

function lsRefs(surface: Surface, repo: RepoRec, lines: string[]): void {
  // Lines after the command: capability lines, a delim, then arguments. The
  // reader flattened the delim away, so arguments are recognized by shape.
  let peel = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'unborn') unborn = true;
    else if (line === 'symrefs') {
      // symref attributes are always emitted for HEAD below
    } else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));

  const out: string[] = [];
  const headRef = surface.store.headRefOf(repo);
  const headOid = repo.refs.get(headRef) ?? null;
  if (matches('HEAD')) {
    if (headOid !== null) out.push(`${headOid} HEAD symref-target:${headRef}`);
    else if (unborn) out.push(`unborn HEAD symref-target:${headRef}`);
  }
  for (const entry of sortedRefs(repo)) {
    if (!matches(entry.ref)) continue;
    let line = `${entry.oid} ${entry.ref}`;
    if (peel && entry.peeled !== null && entry.peeled !== entry.oid) line += ` peeled:${entry.peeled}`;
    out.push(line);
  }
  const body = Buffer.concat([...out.map((line) => pktLine(`${line}\n`)), pktFlush()]);
  surface.sendRaw(200, body, 'application/x-git-upload-pack-result');
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(lines: string[], firstWantLine?: string): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  const all = firstWantLine !== undefined ? [firstWantLine, ...lines] : lines;
  for (const raw of all) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7), 10);
    else if (line === 'done') args.done = true;
    // thin-pack / no-progress / ofs-delta / include-tag / deepen-* / filter: accepted, no effect.
  }
  return args;
}

/** The pack for a fetch, cached by the full request key (packs are content-derived and immutable). */
function fetchPack(repo: RepoRec, args: FetchArgs, packCache: Map<string, Buffer>): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = [repo.id, repo.objects.size, args.wants.join(','), args.haves.join(','), args.shallow.join(','), args.depth ?? ''].join('|');
  const plan = planFetch(repo.objects, args.wants, args.haves, args.shallow, args.depth);
  let pack = packCache.get(key);
  if (!pack) {
    pack = writePack(plan.send.map((oid) => repo.objects.get(oid)).filter((obj): obj is GitObject => obj !== undefined));
    if (packCache.size > 128) packCache.clear();
    packCache.set(key, pack);
  }
  return { pack, shallow: plan.shallow, unshallow: plan.unshallow };
}

function fetchV2(surface: Surface, repo: RepoRec, lines: string[], packCache: Map<string, Buffer>): void {
  const args = parseFetchArgs(lines);
  const { pack, shallow, unshallow } = fetchPack(repo, args, packCache);
  const parts: Buffer[] = [];

  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const existing = args.haves.filter((have) => repo.objects.has(have));
    if (existing.length === 0) {
      parts.push(pktLine('NAK\n'));
    } else {
      for (const have of existing) parts.push(pktLine(`ACK ${have} common\n`));
      if (args.done) parts.push(pktLine('ready\n'));
    }
    if (args.done) parts.push(pktDelim());
  }

  if (args.done) {
    if (shallow.length || unshallow.length) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktDelim());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack));
  }
  parts.push(pktFlush());
  surface.sendRaw(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function fetchV0(surface: Surface, repo: RepoRec, wantLines: string[], negotiationLines: string[], packCache: Map<string, Buffer>): void {
  const args = parseFetchArgs([...wantLines, ...negotiationLines]);
  const { pack, shallow, unshallow } = fetchPack(repo, args, packCache);
  const parts: Buffer[] = [];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const existing = args.haves.filter((have) => repo.objects.has(have));
  if (existing.length) parts.push(pktLine(`ACK ${existing[0]}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(pktFlush());
  surface.sendRaw(200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function receivePack(surface: Surface, repo: RepoRec, body: Buffer): void {
  const reader = new PktReader(body);
  const { lines } = readPktLines(reader);
  if (lines.length === 0) throw new Error('receive-pack request has no commands');

  let capabilities = '';
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  lines.forEach((raw, index) => {
    let line = raw.replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3 || !isOid(parts[0]) || !isOid(parts[1])) {
      throw new Error(`malformed receive-pack command: ${line.slice(0, 60)}`);
    }
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  });
  const caps = new Set(capabilities.split(' ').filter(Boolean));
  const pack = reader.remaining();

  let unpackError: string | null = null;
  if (pack.length > 0) {
    try {
      const incoming = readPack(pack, (oid) => repo.objects.get(oid));
      for (const [oid, obj] of incoming) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason?: string }> = [];
  for (const command of commands) {
    if (unpackError !== null) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true });
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'not our ref' });
      continue;
    }
    if (command.oldOid !== ZERO_OID && command.oldOid !== command.newOid
      && !isAncestor(repo.objects, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true });
  }

  if (!caps.has('report-status')) {
    surface.sendRaw(200, Buffer.alloc(0), 'application/x-git-receive-pack-result');
    return;
  }
  const report: Buffer[] = [pktLine(unpackError === null ? 'unpack ok\n' : `unpack error ${unpackError}\n`)];
  for (const result of results) {
    report.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'error'}\n`));
  }
  report.push(pktFlush());
  const reportBytes = Buffer.concat(report);
  if (caps.has('side-band-64k')) {
    surface.sendRaw(200, Buffer.concat([...sidebandPackets(reportBytes), pktFlush()]), 'application/x-git-receive-pack-result');
  } else {
    surface.sendRaw(200, reportBytes, 'application/x-git-receive-pack-result');
  }
}
