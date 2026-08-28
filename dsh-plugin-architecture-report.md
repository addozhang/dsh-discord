# DeepSeek Harness Plugin Architecture — READ-ONLY Investigation

All paths are absolute under the installed checkout
`/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/`. Plugin packages live in
`node_modules/@deepseek-ai/<pkg>/`. Every API below is labeled **PUBLIC**
(exported via `package.json` `"exports"`/`"types"` and documented in README) or
**INTERNAL** (only in bundled JS or marked internal/private).

---

## 1. Plugin Definition & Loading

### 1.1 The Cordis core — `@deepseek-ai/cordis`

- Package: `node_modules/@deepseek-ai/cordis/package.json`
- README: `node_modules/@deepseek-ai/cordis/README.md`
- Types: `node_modules/@deepseek-ai/cordis/lib/types/*.d.ts` (re-exported by
  `lib/types/index.d.ts` lines 1–15)
- `package.json` `exports` (PUBLIC surface):
  - `"."` → `lib/index.js` (runtime) + `lib/types/index.d.ts` (types)
  - `"./src/*"` → source, `"./package.json"`

**Plugin entrypoint shapes** — `lib/types/registry.d.ts` lines 47–93 (PUBLIC):
A plugin is one of three shapes, all carrying optional `name`, `Config`
(standard-schema), `inject`, `provide`, `intercept` metadata
(`Plugin.Base`, lines 52–63):
- `Plugin.Function` (lines 71–73): `(ctx, config) => any`
- `Plugin.Constructor` (lines 75–77): `new (ctx, config) => any`
- `Plugin.Object` (lines 79–81): `{ apply(ctx, config): any }`

So `apply` is the method form; function and class forms are also supported.
A `Plugin.Runtime` (lines 83–92) is the shared registry record: `name`,
`fibers` (a `DisposableList<Fiber>`), `callback`, and `Config` schema.

**Loading a plugin** — `lib/types/registry.d.ts` lines 99–122 (PUBLIC):
- `ctx.plugin(plugin, ...config)` → `Fiber & PromiseLike<Fiber>` (lines 120)
- `ctx.inject(deps, callback)` → `Fiber & PromiseLike<Fiber>` (lines 111) —
  shorthand for `ctx.plugin({ inject, apply: callback })`; the callback is
  unloaded and re-run whenever a required service changes.

**RegistryService** — `lib/types/registry.d.ts` lines 129–199 (PUBLIC):
`ctx.registry` (mixed onto `ctx`) normalizes plugin shapes, tracks runtimes,
starts fibers, and exposes map-like inspection (`get/has/delete/keys/values/
entries/forEach`, `resolve`, `inject`, `plugin`).

### 1.2 The Loader — `@deepseek-ai/cordis-plugin-loader`

- README: `node_modules/@deepseek-ai/cordis-plugin-loader/README.md`
- Types: `lib/types/index.d.ts` (lines 1–73), `lib/types/config/*.d.ts`,
  `lib/types/internal.d.ts`
- `package.json` `exports` (PUBLIC): `"."`, `"./src/*"`, `"./package.json"`

The Loader owns an `EntryTree` (`lib/types/config/tree.d.ts` lines 6–37,
PUBLIC abstract class) of `Entry` nodes (`lib/types/config/entry.d.ts`
lines 21–55, PUBLIC). Each `Entry` corresponds to a configured plugin row
with `EntryOptions` (lines 6–19): `id`, `name` (module specifier), `config`,
`group`, `disabled`, `inject`.

`Loader` (`lib/types/index.d.ts` lines 54–71, PUBLIC; extends `EntryTree`):
- `loader.create(options, parent?, position?)` — add and start an entry
- `loader.update(id, options, parent?, position?)` — update/move/restart
- `loader.remove(id)` — stop and delete
- `loader.resolve(id)`, `loader.resolveGroup(id)`, `loader.await()`,
  `loader.locate(fiber?)`, `loader.exit()`
- `unwrapExports(exports)` — normalize ESM/CJS/default shapes
- `Loader.Intercept` (lines 44–47): `{ await?: boolean }` — keep dependents
  pending while entries load.

Loader emits extra `Events` (`lib/types/index.d.ts` lines 19–25, PUBLIC):
`exit`, `loader/config-update`, `loader/entry-init`, `loader/partial-dispose`,
`loader/patch-context` (waterfall). `Fiber.entry` is augmented (lines 32–34).

