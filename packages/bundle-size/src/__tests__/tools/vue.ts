let plugin: unknown = () => ({ name: 'vue' })
export { plugin as default }

export function setPlugin(value: unknown) {
  plugin = value
}
