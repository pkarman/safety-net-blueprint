/**
 * Unit tests for action handlers
 * Tests action execution, queue assignment, and priority setting
 */

import { test } from 'node:test';
import assert from 'node:assert';
import { executeActions } from '../../src/action-handlers.js';

// =============================================================================
// setPriority
// =============================================================================

test('executeActions — setPriority sets priority field', () => {
  const resource = {};
  executeActions({ setPriority: 'expedited' }, resource, {});
  assert.strictEqual(resource.priority, 'expedited');
});

test('executeActions — setPriority overwrites existing priority', () => {
  const resource = { priority: 'low' };
  executeActions({ setPriority: 'high' }, resource, {});
  assert.strictEqual(resource.priority, 'high');
});

// =============================================================================
// assignToQueue
// =============================================================================

test('executeActions — assignToQueue sets queueId from looked-up queue', () => {
  const resource = {};
  const deps = {
    findByField: (collection, field, value) => {
      if (collection === 'queues' && field === 'name' && value === 'snap-intake') {
        return { id: 'queue-uuid-1', name: 'snap-intake' };
      }
      return null;
    }
  };
  executeActions({ assignToQueue: 'snap-intake' }, resource, deps);
  assert.strictEqual(resource.queueId, 'queue-uuid-1');
});

test('executeActions — assignToQueue uses fallback when queue not found', () => {
  const resource = {};
  const deps = {
    findByField: (collection, field, value) => {
      if (value === 'general-intake') {
        return { id: 'queue-uuid-2', name: 'general-intake' };
      }
      return null;
    }
  };
  const fallbackAction = { assignToQueue: 'general-intake' };
  executeActions({ assignToQueue: 'nonexistent' }, resource, deps, fallbackAction);
  assert.strictEqual(resource.queueId, 'queue-uuid-2');
});

test('executeActions — assignToQueue does nothing when queue and fallback not found', () => {
  const resource = {};
  const deps = {
    findByField: () => null
  };
  executeActions({ assignToQueue: 'nonexistent' }, resource, deps);
  assert.strictEqual(resource.queueId, undefined);
});

// =============================================================================
// Multiple actions
// =============================================================================

test('executeActions — processes multiple actions in one call', () => {
  const resource = {};
  const deps = {
    findByField: (collection, field, value) => {
      if (value === 'snap-intake') {
        return { id: 'queue-uuid-1', name: 'snap-intake' };
      }
      return null;
    }
  };
  executeActions({ assignToQueue: 'snap-intake', setPriority: 'expedited' }, resource, deps);
  assert.strictEqual(resource.queueId, 'queue-uuid-1');
  assert.strictEqual(resource.priority, 'expedited');
});

test('executeActions — handles null action gracefully', () => {
  const resource = { priority: 'normal' };
  executeActions(null, resource, {});
  assert.strictEqual(resource.priority, 'normal');
});

test('executeActions — skips unknown action types', () => {
  const resource = {};
  executeActions({ unknownAction: 'value' }, resource, {});
  assert.strictEqual(Object.keys(resource).length, 0);
});

// =============================================================================
// forEach
// =============================================================================

function makeForEachDeps(created) {
  return {
    context: {
      this: { id: 'event-1' },
      members: [
        { id: 'member-1', programs: ['snap'] },
        { id: 'member-2', programs: ['medicaid'] }
      ]
    },
    dbCreate(collection, fields) {
      const record = { id: `new-${created.length}`, ...fields };
      created.push({ collection, fields: { ...fields } });
      return record;
    },
    dbUpdate() {},
    findStateMachine: () => null,
    emitCreatedEvent: () => {}
  };
}

test('executeActions — forEach creates resource for each item in collection', () => {
  const created = [];
  executeActions(
    {
      forEach: {
        in: { var: 'members' },
        as: 'member',
        createResource: {
          entity: 'workflow/tasks',
          fields: { memberId: { var: 'member.id' }, status: 'pending' }
        }
      }
    },
    {},
    makeForEachDeps(created)
  );
  assert.strictEqual(created.length, 2);
  assert.strictEqual(created[0].fields.memberId, 'member-1');
  assert.strictEqual(created[1].fields.memberId, 'member-2');
});

test('executeActions — forEach filter excludes non-matching items', () => {
  const created = [];
  executeActions(
    {
      forEach: {
        in: { var: 'members' },
        as: 'member',
        filter: { in: ['snap', { var: 'member.programs' }] },
        createResource: {
          entity: 'workflow/tasks',
          fields: { memberId: { var: 'member.id' }, status: 'pending' }
        }
      }
    },
    {},
    makeForEachDeps(created)
  );
  // Only member-1 has snap
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].fields.memberId, 'member-1');
});

test('executeActions — forEach with empty collection executes no actions', () => {
  const created = [];
  const deps = { ...makeForEachDeps(created), context: { this: {}, members: [] } };
  executeActions(
    {
      forEach: {
        in: { var: 'members' },
        as: 'member',
        createResource: { entity: 'workflow/tasks', fields: { memberId: { var: 'member.id' } } }
      }
    },
    {},
    deps
  );
  assert.strictEqual(created.length, 0);
});
