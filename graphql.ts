// graphql.ts — a small hand-written GraphQL parser and executor covering
// the GitHub-flavoured surface the forge exposes: viewer / repository /
// node queries, issue and pull-request connections with cursor pagination,
// introspection (__type), and the create/close/merge/comment mutations.
// It executes directly against the shared store, so GraphQL and REST never
// disagree about an object.

import {
  Store,
  commentGlobalId,
  globalId,
  issueGlobalId,
  parseGlobalId,
  performSquashMerge,
  markMerged,
  pullFiles,
  pullGlobalId,
  pullMergeable,
  repoGlobalId,
  userGlobalId,
  type CommentRec,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';
import type { Surface } from './app.ts';

// ---------------------------------------------------------------- lexer

type TokenKind = 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread' | 'eof';
interface Token {
  kind: TokenKind;
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string) => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string) => /[_0-9A-Za-z]/.test(c);
  while (i < source.length) {
    const c = source[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '﻿') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end < 0) throw new Error('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const esc = source[j + 1];
          if (esc === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[esc] ?? esc;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[-0-9]/.test(c)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j])) j += 1;
      let kind: TokenKind = 'int';
      if (source[j] === '.' || source[j] === 'e' || source[j] === 'E') {
        kind = 'float';
        if (source[j] === '.') {
          j += 1;
          while (j < source.length && /[0-9]/.test(source[j])) j += 1;
        }
        if (source[j] === 'e' || source[j] === 'E') {
          j += 1;
          if (source[j] === '+' || source[j] === '-') j += 1;
          while (j < source.length && /[0-9]/.test(source[j])) j += 1;
        }
      }
      tokens.push({ kind, value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < source.length && isNameChar(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Array<{ name: string; value: ValueNode }>;
  selectionSet: SelectionNode[] | null;
}
type SelectionNode =
  | FieldNode
  | { kind: 'inlineFragment'; typeCondition: string | null; selectionSet: SelectionNode[] }
  | { kind: 'fragmentSpread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name: string | null;
  variableDefaults: Map<string, ValueNode>;
  selectionSet: SelectionNode[];
}
interface FragmentNode {
  name: string;
  typeCondition: string;
  selectionSet: SelectionNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }
  private next(): Token {
    return this.tokens[this.pos++];
  }
  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected '${value}', got ${token.value}`);
  }
  private skipPunct(value: string): boolean {
    const token = this.peek();
    if (token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error(`expected a name, got ${token.value}`);
    return token.value;
  }

  parseDocument(): { operations: OperationNode[]; fragments: Map<string, FragmentNode> } {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({
          operation: 'query',
          name: null,
          variableDefaults: new Map(),
          selectionSet: this.parseSelectionSet(),
        });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const operation = this.next().value as 'query' | 'mutation';
        const name = this.peek().kind === 'name' ? this.next().value : null;
        const variableDefaults = new Map<string, ValueNode>();
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions(variableDefaults);
        this.skipDirectives();
        operations.push({ operation, name, variableDefaults, selectionSet: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        if (this.expectName() !== 'on') throw new Error('fragment must have an `on` type condition');
        const typeCondition = this.expectName();
        this.skipDirectives();
        fragments.set(name, { name, typeCondition, selectionSet: this.parseSelectionSet() });
      } else {
        throw new Error(`unexpected token ${token.value}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(defaults: Map<string, ValueNode>): void {
    this.expectPunct('(');
    while (!this.skipPunct(')')) {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.skipType();
      if (this.skipPunct('=')) defaults.set(name, this.parseValue());
      this.skipDirectives();
    }
  }

  private skipType(): void {
    if (this.skipPunct('[')) {
      this.skipType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.skipPunct('!');
  }

  private skipDirectives(): void {
    while (this.peek().kind === 'punct' && this.peek().value === '@') {
      this.next();
      this.expectName();
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        while (!this.skipPunct(')')) {
          this.expectName();
          this.expectPunct(':');
          this.parseValue();
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.skipPunct('}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'inlineFragment', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          const name = this.expectName();
          this.skipDirectives();
          selections.push({ kind: 'fragmentSpread', name });
        }
        continue;
      }
      let name = this.expectName();
      let alias: string | null = null;
      if (this.skipPunct(':')) {
        alias = name;
        name = this.expectName();
      }
      const args: FieldNode['args'] = [];
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.next();
        while (!this.skipPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args.push({ name: argName, value: this.parseValue() });
        }
      }
      this.skipDirectives();
      const selectionSet = this.peek().kind === 'punct' && this.peek().value === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', name, alias, args, selectionSet });
    }
    return selections;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (!this.skipPunct(']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (!this.skipPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error(`unexpected value token ${token.value}`);
  }
}

// ---------------------------------------------------------------- executor

interface ExecCtx {
  store: Store;
  surface: Surface;
  variables: Record<string, unknown>;
  defaults: Map<string, ValueNode>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

type Source = Record<string, unknown> & { __dynamicType?: string; __source?: unknown };

interface FieldDef {
  type: string; // GraphQL type the field returns ('String' etc. for scalars)
  list?: boolean;
  resolve: (source: any, args: Record<string, unknown>, ctx: ExecCtx) => unknown;
}

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID', 'DateTime', 'URI', 'GitObjectID']);

function resolveValue(node: ValueNode, ctx: ExecCtx): unknown {
  switch (node.kind) {
    case 'variable': {
      if (node.name in ctx.variables) return ctx.variables[node.name];
      const fallback = ctx.defaults.get(node.name);
      return fallback ? resolveValue(fallback, ctx) : undefined;
    }
    case 'int':
      return Number.parseInt(node.value, 10);
    case 'float':
      return Number.parseFloat(node.value);
    case 'string':
    case 'enum':
      return node.value;
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => resolveValue(item, ctx));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, ctx);
      return out;
    }
  }
}

function argsOf(field: FieldNode, ctx: ExecCtx): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx);
  return args;
}

