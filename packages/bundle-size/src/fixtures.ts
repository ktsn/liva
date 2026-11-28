export interface FeatureFixture {
  readonly motion?: string
  readonly presence?: boolean
  readonly full?: boolean
}

const spring = `
  @spring(duration: 300)
  layer springPlayback when active { button { rotate: 10deg } }
`
const link = `
  layer controlled when active {
    button { translate := link(input: 10, component: "x") }
  }
`
const measure = `
  let bounds = measure(target: button)
  layer measured { button { --button-width: \${bounds.width}px } }
`
const layout = `
  layer projected { button { $layout: position } }
`
const presence = `
  @tween(duration: 100, easing: linear)
  enter { button { opacity: 0 } }
  @tween(duration: 100, easing: linear)
  leave { button { opacity: 0 } }
`

/** Additional production fixtures, in the order used by the PR report. */
export const featureFixtures = {
  spring: { label: 'Spring', motion: spring },
  controller: { label: 'Controller', motion: link },
  'measure-layout': { label: 'Measure + Layout', motion: measure + layout },
  presence: { label: 'Presence', motion: presence, presence: true },
  full: { label: 'Full', full: true },
} satisfies Record<string, FeatureFixture & { label: string }>

export function fixtureSources(
  source: string,
  entry: string,
  variant: FeatureFixture,
): { source: string; entry: string } {
  if (variant.motion) source = source.replace('}\n</liva>', variant.motion + '}\n</liva>')

  if (variant.presence)
    source = source
      .replace(
        '<template>\n  <button',
        '<template>\n  <button @click="active = !active">Toggle presence</button>\n  <button v-if="active"',
      )
      .replace('    @click="active = !active"\n', '')

  if (variant.full)
    entry = entry
      .replace("import liva from '@liva/vue'", "import { createLivaPlugin } from '@liva/vue'")
      .replace('.use(liva)', '.use(createLivaPlugin())')

  return { source, entry }
}
