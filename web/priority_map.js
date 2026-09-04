const map = L.map('map', { zoomControl: false, preferCanvas: true });
L.control.zoom({ position: 'bottomright' }).addTo(map);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap contributors'
}).addTo(map);

const ROUTE_COLORS = [
  '#315f70', '#725d96', '#b06b3f', '#3f7d62',
  '#9a526d', '#566fa0', '#82753d', '#6b6f73'
];
const AFFECTED_PRIORITY = 0.75;
const KM_PER_DEG_LAT = 111.32;

let zoningData = null;
let geojsonLayer = null;
let disasterPathLayer = null;
let routeLayer = L.layerGroup().addTo(map);
let droneLayer = L.layerGroup().addTo(map);
let commandLayer = L.layerGroup().addTo(map);
let zoneLayers = new Map();
let dataBounds = null;
let commandBase = null;
let currentTargets = [];
let currentRoutes = [];
let currentPlan = null;
let animationToken = 0;
let aiAutoShown = false;
let kmPerDegLng = 85;

const ui = {
  disasterType: document.getElementById('disasterType'),
  droneCount: document.getElementById('droneCount'),
  simulateBtn: document.getElementById('simulateBtn'),
  deployBtn: document.getElementById('deployBtn'),
  statusDot: document.getElementById('statusDot'),
  statusText: document.getElementById('statusText'),
  missionState: document.getElementById('missionState'),
  missionCoverage: document.getElementById('missionCoverage'),
  progressFill: document.getElementById('progressFill'),
  progressLabel: document.getElementById('progressLabel'),
  affectedMetric: document.getElementById('affectedMetric'),
  criticalMetric: document.getElementById('criticalMetric'),
  distanceMetric: document.getElementById('distanceMetric'),
  fleetMetric: document.getElementById('fleetMetric'),
  fleetList: document.getElementById('fleetList'),
  planMeta: document.getElementById('planMeta'),
  aiBtn: document.getElementById('aiBtn'),
  aiPanel: document.getElementById('aiPanel'),
  aiCloseBtn: document.getElementById('aiCloseBtn'),
  aiMode: document.getElementById('aiMode'),
  aiZone: document.getElementById('aiZone'),
  aiPreview: document.getElementById('aiPreview'),
  aiImageBadge: document.getElementById('aiImageBadge'),
  aiDamage: document.getElementById('aiDamage'),
  aiConfidence: document.getElementById('aiConfidence'),
  aiFindings: document.getElementById('aiFindings'),
  aiAction: document.getElementById('aiAction'),
  aiAnalyzeBtn: document.getElementById('aiAnalyzeBtn'),
  aiAnalyzeDemoBtn: document.getElementById('aiAnalyzeDemoBtn'),
  aiFile: document.getElementById('aiFile'),
  aiNote: document.getElementById('aiNote')
};

function setStatus(text, state = 'neutral') {
  ui.statusText.textContent = text;
  ui.statusDot.classList.toggle('active', state === 'active');
  ui.statusDot.classList.toggle('error', state === 'error');
}

function simplifyZoningType(original) {
  const code = String(original || '').trim().toUpperCase();
  if (code.startsWith('A')) return 'Agricultural';
  if (code.startsWith('R')) return 'Residential';
  return 'Commercial / other';
}

function priorityColor(priority) {
  if (priority >= 3.6) return '#a83e3e';
  if (priority >= 2.7) return '#d96d55';
  if (priority >= 1.8) return '#e6a15f';
  if (priority >= AFFECTED_PRIORITY) return '#ead58b';
  return '#d9ebe5';
}

function zoneStyle(feature) {
  const priority = Number(feature.properties.priority || 0);
  if (feature.properties.inspected) {
    return {
      fillColor: '#94b1ad',
      fillOpacity: 0.42,
      color: '#557f7b',
      weight: 0.85,
      opacity: 0.72
    };
  }
  return {
    fillColor: priorityColor(priority),
    fillOpacity: priority > 0 ? 0.70 : 0.30,
    color: '#ffffff',
    weight: 0.55,
    opacity: 0.78
  };
}

