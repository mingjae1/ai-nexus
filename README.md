# AI Nexus (Multi-Model Orchestrator Setup)

Windows에서 Claude/Codex/Gemini/Copilot CLI를 함께 설치하고, 하나를 메인 오케스트레이터로 운영하기 위한 설치 패키지입니다.

지원 CLI: Claude Code · Codex CLI · Gemini CLI · Copilot CLI

## 전역 설정 동기화

`server.js`(또는 `node server.js`) 실행 시 자동으로 전역 설정을 프로젝트에 반영합니다.

| 전역 파일 | 반영 대상 |
|---|---|
| `~/.claude/orca-mode.txt` | `wizard-config.json` mode |
| `~/.codex/config.toml` (model) | `wizard-config.json` orchestratorModel |
| `~/.codex/AGENTS.md` | `plan/orchestrator-system-prompt.md` |
| `~/.gemini/GEMINI.md` | `plan/gemini-orchestrator-prompt.md` |

설치 완료 후에는 프로젝트 → 전역으로도 역방향 동기화가 실행됩니다:

- `~/.codex/AGENTS.md`
- `~/.gemini/AGENTS.md` · `~/.gemini/GEMINI.md`
- `~/.claude/CLAUDE.md`

## 설치 시 반영되는 항목

- CLI 설치/인증 상태 확인
- 오케스트레이터 CLI + 모델 선택
- 메인 CLI 설정 파일 반영 (`.claude`, `.codex`, `.gemini`, `.copilot`)
- 오케스트레이터 프롬프트 파일 생성/갱신
- 기존 설정 자동 백업 (`.bak.YYYYMMDD-HHMMSS`)

## 오케스트레이터 사용

### Claude Code

```text
claude
/orca 작업내용
/orca-mode economy
/orca-mode performance
```

### Codex CLI

```cmd
codex-local.cmd   # 프로젝트 로컬 설정으로 실행
codex             # 전역 설정으로 실행
```

전역 지침: `~/.codex/AGENTS.md`

### Gemini CLI

```text
gemini
gemini.cmd   # PowerShell에서 매핑 안 될 때
```

전역 지침: `~/.gemini/GEMINI.md`

### Copilot CLI

```text
gh copilot suggest
```

Copilot은 ACP 기반이며 Bash subprocess 위임 방식으로 동작합니다.

## 주요 파일

| 파일 | 역할 |
|---|---|
| `setup.cmd` | 사용자 진입점 |
| `wizard.html` | 설치 마법사 UI |
| `setup.ps1` | 설정 반영 스크립트 |
| `server.js` | 상태 점검/설치 보조 서버 (포트 7899) |
| `electron-main.js` | Electron 앱 진입점 |
| `scripts/orchestrator.js` | 오케스트레이터 라우팅 엔진 |
| `wizard-config.json` | 현재 설정 (orchestratorCli, mode 등) |
| `plan/orchestrator-system-prompt.md` | 오케스트레이터 프롬프트 (전역에서 동기화됨) |

## npm 스크립트

```bash
npm start          # server.js 실행
npm run app        # Electron 앱 실행
npm run orchestrate -- --prompt "작업내용"  # 라우팅 미리보기
npm test           # Playwright 테스트
npm run dist       # Electron 인스톨러 빌드
```
