/**
 * Mention-syntax neutralization for outbound text. Discord renders
 * `<@id>`, `<@!id>`, `<#id>`, `<@&id>`, `@everyone`, and `@here` pings; the
 * adapter's message flag suppresses parsing, but titles and labels can flow
 * into surfaces the flag does not cover, so the syntax itself is broken with
 * a zero-width space the renderer treats as plain text.
 */

const ZERO_WIDTH = '\u200b'

/**
 * Break every Discord mention form inside `text` so no renderer — with or
 * without the suppression flag — can resolve it into a ping.
 */
export function suppressMentionSyntax(text: string): string {
  return text
    .replace(/<@([!&]?)/gu, `<@$1${ZERO_WIDTH}`)
    .replace(/<#/gu, `<#${ZERO_WIDTH}`)
    .replaceAll('@everyone', `@${ZERO_WIDTH}everyone`)
    .replaceAll('@here', `@${ZERO_WIDTH}here`)
}
