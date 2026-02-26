type SpotifyType = 'track' | 'album' | 'artist';

interface SpotifyOEmbed {
	title: string;
	author_name: string;
	type: string;
}

interface iTunesResult {
	artistId?: number;
	trackViewUrl?: string;
	collectionViewUrl?: string;
	artistViewUrl?: string;
	trackName?: string;
	collectionName?: string;
	artistName?: string;
	wrapperType?: string;
}

interface iTunesResponse {
	resultCount: number;
	results: iTunesResult[];
}

const SPOTIFY_URL_RE = /^https?:\/\/open\.spotify\.com\/(track|album|artist|playlist)\/[\w]+/;

const ITUNES_ENTITY_MAP: Record<SpotifyType, string> = {
	track: 'song',
	album: 'album',
	artist: 'musicArtist',
};

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: {
			'Content-Type': 'application/json',
			'Access-Control-Allow-Origin': '*',
		},
	});
}

function parseSpotifyUrl(raw: string): { type: SpotifyType; url: string } | null {
	const match = raw.match(SPOTIFY_URL_RE);
	if (!match) return null;

	const type = match[1] as SpotifyType | 'playlist';
	if (type === 'playlist') return null;

	return { type, url: raw.split('?')[0] };
}

/** Scrape artist from Spotify's page og:description as a fallback. */
async function scrapeSpotifyArtist(url: string): Promise<string | null> {
	try {
		const page = await fetch(url, {
			headers: { 'User-Agent': 'Mozilla/5.0 (compatible; bot)' },
			redirect: 'follow',
		});
		const html = await page.text();
		// Try both attribute orderings.
		const match =
			html.match(/property="og:description"\s+content="([^"]+)"/) ??
			html.match(/content="([^"]+)"\s+property="og:description"/);
		if (match) {
			// Format: "Artist1, Artist2 · Album · Song · 2007"
			const artist = match[1].split('\u00B7')[0].trim();
			if (artist) return artist;
		}
	} catch {
		// Non-fatal.
	}
	return null;
}

async function fetchSpotifyMeta(url: string): Promise<SpotifyOEmbed> {
	const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
	if (!res.ok) throw new Error(`Spotify oEmbed returned ${res.status}`);
	const data: SpotifyOEmbed = await res.json();

	if (!data.author_name) {
		const scraped = await scrapeSpotifyArtist(url);
		if (scraped) data.author_name = scraped;
	}

	return data;
}

/** Strip parenthesized/bracketed suffixes, "- Remastered", etc. that confuse iTunes search. */
function cleanTitle(title: string): string {
	return title
		.replace(/\s*[\(\[].*?[\)\]]/g, '')   // (feat. ...), [Deluxe], etc.
		.replace(/\s*-\s*(Remaster|Deluxe|Bonus|Anniversary|Expanded|Live).*$/i, '')
		.trim();
}

async function searchItunes(query: string, entity: string): Promise<iTunesResult[]> {
	const res = await fetch(
		`https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=${entity}&limit=10`
	);
	if (!res.ok) return [];
	const data: iTunesResponse = await res.json();
	return data.results;
}

