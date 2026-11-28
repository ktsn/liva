import { resolveLayoutConfigurations, resolveSelectedLayout } from '../composition/layout.ts'

export { LayoutExecution } from './layout-execution.ts'

export const layoutFeature = {
  selected: resolveSelectedLayout,
  persistent: resolveLayoutConfigurations,
}
