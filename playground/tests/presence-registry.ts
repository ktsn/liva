import { defineComponent, h } from 'vue'

export const presenceComponents = {
  LivaCompiledPresenceBoundary: defineComponent({
    setup() {
      return () => h('p', { 'data-testid': 'authored-component' }, 'Author-registered component')
    },
  }),
}

export const registeredName = Object.keys(presenceComponents)[0]
