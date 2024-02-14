import { pathToRegexp } from 'next/dist/compiled/path-to-regexp'
import type { ActionManifest } from '../../build/webpack/plugins/flight-client-entry-plugin'
import type { NextFontManifest } from '../../build/webpack/plugins/next-font-manifest-plugin'
import { generateRandomActionKeyRaw } from '../app-render/action-encryption-utils'
import type { LoadableManifest } from '../load-components'
import type {
  EdgeFunctionDefinition,
  MiddlewareManifest,
} from '../../build/webpack/plugins/middleware-plugin'
import type { PagesManifest } from '../../build/webpack/plugins/pages-manifest-plugin'
import type { AppBuildManifest } from '../../build/webpack/plugins/app-build-manifest-plugin'
import type { BuildManifest } from '../get-page-files'
import type { NextConfigComplete } from '../config-shared'
import loadJsConfig from '../../build/load-jsconfig'
import { join, posix } from 'path'
import { readFile, writeFile } from 'fs/promises'
import {
  APP_BUILD_MANIFEST,
  APP_PATHS_MANIFEST,
  BUILD_MANIFEST,
  MIDDLEWARE_MANIFEST,
  NEXT_FONT_MANIFEST,
  PAGES_MANIFEST,
  SERVER_REFERENCE_MANIFEST,
  REACT_LOADABLE_MANIFEST,
  MIDDLEWARE_BUILD_MANIFEST,
  INTERCEPTION_ROUTE_REWRITE_MANIFEST,
  MIDDLEWARE_REACT_LOADABLE_MANIFEST,
} from '../../shared/lib/constants'
import { writeFileAtomic } from '../../lib/fs/write-atomic'
import { deleteCache } from '../../build/webpack/plugins/nextjs-require-cache-hot-reloader'
import {
  normalizeRewritesForBuildManifest,
  type ClientBuildManifest,
  srcEmptySsgManifest,
} from '../../build/webpack/plugins/build-manifest-plugin'
import type { SetupOpts } from '../lib/router-utils/setup-dev-bundler'
import { isInterceptionRouteRewrite } from '../../lib/generate-interception-routes-rewrites'
import type {
  Issue,
  TurbopackResult,
  StyledString,
  Endpoint,
  WrittenEndpoint,
} from '../../build/swc'
import {
  MAGIC_IDENTIFIER_REGEX,
  decodeMagicIdentifier,
} from '../../shared/lib/magic-identifier'
import { bold, green, magenta, red } from '../../lib/picocolors'
import {
  HMR_ACTIONS_SENT_TO_BROWSER,
  type HMR_ACTION_TYPES,
} from './hot-reloader-types'
import getAssetPathFromRoute from '../../shared/lib/router/utils/get-asset-path-from-route'

export interface InstrumentationDefinition {
  files: string[]
  name: 'instrumentation'
}
export type TurbopackMiddlewareManifest = MiddlewareManifest & {
  instrumentation?: InstrumentationDefinition
}

export function mergeBuildManifests(manifests: Iterable<BuildManifest>) {
  const manifest: Partial<BuildManifest> & Pick<BuildManifest, 'pages'> = {
    pages: {
      '/_app': [],
    },
    // Something in next.js depends on these to exist even for app dir rendering
    devFiles: [],
    ampDevFiles: [],
    polyfillFiles: [],
    lowPriorityFiles: [
      'static/development/_ssgManifest.js',
      'static/development/_buildManifest.js',
    ],
    rootMainFiles: [],
    ampFirstPages: [],
  }
  for (const m of manifests) {
    Object.assign(manifest.pages, m.pages)
    if (m.rootMainFiles.length) manifest.rootMainFiles = m.rootMainFiles
  }
  return manifest
}

export function mergeAppBuildManifests(manifests: Iterable<AppBuildManifest>) {
  const manifest: AppBuildManifest = {
    pages: {},
  }
  for (const m of manifests) {
    Object.assign(manifest.pages, m.pages)
  }
  return manifest
}

export function mergePagesManifests(manifests: Iterable<PagesManifest>) {
  const manifest: PagesManifest = {}
  for (const m of manifests) {
    Object.assign(manifest, m)
  }
  return manifest
}

