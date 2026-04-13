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

test('resolvePath — resolves single-segment path (strips namespace)', () => {
  const resource = { subjectId: 'app-1', status: 'pending' };
  assert.strictEqual(resolvePath(resource, 'task.subjectId'), 'app-1');
});

test('resolvePath — resolves nested path', () => {
  const resource = { meta: { county: 'alameda' } };
  assert.strictEqual(resolvePath(resource, 'task.meta.county'), 'alameda');
});

test('resolvePath — returns undefined for missing field', () => {
  const resource = { status: 'pending' };
  assert.strictEqual(resolvePath(resource, 'task.subjectId'), undefined);
});

test('resolvePath — handles path with no namespace', () => {
  const resource = { subjectId: 'app-1' };
  assert.strictEqual(resolvePath(resource, 'subjectId'), 'app-1');
});

// =============================================================================
// buildRuleContext
// =============================================================================

test('buildRuleContext — builds context from task.* binding', () => {
  const resource = { id: 'task-1', programType: 'snap', isExpedited: true };
  const context = buildRuleContext(['task.*'], resource);
  assert.deepStrictEqual(context, { task: { id: 'task-1', programType: 'snap', isExpedited: true } });
});

test('buildRuleContext — handles multiple bindings', () => {
  const resource = { id: 'task-1', status: 'pending' };
  const context = buildRuleContext(['task.*', 'item.*'], resource);
  assert.deepStrictEqual(context.task, { id: 'task-1', status: 'pending' });
  assert.deepStrictEqual(context.item, { id: 'task-1', status: 'pending' });
});

test('buildRuleContext — handles null/empty bindings', () => {
  const resource = { id: 'task-1' };
  assert.deepStrictEqual(buildRuleContext(null, resource), {});
  assert.deepStrictEqual(buildRuleContext([], resource), {});
});

test('buildRuleContext — merges resolvedEntities into context', () => {
  const resource = { id: 'task-1', subjectId: 'app-1' };
  const resolvedEntities = { application: { id: 'app-1', programs: ['snap'] } };
  const context = buildRuleContext(['task.*'], resource, resolvedEntities);
  assert.deepStrictEqual(context.task, { id: 'task-1', subjectId: 'app-1' });
  assert.deepStrictEqual(context.application, { id: 'app-1', programs: ['snap'] });
});

test('buildRuleContext — object-form bindings are ignored (resolved by caller)', () => {
  const resource = { id: 'task-1' };
  const binding = { as: 'application', entity: 'applications', from: 'task.subjectId' };
  // Object-form bindings are not processed here — no error, just ignored
  const context = buildRuleContext([binding], resource);
  assert.deepStrictEqual(context, {});
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
  const context = {
    task: { id: 'task-1', subjectId: 'app-1' },
    application: { id: 'app-1', programs: ['snap', 'medicaid'] }
  };
  const result = evaluateRuleSet(ruleSet, context);
  assert.strictEqual(result.matched, true);
  assert.strictEqual(result.ruleId, 'snap-rule');
});

// =============================================================================
// evaluateRuleSet — matching conditions
// =============================================================================

test('evaluateRuleSet — matches JSON Logic condition', () => {
  const ruleSet = {
    rules: [
      {
        id: 'rule-1',
        order: 1,
        condition: { '==': [{ var: 'task.programType' }, 'snap'] },
        action: { assignToQueue: 'snap-intake' }
      }
    ]
  };
  const context = { task: { programType: 'snap' } };
  const result = evaluateRuleSet(ruleSet, context);
  assert.strictEqual(result.matched, true);
  assert.strictEqual(result.ruleId, 'rule-1');
  assert.deepStrictEqual(result.action, { assignToQueue: 'snap-intake' });
});

test('evaluateRuleSet — non-matching condition returns matched:false', () => {
  const ruleSet = {
    rules: [
      {
        id: 'rule-1',
        order: 1,
        condition: { '==': [{ var: 'task.programType' }, 'snap'] },
        action: { assignToQueue: 'snap-intake' }
      }
    ]
  };
  const context = { task: { programType: 'tanf' } };
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
  const result = evaluateRuleSet(ruleSet, { task: { programType: 'tanf' } });
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
        condition: { '==': [{ var: 'task.programType' }, 'snap'] },
        action: { assignToQueue: 'snap-intake' }
      }
    ]
  };
  const context = { task: { programType: 'snap' } };
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
  const result = evaluateRuleSet(ruleSet, {});
  assert.strictEqual(result.matched, true);
  assert.deepStrictEqual(result.fallbackAction, { assignToQueue: 'general-intake' });
});

test('evaluateRuleSet — handles null/empty ruleSet', () => {
  assert.deepStrictEqual(evaluateRuleSet(null, {}), { matched: false });
  assert.deepStrictEqual(evaluateRuleSet({}, {}), { matched: false });
  assert.deepStrictEqual(evaluateRuleSet({ rules: [] }, {}), { matched: false });
});

test('evaluateRuleSet — boolean equality with isExpedited', () => {
  const ruleSet = {
    rules: [
      {
        id: 'expedited',
        order: 1,
        condition: { '==': [{ var: 'task.isExpedited' }, true] },
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

  const expedited = evaluateRuleSet(ruleSet, { task: { isExpedited: true } });
  assert.strictEqual(expedited.ruleId, 'expedited');

  const normal = evaluateRuleSet(ruleSet, { task: { isExpedited: false } });
  assert.strictEqual(normal.ruleId, 'default');
});
