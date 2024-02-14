import type { Socket } from 'net'
import type { OutputState } from '../../build/output/store'
import type {
  CompilationError,
  HMR_ACTION_TYPES,
  NextJsHotReloaderInterface,
  ReloadPageAction,
  SyncAction,
  TurbopackConnectedAction,
} from './hot-reloader-types'

import ws from 'next/dist/compiled/ws'
import {
  createDefineEnv,
  type Endpoint,
  type TurbopackResult,
  type WrittenEndpoint,
} from '../../build/swc'
import { join } from 'path'
import * as Log from '../../build/output/log'
import {
  getVersionInfo,
  matchNextPageBundleRequest,
} from './hot-reloader-webpack'
import { store as consoleStore } from '../../build/output/store'
import { BLOCKED_PAGES } from '../../shared/lib/constants'
import { getOverlayMiddleware } from 'next/dist/compiled/@next/react-dev-overlay/dist/middleware-turbopack'
import { mkdir, writeFile } from 'fs/promises'
import { PageNotFoundError } from '../../shared/lib/utils'
import { HMR_ACTIONS_SENT_TO_BROWSER } from './hot-reloader-types'
import type { Update as TurbopackUpdate } from '../../build/swc'
import { debounce } from '../utils'
import {
  deleteAppClientCache,
  deleteCache,
} from '../../build/webpack/plugins/nextjs-require-cache-hot-reloader'
import {
  clearModuleContext,
  clearAllModuleContexts,
} from '../lib/render-server'
import { denormalizePagePath } from '../../shared/lib/page-path/denormalize-page-path'
import { trace } from '../../trace'
import type { VersionInfo } from './parse-version-info'
import {
  getTurbopackJsConfig,
  type BuildManifests,
  type AppBuildManifests,
  type PagesManifests,
  type AppPathsManifests,
  type MiddlewareManifests,
  type ActionManifests,
  type FontManifests,
  type LoadableManifests,
  loadMiddlewareManifest,
  writeManifests,
  loadBuildManifest,
  loadPagesManifest,
  loadFontManifest,
  type PageEntrypoints,
  type AppEntrypoints,
  type CurrentIssues,
  processIssues,
  msToNs,
  formatIssue,
  renderStyledStringToErrorAnsi,
  type GlobalEntrypoints,
  type ReadyIds,
  handleRouteType,
  type EntryKey,
  getEntryKey,
  splitEntryKey,
} from './turbopack-utils'
import {
  propagateServerField,
  type ServerFields,
  type SetupOpts,
} from '../lib/router-utils/setup-dev-bundler'
import { findPagePathData } from './on-demand-entry-handler'
import type { RouteDefinition } from '../future/route-definitions/route-definition'

const wsServer = new ws.Server({ noServer: true })
const isTestMode = !!(
  process.env.NEXT_TEST_MODE ||
  process.env.__NEXT_TEST_MODE ||
  process.env.DEBUG
)

class ClientAssetMapper {
  private entryMap: Map<EntryKey, Set<string>> = new Map()
  private assetMap: Map<string, Set<EntryKey>> = new Map()

  constructor() {}

  /**
   * Overrides asset paths for a key and updates the mapping from path to key.
   *
   * @param key
   * @param assetPaths asset paths relative to the .next directory
   */
  setPathsForKey(key: EntryKey, assetPaths: string[]): void {
    this.delete(key)

    const newAssetPaths = new Set(assetPaths)
    this.entryMap.set(key, newAssetPaths)

    for (const assetPath of newAssetPaths) {
      let assetPathKeys = this.assetMap.get(assetPath)
      if (!assetPathKeys) {
        assetPathKeys = new Set()
        this.assetMap.set(assetPath, assetPathKeys)
      }

      assetPathKeys!.add(key)
    }
  }

  /**
   * Deletes the key and any asset only referenced by this key.
   *
   * @param key
   */
  delete(key: EntryKey) {
    for (const assetPath of this.getAssetPathsByKey(key)) {
      const assetPathKeys = this.assetMap.get(assetPath)

      assetPathKeys?.delete(key)

      if (!assetPathKeys?.size) {
        this.assetMap.delete(assetPath)
      }
    }

    this.entryMap.delete(key)
  }

