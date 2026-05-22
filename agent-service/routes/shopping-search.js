import express from 'express';

const router = express.Router();

const SERPAPI_ENDPOINT = 'https://serpapi.com/search.json';

function toArray(value) {
  if (Array.isArray(value)) {
    return value.map(String).map(item => item.trim()).filter(Boolean);
  }

  if (typeof value === 'string') {
    return value.split(',').map(item => item.trim()).filter(Boolean);
  }

  return [];
}

function normalizePrice(value) {
  if (typeof value === 'number') {
    return value;
  }

  const match = String(value || '').match(/\d+(\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function buildQuery(spec) {
  const brands = toArray(spec.brands);
  const stores = toArray(spec.stores);
  const parts = [
    spec.item,
    spec.size ? `size ${spec.size}` : '',
    spec.color,
    spec.maxPrice ? `under $${normalizePrice(spec.maxPrice)}` : '',
    brands.length ? `(${brands.join(' OR ')})` : '',
    stores.length ? `(${stores.join(' OR ')})` : '',
    toArray(spec.mustHave).join(' ')
  ];

  return parts.filter(Boolean).join(' ');
}

function detectStore(url = '', title = '') {
  const text = `${url} ${title}`.toLowerCase();

  if (text.includes('rei.com')) return 'REI';
  if (text.includes('backcountry.com')) return 'Backcountry';
  if (text.includes('moosejaw.com')) return 'Moosejaw';
  if (text.includes('amazon.com')) return 'Amazon';
  if (text.includes('zappos.com')) return 'Zappos';

  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return 'Unknown store';
  }
}

function extractPrice(result) {
  const priceText = result.price || result.extracted_price || result.snippet || '';

  if (typeof priceText === 'number') {
    return priceText;
  }

  const matches = String(priceText).match(/\$\s?(\d+(?:\.\d{2})?)/g);
  if (!matches) {
    return null;
  }

  return Math.min(...matches.map(match => Number(match.replace(/[$\s]/g, ''))));
}

function scoreResult(result, spec) {
  const text = `${result.title || ''} ${result.snippet || ''} ${result.link || ''}`.toLowerCase();
  const brands = toArray(spec.brands).map(item => item.toLowerCase());
  const stores = toArray(spec.stores).map(item => item.toLowerCase());
  const maxPrice = normalizePrice(spec.maxPrice);
  const price = extractPrice(result);
  let score = 0;

  if (stores.some(store => text.includes(store.toLowerCase()))) score += 3;
  if (brands.some(brand => text.includes(brand))) score += 3;
  if (String(spec.item || '').toLowerCase().split(/\s+/).some(word => word && text.includes(word))) score += 1;
  if (String(spec.color || '').toLowerCase().split(/\s+|,|\//).some(word => word && text.includes(word))) score += 1;
  if (String(spec.size || '') && text.includes(String(spec.size).toLowerCase())) score += 1;
  if (price && maxPrice && price <= maxPrice) score += 4;
  if (text.includes('waterproof')) score += 2;
  if (text.includes('sale') || text.includes('save') || text.includes('% off')) score += 1;

  return score;
}

function resultToRecommendation(result, spec) {
  const price = extractPrice(result);
  const store = detectStore(result.link, result.title);
  const maxPrice = normalizePrice(spec.maxPrice);
  const priceText = price ? `$${price.toFixed(2)}` : 'Price not found in search result';
  const budgetText = price && maxPrice
    ? (price <= maxPrice ? `under the ${spec.maxPrice} cap` : `may exceed the ${spec.maxPrice} cap`)
    : 'price needs verification';

  return {
    name: result.title || 'Product result',
    store,
    price,
    priceText,
    discount: result.extensions?.find(item => /off|sale|save/i.test(item)) || null,
    sizeMatch: spec.size ? `Search result matched query for size ${spec.size}; verify on product page.` : 'Verify size on product page.',
    colorMatch: spec.color ? `Search result matched query for ${spec.color}; verify selected color on product page.` : 'Verify color on product page.',
    url: result.link,
    reason: `${store} result for ${spec.item || 'the requested item'}; ${budgetText}. Verify size, color, and stock before buying.`,
    snippet: result.snippet || ''
  };
}

async function searchSerpApi(query, apiKey) {
  const url = new URL(SERPAPI_ENDPOINT);
  url.searchParams.set('engine', 'google');
  url.searchParams.set('q', query);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('num', '10');

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`SerpAPI request failed: ${response.status} ${body}`);
  }

  return response.json();
}

router.post('/', async (req, res, next) => {
  const apiKey = process.env.SERPAPI_API_KEY;

  if (!apiKey) {
    return res.status(400).json({
      status: 'missing_api_key',
      error: 'SERPAPI_API_KEY is not configured in agent-service/.env'
    });
  }

  try {
    const spec = req.body || {};
    const query = buildQuery(spec);
    const data = await searchSerpApi(query, apiKey);
    const organic = data.organic_results || [];
    const shopping = data.shopping_results || [];
    const allResults = [...shopping, ...organic]
      .filter(result => result.link)
      .map(result => ({ ...result, score: scoreResult(result, spec) }))
      .sort((a, b) => b.score - a.score);

    const recommendations = allResults
      .slice(0, 5)
      .map(result => resultToRecommendation(result, spec));

    res.json({
      status: recommendations.length ? 'verified' : 'no_results',
      query,
      recommendations,
      source: 'SerpAPI'
    });
  } catch (error) {
    next(error);
  }
});

export default router;
