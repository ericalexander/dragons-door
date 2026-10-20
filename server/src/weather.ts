/**
 * The sky over the realm matches the sky over the player, roughly.
 * Location comes from Vercel's IP geolocation headers on each request and is never stored.
 * Conditions come from Open-Meteo (free, no key), cached per ~50 km square for 30 minutes.
 * Any failure means no weather, never an error.
 */
const URL_BASE = process.env.DRAGONS_DOOR_WEATHER_URL ?? "https://api.open-meteo.com/v1/forecast";
const TTL = 30 * 60_000;
const cache = new Map<string, { at: number; w: Weather | null }>();

export interface Weather {
  sky: "clear" | "mostly clear" | "partly cloudy" | "overcast" | "fog" | "drizzle" | "rain" | "heavy rain" | "freezing rain" | "snow" | "heavy snow" | "showers" | "snow showers" | "thunderstorm";
  temp_c: number;
  feel: "freezing" | "cold" | "cool" | "mild" | "warm" | "hot";
  wind: "still" | "breezy" | "windy" | "gale";
  daylight: boolean;
}

function sky(code: number): Weather["sky"] {
  if (code === 0) return "clear";
  if (code === 1) return "mostly clear";
  if (code === 2) return "partly cloudy";
  if (code === 3) return "overcast";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 55) return "drizzle";
  if (code === 56 || code === 57 || code === 66 || code === 67) return "freezing rain";
  if (code === 61 || code === 63) return "rain";
  if (code === 65) return "heavy rain";
  if (code === 71 || code === 73 || code === 77) return "snow";
  if (code === 75) return "heavy snow";
  if (code >= 80 && code <= 82) return "showers";
  if (code === 85 || code === 86) return "snow showers";
  if (code >= 95) return "thunderstorm";
  return "overcast";
}
const feel = (c: number): Weather["feel"] => (c < 0 ? "freezing" : c < 8 ? "cold" : c < 15 ? "cool" : c < 22 ? "mild" : c < 29 ? "warm" : "hot");
const wind = (kmh: number): Weather["wind"] => (kmh < 6 ? "still" : kmh < 20 ? "breezy" : kmh < 45 ? "windy" : "gale");

/** Round to a half degree (~50 km) so nearby players share a lookup and nothing precise is ever sent on. */
const square = (v: number) => Math.round(v * 2) / 2;

export async function weatherAt(lat?: number, lon?: number): Promise<Weather | null> {
  if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const [la, lo] = [square(lat), square(lon)];
  const key = `${la},${lo}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.w;
  let w: Weather | null = null;
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 1200);
    const r = await fetch(`${URL_BASE}?latitude=${la}&longitude=${lo}&current=temperature_2m,weather_code,wind_speed_10m,is_day`, { signal: ac.signal });
    clearTimeout(t);
    if (r.ok) {
      const c = ((await r.json()) as { current?: { temperature_2m: number; weather_code: number; wind_speed_10m: number; is_day: number } }).current;
      if (c) w = { sky: sky(c.weather_code), temp_c: Math.round(c.temperature_2m), feel: feel(c.temperature_2m), wind: wind(c.wind_speed_10m), daylight: c.is_day === 1 };
    }
  } catch { /* slow or down: no weather this time */ }
  // a failed lookup is retried after 5 minutes, not 30
  cache.set(key, { at: w ? Date.now() : Date.now() - TTL + 5 * 60_000, w });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return w;
}
