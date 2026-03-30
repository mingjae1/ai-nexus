[RADIT Phase Header]
Phase: {{PHASE}}
Owner: {{OWNER}}
Objective: {{TASK}}
---

Goal: Identify correctness, security, and maintainability risks.

Task:
{{TASK}}

Context:
{{CONTEXT}}

Input contract:
- Prioritize concrete defects over style preferences.

Output format:
- Findings first, ordered by severity.
- Each finding includes location, impact, and fix direction.
- Residual risks and test gaps listed last.

Quality gates:
- Evidence-backed and reproducible findings.
- No false certainty; note assumptions.
- Recommendations are proportionate to risk.
