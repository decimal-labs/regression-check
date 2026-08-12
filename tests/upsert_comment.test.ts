import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable mock state for @actions/github, set per-test.
const mockState: {
  prNumber: number | undefined;
  comments: Array<{ id: number; body: string }>;
  octokit: any;
} = {
  prNumber: 7,
  comments: [],
  octokit: null,
};

const MARKER = '<!-- decimalai-regression-check-comment -->';

vi.mock('@actions/github', () => {
  return {
    get context() {
      return {
        payload: { pull_request: { number: mockState.prNumber } },
        repo: { owner: 'acme', repo: 'agents' },
      };
    },
    getOctokit: () => mockState.octokit,
  };
});

import { upsertPrComment } from '../src/comment';

function makeOctokit(comments: Array<{ id: number; body: string }>) {
  const calls = {
    created: [] as any[],
    updated: [] as any[],
    deleted: [] as any[],
  };
  const octokit = {
    rest: {
      issues: {
        listComments: vi.fn(),
        createComment: vi.fn(async (a: any) => calls.created.push(a)),
        updateComment: vi.fn(async (a: any) => calls.updated.push(a)),
        deleteComment: vi.fn(async (a: any) => calls.deleted.push(a)),
      },
    },
    paginate: {
      // Async iterator that yields a single page of all comments.
      iterator: () => ({
        async *[Symbol.asyncIterator]() {
          yield { data: comments };
        },
      }),
    },
  };
  return { octokit, calls };
}

describe('upsertPrComment (update mode dedupe)', () => {
  beforeEach(() => {
    mockState.prNumber = 7;
    mockState.comments = [];
    mockState.octokit = null;
  });

  it('updates the most recent marked comment and deletes older duplicates after a new→update switch', async () => {
    // Simulate prior runs in comment-mode `new`: three of our marked comments
    // accumulated (oldest→newest, as listComments returns them), interleaved
    // with an unrelated comment.
    const comments = [
      { id: 101, body: `${MARKER}\nold verdict A` },
      { id: 102, body: 'a human said something' },
      { id: 103, body: `${MARKER}\nold verdict B` },
      { id: 104, body: `${MARKER}\nold verdict C` },
    ];
    const { octokit, calls } = makeOctokit(comments);
    mockState.octokit = octokit;

    await upsertPrComment({
      githubToken: 't',
      body: `${MARKER}\nfresh verdict`,
      mode: 'update',
    });

    // Most-recent marked comment (104) gets updated in place.
    expect(calls.updated).toHaveLength(1);
    expect(calls.updated[0].comment_id).toBe(104);
    expect(calls.updated[0].body).toContain('fresh verdict');

    // Older marked duplicates (103, 101) get deleted; the human comment (102)
    // is left untouched.
    expect(calls.deleted.map((d) => d.comment_id).sort((a, b) => a - b)).toEqual([
      101, 103,
    ]);

    // Nothing is freshly created when an existing comment was found.
    expect(calls.created).toHaveLength(0);
  });

  it('creates a new comment when none of ours exist yet', async () => {
    const { octokit, calls } = makeOctokit([
      { id: 200, body: 'unrelated' },
    ]);
    mockState.octokit = octokit;

    await upsertPrComment({
      githubToken: 't',
      body: `${MARKER}\nfirst verdict`,
      mode: 'update',
    });

    expect(calls.created).toHaveLength(1);
    expect(calls.updated).toHaveLength(0);
    expect(calls.deleted).toHaveLength(0);
  });

  it('updates a single existing comment with no deletes', async () => {
    const { octokit, calls } = makeOctokit([
      { id: 300, body: `${MARKER}\nold` },
    ]);
    mockState.octokit = octokit;

    await upsertPrComment({
      githubToken: 't',
      body: `${MARKER}\nnew`,
      mode: 'update',
    });

    expect(calls.updated).toHaveLength(1);
    expect(calls.updated[0].comment_id).toBe(300);
    expect(calls.deleted).toHaveLength(0);
    expect(calls.created).toHaveLength(0);
  });
});
