# Routing Matrix (Single Source)

Workers in this project: `gemini-cli`, `claude-code`.

## Performance mode

| Task | Primary model | CLI | Fallback model | Fallback CLI |
|------|--------------|-----|----------------|--------------|
| `code-gen-static` | claude-opus-4.6 | claude-code | gemini-2.5-pro | gemini-cli |
| `code-gen-agentic` | [self-execute] | — | claude-opus-4.6 | claude-code |
| `code-gen-simple` | claude-sonnet-4.6 | claude-code | gemini-2.5-flash | gemini-cli |
| `analysis-large` | gemini-3.1-pro | gemini-cli | gemini-2.5-pro | gemini-cli |
| `analysis-precision` | claude-opus-4.6 | claude-code | gemini-2.5-pro | gemini-cli |
| `analysis-light` | gemini-2.5-pro | gemini-cli | claude-sonnet-4.6 | claude-code |
| `review` | claude-opus-4.6 | claude-code | gemini-2.5-pro | gemini-cli |
| `debug` | claude-opus-4.6 | claude-code | gemini-2.5-pro | gemini-cli |
| `refactor` | claude-opus-4.6 | claude-code | gemini-2.5-pro | gemini-cli |
| `architecture` | claude-opus-4.6 | claude-code | gemini-2.5-pro | gemini-cli |
| `test` | claude-sonnet-4.6 | claude-code | gemini-2.5-flash | gemini-cli |
| `docs` | gemini-3.1-pro | gemini-cli | claude-opus-4.6 | claude-code |
| `web-search` | gemini-3.1-pro | gemini-cli | claude-opus-4.6 | claude-code |
| `gitops` | claude-sonnet-4.6 | claude-code | gemini-2.5-flash | gemini-cli |
| `qa-simple` | gemini-2.5-flash | gemini-cli | claude-sonnet-4.6 | claude-code |

## Economy mode

| Task | Primary model | CLI | Fallback model | Fallback CLI |
|------|--------------|-----|----------------|--------------|
| `code-gen-static` | claude-sonnet-4.6 | claude-code | gemini-2.5-pro | gemini-cli |
| `code-gen-agentic` | [self-execute] | — | gemini-2.5-flash | gemini-cli |
| `code-gen-simple` | claude-sonnet-4.6 | claude-code | gemini-2.5-flash-lite | gemini-cli |
| `analysis-large` | gemini-3.1-pro | gemini-cli | gemini-2.5-pro | gemini-cli |
| `analysis-precision` | claude-sonnet-4.6 | claude-code | gemini-2.5-pro | gemini-cli |
| `analysis-light` | gemini-2.5-flash | gemini-cli | claude-sonnet-4.6 | claude-code |
| `review` | gemini-2.5-flash | gemini-cli | claude-sonnet-4.6 | claude-code |
| `debug` | claude-sonnet-4.6 | claude-code | gemini-2.5-flash | gemini-cli |
| `refactor` | claude-sonnet-4.6 | claude-code | gemini-2.5-flash | gemini-cli |
| `architecture` | claude-sonnet-4.6 | claude-code | gemini-2.5-pro | gemini-cli |
| `test` | gemini-2.5-flash-lite | gemini-cli | claude-sonnet-4.6 | claude-code |
| `docs` | gemini-3-flash | gemini-cli | gemini-2.5-flash-lite | gemini-cli |
| `web-search` | gemini-3-flash | gemini-cli | gemini-2.5-flash | gemini-cli |
| `gitops` | claude-sonnet-4.6 | claude-code | gemini-2.5-flash | gemini-cli |
| `qa-simple` | gemini-2.5-flash | gemini-cli | claude-sonnet-4.6 | claude-code |