function zoneTooltip(feature) {
  const description = feature.properties.Description || feature.properties.ZONING || 'Zoning feature';
  const priority = Number(feature.properties.priority || 0);
  const state = priority < AFFECTED_PRIORITY
    ? 'Outside inspection area'
    : feature.properties.inspected ? 'Inspected' : 'Pending inspection';
  return `<div class="zone-tooltip"><strong>${description}</strong><br>Priority ${priority.toFixed(2)} · ${state}</div>`;
}

function bindZone(feature, layer) {
  zoneLayers.set(feature.properties._avarisId, layer);
  layer.bindTooltip('', { sticky: true });
  layer.on('mouseover', () => layer.setTooltipContent(zoneTooltip(feature)));
  layer.on('click', () => {
    if (Number(feature.properties.priority || 0) >= AFFECTED_PRIORITY) showAiSampleForFeature(feature);
  });
}

function redrawZones() {
  zoneLayers = new Map();
  if (geojsonLayer) geojsonLayer.remove();
  geojsonLayer = L.geoJSON(zoningData, { style: zoneStyle, onEachFeature: bindZone }).addTo(map);
}

function resetMission() {
  animationToken += 1;
  routeLayer.clearLayers();
  droneLayer.clearLayers();
  currentTargets = [];
  currentRoutes = [];
  currentPlan = null;
  aiAutoShown = false;
  if (zoningData) {
    zoningData.features.forEach(feature => { feature.properties.inspected = false; });
  }
  ui.missionState.textContent = 'Standby';
  ui.missionCoverage.textContent = '0 / 0';
  ui.progressFill.style.width = '0%';
  ui.progressLabel.textContent = 'Inspection coverage';
  ui.affectedMetric.textContent = '—';
  ui.criticalMetric.textContent = '—';
  ui.distanceMetric.textContent = '—';
  ui.fleetMetric.textContent = '—';
  ui.fleetList.innerHTML = '';
  ui.planMeta.textContent = '';
}

