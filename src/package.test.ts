/**
 * Package-level suite (Task 23.3, FR-14, FR-14.4, design C15, Risk R6).
 *
 * R6: n8n loads community nodes with `require()`. This suite loads the built bundles through
 * `createRequire(import.meta.url)` — the same CommonJS path n8n uses — and checks that each
 * bundle exports its class. The bundle paths come from the `package.json` `n8n` block (the
 * manifest n8n reads), so the suite also proves that the manifest points at files the build emits.
 *
 * `dist/` robustness: the CI workflow runs `npm run build` before `npm test`, so in CI the bundles
 * already exist. For a bare `npm test` on a fresh checkout, `beforeAll` runs the esbuild step
 * (`node build.mjs`, no type check) once when any manifest file is missing. It never rebuilds a
 * present `dist/`.
 *
 * Offline: nothing here opens a socket. The example workflow and README are read as text only.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface PackageManifest {
  name: string;
  files: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  n8n: { n8nNodesApiVersion: number; credentials: string[]; nodes: string[] };
}

interface WorkflowNode {
  name: string;
  type: string;
  typeVersion: number;
  parameters: Record<string, unknown>;
  credentials?: Record<string, { id: string; name: string }>;
}

interface Workflow {
  nodes: WorkflowNode[];
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
}

type Constructor = new () => Record<string, unknown>;

const manifest = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')) as PackageManifest;
const manifestEntries = [...manifest.n8n.credentials, ...manifest.n8n.nodes];
const examplePath = path.join(packageRoot, 'examples', 'chill-and-wait.workflow.json');
const exampleText = readFileSync(examplePath, 'utf8');

function abs(relative: string): string {
  return path.join(packageRoot, relative);
}

/** The single class exported by a CommonJS bundle. */
function exportedClass(relative: string): Constructor {
  const mod = require(abs(relative)) as Record<string, unknown>;
  const classes = Object.values(mod).filter(
    (value): value is Constructor => typeof value === 'function' && /^class\s/.test(String(value)),
  );
  expect(classes, `${relative} must export exactly one class`).toHaveLength(1);
  return classes[0] as Constructor;
}

/** Every file under `dir`, found by a recursive walk (relative paths, `/` separators). */
function walkFiles(dir: string, prefix = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? walkFiles(path.join(dir, entry.name), relative) : [relative];
  });
}

function parseExample(): Workflow {
  return JSON.parse(exampleText) as Workflow;
}

beforeAll(() => {
  if (manifestEntries.every((entry) => existsSync(abs(entry)))) return;
  execFileSync(process.execPath, ['build.mjs'], { cwd: packageRoot, stdio: 'pipe' });
}, 120_000);

describe('package manifest (FR-14, C15)', () => {
  it('test_fr14_manifest_lists_one_credential_and_one_node_under_dist', () => {
    expect(manifest.name).toBe('n8n-nodes-inheco-tec');
    expect(manifest.n8n.n8nNodesApiVersion).toBe(1);
    expect(manifest.n8n.credentials).toHaveLength(1);
    expect(manifest.n8n.nodes).toEqual(['dist/nodes/InhecoTec/InhecoTec.node.js']);
    expect(manifest.files).toContain('dist');
    for (const entry of manifestEntries) {
      expect(entry.startsWith('dist/'), entry).toBe(true);
      expect(entry.endsWith('.js'), entry).toBe(true);
    }
  });

  it('test_fr14_manifest_paths_point_at_files_the_build_emits', () => {
    for (const entry of manifestEntries) {
      expect(existsSync(abs(entry)), `${entry} is missing after the build`).toBe(true);
    }
    // The node icon is copied next to the node bundle (icon: 'file:inhecoTec.svg').
    expect(existsSync(abs('dist/nodes/InhecoTec/inhecoTec.svg'))).toBe(true);
  });
});

describe('CommonJS load of the built bundles (Risk R6)', () => {
  it('test_r6_node_bundle_loads_with_require_and_exports_InhecoTec', () => {
    const NodeClass = exportedClass(manifest.n8n.nodes[0] as string);
    expect(NodeClass.name).toBe('InhecoTec');
    const node = new NodeClass() as { description: { name: string; version: number; credentials: Array<{ name: string }> } };
    expect(node.description.name).toBe('inhecoTec');
    expect(node.description.version).toBe(1);
    expect(node.description.credentials.map((c) => c.name)).toEqual(['inhecoTecApi']);
    expect(typeof (node as unknown as { execute: unknown }).execute).toBe('function');
  });

  it('test_r6_credential_bundle_from_manifest_loads_with_require_and_exports_its_class', () => {
    const CredentialClass = exportedClass(manifest.n8n.credentials[0] as string);
    expect(CredentialClass.name).toBe('InhecoTecApi');
    const credential = new CredentialClass() as { name: string; properties: Array<{ name: string }> };
    expect(credential.name).toBe('inhecoTecApi');
    expect(credential.properties.map((p) => p.name)).toEqual(
      expect.arrayContaining(['baseUrl', 'token', 'caCertificate']),
    );
  });

  it('test_r6_node_bundle_is_commonjs_inlines_core_and_keeps_n8n_workflow_external', () => {
    const bundle = readFileSync(abs(manifest.n8n.nodes[0] as string), 'utf8');
    expect(bundle).toMatch(/module\.exports\s*=/);
    expect(bundle).not.toMatch(/^\s*import\s.+\sfrom\s/m);
    expect(bundle).not.toMatch(/^\s*export\s/m);
    expect(bundle).not.toContain('require("n8n-node-core")');
    expect(bundle).toContain('require("n8n-workflow")');
  });
});