  getAssetPathsByKey(key: EntryKey): string[] {
    return Array.from(this.entryMap.get(key) ?? [])
  }

  getKeysByAsset(path: string): EntryKey[] {
    return Array.from(this.assetMap.get(path) ?? [])
  }

  keys(): IterableIterator<EntryKey> {
    return this.entryMap.keys()
  }
}

export async function createHotReloaderTurbopack(
  opts: SetupOpts,
  serverFields: ServerFields,
  distDir: string
): Promise<NextJsHotReloaderInterface> {
  const { nextConfig, dir } = opts

  const { loadBindings } =
    require('../../build/swc') as typeof import('../../build/swc')

  let bindings = await loadBindings()

  // For the debugging purpose, check if createNext or equivalent next instance setup in test cases
  // works correctly. Normally `run-test` hides output so only will be visible when `--debug` flag is used.
  if (process.env.TURBOPACK && isTestMode) {
    require('console').log('Creating turbopack project', {
      dir,
      testMode: isTestMode,
    })
  }

  const hasRewrites =
    opts.fsChecker.rewrites.afterFiles.length > 0 ||
    opts.fsChecker.rewrites.beforeFiles.length > 0 ||
    opts.fsChecker.rewrites.fallback.length > 0

  const hotReloaderSpan = trace('hot-reloader', undefined, {
    version: process.env.__NEXT_VERSION as string,
  })
  // Ensure the hotReloaderSpan is flushed immediately as it's the parentSpan for all processing
  // of the current `next dev` invocation.
  hotReloaderSpan.stop()

  const project = await bindings.turbo.createProject({
    projectPath: dir,
    rootPath: opts.nextConfig.experimental.outputFileTracingRoot || dir,
    nextConfig: opts.nextConfig,
    jsConfig: await getTurbopackJsConfig(dir, nextConfig),
    watch: true,
    env: process.env as Record<string, string>,
    defineEnv: createDefineEnv({
      isTurbopack: true,
      allowedRevalidateHeaderKeys: undefined,
      clientRouterFilters: undefined,
      config: nextConfig,
      dev: true,
      distDir,
      fetchCacheKeyPrefix: undefined,
      hasRewrites,
      middlewareMatchers: undefined,
      previewModeId: undefined,
    }),
  })
  const entrypointsSubscription = project.entrypointsSubscribe()

  const currentPageEntrypoints: PageEntrypoints = new Map()
  const currentAppEntrypoints: AppEntrypoints = new Map()

  const changeSubscriptions: Map<
    EntryKey,
    Promise<AsyncIterator<any>>
  > = new Map()
  let prevMiddleware: boolean | undefined = undefined

  const globalEntrypoints: GlobalEntrypoints = {
    app: undefined,
    document: undefined,
    error: undefined,
  }
  let currentEntriesHandlingResolve: ((value?: unknown) => void) | undefined
  let currentEntriesHandling = new Promise(
    (resolve) => (currentEntriesHandlingResolve = resolve)
  )
  const hmrPayloads = new Map<string, HMR_ACTION_TYPES>()
  const turbopackUpdates: TurbopackUpdate[] = []

  const currentIssues: CurrentIssues = new Map()
  const serverPathState = new Map<string, string>()

  const assetMapper = new ClientAssetMapper()

  function hasEntrypointForKey(key: EntryKey): boolean {
    const [type, , page] = splitEntryKey(key)

    switch (type) {
      case 'app':
        return currentAppEntrypoints.has(page)
      case 'pages':
        switch (page) {
          case '_app':
            return globalEntrypoints.app != null
          case '_document':
            return globalEntrypoints.app != null
          case '_error':
            return globalEntrypoints.app != null
          default:
            return currentPageEntrypoints.has(page)
        }
      case 'root':
        // we ignore middleware and instrumentation here
        return true
      case 'assets':
        return assetMapper
          .getKeysByAsset(page)
          .some((key) => hasEntrypointForKey(key))
    }
  }

  function clearRequireCache(
    key: EntryKey,
    result: TurbopackResult<WrittenEndpoint>
  ): void {
    // Figure out if the server files have changed
    let hasChange = false
    for (const { path, contentHash } of result.serverPaths) {
      // We ignore source maps
      if (path.endsWith('.map')) continue
      const localKey = `${key}:${path}`
      const localHash = serverPathState.get(localKey)
      const globalHash = serverPathState.get(path)
      if (
        (localHash && localHash !== contentHash) ||
        (globalHash && globalHash !== contentHash)
      ) {
        hasChange = true
        serverPathState.set(key, contentHash)
        serverPathState.set(path, contentHash)
      } else {
        if (!localHash) {
          serverPathState.set(key, contentHash)
        }
        if (!globalHash) {
          serverPathState.set(path, contentHash)
        }
      }
    }

    if (!hasChange) {
      return
    }

    const hasAppPaths = result.serverPaths.some(({ path: p }) =>
      p.startsWith('server/app')
    )

    if (hasAppPaths) {
      deleteAppClientCache()
    }

    const serverPaths = result.serverPaths.map(({ path: p }) =>
      join(distDir, p)
    )

    for (const file of serverPaths) {
      clearModuleContext(file)
      deleteCache(file)
    }

    return
  }

  const buildingIds = new Set()
  const readyIds: ReadyIds = new Set()

  function startBuilding(
    id: string,
    requestUrl: string | undefined,
    forceRebuild: boolean = false
  ) {
    if (!forceRebuild && readyIds.has(id)) {
      return () => {}
    }
    if (buildingIds.size === 0) {
      consoleStore.setState(
        {
          loading: true,
          trigger: id,
          url: requestUrl,
        } as OutputState,
        true
      )
    }
    buildingIds.add(id)
    return function finishBuilding() {
      if (buildingIds.size === 0) {
        return
      }
      readyIds.add(id)
      buildingIds.delete(id)
      if (buildingIds.size === 0) {
        consoleStore.setState(
          {
            loading: false,
          } as OutputState,
          true
        )
      }
    }
  }

  let hmrEventHappened = false
  let hmrHash = 0
  const sendEnqueuedMessages = () => {
    for (const [, issueMap] of currentIssues) {
      if (issueMap.size > 0) {
        // During compilation errors we want to delay the HMR events until errors are fixed
        return
      }
    }
    for (const payload of hmrPayloads.values()) {
      hotReloader.send(payload)
    }
    hmrPayloads.clear()
    if (turbopackUpdates.length > 0) {
      hotReloader.send({
        action: HMR_ACTIONS_SENT_TO_BROWSER.TURBOPACK_MESSAGE,
        data: turbopackUpdates,
      })
      turbopackUpdates.length = 0
    }
  }
  const sendEnqueuedMessagesDebounce = debounce(sendEnqueuedMessages, 2)

  function sendHmr(id: string, payload: HMR_ACTION_TYPES) {
    hmrPayloads.set(`${id}`, payload)
    hmrEventHappened = true
    sendEnqueuedMessagesDebounce()
  }

  function sendTurbopackMessage(payload: TurbopackUpdate) {
    turbopackUpdates.push(payload)
    hmrEventHappened = true
    sendEnqueuedMessagesDebounce()
  }

  const buildManifests: BuildManifests = new Map()
  const appBuildManifests: AppBuildManifests = new Map()
  const pagesManifests: PagesManifests = new Map()
  const appPathsManifests: AppPathsManifests = new Map()
  const middlewareManifests: MiddlewareManifests = new Map()
  const actionManifests: ActionManifests = new Map()
  const fontManifests: FontManifests = new Map()
  const loadableManifests: LoadableManifests = new Map()

  const clientToHmrSubscription: Map<
    ws,
    Map<string, AsyncIterator<any>>
  > = new Map()

  const clients = new Set<ws>()

  async function subscribeToChanges(
    key: EntryKey,
    includeIssues: boolean,
    endpoint: Endpoint | undefined,
    makePayload: (
      change: TurbopackResult
    ) => Promise<HMR_ACTION_TYPES> | HMR_ACTION_TYPES | void
  ) {
    const [, side] = splitEntryKey(key)

    if (!endpoint || changeSubscriptions.has(key)) return

    const changedPromise = endpoint[`${side}Changed`](includeIssues)
    changeSubscriptions.set(key, changedPromise)
    const changed = await changedPromise

    for await (const change of changed) {
      processIssues(currentIssues, key, change)
      const payload = await makePayload(change)
      if (payload) {
        sendHmr(key, payload)
      }
    }
  }

  async function unsubscribeFromChanges(key: EntryKey) {
    const subscription = await changeSubscriptions.get(key)
    if (subscription) {
      await subscription.return?.()
      changeSubscriptions.delete(key)
    }
    currentIssues.delete(key)
  }

  async function subscribeToHmrEvents(id: string, client: ws) {
    const key = getEntryKey('assets', 'client', id)
    if (!hasEntrypointForKey(key)) {
      // maybe throw an error / force the client to reload?
      return
    }

    let mapping = clientToHmrSubscription.get(client)
    if (mapping === undefined) {
      mapping = new Map()
      clientToHmrSubscription.set(client, mapping)
    }
    if (mapping.has(id)) return

    const subscription = project!.hmrEvents(id)
    mapping.set(id, subscription)

    // The subscription will always emit once, which is the initial
    // computation. This is not a change, so swallow it.
    try {
      await subscription.next()

      for await (const data of subscription) {
        processIssues(currentIssues, key, data)
        if (data.type !== 'issues') {
          sendTurbopackMessage(data)
        }
      }
    } catch (e) {
      // The client might be using an HMR session from a previous server, tell them
      // to fully reload the page to resolve the issue. We can't use
      // `hotReloader.send` since that would force every connected client to
      // reload, only this client is out of date.
      const reloadAction: ReloadPageAction = {
        action: HMR_ACTIONS_SENT_TO_BROWSER.RELOAD_PAGE,
      }
      client.send(JSON.stringify(reloadAction))
      client.close()
      return
    }
  }

  function unsubscribeFromHmrEvents(id: string, client: ws) {
    const mapping = clientToHmrSubscription.get(client)
    const subscription = mapping?.get(id)
    subscription?.return!()
  }

  try {
    async function handleEntrypointsSubscription() {
      for await (const entrypoints of entrypointsSubscription) {
        if (!currentEntriesHandlingResolve) {
          currentEntriesHandling = new Promise(
            // eslint-disable-next-line no-loop-func
            (resolve) => (currentEntriesHandlingResolve = resolve)
          )
        }
        globalEntrypoints.app = entrypoints.pagesAppEndpoint
        globalEntrypoints.document = entrypoints.pagesDocumentEndpoint
        globalEntrypoints.error = entrypoints.pagesErrorEndpoint

        currentPageEntrypoints.clear()
        currentAppEntrypoints.clear()

        for (const [pathname, route] of entrypoints.routes) {
          switch (route.type) {
            case 'page':
            case 'page-api':
              currentPageEntrypoints.set(pathname, route)
              break
            case 'app-page': {
              route.pages.forEach((page) => {
                currentAppEntrypoints.set(page.originalName, {
                  type: 'app-page',
                  ...page,
                })
              })
              break
            }
            case 'app-route': {
              currentAppEntrypoints.set(route.originalName, route)
              break
            }
            default:
              Log.info(`skipping ${pathname} (${route.type})`)
              break
          }
        }

        // this needs to be first as `hasEntrypointForKey` uses the `assetMapper`
        for (const key of assetMapper.keys()) {
          if (!hasEntrypointForKey(key)) {
            assetMapper.delete(key)
          }
        }

        for (const key of changeSubscriptions.keys()) {
          // middleware is handled below
          if (!hasEntrypointForKey(key)) {
            await unsubscribeFromChanges(key)
          }
        }

        for (const [key] of currentIssues) {
          if (!hasEntrypointForKey(key)) {
            currentIssues.delete(key)
          }
        }

        for (const [client, mapping] of clientToHmrSubscription) {
          for (const id of mapping.keys()) {
            if (!hasEntrypointForKey(getEntryKey('assets', 'client', id))) {
              unsubscribeFromHmrEvents(id, client)
            }
          }
        }

        const { middleware, instrumentation } = entrypoints
        // We check for explicit true/false, since it's initialized to
        // undefined during the first loop (middlewareChanges event is
        // unnecessary during the first serve)
        if (prevMiddleware === true && !middleware) {
          const key = getEntryKey('root', 'server', 'middleware')

          // Went from middleware to no middleware
          await unsubscribeFromChanges(key)
          currentIssues.delete(key)
          sendHmr('middleware', {
            event: HMR_ACTIONS_SENT_TO_BROWSER.MIDDLEWARE_CHANGES,
          })
        } else if (prevMiddleware === false && middleware) {
          // Went from no middleware to middleware
          sendHmr('middleware', {
            event: HMR_ACTIONS_SENT_TO_BROWSER.MIDDLEWARE_CHANGES,
          })
        }
        if (
          opts.nextConfig.experimental.instrumentationHook &&
          instrumentation
        ) {
          const processInstrumentation = async (
            name: string,
            prop: 'nodeJs' | 'edge'
          ) => {
            const key = getEntryKey('root', 'server', name)

            const writtenEndpoint = await instrumentation[prop].writeToDisk()
            clearRequireCache(key, writtenEndpoint)
            processIssues(currentIssues, key, writtenEndpoint)
          }
          await processInstrumentation('instrumentation.nodeJs', 'nodeJs')
          await processInstrumentation('instrumentation.edge', 'edge')
          await loadMiddlewareManifest(
            distDir,
            middlewareManifests,
            'instrumentation',
            'instrumentation'
          )
          await writeManifests({
            manifests: {
              build: buildManifests,
              appBuild: appBuildManifests,
              pages: pagesManifests,
              appPaths: appPathsManifests,
              middleware: middlewareManifests,
              action: actionManifests,
              font: fontManifests,
              loadable: loadableManifests,
            },

            distDir,
            pageEntrypoints: currentPageEntrypoints,
            rewrites: opts.fsChecker.rewrites,
          })

          serverFields.actualInstrumentationHookFile = '/instrumentation'
          await propagateServerField(
            opts,
            'actualInstrumentationHookFile',
            serverFields.actualInstrumentationHookFile
          )
        } else {
          serverFields.actualInstrumentationHookFile = undefined
          await propagateServerField(
            opts,
            'actualInstrumentationHookFile',
            serverFields.actualInstrumentationHookFile
          )
        }
        if (middleware) {
          const key = getEntryKey('root', 'server', 'middleware')

          const processMiddleware = async () => {
            const writtenEndpoint = await middleware.endpoint.writeToDisk()
            clearRequireCache(key, writtenEndpoint)
            processIssues(currentIssues, key, writtenEndpoint)
            await loadMiddlewareManifest(
              distDir,
              middlewareManifests,
              'middleware',
              'middleware'
            )
            serverFields.middleware = {
              match: null as any,
              page: '/',
              matchers: middlewareManifests.get(key)?.middleware['/'].matchers,
            }
          }
          await processMiddleware()

          subscribeToChanges(key, false, middleware.endpoint, async () => {
            const finishBuilding = startBuilding('middleware', undefined, true)
            await processMiddleware()
            await propagateServerField(
              opts,
              'actualMiddlewareFile',
              serverFields.actualMiddlewareFile
            )
            await propagateServerField(
              opts,
              'middleware',
              serverFields.middleware
            )
            await writeManifests({
              manifests: {
                build: buildManifests,
                appBuild: appBuildManifests,
                pages: pagesManifests,
                appPaths: appPathsManifests,
                middleware: middlewareManifests,
                action: actionManifests,
                font: fontManifests,
                loadable: loadableManifests,
              },

              distDir,
              pageEntrypoints: currentPageEntrypoints,
              rewrites: opts.fsChecker.rewrites,
            })

            finishBuilding()
            return { event: HMR_ACTIONS_SENT_TO_BROWSER.MIDDLEWARE_CHANGES }
          })
          prevMiddleware = true
        } else {
          middlewareManifests.delete(
            getEntryKey('root', 'server', 'middleware')
          )
          serverFields.actualMiddlewareFile = undefined
          serverFields.middleware = undefined
          prevMiddleware = false
        }
        await propagateServerField(
          opts,
          'actualMiddlewareFile',
          serverFields.actualMiddlewareFile
        )
        await propagateServerField(opts, 'middleware', serverFields.middleware)

        currentEntriesHandlingResolve!()
        currentEntriesHandlingResolve = undefined
      }
    }

    handleEntrypointsSubscription().catch((err) => {
      console.error(err)
      process.exit(1)
    })
  } catch (e) {
    console.error(e)
  }

  // Write empty manifests
  await mkdir(join(distDir, 'server'), { recursive: true })
  await mkdir(join(distDir, 'static/development'), { recursive: true })
  await writeFile(
    join(distDir, 'package.json'),
    JSON.stringify(
      {
        type: 'commonjs',
      },
      null,
      2
    )
  )
  await currentEntriesHandling
  await writeManifests({
    manifests: {
      build: buildManifests,
      appBuild: appBuildManifests,
      pages: pagesManifests,
      appPaths: appPathsManifests,
      middleware: middlewareManifests,
      action: actionManifests,
      font: fontManifests,
      loadable: loadableManifests,
    },

    distDir,
    pageEntrypoints: currentPageEntrypoints,
    rewrites: opts.fsChecker.rewrites,
  })
  const overlayMiddleware = getOverlayMiddleware(project)
  const versionInfo: VersionInfo = await getVersionInfo(
    isTestMode || opts.telemetry.isEnabled
  )

  const hotReloader: NextJsHotReloaderInterface = {
    turbopackProject: project,
    activeWebpackConfigs: undefined,
    serverStats: null,
    edgeServerStats: null,
    async run(req, res, _parsedUrl) {
      // intercept page chunks request and ensure them with turbopack
      if (req.url?.startsWith('/_next/static/chunks/pages/')) {
        const params = matchNextPageBundleRequest(req.url)

        if (params) {
          const decodedPagePath = `/${params.path
            .map((param: string) => decodeURIComponent(param))
            .join('/')}`

          const denormalizedPagePath = denormalizePagePath(decodedPagePath)

          await hotReloader
            .ensurePage({
              page: denormalizedPagePath,
              clientOnly: false,
              definition: undefined,
              url: req.url,
            })
            .catch(console.error)
        }
      }

      await overlayMiddleware(req, res)

      // Request was not finished.
      return { finished: undefined }
    },

    // TODO: Figure out if socket type can match the NextJsHotReloaderInterface
    onHMR(req, socket: Socket, head) {
      wsServer.handleUpgrade(req, socket, head, (client) => {
        clients.add(client)
        client.on('close', () => clients.delete(client))

        client.addEventListener('message', ({ data }) => {
          const parsedData = JSON.parse(
            typeof data !== 'string' ? data.toString() : data
          )

          // Next.js messages
          switch (parsedData.event) {
            case 'ping':
              // Ping doesn't need additional handling in Turbopack.
              break
            case 'span-end': {
              hotReloaderSpan.manualTraceChild(
                parsedData.spanName,
                msToNs(parsedData.startTime),
                msToNs(parsedData.endTime),
                parsedData.attributes
              )
              break
            }
            case 'client-hmr-latency': // { id, startTime, endTime, page, updatedModules, isPageHidden }
              hotReloaderSpan.manualTraceChild(
                parsedData.event,
                msToNs(parsedData.startTime),
                msToNs(parsedData.endTime),
                {
                  updatedModules: parsedData.updatedModules,
                  page: parsedData.page,
                  isPageHidden: parsedData.isPageHidden,
                }
              )
              break
            case 'client-error': // { errorCount, clientId }
            case 'client-warning': // { warningCount, clientId }
            case 'client-success': // { clientId }
            case 'server-component-reload-page': // { clientId }
            case 'client-reload-page': // { clientId }
            case 'client-removed-page': // { page }
            case 'client-full-reload': // { stackTrace, hadRuntimeError }
            case 'client-added-page':
              // TODO
              break

            default:
              // Might be a Turbopack message...
              if (!parsedData.type) {
                throw new Error(`unrecognized HMR message "${data}"`)
              }
          }

          // Turbopack messages
          switch (parsedData.type) {
            case 'turbopack-subscribe':
              subscribeToHmrEvents(parsedData.path, client)
              break

            case 'turbopack-unsubscribe':
              unsubscribeFromHmrEvents(parsedData.path, client)
              break

            default:
              if (!parsedData.event) {
                throw new Error(`unrecognized Turbopack HMR message "${data}"`)
              }
          }
        })

        const turbopackConnected: TurbopackConnectedAction = {
          action: HMR_ACTIONS_SENT_TO_BROWSER.TURBOPACK_CONNECTED,
        }
        client.send(JSON.stringify(turbopackConnected))

        const errors = []
        for (const pageIssues of currentIssues.values()) {
          for (const issue of pageIssues.values()) {
            errors.push({
              message: formatIssue(issue),
            })
          }
        }

        const sync: SyncAction = {
          action: HMR_ACTIONS_SENT_TO_BROWSER.SYNC,
          errors,
          warnings: [],
          hash: '',
          versionInfo,
        }

        this.send(sync)
      })
    },

    send(action) {
      const payload = JSON.stringify(action)
      for (const client of clients) {
        client.send(payload)
      }
    },

    setHmrServerError(_error) {
      // Not implemented yet.
    },
    clearHmrServerError() {
      // Not implemented yet.
    },
    async start() {},
    async stop() {
      // Not implemented yet.
    },
    async getCompilationErrors(page) {
      const appKey = getEntryKey('app', 'server', page)
      const pagesKey = getEntryKey('pages', 'server', page)

      const thisPageIssues =
        currentIssues.get(appKey) ?? currentIssues.get(pagesKey)
      if (thisPageIssues !== undefined && thisPageIssues.size > 0) {
        // If there is an error related to the requesting page we display it instead of the first error
        return [...thisPageIssues.values()].map(
          (issue) => new Error(formatIssue(issue))
        )
      }

      // Otherwise, return all errors across pages
      const errors = []
      for (const pageIssues of currentIssues.values()) {
        for (const issue of pageIssues.values()) {
          errors.push(new Error(formatIssue(issue)))
        }
      }
      return errors
    },
    async invalidate({
      // .env files or tsconfig/jsconfig change
      reloadAfterInvalidation,
    }) {
      if (reloadAfterInvalidation) {
        await clearAllModuleContexts()
        this.send({
          action: HMR_ACTIONS_SENT_TO_BROWSER.SERVER_COMPONENT_CHANGES,
        })
      }
    },
    async buildFallbackError() {
      // Not implemented yet.
    },
    async ensurePage({
      page: inputPage,
      // Unused parameters
      // clientOnly,
      // appPaths,
      definition,
      isApp,
      url: requestUrl,
    }) {
      if (BLOCKED_PAGES.includes(inputPage) && inputPage !== '/_error') {
        return
      }

      let routeDef: Pick<RouteDefinition, 'filename' | 'bundlePath' | 'page'> =
        definition ??
        (await findPagePathData(
          dir,
          inputPage,
          nextConfig.pageExtensions,
          opts.pagesDir,
          opts.appDir
        ))

      const page = routeDef.page
      const pathname = definition?.pathname ?? inputPage

      if (page === '/_error') {
        let finishBuilding = startBuilding(pathname, requestUrl)
        try {
          if (globalEntrypoints.app) {
            const key = getEntryKey('pages', 'server', '_app')

            const writtenEndpoint = await globalEntrypoints.app.writeToDisk()
            clearRequireCache(key, writtenEndpoint)
            processIssues(currentIssues, key, writtenEndpoint)
          }
          await loadBuildManifest(distDir, buildManifests, '_app')
          await loadPagesManifest(distDir, pagesManifests, '_app')
          await loadFontManifest(distDir, fontManifests, '_app')

          if (globalEntrypoints.document) {
            const key = getEntryKey('pages', 'server', '_document')

            const writtenEndpoint =
              await globalEntrypoints.document.writeToDisk()
            clearRequireCache(key, writtenEndpoint)
            subscribeToChanges(key, false, globalEntrypoints.document, () => {
              return { action: HMR_ACTIONS_SENT_TO_BROWSER.RELOAD_PAGE }
            })
            processIssues(currentIssues, key, writtenEndpoint)
          }
          await loadPagesManifest(distDir, pagesManifests, '_document')

          if (globalEntrypoints.error) {
            const key = getEntryKey('pages', 'server', '_error')

            const writtenEndpoint = await globalEntrypoints.error.writeToDisk()
            clearRequireCache(key, writtenEndpoint)
            processIssues(currentIssues, key, writtenEndpoint)
          }
          await loadBuildManifest(distDir, buildManifests, '_error')
          await loadPagesManifest(distDir, pagesManifests, '_error')
          await loadFontManifest(distDir, fontManifests, '_error')

          await writeManifests({
            manifests: {
              build: buildManifests,
              appBuild: appBuildManifests,
              pages: pagesManifests,
              appPaths: appPathsManifests,
              middleware: middlewareManifests,
              action: actionManifests,
              font: fontManifests,
              loadable: loadableManifests,
            },

            distDir,
            pageEntrypoints: currentPageEntrypoints,
            rewrites: opts.fsChecker.rewrites,
          })
        } finally {
          finishBuilding()
        }
        return
      }

      await currentEntriesHandling

      const isInsideAppDir = routeDef.bundlePath.startsWith('app/')

      const route = isInsideAppDir
        ? currentAppEntrypoints.get(page)
        : currentPageEntrypoints.get(page)

      if (!route) {
        // TODO: why is this entry missing in turbopack?
        if (page === '/middleware') return
        if (page === '/src/middleware') return
        if (page === '/instrumentation') return
        if (page === '/src/instrumentation') return

        throw new PageNotFoundError(`route not found ${page}`)
      }

      // We don't throw on ensureOpts.isApp === true for page-api
      // since this can happen when app pages make
      // api requests to page API routes.
      if (isApp && route.type === 'page') {
        throw new Error(`mis-matched route type: isApp && page for ${page}`)
      }

      const finishBuilding = startBuilding(pathname, requestUrl)
      try {
        await handleRouteType({
          page,
          pathname,
          route,

          manifests: {
            build: buildManifests,
            appBuild: appBuildManifests,
            pages: pagesManifests,
            appPaths: appPathsManifests,
            middleware: middlewareManifests,
            action: actionManifests,
            font: fontManifests,
            loadable: loadableManifests,
          },

          hooks: {
            subscribeToChanges,
            handleWrittenEndpoint: (key, result) => {
              assetMapper.setPathsForKey(
                key,
                result.clientPaths.map((path) => path.replace(/^_next\//, ''))
              )
              clearRequireCache(key, result)
            },
          },

          globalEntrypoints,
          pageEntrypoints: currentPageEntrypoints,

          rewrites: opts.fsChecker.rewrites,
          distDir,

          readyIds,
          currentIssues,
        })
      } finally {
        finishBuilding()
      }
    },
  }

  ;(async function () {
    for await (const updateMessage of project.updateInfoSubscribe(30)) {
      switch (updateMessage.updateType) {
        case 'start': {
          hotReloader.send({ action: HMR_ACTIONS_SENT_TO_BROWSER.BUILDING })
          break
        }
        case 'end': {
          sendEnqueuedMessages()

          const errors = new Map<string, CompilationError>()
          for (const [, issueMap] of currentIssues) {
            for (const [key, issue] of issueMap) {
              if (errors.has(key)) continue

              const message = formatIssue(issue)

              errors.set(key, {
                message,
                details: issue.detail
                  ? renderStyledStringToErrorAnsi(issue.detail)
                  : undefined,
              })
            }
          }

          hotReloader.send({
            action: HMR_ACTIONS_SENT_TO_BROWSER.BUILT,
            hash: String(++hmrHash),
            errors: [...errors.values()],
            warnings: [],
          })

          if (hmrEventHappened) {
            const time = updateMessage.value.duration
            const timeMessage =
              time > 2000 ? `${Math.round(time / 100) / 10}s` : `${time}ms`
            Log.event(`Compiled in ${timeMessage}`)
            hmrEventHappened = false
          }
          break
        }
        default:
      }
    }
  })().catch(() => {})

  return hotReloader
}