function innerBounds(marginRatio = 0.12) {
  const [west, south, east, north] = dataBounds;
  const dx = (east - west) * marginRatio;
  const dy = (north - south) * marginRatio;
  return { west: west + dx, east: east - dx, south: south + dy, north: north - dy };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function generateHazardTrack(type) {
  const b = innerBounds(type === 'tornado' ? 0.14 : 0.10);
  const width = b.east - b.west;
  const height = b.north - b.south;
  const points = [];

  if (type === 'tornado') {
    const count = 8;
    let lng = b.west + width * (0.12 + Math.random() * 0.14);
    let lat = b.south + height * (0.20 + Math.random() * 0.34);
    const stepLng = width * 0.105;
    const stepLat = height * (0.05 + Math.random() * 0.055);
    points.push([lat, lng]);
    for (let i = 1; i < count; i += 1) {
      lng += stepLng * (0.85 + Math.random() * 0.30);
      lat += stepLat + (Math.random() - 0.5) * height * 0.12;
      points.push([clamp(lat, b.south, b.north), clamp(lng, b.west, b.east)]);
    }
  } else {
    const count = 10;
    const baseLat = b.south + height * (0.35 + Math.random() * 0.30);
    for (let i = 0; i < count; i += 1) {
      const t = i / (count - 1);
      const lng = b.west + width * (0.08 + 0.84 * t);
      const lat = baseLat
        + Math.sin(t * Math.PI * 1.4) * height * 0.13
        + (Math.random() - 0.5) * height * 0.035;
      points.push([clamp(lat, b.south, b.north), clamp(lng, b.west, b.east)]);
    }
  }

  return points;
}

function exposureMultiplier(feature) {
  const type = simplifyZoningType(feature.properties.ZONING);
  if (type === 'Agricultural') return 0.78;
  if (type === 'Residential') return 1.20;
  return 1.00;
}

function collectInspectionTargets() {
  return zoningData.features
    .filter(feature => Number(feature.properties.priority || 0) >= AFFECTED_PRIORITY)
    .map(feature => {
      const point = turf.pointOnFeature(feature).geometry.coordinates;
      return {
        id: feature.properties._avarisId,
        feature,
        layer: zoneLayers.get(feature.properties._avarisId),
        latlng: [point[1], point[0]],
        priority: Number(feature.properties.priority),
        zone: feature.properties.ZONING || 'Unclassified',
        description: feature.properties.Description || 'Zoning feature',
        completed: false
      };
    });
}

function simulateImpact() {
  if (!zoningData) return;

  resetMission();
  if (disasterPathLayer) disasterPathLayer.remove();

  const incident = ui.disasterType.value;
  const track = generateHazardTrack(incident);
  const path = turf.lineString(track.map(([lat, lng]) => [lng, lat]));
  const sigmaKm = incident === 'tornado' ? 1.35 : 2.65;

  zoningData.features.forEach((feature) => {
    const center = turf.pointOnFeature(feature);
    const distance = turf.pointToLineDistance(center, path, { units: 'kilometers' });
    let raw = 4 * Math.exp(-(distance * distance) / (2 * sigmaKm * sigmaKm));
    raw *= 0.96 + Math.random() * 0.08;
    const priority = Math.min(4.8, Math.max(0, raw * exposureMultiplier(feature)));
    feature.properties.priority = Math.round(priority * 100) / 100;
    feature.properties.inspected = false;
  });

  redrawZones();
  disasterPathLayer = L.polyline(track, {
    color: '#b94743',
    weight: 3,
    opacity: 0.88,
    dashArray: '7 9',
    lineCap: 'round'
  }).addTo(map);

  currentTargets = collectInspectionTargets();
  const criticalCount = currentTargets.filter(target => target.priority >= 3.6).length;
  const requestedFleet = Math.min(Number(ui.droneCount.value), currentTargets.length || 0);
  ui.deployBtn.disabled = currentTargets.length === 0;
  ui.missionState.textContent = 'Impact modeled';
  ui.missionCoverage.textContent = `0 / ${currentTargets.length.toLocaleString()}`;
  ui.affectedMetric.textContent = currentTargets.length.toLocaleString();
  ui.criticalMetric.textContent = criticalCount.toLocaleString();
  ui.distanceMetric.textContent = '—';
  ui.fleetMetric.textContent = requestedFleet ? String(requestedFleet) : '—';
  ui.fleetList.innerHTML = '';
  ui.planMeta.textContent = '';
  setStatus(`${currentTargets.length.toLocaleString()} zones require inspection`, 'active');
}

function planarDistanceSquared(a, b) {
  const dy = (a[0] - b[0]) * KM_PER_DEG_LAT;
  const dx = (a[1] - b[1]) * kmPerDegLng;
  return dx * dx + dy * dy;
}

function planarDistance(a, b) {
  return Math.sqrt(planarDistanceSquared(a, b));
}

function buildRoutes() {
  const droneCount = Math.min(Number(ui.droneCount.value), currentTargets.length);
  currentPlan = AvarisRouting.planRoutes({
    targets: currentTargets,
    droneCount,
    commandBase,
    kmPerDegLng
  });

  currentPlan.routes.forEach((route, index) => {
    route.color = ROUTE_COLORS[index % ROUTE_COLORS.length];
  });
  return currentPlan.routes;
}

function drawRoutes(routes) {
  routeLayer.clearLayers();
  routes.forEach(route => {
    L.polyline(route.points, {
      color: route.color,
      weight: 2.1,
      opacity: 0.78,
      smoothFactor: 0
    }).addTo(routeLayer);
  });
}

function prepareTraversal(route) {
  const cumulative = [0];
  for (let i = 1; i < route.points.length; i += 1) {
    cumulative.push(cumulative[i - 1] + planarDistance(route.points[i - 1], route.points[i]));
  }
  return {
    route,
    cumulative,
    totalDistance: cumulative[cumulative.length - 1],
    nextTarget: 0,
    segmentIndex: 0
  };
}

function positionAtDistance(traversal, traveled) {
  const { points } = traversal.route;
  const cumulative = traversal.cumulative;
  const clamped = Math.max(0, Math.min(traversal.totalDistance, traveled));

  while (
    traversal.segmentIndex < points.length - 2
    && cumulative[traversal.segmentIndex + 1] < clamped
  ) {
    traversal.segmentIndex += 1;
  }

  const i = traversal.segmentIndex;
  const a = points[i];
  const b = points[i + 1];
  const start = cumulative[i];
  const end = cumulative[i + 1];
  const t = end > start ? (clamped - start) / (end - start) : 1;
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t
  ];
}

