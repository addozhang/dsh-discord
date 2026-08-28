/**
 * Project-channel Agent Preset control (design.md §7, task 10.1). A preset is
 * a complete Agent composition: the channel default persists independently of
 * the workspace binding and is passed EXPLICITLY to future `session.create`
 * calls only — existing sessions never change. Resetting omits the field so
 * DSH applies its current host default. Selection validates against the host
 * catalog; a missing or broken catalog refuses without writing.
 */

export interface DshPresetPort {
  listPresets(): Promise<
    | { outcome: 'completed'; presets: ReadonlyArray<{ id: string; name: string }> }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
  hostDefaultPreset(): Promise<
    | { outcome: 'completed'; presetId: string | undefined }
    | { outcome: 'failed' }
    | { outcome: 'unknown' }
  >
}

export interface PresetChannelStore {
  get(key: string): { presetId: string } | undefined
  put(key: string, value: { presetId: string }): Promise<void>
  delete(key: string): Promise<boolean>
}

export interface PresetControlDeps {
  presets: DshPresetPort
  channelStore: PresetChannelStore
}

export type PresetSelectResult =
  | { outcome: 'selected'; presetId: string }
  | { outcome: 'failed'; reason: 'preset-not-in-catalog' | 'preset-catalog-unavailable' }

export type PresetShowResult =
  | { outcome: 'ok'; channelPreset: string | undefined; hostDefault: string | undefined }
  | { outcome: 'failed'; reason: 'preset-catalog-unavailable' }

export type PresetResetResult = { outcome: 'reset' }

const storeKey = (guildId: string, channelId: string): string => `${guildId}:${channelId}`

export function createPresetControl(deps: PresetControlDeps): {
  show(input: { guildId: string; channelId: string }): Promise<PresetShowResult>
  select(input: { guildId: string; channelId: string; presetId: string }): Promise<PresetSelectResult>
  reset(input: { guildId: string; channelId: string }): Promise<PresetResetResult>
  /** Merge the channel default into a future session.create request, if set. */
  applyToSessionCreate<T extends { sessionId: string }>(
    scope: { guildId: string; channelId: string },
    createRequest: T,
  ): T & { presetId?: string }
} {
  return {
    async show(input) {
      const hostDefault = await deps.presets.hostDefaultPreset()
      if (hostDefault.outcome !== 'completed') {
        return { outcome: 'failed', reason: 'preset-catalog-unavailable' }
      }
      return {
        outcome: 'ok',
        channelPreset: deps.channelStore.get(storeKey(input.guildId, input.channelId))?.presetId,
        hostDefault: hostDefault.presetId,
      }
    },

    async select(input) {
      const catalog = await deps.presets.listPresets()
      if (catalog.outcome !== 'completed') {
        return { outcome: 'failed', reason: 'preset-catalog-unavailable' }
      }
      if (!catalog.presets.some(preset => preset.id === input.presetId)) {
        return { outcome: 'failed', reason: 'preset-not-in-catalog' }
      }
      await deps.channelStore.put(storeKey(input.guildId, input.channelId), { presetId: input.presetId })
      return { outcome: 'selected', presetId: input.presetId }
    },

    async reset(input) {
      await deps.channelStore.delete(storeKey(input.guildId, input.channelId))
      return { outcome: 'reset' }
    },

    applyToSessionCreate(scope, createRequest) {
      const presetId = deps.channelStore.get(storeKey(scope.guildId, scope.channelId))?.presetId
      return presetId === undefined ? { ...createRequest } : { ...createRequest, presetId }
    },
  }
}
