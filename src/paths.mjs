import os from 'node:os';
import path from 'node:path';

/** Files that together describe "which plugins are enabled and how". */
export const STATE_FILE_SPECS = Object.freeze([
  { key: 'profilePackage', rel: null, required: true },
  { key: 'profilePatch', rel: null, required: false },
  { key: 'profileCompat', rel: null, required: false },
  { key: 'profileWorkspace', rel: null, required: false },
  { key: 'homePatch', rel: 'cordis.patch.yml', required: false },
]);

export function expandHome(value, homedir = os.homedir()) {
  if (typeof value !== 'string' || value === '') return value;
  if (value === '~') return homedir;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir, value.slice(2));
  return value;
}

export function resolveHome({ home, env = process.env, homedir = os.homedir() } = {}) {
  const explicit = home || env.DSH_HOME;
  if (explicit !== undefined && explicit !== '') return path.resolve(expandHome(explicit, homedir));
  return path.join(homedir, '.dsh');
}

function crashDirs({ home, platform, env, homedir }) {
  const dirs = [];
  const appDirName = '@deepseek-ai/dsh-desktop';
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
    dirs.push(path.join(appData, ...appDirName.split('/'), 'logs'));
  } else if (platform === 'darwin') {
    dirs.push(path.join(homedir, 'Library', 'Application Support', ...appDirName.split('/'), 'logs'));
  } else {
    const configHome = env.XDG_CONFIG_HOME || path.join(homedir, '.config');
    dirs.push(path.join(configHome, ...appDirName.split('/'), 'logs'));
  }
  // DSH NEXT keeps its Chromium side-data inside the shared home.
  dirs.push(path.join(home, 'electron-user-data', 'logs'));
  return dirs;
}

/**
 * Everything the CLI needs to know about where things live.
 * `rel` values are posix-separated and relative to `home`, so snapshots stay
 * portable between machines with different separators.
 */
export function resolveLayout({
  home,
  profile = 'desktop',
  platform = process.platform,
  env = process.env,
  homedir = os.homedir(),
} = {}) {
  const resolvedHome = resolveHome({ home, env, homedir });
  const profileName = String(profile || 'desktop');
  const profileRel = `profiles/${profileName}`;
  const profileDir = path.join(resolvedHome, 'profiles', profileName);

  const stateFiles = [
    { ...STATE_FILE_SPECS[0], rel: `${profileRel}/package.json` },
    { ...STATE_FILE_SPECS[1], rel: `${profileRel}/cordis.patch.yml` },
    { ...STATE_FILE_SPECS[2], rel: `${profileRel}/compatibility.json` },
    { ...STATE_FILE_SPECS[3], rel: `${profileRel}/pnpm-workspace.yaml` },
    { ...STATE_FILE_SPECS[4], rel: 'cordis.patch.yml' },
  ];

  const rescueDir = path.join(resolvedHome, 'rescue');
  return {
    home: resolvedHome,
    profile: profileName,
    profileDir,
    nodeModules: path.join(profileDir, 'node_modules'),
    rescueDir,
    snapshotsDir: path.join(rescueDir, 'snapshots'),
    runtimeCacheFile: path.join(rescueDir, 'runtime.json'),
    stateFiles,
    crashDirs: crashDirs({ home: resolvedHome, platform, env, homedir }),
  };
}

/** Join a posix `rel` onto an absolute directory. */
export function absoluteFor(home, rel) {
  return path.join(home, ...String(rel).split('/'));
}