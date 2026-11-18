// OpenSky Network API Client
//
// Fetches real-time aircraft data and aircraft metadata.
// Metadata fallback order:
//   1. OpenSky
//   2. HexDB
//   3. AirLabs
//
// Compatible with Node.js 20+ (native fetch).
// API docs: https://opensky-network.github.io/opensky-api/

const config = require('./config');

// -----------------------------------------------------------------------------
// Caches
// -----------------------------------------------------------------------------

const metadataCache = new Map();
const hexdbCache = new Map();
const airlabsCache = new Map();

// Cache durations
const METADATA_CACHE_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const NEGATIVE_CACHE_TTL = 30 * 60 * 1000;             // 30 minutes
const FALLBACK_CACHE_TTL = 7 * 24 * 60 * 60 * 1000;  // 7 days

// Rate-limit state
let rateLimitedUntil = 0;

// OAuth2 token cache
let accessToken = null;
let tokenExpiresAt = 0;

// -----------------------------------------------------------------------------
// Cache helpers
// -----------------------------------------------------------------------------

function getCached(cache, key) {
  const entry = cache.get(key);

  if (!entry) {
    return undefined;
  }

  if (Date.now() >= entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }

  return entry.value;
}

function setCached(cache, key, value, ttl) {
  cache.set(key, {
    value,
    expiresAt: Date.now() + ttl,
  });
}

function normalizeHex(icao24) {
  return String(icao24 || '').trim().toLowerCase();
}

function normalizeCallsign(callsign) {
  return String(callsign || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '');
}

// -----------------------------------------------------------------------------
// OpenSky Client
// -----------------------------------------------------------------------------

class OpenSkyClient {
  constructor() {
    this.baseUrl = config.opensky.baseUrl;
    this.tokenUrl = config.opensky.tokenUrl;
    this.clientId = config.opensky.clientId;
    this.clientSecret = config.opensky.clientSecret;

    this.hasAuth = Boolean(this.clientId && this.clientSecret);

    if (this.hasAuth) {
      console.log(`🔐 OpenSky: OAuth2 configured (${this.clientId})`);
    } else {
      console.log('🔓 OpenSky: Anonymous mode');
    }
  }

  // ---------------------------------------------------------------------------
  // OAuth2
  // ---------------------------------------------------------------------------

  async getAccessToken(forceRefresh = false) {
    if (
      !forceRefresh &&
      accessToken &&
      Date.now() < tokenExpiresAt - 60000
    ) {
      return accessToken;
    }

    if (!this.hasAuth) {
      return null;
    }

    try {
      console.log('🔑 Fetching OpenSky OAuth2 token...');

      const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret,
      });

      const response = await fetch(this.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        console.error(`❌ OpenSky token request: HTTP ${response.status}`);
        accessToken = null;
        tokenExpiresAt = 0;
        return null;
      }

      const data = await response.json();

      if (!data?.access_token) {
        console.error('❌ OpenSky token response contained no access token');
        return null;
      }

      accessToken = data.access_token;

      const expiresIn = Number(data.expires_in) || 3600;
      tokenExpiresAt = Date.now() + expiresIn * 1000;

      console.log(`✅ OpenSky token received (expires in ${expiresIn}s)`);

