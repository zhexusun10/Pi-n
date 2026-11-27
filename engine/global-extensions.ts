// Discover resources without loading extension code or changing the user's Pi config.
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { isCaseInsensitive, pathKey, toHostInput } from './path-identity.mjs';
import { fileURLToPath } from 'node:url';
import { DefaultPackageManager, SettingsManager, createBashTimeoutBridge, createMcpExtension, composerCommandsExtension, loadBundledSimpleTimeout, loadBundledWebSearch, type InlineExtension } from './pi-compat.ts';
import { loadPiNMcpConfig } from './mcp-config.ts';
import { hasConfiguredDedicatedSearchApiInDir, isKeenableDisabledInDir } from './search-credentials.mjs';
import workspacePolicy, { createWorkspacePolicy } from './prompt-extension.ts';

// Native ESM reuses the already loaded Pi SDK. Passing this mandatory adapter
// through jiti would load its relative SDK dependency graph a second time.
// Import only code here: the factory captures task paths/role after binding.
export const workspacePolicyName = 'pi-n-workspace-policy';
export const simpleTimeoutName = 'pi-simple-timeout';

const builtins = ['llama.cpp', 'codemode', 'tool-search', 'mcp'];
export const trimId = 'npm:pi-trim';
export const bundledTrim = fileURLToPath(new URL('../node_modules/pi-trim/extensions/index.ts', import.meta.url));
export const continuityId = 'npm:pi-continuity';
export const bundledContinuity = fileURLToPath(new URL('../node_modules/pi-continuity/extensions/index.ts', import.meta.url));
export const simpleTimeoutId = 'npm:pi-simple-timeout';
export const bundledSimpleTimeout = fileURLToPath(new URL('../node_modules/pi-simple-timeout/extensions/index.ts', import.meta.url));
export const webSearchId = 'npm:pi-better-web-search';
export const bundledWebSearch = fileURLToPath(new URL('../node_modules/pi-better-web-search/extensions/index.ts', import.meta.url));
export const webSearchExtension: InlineExtension = {
  name: 'pi-better-web-search', factory: async pi => { await (await loadBundledWebSearch())(pi); },
};
// Bundled extensions are pinned project dependencies; only trim is mandatory.
const bundledExtensions = [
  { id: trimId, name: 'pi-trim', path: bundledTrim, required: true, defaultEnabled: true },
  { id: continuityId, name: 'pi-continuity', path: bundledContinuity, required: false, defaultEnabled: true },
  { id: simpleTimeoutId, name: 'pi-simple-timeout', path: bundledSimpleTimeout, required: false, defaultEnabled: true },
  { id: webSearchId, name: 'pi-better-web-search', path: bundledWebSearch, required: false, defaultEnabled: true },
];
const bundledDefault = (id: string) => bundledExtensions.find(extension => extension.id === id)?.defaultEnabled ?? true;
export const globalAgentDir = () => {
  const path = toHostInput(process.env.PI_N_GLOBAL_PI_AGENT_DIR || join(homedir(), '.pi', 'agent'));
  return resolve(path === '~' || /^~[\\/]/.test(path) ? homedir() + path.slice(1) : path);
};
const identity = (path: string) => pathKey(path);
const keyCase = (value: string, path: string) =>
  isCaseInsensitive(dirname(path)) ? value.toLowerCase() : value;
