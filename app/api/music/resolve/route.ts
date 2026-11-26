import { NextRequest, NextResponse } from "next/server";
import yts from "yt-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface ResolvedTrack {
  id: string;
  title: string;
  artist: string;
  coverUrl: string;
  youtubeId: string;
  duration: number; // seconds
}

/* ------------------------------------------------------------------ */
/* Spotify (Client Credentials, server-side only)                      */
/* ------------------------------------------------------------------ */

let tokenCache: { value: string; expiresAt: number } | null = null;

async function getSpotifyToken(): Promise<string | null> {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;

  if (tokenCache && tokenCache.expiresAt > Date.now() + 30_000) {
    return tokenCache.value;
  }

  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
    cache: "no-store",
  });
  if (!res.ok) return null;

  const json = (await res.json()) as { access_token: string; expires_in: number };
  tokenCache = {
    value: json.access_token,
    expiresAt: Date.now() + json.expires_in * 1000,
  };
  return tokenCache.value;
}

interface SpotifyTrack {
  id: string;
  name: string;
  duration_ms: number;
  artists: { name: string }[];
  album: { images: { url: string; width: number; height: number }[] };
}

async function searchSpotify(q: string, limit: number): Promise<SpotifyTrack[]> {
  const token = await getSpotifyToken();
  if (!token) return [];

  const url = `https://api.spotify.com/v1/search?type=track&limit=${limit}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok) return [];

  const json = (await res.json()) as { tracks?: { items?: SpotifyTrack[] } };
  return json.tracks?.items ?? [];
}

/* ------------------------------------------------------------------ */
/* YouTube resolution via yt-search (no Data API quota)                */
/* ------------------------------------------------------------------ */

interface YtMatch {
  youtubeId: string;
  seconds: number;
  thumbnail: string;
}

const NON_MUSIC =
  /\b(interview|podcast|reacts?|reaction|review|tutorial|lesson|how to|full album|compilation|mashup|megamix|nonstop|playlist|hours?|live ?stream|news|vlog|trailer|behind the scenes|making of|karaoke|asmr|episode|explained|breakdown|unboxing)\b/i;
const MUSIC_HINT = /(official|audio|video|lyrics?|visuali[sz]er|music|song|\bfeat\.?\b|\bft\.?\b)/i;
const TOPIC_OR_VEVO = /( - topic$|vevo$)/i;
const BAD_VARIANT = /\b(live|cover|remix|slowed|sped|8d|nightcore|instrumental)\b/i;
const GOOD_WORDS = /(official audio|provided to youtube)/i;

/** Prefers YouTube's Music category, then falls back to a normal search. */
async function searchYt(query: string) {
  try {
    const musicOnly = await yts({ query, category: "music" } as never);
    if (musicOnly.videos.length > 0) return musicOnly;
  } catch {
    /* option unsupported or request failed: use the normal search */
  }
  return yts(query);
}

const ytCache = new Map<string, YtMatch | null>();

async function resolveYoutube(
  title: string,
  artist: string,
  durationSec: number,
  strict: boolean,
): Promise<YtMatch | null> {
  const key = `${strict ? "s" : "l"}|${artist}|${title}`.toLowerCase();
  if (ytCache.has(key)) return ytCache.get(key) ?? null;

  let match: YtMatch | null = null;
  try {
    const result = await searchYt(`${artist} ${title} audio`);
    const wantsVariant = BAD_VARIANT.test(`${title} ${artist}`);
    const queryHasNonMusic = NON_MUSIC.test(title);

    let best = Number.POSITIVE_INFINITY;
    result.videos
      .filter((v) => v.seconds > 30 && v.seconds <= 1200)
      .slice(0, 12)
      .forEach((v, index) => {
        const trusted = TOPIC_OR_VEVO.test(v.author.name) || GOOD_WORDS.test(v.title);
        const diff = Math.abs(v.seconds - durationSec);

        if (strict) {
          // Must be the same recording: tight duration window, wider for trusted uploads.
          if (diff > (trusted ? 25 : 12)) return;
          if (!queryHasNonMusic && NON_MUSIC.test(v.title)) return;
        }

        let score = diff + index;
        if (!wantsVariant && BAD_VARIANT.test(v.title)) score += 60;
        if (trusted) score -= 8;
        if (score < best) {
          best = score;
          match = { youtubeId: v.videoId, seconds: v.seconds, thumbnail: v.thumbnail ?? `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg` };
        }
      });
  } catch {
    match = null;
  }

  if (ytCache.size > 500) ytCache.clear();
  ytCache.set(key, match);
  return match;
}

/* ------------------------------------------------------------------ */
/* Builders                                                            */
/* ------------------------------------------------------------------ */

async function viaSpotify(
  q: string,
  limit: number,
  songsOnly: boolean,
): Promise<ResolvedTrack[]> {
  try {
    // Ask for a few extra: strict mode may drop tracks with no exact YouTube match.
    const items = await searchSpotify(q, songsOnly ? Math.min(10, limit + 4) : limit);
    const resolved = await Promise.all(
      items.map(async (item): Promise<ResolvedTrack | null> => {
        const artist = item.artists.map((a) => a.name).join(", ");
        const duration = Math.round(item.duration_ms / 1000);
        const yt = await resolveYoutube(item.name, item.artists[0]?.name ?? "", duration, songsOnly);
        if (!yt) return null;

        const images = [...item.album.images].sort((a, b) => b.width - a.width);
        return {
          id: item.id,
          title: item.name,
          artist,
          coverUrl: images[0]?.url ?? yt.thumbnail,
          youtubeId: yt.youtubeId,
          duration,
        };
      }),
    );
    return resolved.filter((t): t is ResolvedTrack => t !== null).slice(0, limit);
  } catch {
    return [];
  }
}

function cleanTitle(raw: string): string {
  return raw
    .replace(/\s*[([][^)\]]*(official|video|audio|lyrics?|visuali[sz]er|hd|4k)[^)\]]*[)\]]/gi, "")
    .trim();
}

/** Fallback when Spotify keys are missing or Spotify returns nothing. */
async function viaYoutubeOnly(
  q: string,
  limit: number,
  songsOnly: boolean,
): Promise<ResolvedTrack[]> {
  try {
    const result = await searchYt(songsOnly ? `${q} official audio` : q);
    let videos = result.videos.filter((v) => v.seconds > 30 && v.seconds <= 1200);

    if (songsOnly) {
      const rank = (v: (typeof videos)[number]) =>
        TOPIC_OR_VEVO.test(v.author.name) ? 2 : /official/i.test(v.title) ? 1 : 0;
      videos = videos
        .filter((v) => v.seconds >= 60 && v.seconds <= 600)
        .filter((v) => {
          if (TOPIC_OR_VEVO.test(v.author.name)) return true;
          if (NON_MUSIC.test(v.title)) return false;
          return MUSIC_HINT.test(v.title) || v.title.includes(" - ");
        })
        .sort((a, b) => rank(b) - rank(a));
    }

    return videos.slice(0, limit).map((v) => {
      const cleaned = cleanTitle(v.title);
      const split = cleaned.split(" - ");
      const hasArtist = split.length > 1;
      return {
        id: `yt_${v.videoId}`,
        title: hasArtist ? split.slice(1).join(" - ") : cleaned,
        artist: hasArtist ? split[0] : v.author.name.replace(/ - Topic$/i, ""),
        coverUrl: v.thumbnail ?? `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        youtubeId: v.videoId,
        duration: v.seconds,
      };
    });
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* GET /api/music/resolve?q=...            -> ResolvedTrack            */
/* GET /api/music/resolve?q=...&limit=6    -> { results: ResolvedTrack[] } */
/* Add &songsOnly=0 to turn the music-only filter off (default: on).   */
/* ------------------------------------------------------------------ */

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const q = params.get("q")?.trim();
  if (!q) {
    return NextResponse.json({ error: "Missing ?q= search query" }, { status: 400 });
  }
  if (q.length > 200) {
    return NextResponse.json({ error: "Query too long" }, { status: 400 });
  }

  const limitParam = params.get("limit");
  const multi = limitParam !== null;
  const limit = Math.min(Math.max(parseInt(limitParam ?? "1", 10) || 1, 1), 10);
  const songsOnly = !["0", "false"].includes(params.get("songsOnly") ?? "");

  try {
    let tracks = await viaSpotify(q, limit, songsOnly);
    if (tracks.length === 0) tracks = await viaYoutubeOnly(q, limit, songsOnly);

    if (tracks.length === 0) {
      return NextResponse.json({ error: "No playable match found" }, { status: 404 });
    }

    return NextResponse.json(multi ? { results: tracks } : tracks[0], {
      headers: {
        "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400",
      },
    });
  } catch {
    return NextResponse.json({ error: "Failed to resolve track" }, { status: 502 });
  }
}