function executeSelectionSet(typeName: string, source: unknown, selections: SelectionNode[], ctx: ExecCtx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const typeDef = TYPES[typeName];
  for (const selection of selections) {
    if (selection.kind === 'inlineFragment') {
      if (selection.typeCondition === null || selection.typeCondition === typeName || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(typeName, source, selection.selectionSet, ctx));
      }
      continue;
    }
    if (selection.kind === 'fragmentSpread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment && (fragment.typeCondition === typeName || fragment.typeCondition === 'Node')) {
        Object.assign(out, executeSelectionSet(typeName, source, fragment.selectionSet, ctx));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const def = typeDef?.fields[selection.name];
    if (!def) {
      ctx.errors.push({ message: `Field '${selection.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    }
    let value: unknown;
    try {
      value = def.resolve(source, argsOf(selection, ctx), ctx);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    out[key] = completeValue(def, value, selection.selectionSet, ctx);
  }
  return out;
}

function completeValue(def: FieldDef, value: unknown, selectionSet: SelectionNode[] | null, ctx: ExecCtx): unknown {
  if (value === null || value === undefined) return null;
  if (def.list) {
    if (!Array.isArray(value)) return null;
    return value.map((item) => completeValue({ type: def.type, resolve: def.resolve }, item, selectionSet, ctx));
  }
  if (SCALARS.has(def.type)) {
    if (def.type === 'Int') return typeof value === 'number' ? Math.trunc(value) : Number(value);
    if (def.type === 'ID') return String(value);
    if (def.type === 'Boolean') return Boolean(value);
    return value;
  }
  // Object completion: a resolver may tag a polymorphic result (node(id:)).
  let actualType = def.type;
  let actualSource: unknown = value;
  if (typeof value === 'object' && value !== null && '__dynamicType' in (value as Source)) {
    const tagged = value as Source;
    actualType = tagged.__dynamicType!;
    actualSource = tagged.__source;
  }
  if (!selectionSet) return {};
  return executeSelectionSet(actualType, actualSource, selectionSet, ctx);
}

// ---------------------------------------------------------------- domain sources

interface RepoSource {
  repo: RepoRec;
}
interface IssueSource {
  repo: RepoRec;
  issue: IssueRec;
}
interface PullSource {
  repo: RepoRec;
  pull: PullRec;
}
interface CommentSource {
  repo: RepoRec;
  comment: CommentRec;
}

function repoByGlobalId(store: Store, id: unknown): RepoRec | null {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  if (!parsed || parsed.kind !== 'Repository') return null;
  const dbId = Number.parseInt(parsed.key, 10);
  for (const repo of store.repos.values()) if (repo.id === dbId) return repo;
  return null;
}

function issueByGlobalId(store: Store, id: unknown): IssueSource | null {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  if (!parsed || parsed.kind !== 'Issue') return null;
  const [repoId, number] = parsed.key.split(':').map((part) => Number.parseInt(part, 10));
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const issue = repo.issues.get(number);
    return issue ? { repo, issue } : null;
  }
  return null;
}

function pullByGlobalId(store: Store, id: unknown): PullSource | null {
  const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
  if (!parsed || parsed.kind !== 'PullRequest') return null;
  const [repoId, number] = parsed.key.split(':').map((part) => Number.parseInt(part, 10));
  for (const repo of store.repos.values()) {
    if (repo.id !== repoId) continue;
    const pull = repo.pulls.get(number);
    return pull ? { repo, pull } : null;
  }
  return null;
}

function encodeCursor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number {
  if (typeof cursor !== 'string') return -1;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number.parseInt(match[1], 10) : -1;
  } catch {
    return -1;
  }
}

interface Connection<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
  totalCount: number;
  edges: Array<{ node: T; cursor: string }>;
}

/** Slice an already-ordered list into a connection using opaque offset cursors. */
function connection<T>(items: readonly T[], args: Record<string, unknown>): Connection<T> {
  const after = decodeCursor(args.after);
  const start = after + 1;
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : items.length;
  const slice = items.slice(start, start + first);
  const edges = slice.map((node, i) => ({ node, cursor: encodeCursor(start + i) }));
  return {
    nodes: slice,
    edges,
    pageInfo: {
      hasNextPage: start + slice.length < items.length,
      hasPreviousPage: start > 0,
      startCursor: edges.length ? edges[0].cursor : null,
      endCursor: edges.length ? edges[edges.length - 1].cursor : null,
    },
    totalCount: items.length,
  };
}

// ---------------------------------------------------------------- schema

const viewerSource = (ctx: ExecCtx): Record<string, unknown> => ({ login: ctx.store.viewerLogin ?? '' });

const TYPES: Record<string, { fields: Record<string, FieldDef> }> = {
  Query: {
    fields: {
      viewer: { type: 'User', resolve: (_s, _a, ctx) => viewerSource(ctx) },
      repository: {
        type: 'Repository',
        resolve: (_s, args, ctx) => {
          const owner = typeof args.owner === 'string' ? args.owner : '';
          const name = typeof args.name === 'string' ? args.name : '';
          return ctx.store.repoFor(owner, name);
        },
      },
      node: {
        type: 'Node',
        resolve: (_s, args, ctx) => {
          const id = args.id;
          const repo = repoByGlobalId(ctx.store, id);
          if (repo) return { __dynamicType: 'Repository', __source: repo };
          const issue = issueByGlobalId(ctx.store, id);
          if (issue) return { __dynamicType: 'Issue', __source: issue };
          const pull = pullByGlobalId(ctx.store, id);
          if (pull) return { __dynamicType: 'PullRequest', __source: pull };
          const parsed = typeof id === 'string' ? parseGlobalId(id) : null;
          if (parsed?.kind === 'User') return { __dynamicType: 'User', __source: viewerSource(ctx) };
          return null;
        },
      },
      __type: {
        type: '__Type',
        resolve: (_s, args) => {
          const name = typeof args.name === 'string' ? args.name : '';
          return typeInfo(name);
        },
      },
      __schema: {
        type: '__Schema',
        resolve: () => ({ queryType: { name: 'Query' }, mutationType: { name: 'Mutation' }, subscriptionType: null, types: [], directives: [] }),
      },
      rateLimit: { type: 'RateLimit', resolve: () => ({ limit: 5000, cost: 1, remaining: 4999, used: 1, resetAt: null }) },
    },
  },
  Mutation: {
    fields: {
      createIssue: {
        type: 'CreateIssuePayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoByGlobalId(ctx.store, input.repositoryId);
          if (!repo) throw new Error('repository not found');
          const title = typeof input.title === 'string' ? input.title : '';
          if (title === '') throw new Error('title is required');
          const issue = ctx.store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', []);
          return { issue: { repo, issue } satisfies IssueSource, clientMutationId: input.clientMutationId ?? null };
        },
      },
      closeIssue: {
        type: 'CloseIssuePayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = issueByGlobalId(ctx.store, input.issueId);
          if (!found) throw new Error('issue not found');
          if (found.issue.state === 'open') {
            found.issue.state = 'closed';
            found.issue.closedSeq = ctx.store.tick();
          }
          return { issue: found, clientMutationId: input.clientMutationId ?? null };
        },
      },
      createPullRequest: {
        type: 'CreatePullRequestPayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const repo = repoByGlobalId(ctx.store, input.repositoryId);
          if (!repo) throw new Error('repository not found');
          const headRef = typeof input.headRefName === 'string' ? input.headRefName : '';
          const baseRef = typeof input.baseRefName === 'string' ? input.baseRefName : '';
          const headSha = ctx.store.branchTip(repo, headRef);
          const baseSha = ctx.store.branchTip(repo, baseRef);
          if (headSha === null || baseSha === null) throw new Error('head or base branch does not exist');
          const pull = ctx.store.createPull(repo, {
            title: typeof input.title === 'string' ? input.title : '',
            body: typeof input.body === 'string' ? input.body : '',
            headRef,
            baseRef,
            headSha,
            baseSha,
          });
          return { pullRequest: { repo, pull } satisfies PullSource, clientMutationId: input.clientMutationId ?? null };
        },
      },
      mergePullRequest: {
        type: 'MergePullRequestPayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const found = pullByGlobalId(ctx.store, input.pullRequestId);
          if (!found) throw new Error('pull request not found');
          if (!found.pull.merged) {
            const sha = performSquashMerge(ctx.store, found.repo, found.pull);
            if (sha === null) throw new Error('Pull request is not mergeable');
            markMerged(ctx.store, found.pull, sha);
          }
          return { pullRequest: found, clientMutationId: input.clientMutationId ?? null };
        },
      },
      addComment: {
        type: 'AddCommentPayload',
        resolve: (_s, args, ctx) => {
          const input = (args.input ?? {}) as Record<string, unknown>;
          const body = typeof input.body === 'string' ? input.body : '';
          const issue = issueByGlobalId(ctx.store, input.subjectId);
          if (issue) {
            const comment = ctx.store.addComment(issue.issue, body);
            return {
              commentEdge: { node: { repo: issue.repo, comment } satisfies CommentSource, cursor: '' },
              clientMutationId: input.clientMutationId ?? null,
            };
          }
          const pull = pullByGlobalId(ctx.store, input.subjectId);
          if (pull) {
            const comment = ctx.store.addComment(pull.pull, body);
            return {
              commentEdge: { node: { repo: pull.repo, comment } satisfies CommentSource, cursor: '' },
              clientMutationId: input.clientMutationId ?? null,
            };
          }
          throw new Error('subject not found');
        },
      },
    },
  },
  User: {
    fields: {
      login: { type: 'String', resolve: (s) => (s as { login: string }).login },
      id: { type: 'ID', resolve: (_s, _a, ctx) => userGlobalId(ctx.store) },
      databaseId: { type: 'Int', resolve: (_s, _a, ctx) => ctx.store.viewerId },
      name: { type: 'String', resolve: (s) => (s as { login: string }).login },
      url: { type: 'URI', resolve: (s, _a, ctx) => `${ctx.surface.base}/${(s as { login: string }).login}` },
      avatarUrl: { type: 'URI', resolve: (_s, _a, ctx) => `${ctx.surface.base}/avatars/${ctx.store.viewerId}` },
      isViewer: { type: 'Boolean', resolve: () => true },
    },
  },
  Repository: {
    fields: {
      id: { type: 'ID', resolve: (s) => repoGlobalId(s as RepoRec) },
      databaseId: { type: 'Int', resolve: (s) => (s as RepoRec).id },
      name: { type: 'String', resolve: (s) => (s as RepoRec).name },
      nameWithOwner: { type: 'String', resolve: (s, _a, ctx) => `${ctx.store.viewerLogin ?? ''}/${(s as RepoRec).name}` },
      owner: { type: 'User', resolve: (_s, _a, ctx) => viewerSource(ctx) },
      description: { type: 'String', resolve: (s) => (s as RepoRec).description },
      isPrivate: { type: 'Boolean', resolve: (s) => (s as RepoRec).private },
      isFork: { type: 'Boolean', resolve: () => false },
      isArchived: { type: 'Boolean', resolve: () => false },
      url: { type: 'URI', resolve: (s, _a, ctx) => `${ctx.surface.base}/${ctx.store.viewerLogin ?? ''}/${(s as RepoRec).name}` },
      createdAt: { type: 'DateTime', resolve: (s, _a, ctx) => ctx.store.isoOf((s as RepoRec).seq) },
      updatedAt: { type: 'DateTime', resolve: (s, _a, ctx) => ctx.store.isoOf((s as RepoRec).seq) },
      defaultBranchRef: {
        type: 'Ref',
        resolve: (s, _a, ctx) => {
          const repo = s as RepoRec;
          const tip = ctx.store.branchTip(repo, repo.defaultBranch);
          if (tip === null) return null;
          return { name: repo.defaultBranch, prefix: 'refs/heads/', target: { oid: tip } };
        },
      },
      viewerPermission: { type: 'String', resolve: () => 'ADMIN' },
      hasIssuesEnabled: { type: 'Boolean', resolve: () => true },
      hasPullRequestsEnabled: { type: 'Boolean', resolve: () => true },
      hasWikiEnabled: { type: 'Boolean', resolve: () => false },
      hasProjectsEnabled: { type: 'Boolean', resolve: () => false },
      stargazerCount: { type: 'Int', resolve: () => 0 },
      forkCount: { type: 'Int', resolve: () => 0 },
      issue: {
        type: 'Issue',
        resolve: (s, args) => {
          const repo = s as RepoRec;
          const issue = repo.issues.get(typeof args.number === 'number' ? args.number : -1);
          return issue ? ({ repo, issue } satisfies IssueSource) : null;
        },
      },
      issues: {
        type: 'IssueConnection',
        resolve: (s, args) => {
          const repo = s as RepoRec;
          let issues = [...repo.issues.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
          const orderBy = (args.orderBy ?? {}) as { field?: string; direction?: string };
          const ascending = orderBy.direction === 'ASC';
          issues.sort((a, b) => (ascending ? a.seq - b.seq || a.number - b.number : b.seq - a.seq || b.number - a.number));
          return connection(issues.map((issue) => ({ repo, issue }) satisfies IssueSource), args);
        },
      },
      pullRequest: {
        type: 'PullRequest',
        resolve: (s, args) => {
          const repo = s as RepoRec;
          const pull = repo.pulls.get(typeof args.number === 'number' ? args.number : -1);
          return pull ? ({ repo, pull } satisfies PullSource) : null;
        },
      },
      pullRequests: {
        type: 'PullRequestConnection',
        resolve: (s, args) => {
          const repo = s as RepoRec;
          let pulls = [...repo.pulls.values()];
          const states = Array.isArray(args.states) ? (args.states as string[]) : ['OPEN'];
          pulls = pulls.filter((pull) => states.includes(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
          pulls.sort((a, b) => b.seq - a.seq || b.number - a.number);
          return connection(pulls.map((pull) => ({ repo, pull }) satisfies PullSource), args);
        },
      },
    },
  },
  Issue: {
    fields: {
      id: { type: 'ID', resolve: (s) => issueGlobalId((s as IssueSource).repo, (s as IssueSource).issue) },
      databaseId: { type: 'Int', resolve: (s) => (s as IssueSource).issue.id },
      number: { type: 'Int', resolve: (s) => (s as IssueSource).issue.number },
      title: { type: 'String', resolve: (s) => (s as IssueSource).issue.title },
      body: { type: 'String', resolve: (s) => (s as IssueSource).issue.body },
      state: { type: 'String', resolve: (s) => (s as IssueSource).issue.state.toUpperCase() },
      closed: { type: 'Boolean', resolve: (s) => (s as IssueSource).issue.state === 'closed' },
      author: { type: 'User', resolve: (_s, _a, ctx) => viewerSource(ctx) },
      repository: { type: 'Repository', resolve: (s) => (s as IssueSource).repo },
      url: {
        type: 'URI',
        resolve: (s, _a, ctx) => `${ctx.surface.base}/${ctx.store.viewerLogin ?? ''}/${(s as IssueSource).repo.name}/issues/${(s as IssueSource).issue.number}`,
      },
      createdAt: { type: 'DateTime', resolve: (s, _a, ctx) => ctx.store.isoOf((s as IssueSource).issue.seq) },
      updatedAt: { type: 'DateTime', resolve: (s, _a, ctx) => ctx.store.isoOf((s as IssueSource).issue.closedSeq ?? (s as IssueSource).issue.seq) },
      closedAt: {
        type: 'DateTime',
        resolve: (s, _a, ctx) => {
          const { issue } = s as IssueSource;
          return issue.closedSeq === null ? null : ctx.store.isoOf(issue.closedSeq);
        },
      },
      labels: {
        type: 'LabelConnection',
        resolve: (s, args) => {
          const { repo, issue } = s as IssueSource;
          const labels = issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed', description: repo.labels.get(name)?.description ?? null }));
          return connection(labels, args);
        },
      },
      comments: {
        type: 'IssueCommentConnection',
        resolve: (s, args) => {
          const { repo, issue } = s as IssueSource;
          return connection(issue.comments.map((comment) => ({ repo, comment }) satisfies CommentSource), args);
        },
      },
    },
  },
  PullRequest: {
    fields: {
      id: { type: 'ID', resolve: (s) => pullGlobalId((s as PullSource).repo, (s as PullSource).pull) },
      databaseId: { type: 'Int', resolve: (s) => (s as PullSource).pull.id },
      number: { type: 'Int', resolve: (s) => (s as PullSource).pull.number },
      title: { type: 'String', resolve: (s) => (s as PullSource).pull.title },
      body: { type: 'String', resolve: (s) => (s as PullSource).pull.body },
      state: {
        type: 'String',
        resolve: (s) => {
          const { pull } = s as PullSource;
          return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        },
      },
      merged: { type: 'Boolean', resolve: (s) => (s as PullSource).pull.merged },
      mergedAt: {
        type: 'DateTime',
        resolve: (s, _a, ctx) => {
          const { pull } = s as PullSource;
          return pull.mergedSeq === null ? null : ctx.store.isoOf(pull.mergedSeq);
        },
      },
      mergeCommit: {
        type: 'Commit',
        resolve: (s) => {
          const { pull } = s as PullSource;
          return pull.mergeCommitSha === null ? null : { oid: pull.mergeCommitSha };
        },
      },
      mergeable: { type: 'String', resolve: (s) => pullMergeable((s as PullSource).repo, (s as PullSource).pull) },
      headRefName: { type: 'String', resolve: (s) => (s as PullSource).pull.headRef },
      baseRefName: { type: 'String', resolve: (s) => (s as PullSource).pull.baseRef },
      headRefOid: {
        type: 'GitObjectID',
        resolve: (s, _a, ctx) => {
          const { repo, pull } = s as PullSource;
          return ctx.store.branchTip(repo, pull.headRef) ?? pull.headSha;
        },
      },
      baseRefOid: {
        type: 'GitObjectID',
        resolve: (s, _a, ctx) => {
          const { repo, pull } = s as PullSource;
          return ctx.store.branchTip(repo, pull.baseRef) ?? pull.baseSha;
        },
      },
      isDraft: { type: 'Boolean', resolve: () => false },
      author: { type: 'User', resolve: (_s, _a, ctx) => viewerSource(ctx) },
      repository: { type: 'Repository', resolve: (s) => (s as PullSource).repo },
      url: {
        type: 'URI',
        resolve: (s, _a, ctx) => `${ctx.surface.base}/${ctx.store.viewerLogin ?? ''}/${(s as PullSource).repo.name}/pull/${(s as PullSource).pull.number}`,
      },
      createdAt: { type: 'DateTime', resolve: (s, _a, ctx) => ctx.store.isoOf((s as PullSource).pull.seq) },
      updatedAt: { type: 'DateTime', resolve: (s, _a, ctx) => ctx.store.isoOf((s as PullSource).pull.mergedSeq ?? (s as PullSource).pull.seq) },
      closedAt: {
        type: 'DateTime',
        resolve: (s, _a, ctx) => {
          const { pull } = s as PullSource;
          return pull.state === 'closed' ? ctx.store.isoOf(pull.mergedSeq ?? pull.seq) : null;
        },
      },
      files: {
        type: 'PullRequestChangedFileConnection',
        resolve: (s, args) => {
          const { repo, pull } = s as PullSource;
          const files = pullFiles(repo, pull).map((file) => ({
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED',
          }));
          return connection(files, args);
        },
      },
      comments: {
        type: 'IssueCommentConnection',
        resolve: (s, args) => {
          const { repo, pull } = s as PullSource;
          return connection(pull.comments.map((comment) => ({ repo, comment }) satisfies CommentSource), args);
        },
      },
    },
  },
  Ref: {
    fields: {
      name: { type: 'String', resolve: (s) => (s as { name: string }).name },
      prefix: { type: 'String', resolve: (s) => (s as { prefix: string }).prefix },
      target: { type: 'Commit', resolve: (s) => (s as { target: { oid: string } }).target },
    },
  },
  Commit: {
    fields: {
      oid: { type: 'GitObjectID', resolve: (s) => (s as { oid: string }).oid },
      id: { type: 'ID', resolve: (s) => globalId('Commit', (s as { oid: string }).oid) },
      abbreviatedOid: { type: 'String', resolve: (s) => (s as { oid: string }).oid.slice(0, 7) },
    },
  },
  IssueComment: {
    fields: {
      id: { type: 'ID', resolve: (s) => commentGlobalId((s as CommentSource).repo, (s as CommentSource).comment) },
      databaseId: { type: 'Int', resolve: (s) => (s as CommentSource).comment.id },
      body: { type: 'String', resolve: (s) => (s as CommentSource).comment.body },
      author: { type: 'User', resolve: (_s, _a, ctx) => viewerSource(ctx) },
      createdAt: { type: 'DateTime', resolve: (s, _a, ctx) => ctx.store.isoOf((s as CommentSource).comment.seq) },
      updatedAt: { type: 'DateTime', resolve: (s, _a, ctx) => ctx.store.isoOf((s as CommentSource).comment.seq) },
    },
  },
  Label: {
    fields: {
      id: { type: 'ID', resolve: (s) => globalId('Label', (s as { name: string }).name) },
      name: { type: 'String', resolve: (s) => (s as { name: string }).name },
      color: { type: 'String', resolve: (s) => (s as { color: string }).color },
      description: { type: 'String', resolve: (s) => (s as { description: string | null }).description },
    },
  },
  RateLimit: {
    fields: {
      limit: { type: 'Int', resolve: (s) => (s as { limit: number }).limit },
      cost: { type: 'Int', resolve: (s) => (s as { cost: number }).cost },
      remaining: { type: 'Int', resolve: (s) => (s as { remaining: number }).remaining },
      used: { type: 'Int', resolve: (s) => (s as { used: number }).used },
      resetAt: { type: 'DateTime', resolve: () => null },
    },
  },
  PageInfo: {
    fields: {
      hasNextPage: { type: 'Boolean', resolve: (s) => (s as { hasNextPage: boolean }).hasNextPage },
      hasPreviousPage: { type: 'Boolean', resolve: (s) => (s as { hasPreviousPage: boolean }).hasPreviousPage },
      startCursor: { type: 'String', resolve: (s) => (s as { startCursor: string | null }).startCursor },
      endCursor: { type: 'String', resolve: (s) => (s as { endCursor: string | null }).endCursor },
    },
  },
  CreateIssuePayload: {
    fields: {
      issue: { type: 'Issue', resolve: (s) => (s as { issue: IssueSource }).issue },
      clientMutationId: { type: 'String', resolve: (s) => (s as { clientMutationId: unknown }).clientMutationId },
    },
  },
  CloseIssuePayload: {
    fields: {
      issue: { type: 'Issue', resolve: (s) => (s as { issue: IssueSource }).issue },
      clientMutationId: { type: 'String', resolve: (s) => (s as { clientMutationId: unknown }).clientMutationId },
    },
  },
  CreatePullRequestPayload: {
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (s) => (s as { pullRequest: PullSource }).pullRequest },
      clientMutationId: { type: 'String', resolve: (s) => (s as { clientMutationId: unknown }).clientMutationId },
    },
  },
  MergePullRequestPayload: {
    fields: {
      pullRequest: { type: 'PullRequest', resolve: (s) => (s as { pullRequest: PullSource }).pullRequest },
      clientMutationId: { type: 'String', resolve: (s) => (s as { clientMutationId: unknown }).clientMutationId },
    },
  },
  AddCommentPayload: {
    fields: {
      commentEdge: { type: 'CommentEdge', resolve: (s) => (s as { commentEdge: unknown }).commentEdge },
      clientMutationId: { type: 'String', resolve: (s) => (s as { clientMutationId: unknown }).clientMutationId },
    },
  },
  CommentEdge: {
    fields: {
      node: { type: 'IssueComment', resolve: (s) => (s as { node: CommentSource }).node },
      cursor: { type: 'String', resolve: (s) => (s as { cursor: string }).cursor },
    },
  },
  __Type: {
    fields: {
      name: { type: 'String', resolve: (s) => (s as { name: string }).name },
      kind: { type: 'String', resolve: (s) => (s as { kind: string }).kind },
      description: { type: 'String', resolve: () => null },
      fields: {
        type: '__Field',
        list: true,
        resolve: (s) => ((s as { fieldNames: string[] }).fieldNames ?? []).map((name) => ({ name })),
      },
      enumValues: {
        type: '__EnumValue',
        list: true,
        resolve: (s) => ((s as { enumNames: string[] }).enumNames ?? []).map((name) => ({ name })),
      },
      possibleTypes: { type: '__Type', list: true, resolve: () => null },
      inputFields: { type: '__InputValue', list: true, resolve: () => null },
      ofType: { type: '__Type', resolve: () => null },
      specifiedByURL: { type: 'String', resolve: () => null },
    },
  },
  __Field: {
    fields: {
      name: { type: 'String', resolve: (s) => (s as { name: string }).name },
      description: { type: 'String', resolve: () => null },
      args: { type: '__InputValue', list: true, resolve: () => [] },
      type: { type: '__Type', resolve: () => null },
      isDeprecated: { type: 'Boolean', resolve: () => false },
      deprecationReason: { type: 'String', resolve: () => null },
    },
  },
  __EnumValue: {
    fields: {
      name: { type: 'String', resolve: (s) => (s as { name: string }).name },
      description: { type: 'String', resolve: () => null },
      isDeprecated: { type: 'Boolean', resolve: () => false },
      deprecationReason: { type: 'String', resolve: () => null },
    },
  },
  __Schema: {
    fields: {
      queryType: { type: '__Type', resolve: () => typeInfo('Query') },
      mutationType: { type: '__Type', resolve: () => typeInfo('Mutation') },
      subscriptionType: { type: '__Type', resolve: () => null },
      types: { type: '__Type', list: true, resolve: () => Object.keys(TYPES).map((name) => typeInfo(name)) },
      directives: { type: '__Directive', list: true, resolve: () => [] },
    },
  },
};

// Connection types share one shape; register them against the generic fields.
function connectionType(nodeType: string): { fields: Record<string, FieldDef> } {
  return {
    fields: {
      nodes: { type: nodeType, list: true, resolve: (s) => (s as Connection<unknown>).nodes },
      edges: {
        type: `${nodeType}Edge`,
        list: true,
        resolve: (s) => (s as Connection<unknown>).edges,
      },
      pageInfo: { type: 'PageInfo', resolve: (s) => (s as Connection<unknown>).pageInfo },
      totalCount: { type: 'Int', resolve: (s) => (s as Connection<unknown>).totalCount },
    },
  };
}
function edgeType(nodeType: string): { fields: Record<string, FieldDef> } {
  return {
    fields: {
      node: { type: nodeType, resolve: (s) => (s as { node: unknown }).node },
      cursor: { type: 'String', resolve: (s) => (s as { cursor: string }).cursor },
    },
  };
}
TYPES.IssueConnection = connectionType('Issue');
TYPES.PullRequestConnection = connectionType('PullRequest');
TYPES.LabelConnection = connectionType('Label');
TYPES.IssueCommentConnection = connectionType('IssueComment');
TYPES.PullRequestChangedFileConnection = connectionType('PullRequestChangedFile');
TYPES.IssueEdge = edgeType('Issue');
TYPES.PullRequestEdge = edgeType('PullRequest');
TYPES.LabelEdge = edgeType('Label');
TYPES.IssueCommentEdge = edgeType('IssueComment');
TYPES.PullRequestChangedFileEdge = edgeType('PullRequestChangedFile');
TYPES.PullRequestChangedFile = {
  fields: {
    path: { type: 'String', resolve: (s) => (s as { path: string }).path },
    additions: { type: 'Int', resolve: (s) => (s as { additions: number }).additions },
    deletions: { type: 'Int', resolve: (s) => (s as { deletions: number }).deletions },
    changeType: { type: 'String', resolve: (s) => (s as { changeType: string }).changeType },
  },
};
TYPES.Node = { fields: { id: { type: 'ID', resolve: () => null } } };

function typeInfo(name: string): Record<string, unknown> | null {
  if (name === 'SearchType') {
    return { name, kind: 'ENUM', fieldNames: [], enumNames: ['ISSUE', 'REPOSITORY', 'USER'] };
  }
  const type = TYPES[name];
  if (!type) return null;
  return { name, kind: 'OBJECT', fieldNames: Object.keys(type.fields), enumNames: [] };
}

// ---------------------------------------------------------------- HTTP entry

interface GraphqlRequest {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

function runOperation(surface: Surface, request: GraphqlRequest): Record<string, unknown> {
  const store = surface.store;
  if (typeof request.query !== 'string' || request.query === '') {
    return { errors: [{ message: 'query is required' }] };
  }
  let document: { operations: OperationNode[]; fragments: Map<string, FragmentNode> };
  try {
    document = new Parser(tokenize(request.query)).parseDocument();
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  let operation = document.operations[0];
  if (typeof request.operationName === 'string') {
    operation = document.operations.find((op) => op.name === request.operationName) ?? operation;
  }
  if (!operation) return { errors: [{ message: 'no operation found' }] };
  const ctx: ExecCtx = {
    store,
    surface,
    variables: (typeof request.variables === 'object' && request.variables !== null ? request.variables : {}) as Record<string, unknown>,
    defaults: operation.variableDefaults,
    fragments: document.fragments,
    errors: [],
  };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, {}, operation.selectionSet, ctx);
  const response: Record<string, unknown> = { data };
  if (ctx.errors.length) response.errors = ctx.errors;
  return response;
}

export function handleGraphql(surface: Surface, body: Buffer): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    surface.sendJson(400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    surface.sendJson(200, parsed.map((entry) => runOperation(surface, (entry ?? {}) as GraphqlRequest)));
    return;
  }
  surface.sendJson(200, runOperation(surface, (parsed ?? {}) as GraphqlRequest));
}
