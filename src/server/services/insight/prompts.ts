/**
 * Prompt templates for insight validation via LLM.
 */

export const VALIDATE_INSIGHT_PROMPT = `You are an analytical assistant. Evaluate the following correlation between two entities.

Entity A: {{entityA}}
Entity B: {{entityB}}
Domain: {{domain}}
Signal score: {{score}}
Context: these entities co-occur in {{coCount}} shared data points.

Respond with JSON ONLY:
{
  "is_valid": true/false,
  "confidence": 0.0-1.0,
  "causal_direction": "entityA -> entityB" or "entityB -> entityA" or "bidirectional" or "none",
  "conversational_summary": "One sentence explaining the relationship"
}`;

export const CAUSAL_CHAIN_PROMPT = `You are an analytical assistant. Check whether the following transitive causal chain is valid.

Chain: {{chain}}
Context: each individual link has a confidence >= 0.7.

Respond with JSON ONLY:
{
  "is_valid": true/false,
  "confidence": 0.0-1.0,
  "conversational_summary": "One sentence explaining the whole chain"
}`;

export function buildValidatePrompt(
  entityA: string,
  entityB: string,
  domain: string,
  score: number,
  coCount: number,
): string {
  return VALIDATE_INSIGHT_PROMPT
    .replace('{{entityA}}', entityA)
    .replace('{{entityB}}', entityB)
    .replace('{{domain}}', domain)
    .replace('{{score}}', score.toFixed(2))
    .replace('{{coCount}}', String(coCount));
}

export function buildCausalChainPrompt(chain: string): string {
  return CAUSAL_CHAIN_PROMPT.replace('{{chain}}', chain);
}