describe('n8n-node-core is vendored and inlined at build time (FR-14.6, Task 25 FR-S1, DD-7)', () => {
  it('test_fr_s1_n8n_node_core_is_not_a_runtime_dependency', () => {
    // The core is vendored under src/vendor/n8n-node-core/, so no dependency field names it:
    // neither a runtime one nor, unlike the monorepo workspace, a devDependency.
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain('n8n-node-core');
    expect(Object.keys(manifest.peerDependencies ?? {})).not.toContain('n8n-node-core');
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain('n8n-node-core');
    expect(existsSync(abs('src/vendor/n8n-node-core/index.ts'))).toBe(true);
  });

  it('test_fr_s1_no_built_file_requires_n8n_node_core', () => {
    const distDir = abs('dist');
    const jsFiles = walkFiles(distDir).filter((file) => /\.[cm]?js$/.test(file));
    expect(jsFiles.length).toBeGreaterThanOrEqual(manifestEntries.length);
    const offenders = jsFiles.filter((file) =>
      /require\(\s*["']n8n-node-core(?:\/[^"']*)?["']\s*\)/.test(readFileSync(path.join(distDir, file), 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});

describe('example workflow chill-and-wait (FR-14.4, C15)', () => {
  const instrumentType = 'n8n-nodes-inheco-tec.inhecoTec';

  it('test_fr14_4_example_parses_as_n8n_workflow_json', () => {
    const workflow = parseExample();
    expect(Array.isArray(workflow.nodes)).toBe(true);
    expect(workflow.nodes.length).toBeGreaterThan(0);
    expect(typeof workflow.connections).toBe('object');
    const names = new Set(workflow.nodes.map((n) => n.name));
    expect(names.size).toBe(workflow.nodes.length);
    for (const [from, value] of Object.entries(workflow.connections)) {
      expect(names.has(from), `connection source ${from}`).toBe(true);
      for (const target of value.main.flat()) {
        expect(names.has(target.node), `connection target ${target.node}`).toBe(true);
      }
    }
  });

  it('test_fr14_4_instrument_steps_use_only_the_package_node_type', () => {
    const workflow = parseExample();
    const instrumentSteps = workflow.nodes.filter((n) => !n.type.startsWith('n8n-nodes-base.'));
    expect(instrumentSteps.length).toBeGreaterThan(0);
    for (const step of instrumentSteps) {
      expect(step.type, step.name).toBe(instrumentType);
      expect(step.typeVersion, step.name).toBe(1);
    }
    // The type prefix is the package name plus the loaded node's description name.
    expect(instrumentType).toBe(`${manifest.name}.inhecoTec`);
  });

  it('test_fr14_4_instrument_operations_exist_on_the_loaded_node', () => {
    const NodeClass = exportedClass(manifest.n8n.nodes[0] as string);
    const node = new NodeClass() as {
      description: { properties: Array<{ name: string; options?: Array<{ value: unknown }> }> };
    };
    const opProperty = node.description.properties.find((p) => p.name === 'operation');
    const known = new Set((opProperty?.options ?? []).map((o) => o.value));
    const used = parseExample()
      .nodes.filter((n) => n.type === instrumentType)
      .map((n) => n.parameters.operation);
    expect(used).toEqual(
      expect.arrayContaining(['setTargetTemperature', 'startTemperatureControl', 'checkAtTarget']),
    );
    for (const op of used) expect(known.has(op), String(op)).toBe(true);
  });

  it('test_fr14_4_example_contains_no_token_or_credential_value', () => {
    expect(exampleText).not.toMatch(/token/i);
    expect(exampleText).not.toMatch(/BEGIN [A-Z ]*(CERTIFICATE|PRIVATE KEY)/);
    expect(exampleText).not.toMatch(/https?:\/\//);
    expect(exampleText).not.toMatch(/\b\d{1,3}(\.\d{1,3}){3}\b/);
    for (const step of parseExample().nodes) {
      for (const ref of Object.values(step.credentials ?? {})) {
        expect(Object.keys(ref).sort(), step.name).toEqual(['id', 'name']);
        expect(ref.id).toMatch(/^REPLACE_/);
      }
    }
  });

  it('test_fr14_4_poll_loop_has_an_iteration_cap_and_stops_on_the_cap', () => {
    const workflow = parseExample();
    const capNode = workflow.nodes.find(
      (n) => n.type === 'n8n-nodes-base.if' && JSON.stringify(n.parameters).includes('$runIndex'),
    );
    expect(capNode, 'an IF node that caps the loop with $runIndex').toBeDefined();
    const cap = capNode as WorkflowNode;
    const [loopBranch, capBranch] = workflow.connections[cap.name]?.main ?? [];
    expect(loopBranch?.length).toBeGreaterThan(0);
    expect(capBranch?.length).toBeGreaterThan(0);
    // The cap branch stops temperature control (fail closed).
    const byName = new Map(workflow.nodes.map((n) => [n.name, n]));
    const capTarget = byName.get(capBranch?.[0]?.node ?? '');
    expect(capTarget?.parameters.operation).toBe('stopTemperatureControl');
    // The loop branch reaches a Wait step that leads back to Check At Target.
    const wait = byName.get(loopBranch?.[0]?.node ?? '');
    expect(wait?.type).toBe('n8n-nodes-base.wait');
    const back = workflow.connections[wait?.name ?? '']?.main.flat().map((t) => byName.get(t.node));
    expect(back?.some((n) => n?.parameters.operation === 'checkAtTarget')).toBe(true);
  });
});
