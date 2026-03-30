# RADIT 7-Phase Ownership

## Ownership
- `R`: Gemini (large-scale discovery and analysis)
- `A`: Gemini (A-phase lead)
- `D`: Claude (design owner)
- `I`: Codex (implementation executor)
- `T`: Codex/Gemini (verification)
- `S`: Claude (security review)
- `F`: Claude (final review)

## Handoff Rules
- Every handoff must include a `RADIT Phase Header` defined in `@policy/prompt-contract.md`.
- If `T` phase fails validation, escalate to `D` phase (`claude-code`) for redesign and re-handoff.
- Preserve traceability: each phase output must reference prior phase artifacts used as input.

## Copilot Positioning
- Copilot is outside RADIT ownership.
- Copilot role is limited to final user delivery and QA/gitops support tasks.
