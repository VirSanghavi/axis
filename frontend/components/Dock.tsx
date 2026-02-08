'use client';

import { motion, useMotionValue, useSpring, useTransform, AnimatePresence, MotionValue, SpringOptions } from 'framer-motion';
import { Children, cloneElement, useEffect, useLayoutEffect, useRef, useState, ReactElement } from 'react';

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
    baseItemSize,
}: DockItemProps) {
    const ref = useRef<HTMLDivElement>(null);
    const isHovered = useMotionValue(0);

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
        const timer = setTimeout(updateStableX, 500);

        return () => {
            window.removeEventListener('resize', updateStableX);
            clearTimeout(timer);
        };
    }, []);

    const mouseDistance = useTransform(mouseX, (val) => {
        if (val === Infinity) return Infinity;
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
            data-dock-item
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
    isActive?: boolean;
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
    const panelRef = useRef<HTMLDivElement>(null);
    const leaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    const activeIndex = items.findIndex(i => i.isActive);

    // Pure motion value for indicator position — no React state, no re-renders
    const indicatorTarget = useMotionValue(0);
    const indicatorX = useSpring(indicatorTarget, { stiffness: 500, damping: 30, mass: 0.5 });
    const indicatorOpacity = useMotionValue(0);

    // Get the center-x of item[i] relative to panel left (only dock items, exclude indicator)
    const getItemCenterInPanel = (index: number): number | null => {
        const panel = panelRef.current;
        if (!panel) return null;
        const dockItems = panel.querySelectorAll('[data-dock-item]');
        const itemEl = dockItems[index] as HTMLElement | undefined;
        if (!itemEl) return null;
        const panelRect = panel.getBoundingClientRect();
        const itemRect = itemEl.getBoundingClientRect();
        return itemRect.left + itemRect.width / 2 - panelRect.left;
    };

    // Set indicator to active item on mount, when active changes, or when isMobile changes
    useLayoutEffect(() => {
        if (isMobile || activeIndex < 0) {
            indicatorOpacity.set(0);
            return;
        }
        indicatorOpacity.set(1);
        const updatePos = () => {
            const x = getItemCenterInPanel(activeIndex);
            if (x !== null) indicatorTarget.set(x);
        };
        updatePos();
        const id = requestAnimationFrame(updatePos);
        const id2 = requestAnimationFrame(updatePos); // Double RAF for mobile layout
        return () => { cancelAnimationFrame(id); cancelAnimationFrame(id2); };
    }, [activeIndex, indicatorTarget, indicatorOpacity, isMobile]);

    useEffect(() => {
        const checkMobile = () => {
            setIsMobile(window.innerWidth < 768);
        };
        checkMobile();
        window.addEventListener('resize', checkMobile);
        return () => window.removeEventListener('resize', checkMobile);
    }, []);

    const effectiveMagnification = isMobile ? baseItemSize : magnification;

    // On pointer move: find which item the cursor is closest to and move indicator there
    const handlePointerMove = (e: React.PointerEvent) => {
        if (isMobile) return;
        if (leaveTimeoutRef.current) {
            clearTimeout(leaveTimeoutRef.current);
            leaveTimeoutRef.current = null;
        }
        mouseX.set(e.pageX);

        const panel = panelRef.current;
        if (!panel) return;
        const panelRect = panel.getBoundingClientRect();
        const cursorXInPanel = e.clientX - panelRect.left;

        // Find the closest item center
        let closestDist = Infinity;
        let closestX = indicatorTarget.get();

        const dockItems = panel.querySelectorAll('[data-dock-item]');
        for (let i = 0; i < dockItems.length; i++) {
            const el = dockItems[i] as HTMLElement;
            const elRect = el.getBoundingClientRect();
            const center = elRect.left + elRect.width / 2 - panelRect.left;
            const dist = Math.abs(cursorXInPanel - center);
            if (dist < closestDist) {
                closestDist = dist;
                closestX = center;
            }
        }

        indicatorTarget.set(closestX);
        indicatorOpacity.set(1);
    };

    const handlePointerLeave = () => {
        mouseX.set(Infinity);
        if (leaveTimeoutRef.current) clearTimeout(leaveTimeoutRef.current);

        if (activeIndex >= 0) {
            const idx = activeIndex;
            leaveTimeoutRef.current = setTimeout(() => {
                leaveTimeoutRef.current = null;
                const x = getItemCenterInPanel(idx);
                if (x !== null) indicatorTarget.set(x);
            }, 120);
        } else {
            indicatorOpacity.set(0);
        }
    };

    return (
        <div className={`dock-outer ${isMobile ? 'dock-mobile' : 'dock-desktop'}`} onPointerLeave={handlePointerLeave}>
            <motion.div
                ref={panelRef}
                onPointerMove={handlePointerMove}
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

                {/* Page indicator */}
                <motion.div
                    className="dock-active-indicator"
                    style={{ left: indicatorX, opacity: indicatorOpacity }}
                />
            </motion.div>
        </div>
    );
}