Node-internal module-loader compatibility types live in
`lib/types/internal.d.ts` (lines 1–97, PUBLIC): `ModuleLoaderV1` (Node 22/23)
and `ModuleLoaderV2` (Node 24+), `ModuleLoader.fromInternal()`.

---

## 2. Context / DI Capabilities (provide / inject / on / slots)

All capabilities below are declared in `lib/types/*.d.ts` and re-exported by
`lib/types/index.d.ts`; they are the PUBLIC Cordis surface (documented in
README §"Quick Start" and the per-file JSDoc).

### 2.1 Context proxy & scoping — `lib/types/context.d.ts` (PUBLIC)

`Context` class (lines 40–100) is a proxy. Static symbol keys (lines 42–48):
`Context.effect`, `Context.filter`, `Context.isolate`, `Context.intercept`.
- `Context.is(value)` (lines 58) — cross-realm brand check (global symbol).
- `new Context()` (line 60) — root container, installs built-in services.
- `ctx.extend(meta?)` (line 70) — child context with extra own properties.
- `ctx.isolate(name, label?)` (line 83) — child context with an independent
  service scope for `name`; same `label` joins scopes. **This is the
  realm/isolate concept.**
- `ctx.intercept(name, config)` (lines 96–99) — add per-service intercept
  config merged into resolved service config for plugins below this context.

`Context` interface (lines 15–32) exposes `events`, `logger`, `reflect`,
`registry` services, plus the symbol-keyed `isolate`/`intercept` maps.

### 2.2 Reflect / DI — `lib/types/reflect.d.ts` (PUBLIC)

`ReflectService` (`ctx.reflect`, lines 105–185) powers the context proxy.
Augments `Context` (lines 4–68) with:
- `ctx.get(name, strict?)` (lines 14–16) — read a service without injecting.
- `ctx.set(name, value)` (lines 24–28) — overwrite a provided service (only
  the providing fiber may set).
- `ctx.provide(name, value)` (lines 31–43) — register a service owned by the
  current fiber; returns a disposer. **This is the `provide()` DI pattern.**
- `ctx.accessor(name, options)` (lines 49–53) — computed context property.
- `ctx.mixin(name, mixins)` (lines 60–66) — forward service methods onto
  `ctx` (e.g. `ctx.on` → `ctx.events.on`).

`Impl` record (lines 89–98): `{ name, fiber, value?, check? }`.

### 2.3 Registry / inject — `lib/types/registry.d.ts` (PUBLIC)

- `Inject` type (lines 13–15): array of service names OR a `{ [K]?: config }`
  map (intercept config per service).
- `InjectKey` (lines 17–21): context keys whose services declare typed
  intercept config.
- `@Inject` decorator (lines 33–35) — declares service dependencies on
  classes/methods.
- `Inject.resolve(inject, result?)` (lines 45) — normalize declarations.
- `ctx.plugin` / `ctx.inject` (lines 99–122) — covered in §1.1.

### 2.4 Events / hooks — `lib/types/events.d.ts` (PUBLIC)

`EventsService` (`ctx.events`, lines 118–207) is the event bus, mixed onto
`ctx`. Dispatch modes (`DispatchMode`, line 25): `emit`, `parallel`, `serial`,
`bail`, `waterfall`. Augments `Context` (lines 26–99) with:
- `ctx.parallel(name, ...args)` (lines 35–37) — concurrent, awaited.
- `ctx.emit(name, ...args)` (lines 44–46) — synchronous, fire-and-forget.
- `ctx.serial(name, ...args)` (lines 54–56) — in-order, await until bail.
- `ctx.bail(name, ...args)` (lines 64–66) — sync, stop on first bail value.
- `ctx.waterfall(name, ...args)` (lines 77–79) — compose around `next`.
- `ctx.on(name, listener, options?)` (line 88) — register a fiber-owned
  listener; returns a disposer. `options: boolean | EventOptions`
  (`{ prepend?, global? }`, lines 101–106).
- `ctx.once(name, listener, options?)` (line 97) — auto-disposing `on`.

Listeners are registered as effects on the current fiber
(`EventsService.register`, lines 177) and auto-removed on fiber unload
(line 117 comment). `Hook` record (lines 108–111): `{ ctx, callback, prepend?, global? }`.

Built-in framework `Events` (lines 216–239, PUBLIC but **INTERNAL**
extension points — prefixed `internal/`):
- `internal/plugin(fiber)` — fiber created or uid cleared.
- `internal/status(fiber, oldValue)` — fiber state transition.
- `internal/config(this: Fiber, config, next)` — **waterfall** resolve raw
  config after injections activate.