export function mergeMiddlewareManifests(
  manifests: Iterable<TurbopackMiddlewareManifest>
): MiddlewareManifest {
  const manifest: MiddlewareManifest = {
    version: 2,
    middleware: {},
    sortedMiddleware: [],
    functions: {},
  }
  let instrumentation: InstrumentationDefinition | undefined = undefined
  for (const m of manifests) {
    Object.assign(manifest.functions, m.functions)
    Object.assign(manifest.middleware, m.middleware)
    if (m.instrumentation) {
      instrumentation = m.instrumentation
    }
  }
  const updateFunctionDefinition = (
    fun: EdgeFunctionDefinition
  ): EdgeFunctionDefinition => {
    return {
      ...fun,
      files: [...(instrumentation?.files ?? []), ...fun.files],
    }
  }
  for (const key of Object.keys(manifest.middleware)) {
    const value = manifest.middleware[key]
    manifest.middleware[key] = updateFunctionDefinition(value)
  }
  for (const key of Object.keys(manifest.functions)) {
    const value = manifest.functions[key]
    manifest.functions[key] = updateFunctionDefinition(value)
  }
  for (const fun of Object.values(manifest.functions).concat(
    Object.values(manifest.middleware)
  )) {
    for (const matcher of fun.matchers) {
      if (!matcher.regexp) {
        matcher.regexp = pathToRegexp(matcher.originalSource, [], {
          delimiter: '/',
          sensitive: false,
          strict: true,
        }).source.replaceAll('\\/', '/')
      }
    }
  }
  manifest.sortedMiddleware = Object.keys(manifest.middleware)

  return manifest
}

export async function mergeActionManifests(
  manifests: Iterable<ActionManifest>
) {
  type ActionEntries = ActionManifest['edge' | 'node']
  const manifest: ActionManifest = {
    node: {},
    edge: {},
    encryptionKey: await generateRandomActionKeyRaw(true),
  }

  function mergeActionIds(
    actionEntries: ActionEntries,
    other: ActionEntries
  ): void {
    for (const key in other) {
      const action = (actionEntries[key] ??= {
        workers: {},
        layer: {},
      })
      Object.assign(action.workers, other[key].workers)
      Object.assign(action.layer, other[key].layer)
    }
  }

  for (const m of manifests) {
    mergeActionIds(manifest.node, m.node)
    mergeActionIds(manifest.edge, m.edge)
  }

  return manifest
}

export function mergeFontManifests(manifests: Iterable<NextFontManifest>) {
  const manifest: NextFontManifest = {
    app: {},
    appUsingSizeAdjust: false,
    pages: {},
    pagesUsingSizeAdjust: false,
  }
  for (const m of manifests) {
    Object.assign(manifest.app, m.app)
    Object.assign(manifest.pages, m.pages)

    manifest.appUsingSizeAdjust =
      manifest.appUsingSizeAdjust || m.appUsingSizeAdjust
    manifest.pagesUsingSizeAdjust =
      manifest.pagesUsingSizeAdjust || m.pagesUsingSizeAdjust
  }
  return manifest
}

export function mergeLoadableManifests(manifests: Iterable<LoadableManifest>) {
  const manifest: LoadableManifest = {}
  for (const m of manifests) {
    Object.assign(manifest, m)
  }
  return manifest
}

export async function getTurbopackJsConfig(
  dir: string,
  nextConfig: NextConfigComplete
) {
  const { jsConfig } = await loadJsConfig(dir, nextConfig)
  return jsConfig ?? { compilerOptions: {} }
}

export async function readPartialManifest<T>(
  distDir: string,
  name:
    | typeof MIDDLEWARE_MANIFEST
    | typeof BUILD_MANIFEST
    | typeof APP_BUILD_MANIFEST
    | typeof PAGES_MANIFEST
    | typeof APP_PATHS_MANIFEST
    | `${typeof SERVER_REFERENCE_MANIFEST}.json`
    | `${typeof NEXT_FONT_MANIFEST}.json`
    | typeof REACT_LOADABLE_MANIFEST,
  pageName: string,
  type: 'pages' | 'app' | 'middleware' | 'instrumentation' = 'pages'
): Promise<T> {
  const manifestPath = posix.join(
    distDir,
    `server`,
    type,
    type === 'middleware' || type === 'instrumentation'
      ? ''
      : type === 'app'
      ? pageName
      : getAssetPathFromRoute(pageName),
    name
  )
  return JSON.parse(await readFile(posix.join(manifestPath), 'utf-8')) as T
}

