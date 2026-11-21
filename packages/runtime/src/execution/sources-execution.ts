import { releaseResources } from '../evaluation/resource-cleanup.ts'
import type { SourceConnection } from '../evaluation/reactive-value.ts'
import type { BrowserExecutor } from './browser-executor.ts'

export class SourcesExecution {
  private readonly host: Pick<BrowserExecutor, 'representativeTargets'>

  constructor(host: Pick<BrowserExecutor, 'representativeTargets'>) {
    this.host = host
  }

  private readonly sourceCleanups = new Set<() => void>()

  disconnectBindings() {
    const cleanups = [...this.sourceCleanups]
    this.sourceCleanups.clear()

    releaseResources(cleanups)
  }

  readonly connectSource: SourceConnection = (source, publish) => {
    const cleanup = source.bind(new Map(this.host.representativeTargets()), publish)
    let connected = true
    const disconnect = () => {
      if (!connected) return

      connected = false
      this.sourceCleanups.delete(disconnect)
      cleanup()
    }

    this.sourceCleanups.add(disconnect)

    return disconnect
  }
}
