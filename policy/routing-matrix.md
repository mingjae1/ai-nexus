# Routing Matrix (Single Source)

Workers in this project: `claude-code`, `codex-cli`, `gemini-cli`.

## Performance mode

| Task | Primary model | CLI | Fallback model | Fallback CLI |
|------|--------------|-----|----------------|--------------|
| `code-gen-static` | gpt-5.4 | codex-cli | gemini-3-flash-preview | gemini-cli |
| `code-gen-agentic` | gpt-5.4 | codex-cli | gpt-5.3-codex | codex-cli |
| `code-gen-simple` | gemini-3-flash-preview | gemini-cli | gpt-5.3-codex | codex-cli |
| `analysis-large` | gemini-3.1-pro-preview | gemini-cli | gemini-2.5-pro | gemini-cli |
| `analysis-precision` | claude-opus-4.6 | claude-code | gpt-5.4 | codex-cli |
| `analysis-light` | gemini-3-flash-preview | gemini-cli | claude-sonnet-4.6 | claude-code |
| `review` | claude-opus-4.6 | claude-code | gpt-5.4 | codex-cli |
| `debug` | claude-opus-4.6 | claude-code | gpt-5.4 | codex-cli |
| `refactor` | claude-opus-4.6 | claude-code | gpt-5.4 | codex-cli |
| `architecture` | claude-opus-4.6 | claude-code | gpt-5.4 | codex-cli |
| `test` | gpt-5.3-codex | codex-cli | gemini-3-flash-preview | gemini-cli |
| `docs` | claude-opus-4.6 | claude-code | gemini-3-flash-preview | gemini-cli |
| `web-search` | gemini-3-flash-preview | gemini-cli | gpt-5.4 | codex-cli |
| `gitops` | gpt-5.3-codex | codex-cli | gemini-3-flash-preview | gemini-cli |
| `qa-simple` | claude-sonnet-4.6 | claude-code | gemini-3-flash-preview | gemini-cli |

## Economy mode

| Task | Primary model | CLI | Fallback model | Fallback CLI |
|------|--------------|-----|----------------|--------------|
| `code-gen-static` | gpt-5.3-codex | codex-cli | gemini-3-flash-preview | gemini-cli |
| `code-gen-agentic` | gpt-5.3-codex | codex-cli | gemini-3-flash-preview | gemini-cli |
| `code-gen-simple` | gemini-3-flash-preview | gemini-cli | gemini-2.5-flash-lite | gemini-cli |
| `analysis-large` | gemini-3.1-pro-preview | gemini-cli | gemini-2.5-pro | gemini-cli |
| `analysis-precision` | claude-sonnet-4.6 | claude-code | gpt-5.3-codex | codex-cli |
| `analysis-light` | gemini-3-flash-preview | gemini-cli | claude-sonnet-4.6 | claude-code |
| `review` | claude-sonnet-4.6 | claude-code | gemini-3-flash-preview | gemini-cli |
| `debug` | claude-sonnet-4.6 | claude-code | gpt-5.3-codex | codex-cli |
| `refactor` | claude-sonnet-4.6 | claude-code | gpt-5.3-codex | codex-cli |
| `architecture` | claude-sonnet-4.6 | claude-code | gpt-5.3-codex | codex-cli |
| `test` | gemini-2.5-flash-lite | gemini-cli | gpt-5.3-codex | codex-cli |
| `docs` | claude-sonnet-4.6 | claude-code | gemini-3-flash-preview | gemini-cli |
| `web-search` | gemini-3-flash-preview | gemini-cli | gemini-2.5-flash | gemini-cli |
| `gitops` | gpt-5.3-codex | codex-cli | gemini-3-flash-preview | gemini-cli |
| `qa-simple` | gemini-3-flash-preview | gemini-cli | claude-sonnet-4.6 | claude-code |
