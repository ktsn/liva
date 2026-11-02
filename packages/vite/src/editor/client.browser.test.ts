import { expect, it } from 'vite-plus/test'
import { createApp, defineComponent, h, nextTick, resolveDirective, withDirectives } from 'vue'
import fixture from '../../../../fixtures/toggle.json'
import { decodeBundle } from '@liva/runtime'
import { createDevPlugin } from './client.ts'
import { EditorController } from './controller.ts'
import { subscribeToEditorEvents } from './communication/client.ts'

it('mounts the development editor and observes real component lifetimes', async () => {
  const definition = decodeBundle(JSON.stringify(fixture)).definitions[0]
  const plugin = createDevPlugin('session')
  const registered = customElements.get('liva-motion-editor')
  const url = new URL('/packages/vite/src/editor/ui.ts?registration', window.location.href).href

  await import(/* @vite-ignore */ url)

  expect(customElements.get('liva-motion-editor')).toBe(registered)

  const descriptor = Object.getOwnPropertyDescriptor(window, '__LIVA_EDITOR__')
  const controller: unknown = descriptor?.value

  expect(controller).toBeInstanceOf(EditorController)

  if (!(controller instanceof EditorController)) throw new Error('Missing editor controller')

  const host = document.createElement('div')

  document.body.append(host)

  const component = defineComponent({
    livaDefinitions: [definition],
    livaSource: 'source',
    setup() {
      const directive = resolveDirective('liva')!

      return () => withDirectives(h('div', 'Example'), [[directive, 'off', 'toggle']])
    },
  })
  const app = createApp(component).use(plugin)

  app.mount(host)

  await nextTick()

  expect(controller.entries.size).toBe(1)
  expect(document.querySelector('liva-motion-editor')).not.toBeNull()
  expect(controller.message).toContain('Missing target binding')

  controller.selected = [...controller.entries.values()][0]

  const received: string[] = []
  const unsubscribe = subscribeToEditorEvents({
    sourceChanged: (id) => received.push(id),
    diagnostics: (_id, message) => received.push(message),
  })

  import.meta.hot!.send('liva:test:events')

  await expect.poll(() => received).toEqual(['source', 'First\nSecond'])
  expect(controller.stale).toBe(true)
  expect(controller.message).toBe('First\nSecond')

  unsubscribe()
  import.meta.hot!.send('liva:test:events')

  await expect.poll(() => controller.message).toBe('First\nSecond')
  expect(received).toHaveLength(2)

  app.unmount()

  expect(controller.entries.size).toBe(0)

  host.remove()
  document.querySelector('liva-motion-editor')!.remove()
})
