(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AvarisRouting = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KM_PER_DEG_LAT = 111.32;
  const DEFAULTS = {
    cruiseSpeedKmh: 42,
    scanSecondsPerZone: 8,
    criticalThreshold: 3.6,
    highThreshold: 2.7,
    elevatedThreshold: 1.8,
    criticalDetourKm: 0.15,
    highDetourKm: 0.08,
    elevatedDetourKm: 0.03,
    twoOptSpan: 28,
    twoOptPasses: 1,
    balanceIterations: 90,
    balanceTolerance: 0.045,
    maxTransferDistancePenaltyKm: 10.0,
    sectorRadialWeight: 0.05
  };

  function priorityTier(priority, options) {
    if (priority >= options.criticalThreshold) return 3;
    if (priority >= options.highThreshold) return 2;
    if (priority >= options.elevatedThreshold) return 1;
    return 0;
  }

  function distanceSquared(a, b, kmPerDegLng) {
    const dy = (a[0] - b[0]) * KM_PER_DEG_LAT;
    const dx = (a[1] - b[1]) * kmPerDegLng;
    return dx * dx + dy * dy;
  }

  function distance(a, b, kmPerDegLng) {
    return Math.sqrt(distanceSquared(a, b, kmPerDegLng));
  }

  function routeDistance(targets, base, kmPerDegLng) {
    if (!targets.length) return 0;
    let total = distance(base, targets[0].latlng, kmPerDegLng);
    for (let i = 1; i < targets.length; i += 1) {
      total += distance(targets[i - 1].latlng, targets[i].latlng, kmPerDegLng);
    }
    return total + distance(targets[targets.length - 1].latlng, base, kmPerDegLng);
  }

  function routeMinutes(distanceKm, targetCount, options) {
    return (distanceKm / options.cruiseSpeedKmh) * 60
      + (targetCount * options.scanSecondsPerZone) / 60;
  }

  function balancedSectorClusters(targets, droneCount, base, kmPerDegLng, options) {
    if (targets.length <= droneCount) return targets.map(target => [target]);

    const baseLat = base[0];
    const baseLng = base[1];
    const sorted = targets.map(target => {
      const x = (target.latlng[1] - baseLng) * kmPerDegLng;
      const y = (target.latlng[0] - baseLat) * KM_PER_DEG_LAT;
      return { target, angle: Math.atan2(y, x) };
    }).sort((a, b) => a.angle - b.angle);

    let largestGap = -1;
    let gapAfter = sorted.length - 1;
    for (let i = 0; i < sorted.length; i += 1) {
      const next = (i + 1) % sorted.length;
      const nextAngle = next === 0 ? sorted[0].angle + Math.PI * 2 : sorted[next].angle;
      const gap = nextAngle - sorted[i].angle;
      if (gap > largestGap) {
        largestGap = gap;
        gapAfter = i;
      }
    }

    const start = (gapAfter + 1) % sorted.length;
    const rotated = sorted.slice(start).concat(sorted.slice(0, start));
    const weights = rotated.map(item => {
      const radialKm = distance(base, item.target.latlng, kmPerDegLng);
      return 1 + radialKm * options.sectorRadialWeight;
    });
    const totalWeight = weights.reduce((sum, value) => sum + value, 0);
    const targetWeight = totalWeight / droneCount;
    const clusters = [];
    let cursor = 0;
    let cumulative = 0;

    for (let i = 0; i < rotated.length; i += 1) {
      cumulative += weights[i];
      const remainingTargets = rotated.length - i - 1;
      const remainingClusters = droneCount - clusters.length - 1;
      const threshold = targetWeight * (clusters.length + 1);
      if (
        clusters.length < droneCount - 1
        && cumulative >= threshold
        && remainingTargets >= remainingClusters
      ) {
        clusters.push(rotated.slice(cursor, i + 1).map(item => item.target));
        cursor = i + 1;
      }
    }
    clusters.push(rotated.slice(cursor).map(item => item.target));
    return clusters.filter(cluster => cluster.length);
  }

  function detourForTier(tier, options) {
    if (tier === 3) return options.criticalDetourKm;
    if (tier === 2) return options.highDetourKm;
    if (tier === 1) return options.elevatedDetourKm;
    return 0;
  }

  function priorityAwareNearestNeighbor(clusterTargets, base, kmPerDegLng, options) {
    const remaining = [...clusterTargets];
    const ordered = [];
    let current = base;

    while (remaining.length) {
      const distances = new Array(remaining.length);
      let nearestIndex = 0;
      let nearestKm = Infinity;
      for (let i = 0; i < remaining.length; i += 1) {
        const km = distance(current, remaining[i].latlng, kmPerDegLng);
        distances[i] = km;
        if (km < nearestKm) {
          nearestKm = km;
          nearestIndex = i;
        }
      }

      let chosenIndex = nearestIndex;
      for (let tier = 3; tier >= 1; tier -= 1) {
        const detour = detourForTier(tier, options);
        let candidateIndex = -1;
        let candidateScore = Infinity;
        for (let i = 0; i < remaining.length; i += 1) {
          const target = remaining[i];
          if (priorityTier(target.priority, options) !== tier) continue;
          if (distances[i] > nearestKm + detour) continue;
          const score = distances[i] - Math.max(0, target.priority - options.elevatedThreshold) * 0.035;
          if (score < candidateScore) {
            candidateScore = score;
            candidateIndex = i;
          }
        }
        if (candidateIndex >= 0) {
          chosenIndex = candidateIndex;
          break;
        }
      }

      const [next] = remaining.splice(chosenIndex, 1);
      ordered.push(next);
      current = next.latlng;
    }
    return ordered;
  }

  function improveSameTierTwoOpt(targets, base, kmPerDegLng, options) {
    const best = [...targets];
    if (best.length < 4) return best;

    for (let pass = 0; pass < options.twoOptPasses; pass += 1) {
      let changed = false;
      for (let i = 0; i < best.length - 1; i += 1) {
        const a = i === 0 ? base : best[i - 1].latlng;
        const b = best[i].latlng;
        const tier = priorityTier(best[i].priority, options);
        const stop = Math.min(best.length - 1, i + options.twoOptSpan);

        for (let j = i + 1; j <= stop; j += 1) {
          let sameTier = true;
          for (let k = i + 1; k <= j; k += 1) {
            if (priorityTier(best[k].priority, options) !== tier) {
              sameTier = false;
              break;
            }
          }
          if (!sameTier) break;

          const c = best[j].latlng;
          const d = j === best.length - 1 ? base : best[j + 1].latlng;
          const before = distance(a, b, kmPerDegLng) + distance(c, d, kmPerDegLng);
          const after = distance(a, c, kmPerDegLng) + distance(b, d, kmPerDegLng);
          if (after + 0.004 < before) {
            best.splice(i, j - i + 1, ...best.slice(i, j + 1).reverse());
            changed = true;
            break;
          }
        }
      }
      if (!changed) break;
    }
    return best;
  }

  function removalSavings(targets, index, base, kmPerDegLng) {
    const prev = index === 0 ? base : targets[index - 1].latlng;
    const current = targets[index].latlng;
    const next = index === targets.length - 1 ? base : targets[index + 1].latlng;
    return distance(prev, current, kmPerDegLng)
      + distance(current, next, kmPerDegLng)
      - distance(prev, next, kmPerDegLng);
  }

  function bestInsertion(targets, target, base, kmPerDegLng) {
    let bestPosition = 0;
    let bestDelta = Infinity;
    for (let position = 0; position <= targets.length; position += 1) {
      const prev = position === 0 ? base : targets[position - 1].latlng;
      const next = position === targets.length ? base : targets[position].latlng;
      const delta = distance(prev, target.latlng, kmPerDegLng)
        + distance(target.latlng, next, kmPerDegLng)
        - distance(prev, next, kmPerDegLng);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestPosition = position;
      }
    }
    return { position: bestPosition, deltaKm: bestDelta };
  }

  function enrichRoutes(routes, base, kmPerDegLng, options) {
    return routes.map(route => {
      const distanceKm = routeDistance(route.targets, base, kmPerDegLng);
      return {
        ...route,
        distanceKm,
        missionMinutes: routeMinutes(distanceKm, route.targets.length, options)
      };
    });
  }

  function rebalanceMakespan(routes, base, kmPerDegLng, options) {
    let working = enrichRoutes(routes.map(route => ({ ...route, targets: [...route.targets] })), base, kmPerDegLng, options);

    for (let iteration = 0; iteration < options.balanceIterations; iteration += 1) {
      const orderedByFinish = [...working].sort((a, b) => a.missionMinutes - b.missionMinutes);
      const shortest = orderedByFinish[0];
      const longest = orderedByFinish[orderedByFinish.length - 1];
      const spread = (longest.missionMinutes - shortest.missionMinutes) / Math.max(longest.missionMinutes, 0.001);
      if (spread <= options.balanceTolerance || longest.targets.length <= 1) break;

      const otherMax = Math.max(
        0,
        ...working.filter(route => route !== longest && route !== shortest).map(route => route.missionMinutes)
      );
      const currentMax = Math.max(longest.missionMinutes, otherMax);
      const lowestTier = Math.min(...longest.targets.map(target => priorityTier(target.priority, options)));
      let bestMove = null;

      for (let i = 0; i < longest.targets.length; i += 1) {
        const target = longest.targets[i];
        // Move the least urgent work first. This preserves the route's critical
        // response behavior while using spare fleet capacity for tail work.
        if (priorityTier(target.priority, options) !== lowestTier) continue;

        const savedKm = removalSavings(longest.targets, i, base, kmPerDegLng);
        const insertion = bestInsertion(shortest.targets, target, base, kmPerDegLng);
        const addedTotalKm = insertion.deltaKm - savedKm;
        if (addedTotalKm > options.maxTransferDistancePenaltyKm) continue;

        const longDistance = Math.max(0, longest.distanceKm - savedKm);
        const shortDistance = shortest.distanceKm + insertion.deltaKm;
        const longMinutes = routeMinutes(longDistance, longest.targets.length - 1, options);
        const shortMinutes = routeMinutes(shortDistance, shortest.targets.length + 1, options);
        const newMax = Math.max(longMinutes, shortMinutes, otherMax);

        if (
          newMax < currentMax - 0.02
          && (!bestMove
            || newMax < bestMove.newMax - 1e-9
            || (Math.abs(newMax - bestMove.newMax) < 1e-9 && addedTotalKm < bestMove.addedTotalKm))
        ) {
          bestMove = { i, target, insertion, newMax, addedTotalKm };
        }
      }

      if (!bestMove) break;
      longest.targets.splice(bestMove.i, 1);
      shortest.targets.splice(bestMove.insertion.position, 0, bestMove.target);
      working = enrichRoutes(working, base, kmPerDegLng, options);
    }

    return working.sort((a, b) => a.drone - b.drone);
  }

  function verifyCoverage(routes, targets) {
    const expected = new Set(targets.map(target => target.id));
    const seen = new Set();
    for (const route of routes) {
      for (const target of route.targets) {
        if (!expected.has(target.id)) throw new Error(`Unknown route target ${target.id}`);
        if (seen.has(target.id)) throw new Error(`Duplicate route target ${target.id}`);
        seen.add(target.id);
      }
    }
    if (seen.size !== expected.size) {
      throw new Error(`Incomplete route plan: ${seen.size}/${expected.size} zones assigned`);
    }
  }

  function criticalServiceStats(routes, options) {
    let criticalStops = 0;
    let criticalRankSum = 0;
    for (const route of routes) {
      for (let i = 0; i < route.targets.length; i += 1) {
        if (priorityTier(route.targets[i].priority, options) === 3) {
          criticalStops += 1;
          criticalRankSum += (i + 1) / Math.max(route.targets.length, 1);
        }
      }
    }
    return {
      criticalStops,
      meanCriticalRouteFraction: criticalStops ? criticalRankSum / criticalStops : 0
    };
  }

  function planRoutes(config) {
    const options = { ...DEFAULTS, ...(config.options || {}) };
    const targets = config.targets || [];
    const droneCount = Math.max(1, Math.min(Number(config.droneCount) || 1, targets.length || 1));
    const base = config.commandBase;
    const kmPerDegLng = config.kmPerDegLng;
    if (!targets.length) {
      return { routes: [], totalDistanceKm: 0, makespanMinutes: 0, finishSpreadPct: 0, criticalStops: 0, meanCriticalRouteFraction: 0, options };
    }

    const clusters = balancedSectorClusters(targets, droneCount, base, kmPerDegLng, options);
    let routes = clusters.map((cluster, index) => ({
      drone: index + 1,
      targets: improveSameTierTwoOpt(
        priorityAwareNearestNeighbor(cluster, base, kmPerDegLng, options),
        base,
        kmPerDegLng,
        options
      )
    }));

    routes = rebalanceMakespan(routes, base, kmPerDegLng, options);
    routes = enrichRoutes(routes, base, kmPerDegLng, options);
    routes.forEach(route => {
      route.points = [base, ...route.targets.map(target => target.latlng), base];
    });
    verifyCoverage(routes, targets);

    const totalDistanceKm = routes.reduce((sum, route) => sum + route.distanceKm, 0);
    const maxMinutes = Math.max(...routes.map(route => route.missionMinutes));
    const minMinutes = Math.min(...routes.map(route => route.missionMinutes));
    const finishSpreadPct = maxMinutes > 0 ? ((maxMinutes - minMinutes) / maxMinutes) * 100 : 0;
    const critical = criticalServiceStats(routes, options);

    return {
      routes,
      totalDistanceKm,
      makespanMinutes: maxMinutes,
      finishSpreadPct,
      ...critical,
      options
    };
  }

  return {
    DEFAULTS,
    priorityTier,
    routeDistance,
    routeMinutes,
    planRoutes,
    verifyCoverage
  };
}));