/**
 * `app` -> app dir
 * `pages` -> pages dir
 * `root` -> middleware / instrumentation
 * `assets` -> assets
 */
export type EntryKeyType = 'app' | 'pages' | 'root' | 'assets'
export type EntryKeySide = 'client' | 'server'

export type EntryKey = `${EntryKeyType}@${EntryKeySide}@${string}`

/**
 * Get a key that's unique across all entrypoints.
 */
export function getEntryKey<
  Type extends EntryKeyType,
  Side extends EntryKeySide,
  Page extends string
>(type: Type, side: Side, page: Page): `${Type}@${Side}@${Page}` {
  return `${type}@${side}@${page}` satisfies EntryKey
}

/**
 * Split an `EntryKey` up into its components.
 */
export function splitEntryKey<
  Type extends EntryKeyType,
  Side extends EntryKeySide,
  Page extends string
>(key: `${Type}@${Side}@${Page}`): [Type, Side, Page] {
  const split = (key satisfies EntryKey).split('@', 3)

  if (split.length !== 3) {
    throw new Error(`invalid entry key: ${key}`)
  }

  return [split[0] as Type, split[1] as Side, split[2] as Page]
}

export type BuildManifests = Map<EntryKey, BuildManifest>
export type AppBuildManifests = Map<EntryKey, AppBuildManifest>
export type PagesManifests = Map<EntryKey, PagesManifest>
export type AppPathsManifests = Map<EntryKey, PagesManifest>
export type MiddlewareManifests = Map<EntryKey, TurbopackMiddlewareManifest>
export type ActionManifests = Map<EntryKey, ActionManifest>
export type FontManifests = Map<EntryKey, NextFontManifest>
export type LoadableManifests = Map<EntryKey, LoadableManifest>

export type PageRoute =
  | {
      type: 'page'
      htmlEndpoint: Endpoint
      dataEndpoint: Endpoint
    }
  | {
      type: 'page-api'
      endpoint: Endpoint
    }

export type AppRoute =
  | {
      type: 'app-page'
      htmlEndpoint: Endpoint
      rscEndpoint: Endpoint
    }
  | {
      type: 'app-route'
      endpoint: Endpoint
    }

// pathname -> route
export type PageEntrypoints = Map<string, PageRoute>

// originalName / page -> route
export type AppEntrypoints = Map<string, AppRoute>

export async function loadMiddlewareManifest(
  distDir: string,
  middlewareManifests: MiddlewareManifests,
  pageName: string,
  type: 'pages' | 'app' | 'middleware' | 'instrumentation'
): Promise<void> {
  middlewareManifests.set(
    getEntryKey(
      type === 'middleware' || type === 'instrumentation' ? 'root' : type,
      'server',
      pageName
    ),
    await readPartialManifest(distDir, MIDDLEWARE_MANIFEST, pageName, type)
  )
}

export async function loadBuildManifest(
  distDir: string,
  buildManifests: BuildManifests,
  pageName: string,
  type: 'app' | 'pages' = 'pages'
): Promise<void> {
  buildManifests.set(
    getEntryKey(type, 'server', pageName),
    await readPartialManifest(distDir, BUILD_MANIFEST, pageName, type)
  )
}

async function loadAppBuildManifest(
  distDir: string,
  appBuildManifests: AppBuildManifests,
  pageName: string
): Promise<void> {
  appBuildManifests.set(
    getEntryKey('app', 'server', pageName),
    await readPartialManifest(distDir, APP_BUILD_MANIFEST, pageName, 'app')
  )
}

export async function loadPagesManifest(
  distDir: string,
  pagesManifests: PagesManifests,
  pageName: string
): Promise<void> {
  pagesManifests.set(
    getEntryKey('pages', 'server', pageName),
    await readPartialManifest(distDir, PAGES_MANIFEST, pageName)
  )
}

async function loadAppPathManifest(
  distDir: string,
  appPathsManifests: AppPathsManifests,
  pageName: string
): Promise<void> {
  appPathsManifests.set(
    getEntryKey('app', 'server', pageName),
    await readPartialManifest(distDir, APP_PATHS_MANIFEST, pageName, 'app')
  )
}

