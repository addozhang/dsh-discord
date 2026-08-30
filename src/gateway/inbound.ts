/**
 * Normalized inbound Gateway events. Every Discord dispatch this module
 * accepts is untrusted wire data: validation failures are values, never
 * throws, so one malformed payload can never break the dispatch loop. Only
 * guild-scoped events the adapter understands survive this boundary; DMs and
 * foreign event shapes are rejected here, before any business logic runs.
 */

/** Numeric string of 17-20 digits, the Discord snowflake wire shape. */
const SNOWFLAKE = /^\d{17,20}$/u

/** A Discord snowflake-shaped string. */
export type DiscordSnowflake = string

/** Validate the snowflake shape of an untrusted string. */
export function isDiscordSnowflake(value: unknown): value is DiscordSnowflake {
  return typeof value === 'string' && SNOWFLAKE.test(value)
}

/** Gateway dispatch event names the adapter consumes; everything else is rejected. */
const SUPPORTED_EVENTS = new Set(['MESSAGE_CREATE', 'INTERACTION_CREATE'])

/** Interaction types the adapter consumes (2=command, 3=component, 4=autocomplete, 5=modal). */
const SUPPORTED_INTERACTION_TYPES = new Set([2, 3, 4, 5])

/** Raw untrusted dispatch: an event name plus its unvalidated payload. */
export interface GatewayDispatch {
  t: string
  d?: unknown
}

/** Why a dispatch was rejected; discrimination keeps rejection handling total. */
export type IngestRejectReason = 'unsupported-event' | 'malformed-payload' | 'bot-authored' | 'non-guild-event'

export type IngestResult =
  | { accepted: true; event: NormalizedMessage | NormalizedInteraction }
  | { accepted: false; reason: IngestRejectReason }
/** A validated guild message with its mention-stripped content. */
export interface NormalizedMessage {
  kind: 'message'
  messageId: DiscordSnowflake
  guildId: DiscordSnowflake
  channelId: DiscordSnowflake
  authorId: DiscordSnowflake
  /** Role ids the wire attached to the member (empty when absent). */
  roleIds: string[]
  /** Permission bitmask string from the member, when the wire carried one. */
  memberPermissions: string | undefined
  /** Content after stripping every bot-mention token and trimming. */
  content: string
  /** Whether the message explicitly mentioned the adapter's bot user. */
  mentionedBot: boolean
  /** The snowflake of the message this one replies to, when present and valid. */
  repliedToId: DiscordSnowflake | undefined
}

/** A validated guild interaction with its actor identity. */
export interface NormalizedInteraction {
  kind: 'interaction'
  interactionId: DiscordSnowflake
  /** Discord interaction type (2=command, 3=component, 4=autocomplete, 5=modal). */
  interactionType: number
  guildId: DiscordSnowflake
  channelId: DiscordSnowflake
  actorId: DiscordSnowflake
  roleIds: string[]
  /** Permission bitmask string from the member, when the wire carried one. */
  memberPermissions: string | undefined
  /** The component interaction's parent message (control editing). */
  componentMessageId: string | undefined
  /** Select-menu values (string selects only). */
  selectValues: string[]
  /** Modal text fields, flattened from the action rows (custom_id + value). */
  modalFields: Array<{ customId: string; value: string }>
  /** Whether the invoking user is itself a bot; such invocations are denied. */
  isBot: boolean
  /** Slash-command name for command/autocomplete interactions, when present. */
  commandName: string | undefined
  /** The opaque interaction data table, normalized for downstream routing. */
  data: Record<string, unknown>
}

/**
 * Detect and strip the adapter's own mention (`<@id>` or `<@!id>`) from
 * message content. Other users' mentions are left intact; a mention-only
 * message yields empty text.
 */
