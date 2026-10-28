// Netlify Edge Function: returns the visitor's approximate location from Netlify's IP geolocation,
// so a first-time visitor starts near home instead of a fixed fallback city. City-level at best,
// and wrong for VPNs or mobile carriers, so the app labels it as approximate.
export default async (request, context) => {
  const { city, subdivision, country, latitude, longitude } = context.geo ?? {};
  const body = latitude == null || longitude == null
    ? {}
    : { city, region: subdivision?.name, country: country?.code, lat: latitude, lon: longitude };
  return Response.json(body, { headers: { 'cache-control': 'private, no-store' } });
};

export const config = { path: '/api/geo' };