async function loadActionManifest(
  distDir: string,
  actionManifests: ActionManifests,
  pageName: string
): Promise<void> {
  actionManifests.set(
    getEntryKey('app', 'server', pageName),
    await readPartialManifest(
      distDir,
      `${SERVER_REFERENCE_MANIFEST}.json`,
      pageName,
      'app'
    )
  )
}

export async function loadFontManifest(
  distDir: string,
  fontManifests: FontManifests,
  pageName: string,
  type: 'app' | 'pages' = 'pages'
): Promise<void> {
  fontManifests.set(
    getEntryKey(type, 'server', pageName),
    await readPartialManifest(
      distDir,
      `${NEXT_FONT_MANIFEST}.json`,
      pageName,
      type
    )
  )
}

async function loadLoadableManifest(
  distDir: string,
  loadableManifests: LoadableManifests,
  pageName: string,
  type: 'app' | 'pages' = 'pages'
): Promise<void> {
  loadableManifests.set(
    getEntryKey(type, 'server', pageName),
    await readPartialManifest(distDir, REACT_LOADABLE_MANIFEST, pageName, type)
  )
}

async function writeBuildManifest(
  distDir: string,
  buildManifests: BuildManifests,
  currentEntrypoints: PageEntrypoints,
  rewrites: SetupOpts['fsChecker']['rewrites']
): Promise<void> {
  const buildManifest = mergeBuildManifests(buildManifests.values())
  const buildManifestPath = join(distDir, BUILD_MANIFEST)
  const middlewareBuildManifestPath = join(
    distDir,
    'server',
    `${MIDDLEWARE_BUILD_MANIFEST}.js`
  )
  const interceptionRewriteManifestPath = join(
    distDir,
    'server',
    `${INTERCEPTION_ROUTE_REWRITE_MANIFEST}.js`
  )
  deleteCache(buildManifestPath)
  deleteCache(middlewareBuildManifestPath)
  deleteCache(interceptionRewriteManifestPath)
  await writeFileAtomic(
    buildManifestPath,
    JSON.stringify(buildManifest, null, 2)
  )
  await writeFileAtomic(
    middlewareBuildManifestPath,
    `self.__BUILD_MANIFEST=${JSON.stringify(buildManifest)};`
  )

  const interceptionRewrites = JSON.stringify(
    rewrites.beforeFiles.filter(isInterceptionRouteRewrite)
  )

  await writeFileAtomic(
    interceptionRewriteManifestPath,
    `self.__INTERCEPTION_ROUTE_REWRITE_MANIFEST=${JSON.stringify(
      interceptionRewrites
    )};`
  )

  const content: ClientBuildManifest = {
    __rewrites: rewrites
      ? (normalizeRewritesForBuildManifest(rewrites) as any)
      : { afterFiles: [], beforeFiles: [], fallback: [] },
    ...Object.fromEntries(
      [...currentEntrypoints.keys()].map((pathname) => [
        pathname,
        `static/chunks/pages${pathname === '/' ? '/index' : pathname}.js`,
      ])
    ),
    sortedPages: [...currentEntrypoints.keys()],
  }
  const buildManifestJs = `self.__BUILD_MANIFEST = ${JSON.stringify(
    content
  )};self.__BUILD_MANIFEST_CB && self.__BUILD_MANIFEST_CB()`
  await writeFileAtomic(
    join(distDir, 'static', 'development', '_buildManifest.js'),
    buildManifestJs
  )
  await writeFileAtomic(
    join(distDir, 'static', 'development', '_ssgManifest.js'),
    srcEmptySsgManifest
  )
}

async function writeFallbackBuildManifest(
  distDir: string,
  buildManifests: BuildManifests
): Promise<void> {
  const fallbackBuildManifest = mergeBuildManifests(
    [
      buildManifests.get(getEntryKey('pages', 'server', '_app')),
      buildManifests.get(getEntryKey('pages', 'server', '_error')),
    ].filter(Boolean) as BuildManifest[]
  )
  const fallbackBuildManifestPath = join(distDir, `fallback-${BUILD_MANIFEST}`)
  deleteCache(fallbackBuildManifestPath)
  await writeFileAtomic(
    fallbackBuildManifestPath,
    JSON.stringify(fallbackBuildManifest, null, 2)
  )
}

