---
paths:
  - "tests/**"
  - "package.json"
---

> 覆盖：构建/测试命令与必须覆盖的回归清单；何时读：加测试、改测试或准备验证时

## Testing

Run npm run typecheck, npm test, npm run build. Include regression tests for
identity reuse, unknown status, concurrent file updates, manual-only stops,
reconciliation timing, the unmarked parent chain, and the listener parsers.
`tests/host-bundle.spec.ts` asserts the built plugin registers no model tools.
