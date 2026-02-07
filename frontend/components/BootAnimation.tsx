'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';

const BOOT_LOGS = [
    "[ 0.000000] axis: kernel v1.0.0-prod",
    "[ 0.000312] loading context modules...",
    "[ 0.001024] mem: 16384MB available",
    "[ 0.001337] cpu: neural_engine x8 online",
    "[ 0.002048] init: mounting /dev/knowledge",
    "[ 0.002561] init: vector_db connected",
    "[ 0.003072] init: embedding_engine ready",
    "[ 0.003584] ███████████████████████████ 100%",
    "[ 0.004096] axis: machine mode activated",
    "root@axis:~# ./render --mode=machine",
];

export default function BootAnimation({ onComplete }: { onComplete: () => void }) {
    const [lines, setLines] = useState<string[]>([]);

    useEffect(() => {
        let currentLine = 0;
        const interval = setInterval(() => {
            if (currentLine < BOOT_LOGS.length) {
                setLines(prev => [...prev, BOOT_LOGS[currentLine]]);
                currentLine++;
            } else {
                clearInterval(interval);
                setTimeout(onComplete, 500);
            }
        }, 250);

        return () => clearInterval(interval);
    }, [onComplete]);

    return (
        <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-black p-8 font-mono text-[13px] text-white leading-relaxed flex flex-col items-center justify-center overflow-hidden text-center"
        >
            <div className="max-w-xl w-full">
                {lines.map((line, i) => (
                    <div key={i} className="mb-1">
                        {line}
                    </div>
                ))}
                {lines.length === BOOT_LOGS.length && (
                    <motion.span
                        animate={{ opacity: [1, 0] }}
                        transition={{ repeat: Infinity, duration: 0.8 }}
                        className="inline-block w-2 h-4 bg-white align-middle"
                    />
                )}
            </div>
        </motion.div>
    );
}
