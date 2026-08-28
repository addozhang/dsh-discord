/** The plugin's settings namespace, shared by the Host registration and the
 * browser card. Declared locally (not imported from `dsh-settings`) so the
 * client bundle stays free of host-package value imports.
 */

import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'

/** The branded settings namespace, matching the Host plugin's registration. */
export const DISCORD_SETTINGS_NAMESPACE = 'dsh-discord' as SettingsNamespace
