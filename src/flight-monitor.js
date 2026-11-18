/**
 * Flight Monitor
 *
 * Polls OpenSky for nearby aircraft and sends notifications to LaMetric.
 * Enriches aircraft with metadata and flight routes using multiple sources.
 */

const config = require('./config');
const OpenSkyClient = require('./opensky-client');
const LaMetricClient = require('./lametric-client');
const { filterByDistance } = require('./distance');

// -----------------------------------------------------------------------------
// Route lookup cache
//
// Successful routes are cached for 6 hours.
// Failed lookups are cached for 10 minutes only, allowing routes to become
// available later during the flight.
//
// Route sources:
//   1. adsb.lol routeset (batch lookup)
//   2. ADSBDB callsign lookup (individual fallback)
// -----------------------------------------------------------------------------

const routeCache = new Map();

const ROUTE_CACHE_SUCCESS_MS = 6 * 60 * 60 * 1000;
const ROUTE_CACHE_FAILURE_MS = 10 * 60 * 1000;

/**
 * Normalize callsigns before querying route databases.
 * OpenSky callsigns frequently contain trailing spaces.
 */
function normalizeCallsign(callsign) {
  return (callsign || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

/**
 * Get a route from cache.
 * Returns:
 *   - route object when successfully resolved
 *   - null when a valid negative cache entry exists
 *   - undefined when no valid cache entry exists
 */
function getCachedRoute(callsign) {
  const cached = routeCache.get(callsign);

  if (!cached) {
    return undefined;
  }

  if (Date.now() >= cached.expiresAt) {
    routeCache.delete(callsign);
    return undefined;
  }

  return cached.route;
}

/**
 * Cache a route result.
 * Successful routes receive a longer expiry than failed lookups.
 */
function cacheRoute(callsign, route) {
  const success = !!(route?.origin && route?.destination);

  routeCache.set(callsign, {
    route: success ? route : null,
    expiresAt: Date.now() + (
      success
        ? ROUTE_CACHE_SUCCESS_MS
        : ROUTE_CACHE_FAILURE_MS
    )
  });
}

/**
 * Extract departure and arrival airports from adsb.lol routeset response.
 */
function extractAdsbLolRoute(item) {
  if (!item) return null;

  const airports = Array.isArray(item._airports)
    ? item._airports
    : [];

  let origin =
    airports[0]?.iata ||
    airports[0]?.icao ||
    null;

  let destination =
    airports[1]?.iata ||
    airports[1]?.icao ||
    null;

  // Fallback to the IATA route string (e.g. DUB-LHR)
  if (!origin || !destination) {
    const routeString =
      item._airport_codes_iata ||
      item.airport_codes ||
      '';

    const parts = routeString
      .split('-')
      .map(code => code.trim())
      .filter(Boolean);

    if (parts.length >= 2) {
      origin = origin || parts[0];
      destination = destination || parts[parts.length - 1];
    }
  }

  if (!origin || !destination) {
    return null;
  }

  return {
    origin,
    destination,
    source: 'adsb.lol'
  };
}

/**
 * Batch route lookup using adsb.lol.
 *
 * Sends nearby aircraft callsigns and current positions in a single request.
 * Cached aircraft are excluded to avoid unnecessary API requests.
 */
async function getRoutesFromAdsbLol(aircraft) {
  const unresolved = [];

  for (const plane of aircraft) {
    const callsign = normalizeCallsign(plane.callsign);

    if (!callsign) {
      continue;
    }

    // Skip aircraft with an active cache entry, including negative results.
    const cached = getCachedRoute(callsign);

    if (cached !== undefined) {
      continue;
    }

    // Only send aircraft with valid coordinates
    if (
      typeof plane.latitude !== 'number' ||
      typeof plane.longitude !== 'number'
    ) {
      continue;
    }

    unresolved.push({
      callsign,
      lat: plane.latitude,
      lng: plane.longitude
    });
  }

  if (unresolved.length === 0) {
    return new Map();
  }

  const routes = new Map();

  try {
    const response = await fetch(
      'https://api.adsb.lol/api/0/routeset',
      {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          planes: unresolved
        }),
        signal: AbortSignal.timeout(10000)
      }
    );

    if (!response.ok) {
      console.warn(
        `⚠️ adsb.lol routeset HTTP ${response.status}`
      );
      return routes;
    }

    const data = await response.json();

    const results = Array.isArray(data)
      ? data
      : Array.isArray(data?.planes)
        ? data.planes
        : [];

    for (const item of results) {
      const callsign = normalizeCallsign(item?.callsign);

      if (!callsign) {
        continue;
      }

      const route = extractAdsbLolRoute(item);

      if (route) {
        routes.set(callsign, route);
        cacheRoute(callsign, route);
      }
    }

    console.log(
      `🗺️ adsb.lol resolved ${routes.size}/${unresolved.length} routes`
    );

    return routes;

  } catch (error) {
    console.warn(
      `⚠️ adsb.lol route lookup failed: ${error.message}`
    );

    return routes;
  }
}

