# Prompt Contract

## Output Template
```text
[{MODE} mode] {task_type}
Model: {model_name} via {cli_name}
Reason: {one-line justification}
---
{result}
```

## RADIT Phase Header Format
```text
[RADIT Phase Header]
Phase: {R|A|D|I|T|S|F}
Owner: {gemini-cli|claude-code|codex-cli}
Handoff-To: {gemini-cli|claude-code|codex-cli|user}
Objective: {one-line objective}
```

## Encoding Requirement
- All policy, contract, and prompt-template files must be saved as UTF-8 with BOM.
- Any non-BOM UTF-8 file is considered non-compliant and must be rewritten.
