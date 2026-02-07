'use client';

import React, { createContext, useContext, useState, useEffect } from 'react';

type Mode = 'human' | 'machine';

interface MachineModeContextType {
    mode: Mode;
    setMode: (mode: Mode) => void;
    isBooting: boolean;
    setIsBooting: (isBooting: boolean) => void;
}

const MachineModeContext = createContext<MachineModeContextType | undefined>(undefined);

export function MachineModeProvider({ children }: { children: React.ReactNode }) {
    const [mode, setMode] = useState<Mode>('human');
    const [isBooting, setIsBooting] = useState(false);

    // Persist mode in local storage
    useEffect(() => {
        const savedMode = localStorage.getItem('axis-mode') as Mode;
        if (savedMode) {
            setTimeout(() => setMode(savedMode), 0);
        }
    }, []);

    const handleSetMode = (newMode: Mode) => {
        setMode(newMode);
        localStorage.setItem('axis-mode', newMode);
    };

    return (
        <MachineModeContext.Provider value={{ mode, setMode: handleSetMode, isBooting, setIsBooting }}>
            {children}
        </MachineModeContext.Provider>
    );
}

export function useMachineMode() {
    const context = useContext(MachineModeContext);
    if (!context) {
        throw new Error('useMachineMode must be used within a MachineModeProvider');
    }
    return context;
}