async function writeAppBuildManifest(
  distDir: string,
  appBuildManifests: AppBuildManifests
): Promise<void> {
  const appBuildManifest = mergeAppBuildManifests(appBuildManifests.values())
  const appBuildManifestPath = join(distDir, APP_BUILD_MANIFEST)
  deleteCache(appBuildManifestPath)
  await writeFileAtomic(
    appBuildManifestPath,
    JSON.stringify(appBuildManifest, null, 2)
  )
}

async function writePagesManifest(
  distDir: string,
  pagesManifests: PagesManifests
): Promise<void> {
  const pagesManifest = mergePagesManifests(pagesManifests.values())
  const pagesManifestPath = join(distDir, 'server', PAGES_MANIFEST)
  deleteCache(pagesManifestPath)
  await writeFileAtomic(
    pagesManifestPath,
    JSON.stringify(pagesManifest, null, 2)
  )
}

async function writeAppPathsManifest(
  distDir: string,
  appPathsManifests: AppPathsManifests
): Promise<void> {
  const appPathsManifest = mergePagesManifests(appPathsManifests.values())
  const appPathsManifestPath = join(distDir, 'server', APP_PATHS_MANIFEST)
  deleteCache(appPathsManifestPath)
  await writeFileAtomic(
    appPathsManifestPath,
    JSON.stringify(appPathsManifest, null, 2)
  )
}

async function writeMiddlewareManifest(
  distDir: string,
  middlewareManifests: MiddlewareManifests
): Promise<void> {
  const middlewareManifest = mergeMiddlewareManifests(
    middlewareManifests.values()
  )
  const middlewareManifestPath = join(distDir, 'server', MIDDLEWARE_MANIFEST)
  deleteCache(middlewareManifestPath)
  await writeFileAtomic(
    middlewareManifestPath,
    JSON.stringify(middlewareManifest, null, 2)
  )
}

async function writeActionManifest(
  distDir: string,
  actionManifests: ActionManifests
): Promise<void> {
  const actionManifest = await mergeActionManifests(actionManifests.values())
  const actionManifestJsonPath = join(
    distDir,
    'server',
    `${SERVER_REFERENCE_MANIFEST}.json`
  )
  const actionManifestJsPath = join(
    distDir,
    'server',
    `${SERVER_REFERENCE_MANIFEST}.js`
  )
  const json = JSON.stringify(actionManifest, null, 2)
  deleteCache(actionManifestJsonPath)
  deleteCache(actionManifestJsPath)
  await writeFile(actionManifestJsonPath, json, 'utf-8')
  await writeFile(
    actionManifestJsPath,
    `self.__RSC_SERVER_MANIFEST=${JSON.stringify(json)}`,
    'utf-8'
  )
}

async function writeFontManifest(
  distDir: string,
  fontManifests: FontManifests
): Promise<void> {
  const fontManifest = mergeFontManifests(fontManifests.values())
  const json = JSON.stringify(fontManifest, null, 2)

  const fontManifestJsonPath = join(
    distDir,
    'server',
    `${NEXT_FONT_MANIFEST}.json`
  )
  const fontManifestJsPath = join(distDir, 'server', `${NEXT_FONT_MANIFEST}.js`)
  deleteCache(fontManifestJsonPath)
  deleteCache(fontManifestJsPath)
  await writeFileAtomic(fontManifestJsonPath, json)
  await writeFileAtomic(
    fontManifestJsPath,
    `self.__NEXT_FONT_MANIFEST=${JSON.stringify(json)}`
  )
}

async function writeLoadableManifest(
  distDir: string,
  loadableManifests: LoadableManifests
): Promise<void> {
  const loadableManifest = mergeLoadableManifests(loadableManifests.values())
  const loadableManifestPath = join(distDir, REACT_LOADABLE_MANIFEST)
  const middlewareloadableManifestPath = join(
    distDir,
    'server',
    `${MIDDLEWARE_REACT_LOADABLE_MANIFEST}.js`
  )

  const json = JSON.stringify(loadableManifest, null, 2)

  deleteCache(loadableManifestPath)
  deleteCache(middlewareloadableManifestPath)
  await writeFileAtomic(loadableManifestPath, json)
  await writeFileAtomic(
    middlewareloadableManifestPath,
    `self.__REACT_LOADABLE_MANIFEST=${JSON.stringify(json)}`
  )
}

