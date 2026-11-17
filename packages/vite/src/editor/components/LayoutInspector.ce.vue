<script setup lang="ts">
import type {
  LayoutDeclarationSource,
  LayoutTimingSource,
  ResolvedLayoutConfiguration,
} from '@liva/runtime'
import type { Inspection } from '../communication/protocol.ts'
import { timingText } from '../timeline.ts'

const props = defineProps<{
  configurations: readonly ResolvedLayoutConfiguration[]
  inspection: Inspection
}>()

function sourcePath(source: LayoutDeclarationSource | LayoutTimingSource) {
  let path = `${props.inspection.definition.name}/layer/${source.layer}`

  if ('transition' in source && source.transition !== undefined) {
    path += `/transition/${source.transition}`
  } else if (source.state) {
    path += `/state/${source.state}`
  }

  if (source.target) path += `/target/${source.target}`
  if ('declaration' in source) path += '/property/$layout'
  else if (source.property) path += `/property/${source.property}`

  return path
}

function sourceText(path: string) {
  return props.inspection.fields.find((field) => field.path === path)?.value
}

function axesText(configuration: ResolvedLayoutConfiguration) {
  return (
    Object.entries(configuration.axes)
      .filter(([, enabled]) => enabled)
      .map(([axis]) => axis)
      .join(', ') || 'none'
  )
}
</script>

<template>
  <section aria-label="Layout configuration" class="layout-inspector">
    <h3>Layout configuration (read-only)</h3>
    <p>Configuration is edited in source. Ordinary preview has no before/after layout capture.</p>
    <article
      v-for="configuration in configurations"
      :key="configuration.target"
      :aria-label="`Layout ${configuration.target}`"
      class="layout-configuration"
    >
      <h4>{{ configuration.target }}</h4>
      <dl class="configuration-details">
        <dt>Physical axes</dt><dd class="configuration-value">{{ axesText(configuration) }}</dd>
        <dt>Timing</dt><dd class="configuration-value">{{
          configuration.timing ? timingText(configuration.timing) : 'No timing: settle immediately'
        }}</dd>
        <dt>Declaration</dt><dd class="configuration-value"><code>{{
            sourcePath(configuration.source)
          }}</code><template v-if="sourceText(`${sourcePath(configuration.source)}/value`)"
          > · {{ sourceText(`${sourcePath(configuration.source)}/value`) }}</template></dd>
        <template v-if="configuration.timingSource">
          <dt>Timing source</dt><dd class="configuration-value"><code
            >{{ sourcePath(configuration.timingSource) }}/timing</code><template
              v-if="sourceText(`${sourcePath(configuration.timingSource)}/timing`)"
            > · {{ sourceText(`${sourcePath(configuration.timingSource)}/timing`) }}</template></dd>
          <dt>Timing scope</dt><dd class="configuration-value">{{
            configuration.timingSource.transition !== undefined
              ? 'Selected directional transition only'
              : 'Persistent declaration timing'
          }}</dd>
        </template>
        <dt>Ordinary transform ownership</dt><dd class="configuration-value">{{
          configuration.explicitTransform
            ? 'Explicit Liva transform suppresses automatic projection, including transform: none.'
            : 'No ordinary Liva transform. Physical aliases, Presence and preview may also suppress projection.'
        }}</dd>
        <template v-if="configuration.declarations.length > 1">
          <dt>Declaration cascade (earliest first)</dt><dd class="configuration-value"><ol
              class="declaration-cascade"
            ><li v-for="(source, index) in configuration.declarations" :key="index"><code>{{
                  sourcePath(source)
                }}</code></li></ol></dd>
        </template>
      </dl>
    </article>
  </section>
</template>

<style scoped>
.layout-inspector {
  padding-block: 8px;
  padding-inline: 14px;
  border-block-end: 1px solid var(--liva-border-panel);
}
.configuration-details {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 4px 12px;
}
.configuration-value {
  margin: 0;
  overflow-wrap: anywhere;
}
.declaration-cascade {
  margin-block: 0;
  padding-inline-start: 20px;
}
</style>