export function extractBotMention(
  content: string,
  selfUserId: DiscordSnowflake,
): { mentioned: boolean; text: string } {
  const pattern = new RegExp(`<@!?${selfUserId}>`, 'gu')
  const mentioned = pattern.test(content)
  if (!mentioned) return { mentioned: false, text: content }
  return { mentioned: true, text: content.replace(pattern, ' ').trim() }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extract the member's role ids; server-provided, so lenient when absent. */
function extractRoleIds(payload: Record<string, unknown>): string[] {
  const member = payload['member']
  if (!isRecord(member) || !Array.isArray(member['roles'])) return []
  return member['roles'].filter((role): role is string => typeof role === 'string')
}

function asSnowflake(value: unknown): DiscordSnowflake | undefined {
  return isDiscordSnowflake(value) ? value : undefined
}

function parseMessage(payload: Record<string, unknown>, selfUserId: DiscordSnowflake): IngestResult {
  // Webhook-authored messages are app-driven surfaces, not member input:
  // their author object need not carry `bot: true`, and anyone with
  // Manage Webhooks could otherwise drive prompts through one.
  if (typeof payload['webhook_id'] === 'string') return { accepted: false, reason: 'bot-authored' }

  const author = payload['author']
  if (!isRecord(author)) return { accepted: false, reason: 'malformed-payload' }

  const authorId = asSnowflake(author['id'])
  if (authorId === undefined) return { accepted: false, reason: 'malformed-payload' }
  if (author['bot'] === true || authorId === selfUserId) {
    return { accepted: false, reason: 'bot-authored' }
  }

  const messageId = asSnowflake(payload['id'])
  const guildId = asSnowflake(payload['guild_id'])
  const channelId = asSnowflake(payload['channel_id'])
  if (messageId === undefined || channelId === undefined) {
    return { accepted: false, reason: 'malformed-payload' }
  }
  // A message outside a guild is a DM or foreign surface: reject at the
  // earliest boundary so it can never reach authorization or DSH.
  if (guildId === undefined) return { accepted: false, reason: 'non-guild-event' }

  const content = typeof payload['content'] === 'string' ? payload['content'] : undefined
  if (content === undefined) return { accepted: false, reason: 'malformed-payload' }

  const reference = payload['message_reference']
  const repliedToId = isRecord(reference) ? asSnowflake(reference['message_id']) : undefined
  if (reference !== undefined && !isRecord(reference)) {
    return { accepted: false, reason: 'malformed-payload' }
  }
  if (isRecord(reference) && reference['message_id'] !== undefined && repliedToId === undefined) {
    return { accepted: false, reason: 'malformed-payload' }
  }

  const stripped = extractBotMention(content, selfUserId)
  const rawPermissions = typeof (isRecord(payload['member']) ? payload['member'] : {})['permissions'] === 'string'
    ? (payload['member'] as { permissions: string }).permissions
    : undefined
  return {
    accepted: true,
    event: {
      kind: 'message',
      messageId,
      guildId,
      channelId,
      authorId,
      roleIds: extractRoleIds(payload),
      memberPermissions: rawPermissions,
      content: stripped.text,
      mentionedBot: stripped.mentioned,
      repliedToId,
    },
  }
}

function parseInteraction(payload: Record<string, unknown>): IngestResult {
  const interactionType = payload['type']
  if (typeof interactionType !== 'number' || !SUPPORTED_INTERACTION_TYPES.has(interactionType)) {
    return { accepted: false, reason: 'unsupported-event' }
  }

  const interactionId = asSnowflake(payload['id'])
  const guildId = asSnowflake(payload['guild_id'])
  const channelId = asSnowflake(payload['channel_id'])
  if (interactionId === undefined || guildId === undefined || channelId === undefined) {
    return { accepted: false, reason: 'malformed-payload' }
  }

  const member = payload['member']
  const user = payload['user']
  const authorId = isRecord(member)
    ? (isRecord(member['user']) ? asSnowflake(member['user']['id']) : undefined)
    : isRecord(user)
      ? asSnowflake(user['id'])
      : undefined
  if (authorId === undefined) return { accepted: false, reason: 'malformed-payload' }

  const data = payload['data']
  if (data !== undefined && !isRecord(data)) return { accepted: false, reason: 'malformed-payload' }
  const table = isRecord(data) ? data : undefined
  const commandName = typeof table?.['name'] === 'string' ? table['name'] : undefined
  if ((interactionType === 2 || interactionType === 4) && commandName === undefined) {
    return { accepted: false, reason: 'malformed-payload' }
  }

  const memberUser = isRecord(member) && isRecord(member['user']) ? member['user'] : undefined
  const wireUser = isRecord(user) ? user : undefined
  const rawPermissions = isRecord(member) && typeof member['permissions'] === 'string'
    ? member['permissions']
    : undefined

  // Component parent message + select values + modal fields (the question
  // and approval flows need all three; absent for commands/autocomplete).
  const wireMessage = payload['message']
  const componentMessageId = isRecord(wireMessage) ? asSnowflake(wireMessage['id']) : undefined
  const selectValues = isRecord(data) && Array.isArray(data['values'])
    ? data['values'].filter((value): value is string => typeof value === 'string')
    : []
  const modalRows = isRecord(data) && Array.isArray(data['components']) ? data['components'] : []
  const modalFields: Array<{ customId: string; value: string }> = []
  for (const row of modalRows) {
    if (!isRecord(row) || !Array.isArray(row['components'])) continue
    for (const field of row['components']) {
      if (!isRecord(field)) continue
      if (typeof field['custom_id'] === 'string' && typeof field['value'] === 'string') {
        modalFields.push({ customId: field['custom_id'], value: field['value'] })
      }
    }
  }

  return {
    accepted: true,
    event: {
      kind: 'interaction',
      interactionId,
      interactionType,
      guildId,
      channelId,
      actorId: authorId,
      roleIds: extractRoleIds(payload),
      memberPermissions: rawPermissions,
      isBot: (memberUser?.['bot'] ?? wireUser?.['bot']) === true,
      commandName,
      data: table ?? {},
      componentMessageId,
      selectValues,
      modalFields,
    },
  }
}

/**
 * Validate and normalize one untrusted Gateway dispatch. Returns a rejection
 * value for every unsupported or malformed input and never throws.
 */
export function parseGatewayDispatch(dispatch: GatewayDispatch, selfUserId: DiscordSnowflake): IngestResult {
  if (!isRecord(dispatch) || typeof dispatch['t'] !== 'string' || !SUPPORTED_EVENTS.has(dispatch['t'])) {
    return { accepted: false, reason: 'unsupported-event' }
  }
  const payload = dispatch['d']
  if (!isRecord(payload)) return { accepted: false, reason: 'malformed-payload' }

  return dispatch['t'] === 'MESSAGE_CREATE'
    ? parseMessage(payload, selfUserId)
    : parseInteraction(payload)
}
