'use client';

import { usePathname } from 'next/navigation';
import { useMachineMode } from '@/context/MachineModeContext';
import { AnimatePresence } from 'framer-motion';
import BootAnimation from './BootAnimation';

export default function MachineToggle() {
    const pathname = usePathname();
    const { mode, setMode, isBooting, setIsBooting } = useMachineMode();

    if (pathname !== '/') return null;

    const handleToggle = () => {
        if (mode === 'human') {
            setIsBooting(true);
        } else {
            setMode('human');
        }
    };

    const handleBootComplete = () => {
        setMode('machine');
        setIsBooting(false);
    };

    return (
        <>
            <AnimatePresence>
                {isBooting && <BootAnimation onComplete={handleBootComplete} />}
            </AnimatePresence>

            <div className="fixed bottom-12 left-1/2 -translate-x-1/2 z-[60] flex items-center bg-black/40 backdrop-blur-md border border-white/10 p-1 rounded-sm text-[10px] font-mono tracking-widest uppercase">
                <button
                    onClick={() => setMode('human')}
                    className={`px-4 py-2 flex items-center gap-2 transition-all ${mode === 'human' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/60'}`}
                >
                    <div className={`w-1.5 h-1.5 rounded-full ${mode === 'human' ? 'bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]' : 'border border-white/40'}`} />
                    human
                </button>
                <div className="w-[1px] h-3 bg-white/10 mx-1" />
                <button
                    onClick={handleToggle}
                    className={`px-4 py-2 flex items-center gap-2 transition-all ${mode === 'machine' ? 'bg-white/10 text-white' : 'text-white/40 hover:text-white/60'}`}
                >
                    <div className={`w-1.5 h-1.5 rounded-full ${mode === 'machine' ? 'bg-white shadow-[0_0_8px_rgba(255,255,255,0.8)]' : 'border border-white/40'}`} />
                    machine
                </button>
            </div>
        </>
    );
}
