# Routing Matrix (Single Source)

Workers in this project: `claude-code`, `codex-cli`, `gemini-cli`.

## Routing Philosophy

CLI 전문성을 우선 기준으로 사용하고, 모드는 같은 전문성 내에서 등급을 조절한다.
- **codex-cli**: 코드 생성·실행·테스트 — 에이전틱 코드 작업에 특화
- **gemini-cli**: 대용량 컨텍스트·웹 검색·빠른 응답 — 검색/문서/빠른 조회에 특화
- **claude-code**: 정밀 추론·설계·보안 리뷰 — 깊은 이해와 판단이 필요한 작업에 특화

모드의 역할:
- **performance**: 각 작업에 가장 적합한 전문 모델 사용 (비용 무시)
- **economy**: 같은 전문 CLI 내에서 한 단계 저렴한 모델로 교체

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
| `docs` | gemini-3.1-pro-preview | gemini-cli | claude-sonnet-4.6 | claude-code |
| `web-search` | gemini-3-flash-preview | gemini-cli | gpt-5.4 | codex-cli |
| `gitops` | gpt-5.3-codex | codex-cli | gemini-3-flash-preview | gemini-cli |
| `qa-simple` | gemini-3-flash-preview | gemini-cli | claude-sonnet-4.6 | claude-code |

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
| `debug` | gpt-5.3-codex | codex-cli | gemini-3-flash-preview | gemini-cli |
| `refactor` | claude-sonnet-4.6 | claude-code | gpt-5.3-codex | codex-cli |
| `architecture` | claude-sonnet-4.6 | claude-code | gpt-5.3-codex | codex-cli |
| `test` | gpt-5.3-codex | codex-cli | gemini-3-flash-preview | gemini-cli |
| `docs` | gemini-3-flash-preview | gemini-cli | claude-sonnet-4.6 | claude-code |
| `web-search` | gemini-3-flash-preview | gemini-cli | gemini-2.5-flash | gemini-cli |
| `gitops` | gpt-5.3-codex | codex-cli | gemini-3-flash-preview | gemini-cli |
| `qa-simple` | gemini-3-flash-preview | gemini-cli | claude-sonnet-4.6 | claude-code |
