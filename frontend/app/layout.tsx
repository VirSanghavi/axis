import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/next";
import "./globals.css";
import Snowflakes from "@/components/Snowflakes";

const inter = Inter({
  variable: "--font-sans",
  subsets: ["latin"],
});

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
});

const siteUrl = "https://useaxis.dev";

export const metadata: Metadata = {
  title: "Axis - Parallel Agent Workflows & Distributed Orchestration",
  description: "The high-performance orchestration layer for parallel AI agent workflows. Coordinate distributed agent swarms with shared memory and atomic task management.",
  icons: {
    icon: "/favicon.ico",
    apple: "/favicon.ico",
  },
  metadataBase: new URL(siteUrl),
  openGraph: {
    title: "Axis - Parallel Agent Workflows",
    description: "Coordinate distributed AI agent swarms with shared memory, file locking, and atomic task management.",
    url: siteUrl,
    siteName: "Axis",
    type: "website",
    locale: "en_US",
    images: [
      {
        url: `${siteUrl}/og.png`,
        width: 1200,
        height: 630,
        alt: "Axis — Parallel Agent Workflows & Distributed Orchestration",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "Axis - Parallel Agent Workflows",
    description: "Coordinate distributed AI agent swarms with shared memory, file locking, and atomic task management.",
    creator: "@VirSanghavi13",
    images: [`${siteUrl}/og.png`],
  },
};

import { MachineModeProvider } from "@/context/MachineModeContext";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="icon" href="/favicon.ico" />
        <link rel="preload" as="image" href="/avalanche.gif" />
        <link rel="preload" as="image" href="/avalanche2.gif" />
      </head>
      <body className={`${inter.variable} ${jetbrainsMono.variable} antialiased min-h-screen bg-[#050505] lowercase`}>
        <MachineModeProvider>
          <Snowflakes />
          {children}
        </MachineModeProvider>
        <Analytics />
      </body>
    </html>
  );
}