- `internal/service(this: Context, name, value)` — service binding intercept.
- `internal/update(this: Fiber, config, noSave, next)` — **waterfall** fiber
  config update (HMR can veto/replace).
- `internal/get`, `internal/set` — **waterfall** service read/write through
  the proxy.
- `internal/listener` — **bail** listener registration intercept.
- `internal/dispatch` — fired before non-internal events dispatch.

### 2.5 Fiber lifecycle — `lib/types/fiber.d.ts` (PUBLIC)

`Fiber` (lines 97–200) is one plugin's runtime instance. `FiberState` enum
(lines 67–74): `PENDING=0`, `LOADING=1`, `ACTIVE=2`, `FAILED=3`,
`DISPOSED=4`, `UNLOADING=5`.
- `ctx.fiber` (lines 7–12) — the fiber owning the current context.
- `ctx.effect` (lines 7–12, via `Context.effect` symbol) — register a
  cleanup-aware effect (`Effect` type, lines 49–51): a disposer, a promise of
  one, or a sync/async iterable of disposers. Disposers run in reverse order
  on unload (`Disposable`, line 41).
- `fiber.dispose` (line 112) — unload the plugin.
- `fiber.restart()` (line 187) — dispose + reload with current config.
- `fiber.update(config, noSave?)` (line 199) — runs `internal/update`
  waterfall first, so HMR/update hooks can veto or replace.
- `fiber.await()` (line 180) — wait for lifecycle work, rethrow startup errors.
- `fiber.getEffects()` (line 165) — `EffectMeta[]` diagnostics tree.
- `CordisError` (lines 76–90): `INACTIVE_EFFECT` is the only stable code.

### 2.6 Service base — `lib/types/service.d.ts` (PUBLIC)

`Service` abstract class (lines 9–54): subclasses call `super(ctx, name)`,
which calls `ctx.reflect.provide(name, this, this[Service.check])`. Symbol
keys (lines 12–24): `Service.init` (post-construction for class plugins),
`Service.check` (availability predicate), `Service.config` (phantom intercept
type), `Service.invoke` (callable service body, e.g. `ctx.logger()`),
`Service.extend`, `Service.tracker`, `Service.resolveConfig` (merge intercept
config; lines 52).

### 2.7 Realm / isolate (loader-level) — `cordis-plugin-loader/lib/types/config/isolate.d.ts` (PUBLIC)

- `Realm` abstract class (lines 14–20): symbol-keyed store keyed by entry/label.
- `LocalRealm` (lines 22–26) — entry-local isolation.
- `GlobalRealm` (lines 28–32) — named shared isolation realm.
- `EntryOptions` is augmented (lines 4–11) with `intercept?` and `isolate?`
  (`Dict<true | string>`): an entry can join a named isolate realm.
- Default export `isolate(ctx)` (line 34, **INTERNAL installer**) — installs
  loader hooks applying `intercept`/`isolate` entry options.

### 2.8 Shared symbols — `lib/types/utils.d.ts` (PUBLIC)

`symbols` object (lines 20–38) re-exports the `Context.*` and `Service.*`
symbol keys. `DisposableList<T>` (lines 3–12) is the ordered disposable
collection. `getTraceable` (line 48), `withProps` (line 50), `createCallable`
(line 52) are INTERNAL helpers backing the context proxy and callable services.

---

## 3. Dual-half (Host + Client) Plugin Mechanism

DSH plugins can ship **two independently compiled faces**: a Node **host**
half and a browser **client** half. The split is declared in `package.json`
under a `"dsh"` manifest section and enforced by separate loader pipelines.

### 3.1 The `dsh.client` manifest section

Example — `node_modules/@deepseek-ai/dsh-typert-registry/package.json`:
```json
"dsh": {
  "client": {
    "inject": [],
    "platform": "web",
    "immediately": true
  }
}
```
- `dsh.client.inject` — services the client face requires before activation.
- `dsh.client.platform` — target platform (e.g. `"web"`).
- `dsh.client.immediately` — load the client face on boot vs. on demand.
- `dsh.client.external` (per `dsh-client-modules` README) — extra dynamic
  module requests beyond the seeded baseline.

Examples observed:
- `dsh-typert-registry` — `{ client: { inject: [], platform: "web", immediately: true } }`
- `dsh-client-modules` — `{ client: { platform: "web", inject: [], immediately: true } }`
- `dsh-client-hmr` — `{ client: { inject: [], platform: "web", immediately: true } }`
- `dsh-cordis-client-runner` — `{ client: { inject: ["dsh-client-runtime",
  "dsh-api-remotes", "dsh-client-modules", "dsh-client-ui-theme"], platform: "web" } }`

