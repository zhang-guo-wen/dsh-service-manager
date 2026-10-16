---
paths:
  - "src/client/**"
  - "tests/**"
---

> 覆盖：`ServiceSection` 的设置页几何、文案与失败反馈、状态渲染；何时读：改 `src/client/**` 或浏览器测试替身时

## Browser section

- `ServiceSection` contributes a `settings.section`, so it follows the settings
  geometry: `container: service-manager / inline-size` plus `max-width: 760px`,
  never the 960px first-level page column. Row copy, status words, and the
  relative-time buckets all live in `src/client/locales.ts`; the buckets come
  from the host's `relativeTime`. `createdAt` is displayable, while `startedAt`
  is a process identity string and must never be parsed as a date.
- A failed read keeps the rows already on screen and marks them as the last
  successful read; only a first read that never succeeded shows the failure
  block. Stop, remove, and claim each keep their dialog or candidate row open on
  failure with a retry, and report success next to the section.
- Running status is a word beside a host `StateDot`, never colour alone. The
  leftover marker stays a plain span because `Tag` cannot carry its explanatory
  title, and the test doubles in `tests/client-section.spec.tsx` and
  `tests/client-bundle.spec.tsx` mirror whichever primitives the section uses.