function renderFleetSummary(routes) {
  const makespan = currentPlan?.makespanMinutes || Math.max(...routes.map(route => route.missionMinutes), 0);
  const totalDistance = currentPlan?.totalDistanceKm || routes.reduce((sum, route) => sum + route.distanceKm, 0);
  const spread = currentPlan?.finishSpreadPct || 0;
  ui.distanceMetric.textContent = makespan ? `${Math.round(makespan)} min` : '—';
  ui.fleetMetric.textContent = String(routes.length);
  ui.fleetList.innerHTML = routes.map(route => `
    <div class="fleet-row" data-drone="${route.drone}">
      <span class="drone-key" style="color:${route.color}">D${route.drone}</span>
      <span class="fleet-meta">${route.targets.length.toLocaleString()} zones · ${route.distanceKm.toFixed(1)} km · ${Math.round(route.missionMinutes)} min</span>
      <span class="fleet-progress">0%</span>
      <div class="fleet-bar"><i style="background:${route.color}"></i></div>
    </div>
  `).join('');
  ui.planMeta.textContent = `${totalDistance.toFixed(1)} km total · ${spread.toFixed(1)}% finish spread`;
}

function updateFleetProgress(routeNumber, progress) {
  const row = ui.fleetList.querySelector(`[data-drone="${routeNumber}"]`);
  if (!row) return;
  const percent = Math.max(0, Math.min(100, Math.round(progress * 100)));
  row.querySelector('.fleet-progress').textContent = `${percent}%`;
  row.querySelector('.fleet-bar > i').style.width = `${percent}%`;
}

function droneIcon(number, color) {
  return L.divIcon({
    className: '',
    html: `<div class="drone-icon" style="background:${color}">D${number}</div>`,
    iconSize: [25, 25],
    iconAnchor: [12, 12]
  });
}

function markTargetComplete(target) {
  if (!target || target.completed) return false;
  target.completed = true;
  target.feature.properties.inspected = true;
  target.layer?.setStyle(zoneStyle(target.feature));
  if (!aiAutoShown && target.priority >= 3.6) {
    aiAutoShown = true;
    showAiSample(target, true);
  }
  return true;
}