The **host** half is the package's default `exports["."]` (Node ESM); the
**client** half is `exports["./client"]` (browser bundle). The typert packages
add `./invariant` and `./types` subpaths.

### 3.2 Host-side loader

The Node-side `Loader` (§1.2) imports plugin modules through Node's internal
ESM loader (`ModuleLoaderV1`/`V2`, `cordis-plugin-loader/lib/types/internal.d.ts`).
Bare `@deepseek-ai/dsh-*` specifiers resolve from the config directory or an
optional `bareModuleBaseUrl` (see `boot()` in `dsh-app-boot`).

### 3.3 Client-side loader — `@deepseek-ai/dsh-client-modules`

README: `node_modules/@deepseek-ai/dsh-client-modules/README.md`.
The web shell mounts the vendored cordis Loader for entry governance
(fiber lifecycle, inject waiting, update/refresh) and injects
`ClientModuleLoader` through the Loader's `internal` contract — the vendored
side's only consumption point is `EntryTree.import`, so replacing `internal`
replaces exactly "how plugin code arrives". The Node half scans enabled
Loader entries for web `dsh.client` packages, resolves each
`exports["./client"]`, hashes the built bundle into the boot graph, and
serves each bundle under `/plugins`.

### 3.4 Client HMR — `@deepseek-ai/dsh-client-hmr`

README: `node_modules/@deepseek-ai/dsh-client-hmr/README.md`. The browser half
subscribes to the system SSE channel (`GET /plugins/events`) and reloads one
plugin per `rebuilt` frame through a serialized queue (invalidate → prefetch
→ registry.delete → drain → re-import). Dependents reload through cordis
itself (a fiber's activation epoch strings its service providers' uids, so
replacing a provider cascades dependents with zero client-side graph
analysis). The Node half stat-polls each graph bundle and broadcasts real rev
changes.

### 3.5 What is "Typert"?

"Typert" is DSH's **compiler-independent reflection + RPC** pipeline. Three
packages (all `0.1.1-rc.2`, PUBLIC via `exports`):

- **`@deepseek-ai/dsh-typert-protocol`** (`lib/types/index.d.ts` lines 1–101,
  `lib/types/types.d.ts` 418 lines): compiler-independent Remote metadata
  and provider contracts. Owns `TypertRemoteService` (extends `Service`,
  lines 64–74), the `@Remote` / `@RemoteScope` decorators (lines 80–93),
  `bindTypertRemote` (line 62), `remoteMethods` (line 100),
  `TypertLookupFailure`, `InvocationDescriptor`, codec/provider contracts.
  Declaration-merged maps: `TypertLookupMap`, `TypertContextMap`,
  `TypertRemoteMap`, `TypertRemoteScopeMap`, `TypertRemoteNamespaceMap`,
  `TypertRemoteEventSelection`.

- **`@deepseek-ai/dsh-typert-registry`** (`lib/types/index.d.ts` 17 lines,
  `lib/types/service.d.ts` 103 lines, `lib/types/types.d.ts` 100 lines,
  `lib/types/client/index.d.ts` 10 lines): runtime registry provided as
  `ctx.typert` (`TypertRegistry extends Service`, `service.d.ts` lines 36–102).
  `register(contribution)` (line 59) — atomic per-fiber registration of a
  `TypertContribution` (`types.d.ts` lines 69–76: `package`, `face`
  (`'host'|'client'`), `schemas`, `model` (`TypertPackageModel`:
  services/events/objects), `invocations`). Queries: `get`, `resolve`,
  `list`, `getPackage`, `listPackages`, `toJSONSchema`. Keyed by
  `<package>#<face>` and `<package>#<name>`. The **client face**
  (`lib/types/client/index.d.ts`) is a browser `apply(ctx)` that installs the
  same registry implementation with `inject: []`.

- **`@deepseek-ai/dsh-typert-loader`** (`lib/types/index.d.ts` 60 lines):
  Node-only Loader integration. `apply(ctx, config)` (line 59) scans Loader
  entries, resolves each entry's `package.json`, imports `./typert` (the
  `TYPERT_HOST_EXPORT = "./typert"` constant, line 31), validates its `TYPERT`
  manifest via `validateTypertManifest` (line 52), and registers into
  `ctx.typert` until the entry or this plugin unmounts. Follows Cordis
  `internal/plugin` lifecycle notifications. `Config.packages` (lines 37–40)
  lists additional nested-package artifacts.

