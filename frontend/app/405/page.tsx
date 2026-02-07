'use client';

import Link from "next/link";
import { motion } from "framer-motion";

export default function Error405() {
    return (
        <div className="relative min-h-screen flex items-center justify-center overflow-hidden">
            {/* Avalanche Background */}
            <div className="bg-avalanche pointer-events-none fixed inset-0 z-0" />

            {/* Modal Overlay */}
            <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                className="relative z-10 glass p-12 rounded-2xl text-center max-w-md w-full mx-6 shadow-2xl border border-white/10"
            >
                <h1 className="text-4xl font-mono mb-8 tracking-tighter text-white">405 method not allowed</h1>
                <Link
                    href="/"
                    className="inline-block bg-white text-black px-8 py-3 rounded text-[10px] font-bold tracking-widest uppercase hover:bg-neutral-200 transition-all"
                >
                    return home
                </Link>
            </motion.div>
        </div>
    );
}