type Manifests = {
  build: BuildManifests
  appBuild: AppBuildManifests
  pages: PagesManifests
  appPaths: AppPathsManifests
  middleware: MiddlewareManifests
  action: ActionManifests
  font: FontManifests
  loadable: LoadableManifests
}

export async function writeManifests({
  manifests,

  distDir,
  pageEntrypoints,
  rewrites,
}: {
  manifests: Manifests

  distDir: string
  pageEntrypoints: PageEntrypoints
  rewrites: SetupOpts['fsChecker']['rewrites']
}): Promise<void> {
  await writeBuildManifest(distDir, manifests.build, pageEntrypoints, rewrites)
  await writeAppBuildManifest(distDir, manifests.appBuild)
  await writePagesManifest(distDir, manifests.pages)
  await writeAppPathsManifest(distDir, manifests.appPaths)
  await writeMiddlewareManifest(distDir, manifests.middleware)
  await writeActionManifest(distDir, manifests.action)
  await writeFontManifest(distDir, manifests.font)
  await writeLoadableManifest(distDir, manifests.loadable)
  await writeFallbackBuildManifest(distDir, manifests.build)
}

class ModuleBuildError extends Error {}

function getIssueKey(issue: Issue): string {
  return [
    issue.severity,
    issue.filePath,
    JSON.stringify(issue.title),
    JSON.stringify(issue.description),
  ].join('-')
}

export function formatIssue(issue: Issue) {
  const { filePath, title, description, source } = issue
  let { documentationLink } = issue
  let formattedTitle = renderStyledStringToErrorAnsi(title).replace(
    /\n/g,
    '\n    '
  )

  // TODO: Use error codes to identify these
  // TODO: Generalize adapting Turbopack errors to Next.js errors
  if (formattedTitle.includes('Module not found')) {
    // For compatiblity with webpack
    // TODO: include columns in webpack errors.
    documentationLink = 'https://nextjs.org/docs/messages/module-not-found'
  }

  let formattedFilePath = filePath
    .replace('[project]/', './')
    .replaceAll('/./', '/')
    .replace('\\\\?\\', '')

  let message

  if (source && source.range) {
    const { start } = source.range
    message = `${formattedFilePath}:${start.line + 1}:${
      start.column + 1
    }\n${formattedTitle}`
  } else if (formattedFilePath) {
    message = `${formattedFilePath}\n${formattedTitle}`
  } else {
    message = formattedTitle
  }
  message += '\n'

  if (source?.range && source.source.content) {
    const { start, end } = source.range
    const { codeFrameColumns } = require('next/dist/compiled/babel/code-frame')

    message +=
      codeFrameColumns(
        source.source.content,
        {
          start: {
            line: start.line + 1,
            column: start.column + 1,
          },
          end: {
            line: end.line + 1,
            column: end.column + 1,
          },
        },
        { forceColor: true }
      ).trim() + '\n\n'
  }

  if (description) {
    message += renderStyledStringToErrorAnsi(description) + '\n\n'
  }

  // TODO: make it possible to enable this for debugging, but not in tests.
  // if (detail) {
  //   message += renderStyledStringToErrorAnsi(detail) + '\n\n'
  // }

  // TODO: Include a trace from the issue.

  if (documentationLink) {
    message += documentationLink + '\n\n'
  }

  return message
}

export type CurrentIssues = Map<EntryKey, Map<string, Issue>>

export function processIssues(
  currentIssues: CurrentIssues,
  key: EntryKey,
  result: TurbopackResult,
  throwIssue = false
) {
  const newIssues = new Map<string, Issue>()
  currentIssues.set(key, newIssues)

  const relevantIssues = new Set()

  for (const issue of result.issues) {
    if (issue.severity !== 'error' && issue.severity !== 'fatal') continue
    const issueKey = getIssueKey(issue)
    const formatted = formatIssue(issue)
    newIssues.set(issueKey, issue)

    // We show errors in node_modules to the console, but don't throw for them
    if (/(^|\/)node_modules(\/|$)/.test(issue.filePath)) continue
    relevantIssues.add(formatted)
  }

  if (relevantIssues.size && throwIssue) {
    throw new ModuleBuildError([...relevantIssues].join('\n\n'))
  }
}