So a dual-half package can export `./typert` (host reflection artifact)
alongside `./client` (browser bundle); the loader auto-registers the host
artifact into `ctx.typert`, and the client face is served by the module graph.

---

## 4. Profile / Bundle / Patch-layer Composition

### 4.1 The composition model

Declared in `dsh-app-boot/lib/types/profile.d.ts` (lines 1–172, PUBLIC) and
the `dsh-app-boot` README.

- **Profile** = a directory under `$DSH_HOME/profiles/<name>` holding:
  - `package.json` — out-of-tree plugin `dependencies` + the profile
    manifest `dsh.profile` (`DshProfileManifest.bundles: string[]`,
    `profile.d.ts` lines 36–39).
  - `dsh.profile` — ordered `bundles` layer list.
  - `cordis.patch.yml` — the user's own patch layer
    (`PROFILE_PATCH_FILENAME = "cordis.patch.yml"`, line 29).
- **Bundle** = an npm package whose manifest declares
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`
  (`DshBundleManifest`, lines 31–34). Example: `dsh-base`, `dsh-web-app`,
  `dsh-headless` all ship a `cordis.patch.yml` and declare this field.
- **Layer composition** (`composeEntries`, lines 163–171): apply each
  bundle's patch list in `dsh.profile.bundles` order over an empty entry
  list, then the profile's own patches, then launcher overlays (`--patch`
  files). All through the include's own `applyEntryPatches` — one single
  pass, so flag derivation and config dumps cannot drift from what boots.
- **Two-anchor module resolution** (`resolveBundleDir`, lines 133–145):
  installation anchor first, then profile directory. The installation-first
  order is the contract that `@deepseek-ai/dsh-base` always comes from the
  same installation as the running dsh.
- **Module fallback** (`healProfilesModuleFallback`, lines 99–119):
  maintains flat `$DSH_HOME/profiles/node_modules` symlinks for in-box
  packages so bare plugin names resolve through Node's parent-walk.
- **Templates** (`PROFILE_TEMPLATES`, line 89): `web`, `headless`
  auto-initialize on first use; `DEFAULT_PROFILE_BUNDLES` (line 91) for
  `dsh plugin` init of other names.

### 4.2 Patch semantics — `@deepseek-ai/cordis-plugin-include`

`lib/types/index.d.ts` lines 1–99 (PUBLIC). `applyEntryPatches(data, patches,
warn)` (lines 26) is THE patch semantics, shared by mounting and offline
`dsh --dump-config` tooling so a dump can never drift from what boots. Input
is never mutated; result is always detached. `PatchOptions` (lines 28–39):
`id?`, `insert?` (entry list), `name?`, `config?`, `group?`, `disabled?`,
`inject?`, `intercept?`, `isolate?`. A patch naming an absent entry id is a
stderr warning. `entryListSchema` (line 10) is the YAML dialect
(`!!js` scalars round-trip as expression nodes).

A patch **replaces the targeted row's whole `config`** (no deep-merge) —
documented in `dsh-base/README.md` and `dsh-app-boot/README.md` §"Profiles".
Mode-specific values therefore live in mode bundles, not in `dsh-base`.

### 4.3 The boot sequence — `@deepseek-ai/dsh-app-boot`

`lib/types/index.d.ts` (PUBLIC). `boot(binName, absoluteConfigPath, patches?,
prepare?, bareModuleBaseUrl?)` (lines 249) → `Promise<Context>`:
1. Create root context, expose `dshHomePath(...)` to Loader `!!js` expressions
   (lines 13–18).
2. Install Loader.
3. Run optional `prepare(ctx)` before config-tree entries mount (launcher-
   owned context slots).
4. `mountRootInclude` (line 145): register the statically imported
   `cordis:include` and `cordis:group` builtins, mount the include, retain
   the root entry for user patch-layer HMR.
5. Await the include tree, `assertEntriesLoaded` (line 205) +
   `assertEntriesActivated` (line 218).
6. Return root context — or dispose the partial context and reject a labelled
   error.

Supporting helpers: `resolveConfigPath` (snapshot-aware, line 29),
`loadEnv`/`loadLayeredEnv` (lines 37/49), `installFailLoud` (line 197,
`FAIL_LOUD_RELEASE_TIMEOUT_MS = 2000` line 167), `watchUserPatches` (line 72,
recomposes full patch list through caller's `compose` closure),
`renderConfigDump` (line 133, offline composition matching `boot()`),
`addHarnessSourceSection` (line 266, `HARNESS_SOURCE_SECTION = "harness:source"`
line 251).

### 4.4 Concrete patch layers

- **`dsh-base/cordis.patch.yml`** (451 lines): ONE `insert` over the empty
  root — every base plugin row (timer, hmr, llm, session, typert,
  typert-loader, agent, agent-default-model, tools, system-prompt,
  fs-sandbox, the shell stacks gated by `!!js process.platform`, all
  tool-* rows, subagent providers, workflow, web/search, etc.). Platform
  gating via `disabled: !!js process.platform === 'win32'` (lines 180/186).
- **`dsh-headless/cordis.patch.yml`** (35 lines): rides over `dsh-base` —
  sets the coding `persona`, disables HMR, inserts `code-runtime`,
  `headless-startup`, `headless-runner` (with `inject: [headlessStartup]` and
  `config: { task: !!js ctx.headlessStartup.task }`). No Host/HTTP/browser.
- **`dsh-web-app/cordis.patch.yml`**: rides over `dsh-base` — sets coding
  persona, inserts Web host rows (webserver, API gateway, workspace,
  storage) and the browser plugin roster + always-on client-plugin reload
  chain + the `web-runtime` glue plugin.

### 4.5 `cordis:group` rows

`cordis:group` is registered beside `cordis:include` by `mountRootInclude`
(`dsh-app-boot/README.md` line 18, line 30) so a composition can give one
`isolate` realm to a provider and its consumers together. Both load through
the ambient module pipeline (not the included tree's specifier resolution),
letting out-of-workspace compositions (agent presets under the Harness home)
use a group row. `cordis-plugin-group` just re-exports `Group` from
`cordis-plugin-loader` (`lib/types/index.d.ts` line 2):
`export default Group`. `Group extends EntryGroup`
(`cordis-plugin-loader/lib/types/config/group.d.ts` lines 19–26) and
implements `[Service.init]()` as an `AsyncGenerator` yielding the teardown.

---

## 5. Lifecycle Hooks Available to Plugins

An adapter plugin subscribes via `ctx.on('event', listener)` (§2.4). All
events below are PUBLIC (declared in `interface Events` augmentations of
`@deepseek-ai/cordis`, shipped in `.d.ts` files under `exports`).

### 5.1 Cordis framework events — `cordis/lib/types/events.d.ts` lines 216–239

(INTERNAL extension points — `internal/*`):
`internal/plugin`, `internal/status`, `internal/config` (waterfall),
`internal/service`, `internal/update` (waterfall), `internal/get` (waterfall),
`internal/set` (waterfall), `internal/listener` (bail), `internal/dispatch`.

### 5.2 Loader events — `cordis-plugin-loader/lib/types/index.d.ts` lines 19–25

`exit`, `loader/config-update`, `loader/entry-init`, `loader/partial-dispose`,
`loader/patch-context` (waterfall).

### 5.3 Session lifecycle — `dsh-session/lib/types/index.d.ts` lines 32–77

All `@dshScopeScan unsupported`, scope-filtered (`Scoped<Session>`), `emit`
mode unless noted:
- `session/created(this: Scoped<Session>, session)` (line 44) — creation
  announcement; sync throw vetoes + rolls back.
- `session/disposed(this: Scoped<Session>, session)` (line 54) — leaves the
  store (incl. rollback), never for an unannounced entry.
- `session/event(this: Scoped<Session>, session, event)` (line 66) —
  fire-and-forget post-commit append feed.
- `session/flush(this: Scoped<Session>, session)` (line 75) — **parallel**
  awaited durability checkpoint.

### 5.4 Agent lifecycle — `dsh-agent/lib/types/runtime-types.d.ts` lines 134–322

All scope-filtered (`Scoped<Agent>`), mode in JSDoc:
- `agent/created(this, { agent })` (lines 146–148, **emit**) — published.
- `agent/disposed(this, { agent })` (lines 157–159, **emit**) — left registry.
- `agent/status(this, { agent, status })` (lines 169–172, **emit**) —
  `idle` ⇄ `running`.
- `agent/inbox/inserted` / `agent/inbox/claimed` / `agent/inbox/discarded`
  (lines 180–209, **emit**).
- `agent/session-start(this, { agent, source })` (lines 220–223, **emit**) —
  once before the first turn; use `agent.inject()` to seed context.
- `agent/pre-step(this, { agent, messages, turn, step, signal }, next)`
  (lines 235–241, **waterfall**) — reject or replace step messages.
- `agent/request(this, { agent, turn, step, signal }, next)`
  (lines 254–259, **waterfall**) — replace the call config.
- `agent/request-error(this, { agent, turn, step, provider, failure,
  retryPolicy, signal }, next)` (lines 275–283, **waterfall**) — handle a
  failed attempt (`{ kind: 'retry' }` to own recovery).
- `agent/turn-stopping(this, { agent, turn, signal })`
  (lines 301–305, **serial**) — about to close; steer to continue.
- `agent/error(this, { agent, turn, step, error })` (lines 316–321, **emit**).

The fused dispatcher `agentEvents(ctx, agent, carrier?)`
(`dsh-agent/lib/types/dispatch.d.ts` lines 93, PUBLIC) couples the agent
subject to its scope carrier; `emitAgentEvent` (line 101) is the one-shot
form. `assembleContextFor(agent, signal?)` (line 109) builds the
prompt-assembly context.

### 5.5 Agent-loop event — `dsh-agent-loop/lib/types/index.d.ts` lines 26–41

- `agent-loop/config-start-failed({ sessionId, error })` (**emit**) — a
  declarative agent entry failed before publishing; consumers buffering work
  for that identity reject it instead of waiting forever.

### 5.6 Session-event vocabulary — `dsh-session/lib/types/types.d.ts` lines 223–359

The append-only durable log event types (`SessionEventMap`, merge-extensible):
`turn/start`, `turn/end` (`TurnEndReason`), `step/start`, `step/end`,
`user/message`, `assistant/chunk`, `assistant/message` (`usage?`,
`interrupted?`), `tool/call`, `tool/result` (`error?`, `meta?`),
`todo/write`, `request/header` (`EpochHeader`, `RequestHeaderReason`),
`request/context`, `session/end-seed`. Extensions: `dsh-agent/types` adds
`agent/inbox/spliced` (lines 9–23). Plugins extend the map by declaring
merged variants; unrecognized events without `ignorable: true` must be
refused on reconstruction.

### 5.7 System-prompt events — `dsh-system-prompt/lib/types/index.d.ts` lines 14–34

- `system-prompt/assemble(this: Scoped<SystemPrompt>, assembly, context, next)`
  (line 27, **waterfall**) — expert waterfall over assembled
  sections/contexts/tools/variables; returned value is authoritative
  (subject to `complete` section restore).
- `system-prompt/change()` (line 33, **emit**) — any prompt provider changed.

The `SystemPrompt` service (lines 174–229, PUBLIC) exposes registration
helpers returning exact Cordis effect disposers: `section(PromptSection)`
(line 187), `context(PromptContext)` (line 194), `suppressRuntimeContext()`
(line 201), `tools(provider)` (line 209), `variable(name, provider)` (line
218), `assemble(context?)` (line 228). Constants: `PERSONA_SECTION =
"deployment:persona"`, `PERSONA_ORDER = 0`, `TOOL_ORDER_REST = "<unlisted-tools>"`.

---

## 6. HMR and Include

### 6.1 HMR — `@deepseek-ai/cordis-plugin-hmr` (PUBLIC)

- README: `cordis-plugin-hmr/README.md`. Types: `lib/types/index.d.ts`
  (86 lines). `dsh.client` peer requires `timer`.
- `ctx.hmr` (`Hmr extends Service`, lines 24–76). `Config` (lines 77–85):
  `base?`, `root` (chokidar roots), `debounce`, `ignored` (picomatch).
- Watches source files, traces Node's module graph, clears affected module
  caches, and reloads only the loader entries that depend on changed files.
  Changes to framework-level dependencies fall back to `loader.exit()` (host
  process restart). Requires Node's internal module loader
  (`ModuleLoader.fromInternal()`).
- `registerConfig(filename, refresh)` (line 58, PUBLIC) — watch one exact
  config path outside module roots; refresh callback run serially on
  add/change/unlink; returns async disposer.
- `[Service.init]()` (line 63) — `AsyncGenerator` teardown.
- Events (lines 8–18, PUBLIC):
  - `hmr/change(url)` — changed files not handled by plugin/config reload.
  - `hmr/reload(reloads: Map<Plugin, Reload>)` — after entries reloaded.
  - `hmr/config-update-failed(filename, error)` (**parallel**) — watched
    config-file refresh failed.

### 6.2 Include — `@deepseek-ai/cordis-plugin-include` (PUBLIC)

- README: `cordis-plugin-include/README.md`. Types: `lib/types/index.d.ts`
  (99 lines).
- `Include extends EntryTree` (lines 55–97). `Config` (lines 43–52):
  `path` (YAML/JSON), `initial?`, `patches?: PatchOptions[]`, `enableLogs?`.
- Reads a YAML/JSON file, turns it into loader entries, writes updates back
  when the file is writable. `applyEntryPatches` (line 26) is the shared
  patch semantics (§4.2). `entryListSchema` (line 10) is the YAML dialect.
- `[Service.init]()` (line 82) — `AsyncGenerator` teardown.
- `refresh()` (line 89) — re-read + transactionally refresh child entries;
  last good tree remains on rollback failure.
- `write()` (line 96) — schedule write of current root entry data.

### 6.3 Group — `@deepseek-ai/cordis-plugin-group` (PUBLIC)

- README: `cordis-plugin-group/README.md`. Types: `lib/types/index.d.ts`
  (3 lines). Just `export default Group` re-exported from
  `cordis-plugin-loader`. Nested entry ids use `:` separators
  (`EntryTree.sep = ":"`, `tree.d.ts` line 7). Disabling a group prevents
  children from running.

### 6.4 Timer — `@deepseek-ai/cordis-plugin-timer` (PUBLIC, HMR peer)

- README: `cordis-plugin-timer/README.md`. Disposal-aware timeout/interval/
  throttle/debounce helpers; timer handles are registered on the current
  fiber and cleared automatically on plugin dispose.

---

## Summary — PUBLIC vs INTERNAL

**PUBLIC plugin APIs** (exported via `package.json` `exports`/`types`, JSDoc'd
in `.d.ts`, documented in README):
- Cordis: `Context`, `Service`, `Fiber`, `Plugin`/`Plugin.Runtime`,
  `RegistryService`, `ReflectService`, `EventsService`, `Inject`/`@Inject`,
  `CordisError`/`ValidationError`, `resolveConfig`, `DisposableList`,
  `symbols`.
- `ctx.plugin`, `ctx.inject`, `ctx.provide`, `ctx.get`, `ctx.set`,
  `ctx.accessor`, `ctx.mixin`, `ctx.extend`, `ctx.isolate`, `ctx.intercept`,
  `ctx.on`/`once`/`emit`/`parallel`/`serial`/`bail`/`waterfall`,
  `ctx.effect`, `ctx.fiber`.
- Loader: `Loader`, `Entry`, `EntryTree`, `EntryGroup`, `Group`,
  `EntryOptions`, `Realm`/`LocalRealm`/`GlobalRealm`, `ModuleLoader*`.
- Include: `Include`, `PatchOptions`, `applyEntryPatches`, `entryListSchema`.
- HMR: `Hmr`, `Hmr.Config`, `registerConfig`, events `hmr/*`.
- Typert: `TypertRegistry` (`ctx.typert`), `TypertRemoteService`, `@Remote`/
  `@RemoteScope`, `bindTypertRemote`, `remoteMethods`, `validateTypertManifest`,
  `TypertContribution`/`TypertPackageModel`/`TypertSchema`, the
  `Typert*Map` declaration-merge interfaces.
- DSH app: `boot`, `mountRootInclude`, `loadProfile`/`composeEntries`/
  `resolveBundleDir`/`healProfilesModuleFallback`, `watchUserPatches`,
  `renderConfigDump`, `installFailLoud`, `addHarnessSourceSection`.
- Lifecycle events: `session/*`, `agent/*`, `agent-loop/*`,
  `system-prompt/*`, `loader/*`, `hmr/*`, `exit`.
- Manifest fields: `dsh.bundle.patch`, `dsh.profile.bundles`,
  `dsh.client.{inject,platform,immediately,external}`.

**INTERNAL APIs** (present in `.d.ts` but marked private/`_`-prefixed, or
`internal/*` framework events, or installer-only defaults):
- `internal/plugin`, `internal/status`, `internal/config`, `internal/service`,
  `internal/update`, `internal/get`, `internal/set`, `internal/listener`,
  `internal/dispatch` — framework extension points, not for plugin authors.
- `isolate(ctx)` default export (`cordis-plugin-loader/config/isolate.d.ts`
  line 34) — installer hook applying intercept/isolate entry options.
- `Fiber._execute`/`_reload`/`_unload`/`_resolveConfig`/`_getState`/
  `_updateState`/`_checkImpl`/`_refresh`/`_setEpoch` (private, `fiber.d.ts`).
- `ReflectService._getImpl`, `RegistryService._internal`/`_counter`.
- `utils.ts` helpers (`getTraceable`, `withProps`, `createCallable`,
  `composeError`, `buildOuterStack`) — backing implementation, not for
  plugin authors.
- `ModuleLoader.fromInternal()` — locates Node's internal module loader;
  required by HMR but not a plugin-facing API.
