import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SHIPPED_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];

export const DEFAULT_PATCH = [
  '# 用户补丁层（测试夹具）',
  '# 这行中文注释必须原样保留，用来证明我们只追加不重排',
  '- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      aliyun:',
  '        api: openai-completions',
  '        defaultMaxTokens: 32768',
  '',
  '- id: compaction-basic',
  '  config:',
  '    thresholdRatio: 0.8',
  '',
].join('\n');

export function tempDir(prefix = 'dsh-rescue-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function removeDir(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

export function readFileOrNull(target) {
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return null;
  }
}

export function readJsonFile(target) {
  const text = readFileOrNull(target);
  return text === null ? null : JSON.parse(text);
}

export function writeManifest(profileDir, name, manifest) {
  const dir = path.join(profileDir, 'node_modules', ...String(name).split('/'));
  fs.mkdirSync(dir, { recursive: true });
  if (manifest === null) return dir;
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return dir;
}

/**
 * Build a synthetic DSH home that looks enough like the real one to exercise
 * every code path, without ever touching the user's own ~/.dsh.
 */
export function makeHome(options = {}) {
  const home = options.home ?? tempDir();
  const profile = options.profile ?? 'desktop';
  const profileDir = path.join(home, 'profiles', profile);
  fs.mkdirSync(profileDir, { recursive: true });

  const bundles = options.bundles ?? [...SHIPPED_BUNDLES, 'dsh-fake-plugin'];
  const nonShipped = bundles.filter((name) => typeof name === 'string' && !SHIPPED_BUNDLES.includes(name));
  const dependencies = options.deps ?? Object.fromEntries(nonShipped.map((name) => [name, '^1.0.0']));

  let packageJson = options.packageJson;
  if (packageJson === undefined) {
    packageJson = {
      name: 'dsh-profile-desktop',
      private: true,
      dependencies,
      dsh: { profile: { bundles } },
    };
    if (options.bundlesRaw !== undefined) packageJson.dsh.profile.bundles = options.bundlesRaw;
    if (options.dshExtra) Object.assign(packageJson.dsh, options.dshExtra);
  }
  if (options.writePackageJson !== false) {
    fs.writeFileSync(
      path.join(profileDir, 'package.json'),
      typeof packageJson === 'string' ? packageJson : `${JSON.stringify(packageJson, null, 2)}\n`,
    );
  }

  if (options.nodeModules !== false) {
    const packages = options.packages ?? {};
    const names = new Set([...nonShipped, ...Object.keys(packages)]);
    for (const name of names) {
      const custom = packages[name];
      if (custom === null) {
        writeManifest(profileDir, name, null);
        continue;
      }
      const manifest = {
        name,
        version: '1.0.0',
        peerDependencies: { '@deepseek-ai/dsh': '^0.2.0' },
        dsh: { bundle: { patch: 'cordis.patch.yml' } },
        ...(custom ?? {}),
      };
      const dir = writeManifest(profileDir, name, manifest);
      const declared = manifest.dsh?.bundle?.patch;
      const patchRel = Array.isArray(declared) ? declared[0] : declared;
      if (typeof patchRel === 'string' && !fs.existsSync(path.join(dir, patchRel))) {
        fs.writeFileSync(path.join(dir, patchRel), '- id: llm-pi-ai\n- id: compaction-basic\n');
      }
    }
  }

  if (options.patch !== false) {
    const text = options.patch === undefined ? DEFAULT_PATCH : options.patch;
    fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), text);
  }
  if (options.compat !== undefined && options.compat !== null) {
    fs.writeFileSync(
      path.join(profileDir, 'compatibility.json'),
      typeof options.compat === 'string' ? options.compat : `${JSON.stringify(options.compat, null, 2)}\n`,
    );
  }
  if (options.workspace !== undefined) {
    fs.writeFileSync(path.join(profileDir, 'pnpm-workspace.yaml'), options.workspace);
  }
  if (options.homePatch !== undefined) {
    fs.writeFileSync(path.join(home, 'cordis.patch.yml'), options.homePatch);
  }

  return {
    home,
    profile,
    profileDir,
    nodeModules: path.join(profileDir, 'node_modules'),
    packageFile: path.join(profileDir, 'package.json'),
    patchFile: path.join(profileDir, 'cordis.patch.yml'),
  };
}

/** A CLI io stub: captured streams, no TTY, no colour, deterministic runtime. */
export function makeIo({ home, profile, runtimeVersion = '0.2.1-rc.3', detector, env } = {}) {
  const stdoutChunks = [];
  const stderrChunks = [];
  const stdout = {
    isTTY: false,
    write(chunk) {
      stdoutChunks.push(String(chunk));
      return true;
    },
  };
  const stderr = {
    isTTY: false,
    write(chunk) {
      stderrChunks.push(String(chunk));
      return true;
    },
  };
  const stdin = { isTTY: false };
  const argvEnv = {
    ...process.env,
    ...(home ? { DSH_HOME: home } : {}),
    NO_COLOR: '1',
    DSH_RESCUE_ASSUME_RUNNING: '0',
    ...(env ?? {}),
  };
  return {
    io: { stdout, stderr, stdin, env: argvEnv, runtimeVersion, detector, platform: process.platform },
    stdout: () => stdoutChunks.join(''),
    stderr: () => stderrChunks.join(''),
    json() {
      const text = stdoutChunks.join('').trim();
      return JSON.parse(text);
    },
    args(extra = []) {
      const base = [...extra];
      if (home) base.push('--home', home);
      if (profile) base.push('--profile', profile);
      return base;
    },
  };
}