/** Normalize a string for fuzzy comparison: lowercase, strip punctuation/whitespace. */
function normalize(s: string): string {
	return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Check if two strings are a fuzzy match (one contains the other after normalization). */
function fuzzyMatch(a: string, b: string): boolean {
	const na = normalize(a);
	const nb = normalize(b);
	return na.includes(nb) || nb.includes(na);
}

/**
 * Pick the best iTunes result that actually matches the Spotify metadata.
 * For tracks/albums: the title must fuzzy-match AND (if we have an artist) the artist must fuzzy-match.
 * For artists: the artist name must fuzzy-match.
 */
function pickBestResult(
	results: iTunesResult[],
	type: SpotifyType,
	title: string,
	artist: string | undefined,
): iTunesResult | null {
	for (const r of results) {
		if (type === 'artist') {
			if (r.artistName && fuzzyMatch(r.artistName, artist ?? title)) return r;
			continue;
		}

		const resultTitle = type === 'track' ? r.trackName : r.collectionName;
		if (!resultTitle || !fuzzyMatch(resultTitle, title)) continue;

		// Title matches — if we have an artist, verify that too.
		if (artist && r.artistName && !fuzzyMatch(r.artistName, artist)) continue;

		return r;
	}
	return null;
}

/**
 * Fallback: find the artist on iTunes, then look up their full catalog
 * and match the track/album by title. The search API is bad at finding
 * niche/non-English songs, but the lookup API returns everything.
 */
async function lookupViaArtist(
	artist: string,
	type: SpotifyType,
	title: string,
): Promise<iTunesResult | null> {
	// Try the full artist string, then individual names (e.g. "PaulK, reezy" → "PaulK").
	const candidates = [artist];
	if (artist.includes(',')) {
		candidates.push(artist.split(',')[0].trim());
	}

	for (const name of candidates) {
		// Step 1: find the artist.
		const artists = await searchItunes(name, 'musicArtist');
		const matchedArtist = artists.find(
			(a) => a.artistName && fuzzyMatch(a.artistName, name),
		);
		if (!matchedArtist?.artistId) continue;

		// Step 2: look up their catalog for the matching entity type.
		const entity = ITUNES_ENTITY_MAP[type];
		const res = await fetch(
			`https://itunes.apple.com/lookup?id=${matchedArtist.artistId}&entity=${entity}&limit=200`,
		);
		if (!res.ok) continue;
		const data: iTunesResponse = await res.json();

		const catalog = data.results.filter((r) => r.wrapperType !== 'artist');
		const match = pickBestResult(catalog, type, title, undefined);
		if (match) return match;
	}

	return null;
}

function getAppleMusicUrl(result: iTunesResult, type: SpotifyType): string | null {
	if (type === 'track') return result.trackViewUrl ?? null;
	if (type === 'album') return result.collectionViewUrl ?? null;
	if (type === 'artist') return result.artistViewUrl ?? null;
	return null;
}

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === 'OPTIONS') {
			return new Response(null, {
				headers: {
					'Access-Control-Allow-Origin': '*',
					'Access-Control-Allow-Methods': 'GET, OPTIONS',
					'Access-Control-Allow-Headers': '*',
				},
			});
		}

		if (url.pathname !== '/convert') {
			return jsonResponse({ error: 'Not found. Use GET /convert?url=<spotify_url>' }, 404);
		}

		const spotifyUrl = url.searchParams.get('url');
		if (!spotifyUrl) {
			return jsonResponse({ error: 'Missing ?url= parameter' }, 400);
		}

		const parsed = parseSpotifyUrl(spotifyUrl);
		if (!parsed) {
			return jsonResponse(
				{ error: 'Invalid Spotify URL. Supported types: track, album, artist. Playlists are not supported.' },
				400
			);
		}

		let meta: SpotifyOEmbed;
		try {
			meta = await fetchSpotifyMeta(parsed.url);
		} catch {
			return jsonResponse({ error: 'Failed to fetch metadata from Spotify' }, 502);
		}

		const entity = ITUNES_ENTITY_MAP[parsed.type];
		const cleaned = cleanTitle(meta.title);

		// Try progressively looser searches until we get a hit.
		const hasArtist = Boolean(meta.author_name);
		const queries =
			parsed.type === 'artist'
				? [meta.author_name]
				: hasArtist
					? [
							`${cleaned} ${meta.author_name}`,  // cleaned title + artist (best)
							`${meta.title} ${meta.author_name}`, // original title + artist
							cleaned,                              // just the cleaned title
					  ]
					: [cleaned, meta.title];                      // no artist — title only

		let result: iTunesResult | null = null;
		for (const q of queries) {
			const results = await searchItunes(q, entity);
			result = pickBestResult(results, parsed.type, cleaned, meta.author_name);
			if (result) break;
		}

		// Fallback: search failed — try finding the artist, then browsing their catalog.
		if (!result && hasArtist && parsed.type !== 'artist') {
			result = await lookupViaArtist(meta.author_name, parsed.type, cleaned);
		}

		if (!result) {
			return jsonResponse({ error: 'No Apple Music match found' }, 404);
		}

		const appleMusicUrl = getAppleMusicUrl(result, parsed.type);
		if (!appleMusicUrl) {
			return jsonResponse({ error: 'No Apple Music match found' }, 404);
		}

		const wantRedirect = url.searchParams.get('redirect') !== '0';
		if (wantRedirect) {
			return new Response(null, {
				status: 302,
				headers: {
					Location: appleMusicUrl,
					'Access-Control-Allow-Origin': '*',
				},
			});
		}

		return jsonResponse({
			appleMusic: appleMusicUrl,
			title: result.trackName ?? result.collectionName ?? result.artistName ?? meta.title,
			artist: result.artistName ?? meta.author_name,
		});
	},
} satisfies ExportedHandler;
