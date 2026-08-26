/**
 * CLI: Full ROI / wallet / DB diagnostic
 * Usage (from backend folder):
 *   node scripts/debugPayout.js
 *   node scripts/debugPayout.js 2026-08-26
 */
import '../loadEnv.js';
import { buildPayoutDebugReport } from '../services/payoutDebugService.js';

const asOfDate = process.argv[2] || null;

const report = await buildPayoutDebugReport({ asOfDate });

console.log('\n========== XIT PAYOUT DEBUG ==========');
console.log('IST date:', report.istDate, '| asOf:', report.asOfDate);
console.log('\n--- ENV ---');
console.log(JSON.stringify(report.env, null, 2));
console.log('\n--- DATABASE ---');
console.log(JSON.stringify(report.database, null, 2));
console.log('\n--- PLATFORM ---');
console.log(JSON.stringify(report.platform, null, 2));
console.log('\n--- SUMMARY ---');
console.log(JSON.stringify(report.summary, null, 2));
console.log('\n--- SPOT CHECK users 50-52 ---');
console.log(JSON.stringify(report.spotCheckUsers50to52, null, 2));
console.log('\n--- PAYOUT RUNS TODAY ---');
console.log(JSON.stringify(report.payoutRunsToday, null, 2));
console.log('\n--- NOTES ---');
for (const n of report.notes) console.log('!', n);
console.log('\n--- PREDICTED FAILURES ---');
console.log(JSON.stringify(report.failuresPredicted, null, 2));
console.log('\n--- ELIGIBLE / ACTIONABLE INVESTMENTS ---');
for (const inv of report.investments.filter((i) => i.eligible || i.predictedAction.startsWith('FAIL'))) {
  console.log(
    `inv#${inv.investmentId} user=${inv.username}(${inv.userId}) ` +
      `${inv.tokenAmount} XIT | wallet=${inv.hasWallet ? inv.walletMasked : 'NONE'} | ` +
      `roi=${inv.calcRoi} days=${inv.calcDays} | ${inv.predictedAction}`
  );
}
console.log('\n========== END DEBUG ok=' + report.ok + ' ==========\n');

// Also write full JSON next to script for copy
process.exit(report.ok ? 0 : 2);
