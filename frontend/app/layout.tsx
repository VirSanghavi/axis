import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Axis - Parallel Agent Workflows & Distributed Orchestration",
  description: "The high-performance orchestration layer for parallel AI agent workflows. Coordinate distributed agent swarms with shared memory and atomic task management.",
  icons: {
    icon: "/favicon.ico",
    apple: "/favicon.ico",
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
      </body>
    </html>
  );
}