async function deployRoutes() {
  if (!currentTargets.length) simulateImpact();
  if (!currentTargets.length) return;

  animationToken += 1;
  const token = animationToken;
  routeLayer.clearLayers();
  droneLayer.clearLayers();
  currentTargets.forEach(target => {
    target.completed = false;
    target.feature.properties.inspected = false;
    target.layer?.setStyle(zoneStyle(target.feature));
  });

  ui.simulateBtn.disabled = true;
  ui.deployBtn.disabled = true;
  ui.missionState.textContent = 'Planning';
  ui.missionCoverage.textContent = `0 / ${currentTargets.length.toLocaleString()}`;
  ui.progressFill.style.width = '0%';
  setStatus(`Planning ${currentTargets.length.toLocaleString()} stops…`, 'active');

  // Yield once so the Planning state paints before route construction begins.
  await new Promise(resolve => requestAnimationFrame(() => resolve()));

  try {
    currentRoutes = buildRoutes();
  } catch (error) {
    console.error(error);
    ui.missionState.textContent = 'Planning failed';
    setStatus(error.message, 'error');
    ui.simulateBtn.disabled = false;
    ui.deployBtn.disabled = false;
    return;
  }

  if (token !== animationToken) return;

  drawRoutes(currentRoutes);
  renderFleetSummary(currentRoutes);

  const traversals = currentRoutes.map(prepareTraversal);
  const maxMissionMinutes = Math.max(...currentRoutes.map(route => route.missionMinutes), 0.001);
  const markers = traversals.map(({ route }) =>
    L.marker(commandBase, {
      icon: droneIcon(route.drone, route.color),
      zIndexOffset: 1000
    }).addTo(droneLayer)
  );

  ui.missionState.textContent = 'Inspecting';
  setStatus(`${currentRoutes.length} routes · priority + fleet balance optimized`, 'active');

  let completedCount = 0;
  const start = performance.now();
  const longestRouteDurationMs = 16000;
  const routeDurations = traversals.map(item =>
    longestRouteDurationMs * Math.max(0.35, item.route.missionMinutes / maxMissionMinutes)
  );

  await new Promise(resolve => {
    function frame(now) {
      if (token !== animationToken) return resolve();
      const elapsed = now - start;
      let allReturned = true;

      traversals.forEach((traversal, routeIndex) => {
        const duration = routeDurations[routeIndex];
        const routeProgress = Math.min(1, elapsed / duration);
        const traveled = traversal.totalDistance * routeProgress;
        markers[routeIndex].setLatLng(positionAtDistance(traversal, traveled));
        updateFleetProgress(traversal.route.drone, routeProgress);

        // Target n is route point n+1. The cumulative distance to that point is
        // therefore cumulative[n+1]. Advancing by distance makes target coverage
        // independent of animation frame rate or trajectory sampling density.
        while (
          traversal.nextTarget < traversal.route.targets.length
          && traversal.cumulative[traversal.nextTarget + 1] <= traveled + 1e-9
        ) {
          const target = traversal.route.targets[traversal.nextTarget];
          if (markTargetComplete(target)) completedCount += 1;
          traversal.nextTarget += 1;
        }

        if (routeProgress < 1) allReturned = false;
      });

      const coverage = currentTargets.length ? completedCount / currentTargets.length : 1;
      ui.progressFill.style.width = `${coverage * 100}%`;
      ui.missionCoverage.textContent = `${completedCount.toLocaleString()} / ${currentTargets.length.toLocaleString()}`;
      if (completedCount === currentTargets.length && !allReturned) {
        ui.missionState.textContent = 'Returning';
      }

      if (!allReturned) requestAnimationFrame(frame);
      else resolve();
    }
    requestAnimationFrame(frame);
  });

  if (token !== animationToken) return;

  // This should already be complete. The final pass is a hard invariant guard so
  // UI completion can never mask a missed waypoint.
  currentTargets.forEach(target => {
    if (markTargetComplete(target)) completedCount += 1;
  });

  if (completedCount !== currentTargets.length) {
    ui.missionState.textContent = 'Coverage error';
    setStatus(`Coverage mismatch: ${completedCount}/${currentTargets.length}`, 'error');
  } else {
    ui.progressFill.style.width = '100%';
    ui.missionCoverage.textContent = `${currentTargets.length.toLocaleString()} / ${currentTargets.length.toLocaleString()}`;
    ui.missionState.textContent = 'Complete';
    setStatus('All affected zones inspected');
  }
  ui.simulateBtn.disabled = false;
  ui.deployBtn.disabled = false;
}

function sampleAssessment(priority, zoneType) {
  const residential = simplifyZoningType(zoneType) === 'Residential';
  if (priority >= 3.6) {
    return {
      damage_level: 'severe', confidence: 0.93,
      findings: [
        residential ? 'Major roof covering loss is visible' : 'Substantial exterior structural damage is visible',
        'Debris is present around the structure',
        'Possible weather exposure at the roof deck'
      ],
      recommended_action: 'Immediate adjuster review'
    };
  }
  if (priority >= 2.7) {
    return {
      damage_level: 'moderate', confidence: 0.89,
      findings: ['Localized exterior damage', 'Loose debris near structures', 'Follow-up imagery recommended'],
      recommended_action: 'Priority desk review'
    };
  }
  if (priority >= 1.8) {
    return {
      damage_level: 'mild', confidence: 0.86,
      findings: ['Minor visible exterior damage', 'No obvious major structural failure'],
      recommended_action: 'Standard review'
    };
  }
  return {
    damage_level: 'none', confidence: 0.84,
    findings: ['No clear structural damage visible in sample assessment'],
    recommended_action: 'No immediate escalation'
  };
}

const AI_DEMO_IMAGE = 'https://oceanservice.noaa.gov/news/sep24/helene-asheville-oct-5-960.jpg';
const AI_LOCAL_FALLBACK = 'http://127.0.0.1:8000';
let aiPreviewObjectUrl = null;
let aiCurrentTarget = null;
let aiApiBase = null;
let aiApiStatus = null;
let aiStatusCheckedAt = 0;

