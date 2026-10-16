// tests/section-layout.spec.ts — the header row's wrap contract.
//
// The real proof for the ≤360px overflow fix (task-21) is the browser
// measurement recorded in `_team/browser-acceptance*.md`. This spec guards the
// declarations that make the narrow column fit, so a later refactor cannot
// silently bring the horizontal overflow back.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/ServiceSection.module.css', import.meta.url), 'utf8')

/** The body of one top-level rule, keyed by its exact selector. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = new RegExp(`(?:^|\\})\\s*${escaped}\\s*\\{([^}]*)\\}`, 'm').exec(css)
  if (match === null) throw new Error(`rule not found: ${selector}`)
  return match[1] ?? ''
}

describe('service section header layout', () => {
  it('wraps the action row instead of overflowing the settings column', () => {
    // The header must be able to move the fixed 297px action row to its own line.
    expect(rule('.header')).toMatch(/flex-wrap:\s*wrap/)
    // The heading keeps a minimum usable width; `min()` keeps it from forcing
    // an overflow inside a column narrower than that minimum.
    expect(rule('.heading')).toMatch(/min-width:\s*min\(/)
    // The controls must be allowed to shrink; an unshrinkable fixed row is what
    // pushed the content area's scrollWidth past its clientWidth.
    expect(rule('.controls')).not.toMatch(/flex-shrink:\s*0/)
    expect(rule('.controls')).toMatch(/flex-wrap:\s*wrap/)
  })
})
