"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import YouTube, { type YouTubeEvent, type YouTubePlayer } from "react-youtube";
import {
  AnimatePresence,
  Reorder,
  motion,
  useDragControls,
  useReducedMotion,
} from "framer-motion";
import {
  BookmarkPlus,
  Check,
  ExternalLink,
  Disc3,
  FastForward,
  GripVertical,
  Heart,
  Library,
  Link2,
  ListMusic,
  ListPlus,
  Loader2,
  MessageSquareQuote,
  MoreHorizontal,
  Music2,
  Pause,
  Play,
  Plus,
  Repeat,
  Repeat1,
  Rewind,
  Search,
  Trash2,
  Volume1,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

/* ================================================================== */
/* Types & constants                                                   */
/* ================================================================== */

export interface Track {
  id: string;
  title: string;
  artist: string;
  coverUrl: string;
  youtubeId: string;
  duration: number;
}

interface QueueTrack extends Track {
  qid: string;
}

interface Playlist {
  id: string;
  name: string;
  tracks: Track[];
}

type DrawerTab = "queue" | "playlists";
type RepeatMode = "off" | "track" | "queue" | "playlist";
const REPEAT_MODES: RepeatMode[] = ["off", "track", "queue", "playlist"];
type Palette = { a: string; b: string };

const PLAYLISTS_KEY = "cfmp:playlists:v1";
const SONGS_ONLY_KEY = "cfmp:songsonly:v1";
const QUEUE_KEY = "cfmp:queue:v1";

const STARTER_QUERIES = [
  "Blinding Lights The Weeknd",
  "Levitating Dua Lipa",
  "Good Days SZA",
  "As It Was Harry Styles",
  "Redbone Childish Gambino",
];

const DEFAULT_PALETTE: Palette = { a: "hsl(30 55% 28%)", b: "hsl(14 50% 9%)" };
const GLASS_POPOVER =
  "rounded-2xl border border-white/[0.12] bg-neutral-950/80 backdrop-blur-2xl shadow-[0_24px_64px_-16px_rgba(0,0,0,0.85),inset_0_1px_0_rgba(255,255,255,0.08)]";

/* ================================================================== */
/* Helpers                                                             */
/* ================================================================== */

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

const uid = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function fmt(sec: number): string {
  const s = Number.isFinite(sec) && sec > 0 ? sec : 0;
  return `${Math.floor(s / 60)}:${Math.floor(s % 60).toString().padStart(2, "0")}`;
}

function isTrack(x: unknown): x is Track {
  if (!x || typeof x !== "object") return false;
  const t = x as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.title === "string" &&
    typeof t.artist === "string" &&
    typeof t.coverUrl === "string" &&
    typeof t.youtubeId === "string" &&
    typeof t.duration === "number"
  );
}

async function fetchOne(q: string): Promise<Track | null> {
  try {
    const res = await fetch(`/api/music/resolve?q=${encodeURIComponent(q)}`);
    if (!res.ok) return null;
    const data: unknown = await res.json();
    return isTrack(data) ? data : null;
  } catch {
    return null;
  }
}

interface PlaylistImportResponse {
  name: string;
  resolved: boolean;
  tracks: unknown[];
}

function isImportResponse(x: unknown): x is PlaylistImportResponse {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return typeof r.name === "string" && typeof r.resolved === "boolean" && Array.isArray(r.tracks);
}

const uniqTracks = (ts: Track[]) => ts.filter((t, i) => ts.findIndex((x) => x.id === t.id) === i);

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hashHue(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return 14 + (h % 36); // warm range: 14–50°
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed"));
    img.src = url;
  });
}

/** Dominant vibrant colour from the cover, weighted toward saturated, mid-bright pixels. */
async function extractPalette(url: string, seed: string): Promise<Palette> {
  const hue = hashHue(seed);
  const fallback: Palette = {
    a: `hsl(${hue} 55% 28%)`,
    b: `hsl(${(hue + 346) % 360} 45% 9%)`,
  };
  try {
    const img = await loadImage(url);
    const size = 24;
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return fallback;
    ctx.drawImage(img, 0, 0, size, size);
    const data = ctx.getImageData(0, 0, size, size).data;

    let r = 0;
    let g = 0;
    let b = 0;
    let total = 0;
    for (let i = 0; i < data.length; i += 4) {
      const R = data[i];
      const G = data[i + 1];
      const B = data[i + 2];
      const max = Math.max(R, G, B);
      const min = Math.min(R, G, B);
      const val = max / 255;
      if (val < 0.14) continue;
      const sat = max === 0 ? 0 : (max - min) / max;
      const weight = sat * sat * val + 0.02;
      r += R * weight;
      g += G * weight;
      b += B * weight;
      total += weight;
    }
    if (total === 0) return fallback;

    const [h, s, l] = rgbToHsl(r / total, g / total, b / total);
    const hh = Math.round(h);
    return {
      // Dim on purpose: same hue as the cover, but low lightness and capped saturation.
      a: `hsl(${hh} ${Math.round(clamp(s * 100, 35, 62))}% ${Math.round(clamp(l * 100 * 0.6, 22, 32))}%)`,
      b: `hsl(${(hh + 350) % 360} ${Math.round(clamp(s * 100, 30, 55))}% 9%)`,
    };
  } catch {
    return fallback;
  }
}

function useOutsideClick<T extends HTMLElement>(
  ref: RefObject<T | null>,
  onOutside: () => void,
  active: boolean,
) {
  const cb = useRef(onOutside);
  cb.current = onOutside;
  useEffect(() => {
    if (!active) return;
    const handler = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) cb.current();
    };
    document.addEventListener("pointerdown", handler);
    return () => document.removeEventListener("pointerdown", handler);
  }, [ref, active]);
}

/**
 * Sizes the cards from the stage they actually live in (not guessed viewport math), so the
 * carousel fits any ratio: phones upright/landscape, tablets, desktop, ultrawide, split-screen.
 */
function useStageFit(ref: RefObject<HTMLDivElement | null>) {
  const [fit, setFit] = useState({ w: 200, strip: 76, cy: 0, portrait: true, ready: false, resizing: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    let timer = 0;
    let first = true;
    const measure = () => {
      const cs = getComputedStyle(el);
      const availH = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - 24;
      const availW = el.clientWidth;
      const portrait = availW < availH;
      const cy = Math.round(el.offsetTop + parseFloat(cs.paddingTop) + (el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom)) / 2);
      const strip = availH < 320 ? 52 : 76; // slimmer title strip on very short screens
      const kY = portrait ? 0.4 : 0.3; // keep in sync with stepY in the render
      const byH = (availH - strip * 0.94) / (0.94 + 2 * kY); // centre card + the ±1 diagonal neighbours fit vertically
      const byW = availW * (portrait ? 0.52 : 0.3);
      const w = Math.round(clamp(Math.min(byH, byW), 80, 380));
      setFit((p) =>
        p.w === w && p.strip === strip && p.cy === cy && p.portrait === portrait && p.ready
          ? p
          : { w, strip, cy, portrait, ready: true, resizing: !first },
      );
      first = false;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setFit((p) => (p.resizing ? { ...p, resizing: false } : p)), 180);
    };
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(measure);
    });
    ro.observe(el);
    measure();
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [ref]);
  return fit;
}

function useIsMobile(): boolean {
  const [m, setM] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 639px)");
    const update = () => setM(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return m;
}

/** One second of silence. Looping it keeps the page registered as "playing media" in the background. */
function makeSilentWavUrl(): string {
  const rate = 8000;
  const buf = new ArrayBuffer(44 + rate);
  const v = new DataView(buf);
  const tag = (o: number, t: string) => {
    for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i));
  };
  tag(0, "RIFF");
  v.setUint32(4, 36 + rate, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  tag(36, "data");
  v.setUint32(40, rate, true);
  new Uint8Array(buf, 44).fill(128);
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

/* ================================================================== */
/* Small UI pieces                                                     */
/* ================================================================== */

function IconBtn({
  label,
  onClick,
  active,
  className = "",
  children,
}: {
  label: string;
  onClick: () => void;
  active?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={`grid h-11 w-11 shrink-0 place-items-center rounded-full text-white/75 transition duration-200 hover:bg-white/10 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60 active:scale-90 max-[359px]:h-10 max-[359px]:w-10 sm:h-10 sm:w-10 ${
        active ? "bg-white/[0.14] text-white" : ""
      } ${className}`}
    >
      {children}
    </button>
  );
}

/** List lines + loop arrow: "repeat the playlist". */
function PlaylistLoopIcon({ size = 18 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M3 6h12M3 11h6M3 16h5" />
      <path d="M13 17a4.5 4.5 0 1 0 1.3-3.2" />
      <path d="M14.8 10.8v3.2h3.2" />
    </svg>
  );
}

function Equalizer({ active }: { active: boolean }) {
  return (
    <div className="flex h-4 items-end gap-[2px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="w-[3px] rounded-full bg-white/85"
          animate={{ height: active ? [4, 14, 7, 12, 4] : 4 }}
          transition={
            active
              ? { duration: 0.9 + i * 0.15, repeat: Infinity, ease: "easeInOut" }
              : { duration: 0.2 }
          }
        />
      ))}
    </div>
  );
}