      return accessToken;
    } catch (error) {
      console.error(`❌ OpenSky token request failed: ${error.message}`);
      accessToken = null;
      tokenExpiresAt = 0;
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Rate limiting
  // ---------------------------------------------------------------------------

  isRateLimited() {
    if (Date.now() < rateLimitedUntil) {
      const seconds = Math.ceil(
        (rateLimitedUntil - Date.now()) / 1000
      );

      console.log(`⏳ OpenSky rate limited; retry in ${seconds}s`);
      return true;
    }

    return false;
  }

  setRateLimited(seconds = 60) {
    rateLimitedUntil = Date.now() + seconds * 1000;
    console.warn(`⚠️ OpenSky rate limit; backing off ${seconds}s`);
  }

  // ---------------------------------------------------------------------------
  // HTTP helper
  // ---------------------------------------------------------------------------

  async requestJson(url, options = {}) {
    try {
      const response = await fetch(url, {
        ...options,
        signal: options.signal || AbortSignal.timeout(15000),
      });

      if (response.status === 429) {
        this.setRateLimited(60);
        return null;
      }

      if (!response.ok) {
        console.warn(`⚠️ HTTP ${response.status} for ${url}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      console.warn(`⚠️ Request failed: ${error.message}`);
      return null;
    }
  }

  // OpenSky API request with optional OAuth authentication.
  async curlGet(url, retryAuth = true) {
    if (this.isRateLimited()) {
      return null;
    }

    let headers = {};

    if (this.hasAuth) {
      const token = await this.getAccessToken();

      if (!token) {
        console.warn('⚠️ OpenSky authentication unavailable');
        return null;
      }

      headers.Authorization = `Bearer ${token}`;
    }

    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15000),
      });

      if (response.status === 429) {
        this.setRateLimited(60);
        return null;
      }

      // Refresh token and retry once on unauthorized.
      if (response.status === 401 && this.hasAuth && retryAuth) {
        console.warn('🔄 OpenSky token rejected; refreshing');

        await this.getAccessToken(true);

        return this.curlGet(url, false);
      }

      if (!response.ok) {
        console.error(`❌ OpenSky API error: HTTP ${response.status}`);
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error(`❌ OpenSky request failed: ${error.message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Geographic helpers
  // ---------------------------------------------------------------------------

  calculateBoundingBox(lat, lon, radiusMiles) {
    const latDelta = radiusMiles / 69;
    const cosLat = Math.cos((lat * Math.PI) / 180);

    // Avoid division by zero near the poles.
    const lonDelta =
      radiusMiles / Math.max(69 * Math.abs(cosLat), 0.01);

    return {
      lamin: lat - latDelta,
      lamax: lat + latDelta,
      lomin: lon - lonDelta,
      lomax: lon + lonDelta,
    };
  }

  // ---------------------------------------------------------------------------
  // Aircraft metadata - OpenSky
  // ---------------------------------------------------------------------------

  async getAircraftMetadata(icao24) {
    const hex = normalizeHex(icao24);

    if (!hex) {
      return null;
    }

    const cached = getCached(metadataCache, hex);

    if (cached !== undefined) {
      return cached;
    }

    try {
      const url = `${this.baseUrl}/metadata/aircraft/icao/${encodeURIComponent(hex)}`;
      const data = await this.curlGet(url);

      if (!data) {
        setCached(metadataCache, hex, null, NEGATIVE_CACHE_TTL);
        return null;
      }

      const metadata = {
        registration: data.registration || null,
        manufacturerName: data.manufacturerName || null,
        model: data.model || null,
        typecode: data.typecode || null,
        owner: data.owner || null,
      };

      const hasData = Object.values(metadata).some(Boolean);

      setCached(
        metadataCache,
        hex,
        hasData ? metadata : null,
        hasData ? METADATA_CACHE_TTL : NEGATIVE_CACHE_TTL
      );

      return hasData ? metadata : null;
    } catch (error) {
      console.warn(`⚠️ OpenSky metadata failed for ${hex}: ${error.message}`);
      setCached(metadataCache, hex, null, NEGATIVE_CACHE_TTL);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Flight state data
  // ---------------------------------------------------------------------------

  async getStatesInBox(bbox) {
    const params = new URLSearchParams({
      lamin: bbox.lamin,
      lamax: bbox.lamax,
      lomin: bbox.lomin,
      lomax: bbox.lomax,
    });

    const url = `${this.baseUrl}/states/all?${params.toString()}`;
    const data = await this.curlGet(url);

    if (!Array.isArray(data?.states) || data.states.length === 0) {
      return [];
    }

    return data.states.map((state) => ({
      icao24: state[0] || null,
      callsign: normalizeCallsign(state[1]),
      originCountry: state[2] || null,
      timePosition: state[3] ?? null,
      lastContact: state[4] ?? null,
      longitude: state[5] ?? null,
      latitude: state[6] ?? null,
      baroAltitude: state[7] ?? null,
      onGround: state[8] ?? null,
      velocity: state[9] ?? null,
      trueTrack: state[10] ?? null,
      verticalRate: state[11] ?? null,
      sensors: state[12] ?? null,
      geoAltitude: state[13] ?? null,
      squawk: state[14] || null,
      spi: state[15] ?? null,
      positionSource: state[16] ?? null,
    }));
  }

  async getAircraftNear(lat, lon, radiusMiles) {
    const bbox = this.calculateBoundingBox(lat, lon, radiusMiles);

    console.log(`🔍 Searching aircraft within ${radiusMiles} miles`);

    const aircraft = await this.getStatesInBox(bbox);

    // null and undefined coordinates are rejected, but zero is valid.
    const inFlight = aircraft.filter(
      (a) =>
        !a.onGround &&
        Number.isFinite(a.latitude) &&
        Number.isFinite(a.longitude)
    );

    console.log(`   Found ${inFlight.length} aircraft in flight`);

    return inFlight;
  }

  // ---------------------------------------------------------------------------
  // Optional OpenSky metadata enrichment
  // ---------------------------------------------------------------------------

  async enrichWithMetadata(aircraft) {
    const metadata = await this.getAircraftMetadata(aircraft?.icao24);

    return {
      ...aircraft,
      typecode: metadata?.typecode || null,
      model: metadata?.model || null,
      registration: metadata?.registration || null,
      manufacturer: metadata?.manufacturerName || null,
    };
  }

  // ---------------------------------------------------------------------------
  // HexDB fallback
  // ---------------------------------------------------------------------------

  async getAircraftFromHexDB(icao24) {
    const hex = normalizeHex(icao24);

    if (!hex) {
      return null;
    }

    const cached = getCached(hexdbCache, hex);

    if (cached !== undefined) {
      return cached;
    }

    try {
      const url = `https://hexdb.io/api/v2/aircraft/${encodeURIComponent(hex)}`;

      const data = await this.requestJson(url, {
        signal: AbortSignal.timeout(5000),
      });

      if (!data) {
        setCached(hexdbCache, hex, null, NEGATIVE_CACHE_TTL);
        return null;
      }

      const result = {
        registration: data.registration || null,
        manufacturer: data.manufacturer || null,
        model: data.type || null,
        typecode: data.icao_type_code || null,
        owner: data.registered_owner || null,
      };

      const hasData = result.model || result.typecode || result.manufacturer;

      setCached(
        hexdbCache,
        hex,
        hasData ? result : null,
        hasData ? FALLBACK_CACHE_TTL : NEGATIVE_CACHE_TTL
      );

      if (hasData) {
        console.log(
          `   🔎 HexDB identified ${hex}: ${result.model || result.typecode}`
        );

        return result;
      }

      return null;
    } catch (error) {
      console.warn(`⚠️ HexDB lookup failed for ${hex}: ${error.message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // AirLabs fallback
  // ---------------------------------------------------------------------------

  async getAircraftFromAirLabs(icao24) {
    const hex = normalizeHex(icao24);

    if (!hex || !config.airlabs?.apiKey) {
      return null;
    }

    const cached = getCached(airlabsCache, hex);

    if (cached !== undefined) {
      return cached;
    }

    try {
      const url = new URL('https://airlabs.co/api/v9/fleets');

      url.searchParams.set('hex', hex);
      url.searchParams.set('api_key', config.airlabs.apiKey);

      const data = await this.requestJson(url.toString(), {
        signal: AbortSignal.timeout(5000),
      });

      if (!data) {
        setCached(airlabsCache, hex, null, NEGATIVE_CACHE_TTL);
        return null;
      }

      const aircraft = data.response?.[0] || data[0] || null;

      if (!aircraft) {
        setCached(airlabsCache, hex, null, NEGATIVE_CACHE_TTL);
        return null;
      }

      const result = {
        registration: aircraft.reg_number || null,
        manufacturer: aircraft.manufacturer || null,
        model: aircraft.model || null,
        typecode: aircraft.icao || aircraft.aircraft_icao || null,
        owner: null,
      };

      const hasData = result.model || result.typecode || result.manufacturer;

      setCached(
        airlabsCache,
        hex,
        hasData ? result : null,
        hasData ? FALLBACK_CACHE_TTL : NEGATIVE_CACHE_TTL
      );

      return hasData ? result : null;
    } catch (error) {
      console.warn(`⚠️ AirLabs lookup failed for ${hex}: ${error.message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Unified aircraft identification
  // ---------------------------------------------------------------------------

  async resolveAircraftType(aircraft) {
    const emptyResult = {
      typecode: null,
      model: null,
      manufacturer: null,
      registration: null,
    };

    if (!aircraft?.icao24) {
      return emptyResult;
    }

    const hex = normalizeHex(aircraft.icao24);

    let result = { ...emptyResult };

    // 1. OpenSky - primary source.
    try {
      if (config.tracking?.fetchMetadata) {
        const metadata = await this.getAircraftMetadata(hex);

        if (metadata) {
          result.typecode = metadata.typecode || null;
          result.model = metadata.model || null;
          result.manufacturer = metadata.manufacturerName || null;
          result.registration = metadata.registration || null;
        }
      }
    } catch (error) {
      console.warn(`⚠️ OpenSky metadata failed for ${hex}: ${error.message}`);
    }

    // 2. HexDB - fill any missing fields.
    if (
      !result.typecode ||
      !result.model ||
      !result.manufacturer ||
      !result.registration
    ) {
      try {
        const hexdb = await this.getAircraftFromHexDB(hex);

        if (hexdb) {
          result.typecode ||= hexdb.typecode || null;
          result.model ||= hexdb.model || null;
          result.manufacturer ||= hexdb.manufacturer || null;
          result.registration ||= hexdb.registration || null;
        }
      } catch (error) {
        console.warn(`⚠️ HexDB failed for ${hex}: ${error.message}`);
      }
    }

    // 3. AirLabs - fill remaining gaps.
    if (
      !result.typecode ||
      !result.model ||
      !result.manufacturer ||
      !result.registration
    ) {
      try {
        const airlabs = await this.getAircraftFromAirLabs(hex);

        if (airlabs) {
          result.typecode ||= airlabs.typecode || null;
          result.model ||= airlabs.model || null;
          result.manufacturer ||= airlabs.manufacturer || null;
          result.registration ||= airlabs.registration || null;
        }
      } catch (error) {
        console.warn(`⚠️ AirLabs failed for ${hex}: ${error.message}`);
      }
    }

    // Always return the same predictable object shape.
    return {
      typecode: result.typecode || null,
      model: result.model || null,
      manufacturer: result.manufacturer || null,
      registration: result.registration || null,
    };
  }

  // ---------------------------------------------------------------------------
  // Unit conversions
  // ---------------------------------------------------------------------------

  static metersToFeet(meters) {
    return Number.isFinite(meters) ? Math.round(meters * 3.28084) : null;
  }

  static msToKnots(ms) {
    return Number.isFinite(ms) ? Math.round(ms * 1.94384) : null;
  }
}

module.exports = OpenSkyClient;
