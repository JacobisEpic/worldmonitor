// Regression coverage for #3753 — parseClassifyCacheHit, the runtime
// validator enrichWithAiCache runs on every getCachedJsonBatch hit before
// `level`/`category` reach a typed ParsedItem
// (server/worldmonitor/news/v1/list-feed-digest.ts).
//
// ParsedItem.category is declared `string`, but the LLM classify cache is
// Redis-backed JSON: `unwrapEnvelope(parsed).data` returns `unknown`, so a
// stale schema, unrelated payload, or hand-edited Redis value parses fine as
// JSON while carrying a non-string `category`. The pre-fix code cast the
// hit straight to `{ level?: string; category?: string }` and only checked
// truthiness (`!hit.category`) — a truthy non-string (a number, an object,
// an array) sailed through the assertion and got assigned onto
// `item.category` untyped. This asymmetry is exactly why
// buildStoryTrackHsetFields (list-feed-digest.ts:1161) needed a defensive
// `typeof item.category === 'string'` guard downstream — the type was never
// actually enforced at the point of assignment.
//
// parseClassifyCacheHit tightens the invariant at the cache-read boundary:
// it returns null unless BOTH `level` and `category` are actually strings,
// so a caller can never assign a non-string onto ParsedItem.category. Emptiness
// (a valid-shape hit with `category: ''`) is intentionally NOT rejected here
// — that stays enrichWithAiCache's `!hit.category` truthiness check, so this
// test file locks the split: shape-validation lives in the parser, value
// policy (empty/`_skip`) lives in the caller.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __testing__ } from '../server/worldmonitor/news/v1/list-feed-digest';

const { parseClassifyCacheHit } = __testing__;

describe('parseClassifyCacheHit — valid shapes', () => {
  it('valid string level + category → returns the pair unchanged', () => {
    assert.deepStrictEqual(
      parseClassifyCacheHit({ level: 'critical', category: 'conflict' }),
      { level: 'critical', category: 'conflict' },
    );
  });

  it('extra unrelated fields on the cache row do not block validation', () => {
    // The classify cache row may carry additional fields (confidence,
    // model, timestamp, ...) that ParsedItem doesn't need. Validation only
    // cares about level/category shape.
    assert.deepStrictEqual(
      parseClassifyCacheHit({ level: 'high', category: 'security', confidence: 0.87, model: 'x' }),
      { level: 'high', category: 'security' },
    );
  });

  it('`_skip` is a valid string shape — the sentinel check is the caller\'s job, not the parser\'s', () => {
    // enrichWithAiCache's `hit.level === '_skip'` check runs on the parsed
    // result. The validator must not special-case or reject the sentinel
    // itself, or that downstream check would never see it.
    assert.deepStrictEqual(
      parseClassifyCacheHit({ level: '_skip', category: 'general' }),
      { level: '_skip', category: 'general' },
    );
  });

  it('empty-string category is a valid shape (emptiness is a caller-side policy, not a shape violation)', () => {
    assert.deepStrictEqual(
      parseClassifyCacheHit({ level: 'info', category: '' }),
      { level: 'info', category: '' },
    );
  });

  it('empty-string level is a valid shape too', () => {
    assert.deepStrictEqual(
      parseClassifyCacheHit({ level: '', category: 'conflict' }),
      { level: '', category: 'conflict' },
    );
  });
});

describe('parseClassifyCacheHit — rejects malformed category', () => {
  it('missing category → null', () => {
    assert.strictEqual(parseClassifyCacheHit({ level: 'high' }), null);
  });

  it('numeric category → null (the exact #3753 failure shape)', () => {
    // Pre-fix: `!hit.category` on `42` is false (truthy), so the old code
    // let this through and assigned the number onto item.category.
    assert.strictEqual(parseClassifyCacheHit({ level: 'high', category: 42 }), null);
  });

  it('object category → null', () => {
    assert.strictEqual(
      parseClassifyCacheHit({ level: 'high', category: { name: 'conflict' } }),
      null,
    );
  });

  it('array category → null', () => {
    assert.strictEqual(parseClassifyCacheHit({ level: 'high', category: ['conflict'] }), null);
  });

  it('boolean category → null', () => {
    assert.strictEqual(parseClassifyCacheHit({ level: 'high', category: true }), null);
  });

  it('null category → null', () => {
    assert.strictEqual(parseClassifyCacheHit({ level: 'high', category: null }), null);
  });
});

describe('parseClassifyCacheHit — rejects malformed level', () => {
  it('missing level → null', () => {
    assert.strictEqual(parseClassifyCacheHit({ category: 'conflict' }), null);
  });

  it('numeric level → null', () => {
    assert.strictEqual(parseClassifyCacheHit({ level: 3, category: 'conflict' }), null);
  });

  it('object level → null', () => {
    assert.strictEqual(
      parseClassifyCacheHit({ level: { rank: 'critical' }, category: 'conflict' }),
      null,
    );
  });
});

describe('parseClassifyCacheHit — rejects malformed cache values wholesale', () => {
  it('undefined (cache miss) → null', () => {
    assert.strictEqual(parseClassifyCacheHit(undefined), null);
  });

  it('null → null', () => {
    assert.strictEqual(parseClassifyCacheHit(null), null);
  });

  it('a bare string (e.g. a legacy non-JSON-object cache row) → null', () => {
    assert.strictEqual(parseClassifyCacheHit('critical'), null);
  });

  it('a bare number → null', () => {
    assert.strictEqual(parseClassifyCacheHit(42), null);
  });

  it('a top-level array → null', () => {
    assert.strictEqual(parseClassifyCacheHit(['critical', 'conflict']), null);
  });

  it('an empty object → null', () => {
    assert.strictEqual(parseClassifyCacheHit({}), null);
  });
});
