import { describe, expect, it } from 'vite-plus/test'
import { controllerSnapshot, propertyController } from './controllers.ts'
import { link } from './builtins/link.ts'

describe('controller capability validation', () => {
  it('rejects forged records and ordinary values as property owners', () => {
    expect(() => propertyController({ value: 1, attached: true })).toThrow('capability')
    expect(() => propertyController(1)).toThrow('capability')
  })

  it('rejects non-record controller observations', () => {
    const controller = propertyController(link({ input: 1 }).value)

    expect(() => controllerSnapshot(controller, 1)).toThrow('readable records')
  })
})
