#!/usr/bin/env node
/**
 * P3 worker auto-recommendation helper.
 *
 * Computes a recommended number of WhisperX server worker processes based
 * on available CPU cores and system RAM. The large-v3 model needs ~3-4GB
 * per worker (int8 on CPU) and benefits from ~4 cores each during inference.
 *
 * Heuristic:
 *   byCore = floor(cpuCount / 4)      // leave 4 cores per worker
 *   byRam  = floor(ramGB / 4)         // ~4GB per worker
 *   recommended = max(1, min(3, byCore, byRam))   // cap at 3
 *
 * Usage:
 *   node scripts/p3-recommend-workers.js          # prints single integer to stdout
 *   node scripts/p3-recommend-workers.js --verbose # also prints breakdown to stderr
 *
 * Also exported as a function for programmatic use:
 *   const { recommendWorkers } = require('./p3-recommend-workers.js');
 */

const os = require('os');

function recommendWorkers() {
  const cpuCount = os.cpus().length;
  const ramGB = os.totalmem() / 1e9;
  const byCore = Math.floor(cpuCount / 4);
  const byRam = Math.floor(ramGB / 4);
  const recommended = Math.max(1, Math.min(3, byCore, byRam));
  return {
    recommended,
    cpuCount,
    ramGB: Math.round(ramGB),
    byCore,
    byRam,
  };
}

if (require.main === module) {
  const info = recommendWorkers();
  const verbose = process.argv.includes('--verbose');
  if (verbose) {
    process.stderr.write(
      `P3 auto_workers enabled: using ${info.recommended} workers ` +
      `(cores=${info.cpuCount}, ram=${info.ramGB}GB, byCore=${info.byCore}, ` +
      `byRam=${info.byRam}, capped=3)\n`
    );
  }
  process.stdout.write(String(info.recommended) + '\n');
}

module.exports = { recommendWorkers };
