// Trip Picker flight search: a Cloudflare Worker that holds the SerpApi key.
// The page asks:  GET /search?from=MEL&to=CTS&date=2027-02-06
// The Worker asks SerpApi's Google Flights search for one-way economy fares for one adult in A$,
// and returns a short list of flights in the shape Trip Picker stores.
//
// Settings (Cloudflare dashboard > the Worker > Settings > Variables and Secrets):
//   SERPAPI_KEY      secret, the key from serpapi.com (required)
//   ALLOWED_ORIGINS  optional, comma-separated sites allowed to call this (default below)
//   DAILY_LIMIT      optional, new searches allowed per day (default 8)
// Optional binding: a KV namespace called COUNTS keeps the daily count exact across Cloudflare's data centres.

const DEFAULT_ORIGINS = "https://tgal1.github.io";
const CACHE_HOURS = 6;
const MAX_RESULTS = 10;

// Google Flights takes airport codes; these city codes cover more than one airport.
const CITY_AIRPORTS = {
  TYO: "HND,NRT", OSA: "KIX,ITM", SPK: "CTS", SEL: "ICN,GMP", BJS: "PEK,PKX", SHA: "PVG,SHA",
  LON: "LHR,LGW,STN,LTN,LCY", PAR: "CDG,ORY", MIL: "MXP,LIN", ROM: "FCO,CIA", NYC: "JFK,EWR,LGA",
  WAS: "IAD,DCA", CHI: "ORD,MDW", YTO: "YYZ,YTZ", BKK: "BKK,DMK", JKT: "CGK,HLP", STO: "ARN,BMA"
};

const LOW_COST = /jetstar|scoot|air ?asia|peach|zipair|spring|cebu|vietjet|ryanair|easyjet|wizz|spirit|frontier|allegiant|lion air|batik|tigerair|jeju|t'way|jin air|air busan|indigo|flynas|flydubai|rex\b|bonza/i;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const allowed = String(env.ALLOWED_ORIGINS || DEFAULT_ORIGINS).split(",").map(s => s.trim()).filter(Boolean);
    const okOrigin = allowed.includes(origin);
    const cors = okOrigin ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {};
    const reply = (status, body, extra = {}) => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors, ...extra }
    });

    if (request.method === "OPTIONS") {
      return new Response(null, { status: okOrigin ? 204 : 403, headers: { ...cors, "Access-Control-Allow-Methods": "GET", "Access-Control-Max-Age": "86400" } });
    }
    if (!okOrigin) return reply(403, { error: "origin", message: "This search only answers Trip Picker." });
    if (url.pathname !== "/search" || request.method !== "GET") return reply(404, { error: "not-found" });
    if (!env.SERPAPI_KEY) return reply(500, { error: "no-key", message: "The flight search has no SerpApi key yet." });

    const from = String(url.searchParams.get("from") || "").trim().toUpperCase();
    const to = String(url.searchParams.get("to") || "").trim().toUpperCase();
    const date = String(url.searchParams.get("date") || "").trim();
    if (!/^[A-Z]{3}$/.test(from)) return reply(400, { error: "from", message: "The start needs to be a three-letter airport code, such as MEL." });
    if (!/^[A-Z]{3}$/.test(to)) return reply(400, { error: "to", message: "Each destination needs a three-letter airport code, such as CTS." });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return reply(400, { error: "date", message: "The date needs to be in the form 2027-02-06." });
    const today = melbourneDate();
    if (date < today) return reply(400, { error: "past", message: "That date has already passed." });

    // Cached answer, if this exact search ran in the last few hours
    const cacheKey = new Request(`https://cache.trip-picker/search?from=${from}&to=${to}&date=${date}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.json();
      return reply(200, { ...body, cached: true });
    }

    // Daily cap on new searches, so the free SerpApi allowance can't be used up
    const limit = Math.max(0, Number(env.DAILY_LIMIT || 8));
    const counter = makeCounter(env, today);
    const used = await counter.get();
    if (used >= limit) return reply(429, { error: "limit", limit, message: `Today's ${limit} live searches are used up. Try again tomorrow.` });
    await counter.set(used + 1);

    const q = new URLSearchParams({
      engine: "google_flights", type: "2", departure_id: CITY_AIRPORTS[from] || from, arrival_id: CITY_AIRPORTS[to] || to,
      outbound_date: date, currency: "AUD", hl: "en", gl: "au", adults: "1", travel_class: "1", api_key: env.SERPAPI_KEY
    });
    let data;
    try {
      const r = await fetch("https://serpapi.com/search.json?" + q.toString());
      data = await r.json();
      if (!r.ok || data.error) {
        const msg = String(data.error || `SerpApi answered ${r.status}`);
        if (/hasn't returned any results/i.test(msg)) data = { best_flights: [], other_flights: [] };
        else return reply(502, { error: "upstream", message: msg.replace(env.SERPAPI_KEY, "…") });
      }
    } catch (e) {
      return reply(502, { error: "upstream", message: "Couldn't reach the flight search. Try again in a minute." });
    }

    const body = {
      from, to, date, checkedAt: new Date().toISOString(), searchUrl: data.search_metadata?.google_flights_url || "",
      flights: shape(data), searchesLeftToday: Math.max(0, limit - used - 1), limit
    };
    const stored = new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json", "Cache-Control": `max-age=${CACHE_HOURS * 3600}` } });
    ctx.waitUntil(cache.put(cacheKey, stored));
    return reply(200, { ...body, cached: false });
  }
};

