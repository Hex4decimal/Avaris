'use strict';

const assert = require('assert');
const { planRoutes } = require('../web/routing.js');

function seededRandom(seed) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
}

const random = seededRandom(42);
const commandBase = [40.4842, -88.9937];
const kmPerDegLng = 111.32 * Math.cos(commandBase[0] * Math.PI / 180);
const targets = [];

for (let i = 0; i < 2565; i += 1) {
  const angle = random() * Math.PI * 2;
  const radiusKm = Math.sqrt(random()) * 7.2;
  const lat = commandBase[0] + Math.sin(angle) * radiusKm / 111.32;
  const lng = commandBase[1] + Math.cos(angle) * radiusKm / kmPerDegLng;
  const corridor = Math.abs(Math.sin(angle * 1.5));
  const priority = Math.min(4.8, 0.75 + corridor * 1.2 + random() * 3.9);
  targets.push({ id: i, latlng: [lat, lng], priority });
}

const plan = planRoutes({ targets, droneCount: 5, commandBase, kmPerDegLng });
const assigned = plan.routes.flatMap(route => route.targets);
const unique = new Set(assigned.map(target => target.id));

assert.strictEqual(assigned.length, targets.length, 'every target should be assigned');
assert.strictEqual(unique.size, targets.length, 'targets should be assigned exactly once');
assert.ok(plan.finishSpreadPct < 10, `fleet finish spread is too high: ${plan.finishSpreadPct.toFixed(1)}%`);

let critical = 0;
let criticalInFirstHalf = 0;
for (const route of plan.routes) {
  route.targets.forEach((target, index) => {
    if (target.priority >= plan.options.criticalThreshold) {
      critical += 1;
      if (index < route.targets.length / 2) criticalInFirstHalf += 1;
    }
  });
}
const earlyCriticalShare = critical ? criticalInFirstHalf / critical : 1;
assert.ok(earlyCriticalShare >= 0.60, `critical-zone prioritization is too weak: ${(earlyCriticalShare * 100).toFixed(1)}%`);

console.log(`coverage: ${unique.size}/${targets.length}`);
console.log(`finish spread: ${plan.finishSpreadPct.toFixed(1)}%`);
console.log(`critical zones in first half of routes: ${(earlyCriticalShare * 100).toFixed(1)}%`);