/**
 * Individual route fallback using ADSBDB.
 *
 * Called when adsb.lol does not return a route for an aircraft.
 */
async function getFlightRoute(callsign, batchRoute = null) {
  const normalized = normalizeCallsign(callsign);

  if (!normalized) {
    return null;
  }

  // Prefer a route returned by the batch lookup
  if (batchRoute?.origin && batchRoute?.destination) {
    cacheRoute(normalized, batchRoute);
    return batchRoute;
  }

  // Check existing route cache
  const cached = getCachedRoute(normalized);

  if (cached !== undefined) {
    return cached;
  }

  try {
    const response = await fetch(
      `https://api.adsbdb.com/v0/callsign/${encodeURIComponent(normalized)}`,
      {
        signal: AbortSignal.timeout(8000)
      }
    );

    if (!response.ok) {
      console.warn(
        `⚠️ ADSBDB HTTP ${response.status} for ${normalized}`
      );

      cacheRoute(normalized, null);
      return null;
    }

    const data = await response.json();
    const flightRoute = data?.response?.flightroute;

    const origin =
      flightRoute?.origin?.iata_code ||
      flightRoute?.origin?.icao_code ||
      null;

    const destination =
      flightRoute?.destination?.iata_code ||
      flightRoute?.destination?.icao_code ||
      null;

    if (origin && destination) {
      const route = {
        origin,
        destination,
        source: 'ADSBDB'
      };

      cacheRoute(normalized, route);

      console.log(
        `🗺️ ADSBDB resolved ${normalized}: ${origin} → ${destination}`
      );

      return route;
    }

    // No route available yet. Cache temporarily so the API is not queried
    // on every polling cycle.
    cacheRoute(normalized, null);

    return null;

  } catch (error) {
    console.warn(
      `⚠️ ADSBDB route lookup failed for ${normalized}: ${error.message}`
    );

    cacheRoute(normalized, null);

    return null;
  }
}

class FlightMonitor {
  constructor() {
    this.opensky = new OpenSkyClient();
    this.lametric = new LaMetricClient();
    this.notifiedFlights = new Map(); // Track recently notified flights
    this.isRunning = false;
    this.pollInterval = null;

    // Prevent overlapping poll cycles
    this.pollInProgress = false;
  }

  /**
   * Check if we should notify for this flight
   */
  shouldNotify(icao24) {
    const lastNotified = this.notifiedFlights.get(icao24);
    const cooldownMs =
      config.tracking.notificationCooldownMinutes * 60 * 1000;

    if (lastNotified && Date.now() - lastNotified < cooldownMs) {
      return false;
    }

    return true;
  }

  /**
   * Mark a flight as notified
   */
  markNotified(icao24) {
    this.notifiedFlights.set(icao24, Date.now());

    // Clean up old entries
    const maxAge =
      config.tracking.notificationCooldownMinutes * 60 * 1000 * 2;

    for (const [key, time] of this.notifiedFlights) {
      if (Date.now() - time > maxAge) {
        this.notifiedFlights.delete(key);
      }
    }
  }