export function renderStyledStringToErrorAnsi(string: StyledString): string {
  function decodeMagicIdentifiers(str: string): string {
    return str.replaceAll(MAGIC_IDENTIFIER_REGEX, (ident) => {
      try {
        return magenta(`{${decodeMagicIdentifier(ident)}}`)
      } catch (e) {
        return magenta(`{${ident} (decoding failed: ${e})}`)
      }
    })
  }

  switch (string.type) {
    case 'text':
      return decodeMagicIdentifiers(string.value)
    case 'strong':
      return bold(red(decodeMagicIdentifiers(string.value)))
    case 'code':
      return green(decodeMagicIdentifiers(string.value))
    case 'line':
      return string.value.map(renderStyledStringToErrorAnsi).join('')
    case 'stack':
      return string.value.map(renderStyledStringToErrorAnsi).join('\n')
    default:
      throw new Error('Unknown StyledString type', string)
  }
}

const MILLISECONDS_IN_NANOSECOND = 1_000_000

export function msToNs(ms: number): bigint {
  return BigInt(Math.floor(ms)) * BigInt(MILLISECONDS_IN_NANOSECOND)
}

export interface GlobalEntrypoints {
  app: Endpoint | undefined
  document: Endpoint | undefined
  error: Endpoint | undefined
}

export type HandleWrittenEndpoint = (
  key: EntryKey,
  result: TurbopackResult<WrittenEndpoint>
) => void

export type ChangeSubscription = (
  key: EntryKey,
  includeIssues: boolean,
  endpoint: Endpoint | undefined,
  makePayload: (
    change: TurbopackResult
  ) => Promise<HMR_ACTION_TYPES> | HMR_ACTION_TYPES | void
) => Promise<void>

export type ReadyIds = Set<string>

type HandleRouteHooks = {
  handleWrittenEndpoint?: HandleWrittenEndpoint
  subscribeToChanges?: ChangeSubscription
}

type HandleRouteTypeArgs = {
  page: string
  pathname: string
  route: PageRoute | AppRoute

  manifests: Manifests
  hooks: HandleRouteHooks

  globalEntrypoints: GlobalEntrypoints
  pageEntrypoints: PageEntrypoints

  rewrites: SetupOpts['fsChecker']['rewrites']
  distDir: string

  readyIds: ReadyIds
  currentIssues: CurrentIssues
}

