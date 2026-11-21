let plugin: unknown = () => ({ name: 'liva' })
export { plugin as default }

export function setPlugin(value: unknown) {
  plugin = value
}
