import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Inter, Modak } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--font-display", display: "swap" });

const wordmark = Modak({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-wordmark",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Rustify",
  description: "Search any song, queue it, and watch your music move.",
  appleWebApp: { capable: true, title: "Rustify", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#000000",
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${inter.variable} ${wordmark.variable} ${display.variable} font-sans antialiased`}>{children}</body>
    </html>
  );
}