/** Scrolls long titles instead of letting them run off screen. Short titles stay still. */
function MarqueeText({ text, className = "" }: { text: string; className?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const measure = () => {
      const w = wrapRef.current;
      const t = textRef.current;
      if (w && t) setOverflow(t.scrollWidth > w.clientWidth + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (wrapRef.current) ro.observe(wrapRef.current);
    return () => ro.disconnect();
  }, [text]);

  const fade = "linear-gradient(90deg, #000 90%, transparent)";
  return (
    <div
      ref={wrapRef}
      title={text}
      className={`relative w-full min-w-0 overflow-hidden whitespace-nowrap ${className}`}
      style={overflow ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
    >
      <span ref={textRef} className={overflow ? "invisible absolute left-0 top-0" : "inline-block"}>
        {text}
      </span>
      {overflow && (
        <div
          className="marquee inline-flex"
          style={{ animationDuration: `${Math.max(8, text.length * 0.3)}s` }}
        >
          <span className="pr-10">{text}</span>
          <span className="pr-10" aria-hidden>
            {text}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * Seek bar. The fill and thumb are moved straight on the DOM every animation frame
 * (no React re-render), with the player clock extrapolated between polls, so it glides.
 */
function ProgressSection({
  playerRef,
  ready,
  playing,
  trackKey,
  fallbackDuration,
  progressRef,
  scrubbingRef,
  accent,
}: {
  playerRef: { current: YouTubePlayer | null };
  ready: boolean;
  playing: boolean;
  trackKey: string;
  fallbackDuration: number;
  progressRef: { current: number };
  scrubbingRef: { current: boolean };
  accent: string;
}) {
  const [elapsed, setElapsed] = useState(0);
  const [total, setTotal] = useState(fallbackDuration);
  const [dragging, setDragging] = useState(false);

  const innerRef = useRef<HTMLDivElement>(null);
  const fillRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLDivElement>(null);
  const clock = useRef({ t: 0, at: 0, playing: false });
  const totalRef = useRef(fallbackDuration);
  const lastSecRef = useRef(-1);

  const paint = useCallback((t: number) => {
    const tot = totalRef.current;
    const r = tot > 0 ? clamp(t / tot, 0, 1) : 0;
    if (fillRef.current) fillRef.current.style.width = `${r * 100}%`;
    if (thumbRef.current) thumbRef.current.style.left = `calc(${r * 100}% - 9px)`;
    const sec = Math.floor(t);
    if (sec !== lastSecRef.current) {
      lastSecRef.current = sec;
      setElapsed(sec);
    }
  }, []);

  // New track: reset the clock.
  useEffect(() => {
    totalRef.current = fallbackDuration;
    setTotal(fallbackDuration);
    clock.current = { t: 0, at: performance.now(), playing: clock.current.playing };
    progressRef.current = 0;
    lastSecRef.current = -1;
    paint(0);
  }, [trackKey, fallbackDuration, paint, progressRef]);

  // Play / pause: freeze or resume extrapolation without a jump.
  useEffect(() => {
    const c = clock.current;
    const now = performance.now();
    if (c.playing) c.t += (now - c.at) / 1000;
    c.at = now;
    c.playing = playing;
  }, [playing]);

  // Correct drift from the real player a few times a second.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const id = setInterval(async () => {
      const p = playerRef.current;
      if (!p || scrubbingRef.current) return;
      try {
        const [t, d] = await Promise.all([
          Promise.resolve(p.getCurrentTime()),
          Promise.resolve(p.getDuration()),
        ]);
        if (!alive || scrubbingRef.current) return;
        if (Number.isFinite(t)) {
          clock.current.t = t;
          clock.current.at = performance.now();
          progressRef.current = t;
        }
        if (Number.isFinite(d) && d > 0 && Math.abs(d - totalRef.current) > 0.5) {
          totalRef.current = d;
          setTotal(d);
        }
      } catch {
        /* player not ready for this call yet */
      }
    }, 250);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [ready, playerRef, progressRef, scrubbingRef]);

  // Per-frame painting.
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      if (!scrubbingRef.current) {
        const c = clock.current;
        let t = c.t + (c.playing ? (performance.now() - c.at) / 1000 : 0);
        if (totalRef.current > 0) t = Math.min(t, totalRef.current);
        paint(Math.max(0, t));
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [paint, scrubbingRef]);

  const ratioFrom = (e: ReactPointerEvent<HTMLDivElement>) => {
    const rect = innerRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return 0;
    return clamp((e.clientX - rect.left) / rect.width, 0, 1);
  };

  const scrub = (r: number) => {
    scrubbingRef.current = true;
    setDragging(true);
    const t = r * totalRef.current;
    clock.current.t = t;
    clock.current.at = performance.now();
    paint(t);
  };

  const commit = (r: number) => {
    if (!scrubbingRef.current) return;
    const t = r * totalRef.current;
    playerRef.current?.seekTo(t, true);
    clock.current.t = t;
    clock.current.at = performance.now();
    progressRef.current = t;
    scrubbingRef.current = false;
    setDragging(false);
    paint(t);
  };

  const nudge = (delta: number) => {
    const t = clamp(progressRef.current + delta, 0, totalRef.current);
    playerRef.current?.seekTo(t, true);
    clock.current.t = t;
    clock.current.at = performance.now();
    progressRef.current = t;
    paint(t);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      nudge(5);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      nudge(-5);
    }
  };

  return (
    <div className="mt-1">
      <div
        role="slider"
        tabIndex={0}
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={Math.round(total)}
        aria-valuenow={elapsed}
        aria-valuetext={`${fmt(elapsed)} of ${fmt(total)}`}
        onKeyDown={onKey}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          scrub(ratioFrom(e));
        }}
        onPointerMove={(e) => {
          if (scrubbingRef.current && e.buttons & 1) scrub(ratioFrom(e));
        }}
        onPointerUp={(e) => commit(ratioFrom(e))}
        onPointerCancel={() => commit(totalRef.current > 0 ? progressRef.current / totalRef.current : 0)}
        className="relative h-9 cursor-pointer touch-none select-none px-[9px] focus-visible:outline-none"
      >
        <div ref={innerRef} className="relative h-full">
          <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full bg-white/25" />
          <div
            ref={fillRef}
            className="absolute left-0 top-1/2 h-1.5 -translate-y-1/2 rounded-full"
            style={{ width: "0%", background: accent }}
          />
          <div
            ref={thumbRef}
            className={`absolute top-1/2 h-[18px] w-[18px] -translate-y-1/2 rounded-full border-[3px] border-white transition-transform duration-150 ${
              dragging ? "scale-125" : ""
            }`}
            style={{
              left: "calc(0% - 9px)",
              background: accent,
              boxShadow: `0 0 0 5px color-mix(in srgb, ${accent} 28%, transparent), 0 2px 8px rgba(0,0,0,0.5)`,
            }}
          />
        </div>
      </div>
      <div className="flex justify-between px-[9px] text-[11px] tabular-nums text-white/60">
        <span>{fmt(elapsed)}</span>
        <span>{fmt(total)}</span>
      </div>
    </div>
  );
}

function PlaylistPicker({
  playlists,
  onPick,
  onCreate,
}: {
  playlists: Playlist[];
  onPick: (playlistId: string) => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const submit = () => {
    const n = name.trim();
    if (!n) return;
    onCreate(n);
    setName("");
  };
  return (
    <div className="w-60 p-2 text-sm text-white">
      <p className="px-2 pb-1.5 pt-1 text-xs font-medium text-white/60">Save to playlist</p>
      <ul className="max-h-40 overflow-y-auto">
        {playlists.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              onClick={() => onPick(p.id)}
              className="flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left hover:bg-white/10"
            >
              <span className="truncate">{p.name}</span>
              <span className="text-xs text-white/50">{p.tracks.length}</span>
            </button>
          </li>
        ))}
        {playlists.length === 0 && (
          <li className="px-2 py-2 text-xs text-white/50">No playlists yet. Create one below.</li>
        )}
      </ul>
      <div className="mt-1 flex items-center gap-1.5 border-t border-white/10 pt-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="New playlist name"
          maxLength={40}
          className="min-w-0 flex-1 rounded-lg bg-white/10 px-2.5 py-1.5 text-base placeholder:text-white/40 sm:text-sm focus:outline-none focus:ring-1 focus:ring-white/50"
        />
        <button
          type="button"
          aria-label="Create playlist and save"
          onClick={submit}
          className="grid h-8 w-8 place-items-center rounded-lg bg-white/15 hover:bg-white/25"
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}

/* ---------------------------- Search bar --------------------------- */

