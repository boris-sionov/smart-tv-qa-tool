#!/usr/bin/env node
'use strict';

/**
 * Regenerates src/build-info.json — the app's version banner (semver + build number).
 *
 * The build number lives in that file and is committed, so it survives clean checkouts.
 * It is bumped only when invoked with --bump AND the working tree moved since the last
 * bump (different HEAD commit, or a dirty tree), so a repeated `npm run build` on the
 * same commit keeps the same build number instead of inflating it.
 *
 *   node scripts/build-info.js            refresh commit/date only (dev)
 *   node scripts/build-info.js --bump     bump when there is a new update (release build)
 *   node scripts/build-info.js --bump --force   always bump
 */

const fs = require('fs');
const path = require('path');
const child_process = require('child_process');

const root = path.resolve(__dirname, '..');
const outFile = path.join(root, 'src', 'build-info.json');

function git(args) {
  try {
    return child_process.execSync(`git ${args}`, {cwd: root, stdio: ['ignore', 'pipe', 'ignore']})
      .toString().trim();
  } catch (e) {
    return '';
  }
}

function readCurrent() {
  try {
    return JSON.parse(fs.readFileSync(outFile, 'utf8'));
  } catch (e) {
    return {};
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const current = readCurrent();

const commit = git('rev-parse --short HEAD');
// Ignore our own output file, so a second build on the same commit does not re-bump.
const dirty = git('status --porcelain')
  .split('\n')
  .filter((line) => line.trim() && !line.endsWith('src/build-info.json'))
  .length > 0;
const bump = process.argv.includes('--bump');
const force = process.argv.includes('--force');

let build = Number.isFinite(current.build) ? current.build : 0;
const isNewUpdate = !commit || commit !== current.commit || dirty;
if (bump && (force || isNewUpdate || build === 0)) {
  build += 1;
}

const info = {
  version: pkg.version,
  build,
  commit,
  branch: git('rev-parse --abbrev-ref HEAD'),
  builtAt: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
};

fs.writeFileSync(outFile, `${JSON.stringify(info, null, 2)}\n`);
console.log(`build-info: v${info.version} (build ${info.build})${info.commit ? ` · ${info.commit}` : ''}`);