function fetchWithTimeout(url, options = {}, timeoutMs = 1400) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function detectAiBackend(force = false) {
  if (!force && aiApiStatus && performance.now() - aiStatusCheckedAt < 5000) return aiApiStatus;

  const bases = [''];
  const fallbackOrigin = new URL(AI_LOCAL_FALLBACK).origin;
  if (window.location.origin !== fallbackOrigin) bases.push(fallbackOrigin);

  for (const base of bases) {
    try {
      const response = await fetchWithTimeout(`${base}/api/status`, { cache: 'no-store' });
      if (!response.ok) continue;
      const payload = await response.json();
      if (payload?.service !== 'avaris-ai') continue;
      aiApiBase = base;
      aiApiStatus = payload;
      aiStatusCheckedAt = performance.now();
      return payload;
    } catch (_) {
      // Try the next local candidate.
    }
  }

  aiApiBase = null;
  aiApiStatus = null;
  aiStatusCheckedAt = performance.now();
  return null;
}

function aiBackendMessage(status) {
  if (!status) return 'Live AI server not detected · run python src/demo_server.py';
  if (!status.openai_installed) {
    const python = status.python_executable || 'the Python used to start the server';
    return `OpenAI package missing from ${python} · use that interpreter with -m pip install openai`;
  }
  if (!status.configured) return 'AI server found · set OPENAI_API_KEY and restart it';
  return `Live AI ready · ${status.model || 'configured model'}`;
}

async function refreshAiAvailabilityNote(prefix = 'NOAA Hurricane Helene · Asheville, NC · sample output') {
  const status = await detectAiBackend();
  if (!ui.aiPanel.hidden) ui.aiNote.textContent = `${prefix} · ${aiBackendMessage(status)}`;
  return status;
}


function setAiPreview(src, badge, alt) {
  if (aiPreviewObjectUrl && src !== aiPreviewObjectUrl) {
    URL.revokeObjectURL(aiPreviewObjectUrl);
    aiPreviewObjectUrl = null;
  }
  ui.aiPreview.classList.remove('is-loading');
  ui.aiPreview.src = src;
  ui.aiPreview.alt = alt || 'Inspection image preview';
  ui.aiImageBadge.textContent = badge;
}

function renderAiFindings(findings) {
  ui.aiFindings.replaceChildren();
  (findings || []).slice(0, 4).forEach(item => {
    const row = document.createElement('div');
    row.textContent = String(item);
    ui.aiFindings.appendChild(row);
  });
}

function normalizeConfidence(value) {
  let confidence = Number(value || 0);
  if (confidence > 1 && confidence <= 100) confidence /= 100;
  return Math.max(0, Math.min(1, confidence));
}

function setAiResult(result, label, mode = 'SAMPLE') {
  ui.aiMode.textContent = mode;
  ui.aiZone.textContent = label;
  ui.aiDamage.textContent = String(result.damage_level || 'unknown').replace(/^./, c => c.toUpperCase());
  ui.aiConfidence.textContent = `${Math.round(normalizeConfidence(result.confidence) * 100)}%`;
  renderAiFindings(result.findings);
  ui.aiAction.textContent = result.recommended_action || 'Review';
  ui.aiPanel.hidden = false;
}

function showAiSample(target, automatic = false) {
  aiCurrentTarget = target;
  const result = sampleAssessment(Number(target.priority || 0), target.zone || target.feature?.properties?.ZONING);
  const zoneLabel = `${target.description || 'Affected zone'} · priority ${Number(target.priority || 0).toFixed(2)}`;
  setAiPreview(
    AI_DEMO_IMAGE,
    'NOAA IMAGE',
    'NOAA aerial damage imagery of a destroyed property in Asheville, North Carolina after Hurricane Helene'
  );
  setAiResult(result, zoneLabel, 'SAMPLE');
  const prefix = automatic
    ? 'NOAA Hurricane Helene · Asheville, NC · sample output · opened at first critical inspection'
    : 'NOAA Hurricane Helene · Asheville, NC · sample output';
  ui.aiNote.textContent = prefix;
  refreshAiAvailabilityNote(prefix);
}

function showAiSampleForFeature(feature) {
  showAiSample({
    priority: Number(feature.properties.priority || 0),
    zone: feature.properties.ZONING,
    description: feature.properties.Description || feature.properties.ZONING || 'Affected zone',
    feature
  });
}

function showDefaultAiSample() {
  const target = currentTargets.length
    ? [...currentTargets].sort((a, b) => b.priority - a.priority)[0]
    : { priority: 4.1, zone: 'R-1', description: 'Demo inspection' };
  showAiSample(target);
}

