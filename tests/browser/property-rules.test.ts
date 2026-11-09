import { expect, test, type Page } from '@playwright/test'

const writingModes = ['horizontal-tb', 'vertical-rl', 'vertical-lr', 'sideways-rl', 'sideways-lr']
const directions = ['ltr', 'rtl']

async function openWritingContext(page: Page, writingMode: string, direction: string) {
  await page.goto('/tests/browser/')
  await page.evaluate(
    ({ writingMode: mode, direction: flowDirection }) => {
      const container = document.createElement('div')
      container.style.cssText = 'position:relative;width:400px;height:300px;'
      const element = document.createElement('div')
      element.dataset.testid = 'property-rule-target'
      element.style.cssText =
        'position:absolute;width:101px;height:83px;top:11px;right:23px;bottom:37px;left:53px;'
      element.style.writingMode = mode
      element.style.direction = flowDirection
      container.append(element)
      document.body.append(container)
    },
    { writingMode, direction },
  )

  return page.getByTestId('property-rule-target')
}

for (const writingMode of writingModes) {
  for (const direction of directions) {
    test.describe(`${writingMode} / ${direction}`, () => {
      test('decodes logical sizes and insets like the browser', async ({ page }) => {
        const target = await openWritingContext(page, writingMode, direction)
        const samples = await target.evaluate(async (element) => {
          if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML target')

          const { decodeProperty } = await import('../../packages/runtime/src/property-codec.ts')
          const style = getComputedStyle(element)
          const properties = [
            ['inline-size', ['inline-size']],
            ['block-size', ['block-size']],
            ['inset-inline-start', ['inset-inline-start']],
            ['inset-inline-end', ['inset-inline-end']],
            ['inset-block-start', ['inset-block-start']],
            ['inset-block-end', ['inset-block-end']],
            ['inset-inline', ['inset-inline-start', 'inset-inline-end']],
            ['inset-block', ['inset-block-start', 'inset-block-end']],
          ] as const

          // Unique physical dimensions and offsets make an incorrect axis observable.
          return properties.map(([property, longhands]) => ({
            property,
            actual: decodeProperty(element, property)?.values,
            expected: longhands.map((name) => parseFloat(style.getPropertyValue(name))),
          }))
        })

        for (const sample of samples) {
          expect(sample.actual, sample.property).toEqual(sample.expected)
        }
      })

      test('expands inset tracks to equivalent physical declarations', async ({ page }) => {
        const target = await openWritingContext(page, writingMode, direction)
        const samples = await target.evaluate(async (element) => {
          if (!(element instanceof HTMLElement)) throw new Error('Expected an HTML target')

          const { canonicalTracks } = await import('../../packages/runtime/src/property-codec.ts')
          const container = element.parentElement
          if (!container) throw new Error('Expected a writing context container')
          const physical = ['top', 'right', 'bottom', 'left']
          const properties = [
            ['inset', '10% 2em 30px 4em', '3px 7px 11px 19px'],
            ['inset-inline', '10% 2em', '3px 7px'],
            ['inset-block', '10% 2em', '3px 7px'],
          ]

          return properties.flatMap(([property, destination, midpoint]) => {
            const track = {
              target: 'self',
              property,
              destinationValue: destination,
              timing: { kind: 'tween', durationMs: 200, easing: 'linear' } as const,
              keyframes: [{ offset: 0.5, value: midpoint, easing: 'ease-in' }],
            }
            const expanded = canonicalTracks(element, track)

            // Compare rendered CSS from the authored shorthand and expanded longhands,
            // both at the destination and at an intermediate frame.
            return ['destination', 'midpoint'].map((phase) => {
              const authored = element.cloneNode()
              const split = element.cloneNode()
              if (!(authored instanceof HTMLElement) || !(split instanceof HTMLElement))
                throw new Error('Expected HTML comparison elements')

              container.append(authored, split)

              try {
                authored.style.setProperty(
                  property,
                  phase === 'destination' ? destination : midpoint,
                )

                for (const entry of expanded) {
                  split.style.setProperty(
                    entry.property,
                    phase === 'destination' ? entry.destinationValue : entry.keyframes[0].value,
                  )
                }

                const expected = getComputedStyle(authored)
                const actual = getComputedStyle(split)

                return {
                  property,
                  phase,
                  actual: physical.map((name) => actual.getPropertyValue(name)),
                  expected: physical.map((name) => expected.getPropertyValue(name)),
                  easing: expanded.map((entry) => entry.keyframes[0].easing),
                }
              } finally {
                authored.remove()
                split.remove()
              }
            })
          })
        })

        for (const sample of samples) {
          expect(sample.actual, `${sample.property}: ${sample.phase}`).toEqual(sample.expected)
          expect(sample.easing.every((easing) => easing === 'ease-in')).toBe(true)
        }
      })
    })
  }
}
