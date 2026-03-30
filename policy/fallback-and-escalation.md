# Fallback And Escalation

## Fallback Triggers
- HTTP `429` (rate limit): switch immediately to fallback model/CLI.
- Response latency exceeds 30 seconds: switch immediately.
- Incomplete result repeats 3 times: escalate to higher-tier model.

## Escalation Rules
- If primary route fails, execute the configured fallback route.
- If both primary and fallback fail, report `ROUTING_BLOCKED` with error context.
- `T`-phase validation failure must escalate to `D`-phase (`claude-code`) for redesign.
- Respect user explicit override for model/CLI unless impossible, then report constraint and next valid route.

## Context-Size Guardrails
- Input >200K tokens: route to `gemini-3.1-pro-preview`.
- Input >272K tokens: never route to GPT-5.4/self-execute paths; force `gemini-3.1-pro-preview`.
