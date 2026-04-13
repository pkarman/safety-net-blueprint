/**
 * Rules engine — pure logic, no Express or database dependencies.
 * Evaluates rule conditions using JSON Logic and returns matched actions.
 */

import jsonLogic from 'json-logic-js';

/**
 * Resolve a dot-notation path against an object.
 * @param {Object} obj - The object to traverse
 * @param {string} path - Dot-notation path (e.g., "subjectId", "application.caseId")
 * @returns {*} Resolved value, or undefined if not found
 */
export function resolvePath(obj, path) {
  return path.split('.').reduce((cur, key) => (cur != null ? cur[key] : undefined), obj);
}

/**
 * Build a context object for rule evaluation.
 * The calling resource is always available as "this".
 * Pre-resolved entities are merged in by alias.
 * @param {Object} resource - The primary resource being evaluated
 * @param {Object} resolvedEntities - Pre-fetched entities keyed by alias (e.g., { application: {...} })
 * @returns {Object} Context object for rule evaluation
 */
export function buildRuleContext(resource, resolvedEntities = {}) {
  return { this: { ...resource }, ...resolvedEntities };
}

/**
 * Evaluate a ruleSet against context data. Uses first-match-wins semantics.
 * @param {Object} ruleSet - RuleSet definition with rules array
 * @param {Object} contextData - Context object built by buildRuleContext
 * @returns {{ matched: boolean, ruleId?: string, action?: Object, fallbackAction?: Object }}
 */
export function evaluateRuleSet(ruleSet, contextData) {
  if (!ruleSet || !ruleSet.rules) {
    return { matched: false };
  }

  // Sort rules by order to ensure correct evaluation sequence
  const sortedRules = [...ruleSet.rules].sort((a, b) => a.order - b.order);

  for (const rule of sortedRules) {
    let conditionMet = false;

    if (rule.condition === true) {
      // Catch-all rule — always matches
      conditionMet = true;
    } else {
      // Evaluate JSON Logic condition
      try {
        conditionMet = jsonLogic.apply(rule.condition, contextData);
      } catch (err) {
        console.warn(`Rule "${rule.id}" condition evaluation failed: ${err.message}`);
        continue;
      }
    }

    if (conditionMet) {
      return {
        matched: true,
        ruleId: rule.id,
        action: rule.action,
        fallbackAction: rule.fallbackAction || null
      };
    }
  }

  return { matched: false };
}
