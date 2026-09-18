/**
 * The adapter's fail-loud startup boundary. Cordis `inject` delays activation
 * until the named services exist but says nothing about contract shape, and a
 * silently half-mounted Discord plugin is a security liability. This module
 * probes every required DSH Host service in one pass and refuses activation
 * with a single actionable diagnostic naming every gap.
 */

/** The exact Host service roster the adapter requires (design decision 1). */
export const REQUIRED_HOST_SERVICES = [
  'sessionController',
  'workspaceController',
  'sessionQuery',
  'webServer',
  'credentials',
  'settings',
  'storageDomain',
  'connection',
] as const

export type HostServiceName = (typeof REQUIRED_HOST_SERVICES)[number]

/**
 * Minimum contract members per service, confirmed against the 0.1.6
 * controller faces (dsh-api-session-controller / dsh-api-workspace-controller
 * / dsh-session-query). A service lacking any member means a version drift
 * the startup probe should have refused; refuse rather than probe at runtime.
 */
const REQUIRED_CONTRACT_MEMBERS: Record<HostServiceName, readonly string[]> = {
  sessionController: ['prompt', 'create', 'list', 'cancel', 'updateQueue', 'selectModel', 'modelCatalog', 'follow', 'control'],
  workspaceController: ['follow'],
  sessionQuery: ['observeSession'],
  webServer: [],
  credentials: ['resolve', 'describe', 'set', 'unset'],
  settings: ['installSection'],
  storageDomain: ['open'],
  connection: ['rpc'],
}

/** Actionable remediation hint appended to every activation failure. */
const REMEDIATION = 'install @addozhang/dsh-discord into a dsh web profile providing the 0.1.6 host controller services'

function missingMembers(service: unknown, required: readonly string[]): string[] {
  if (service === undefined || service === null) return [...required]
  return required.filter(member => typeof (service as Record<string, unknown>)[member] === 'undefined')
}

/**
 * Validate every required Host capability through `resolveService`, which
 * returns the service value or `undefined` when absent. Throws one aggregated
 * `TypeError` naming every missing service and every missing contract member.
 */
export function validateHostCapabilities(resolveService: (name: HostServiceName) => unknown): void {
  const missing: string[] = []
  const incompatible: string[] = []
  for (const name of REQUIRED_HOST_SERVICES) {
    const service = resolveService(name)
    if (service === undefined || service === null) {
      missing.push(name)
      continue
    }
    const gaps = missingMembers(service, REQUIRED_CONTRACT_MEMBERS[name])
    if (gaps.length > 0) incompatible.push(`${name} lacks ${gaps.map(member => `'${member}'`).join(', ')}`)
  }
  const parts = [
    missing.length > 0 ? `missing DSH host service(s) ${missing.map(name => `'${name}'`).join(', ')}` : undefined,
    incompatible.length > 0 ? `incompatible service(s): ${incompatible.join('; ')}` : undefined,
  ].filter(Boolean)
  if (parts.length > 0) {
    throw new TypeError(`dsh-discord cannot activate (${parts.join('; ')}). ${REMEDIATION}`)
  }
}
