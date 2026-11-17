// mcp.ts — the MCP endpoint: JSON-RPC 2.0 over Streamable HTTP.
//
// Both protocol eras are served: the modern `server/discover` probe
// (2026-07-28) and the legacy `initialize` + `notifications/initialized`
// handshake. The endpoint is stateless per request, which keeps concurrent
// calls naturally apart (each response echoes its own request id).
//
// The tools act on the same store as REST and render the same shapes, so
// ids and numbers agree across surfaces.

import {
  Store,
  markMerged,
  performSquashMerge,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import type { Surface } from './app.ts';

const SERVER_INFO = { name: 'forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

// ---------------------------------------------------------------- tool definitions
//
// Built once and returned verbatim from every tools/list call, so two
// listings are byte-identical.

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const str = (description: string) => ({ type: 'string', description });

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The repository name'),
        description: str('A short description of the repository'),
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        title: str('The issue title'),
        body: str('The issue body'),
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state (open, closed, all).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        state: str('Filter by state: open, closed or all'),
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        title: str('The pull request title'),
        head: str('The head branch name'),
        base: str('The base branch name'),
        body: str('The pull request body'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login'),
        repo: str('The repository name'),
        pull_number: { type: 'integer', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// ---------------------------------------------------------------- rendering (REST shapes)

function repoResult(store: Store, repo: RepoRec): Record<string, unknown> {
  const owner = store.viewerLogin ?? '';
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: store.viewerId, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: store.isoOf(repo.seq),
    updated_at: store.isoOf(repo.seq),
  };
}

function issueResult(store: Store, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: store.viewerLogin ?? '', id: store.viewerId },
    comments: issue.comments.length,
    created_at: store.isoOf(issue.seq),
    updated_at: store.isoOf(issue.closedSeq ?? issue.seq),
    closed_at: issue.closedSeq === null ? null : store.isoOf(issue.closedSeq),
  };
}

function pullResult(store: Store, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const owner = store.viewerLogin ?? '';
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : store.isoOf(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: store.branchTip(repo, pull.headRef) ?? pull.headSha, label: `${owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: store.branchTip(repo, pull.baseRef) ?? pull.baseSha, label: `${owner}:${pull.baseRef}` },
    user: { login: owner, id: store.viewerId },
    created_at: store.isoOf(pull.seq),
    updated_at: store.isoOf(pull.mergedSeq ?? pull.seq),
  };
}

// ---------------------------------------------------------------- tool execution

class ToolFailure extends Error {}

function needRepo(store: Store, args: Record<string, unknown>): RepoRec {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const name = typeof args.repo === 'string' ? args.repo : '';
  const repo = store.repoFor(owner, name);
  if (!repo) throw new ToolFailure(`repository ${owner}/${name} not found`);
  return repo;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '' || !/^[A-Za-z0-9._-]+$/.test(repoName)) throw new ToolFailure('a valid repository name is required');
      if (store.repos.has(repoName)) throw new ToolFailure('name already exists on this account');
      const repo = store.createRepo(repoName, {
        description: typeof args.description === 'string' ? args.description : null,
        private: args.private === true,
      });
      return repoResult(store, repo);
    }
    case 'get_repo': {
      return repoResult(store, needRepo(store, args));
    }
    case 'create_issue': {
      const repo = needRepo(store, args);
      const issue = store.createIssue(
        repo,
        typeof args.title === 'string' ? args.title : '',
        typeof args.body === 'string' ? args.body : '',
        [],
      );
      return issueResult(store, repo, issue);
    }
    case 'list_issues': {
      const repo = needRepo(store, args);
      const state = typeof args.state === 'string' ? args.state : 'all';
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.seq - a.seq);
      return { issues: issues.map((issue) => issueResult(store, repo, issue)) };
    }
    case 'create_pull_request': {
      const repo = needRepo(store, args);
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      const headSha = store.branchTip(repo, head);
      const baseSha = store.branchTip(repo, base);
      if (headSha === null || baseSha === null) throw new ToolFailure('head or base branch does not exist');
      const pull = store.createPull(repo, {
        title: typeof args.title === 'string' ? args.title : '',
        body: typeof args.body === 'string' ? args.body : '',
        headRef: head,
        baseRef: base,
        headSha,
        baseSha,
      });
      return pullResult(store, repo, pull);
    }
    case 'merge_pull_request': {
      const repo = needRepo(store, args);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (!pull) throw new ToolFailure(`pull request ${String(args.pull_number)} not found`);
      if (!pull.merged) {
        if (pull.state === 'closed') throw new ToolFailure('pull request is not mergeable');
        const sha = performSquashMerge(store, repo, pull);
        if (sha === null) throw new ToolFailure('pull request is not mergeable');
        markMerged(store, pull, sha);
      }
      return pullResult(store, repo, pull);
    }
    default:
      throw new ToolFailure(`unknown tool ${name}`);
  }
}

// ---------------------------------------------------------------- JSON-RPC plumbing

interface RpcError {
  code: number;
  message: string;
}

export function handleMcp(surface: Surface, method: string, body: Buffer): void {
  const { store } = surface;
  if (method === 'DELETE') {
    surface.sendRaw(200, Buffer.alloc(0), 'application/json; charset=utf-8');
    return;
  }
  if (method !== 'POST') {
    surface.sendJson(405, { message: 'Method Not Allowed' });
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    surface.sendJson(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    surface.sendJson(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const request = parsed as { id?: unknown; method?: unknown; params?: unknown };
  const rpcMethod = typeof request.method === 'string' ? request.method : '';
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  // Notifications carry no id and are answered with a bare 202.
  if (request.id === undefined) {
    surface.sendRaw(202, Buffer.alloc(0), 'application/json; charset=utf-8');
    return;
  }
  const id = request.id;

  const fail = (error: RpcError) => surface.sendJson(200, { jsonrpc: '2.0', id, error });
  const succeed = (result: unknown) => surface.sendJson(200, { jsonrpc: '2.0', id, result });

  switch (rpcMethod) {
    case 'server/discover':
      succeed({
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case 'initialize':
      succeed({
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });
      return;
    case 'ping':
      succeed({});
      return;
    case 'tools/list':
      succeed({ tools: TOOLS });
      return;
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((entry) => entry.name === toolName);
      if (!tool) {
        fail({ code: -32602, message: `Unknown tool: ${toolName}` });
        return;
      }
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      const missing = tool.inputSchema.required.filter((key) => args[key] === undefined);
      if (missing.length) {
        fail({ code: -32602, message: `Missing required argument(s): ${missing.join(', ')}` });
        return;
      }
      try {
        const result = callTool(store, toolName, args);
        succeed({
          content: [{ type: 'text', text: JSON.stringify(result) }],
          structuredContent: result,
          isError: false,
        });
      } catch (err) {
        if (err instanceof ToolFailure) {
          succeed({ content: [{ type: 'text', text: err.message }], isError: true });
          return;
        }
        throw err;
      }
      return;
    }
    case 'prompts/list':
      succeed({ prompts: [] });
      return;
    case 'resources/list':
      succeed({ resources: [] });
      return;
    case 'resources/templates/list':
      succeed({ resourceTemplates: [] });
      return;
    default:
      fail({ code: -32601, message: `Method not found: ${rpcMethod}` });
  }
}
