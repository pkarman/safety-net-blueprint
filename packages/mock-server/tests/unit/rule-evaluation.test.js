/**
 * Unit tests for rule-evaluation — specifically the context enrichment path
 * (resolveContextEntities + processRuleEvaluations with per-ruleSet context bindings).
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { insertResource, clearAll } from '../../src/database-manager.js';
import { processRuleEvaluations } from '../../src/handlers/rule-evaluation.js';

// =============================================================================
// Helpers
// =============================================================================

function makeRules(contextBindings, condition, action) {
  return [
    {
      domain: 'workflow',
      ruleSets: [
        {
          id: 'test-ruleset',
          ruleType: 'assignment',
          evaluation: 'first-match-wins',
          context: contextBindings,
          rules: [
            { id: 'rule-1', order: 1, condition, action },
            { id: 'catch-all', order: 2, condition: true, action: { assignToQueue: 'general-intake' } }
          ]
        }
      ]
    }
  ];
}

function seedQueues() {
  clearAll('queues');
  insertResource('queues', { id: 'q-snap', name: 'snap-intake' });
  insertResource('queues', { id: 'q-general', name: 'general-intake' });
  insertResource('queues', { id: 'q-alameda', name: 'alameda-intake' });
}

// =============================================================================
// Context binding — happy path
// =============================================================================

test('processRuleEvaluations — context binding resolves entity and makes fields available', () => {
  clearAll('applications');
  clearAll('tasks');
  seedQueues();

  insertResource('applications', { id: 'app-1', programs: ['snap'] });
  const task = { id: 'task-1', subjectId: 'app-1', queueId: null };

  const rules = makeRules(
    [{ as: 'application', entity: 'intake/applications', from: 'subjectId' }],
    { in: ['snap', { var: 'application.programs' }] },
    { assignToQueue: 'snap-intake' }
  );

  processRuleEvaluations([{ ruleType: 'assignment' }], task, rules, 'workflow');
  assert.strictEqual(task.queueId, 'q-snap');
});

// =============================================================================
// Context binding — error: entity not found → skip rule set
// =============================================================================

test('processRuleEvaluations — entity not found skips rule set entirely', () => {
  clearAll('applications');
  clearAll('tasks');
  seedQueues();

  // Application with this ID does not exist in the DB
  const task = { id: 'task-1', subjectId: 'nonexistent', queueId: null };

  const rules = makeRules(
    [{ as: 'application', entity: 'intake/applications', from: 'subjectId' }],
    { in: ['snap', { var: 'application.programs' }] },
    { assignToQueue: 'snap-intake' }
  );

  // Rule set skipped — queueId stays null (no fallback fires)
  processRuleEvaluations([{ ruleType: 'assignment' }], task, rules, 'workflow');
  assert.strictEqual(task.queueId, null);
});

// =============================================================================
// Context binding — warning: from field missing → skip binding, rule set continues
// =============================================================================

test('processRuleEvaluations — missing from field value skips binding but rule set continues', () => {
  clearAll('applications');
  clearAll('tasks');
  seedQueues();

  const task = { id: 'task-1', queueId: null }; // no subjectId

  const rules = makeRules(
    [{ as: 'application', entity: 'intake/applications', from: 'subjectId' }],
    { in: ['snap', { var: 'application.programs' }] },
    { assignToQueue: 'snap-intake' }
  );

  // application not resolved (no subjectId) — snap condition fails — catch-all fires
  processRuleEvaluations([{ ruleType: 'assignment' }], task, rules, 'workflow');
  assert.strictEqual(task.queueId, 'q-general');
});

// =============================================================================
// Chaining — from path references a previously resolved entity
// =============================================================================

test('processRuleEvaluations — chained binding resolves entity via prior resolved entity field', () => {
  clearAll('applications');
  clearAll('cases');
  clearAll('tasks');
  seedQueues();

  insertResource('applications', { id: 'app-1', programs: ['snap'], caseId: 'case-99' });
  insertResource('cases', { id: 'case-99', county: 'alameda' });
  const task = { id: 'task-1', subjectId: 'app-1', queueId: null };

  const rules = makeRules(
    [
      { as: 'application', entity: 'intake/applications', from: 'subjectId' },
      { as: 'case', entity: 'case-management/cases', from: 'application.caseId' }
    ],
    { '==': [{ var: 'case.county' }, 'alameda'] },
    { assignToQueue: 'alameda-intake' }
  );

  processRuleEvaluations([{ ruleType: 'assignment' }], task, rules, 'workflow');
  assert.strictEqual(task.queueId, 'q-alameda');
});

// =============================================================================
// "this" alias — calling resource fields accessible via this.*
// =============================================================================

test('processRuleEvaluations — calling resource fields accessible as "this.*" in conditions', () => {
  clearAll('tasks');
  seedQueues();

  const task = { id: 'task-1', isExpedited: false, queueId: null };

  const rules = [
    {
      domain: 'workflow',
      ruleSets: [
        {
          id: 'test-priority',
          ruleType: 'assignment',
          evaluation: 'first-match-wins',
          rules: [
            {
              id: 'expedited',
              order: 1,
              condition: { '==': [{ var: 'this.isExpedited' }, true] },
              action: { assignToQueue: 'snap-intake' }
            },
            { id: 'catch-all', order: 2, condition: true, action: { assignToQueue: 'general-intake' } }
          ]
        }
      ]
    }
  ];

  processRuleEvaluations([{ ruleType: 'assignment' }], task, rules, 'workflow');
  assert.strictEqual(task.queueId, 'q-general'); // isExpedited false → catch-all

  task.isExpedited = true;
  task.queueId = null;
  processRuleEvaluations([{ ruleType: 'assignment' }], task, rules, 'workflow');
  assert.strictEqual(task.queueId, 'q-snap'); // isExpedited true → snap-intake
});
