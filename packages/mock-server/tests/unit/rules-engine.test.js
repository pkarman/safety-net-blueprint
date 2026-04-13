/**
 * Unit tests for the rules engine
 * Tests rule condition evaluation and context building
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { evaluateRuleSet, buildRuleContext, resolvePath } from '../../src/rules-engine.js';

// =============================================================================
// resolvePath
// =============================================================================

test('resolvePath — resolves single-segment path', () => {
  const resource = { subjectId: 'app-1', status: 'pending' };
  assert.strictEqual(resolvePath(resource, 'subjectId'), 'app-1');
});

test('resolvePath — resolves nested path', () => {
  const resource = { meta: { county: 'alameda' } };
  assert.strictEqual(resolvePath(resource, 'meta.county'), 'alameda');
});

test('resolvePath — resolves path across resolved entity (chaining)', () => {
  const context = { subjectId: 'app-1', application: { caseId: 'case-99' } };
  assert.strictEqual(resolvePath(context, 'application.caseId'), 'case-99');
});

test('resolvePath — returns undefined for missing field', () => {
  const resource = { status: 'pending' };
  assert.strictEqual(resolvePath(resource, 'subjectId'), undefined);
});

// =============================================================================
// buildRuleContext
// =============================================================================

test('buildRuleContext — calling resource available as "this"', () => {
  const resource = { id: 'task-1', isExpedited: true };
  const context = buildRuleContext(resource);
  assert.deepStrictEqual(context, { this: { id: 'task-1', isExpedited: true } });
});

test('buildRuleContext — merges resolvedEntities alongside "this"', () => {
  const resource = { id: 'task-1', subjectId: 'app-1' };
  const resolvedEntities = { application: { id: 'app-1', programs: ['snap'] } };
  const context = buildRuleContext(resource, resolvedEntities);
  assert.deepStrictEqual(context.this, { id: 'task-1', subjectId: 'app-1' });
  assert.deepStrictEqual(context.application, { id: 'app-1', programs: ['snap'] });
});

test('buildRuleContext — handles empty resolvedEntities', () => {
  const resource = { id: 'task-1' };
  assert.deepStrictEqual(buildRuleContext(resource, {}), { this: { id: 'task-1' } });
  assert.deepStrictEqual(buildRuleContext(resource), { this: { id: 'task-1' } });
});

// =============================================================================
// evaluateRuleSet — conditions using "this" alias
// =============================================================================

test('evaluateRuleSet — condition references calling resource via "this"', () => {
  const ruleSet = {
    rules: [
      {
        id: 'expedited',
        order: 1,
        condition: { '==': [{ var: 'this.isExpedited' }, true] },
        action: { setPriority: 'expedited' }
      }
    ]
  };
  const context = buildRuleContext({ id: 'task-1', isExpedited: true });
  const result = evaluateRuleSet(ruleSet, context);
  assert.strictEqual(result.matched, true);
  assert.strictEqual(result.ruleId, 'expedited');
});

test('evaluateRuleSet — condition references resolved entity field', () => {
  const ruleSet = {
    rules: [
      {
        id: 'snap-rule',
        order: 1,
        condition: { in: ['snap', { var: 'application.programs' }] },
        action: { assignToQueue: 'snap-intake' }
      }
    ]
  };
  const context = buildRuleContext(
    { id: 'task-1', subjectId: 'app-1' },
    { application: { id: 'app-1', programs: ['snap', 'medicaid'] } }
  );
  const result = evaluateRuleSet(ruleSet, context);
  assert.strictEqual(result.matched, true);
  assert.strictEqual(result.ruleId, 'snap-rule');
});

// =============================================================================
// evaluateRuleSet — matching conditions
// =============================================================================

test('evaluateRuleSet — non-matching condition returns matched:false', () => {
  const ruleSet = {
    rules: [
      {
        id: 'rule-1',
        order: 1,
        condition: { '==': [{ var: 'this.isExpedited' }, true] },
        action: { setPriority: 'expedited' }
      }
    ]
  };
  const context = buildRuleContext({ isExpedited: false });
  const result = evaluateRuleSet(ruleSet, context);
  assert.strictEqual(result.matched, false);
});

test('evaluateRuleSet — catch-all with condition: true', () => {
  const ruleSet = {
    rules: [
      {
        id: 'catch-all',
        order: 1,
        condition: true,
        action: { assignToQueue: 'general-intake' }
      }
    ]
  };
  const result = evaluateRuleSet(ruleSet, buildRuleContext({ id: 'task-1' }));
  assert.strictEqual(result.matched, true);
  assert.strictEqual(result.ruleId, 'catch-all');
  assert.deepStrictEqual(result.action, { assignToQueue: 'general-intake' });
});

test('evaluateRuleSet — first-match-wins order', () => {
  const ruleSet = {
    rules: [
      {
        id: 'catch-all',
        order: 2,
        condition: true,
        action: { assignToQueue: 'general-intake' }
      },
      {
        id: 'snap-rule',
        order: 1,
        condition: { in: ['snap', { var: 'application.programs' }] },
        action: { assignToQueue: 'snap-intake' }
      }
    ]
  };
  const context = buildRuleContext(
    { id: 'task-1' },
    { application: { programs: ['snap'] } }
  );
  const result = evaluateRuleSet(ruleSet, context);
  // Should match snap-rule (order 1) even though catch-all is listed first
  assert.strictEqual(result.ruleId, 'snap-rule');
});

test('evaluateRuleSet — returns fallbackAction when present', () => {
  const ruleSet = {
    rules: [
      {
        id: 'rule-1',
        order: 1,
        condition: true,
        action: { assignToQueue: 'snap-intake' },
        fallbackAction: { assignToQueue: 'general-intake' }
      }
    ]
  };
  const result = evaluateRuleSet(ruleSet, buildRuleContext({}));
  assert.strictEqual(result.matched, true);
  assert.deepStrictEqual(result.fallbackAction, { assignToQueue: 'general-intake' });
});

test('evaluateRuleSet — handles null/empty ruleSet', () => {
  assert.deepStrictEqual(evaluateRuleSet(null, {}), { matched: false });
  assert.deepStrictEqual(evaluateRuleSet({}, {}), { matched: false });
  assert.deepStrictEqual(evaluateRuleSet({ rules: [] }, {}), { matched: false });
});

test('evaluateRuleSet — boolean equality with isExpedited via "this"', () => {
  const ruleSet = {
    rules: [
      {
        id: 'expedited',
        order: 1,
        condition: { '==': [{ var: 'this.isExpedited' }, true] },
        action: { setPriority: 'expedited' }
      },
      {
        id: 'default',
        order: 2,
        condition: true,
        action: { setPriority: 'normal' }
      }
    ]
  };

  const expedited = evaluateRuleSet(ruleSet, buildRuleContext({ isExpedited: true }));
  assert.strictEqual(expedited.ruleId, 'expedited');

  const normal = evaluateRuleSet(ruleSet, buildRuleContext({ isExpedited: false }));
  assert.strictEqual(normal.ruleId, 'default');
});
