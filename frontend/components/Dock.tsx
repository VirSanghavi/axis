'use client';

import { motion, useMotionValue, useSpring, useTransform, AnimatePresence, MotionValue, SpringOptions } from 'framer-motion';
import { Children, cloneElement, useEffect, useRef, useState, ReactElement } from 'react';

import './Dock.css';

interface DockItemProps {
    children: React.ReactNode;
    className?: string;
    onClick?: () => void;
    mouseX: MotionValue<number>;
    spring: SpringOptions;
    distance: number;
    magnification: number;
    baseItemSize: number;
}

function DockItem({
    children,
    className = '',
    onClick,
    mouseX,
    spring,
    distance,
    magnification,
    baseItemSize
}: DockItemProps) {
    const ref = useRef<HTMLDivElement>(null);
    const isHovered = useMotionValue(0);

    // To prevent jitter, we calculate distance relative to a STABLE center.
    // We use a ref to store the initial/stable left position.
    const stableX = useRef<number>(0);

    useEffect(() => {
        const updateStableX = () => {
            if (ref.current) {
                const rect = ref.current.getBoundingClientRect();
                stableX.current = rect.left + rect.width / 2;
            }
        };

        updateStableX();
        window.addEventListener('resize', updateStableX);
        // Also update after a short delay since layout might shift after initial mount
        const timer = setTimeout(updateStableX, 500);

        return () => {
            window.removeEventListener('resize', updateStableX);
            clearTimeout(timer);
        };
    }, []);

    const mouseDistance = useTransform(mouseX, (val) => {
        if (val === Infinity) return Infinity;
        // Use the stableX collected in useEffect to avoid getBoundingClientRect() on every frame
        return val - stableX.current;
    });

    const targetSize = useTransform(
        mouseDistance,
        [-distance, 0, distance],
        [baseItemSize, magnification, baseItemSize]
    );

    const size = useSpring(targetSize, spring);

    return (
        <motion.div
            ref={ref}
            style={{
                width: size,
                height: size
            }}
            onHoverStart={() => isHovered.set(1)}
            onHoverEnd={() => isHovered.set(0)}
            onFocus={() => isHovered.set(1)}
            onBlur={() => isHovered.set(0)}
            onClick={onClick}
            className={`dock-item ${className}`}
            tabIndex={0}
            role="button"
            aria-haspopup="true"
        >
            {Children.map(children, child => {
                if (typeof child === 'object' && child !== null) {
                    return cloneElement(child as ReactElement<{ isHovered: MotionValue<number> }>, { isHovered });
                }
                return child;
            })}
        </motion.div>
    );
}

function DockLabel({ children, className = '', ...rest }: { children: React.ReactNode; className?: string; isHovered?: MotionValue<number> }) {
    const isHovered = rest.isHovered as MotionValue<number>;
    const [isVisible, setIsVisible] = useState(false);

    useEffect(() => {
        if (!isHovered) return;
        const unsubscribe = isHovered.on('change', latest => {
            setIsVisible(latest === 1);
        });
        return () => unsubscribe();
    }, [isHovered]);

    return (
        <AnimatePresence>
            {isVisible && (
                <motion.div
                    initial={{ opacity: 0, y: 5, x: '-50%' }}
                    animate={{ opacity: 1, y: 0, x: '-50%' }}
                    exit={{ opacity: 0, y: 5, x: '-50%' }}
                    transition={{ duration: 0.15, ease: "easeOut" }}
                    className={`dock-label ${className}`}
                    role="tooltip"
                >
                    {children}
                </motion.div>
            )}
        </AnimatePresence>
    );
}

function DockIcon({ children, className = '' }: { children: React.ReactNode; className?: string }) {
    return <div className={`dock-icon ${className}`}>{children}</div>;
}

export interface DockItemConfig {
    icon: React.ReactNode;
    label: string;
    onClick: () => void;
    className?: string;
}

export default function Dock({
    items,
    className = '',
    spring = { mass: 0.1, stiffness: 200, damping: 15 },
    magnification = 84,
    distance = 150,
    panelHeight = 60,
    baseItemSize = 44
}: {
    items: DockItemConfig[];
    className?: string;
    spring?: SpringOptions;
    magnification?: number;
    distance?: number;
    panelHeight?: number;
    baseItemSize?: number;
}) {
    const mouseX = useMotionValue(Infinity);
    const [isMobile, setIsMobile] = useState(false);

    useEffect(() => {
        const checkMobile = () => {
            setIsMobile(window.innerWidth < 768);
        };
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    const effectiveMagnification = isMobile ? baseItemSize : magnification;

    return (
        <div className={`dock-outer ${isMobile ? 'dock-mobile' : 'dock-desktop'}`} onPointerLeave={() => mouseX.set(Infinity)}>
            <motion.div
                onPointerMove={(e) => !isMobile && mouseX.set(e.pageX)}
                className={`dock-panel ${className}`}
                style={{ height: isMobile ? panelHeight - 10 : panelHeight }}
                role="toolbar"
                aria-label="Application dock"
            >
                {items.map((item, index) => (
                    <DockItem
                        key={index}
                        onClick={item.onClick}
                        className={item.className}
                        mouseX={mouseX}
                        spring={spring}
                        distance={isMobile ? 0 : distance}
                        magnification={effectiveMagnification}
                        baseItemSize={isMobile ? baseItemSize - 4 : baseItemSize}
                    >
                        <DockIcon>{item.icon}</DockIcon>
                        {!isMobile && <DockLabel>{item.label}</DockLabel>}
                    </DockItem>
                ))}
            </motion.div>
        </div>
    );
}
