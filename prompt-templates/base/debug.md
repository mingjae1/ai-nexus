[RADIT Phase Header]
Phase: {{PHASE}}
Owner: {{OWNER}}
Objective: {{TASK}}
---

Goal: Isolate and resolve defects with minimal blast radius.

Task:
{{TASK}}

Context:
{{CONTEXT}}

Input contract:
- Reproduction steps and observed/expected behavior are required.

Output format:
- Confirmed root cause.
- Minimal corrective patch strategy.
- Verification evidence after fix.

Quality gates:
- Fix addresses root cause, not symptom only.
- No regressions in adjacent flows.
- Error handling remains explicit.
