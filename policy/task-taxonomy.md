# Task Taxonomy Signals

| Task type | Signals |
|-----------|---------|
| `code-gen-static` | "만들기", "생성", "create", "implement", "write", "build" + architecture context |
| `code-gen-agentic` | "실행", "빌드", "run", "deploy", "CI/CD", terminal/shell context |
| `code-gen-simple` | simple edits, boilerplate, templates, repetitive generation |
| `analysis-large` | "분석" + large codebase/logs (>200K tokens) |
| `analysis-precision` | "분석" + algorithm/logic/math (<100K tokens) |
| `analysis-light` | quick lookup, API parameter check, log filtering |
| `review` | "리뷰", "점검", "audit", "check", security context |
| `debug` | "버그", "에러", "fix", "debug", "오류", "수정" |
| `refactor` | "리팩토링", "개선", "refactor", "optimize", "clean up" |
| `architecture` | "설계", "아키텍처", "design", "architect", "구조" |
| `test` | "테스트", "test", "spec", "coverage" |
| `docs` | "문서", "README", "document", "주석", summarize |
| `web-search` | "검색", "search", "찾아줘", latest docs |
| `gitops` | PR, issue, branch, merge, GitHub operations |
| `qa-simple` | quick Q&A, micro-edit, grammar fix |

For multi-intent prompts, decompose and route sub-tasks sequentially.