function melbourneDate() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Australia/Melbourne", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

// KV counter when bound; otherwise the cache of the nearest data centre (good enough for one person's use).
function makeCounter(env, day) {
  const key = "searches:" + day;
  if (env.COUNTS) return {
    async get() { return Number(await env.COUNTS.get(key)) || 0; },
    async set(n) { await env.COUNTS.put(key, String(n), { expirationTtl: 3 * 86400 }); }
  };
  const req = new Request("https://cache.trip-picker/" + key);
  return {
    async get() { const r = await caches.default.match(req); return r ? Number(await r.text()) || 0 : 0; },
    async set(n) { await caches.default.put(req, new Response(String(n), { headers: { "Cache-Control": "max-age=172800" } })); }
  };
}

const short = (name) => String(name || "").replace(/\s+(International\s+)?Airport$/i, "").replace(/\s+International$/i, "").trim();
const hm = (m) => { m = Math.round(Number(m) || 0); const h = Math.floor(m / 60), mm = m % 60; return h ? `${h}h ${String(mm).padStart(2, "0")}m` : `${mm}m`; };
const localIso = (t) => String(t || "").replace(" ", "T").slice(0, 16);

function shape(data) {
  const all = [...(data.best_flights || []), ...(data.other_flights || [])];
  const seen = new Set(); const out = [];
  for (const it of all) {
    const legs = it.flights || [];
    if (!legs.length || !Number.isFinite(Number(it.price))) continue;
    const first = legs[0], last = legs[legs.length - 1];
    const airlines = [...new Set(legs.map(l => l.airline).filter(Boolean))];
    const depart = localIso(first.departure_airport?.time), arrive = localIso(last.arrival_airport?.time);
    const key = legs.map(l => l.flight_number).join("|") + depart;
    if (seen.has(key)) continue; seen.add(key);
    const layovers = it.layovers || [];
    const ext = [...(it.extensions || []), ...legs.flatMap(l => l.extensions || [])].join(" · ");
    let bagsIncluded, bagNote = "";
    if (/checked bag(gage)? (for a fee|not included)|no (free )?checked bag/i.test(ext)) bagsIncluded = false;
    else if (/(\d|free) checked bag|checked bag(gage)? included/i.test(ext)) bagsIncluded = true;
    else if (airlines.some(a => LOW_COST.test(a))) bagsIncluded = false;
    else { bagsIncluded = true; bagNote = "Bags assumed included: check the fare"; }
    const notes = [];
    const nightWait = layovers.find(l => l.overnight);
    if (nightWait) notes.push(`Overnight wait in ${short(nightWait.name)}`);
    if (bagNote) notes.push(bagNote);
    out.push({
      airline: airlines.join(" and "),
      flightNumbers: legs.map(l => l.flight_number).filter(Boolean).join(", "),
      stops: legs.length - 1,
      via: layovers.map(l => `${short(l.name)} (${hm(l.duration)})`).join(", "),
      depAirport: first.departure_airport?.id || "",
      arrAirport: last.arrival_airport?.id || "",
      depart, arrive,
      flightMins: Number(it.total_duration) || 0,
      fare: Math.round(Number(it.price)),
      bagsIncluded,
      notes: notes.join(". ")
    });
  }
  out.sort((a, b) => a.fare - b.fare);
  // Keep the cheapest few, plus the quickest, so both ends of the table are covered
  const keep = out.slice(0, MAX_RESULTS - 2);
  const quick = [...out].sort((a, b) => a.flightMins - b.flightMins).filter(f => !keep.includes(f)).slice(0, 2);
  return [...keep, ...quick];
}
