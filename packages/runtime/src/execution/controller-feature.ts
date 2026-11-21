import { controllerAddresses } from '../evaluation/controller-addresses.ts'
import { resolveControllerPresentation } from './controller-presentation.ts'

export { ControllersExecution } from './controllers-execution.ts'

export const controllerFeature = {
  addresses: controllerAddresses,
  resolve: resolveControllerPresentation,
}