function SearchBar({
  playlists,
  onPlayNow,
  onAddToQueue,
  onSaveToPlaylist,
  onCreatePlaylistAndSave,
}: {
  playlists: Playlist[];
  onPlayNow: (t: Track) => void;
  onAddToQueue: (t: Track) => void;
  onSaveToPlaylist: (playlistId: string, t: Track) => void;
  onCreatePlaylistAndSave: (name: string, t: Track) => void;
}) {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Track[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [pickerFor, setPickerFor] = useState<string | null>(null);
  const [songsOnly, setSongsOnly] = useState(true); // on by default
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      if (window.localStorage.getItem(SONGS_ONLY_KEY) === "0") setSongsOnly(false);
    } catch {
      /* storage blocked */
    }
  }, []);

  const toggleSongsOnly = () => {
    setSongsOnly((v) => {
      try {
        window.localStorage.setItem(SONGS_ONLY_KEY, v ? "0" : "1");
      } catch {
        /* storage blocked */
      }
      return !v;
    });
  };

  useOutsideClick(wrapRef, () => {
    setOpen(false);
    setPickerFor(null);
  }, open);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      setMessage(null);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    setMessage(null);

    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/music/resolve?q=${encodeURIComponent(term)}&limit=6&songsOnly=${songsOnly ? 1 : 0}`,
          { signal: ctrl.signal },
        );
        if (res.status === 404) {
          setResults([]);
          setMessage("No songs found. Try another search.");
          return;
        }
        if (!res.ok) throw new Error("request failed");
        const data = (await res.json()) as { results?: unknown[] };
        const list = (data.results ?? []).filter(isTrack);
        setResults(list);
        setMessage(list.length ? null : "No songs found. Try another search.");
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setResults([]);
        setMessage("Search failed. Check your connection and try again.");
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    }, 400);

    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, songsOnly]);

  const showPanel = open && q.trim().length >= 2;

  return (
    <div ref={wrapRef} className="relative min-w-0 flex-1">
      <div className="flex items-center gap-2 rounded-full border border-white/[0.12] bg-white/[0.07] px-4 py-2.5 shadow-[0_8px_30px_-10px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.1)] backdrop-blur-2xl transition focus-within:border-white/30 focus-within:bg-white/[0.11]">
        {loading ? (
          <Loader2 size={18} className="shrink-0 animate-spin text-white/70" />
        ) : (
          <Search size={18} className="shrink-0 text-white/70" />
        )}
        <input
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOpen(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
          placeholder="Search songs or artists"
          aria-label="Search songs"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 bg-transparent text-base text-white placeholder:text-white/50 focus:outline-none"
        />
        <button
          type="button"
          aria-pressed={songsOnly}
          aria-label="Songs only"
          title={songsOnly ? "Songs only: on" : "Songs only: off"}
          onClick={toggleSongsOnly}
          className={`flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition ${
            songsOnly ? "bg-white text-neutral-900" : "bg-white/10 text-white/70"
          }`}
        >
          <Music2 size={13} />
          Songs
        </button>
        {q && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => {
              setQ("");
              setResults([]);
            }}
            className="text-white/60 hover:text-white"
          >
            <X size={16} />
          </button>
        )}
      </div>

      <AnimatePresence>
        {showPanel && (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className={`absolute left-0 right-0 top-full z-50 mt-2 max-h-[55dvh] overscroll-contain overflow-y-auto p-1.5 ${GLASS_POPOVER}`}
          >
            {message && !loading && (
              <p className="px-3 py-4 text-center text-sm text-white/60">{message}</p>
            )}
            {loading && results.length === 0 && (
              <p className="px-3 py-4 text-center text-sm text-white/60">Searching…</p>
            )}
            <ul>
              {results.map((t) => (
                <li key={t.id} className="relative flex items-center gap-3 rounded-xl p-2 hover:bg-white/10">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={t.coverUrl}
                    alt=""
                    className="h-11 w-11 shrink-0 rounded-md object-cover"
                    draggable={false}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-white">{t.title}</p>
                    <p className="truncate text-xs text-white/55">
                      {t.artist} · {fmt(t.duration)}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center">
                    <IconBtn
                      label="Play now"
                      className="!h-9 !w-9"
                      onClick={() => {
                        onPlayNow(t);
                        setOpen(false);
                      }}
                    >
                      <Play size={16} className="fill-current" />
                    </IconBtn>
                    <IconBtn label="Add to queue" className="!h-9 !w-9" onClick={() => onAddToQueue(t)}>
                      <ListPlus size={17} />
                    </IconBtn>
                    <IconBtn
                      label="Save to playlist"
                      className="!h-9 !w-9"
                      active={pickerFor === t.id}
                      onClick={() => setPickerFor(pickerFor === t.id ? null : t.id)}
                    >
                      <BookmarkPlus size={17} />
                    </IconBtn>
                  </div>
                  {pickerFor === t.id && (
                    <div className={`absolute right-2 top-full z-10 mt-1 ${GLASS_POPOVER}`}>
                      <PlaylistPicker
                        playlists={playlists}
                        onPick={(id) => {
                          onSaveToPlaylist(id, t);
                          setPickerFor(null);
                        }}
                        onCreate={(name) => {
                          onCreatePlaylistAndSave(name, t);
                          setPickerFor(null);
                        }}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ---------------------------- Queue row ---------------------------- */

function QueueRow({
  track,
  active,
  playing,
  onPlay,
  onRemove,
}: {
  track: QueueTrack;
  active: boolean;
  playing: boolean;
  onPlay: () => void;
  onRemove: () => void;
}) {
  const controls = useDragControls();
  return (
    <Reorder.Item
      value={track}
      dragListener={false}
      dragControls={controls}
      className={`flex items-center gap-2 rounded-2xl p-2 ${
        active ? "bg-white/[0.13] ring-1 ring-inset ring-white/10" : "hover:bg-white/10"
      }`}
    >
      <button
        type="button"
        aria-label="Drag to reorder"
        onPointerDown={(e) => controls.start(e)}
        className="grid h-8 w-6 shrink-0 cursor-grab touch-none place-items-center text-white/40 hover:text-white/80 active:cursor-grabbing"
      >
        <GripVertical size={16} />
      </button>
      <button type="button" onClick={onPlay} className="flex min-w-0 flex-1 items-center gap-3 text-left">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={track.coverUrl} alt="" className="h-10 w-10 shrink-0 rounded-md object-cover" draggable={false} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-white">{track.title}</span>
          <span className="block truncate text-xs text-white/55">{track.artist}</span>
        </span>
        {active && <Equalizer active={playing} />}
      </button>
      <IconBtn label="Remove from queue" className="!h-8 !w-8" onClick={onRemove}>
        <X size={15} />
      </IconBtn>
    </Reorder.Item>
  );
}

/* ================================================================== */
/* Main component                                                      */
/* ================================================================== */

export default function CoverFlowMusicPlayer({ className = "" }: { className?: string }) {
  const reduceMotion = useReducedMotion();
  const spring = reduceMotion
    ? { duration: 0 }
    : ({ type: "spring", stiffness: 300, damping: 32, mass: 0.8 } as const);
  const stageRef = useRef<HTMLDivElement>(null);
  const { w: cardW, strip, portrait, ready: stageReady, resizing } = useStageFit(stageRef);
  const isMobile = useIsMobile();
  const cardSpring = resizing ? ({ duration: 0 } as const) : spring; // no spring lag while the window is being resized
  const sheetControls = useDragControls();

  /* ---- state ---- */
  const [hydrated, setHydrated] = useState(false);
  const [queue, setQueue] = useState<QueueTrack[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  const [repeat, setRepeat] = useState<RepeatMode>("off");
  const [source, setSource] = useState<string | null>(null); // playlist the queue was started from
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(80);
  const [muted, setMuted] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [drawer, setDrawer] = useState<DrawerTab | null>(null);
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuView, setMenuView] = useState<"main" | "playlists">("main");
  const [openPlaylistId, setOpenPlaylistId] = useState<string | null>(null);
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [importUrl, setImportUrl] = useState("");
  const [importing, setImporting] = useState<{ done: number; total: number } | null>(null);
  const [palette, setPalette] = useState<Palette>(DEFAULT_PALETTE);
  const [playerReady, setPlayerReady] = useState(false);
  const [starterLoading, setStarterLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [likedIds, setLikedIds] = useState<string[]>([]);
  const [burst, setBurst] = useState<number | null>(null);

  /* ---- refs (stable access inside callbacks / player events) ---- */
  const playerRef = useRef<YouTubePlayer | null>(null);
  const intentRef = useRef(false); // true = user wants audio playing
  const scrubbingRef = useRef(false);
  const queueRef = useRef<QueueTrack[]>(queue);
  const indexRef = useRef(currentIndex);
  const progressRef = useRef(0);
  const swipedRef = useRef(false);
  const userPausedRef = useRef(false);
  const interruptedRef = useRef(false); // browser paused us while the app was in the background
  const keepAliveRef = useRef<HTMLAudioElement | null>(null);
  const playlistsRef = useRef<Playlist[]>(playlists);
  const repeatRef = useRef<RepeatMode>("off");
  const sourceRef = useRef<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const volumeRef = useRef<HTMLDivElement>(null);
  queueRef.current = queue;
  indexRef.current = currentIndex;
  playlistsRef.current = playlists;
  repeatRef.current = repeat;
  sourceRef.current = source;

  const current: QueueTrack | null = queue[currentIndex] ?? null;

  useOutsideClick(menuRef, () => setMenuOpen(false), menuOpen);
  useOutsideClick(volumeRef, () => setVolumeOpen(false), volumeOpen);

  /* Tells the page that embeds or opened Rustify (Ace) what is playing. Does nothing when Rustify runs on its own. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const target = window.parent !== window ? window.parent : window.opener; // embedded in Ace, or opened from it as a window
    if (!target) return;
    const host = process.env.NEXT_PUBLIC_ACE_ORIGIN || "https://miscord-beryl.vercel.app";
    const send = () =>
      target.postMessage(
        {
          type: "ace:nowplaying",
          v: 1,
          playing: isPlaying && !!current,
          track: current
            ? { title: current.title, artist: current.artist, cover: current.coverUrl, yt: current.youtubeId, duration: current.duration }
            : null,
        },
        host,
      );
    send();
    if (!isPlaying) return;
    const beat = window.setInterval(send, 15000); // heartbeat: the host treats silence as "stopped"
    return () => window.clearInterval(beat);
  }, [current, isPlaying]);

  const notify = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem("rustify:liked");
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (Array.isArray(parsed)) setLikedIds(parsed.filter((x): x is string => typeof x === "string"));
    } catch {
      /* storage unavailable: likes just won't persist */
    }
  }, []);

  const toggleLike = useCallback(() => {
    if (!current) return;
    const id = current.id;
    const liking = !likedIds.includes(id);
    const nextIds = liking ? [...likedIds, id] : likedIds.filter((x) => x !== id);
    setLikedIds(nextIds);
    try {
      window.localStorage.setItem("rustify:liked", JSON.stringify(nextIds));
    } catch {
      /* ignore */
    }
    if (liking) {
      setBurst(Date.now());
      window.setTimeout(() => setBurst(null), 800);
    }
    notify(liking ? "Added to your liked songs" : "Removed from liked songs");
  }, [current, likedIds, notify]);

  useEffect(
    () => () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    },
    [],
  );

  /* ================================================================ */
  /* Persistence (SSR-safe: only touches localStorage after mount)     */
  /* ================================================================ */

  useEffect(() => {
    try {
      const rawPl = window.localStorage.getItem(PLAYLISTS_KEY);
      if (rawPl) {
        const parsed: unknown = JSON.parse(rawPl);
        if (Array.isArray(parsed)) {
          const valid: Playlist[] = parsed
            .filter(
              (p): p is Playlist =>
                !!p &&
                typeof (p as Playlist).id === "string" &&
                typeof (p as Playlist).name === "string" &&
                Array.isArray((p as Playlist).tracks),
            )
            .map((p) => ({ ...p, tracks: p.tracks.filter(isTrack) }));
          setPlaylists(valid);
        }
      }
      const rawQ = window.localStorage.getItem(QUEUE_KEY);
      if (rawQ) {
        const parsed = JSON.parse(rawQ) as {
          queue?: unknown[];
          currentIndex?: number;
          volume?: number;
          repeat?: string;
          source?: string | null;
        };
        if (Array.isArray(parsed.queue)) {
          const restored: QueueTrack[] = parsed.queue
            .filter(isTrack)
            .map((t) => ({ ...t, qid: uid() }));
          setQueue(restored);
          setCurrentIndex(clamp(parsed.currentIndex ?? 0, 0, Math.max(0, restored.length - 1)));
        }
        if (typeof parsed.volume === "number") setVolume(clamp(parsed.volume, 0, 100));
        if (REPEAT_MODES.includes(parsed.repeat as RepeatMode)) setRepeat(parsed.repeat as RepeatMode);
        if (typeof parsed.source === "string") setSource(parsed.source);
      }
    } catch {
      /* corrupted or blocked storage: start fresh */
    }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(PLAYLISTS_KEY, JSON.stringify(playlists));
    } catch {
      /* quota or private mode */
    }
  }, [playlists, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      const slim = queue.map(({ qid: _qid, ...t }) => t);
      window.localStorage.setItem(
        QUEUE_KEY,
        JSON.stringify({ queue: slim, currentIndex, volume, repeat, source }),
      );
    } catch {
      /* quota or private mode */
    }
  }, [queue, currentIndex, volume, repeat, source, hydrated]);

  /* ================================================================ */
  /* YouTube engine wiring                                             */
  /* ================================================================ */

  // Load / cue the video whenever the active queue entry changes.
  const currentQid = current?.qid;
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !playerReady) return;
    progressRef.current = 0;
    if (!current) {
      p.stopVideo();
      intentRef.current = false;
      setIsPlaying(false);
      return;
    }
    if (intentRef.current) p.loadVideoById(current.youtubeId);
    else p.cueVideoById(current.youtubeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentQid, playerReady]);

  // Volume + mute.
  useEffect(() => {
    const p = playerRef.current;
    if (!p || !playerReady) return;
    p.setVolume(volume);
    if (muted || volume === 0) p.mute();
    else p.unMute();
  }, [volume, muted, playerReady]);

  /* ================================================================ */
  /* Transport actions                                                 */
  /* ================================================================ */

  const playIndex = useCallback((i: number) => {
    const q = queueRef.current;
    if (i < 0 || i >= q.length) return;
    intentRef.current = true;
    setIsPlaying(true);
    if (i === indexRef.current) {
      playerRef.current?.playVideo();
    } else {
      setCurrentIndex(i);
    }
  }, []);

  const togglePlay = useCallback(() => {
    const p = playerRef.current;
    if (!p || queueRef.current.length === 0) return;
    if (intentRef.current) {
      intentRef.current = false;
      userPausedRef.current = true;
      p.pauseVideo();
      setIsPlaying(false);
    } else {
      intentRef.current = true;
      p.playVideo();
      setIsPlaying(true);
    }
  }, []);

  // Replay the current song from the start.
  const restartCurrent = useCallback(() => {
    const p = playerRef.current;
    if (!p) return;
    intentRef.current = true;
    userPausedRef.current = false;
    progressRef.current = 0;
    p.seekTo(0, true);
    p.playVideo();
    setIsPlaying(true);
  }, []);

  // End of the queue with a loop mode on: go round again.
  const wrapAround = useCallback(() => {
    const q = queueRef.current;
    if (repeatRef.current === "playlist") {
      const pl = playlistsRef.current.find((x) => x.id === sourceRef.current);
      if (pl && pl.tracks.length > 0) {
        intentRef.current = true;
        userPausedRef.current = false;
        setQueue(pl.tracks.map((t) => ({ ...t, qid: uid() })));
        setCurrentIndex(0);
        setIsPlaying(true);
        return;
      }
    }
    if (q.length > 1) playIndex(0);
    else restartCurrent();
  }, [playIndex, restartCurrent]);

  const next = useCallback(() => {
    const q = queueRef.current;
    const i = indexRef.current;
    if (i < q.length - 1) {
      playIndex(i + 1);
    } else if (q.length > 0 && (repeatRef.current === "queue" || repeatRef.current === "playlist")) {
      wrapAround();
    }
  }, [playIndex, wrapAround]);

  const prev = useCallback(() => {
    if (progressRef.current > 3 || indexRef.current === 0) {
      playerRef.current?.seekTo(0, true);
      progressRef.current = 0;
      return;
    }
    playIndex(indexRef.current - 1);
  }, [playIndex]);

  const handleEnded = useCallback(() => {
    const q = queueRef.current;
    const i = indexRef.current;
    const mode = repeatRef.current;

    if (mode === "track") {
      restartCurrent();
      return;
    }
    if (i < q.length - 1) {
      intentRef.current = true;
      setCurrentIndex(i + 1);
      return;
    }
    if (mode === "queue" || mode === "playlist") {
      wrapAround();
      return;
    }
    // End of queue, loop off: stop and re-cue the last track.
    intentRef.current = false;
    setIsPlaying(false);
    progressRef.current = 0;
    if (q[i]) playerRef.current?.cueVideoById(q[i].youtubeId);
  }, [restartCurrent, wrapAround]);

  const handleError = useCallback(() => {
    notify("This track can't be played. Skipping.");
    if (indexRef.current < queueRef.current.length - 1) {
      intentRef.current = true;
      setCurrentIndex(indexRef.current + 1);
    } else {
      intentRef.current = false;
      setIsPlaying(false);
    }
  }, [notify]);

  // Keyboard: ← / → change tracks (ignored while typing or on sliders).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, [role='slider']")) return;
      if (e.key === "ArrowRight") next();
      else if (e.key === "ArrowLeft") prev();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [next, prev]);

  // Background playback: silent looping audio keeps the page registered as media playback.
  useEffect(() => {
    const a = keepAliveRef.current;
    if (!a) return;
    const url = makeSilentWavUrl();
    a.src = url;
    a.loop = true;
    return () => {
      a.pause();
      URL.revokeObjectURL(url);
    };
  }, []);

  useEffect(() => {
    const a = keepAliveRef.current;
    if (!a || !a.src) return;
    if (isPlaying) a.play().catch(() => {});
    else a.pause();
  }, [isPlaying]);

  // If the page goes to the background and playback gets paused by the browser, resume it.
  useEffect(() => {
    const onVisibility = () => {
      if (!document.hidden) {
        // Back in the app: continue the song the browser paused for us.
        if (interruptedRef.current && !userPausedRef.current) {
          interruptedRef.current = false;
          intentRef.current = true;
          setIsPlaying(true);
          playerRef.current?.playVideo();
        }
        return;
      }
      window.setTimeout(() => {
        const p = playerRef.current;
        if (p && document.hidden && intentRef.current && !userPausedRef.current) p.playVideo();
      }, 300);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  // Lock-screen / notification controls on phones.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    if (!current) {
      ms.metadata = null;
      return;
    }
    ms.metadata = new MediaMetadata({
      title: current.title,
      artist: current.artist,
      artwork: [{ src: current.coverUrl, sizes: "640x640" }],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.qid]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) return;
    const ms = navigator.mediaSession;
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        /* action unsupported */
      }
    };
    set("play", () => {
      if (!intentRef.current) togglePlay();
    });
    set("pause", () => {
      if (intentRef.current) togglePlay();
    });
    set("nexttrack", next);
    set("previoustrack", prev);
    return () => {
      (["play", "pause", "nexttrack", "previoustrack"] as MediaSessionAction[]).forEach((a) =>
        set(a, null),
      );
    };
  }, [togglePlay, next, prev]);

  /* ================================================================ */
  /* Queue actions                                                     */
  /* ================================================================ */

  const replaceQueue = useCallback((tracks: Track[], startIndex: number, play: boolean, sourceId: string | null = null) => {
    intentRef.current = play;
    setSource(sourceId);
    setQueue(tracks.map((t) => ({ ...t, qid: uid() })));
    setCurrentIndex(startIndex);
    setIsPlaying(play);
  }, []);

  const playNow = useCallback((t: Track) => {
    const q = queueRef.current;
    const at = q.length ? indexRef.current + 1 : 0;
    const item: QueueTrack = { ...t, qid: uid() };
    intentRef.current = true;
    setQueue([...q.slice(0, at), item, ...q.slice(at)]);
    setCurrentIndex(at);
    setIsPlaying(true);
  }, []);

  const addToQueue = useCallback(
    (t: Track) => {
      setQueue((q) => [...q, { ...t, qid: uid() }]);
      notify(`Added “${t.title}” to queue`);
    },
    [notify],
  );

  const removeFromQueue = useCallback((qid: string) => {
    const q = queueRef.current;
    const idx = q.findIndex((x) => x.qid === qid);
    if (idx < 0) return;
    const nq = q.filter((x) => x.qid !== qid);
    let ni = indexRef.current;
    if (idx < ni) ni -= 1;
    else if (idx === ni) ni = Math.min(ni, nq.length - 1);
    setQueue(nq);
    setCurrentIndex(Math.max(0, ni));
  }, []);

  const reorderQueue = useCallback((order: QueueTrack[]) => {
    const curQid = queueRef.current[indexRef.current]?.qid;
    setQueue(order);
    const ni = order.findIndex((x) => x.qid === curQid);
    if (ni >= 0) setCurrentIndex(ni);
  }, []);

  const clearQueue = useCallback(() => {
    intentRef.current = false;
    setQueue([]);
    setCurrentIndex(0);
    setIsPlaying(false);
    setSource(null);
  }, []);

  const loadStarter = async () => {
    setStarterLoading(true);
    try {
      const found = (await Promise.all(STARTER_QUERIES.map(fetchOne))).filter(
        (t): t is Track => t !== null,
      );
      if (found.length) replaceQueue(found, 0, true);
      else notify("Couldn't load songs. Check your connection and API keys.");
    } finally {
      setStarterLoading(false);
    }
  };

  /* ================================================================ */
  /* Playlist actions                                                  */
  /* ================================================================ */

  const saveToPlaylist = useCallback(
    (playlistId: string, t: Track) => {
      const target = playlistsRef.current.find((p) => p.id === playlistId);
      if (!target) return;
      if (target.tracks.some((x) => x.id === t.id)) {
        notify(`Already in “${target.name}”`);
        return;
      }
      setPlaylists((all) =>
        all.map((p) => (p.id === playlistId ? { ...p, tracks: [...p.tracks, t] } : p)),
      );
      notify(`Saved to “${target.name}”`);
    },
    [notify],
  );

  const createPlaylist = useCallback((name: string, firstTrack?: Track): string => {
    const id = uid();
    setPlaylists((all) => [...all, { id, name, tracks: firstTrack ? [firstTrack] : [] }]);
    return id;
  }, []);

  const createPlaylistAndSave = useCallback(
    (name: string, t: Track) => {
      createPlaylist(name, t);
      notify(`Saved to “${name}”`);
    },
    [createPlaylist, notify],
  );

  const deletePlaylist = (id: string) => {
    setPlaylists((all) => all.filter((p) => p.id !== id));
    if (openPlaylistId === id) setOpenPlaylistId(null);
  };

  const removeFromPlaylist = (playlistId: string, trackId: string) =>
    setPlaylists((all) =>
      all.map((p) =>
        p.id === playlistId ? { ...p, tracks: p.tracks.filter((t) => t.id !== trackId) } : p,
      ),
    );

  const playPlaylist = (p: Playlist) => {
    if (!p.tracks.length) return;
    replaceQueue(p.tracks, 0, true, p.id);
    setDrawer(null);
  };

  const queuePlaylist = (p: Playlist) => {
    if (!p.tracks.length) return;
    setQueue((q) => [...q, ...p.tracks.map((t) => ({ ...t, qid: uid() }))]);
    notify(`Queued ${p.tracks.length} songs from “${p.name}”`);
  };

  /** Paste a Spotify/YouTube playlist link: creates a playlist and fills it with every song. */
  const importPlaylist = async () => {
    const url = importUrl.trim();
    if (!url || importing) return;
    setImporting({ done: 0, total: 0 });
    try {
      const res = await fetch(`/api/music/playlist?url=${encodeURIComponent(url)}`);
      const data: unknown = await res.json();
      if (!res.ok || !isImportResponse(data)) {
        const msg = (data as { error?: unknown } | null)?.error;
        notify(typeof msg === "string" ? msg : "Couldn’t import that playlist");
        return;
      }
      const name = data.name.slice(0, 60);

      if (data.resolved) {
        const tracks = uniqTracks(data.tracks.filter(isTrack));
        const id = createPlaylist(name);
        setPlaylists((all) => all.map((p) => (p.id === id ? { ...p, tracks } : p)));
        setOpenPlaylistId(id);
        notify(`Imported ${tracks.length} songs into “${name}”`);
        setImportUrl("");
        return;
      }

      // Spotify gives metadata only: find each song on YouTube, 4 at a time, keeping playlist order.
      const items = data.tracks.filter(
        (t): t is { title: string; artist: string } =>
          !!t && typeof (t as { title?: unknown }).title === "string" && typeof (t as { artist?: unknown }).artist === "string",
      );
      const id = createPlaylist(name);
      setOpenPlaylistId(id);
      const results: (Track | null)[] = items.map(() => null);
      let cursor = 0;
      let done = 0;
      setImporting({ done, total: items.length });
      const worker = async () => {
        while (cursor < items.length) {
          const i = cursor++;
          const item = items[i];
          if (!item) continue;
          results[i] = await fetchOne(`${item.artist} ${item.title}`);
          done++;
          const tracks = uniqTracks(results.filter((t): t is Track => t !== null));
          setPlaylists((all) => all.map((p) => (p.id === id ? { ...p, tracks } : p)));
          setImporting({ done, total: items.length });
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      const added = results.filter(Boolean).length;
      notify(`Imported ${added} of ${items.length} songs into “${name}”`);
      setImportUrl("");
    } catch {
      notify("Couldn’t import that playlist");
    } finally {
      setImporting(null);
    }
  };

  /* ================================================================ */
  /* Ambient colour                                                    */
  /* ================================================================ */

  const cycleRepeat = () => {
    let nxt = REPEAT_MODES[(REPEAT_MODES.indexOf(repeat) + 1) % REPEAT_MODES.length];
    const pl = playlists.find((x) => x.id === source);
    if (nxt === "playlist" && !pl) {
      notify("Start a playlist from the Playlists tab to loop it");
      nxt = "off";
    }
    setRepeat(nxt);
    notify(
      nxt === "track"
        ? "Repeating this song"
        : nxt === "queue"
          ? "Repeating the whole queue"
          : nxt === "playlist"
            ? `Repeating playlist “${pl?.name ?? ""}”`
            : "Repeat off",
    );
  };

  // If the playlist we were looping is gone, fall back to looping the queue.
  useEffect(() => {
    if (repeat === "playlist" && !(source && playlists.some((x) => x.id === source))) {
      setRepeat("queue");
    }
  }, [repeat, source, playlists]);

  const coverUrl = current?.coverUrl;
  const seed = current?.title ?? "";
  useEffect(() => {
    if (!coverUrl) {
      setPalette(DEFAULT_PALETTE);
      return;
    }
    let live = true;
    extractPalette(coverUrl, seed).then((p) => live && setPalette(p));
    return () => {
      live = false;
    };
  }, [coverUrl, seed]);

  /* ================================================================ */
  /* Derived values                                                    */
  /* ================================================================ */

  const accent = `hsl(${/hsl\((\d+)/.exec(palette.a)?.[1] ?? 24} 92% 58%)`;
  const glow = current ? accent : "hsl(0 0% 100%)";
  const isLiked = !!current && likedIds.includes(current.id);
  const cardH = cardW + strip;
  const VolumeIcon = muted || volume === 0 ? VolumeX : volume < 50 ? Volume1 : Volume2;

  const visible = [-3, -2, -1, 0, 1, 2, 3]
    .map((offset) => ({ offset, track: queue[currentIndex + offset] }))
    .filter((x): x is { offset: number; track: QueueTrack } => Boolean(x.track));

  /* Glass exit carousel: cards ride a diagonal. Slots ±3 are glass "exit" ghosts that fly past the camera. */
  const stepX = cardW * (portrait ? 0.6 : 0.82);
  const stepY = cardW * (portrait ? 0.4 : 0.3);
  const at = (arr: readonly number[], i: number) => arr[Math.min(i, arr.length - 1)] ?? 0;
  const slot = (o: number) => {
    const s = Math.sign(o);
    const a = Math.abs(o);
    return {
      x: s * stepX * at([0, 1, 1.9, 2.7, 3.6], a),
      y: s * stepY * at([0, 1, 1.9, 3.6, 5], a),
      scale: at([1, 0.94, 0.86, 1.9, 2.8], a),
      rotate: s * at([0, 6, 13, 22, 32], a),
      rotateY: -s * at([0, 16, 26, 34, 40], a),
      opacity: at([1, 1, 0.92, 0.6, 0], a),
      filter: `blur(${at(isMobile ? [0, 0, 0.4, 4, 10] : [0, 0, 0.6, 7, 16], a)}px)`,
    };
  };
  const ghostAt = (a: number) => at([0, 0, 0.15, 0.9, 1], a); // RGB-split + sheen strength
  const shiftAt = (a: number) => at([0, 0, 2, 10, 18], a); // chromatic offset in px

  /* ================================================================ */
  /* Render                                                            */
  /* ================================================================ */

  return (
    <section
      className={`relative isolate flex h-screen w-full flex-col supports-[height:100dvh]:h-[100dvh] overflow-hidden overscroll-none bg-black text-white ${className}`}
      aria-label="Music player"
    >
      {/* ---------- Ambient background ---------- */}
      <div className="pointer-events-none absolute inset-0 -z-10 bg-[#060403]">
        {/* Static artwork: always on, never moves. */}
        {/* Phones held upright get the portrait artwork; wide screens get the landscape one. */}
        <picture>
          <source media="(orientation: portrait)" srcSet="/default-bg-mobile.jpg" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/default-bg.jpg"
            alt=""
            draggable={false}
            decoding="async"
            className="absolute inset-0 h-full w-full object-cover object-center"
          />
        </picture>

        {/* Album-reactive aurora: the current cover, melted into colour, drifts while the song plays. */}
        <AnimatePresence>
          {current && (
            <motion.div
              key={current.qid}
              className="absolute inset-0 overflow-hidden"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 1.4, ease: "easeInOut" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={current.coverUrl}
                alt=""
                draggable={false}
                className="absolute inset-0 h-full w-full scale-150 object-cover opacity-70 blur-[70px] saturate-[1.6]"
              />
              <div
                className="aurora aurora-a"
                style={{ background: accent, animationPlayState: isPlaying ? "running" : "paused" }}
              />
              <div
                className="aurora aurora-b"
                style={{
                  background: `hsl(${(Number(/hsl\((\d+)/.exec(palette.a)?.[1] ?? 24) + 48) % 360} 90% 60%)`,
                  animationPlayState: isPlaying ? "running" : "paused",
                }}
              />
              <div className="absolute inset-0 bg-[#060409]/50" />
            </motion.div>
          )}
        </AnimatePresence>

        {/* The glow behind the centre: white when idle, tinted by the current song when playing. */}
        <AnimatePresence>
          <motion.div
            key={glow}
            className="absolute left-1/2 top-[40%] aspect-square w-[min(120vw,900px)] -translate-x-1/2 -translate-y-1/2 rounded-full"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0 : 1.2, ease: "easeInOut" }}
            style={{
              background: `radial-gradient(closest-side, color-mix(in srgb, ${glow} ${current ? 42 : 28}%, transparent) 0%, color-mix(in srgb, ${glow} 14%, transparent) 55%, transparent 100%)`,
              filter: "blur(24px)",
            }}
          />
        </AnimatePresence>

        {/* RUSTIFY wordmark: shown while idle, fades out when the cards take the centre. */}
        <motion.div
          aria-hidden
          className="absolute inset-x-0 top-[36%] flex -translate-y-1/2 select-none flex-col items-center gap-3"
          initial={false}
          animate={{ opacity: current ? 0 : 1 }}
          transition={{ duration: reduceMotion ? 0 : 0.8, ease: "easeInOut" }}
        >
          <h1
            className="flex text-white"
            style={{
              fontFamily: "var(--font-wordmark), 'Arial Rounded MT Bold', 'Arial Black', sans-serif",
              fontSize: "clamp(64px, 21vw, 190px)",
              lineHeight: 0.95,
              letterSpacing: "-0.01em",
              textShadow: "0 0 22px rgba(255,255,255,0.55), 0 0 64px rgba(255,255,255,0.28)",
            }}
          >
            {Array.from("RUSTIFY").map((ch, i) => (
              <span
                key={i}
                className="inline-block"
                style={{
                  transform: `translateY(${[0, -0.04, 0.03, -0.03, 0.04, -0.02, 0.02][i]}em) rotate(${[-4, 3, -3, 4, -2, 3, -3][i]}deg)`,
                }}
              >
                {ch}
              </span>
            ))}
          </h1>
          <p className="font-display text-[clamp(14px,2.6vw,20px)] font-medium tracking-wide text-white/75">
            Pick a song. Watch it move.
          </p>
        </motion.div>

        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(0,0,0,0.55) 100%)",
          }}
        />
        <div className="grain absolute inset-0 opacity-[0.07] mix-blend-overlay" />
      </div>

      <audio ref={keepAliveRef} className="hidden" aria-hidden />

      {/* ---------- Hidden YouTube audio engine ---------- */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 h-px w-px overflow-hidden opacity-0"
      >
        <YouTube
          opts={{
            width: "1",
            height: "1",
            playerVars: {
              autoplay: 0,
              controls: 0,
              disablekb: 1,
              fs: 0,
              playsinline: 1,
              rel: 0,
              modestbranding: 1,
            },
          }}
          onReady={(e: YouTubeEvent) => {
            playerRef.current = e.target;
            setPlayerReady(true);
          }}
          onStateChange={(e: YouTubeEvent<number>) => {
            if (e.data === 1) {
              userPausedRef.current = false;
              interruptedRef.current = false;
              intentRef.current = true;
              setIsPlaying(true);
            } else if (e.data === 2 && !scrubbingRef.current) {
              // App is in the background and the user didn't pause: the browser did. Try to resume,
              // and if it won't, show the truthful "paused" state and resume when the user returns.
              if (document.hidden && intentRef.current && !userPausedRef.current) {
                const player = e.target;
                player.playVideo();
                window.setTimeout(async () => {
                  const st = await Promise.resolve(player.getPlayerState());
                  if (st !== 1 && !userPausedRef.current) {
                    interruptedRef.current = true;
                    intentRef.current = false;
                    setIsPlaying(false);
                  }
                }, 1500);
                return;
              }
              intentRef.current = false;
              setIsPlaying(false);
            }
          }}
          onEnd={handleEnded}
          onError={handleError}
        />
      </div>

      {/* ---------- Brand mark (wide screens) ---------- */}
      <div className="pointer-events-none absolute left-6 top-[max(1rem,env(safe-area-inset-top))] z-40 hidden h-[46px] items-center gap-2.5 lg:flex">
        <span
          className="grid h-10 w-10 place-items-center rounded-2xl text-neutral-950 shadow-lg"
          style={{ background: `linear-gradient(135deg, #fff, color-mix(in srgb, ${accent} 45%, white))` }}
        >
          <Disc3 size={22} className={isPlaying && !reduceMotion ? "animate-[spin_3s_linear_infinite]" : ""} />
        </span>
        <span className="font-display text-xl font-bold tracking-tight">Rustify</span>
      </div>

      {/* ---------- Top bar: search + library ---------- */}
      <div className="absolute inset-x-0 top-0 z-40 mx-auto flex w-full max-w-xl items-start gap-2 px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <SearchBar
          playlists={playlists}
          onPlayNow={playNow}
          onAddToQueue={addToQueue}
          onSaveToPlaylist={saveToPlaylist}
          onCreatePlaylistAndSave={createPlaylistAndSave}
        />
        <button
          type="button"
          aria-label="Open playlists"
          title="Playlists"
          onClick={() => setDrawer("playlists")}
          className="grid h-[46px] w-[46px] shrink-0 place-items-center rounded-full border border-white/[0.12] bg-white/[0.07] shadow-[0_8px_30px_-10px_rgba(0,0,0,0.7),inset_0_1px_0_rgba(255,255,255,0.1)] backdrop-blur-2xl transition hover:bg-white/[0.14] active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
        >
          <Library size={19} />
        </button>
      </div>

      {/* ---------- Cover-flow ---------- */}
      <div
        ref={stageRef}
        className="relative z-10 flex min-h-0 flex-1 items-center justify-center pb-2 pt-[calc(env(safe-area-inset-top)+4.75rem)] [@media(max-height:480px)]:pt-[calc(env(safe-area-inset-top)+3.75rem)]"
      >
        {!stageReady ? null : queue.length === 0 ? (
          <div className="mx-auto flex max-w-xs flex-col items-center gap-3 self-end px-6 pb-1 text-center">
            <motion.div
              className="grid h-16 w-16 place-items-center rounded-3xl border border-white/20 bg-white/10 backdrop-blur-xl"
              animate={reduceMotion ? undefined : { y: [0, -7, 0], rotate: [-4, 4, -4] }}
              transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
            >
              <ListMusic size={28} className="text-white/85" />
            </motion.div>
            <div>
              <p className="font-display text-xl font-bold tracking-tight">Nothing on deck yet</p>
              <p className="mt-1 text-sm text-white/65">
                Search for a song above, or let us spin up a starter mix.
              </p>
            </div>
            <button
              type="button"
              onClick={loadStarter}
              disabled={starterLoading}
              className="flex items-center gap-2 rounded-full bg-white px-6 py-3 text-sm font-semibold text-neutral-900 shadow-[0_12px_32px_-10px_rgba(255,255,255,0.55)] transition hover:scale-[1.04] active:scale-95 disabled:opacity-60"
            >
              {starterLoading && <Loader2 size={16} className="animate-spin" />}
              Spin up a starter mix
            </button>
          </div>
        ) : (
          <motion.div
            className="relative w-full"
            style={{ height: cardH + 24, perspective: 1400, touchAction: "pan-y" }}
            onPanStart={() => {
              swipedRef.current = false;
            }}
            onPan={(_, info) => {
              if (Math.abs(info.offset.x) > 8) swipedRef.current = true;
            }}
            onPanEnd={(_, info) => {
              if (info.offset.x < -50 || info.velocity.x < -500) next();
              else if (info.offset.x > 50 || info.velocity.x > 500) prev();
              window.setTimeout(() => {
                swipedRef.current = false;
              }, 80);
            }}
          >
            <AnimatePresence initial={false}>
              {visible.map(({ offset, track }) => {
                const abs = Math.abs(offset);
                const isCenter = offset === 0;
                const isExit = abs >= 3;
                const to = slot(offset);
                const from = isCenter ? { ...to, scale: 0.8 } : slot(offset + Math.sign(offset));
                return (
                  <motion.div
                    key={track.qid}
                    role={isExit ? undefined : "button"}
                    tabIndex={isExit ? -1 : 0}
                    aria-hidden={isExit || undefined}
                    aria-label={
                      isCenter
                        ? `${isPlaying ? "Pause" : "Play"} ${track.title} by ${track.artist}`
                        : `Jump to ${track.title} by ${track.artist}`
                    }
                    onClick={() => {
                      if (swipedRef.current || isExit) return;
                      if (isCenter) togglePlay();
                      else playIndex(currentIndex + offset);
                    }}
                    onKeyDown={(e) => {
                      if (isExit) return;
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        if (isCenter) togglePlay();
                        else playIndex(currentIndex + offset);
                      }
                    }}
                    className="group absolute left-1/2 top-1/2 transform-gpu cursor-pointer select-none overflow-hidden rounded-[26px] border border-white/[0.16] bg-neutral-900/60 shadow-[0_40px_80px_-30px_rgba(0,0,0,0.9)] ring-1 ring-inset ring-white/[0.06] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                    onPointerMove={
                      isCenter
                        ? (e) => {
                            const r = e.currentTarget.getBoundingClientRect();
                            e.currentTarget.style.setProperty("--mx", `${((e.clientX - r.left) / r.width) * 100}%`);
                            e.currentTarget.style.setProperty("--my", `${((e.clientY - r.top) / r.height) * 100}%`);
                          }
                        : undefined
                    }
                    style={{
                      width: cardW,
                      height: cardH,
                      marginLeft: -cardW / 2,
                      marginTop: -cardH / 2,
                      zIndex: isExit ? 20 : 10 - abs, // exit ghosts pass in front, like they're past the lens
                      pointerEvents: isExit ? "none" : undefined,
                      boxShadow: isCenter
                        ? `0 44px 90px -32px color-mix(in srgb, ${accent} 60%, transparent), 0 0 0 1px rgba(255,255,255,0.06)`
                        : undefined,
                      willChange: "transform, opacity, filter",
                      isolation: "isolate",
                      backfaceVisibility: "hidden",
                      WebkitBackfaceVisibility: "hidden",
                    }}
                    initial={{ ...from, opacity: 0 }}
                    animate={to}
                    exit={{ ...(isCenter ? { ...to, scale: 0.6 } : slot(offset + Math.sign(offset))), opacity: 0 }}
                    transition={cardSpring}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={track.coverUrl}
                      alt={`${track.title} cover art`}
                      draggable={false}
                      className="block w-full object-cover"
                      style={{ height: cardW }}
                    />
                    {isCenter && (
                      <>
                        <div
                          aria-hidden
                          className="pointer-events-none absolute inset-x-0 top-0 opacity-0 transition-opacity duration-300 group-hover:opacity-100"
                          style={{
                            height: cardW,
                            background:
                              "radial-gradient(circle at var(--mx, 50%) var(--my, 30%), rgba(255,255,255,0.28), transparent 46%)",
                          }}
                        />
                        <div
                          aria-hidden
                          className="pointer-events-none absolute inset-x-0 top-0 bg-gradient-to-t from-black/55 via-transparent to-black/25"
                          style={{ height: cardW }}
                        />
                        <div
                          aria-hidden
                          className="pointer-events-none absolute left-3 top-3 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 backdrop-blur-md"
                        >
                          <Equalizer active={isPlaying} />
                          <span className="text-[11px] font-semibold tracking-wide">
                            {isPlaying ? "Now playing" : "Paused"}
                          </span>
                        </div>
                        {isLiked && (
                          <div
                            aria-hidden
                            className="pointer-events-none absolute right-3 top-3 grid h-8 w-8 place-items-center rounded-full bg-black/50 backdrop-blur-md"
                          >
                            <Heart size={15} className="fill-[#ff4d6d] text-[#ff4d6d]" />
                          </div>
                        )}
                        <div
                          aria-hidden
                          className={`pointer-events-none absolute right-3 grid h-12 w-12 place-items-center rounded-full bg-white text-neutral-950 shadow-[0_10px_30px_-8px_rgba(0,0,0,0.7)] transition duration-300 ${
                            isPlaying ? "scale-75 opacity-0 group-hover:scale-100 group-hover:opacity-100" : "scale-100 opacity-100"
                          }`}
                          style={{ top: cardW - 60 }}
                        >
                          {isPlaying ? (
                            <Pause size={20} className="fill-current" />
                          ) : (
                            <Play size={20} className="ml-0.5 fill-current" />
                          )}
                        </div>
                      </>
                    )}
                    {abs >= 2 &&
                      (
                        [
                          ["#f00", -1],
                          ["#0ff", 1],
                        ] as const
                      ).map(([tint, dir]) => (
                        <motion.div
                          key={tint}
                          aria-hidden
                          className="pointer-events-none absolute inset-x-0 top-0 isolate overflow-hidden"
                          style={{ height: cardW, mixBlendMode: "screen" }}
                          initial={false}
                          animate={{ x: dir * shiftAt(abs), opacity: ghostAt(abs) }}
                          transition={cardSpring}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={track.coverUrl} alt="" draggable={false} className="block h-full w-full object-cover" />
                          <div className="absolute inset-0" style={{ background: tint, mixBlendMode: "multiply" }} />
                        </motion.div>
                      ))}
                    <div
                      className="flex flex-col justify-center border-t border-white/[0.08] bg-neutral-950/70 px-3 sm:px-4"
                      style={{ height: strip }}
                    >
                      <p className="font-display truncate text-base font-bold leading-tight tracking-tight text-white">
                        {track.title}
                      </p>
                      <p className="mt-0.5 truncate text-sm text-white/60">{track.artist}</p>
                    </div>
                    {!isCenter && !isExit && (
                      <div
                        className="pointer-events-none absolute inset-0 bg-black"
                        style={{ opacity: abs * 0.16 }}
                      />
                    )}
                    {abs >= 2 && (
                      <motion.div
                        aria-hidden
                        className="pointer-events-none absolute inset-0"
                        style={{
                          background:
                            "linear-gradient(135deg, rgba(255,255,255,0.34) 0%, rgba(255,255,255,0.04) 45%, rgba(255,255,255,0.2) 100%)",
                        }}
                        initial={false}
                        animate={{ opacity: ghostAt(abs) }}
                        transition={cardSpring}
                      />
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </motion.div>
        )}
      </div>

      {/* ---------- Control pill ---------- */}
      <div className="relative z-30 mx-auto w-full min-w-0 max-w-3xl px-3 pb-[max(1rem,env(safe-area-inset-bottom))] sm:px-6 sm:pb-8">
        <AnimatePresence>
          {lyricsOpen && current && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.18 }}
              className={`absolute bottom-full left-3 right-3 mb-3 mx-auto max-w-md p-4 ${GLASS_POPOVER}`}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-base font-semibold tracking-tight">{current.title}</p>
                  <p className="truncate text-sm text-white/60">{current.artist}</p>
                </div>
                <button
                  type="button"
                  aria-label="Close lyrics panel"
                  onClick={() => setLyricsOpen(false)}
                  className="text-white/60 hover:text-white"
                >
                  <X size={18} />
                </button>
              </div>
              <p className="mt-3 text-sm text-white/70">
                Lyrics are licensed content, so they aren’t stored in this player. Open them on
                Genius in a new tab.
              </p>
              <a
                href={`https://genius.com/search?q=${encodeURIComponent(`${current.artist} ${current.title}`)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-2 rounded-full bg-white/15 px-4 py-2 text-sm font-medium hover:bg-white/25"
              >
                Find lyrics on Genius <ExternalLink size={14} />
              </a>
            </motion.div>
          )}
        </AnimatePresence>

        <div
          className="flex min-w-0 max-w-full flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-[30px] border border-white/[0.14] bg-[#0b0a10]/55 p-2.5 backdrop-blur-3xl backdrop-saturate-150 sm:flex-nowrap sm:rounded-full sm:px-5 sm:py-2.5"
          style={{
            boxShadow: `0 30px 80px -24px rgba(0,0,0,0.95), 0 0 70px -34px ${accent}, inset 0 1px 0 rgba(255,255,255,0.14)`,
          }}
        >
          {/* Left transport */}
          <div className="order-2 flex items-center gap-1 sm:order-1">
            <IconBtn label="Previous" onClick={prev}>
              <Rewind size={22} className="fill-current" />
            </IconBtn>
            <button
              type="button"
              aria-label={isPlaying ? "Pause" : "Play"}
              onClick={togglePlay}
              className="relative grid h-[52px] w-[52px] shrink-0 place-items-center rounded-full text-neutral-950 transition duration-200 hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70 active:scale-90"
              style={{
                background: `linear-gradient(135deg, #ffffff 0%, color-mix(in srgb, ${accent} 40%, white) 100%)`,
                boxShadow: `0 10px 30px -8px ${accent}`,
              }}
            >
              {isPlaying && !reduceMotion && (
                <motion.span
                  aria-hidden
                  className="pointer-events-none absolute inset-0 rounded-full"
                  style={{ boxShadow: `0 0 0 2px ${accent}` }}
                  animate={{ scale: [1, 1.55], opacity: [0.7, 0] }}
                  transition={{ duration: 1.4, repeat: Infinity, ease: "easeOut" }}
                />
              )}
              {isPlaying ? (
                <Pause size={22} className="fill-current" />
              ) : (
                <Play size={22} className="ml-0.5 fill-current" />
              )}
            </button>
            <IconBtn label="Next" onClick={next}>
              <FastForward size={22} className="fill-current" />
            </IconBtn>
          </div>

          {/* Center mini-player capsule */}
          <div
            ref={menuRef}
            className="relative order-1 w-full min-w-0 max-w-full basis-full rounded-[22px] bg-black/35 px-3 pb-1.5 pt-2.5 ring-1 ring-inset ring-white/[0.1] sm:order-2 sm:w-auto sm:basis-auto sm:flex-1 sm:max-w-md"
          >
            <div className="flex items-center gap-3">
              {current ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={current.coverUrl}
                  alt=""
                  className="h-11 w-11 shrink-0 rounded-xl object-cover shadow-lg"
                  draggable={false}
                />
              ) : (
                <div className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-white/10">
                  <ListMusic size={16} className="text-white/50" />
                </div>
              )}
              <div className="min-w-0 flex-1 overflow-hidden">
                <MarqueeText
                  text={current?.title ?? "Nothing playing"}
                  className="font-display text-sm font-bold leading-tight"
                />
                <p className="truncate text-xs text-white/55">
                  {current?.artist ?? "Search for a song to begin"}
                </p>
              </div>
              <Equalizer active={isPlaying} />
              <button
                type="button"
                aria-label={isLiked ? "Remove from liked songs" : "Like this song"}
                aria-pressed={isLiked}
                title={isLiked ? "Liked" : "Like"}
                disabled={!current}
                onClick={toggleLike}
                className="relative grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/50 transition hover:text-white active:scale-75 disabled:opacity-40"
              >
                <motion.span
                  key={isLiked ? "on" : "off"}
                  initial={isLiked && !reduceMotion ? { scale: 0.4 } : false}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 500, damping: 12 }}
                  className="grid place-items-center"
                >
                  <Heart size={18} className={isLiked ? "fill-[#ff4d6d] text-[#ff4d6d]" : ""} />
                </motion.span>
                {burst !== null && !reduceMotion &&
                  Array.from({ length: 8 }).map((_, i) => {
                    const a = (i / 8) * Math.PI * 2;
                    return (
                      <motion.span
                        key={`${burst}-${i}`}
                        aria-hidden
                        className="pointer-events-none absolute left-1/2 top-1/2 h-1.5 w-1.5 rounded-full"
                        style={{ background: i % 2 ? "#ffb547" : "#ff4d6d" }}
                        initial={{ x: -3, y: -3, scale: 0, opacity: 1 }}
                        animate={{ x: Math.cos(a) * 24 - 3, y: Math.sin(a) * 24 - 3, scale: [0, 1.2, 0], opacity: [1, 1, 0] }}
                        transition={{ duration: 0.7, ease: "easeOut" }}
                      />
                    );
                  })}
              </button>
              <button
                type="button"
                onClick={cycleRepeat}
                aria-label={`Repeat: ${
                  repeat === "off"
                    ? "off"
                    : repeat === "track"
                      ? "this song"
                      : repeat === "queue"
                        ? "whole queue"
                        : "playlist"
                }`}
                title="Repeat"
                className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-full transition active:scale-90 ${
                  repeat === "off" ? "text-white/45 hover:text-white/80" : "bg-white/10"
                }`}
                style={repeat === "off" ? undefined : { color: accent }}
              >
                {repeat === "track" ? (
                  <Repeat1 size={18} />
                ) : repeat === "playlist" ? (
                  <PlaylistLoopIcon size={18} />
                ) : (
                  <Repeat size={18} />
                )}
                {repeat === "queue" && (
                  <span className="absolute -bottom-0.5 -right-1 rounded bg-white px-[3px] text-[7px] font-bold leading-[10px] text-neutral-950">
                    ALL
                  </span>
                )}
              </button>
              <button
                type="button"
                aria-label="Track actions"
                aria-expanded={menuOpen}
                disabled={!current}
                onClick={() => {
                  setMenuOpen((v) => !v);
                  setMenuView("main");
                }}
                className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-white/80 hover:bg-white/15 disabled:opacity-40"
              >
                <MoreHorizontal size={18} />
              </button>
            </div>

            <ProgressSection
              playerRef={playerRef}
              ready={playerReady}
              playing={isPlaying}
              accent={accent}
              trackKey={current?.qid ?? "none"}
              fallbackDuration={current?.duration ?? 0}
              progressRef={progressRef}
              scrubbingRef={scrubbingRef}
            />

            <AnimatePresence>
              {menuOpen && current && (
                <motion.div
                  initial={{ opacity: 0, y: 6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 6, scale: 0.97 }}
                  transition={{ duration: 0.14 }}
                  className={`absolute bottom-full right-0 z-20 mb-2 ${GLASS_POPOVER}`}
                >
                  {menuView === "main" ? (
                    <ul className="w-56 p-1.5 text-sm">
                      <li>
                        <button
                          type="button"
                          onClick={() => setMenuView("playlists")}
                          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left hover:bg-white/10"
                        >
                          <BookmarkPlus size={16} /> Add to Playlist
                        </button>
                      </li>
                      <li>
                        <button
                          type="button"
                          onClick={() => {
                            removeFromQueue(current.qid);
                            setMenuOpen(false);
                          }}
                          className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-red-300 hover:bg-white/10"
                        >
                          <Trash2 size={16} /> Remove from Queue
                        </button>
                      </li>
                    </ul>
                  ) : (
                    <PlaylistPicker
                      playlists={playlists}
                      onPick={(id) => {
                        saveToPlaylist(id, current);
                        setMenuOpen(false);
                      }}
                      onCreate={(name) => {
                        createPlaylistAndSave(name, current);
                        setMenuOpen(false);
                      }}
                    />
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Right controls */}
          <div className="order-3 flex items-center gap-0.5">
            <IconBtn
              label="Lyrics"
              active={lyricsOpen}
              onClick={() => setLyricsOpen((v) => !v)}
            >
              <MessageSquareQuote size={20} />
            </IconBtn>
            <IconBtn
              label="Queue"
              active={drawer === "queue"}
              onClick={() => setDrawer(drawer === "queue" ? null : "queue")}
            >
              <ListMusic size={20} />
            </IconBtn>
            <div ref={volumeRef} className="relative">
              <IconBtn label="Volume" active={volumeOpen} onClick={() => setVolumeOpen((v) => !v)}>
                <VolumeIcon size={20} />
              </IconBtn>
              <AnimatePresence>
                {volumeOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 6 }}
                    transition={{ duration: 0.14 }}
                    className={`absolute bottom-full right-0 z-20 mb-3 flex w-52 items-center gap-2 p-2.5 ${GLASS_POPOVER}`}
                  >
                    <button
                      type="button"
                      aria-label={muted ? "Unmute" : "Mute"}
                      onClick={() => setMuted((m) => !m)}
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full hover:bg-white/15"
                    >
                      <VolumeIcon size={18} />
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={muted ? 0 : volume}
                      aria-label="Volume"
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        setVolume(v);
                        setMuted(v === 0);
                      }}
                      className="h-1 flex-1 cursor-pointer accent-white"
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>

      {/* ---------- Toast ---------- */}
      <AnimatePresence>
        {toast && (
          <motion.div
            role="status"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            className="pointer-events-none absolute bottom-[calc(env(safe-area-inset-bottom)+11rem)] left-1/2 z-50 flex max-w-[90vw] -translate-x-1/2 items-center gap-2 rounded-full border border-white/[0.12] bg-neutral-950/85 px-4 py-2.5 text-sm font-medium shadow-[0_16px_40px_-12px_rgba(0,0,0,0.8)] backdrop-blur-2xl sm:bottom-32"
          >
            <Check size={15} className="shrink-0" style={{ color: accent }} />
            <span className="truncate">{toast}</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ---------- Queue / playlist drawer ---------- */}
      <AnimatePresence>
        {drawer && (
          <motion.div
            key="drawer"
            className="absolute inset-0 z-50"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className="absolute inset-0 bg-black/35" onClick={() => setDrawer(null)} />
            <motion.aside
              role="dialog"
              aria-label={drawer === "queue" ? "Queue" : "Playlists"}
              className={
                isMobile
                  ? "absolute inset-x-0 bottom-0 flex h-[82dvh] flex-col rounded-t-3xl border-t border-white/15 bg-neutral-950/75 pb-[env(safe-area-inset-bottom)] backdrop-blur-2xl"
                  : "absolute right-0 top-0 flex h-full w-96 flex-col border-l border-white/15 bg-neutral-950/55 backdrop-blur-2xl"
              }
              initial={isMobile ? { y: "100%" } : { x: "100%" }}
              animate={isMobile ? { y: 0 } : { x: 0 }}
              exit={isMobile ? { y: "100%" } : { x: "100%" }}
              transition={spring}
              drag={isMobile ? "y" : false}
              dragControls={sheetControls}
              dragListener={false}
              dragConstraints={{ top: 0, bottom: 0 }}
              dragElastic={{ top: 0, bottom: 0.5 }}
              onDragEnd={(_, info) => {
                if (isMobile && (info.offset.y > 120 || info.velocity.y > 600)) setDrawer(null);
              }}
            >
              {isMobile && (
                <div
                  onPointerDown={(e) => sheetControls.start(e)}
                  className="flex shrink-0 touch-none justify-center pb-1 pt-3"
                  aria-hidden
                >
                  <span className="h-1.5 w-10 rounded-full bg-white/30" />
                </div>
              )}
              <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
                <div className="flex rounded-full bg-white/10 p-1 text-sm">
                  {(["queue", "playlists"] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => setDrawer(tab)}
                      className={`font-display rounded-full px-4 py-1.5 font-semibold transition ${
                        drawer === tab ? "bg-white text-neutral-900" : "text-white/70 hover:text-white"
                      }`}
                    >
                      {tab === "queue" ? `Queue (${queue.length})` : `Playlists (${playlists.length})`}
                    </button>
                  ))}
                </div>
                <IconBtn label="Close drawer" onClick={() => setDrawer(null)}>
                  <X size={20} />
                </IconBtn>
              </div>

              {drawer === "queue" ? (
                <>
                  <div className="min-h-0 flex-1 overscroll-contain overflow-y-auto px-2 pb-4">
                    {queue.length === 0 ? (
                      <p className="px-4 py-10 text-center text-sm text-white/55">
                        Nothing queued. Search for a song and choose Add to Queue.
                      </p>
                    ) : (
                      <Reorder.Group
                        axis="y"
                        values={queue}
                        onReorder={reorderQueue}
                        className="flex flex-col gap-0.5"
                      >
                        {queue.map((t, i) => (
                          <QueueRow
                            key={t.qid}
                            track={t}
                            active={i === currentIndex}
                            playing={isPlaying}
                            onPlay={() => playIndex(i)}
                            onRemove={() => removeFromQueue(t.qid)}
                          />
                        ))}
                      </Reorder.Group>
                    )}
                  </div>
                  {queue.length > 0 && (
                    <div className="border-t border-white/10 p-3">
                      <button
                        type="button"
                        onClick={clearQueue}
                        className="w-full rounded-full bg-white/10 py-2.5 text-sm font-medium text-white/80 hover:bg-white/20"
                      >
                        Clear queue
                      </button>
                    </div>
                  )}
                </>
              ) : (
                <div className="flex flex-1 flex-col overflow-hidden">
                  <div className="flex items-center gap-2 px-4 pb-3">
                    <input
                      value={newPlaylistName}
                      onChange={(e) => setNewPlaylistName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && newPlaylistName.trim()) {
                          createPlaylist(newPlaylistName.trim());
                          setNewPlaylistName("");
                        }
                      }}
                      maxLength={40}
                      placeholder="New playlist name"
                      aria-label="New playlist name"
                      className="min-w-0 flex-1 rounded-full bg-white/10 px-4 py-2 text-base placeholder:text-white/40 sm:text-sm focus:outline-none focus:ring-1 focus:ring-white/50"
                    />
                    <button
                      type="button"
                      onClick={() => {
                        const n = newPlaylistName.trim();
                        if (!n) return;
                        createPlaylist(n);
                        setNewPlaylistName("");
                      }}
                      className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-white/90"
                    >
                      Create
                    </button>
                  </div>

                  <div className="flex items-center gap-2 px-4 pb-3">
                    <input
                      value={importUrl}
                      onChange={(e) => setImportUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") void importPlaylist();
                      }}
                      disabled={!!importing}
                      inputMode="url"
                      autoCapitalize="none"
                      autoCorrect="off"
                      placeholder="Paste playlist link"
                      aria-label="Playlist link to import"
                      className="min-w-0 flex-1 rounded-full bg-white/10 px-4 py-2 text-base placeholder:text-white/40 disabled:opacity-60 sm:text-sm focus:outline-none focus:ring-1 focus:ring-white/50"
                    />
                    <button
                      type="button"
                      onClick={() => void importPlaylist()}
                      disabled={!importUrl.trim() || !!importing}
                      className="flex shrink-0 items-center gap-1.5 rounded-full bg-white/15 px-4 py-2 text-sm font-semibold text-white hover:bg-white/25 disabled:opacity-50"
                    >
                      {importing ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}
                      {importing && importing.total > 0 ? `${importing.done}/${importing.total}` : "Import"}
                    </button>
                  </div>

                  <ul className="min-h-0 flex-1 space-y-2 overscroll-contain overflow-y-auto px-3 pb-4">
                    {playlists.length === 0 && (
                      <li className="px-2 py-10 text-center text-sm text-white/55">
                        No playlists yet. Name one above, import a link, or save songs from search or the track menu.
                      </li>
                    )}
                    {playlists.map((pl) => {
                      const expanded = openPlaylistId === pl.id;
                      return (
                        <li key={pl.id} className="rounded-2xl bg-white/[0.06] ring-1 ring-inset ring-white/[0.06]">
                          <div className="flex items-center gap-1 p-2">
                            <button
                              type="button"
                              aria-expanded={expanded}
                              onClick={() => setOpenPlaylistId(expanded ? null : pl.id)}
                              className="flex min-w-0 flex-1 items-center gap-3 rounded-lg p-1 text-left hover:bg-white/5"
                            >
                              {pl.tracks.length >= 4 ? (
                                <div className="grid h-12 w-12 shrink-0 grid-cols-2 gap-px overflow-hidden rounded-lg bg-black/40">
                                  {pl.tracks.slice(0, 4).map((t) => (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img key={t.id} src={t.coverUrl} alt="" className="h-full w-full object-cover" draggable={false} />
                                  ))}
                                </div>
                              ) : pl.tracks[0] ? (
                                // eslint-disable-next-line @next/next/no-img-element
                                <img
                                  src={pl.tracks[0].coverUrl}
                                  alt=""
                                  className="h-12 w-12 shrink-0 rounded-lg object-cover"
                                  draggable={false}
                                />
                              ) : (
                                <div className="grid h-12 w-12 shrink-0 place-items-center rounded-lg bg-white/10">
                                  <ListMusic size={18} className="text-white/50" />
                                </div>
                              )}
                              <span className="min-w-0">
                                <span className="font-display block truncate text-sm font-bold">{pl.name}</span>
                                <span className="block text-xs text-white/55">
                                  {pl.tracks.length} {pl.tracks.length === 1 ? "song" : "songs"}
                                </span>
                              </span>
                            </button>
                            <IconBtn label={`Play ${pl.name}`} className="!h-9 !w-9" onClick={() => playPlaylist(pl)}>
                              <Play size={16} className="fill-current" />
                            </IconBtn>
                            <IconBtn label={`Queue ${pl.name}`} className="!h-9 !w-9" onClick={() => queuePlaylist(pl)}>
                              <ListPlus size={17} />
                            </IconBtn>
                            <IconBtn label={`Delete ${pl.name}`} className="!h-9 !w-9" onClick={() => deletePlaylist(pl.id)}>
                              <Trash2 size={16} />
                            </IconBtn>
                          </div>

                          {expanded && (
                            <ul className="border-t border-white/10 p-1.5">
                              {pl.tracks.length === 0 && (
                                <li className="px-3 py-3 text-xs text-white/50">This playlist is empty.</li>
                              )}
                              {pl.tracks.map((t) => (
                                <li key={t.id} className="flex items-center gap-2 rounded-lg p-1.5 hover:bg-white/10">
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src={t.coverUrl} alt="" className="h-9 w-9 shrink-0 rounded object-cover" draggable={false} />
                                  <div className="min-w-0 flex-1">
                                    <p className="truncate text-[13px] font-medium">{t.title}</p>
                                    <p className="truncate text-xs text-white/55">{t.artist}</p>
                                  </div>
                                  <IconBtn label="Play now" className="!h-8 !w-8" onClick={() => playNow(t)}>
                                    <Play size={14} className="fill-current" />
                                  </IconBtn>
                                  <IconBtn label="Add to queue" className="!h-8 !w-8" onClick={() => addToQueue(t)}>
                                    <ListPlus size={15} />
                                  </IconBtn>
                                  <IconBtn
                                    label="Remove from playlist"
                                    className="!h-8 !w-8"
                                    onClick={() => removeFromPlaylist(pl.id, t.id)}
                                  >
                                    <X size={14} />
                                  </IconBtn>
                                </li>
                              ))}
                            </ul>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
            </motion.aside>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}