export async function handleRouteType({
  page,
  pathname,
  route,

  manifests,
  hooks,

  globalEntrypoints,
  pageEntrypoints,

  rewrites,
  distDir,

  readyIds,
  currentIssues,
}: HandleRouteTypeArgs) {
  switch (route.type) {
    case 'page': {
      const clientKey = getEntryKey('pages', 'client', page)
      const serverKey = getEntryKey('pages', 'server', page)

      try {
        if (globalEntrypoints.app) {
          const key = getEntryKey('pages', 'server', '_app')

          const writtenEndpoint = await globalEntrypoints.app.writeToDisk()
          hooks.handleWrittenEndpoint?.(key, writtenEndpoint)
          processIssues(currentIssues, key, writtenEndpoint)
        }
        await loadBuildManifest(distDir, manifests.build, '_app')
        await loadPagesManifest(distDir, manifests.pages, '_app')

        if (globalEntrypoints.document) {
          const key = getEntryKey('pages', 'server', '_document')

          const writtenEndpoint = await globalEntrypoints.document.writeToDisk()
          hooks.handleWrittenEndpoint?.(key, writtenEndpoint)
          processIssues(currentIssues, key, writtenEndpoint)
        }
        await loadPagesManifest(distDir, manifests.pages, '_document')

        const writtenEndpoint = await route.htmlEndpoint.writeToDisk()
        hooks.handleWrittenEndpoint?.(serverKey, writtenEndpoint)

        const type = writtenEndpoint?.type

        await loadBuildManifest(distDir, manifests.build, page)
        await loadPagesManifest(distDir, manifests.pages, page)
        if (type === 'edge') {
          await loadMiddlewareManifest(
            distDir,
            manifests.middleware,
            page,
            'pages'
          )
        } else {
          manifests.middleware.delete(serverKey)
        }
        await loadFontManifest(distDir, manifests.font, page, 'pages')
        await loadLoadableManifest(distDir, manifests.loadable, page, 'pages')

        await writeManifests({
          manifests,

          distDir,
          pageEntrypoints,
          rewrites,
        })

        processIssues(currentIssues, serverKey, writtenEndpoint)
      } finally {
        hooks.subscribeToChanges?.(serverKey, false, route.dataEndpoint, () => {
          // Report the next compilation again
          readyIds.delete(pathname)
          return {
            event: HMR_ACTIONS_SENT_TO_BROWSER.SERVER_ONLY_CHANGES,
            pages: [page],
          }
        })
        hooks.subscribeToChanges?.(clientKey, false, route.htmlEndpoint, () => {
          return {
            event: HMR_ACTIONS_SENT_TO_BROWSER.CLIENT_CHANGES,
          }
        })
        if (globalEntrypoints.document) {
          hooks.subscribeToChanges?.(
            getEntryKey('pages', 'server', '_document'),
            false,
            globalEntrypoints.document,
            () => {
              return { action: HMR_ACTIONS_SENT_TO_BROWSER.RELOAD_PAGE }
            }
          )
        }
      }

      break
    }
    case 'page-api': {
      const key = getEntryKey('pages', 'server', page)

      const writtenEndpoint = await route.endpoint.writeToDisk()
      hooks.handleWrittenEndpoint?.(key, writtenEndpoint)

      const type = writtenEndpoint?.type

      await loadPagesManifest(distDir, manifests.pages, page)
      if (type === 'edge') {
        await loadMiddlewareManifest(
          distDir,
          manifests.middleware,
          page,
          'pages'
        )
      } else {
        manifests.middleware.delete(key)
      }
      await loadLoadableManifest(distDir, manifests.loadable, page, 'pages')

      await writeManifests({
        manifests,
        distDir,
        pageEntrypoints,
        rewrites,
      })

      processIssues(currentIssues, key, writtenEndpoint)

      break
    }
    case 'app-page': {
      const key = getEntryKey('app', 'server', page)

      const writtenEndpoint = await route.htmlEndpoint.writeToDisk()
      hooks.handleWrittenEndpoint?.(key, writtenEndpoint)

      hooks.subscribeToChanges?.(key, true, route.rscEndpoint, (change) => {
        if (change.issues.some((issue) => issue.severity === 'error')) {
          // Ignore any updates that has errors
          // There will be another update without errors eventually
          return
        }
        // Report the next compilation again
        readyIds.delete(pathname)
        return {
          action: HMR_ACTIONS_SENT_TO_BROWSER.SERVER_COMPONENT_CHANGES,
        }
      })

      const type = writtenEndpoint?.type

      if (type === 'edge') {
        await loadMiddlewareManifest(distDir, manifests.middleware, page, 'app')
      } else {
        manifests.middleware.delete(key)
      }

      await loadAppBuildManifest(distDir, manifests.appBuild, page)
      await loadBuildManifest(distDir, manifests.build, page, 'app')
      await loadAppPathManifest(distDir, manifests.appPaths, page)
      await loadActionManifest(distDir, manifests.action, page)
      await loadFontManifest(distDir, manifests.font, page, 'app')

      await writeManifests({
        manifests,
        distDir,
        pageEntrypoints,
        rewrites,
      })

      processIssues(currentIssues, key, writtenEndpoint, true)

      break
    }
    case 'app-route': {
      const key = getEntryKey('app', 'server', page)

      const writtenEndpoint = await route.endpoint.writeToDisk()
      hooks.handleWrittenEndpoint?.(key, writtenEndpoint)

      const type = writtenEndpoint?.type

      await loadAppPathManifest(distDir, manifests.appPaths, page)
      if (type === 'edge') {
        await loadMiddlewareManifest(distDir, manifests.middleware, page, 'app')
      } else {
        manifests.middleware.delete(key)
      }

      await writeManifests({
        manifests,
        distDir,
        pageEntrypoints,
        rewrites,
      })
      processIssues(currentIssues, key, writtenEndpoint, true)

      break
    }
    default: {
      throw new Error(`unknown route type ${(route as any).type} for ${page}`)
    }
  }
}
