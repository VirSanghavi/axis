'use client';

import { usePathname, useRouter } from "next/navigation";
import { Home, Info, MessageCircle, BookOpen, Github, LogOut, LogIn, LayoutDashboard } from "lucide-react";
import Dock, { DockItemConfig } from "./Dock";
import { useRef, useState, useEffect, useMemo, useCallback } from "react";

export default function Navbar() {
    const pathname = usePathname();
    const router = useRouter();
    const [isAuthenticated, setIsAuthenticated] = useState<boolean | null>(null);
    const logoutFormRef = useRef<HTMLFormElement>(null);

    useEffect(() => {
        const checkAuth = async () => {
            try {
                // Use a controller to avoid parallel fetches if pathname changes rapidly
                const res = await fetch("/api/auth/session");
                if (res.ok) {
                    const data = await res.json();
                    setIsAuthenticated(data.authenticated);
                } else {
                    setIsAuthenticated(false);
                }
            } catch {
                setIsAuthenticated(false);
            }
        };
        checkAuth();
    }, [pathname]);

    const [shouldLogout, setShouldLogout] = useState(false);

    useEffect(() => {
        if (shouldLogout) {
            logoutFormRef.current?.submit();
            setTimeout(() => setShouldLogout(false), 0);
        }
    }, [shouldLogout]);

    const handleLogout = useCallback(() => {
        setShouldLogout(true);
    }, []);

    const navItems = useMemo(() => {
        const items: DockItemConfig[] = [
            {
                icon: <img src="/alogo.jpg" alt="Axis" className="w-full h-full object-cover rounded-full" />,
                label: "axis",
                onClick: () => router.push("/")
            },
            {
                icon: <Home size={20} />,
                label: "home",
                onClick: () => router.push("/")
            },
            {
                icon: isAuthenticated === false ? <LogIn size={20} /> : <Info size={20} />,
                label: isAuthenticated === false ? "sign in" : "about",
                onClick: () => router.push(isAuthenticated === false ? "/login" : "/about")
            },
            {
                icon: <MessageCircle size={20} />,
                label: "thoughts?",
                onClick: () => router.push("/feedback")
            },
            {
                icon: <BookOpen size={20} />,
                label: "docs",
                onClick: () => router.push("/docs")
            },
            {
                icon: <Github size={20} />,
                label: "github",
                onClick: () => window.open("https://github.com/VirSanghavi/shared-context", "_blank")
            }
        ];

        if (isAuthenticated === true) {
            items.push({
                icon: <LayoutDashboard size={20} />,
                label: "dashboard",
                onClick: () => router.push("/dashboard")
            });
            items.push({
                icon: <LogOut size={20} />,
                label: "logout",
                onClick: handleLogout
            });
        }
        return items;
    }, [isAuthenticated, router, handleLogout]);

    return (
        <header className="z-50 pointer-events-none">
            <form action="/api/auth/logout" method="POST" ref={logoutFormRef} className="hidden">
                <button type="submit">logout</button>
            </form>
            <Dock items={navItems} />
        </header>
    );
}
