import { NextRequest, NextResponse } from "next/server";
import * as cheerio from "cheerio";
import yts from "yt-search";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TRACKS = 150;

interface SpotifyItem {
  title: string;
  artist: string;
}

type Parsed = { kind: "youtube" | "spotify"; id: string };

function parseLink(raw: string): Parsed | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "");
  if (["youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"].includes(host)) {
    const list = u.searchParams.get("list");
    return list && /^[\w-]{10,64}$/.test(list) ? { kind: "youtube", id: list } : null;
  }
  if (host === "open.spotify.com") {
    const m = /\/playlist\/([A-Za-z0-9]{10,30})/.exec(u.pathname);
    return m?.[1] ? { kind: "spotify", id: m[1] } : null;
  }
  return null;
}

/* ---------------------------- YouTube ---------------------------- */

function cleanTitle(raw: string): string {
  return raw
    .replace(/\s*[([][^)\]]*(official|video|audio|lyrics?|visuali[sz]er|hd|4k)[^)\]]*[)\]]/gi, "")
    .trim();
}

async function fromYoutube(listId: string) {
  const list = await yts({ listId });
  const tracks = list.videos
    .filter((v) => v.videoId && !/^(deleted|private) video$/i.test(v.title) && v.duration.seconds > 30)
    .slice(0, MAX_TRACKS)
    .map((v) => {
      const cleaned = cleanTitle(v.title);
      const split = cleaned.split(" - ");
      const hasArtist = split.length > 1;
      return {
        id: `yt_${v.videoId}`,
        title: hasArtist ? split.slice(1).join(" - ") : cleaned,
        artist: hasArtist ? (split[0] ?? "") : v.author.name.replace(/ - Topic$/i, ""),
        coverUrl: v.thumbnail ?? `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`,
        youtubeId: v.videoId,
        duration: v.duration.seconds,
      };
    });
  return { name: list.title || "Imported playlist", resolved: true, tracks };
}

/* ---------------------------- Spotify ---------------------------- */

async function spotifyToken(): Promise<string | null> {
  const id = process.env.SPOTIFY_CLIENT_ID;
  const secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) return null;
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
  return ((await res.json()) as { access_token?: string }).access_token ?? null;
}

interface ApiPage {
  next?: string | null;
  items?: { track?: { name?: string; artists?: { name: string }[] } | null }[];
}

async function spotifyViaApi(id: string): Promise<{ name: string; items: SpotifyItem[] } | null> {
  const token = await spotifyToken();
  if (!token) return null;
  const headers = { Authorization: `Bearer ${token}` };
  const meta = await fetch(`https://api.spotify.com/v1/playlists/${id}?fields=name`, { headers, cache: "no-store" });
  if (!meta.ok) return null;
  const name = ((await meta.json()) as { name?: string }).name ?? "Imported playlist";

  const items: SpotifyItem[] = [];
  let url: string | null = `https://api.spotify.com/v1/playlists/${id}/tracks?limit=100&fields=next,items(track(name,artists(name)))`;
  while (url && items.length < MAX_TRACKS) {
    const res: Response = await fetch(url, { headers, cache: "no-store" });
    if (!res.ok) break;
    const page = (await res.json()) as ApiPage;
    for (const it of page.items ?? []) {
      const t = it.track;
      if (t?.name) items.push({ title: t.name, artist: t.artists?.map((a) => a.name).join(", ") ?? "" });
    }
    url = page.next ?? null;
  }
  return items.length ? { name, items: items.slice(0, MAX_TRACKS) } : null;
}

interface EmbedData {
  props?: {
    pageProps?: {
      state?: {
        data?: { entity?: { name?: string; title?: string; trackList?: { title?: string; subtitle?: string }[] } };
      };
    };
  };
}

/** No-keys fallback: the public embed page ships the first ~100 tracks as JSON. */
async function spotifyViaEmbed(id: string): Promise<{ name: string; items: SpotifyItem[] } | null> {
  const res = await fetch(`https://open.spotify.com/embed/playlist/${id}`, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; Rustify/1.0)", "Accept-Language": "en" },
    cache: "no-store",
  });
  if (!res.ok) return null;
  const raw = cheerio.load(await res.text())("script#__NEXT_DATA__").text();
  if (!raw) return null;
  const entity = (JSON.parse(raw) as EmbedData).props?.pageProps?.state?.data?.entity;
  const items = (entity?.trackList ?? [])
    .filter((t): t is { title: string; subtitle?: string } => typeof t.title === "string" && t.title.length > 0)
    .map((t) => ({ title: t.title, artist: (t.subtitle ?? "").replace(/\u00a0/g, " ") }))
    .slice(0, MAX_TRACKS);
  return items.length ? { name: entity?.name ?? entity?.title ?? "Imported playlist", items } : null;
}

/* ---------------------------- Handler ---------------------------- */
/* GET /api/music/playlist?url=<spotify or youtube playlist link>
   -> { name, resolved: true,  tracks: Track[] }         (YouTube: ready to play)
   -> { name, resolved: false, tracks: {title,artist}[] } (Spotify: client resolves each via /api/music/resolve) */

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url") ?? "";
  const parsed = url.length <= 300 ? parseLink(url) : null;
  if (!parsed) {
    return NextResponse.json({ error: "Paste a Spotify or YouTube playlist link" }, { status: 400 });
  }

  try {
    if (parsed.kind === "youtube") {
      const out = await fromYoutube(parsed.id);
      if (out.tracks.length === 0) throw new Error("empty");
      return NextResponse.json(out);
    }
    let found: { name: string; items: SpotifyItem[] } | null = null;
    try {
      found = await spotifyViaApi(parsed.id);
    } catch {
      found = null;
    }
    if (!found) found = await spotifyViaEmbed(parsed.id);
    if (!found) throw new Error("empty");
    return NextResponse.json({ name: found.name, resolved: false, tracks: found.items });
  } catch {
    return NextResponse.json({ error: "Couldn’t read that playlist. Make sure it’s public." }, { status: 404 });
  }
}
