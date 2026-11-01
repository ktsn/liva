export function waapiProperty(property: string): string {
  if (property.startsWith('--')) {
    return property
  }

  if (property === 'offset') return 'cssOffset'
  if (property === 'float') return 'cssFloat'
  // Metadata names have no CSS counterpart/WAAPI alias. Kebab spelling prevents
  // them from overwriting effect metadata while still reaching the browser.
  if (property === 'easing' || property === 'composite') return `-${property}`

  return property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())
}
