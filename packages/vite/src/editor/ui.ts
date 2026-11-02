import { defineCustomElement } from 'vue'
import EditorPanel from './components/EditorPanel.ce.vue'
import type { EditorController } from './controller.ts'

const tag = 'liva-motion-editor'

if (!customElements.get(tag)) {
  customElements.define(tag, defineCustomElement(EditorPanel))
}

export function mountEditor(controller: EditorController) {
  const host = Object.assign(document.createElement(tag), { controller })
  host.dataset.livaEditor = ''
  document.body.append(host)

  import.meta.hot?.dispose(
    /* v8 ignore next -- @preserve: Vite owns module-disposal dispatch; the callback only removes its host. */ () => {
      host.remove()
    },
  )
}
