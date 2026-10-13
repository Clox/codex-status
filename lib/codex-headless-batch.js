'use strict';

// The caller owns the exclusive lock and client lease for this entire loop.
// A new decision is made after every terminal turn and every verified switch.
async function runHeadlessBatch({ nextPlan, switchTarget, runCandidate, onNoWork,
  maxSteps = 64 }) {
  let completed = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    const plan = await nextPlan();
    if (plan.action !== 'resume' || !plan.candidates?.length) {
      await onNoWork(plan, completed);
      return { completed, plan };
    }
    if (await switchTarget(plan)) continue;
    const result = await runCandidate(plan.candidates[0], plan);
    if (result === 'replan') continue;
    completed += 1;
  }
  throw new Error('AUTO_BATCH_REPLAN_LIMIT');
}

module.exports = { runHeadlessBatch };