  /**
   * Poll for nearby aircraft and notify
   */
  async poll() {
    // Avoid overlapping polls if lookups take longer than the poll interval
    if (this.pollInProgress) {
      console.log('⏳ Previous poll still running; skipping this cycle');
      return;
    }

    this.pollInProgress = true;

    const { latitude, longitude } = config.home;
    const radiusMiles = config.tracking.radiusMiles;

    try {
      // Get aircraft in the bounding box
      const aircraft = await this.opensky.getAircraftNear(
        latitude,
        longitude,
        radiusMiles
      );

      if (!aircraft || aircraft.length === 0) {
        console.log('   No aircraft in bounding box');
        return;
      }

      // Filter by exact distance (Haversine)
      const nearby = filterByDistance(
        aircraft,
        latitude,
        longitude,
        radiusMiles
      );

      if (nearby.length === 0) {
        console.log('   No aircraft within radius');
        return;
      }

      console.log(
        `✈️  ${nearby.length} aircraft within ${radiusMiles} miles:`
      );

      // Resolve routes for nearby aircraft in one batch request.
      // Routes from the batch request are cached and reused below.
      const batchRoutes = await getRoutesFromAdsbLol(nearby);

      for (const plane of nearby) {
        // Skip if recently notified
        if (!this.shouldNotify(plane.icao24)) {
          const callsign = plane.callsign || plane.icao24;
          console.log(
            `   - ${callsign}: (skipped - recently notified)`
          );
          continue;
        }

        const callsign =
          normalizeCallsign(plane.callsign) || plane.icao24;

        // Aircraft metadata and model lookup.
        // A failed lookup must never prevent a notification.
        let aircraftInfo = {};

        try {
          aircraftInfo =
            (await this.opensky.resolveAircraftType(plane)) || {};
        } catch (error) {
          console.warn(
            `⚠️ Aircraft type lookup failed for ${plane.icao24}: ${error.message}`
          );
        }

        const typecode = aircraftInfo?.typecode || null;

        const aircraftModel =
          aircraftInfo?.model ||
          (
              aircraftInfo?.manufacturer && typecode
                ? `${aircraftInfo.manufacturer} ${typecode}`
                : typecode
          ) ||
          null;

        // Resolve route: batch result first, then ADSBDB fallback
        let route = null;

        try {
          route = await getFlightRoute(
            callsign,
            batchRoutes.get(callsign) || null
          );
        } catch (error) {
          console.warn(
            `⚠️ Route resolution failed for ${callsign}: ${error.message}`
          );
        }

        const origin = route?.origin || null;
        const destination = route?.destination || null;

        // Log the aircraft without unknown placeholders or distance
        const logParts = [callsign];

        if (origin && destination) {
          logParts.push(`${origin} → ${destination}`);
        }

        if (aircraftModel) {
          logParts.push(aircraftModel);
        }

        const altitude =
          plane.baroAltitude ??
          plane.geoAltitude ??
          0;

        logParts.push(`${Math.round(altitude).toLocaleString()} m`);

        console.log(`   - ${logParts.join(' | ')}`);

        // Send notification to LaMetric
        const notificationResult = this.lametric.pushFlightNotification({
          callsign,
          origin,
          destination,
          altitude,
          typecode,
          aircraftModel
        });

        // Mark only after the notification call has been made
        if (notificationResult?.success !== false) {
          this.markNotified(plane.icao24);
        }

        // Small delay between notifications to not overwhelm
        await new Promise(resolve => setTimeout(resolve, 500));
      }

    } catch (error) {
      console.error('❌ Poll error:', error.message);
    } finally {
      this.pollInProgress = false;
    }
  }

  /**
   * Start the flight monitor
   */
  start() {
    if (this.isRunning) {
      console.log('⚠️  Monitor already running');
      return;
    }

    console.log('🛫 Flight Monitor Starting');
    console.log('==========================');
    console.log(
      `📍 Home: ${config.home.latitude.toFixed(4)}, ${config.home.longitude.toFixed(4)}`
    );
    console.log(`📏 Radius: ${config.tracking.radiusMiles} miles`);
    console.log(
      `⏱️  Poll interval: ${config.tracking.pollIntervalSeconds} seconds`
    );
    console.log(
      `🔕 Cooldown: ${config.tracking.notificationCooldownMinutes} minutes`
    );
    console.log(
      `🛩️  Aircraft type lookup: ${config.tracking.fetchMetadata ? 'ON' : 'OFF (saves API credits)'}`
    );
    console.log('');

    this.isRunning = true;

    // Initial poll
    this.poll();

    // Schedule regular polls
    this.pollInterval = setInterval(
      () => this.poll(),
      config.tracking.pollIntervalSeconds * 1000
    );

    console.log('✅ Monitor running. Press Ctrl+C to stop.\n');
  }

  /**
   * Stop the flight monitor
   */
  stop() {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    this.isRunning = false;
    console.log('\n🛬 Flight Monitor Stopped');
  }
}

module.exports = FlightMonitor;