function setAiAnalyzing(label, badge = 'LIVE INPUT') {
  ui.aiPanel.hidden = false;
  ui.aiMode.textContent = 'LIVE';
  ui.aiZone.textContent = label;
  ui.aiDamage.textContent = 'Analyzing…';
  ui.aiConfidence.textContent = '—';
  renderAiFindings([]);
  ui.aiAction.textContent = '—';
  ui.aiImageBadge.textContent = badge;
  ui.aiPreview.classList.add('is-loading');
  ui.aiNote.textContent = 'Analyzing image…';
  ui.aiAnalyzeBtn.disabled = true;
  ui.aiAnalyzeDemoBtn.disabled = true;
}

function finishAiRequest() {
  ui.aiPreview.classList.remove('is-loading');
  ui.aiAnalyzeBtn.disabled = false;
  ui.aiAnalyzeDemoBtn.disabled = false;
}

async function dataUrlFromBlob(blob) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('Unable to read image'));
    reader.readAsDataURL(blob);
  });
}

async function requestAiAssessment(imageInput, label) {
  const status = await detectAiBackend(true);
  if (!status) {
    throw new Error('Avaris AI server not detected. Start it with: python src/demo_server.py');
  }
  if (!status.openai_installed) {
    const python = status.python_executable || 'python';
    throw new Error(`The openai package is not installed for ${python}. Run that interpreter with: -m pip install openai`);
  }
  if (!status.configured) {
    throw new Error('OPENAI_API_KEY is not set on the Avaris server. Set it, then restart src/demo_server.py');
  }

  const body = imageInput.startsWith('data:')
    ? { image_data: imageInput, filename: label }
    : { image_url: imageInput, filename: label };

  const started = performance.now();
  const response = await fetch(`${aiApiBase}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 405) {
      throw new Error('This page is being served by a static server. Use python src/demo_server.py for live AI');
    }
    throw new Error(payload.error || `Analysis failed (${response.status})`);
  }
  return { payload, elapsedMs: performance.now() - started };
}

async function analyzeDemoImage() {
  setAiPreview(
    AI_DEMO_IMAGE,
    'NOAA IMAGE',
    'NOAA aerial damage imagery of a destroyed property in Asheville, North Carolina after Hurricane Helene'
  );

  const status = await detectAiBackend(true);
  if (!status || !status.ready) {
    const fallbackTarget = aiCurrentTarget || { priority: 4.1, zone: 'R-1', description: 'Demo inspection' };
    const fallback = sampleAssessment(Number(fallbackTarget.priority || 0), fallbackTarget.zone);
    setAiResult(fallback, fallbackTarget.description || 'NOAA reference image', 'SAMPLE');
    ui.aiImageBadge.textContent = 'NOAA IMAGE';
    ui.aiNote.textContent = aiBackendMessage(status);
    return;
  }

  setAiAnalyzing(aiCurrentTarget?.description || 'NOAA Hurricane Helene property', 'NOAA IMAGE');
  try {
    const { payload, elapsedMs } = await requestAiAssessment(AI_DEMO_IMAGE, 'NOAA Hurricane Helene property reference');
    setAiResult(payload, aiCurrentTarget?.description || 'NOAA Hurricane Helene property', 'LIVE');
    ui.aiImageBadge.textContent = 'MODEL INPUT';
    ui.aiNote.textContent = `Live model result · NOAA imagery · ${(elapsedMs / 1000).toFixed(1)} s`;
  } catch (error) {
    console.error(error);
    const fallbackTarget = aiCurrentTarget || { priority: 4.1, zone: 'R-1', description: 'Demo inspection' };
    const fallback = sampleAssessment(Number(fallbackTarget.priority || 0), fallbackTarget.zone);
    setAiResult(fallback, fallbackTarget.description || 'NOAA reference image', 'SAMPLE');
    ui.aiImageBadge.textContent = 'NOAA IMAGE';
    ui.aiNote.textContent = `Live AI unavailable · ${error.message}`;
  } finally {
    finishAiRequest();
  }
}

async function analyzeInspectionImage(file) {
  if (!file) return;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) {
    ui.aiNote.textContent = 'Use a JPEG, PNG, or WebP image.';
    return;
  }
  if (file.size > 8 * 1024 * 1024) {
    ui.aiNote.textContent = 'Image must be 8 MB or smaller.';
    return;
  }

  if (aiPreviewObjectUrl) URL.revokeObjectURL(aiPreviewObjectUrl);
  aiPreviewObjectUrl = URL.createObjectURL(file);
  setAiPreview(aiPreviewObjectUrl, 'UPLOADED', `Uploaded inspection image: ${file.name}`);

  const status = await detectAiBackend(true);
  if (!status || !status.ready) {
    ui.aiPanel.hidden = false;
    ui.aiMode.textContent = 'PREVIEW';
    ui.aiZone.textContent = file.name;
    ui.aiDamage.textContent = 'Not analyzed';
    ui.aiConfidence.textContent = '—';
    renderAiFindings(['Image preview loaded successfully.']);
    ui.aiAction.textContent = '—';
    ui.aiImageBadge.textContent = 'UPLOADED';
    ui.aiNote.textContent = aiBackendMessage(status);
    ui.aiFile.value = '';
    return;
  }

  setAiAnalyzing(file.name, 'UPLOADED');
  try {
    const imageData = await dataUrlFromBlob(file);
    const { payload, elapsedMs } = await requestAiAssessment(imageData, file.name);
    setAiResult(payload, file.name, 'LIVE');
    ui.aiImageBadge.textContent = 'MODEL INPUT';
    ui.aiNote.textContent = `Live model result · ${(elapsedMs / 1000).toFixed(1)} s`;
  } catch (error) {
    console.error(error);
    ui.aiMode.textContent = 'PREVIEW';
    ui.aiDamage.textContent = 'Not analyzed';
    ui.aiConfidence.textContent = '—';
    renderAiFindings(['Image preview loaded successfully.', 'Start src/demo_server.py with OPENAI_API_KEY set for live analysis.']);
    ui.aiAction.textContent = '—';
    ui.aiImageBadge.textContent = 'UPLOADED';
    ui.aiNote.textContent = `Live AI unavailable · ${error.message}`;
  } finally {
    finishAiRequest();
    ui.aiFile.value = '';
  }
}

function drawCommandBase() {
  commandLayer.clearLayers();
  const basePoint = turf.pointOnFeature(zoningData).geometry.coordinates;
  commandBase = [basePoint[1], basePoint[0]];
  kmPerDegLng = KM_PER_DEG_LAT * Math.cos(commandBase[0] * Math.PI / 180);
  const icon = L.divIcon({
    className: '',
    html: '<div class="command-icon"></div>',
    iconSize: [13, 13],
    iconAnchor: [6, 6]
  });
  L.marker(commandBase, { icon })
    .bindTooltip('Launch / recovery')
    .addTo(commandLayer);
}

ui.simulateBtn.addEventListener('click', simulateImpact);
ui.deployBtn.addEventListener('click', deployRoutes);
ui.aiBtn.addEventListener('click', () => {
  if (ui.aiPanel.hidden) showDefaultAiSample();
  else ui.aiPanel.hidden = true;
});
ui.aiCloseBtn.addEventListener('click', () => { ui.aiPanel.hidden = true; });
ui.aiAnalyzeDemoBtn.addEventListener('click', analyzeDemoImage);
ui.aiAnalyzeBtn.addEventListener('click', () => ui.aiFile.click());
ui.aiFile.addEventListener('change', () => analyzeInspectionImage(ui.aiFile.files?.[0]));

fetch('data/bloomington_zoning.geojson')
  .then(response => {
    if (!response.ok) throw new Error(`GeoJSON request failed: ${response.status}`);
    return response.json();
  })
  .then(data => {
    zoningData = data;
    zoningData.features.forEach((feature, index) => {
      feature.properties._avarisId = index;
      feature.properties.priority = 0;
      feature.properties.inspected = false;
    });
    dataBounds = turf.bbox(zoningData);
    redrawZones();
    drawCommandBase();
    map.fitBounds(geojsonLayer.getBounds(), { padding: [16, 16] });
    setStatus(`${zoningData.features.length.toLocaleString()} zones loaded`, 'active');
    ui.simulateBtn.disabled = false;
  })
  .catch(error => {
    console.error(error);
    setStatus('Unable to load zoning data', 'error');
    ui.simulateBtn.disabled = true;
    ui.deployBtn.disabled = true;
  });