type PackageNameCache = Map<string, string | undefined>;
function readPackageJsonName(packageRoot: string, cache?: PackageNameCache): string | undefined {
  if (cache?.has(packageRoot)) return cache.get(packageRoot);
  let name: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))?.name;
    if (typeof parsed === 'string' && parsed) name = parsed;
  } catch {}
  cache?.set(packageRoot, name);
  return name;
}
function isBundled(resource: { path: string; metadata: { source: string; packageRoot?: string } }, cache?: PackageNameCache) {
  if (bundledExtensions.some(extension => resource.metadata.source === extension.id ||
    resource.metadata.source.startsWith(`${extension.id}@`) || identity(resource.path) === identity(extension.path))) return true;
  if (resource.metadata.packageRoot) {
    const name = readPackageJsonName(resource.metadata.packageRoot, cache);
    return name !== undefined && bundledExtensions.some(extension => extension.name === name);
  }
  return false;
}
// Scoped packages must keep their full identity (including the directory name
// fallback) or @a/tools and @b/tools would shadow each other's skills.
function packageName(packageRoot: string | undefined, cache?: PackageNameCache): string | undefined {
  if (!packageRoot) return undefined;
  const name = readPackageJsonName(packageRoot, cache);
  if (name) return name;
  const parent = basename(dirname(packageRoot));
  const base = basename(packageRoot);
  return parent.startsWith('@') ? `${parent}/${base}` : base;
}
function extensionName(resource: { path: string; metadata: { source: string; packageRoot?: string } }, cache?: PackageNameCache) {
  return packageName(resource.metadata.packageRoot, cache) ?? basename(resource.path);
}
export function extensionPackageName(resource: { path: string; metadata: { source: string; packageRoot?: string } }, cache?: PackageNameCache): string | undefined {
  return packageName(resource.metadata.packageRoot, cache);
}
export function resourceKey(resource: { path: string; metadata: { source: string; packageRoot?: string; baseDir?: string } }, cache?: PackageNameCache): string {
  if (resource.path.startsWith('builtin:')) return resource.path;
  if (resource.metadata.packageRoot) {
    const name = extensionName(resource, cache);
    const subpath = relative(resource.metadata.packageRoot, resource.path).replace(/\\/g, '/');
    const key = `pkg:${name}:${subpath}`;
    return keyCase(key, resource.path);
  }
  if (resource.metadata.baseDir) {
    const subpath = relative(resource.metadata.baseDir, resource.path).replace(/\\/g, '/');
    const key = `file:${subpath}`;
    return keyCase(key, resource.path);
  }
  const key = `file:${basename(resource.path)}`;
  return keyCase(key, resource.path);
}
export function skillKey(resource: { path: string; metadata?: { packageRoot?: string; baseDir?: string } }, cache?: PackageNameCache): string {
  if (resource.metadata?.packageRoot) {
    const pkg = packageName(resource.metadata.packageRoot, cache) ?? basename(resource.metadata.packageRoot);
    const rel = relative(resource.metadata.packageRoot, resource.path).replace(/\\/g, '/');
    const key = `pkg:${pkg}:${rel}`;
    return keyCase(key, resource.path);
  }
  if (resource.metadata?.baseDir) {
    const rel = relative(resource.metadata.baseDir, resource.path).replace(/\\/g, '/');
    const key = `file:${rel}`;
    return keyCase(key, resource.path);
  }
  const cleanPath = resource.path.replace(/[/\\]SKILL\.md$/i, '').replace(/[/\\]index\.[jt]s$/i, '');
  const key = `file:${basename(cleanPath)}`;
  return keyCase(key, resource.path);
}
interface ExtensionState {
  overrides: Record<string, boolean>;
  webSearch?: { keenablePublic?: boolean };
}
function readExtensionState(directory: string): ExtensionState {
  const path = join(directory, 'extensions.json');
  if (!existsSync(path)) return { overrides: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  const value = parsed?.overrides;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'boolean')) {
    throw new Error('Invalid Pi^n extensions.json');
  }
  if (Object.hasOwn(value, trimId)) throw new Error('Unsupported pi-trim override; pi-trim is required');
  let webSearch: { keenablePublic?: boolean } | undefined;
  if (parsed.webSearch !== undefined) {
    if (!parsed.webSearch || typeof parsed.webSearch !== 'object' || Array.isArray(parsed.webSearch)) {
      throw new Error('Invalid Pi^n extensions.json');
    }
    if (parsed.webSearch.keenablePublic !== undefined && typeof parsed.webSearch.keenablePublic !== 'boolean') {
      throw new Error('Invalid Pi^n extensions.json');
    }
    if (parsed.webSearch.keenablePublic !== undefined) webSearch = { keenablePublic: parsed.webSearch.keenablePublic };
  }
  return webSearch ? { overrides: value, webSearch } : { overrides: value };
}
function overrides(directory: string): Record<string, boolean> {
  return readExtensionState(directory).overrides;
}
async function resolveGlobal() {
  const agentDir = globalAgentDir();
  const path = join(agentDir, 'settings.json');
  const settingsManager = SettingsManager.inMemory(existsSync(path) ? JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) : {}, { projectTrusted: false });
  const manager = new DefaultPackageManager({ cwd: agentDir, agentDir, settingsManager, builtinExtensions: builtins });
  // Settings must not install missing packages on the UI or agent startup path.
  return manager.resolve(async () => 'skip');
}
export interface PiExtension {
  id: string;
  name: string;
  source: string;
  path: string;
  enabled: boolean;
  bundled: boolean;
  required: boolean;
}
function getOverride(state: Record<string, boolean>, id: string): boolean | undefined {
  return Object.hasOwn(state, id) ? state[id] : undefined;
}
export async function extensionCatalog(directory: string) {
  const persisted = readExtensionState(directory);
  const state = persisted.overrides;
  const resources = await resolveGlobal();
  const pkgCache: PackageNameCache = new Map();
  const extensions: PiExtension[] = bundledExtensions.map(({ defaultEnabled, ...extension }) => ({ ...extension, source: extension.id,
    enabled: extension.required || (getOverride(state, extension.id) ?? defaultEnabled), bundled: true }));
  const seen = new Set(extensions.map(extension => extension.id));
  for (const resource of resources.extensions) {
    if (resource.path.startsWith('builtin:') || isBundled(resource, pkgCache)) continue;
    const id = identity(resource.path);
    if (seen.has(id)) continue;
    seen.add(id);
    extensions.push({ id, name: extensionName(resource, pkgCache), source: resource.metadata.source,
      path: resource.path, enabled: getOverride(state, id) === true, bundled: false, required: false });
  }
  const globalDirectory = globalAgentDir();
  const webSearchEnabled = getOverride(state, webSearchId) ?? bundledDefault(webSearchId);
  return {
    globalDirectory,
    extensions,
    webSearch: {
      keenablePublic: webSearchEnabled && persisted.webSearch?.keenablePublic !== false && !isKeenableDisabledInDir(directory),
      hasDedicatedApi: hasConfiguredDedicatedSearchApiInDir(directory, globalDirectory),
    },
  };
}
export async function setExtensionEnabled(
  directory: string,
  id: string,
  enabled: boolean,
  options?: { keenablePublic?: boolean },
) {
  if (id === trimId) throw new Error('Bundled pi-trim is required and cannot be changed');
  const catalog = await extensionCatalog(directory);
  if (!catalog.extensions.some(extension => extension.id === id)) throw new Error('Unknown Pi extension');
  const persisted = readExtensionState(directory);
  persisted.overrides[id] = enabled;
  if (id === webSearchId) {
    if (!enabled) {
      delete persisted.webSearch;
    } else if (options?.keenablePublic !== undefined) {
      persisted.webSearch = { keenablePublic: options.keenablePublic };
    }
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, 'extensions.json');
  const temporary = `${target}.${randomUUID()}.tmp`;
  const payload = persisted.webSearch ? { overrides: persisted.overrides, webSearch: persisted.webSearch } : { overrides: persisted.overrides };
  try {
    writeFileSync(temporary, JSON.stringify(payload, null, 2), { mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    try { rmSync(temporary, { force: true }); } catch {}
  }
  return extensionCatalog(directory);
}

export async function executionResources(args: string[], directory: string, role = process.env.PI_N_MODE) {
  const state = overrides(directory);
  const discoverExtensions = !args.includes('--no-extensions') && !args.includes('-ne');
  const discoverSkills = !args.includes('--no-skills') && !args.includes('-ns');
  const simpleTimeoutAllowed = role === 'planner' || role === 'node' || role === 'merger';
  const simpleTimeoutEnabled = simpleTimeoutAllowed && discoverExtensions && (getOverride(state, simpleTimeoutId) ?? bundledDefault(simpleTimeoutId));
  const bashTimeoutBridge = simpleTimeoutEnabled ? createBashTimeoutBridge() : undefined;
  const extensionFactories: InlineExtension[] = [{
    name: workspacePolicyName,
    factory: bashTimeoutBridge ? createWorkspacePolicy(bashTimeoutBridge) : workspacePolicy,
  }];
  if ((role === 'planner' || role === 'node') && args.some((arg, index) => arg === '--mode' && args[index + 1] === 'rpc')) {
    extensionFactories.push(composerCommandsExtension);
  }
  const extensions: string[] = [];
  const skills: string[] = [];
  const allowed = (role === 'planner' || role === 'node') && (discoverExtensions || discoverSkills);
  if (allowed) {
    const settingsManager = SettingsManager.create(process.cwd(), directory, { projectTrusted: args.includes('--approve') });
    const manager = new DefaultPackageManager({ cwd: process.cwd(), agentDir: directory, settingsManager, builtinExtensions: builtins });
    // Independent discovery only. Both inputs remain fresh for this binding;
    // precedence and factory initialization are applied after both complete.
    const [global, local] = await Promise.all([resolveGlobal(), manager.resolve(async () => 'skip')]);
    const pkgCache: PackageNameCache = new Map();
    const sameGlobalAndDedicated = identity(directory) === identity(globalAgentDir());
    const globalById = new Map<string, typeof global.extensions[number]>();
    const globalByKey = new Map<string, typeof global.extensions[number]>();
    for (const r of global.extensions) {
      if (r.path.startsWith('builtin:') || isBundled(r, pkgCache)) continue;
      globalById.set(identity(r.path), r);
      globalByKey.set(resourceKey(r, pkgCache), r);
    }
    const seenExtensions = new Set<string>();
    const seenKeys = new Set<string>();
    const localPackages = new Set<string>();
    const localKeys = new Set<string>();

    const normalizePkg = (pkg: string) => process.platform === 'win32' ? pkg.toLowerCase() : pkg;
    for (const resource of local.extensions) {
      if (isBundled(resource, pkgCache)) continue;
      const pkg = extensionPackageName(resource, pkgCache);
      if (pkg) localPackages.add(normalizePkg(pkg));
      localKeys.add(resourceKey(resource, pkgCache));
    }

    const candidateList = discoverExtensions
      ? [
          ...local.extensions.map(resource => ({ resource, isLocal: true })),
          ...global.extensions.map(resource => ({ resource, isLocal: false })),
        ]
      : [];

    for (const { resource, isLocal } of candidateList) {
      if (isBundled(resource, pkgCache)) continue; // Use only the selected bundled copies, never global/project duplicates.
      const builtin = resource.path.startsWith('builtin:');
      const id = builtin ? resource.path : identity(resource.path);
      const key = resourceKey(resource, pkgCache);
      const pkg = extensionPackageName(resource, pkgCache);
      const normalizedPkg = pkg ? normalizePkg(pkg) : undefined;

      if (!isLocal) {
        if (normalizedPkg && localPackages.has(normalizedPkg)) continue;
        if (localKeys.has(key) || seenKeys.has(key)) continue;
      }

      const original = builtin ? global.extensions.find(r => r.path === id) : (globalById.get(id) ?? globalByKey.get(key));
      const originalId = original ? identity(original.path) : undefined;
      const explicitOverride = getOverride(state, id) ?? (originalId ? getOverride(state, originalId) : undefined);
      // Discovered external Pi extensions are opt-in: users must explicitly add
      // them in Pi^n Settings before they are mounted. Trusted project-local
      // and dedicated-only Pi^n extensions keep their local enable state.
      const requiresOptIn = !isLocal || (resource.metadata.scope === 'user' && (sameGlobalAndDedicated || original !== undefined));
      const enabled = builtin
        ? (original?.enabled ?? true) && (local.extensions.find(r => r.path === id)?.enabled ?? true)
        : requiresOptIn
          ? explicitOverride === true
          : (explicitOverride ?? resource.enabled);

      if (!enabled || seenExtensions.has(id) || seenKeys.has(key)) continue;
      seenExtensions.add(id);
      seenKeys.add(key);
      extensions.push(resource.path);
    }
    if (discoverSkills) {
      const seenSkills = new Set<string>();
      const seenSkillKeys = new Set<string>();
      const localSkillKeys = new Set<string>();

      for (const resource of local.skills) {
        localSkillKeys.add(skillKey(resource, pkgCache));
      }

      const candidateSkills = [
        ...local.skills.map(resource => ({ resource, isLocal: true })),
        ...global.skills.map(resource => ({ resource, isLocal: false })),
      ];

      for (const { resource, isLocal } of candidateSkills) {
        const id = identity(resource.path);
        const key = skillKey(resource, pkgCache);

        if (!isLocal && localSkillKeys.has(key)) continue;
        if (resource.enabled && !seenSkills.has(id) && !seenSkillKeys.has(key)) {
          seenSkills.add(id);
          seenSkillKeys.add(key);
          skills.push(resource.path);
        }
      }
    }
    // Web search is enabled by default for Planner/Node and only augments roles
    // that already receive user extensions.
    if (discoverExtensions && (getOverride(state, webSearchId) ?? bundledDefault(webSearchId))) {
      extensionFactories.push(webSearchExtension);
    }
    // Keep credentials in Pi^n's dedicated agent directory; read global MCP
    // config fresh, then let dedicated/project entries win name collisions.
    if (extensions.includes('builtin:mcp')) {
      extensions.splice(extensions.indexOf('builtin:mcp'), 1);
      extensionFactories.push({ name: 'pi-n-mcp', factory: createMcpExtension({
        loadConfig: ctx => loadPiNMcpConfig({
          globalDir: globalAgentDir(), agentDir: directory, cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(),
        }),
      }) });
    }
  }
  if (simpleTimeoutEnabled && bashTimeoutBridge) {
    extensionFactories.push({
      name: simpleTimeoutName,
      factory: async pi => { await (await loadBundledSimpleTimeout(bashTimeoutBridge))(pi); },
    });
  }
  const continuityAllowed = role === 'planner' || role === 'node' || role === 'merger';
  if (continuityAllowed && discoverExtensions && (getOverride(state, continuityId) ?? bundledDefault(continuityId))) {
    extensions.push(bundledContinuity);
  }
  extensions.push(bundledTrim);
  return {
    // Only explicit, selected resources reach Pi; no automatic second loading.
    args: [...args, '--no-extensions', '--no-skills', ...extensions.flatMap(path => ['--extension', path]), ...skills.flatMap(path => ['--skill', path])],
    extensionFactories,
  };
}
