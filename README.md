# Rustify
Cover-flow music player. Search any song, queue it, and watch your music move. 🎧
**Search any song, queue it, and watch your music move.**

Rustify is a cover-flow music player for the web. Search for a track, drop it in your queue, and flip through album art in a smooth 3D carousel with glass-effect cards. Installable as a PWA on phone or desktop.

## Bio

| | |
|---|---|
| **Name** | Rustify |
| **Tagline** | Search any song, queue it, and watch your music move. |
| **Type** | Web app / installable PWA |
| **Category** | Music player |
| **Stack** | Next.js 15 (App Router), React 19, TypeScript, Tailwind CSS, Framer Motion |
| **Playback** | YouTube (via `react-youtube`) |
| **Search** | YouTube (`yt-search`), optionally enhanced with the Spotify API |
| **Hosting** | Vercel (recommended) |
| **Storage** | Browser `localStorage`, no account or database needed |

## Features

- Cover-flow carousel with glass exit cards and RGB-split effect
- Song search with YouTube results (Spotify keys optional for better matching)
- Playlist import from a Spotify or YouTube playlist link
- Queue with drag-to-reorder, repeat (all / one), and volume control
- Liked songs and saved playlists, kept in your browser
- Lyrics panel (links out, no licensed lyrics stored)
- Media Session support (lock-screen and hardware media keys)
- Responsive layout for any screen ratio, mobile and desktop
- Installable PWA with app icons and standalone mode

## Run locally

```bash
npm install
cp .env.example .env.local   # optional: add Spotify keys
npm run dev
```

Open http://localhost:3000

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `SPOTIFY_CLIENT_ID` | No | Better search and Spotify playlist import |
| `SPOTIFY_CLIENT_SECRET` | No | Same as above |

Without the keys, search still works using YouTube-only results.

## Project structure

```
app/            Next.js routes, layout, manifest, API routes
  api/music/    /resolve (search) and /playlist (import)
components/     CoverFlowMusicPlayer.tsx (main UI)
public/         Icons and default backgrounds
```

## Disclaimer

Rustify streams through YouTube's embedded player and does not host or download any audio. Use it in line with the terms of the services it connects to.
