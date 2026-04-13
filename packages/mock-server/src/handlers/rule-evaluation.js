/**
 * Shared helper for processing pending rule evaluations.
 * Used by both the transition handler and create handler.
 */

import { findAll, findById } from '../database-manager.js';
import { findRuleSet } from '../rules-loader.js';
import { buildRuleContext, evaluateRuleSet, resolvePath } from '../rules-engine.js';
import { executeActions } from '../action-handlers.js';

/**
 * Build the dependencies object for action handlers.
 * Provides database lookup functions without exposing the DB layer directly.
 * @returns {Object} Dependencies object
 */
function buildDependencies() {
  return {
    findByField(collection, field, value) {
      const { items } = findAll(collection, { [field]: value }, { limit: 1 });
      return items.length > 0 ? items[0] : null;
    }
  };
}

/**
 * Resolve object-form context bindings by fetching related entities from the database.
 * Only object-form bindings (with `as`, `entity`, `from`) are resolved here;
 * string-form bindings are handled by buildRuleContext.
 * @param {Array} contextBindings - Mixed string/object binding array from the rules file
 * @param {Object} resource - The primary resource being evaluated
 * @returns {Object} Map of alias → fetched entity (e.g., { application: {...} })
 */
function resolveContextEntities(contextBindings, resource) {
  const resolved = {};
  for (const binding of contextBindings || []) {
    if (typeof binding !== 'object' || !binding.as || !binding.entity || !binding.from) continue;

    const entityId = resolvePath(resource, binding.from);
    if (!entityId) {
      console.warn(`Context binding "${binding.as}": could not resolve "${binding.from}" on resource`);
      continue;
    }

    const entity = findById(binding.entity, entityId);
    if (!entity) {
      console.warn(`Context binding "${binding.as}": entity "${binding.entity}" with id "${entityId}" not found`);
      continue;
    }

    resolved[binding.as] = entity;
  }
  return resolved;
}

/**
 * Process pending rule evaluations against a resource.
 * Mutates the resource with action results (e.g., sets queueId, priority).
 * @param {Array<{ ruleType: string }>} pendingRuleEvaluations - Rule evaluations to process
 * @param {Object} resource - Resource to mutate
 * @param {Array} rules - All loaded rules from discoverRules()
 * @param {string} domain - Domain name (e.g., "workflow")
 */
export function processRuleEvaluations(pendingRuleEvaluations, resource, rules, domain) {
  if (!pendingRuleEvaluations || pendingRuleEvaluations.length === 0 || !rules) return;

  const deps = buildDependencies();

  for (const { ruleType } of pendingRuleEvaluations) {
    const found = findRuleSet(rules, domain, ruleType);
    if (!found) continue;

    const { ruleSet, context: contextBindings } = found;
    const resolvedEntities = resolveContextEntities(contextBindings, resource);
    const contextData = buildRuleContext(contextBindings, resource, resolvedEntities);
    const result = evaluateRuleSet(ruleSet, contextData);

    if (result.matched) {
      executeActions(result.action, resource, deps, result.fallbackAction);
    }
  }
}
