'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import Link from 'next/link';
import Navbar from '@/components/Navbar';

// Types
interface SubscriptionData {
    subscription_status: string;
    has_retention_offer: boolean;
    has_seen_retention: boolean;
    stripe?: {
        status: string;
        cancel_at_period_end: boolean;
        current_period_end?: number;
    };
}

export default function BillingPage() {
    const [subData, setSubData] = useState<SubscriptionData | null>(null);
    const [loading, setLoading] = useState(true);
    const [showRetention, setShowRetention] = useState(false);
    const [processing, setProcessing] = useState(false);
    const [message, setMessage] = useState<string | null>(null);

    useEffect(() => {
        fetchStatus();
    }, []);

    async function fetchStatus() {
        setLoading(true);
        try {
            // Use no-store to ensure we get the latest status after payment
            const res = await fetch('/api/stripe/status', { cache: 'no-store' });
            if (res.ok) {
                const data = await res.json();
                setSubData(data);
            }
        } catch (e) {
            console.error(e);
        } finally {
            setLoading(false);
        }
    }

    async function handleSubscribe() {
        setProcessing(true);
        try {
            const res = await fetch('/api/stripe/checkout', { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                if (data.url) window.location.href = data.url;
            }
        } catch (e) {
            console.error(e);
        } finally {
            setProcessing(false);
        }
    }

    async function handleApplyOffer() {
        setProcessing(true);
        try {
            const res = await fetch('/api/stripe/retention', { method: 'POST' });
            if (res.ok) {
                setMessage("offer applied! 50% discount will show on your next bill.");
                setShowRetention(false);
                fetchStatus();
            } else {
                const data = await res.json();
                setMessage(data.error || "failed to apply offer.");
            }
        } catch (e) {
            console.error(e);
        } finally {
            setProcessing(false);
        }
    }

    async function handleFinalCancel() {
        setProcessing(true);
        try {
            const res = await fetch('/api/stripe/cancel', { method: 'POST' });
            if (res.ok) {
                setMessage("subscription will be cancelled at the end of the current period.");
                setShowRetention(false);
                fetchStatus();
            }
        } catch (e) {
            console.error(e);
        } finally {
            setProcessing(false);
        }
    }

    if (loading) {
        return (
            <div className="min-h-screen bg-[#050505] flex items-center justify-center">
                <div className="bg-avalanche" />
                <div className="text-[10px] font-mono text-white/40 uppercase tracking-[0.4em]">loading axis context...</div>
            </div>
        );
    }

    const isActive = subData?.subscription_status === 'pro' || subData?.stripe?.status === 'active';
    const isCancelled = subData?.stripe?.cancel_at_period_end;

    return (
        <div className="min-h-screen bg-[#050505] text-white selection:bg-white/10 tracking-tight lowercase">
            <div className="bg-avalanche" />

            <Navbar />

            <main className="pt-32 pb-20 px-6 relative z-10 flex flex-col items-center">
                <div className="w-full max-w-lg bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl p-12 text-neutral-900">
                    <div className="mb-10 text-center">
                        <h1 className="text-4xl font-medium tracking-tight mb-2">billing</h1>
                        <p className="text-[11px] text-neutral-500 uppercase tracking-[0.2em]">manage your axis subscription</p>
                    </div>

                    <div className="space-y-8">
                        {/* Status Card */}
                        <div className="bg-neutral-50 border border-neutral-100 rounded-xl p-8">
                            <div className="flex justify-between items-start mb-6">
                                <div>
                                    <div className="text-[10px] font-bold uppercase tracking-[0.3em] text-neutral-400 mb-2">current plan</div>
                                    <div className="text-2xl font-black text-neutral-900 tracking-tighter">axis pro</div>
                                </div>
                                <div className={isActive ? (isCancelled ? "bg-amber-100 text-amber-700 px-3 py-1 rounded-full text-[9px] font-bold uppercase tracking-widest" : "bg-emerald-100 text-emerald-700 px-3 py-1 rounded-full text-[9px] font-bold uppercase tracking-widest") : "bg-neutral-200 text-neutral-500 px-3 py-1 rounded-full text-[9px] font-bold uppercase tracking-widest"}>
                                    {isActive ? (isCancelled ? "cancelling" : "active") : "inactive"}
                                </div>
                            </div>

                            {isActive && subData.stripe?.current_period_end && (
                                <div className="text-[11px] text-neutral-500 font-mono tracking-wider">
                                    {isCancelled ? "expires on: " : "next billing date: "}
                                    {new Date(subData.stripe.current_period_end * 1000).toLocaleDateString()}
                                </div>
                            )}

                            {!isActive && (
                                <div className="text-[11px] text-neutral-500 leading-relaxed mb-6">
                                    you are currently on the legacy tier. subscribe to axis pro for unlimited mcp connectors and live streaming.
                                </div>
                            )}
                        </div>

                        {/* Actions */}
                        <div className="space-y-3">
                            {!isActive ? (
                                <button
                                    onClick={handleSubscribe}
                                    disabled={processing}
                                    className="w-full bg-neutral-900 text-white py-4 rounded-xl text-[12px] font-black tracking-[0.4em] uppercase hover:bg-black transition-all shadow-xl"
                                >
                                    {processing ? "processing..." : "subscribe — $5/mo"}
                                </button>
                            ) : (
                                <>
                                    <button
                                        onClick={async () => {
                                            setProcessing(true);
                                            try {
                                                const res = await fetch('/api/stripe/portal', { method: 'POST' });
                                                if (res.redirected) {
                                                    window.location.href = res.url;
                                                } else if (res.ok) {
                                                    // In case it doesn't auto-redirect but returns JSON or similar
                                                    const data = await res.json();
                                                    if (data.url) window.location.href = data.url;
                                                }
                                            } catch (e) {
                                                console.error(e);
                                            } finally {
                                                setProcessing(false);
                                            }
                                        }}
                                        disabled={processing}
                                        className="w-full bg-neutral-900 text-white py-4 rounded-xl text-[12px] font-black tracking-[0.4em] uppercase hover:bg-black transition-all shadow-xl disabled:opacity-50"
                                    >
                                        {processing ? "loading..." : "manage payment methods"}
                                    </button>
                                    {!isCancelled && (
                                        <button
                                            onClick={async () => {
                                                console.log("[Billing] Cancel clicked. State:", { hasOffer: subData?.has_retention_offer, hasSeen: subData?.has_seen_retention });
                                                if (subData?.has_retention_offer || subData?.has_seen_retention) {
                                                    // Already have it OR already saw it - just cancel
                                                    handleFinalCancel();
                                                } else {
                                                    // Mark as seen in DB immediately and wait for it
                                                    await fetch('/api/stripe/status/mark-seen', { method: 'POST' });
                                                    setShowRetention(true);
                                                }
                                            }}
                                            className="w-full text-[10px] text-neutral-400 hover:text-rose-500 transition-colors uppercase tracking-widest font-mono mt-4"
                                        >
                                            cancel subscription
                                        </button>
                                    )}
                                </>
                            )}
                        </div>
                    </div>

                    {message && (
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="mt-8 p-4 bg-neutral-100 rounded-lg text-[11px] text-neutral-600 text-center font-mono"
                        >
                            {message}
                        </motion.div>
                    )}

                    <div className="mt-12 pt-8 border-t border-neutral-100">
                        <Link href="/dashboard" className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-400 hover:text-neutral-900 transition-colors">
                            ← back to dashboard
                        </Link>
                    </div>
                </div>
            </main >

            {/* Retention Modal */}
            <AnimatePresence>
                {
                    showRetention && (
                        <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
                            <motion.div
                                initial={{ opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={{ opacity: 0 }}
                                className="absolute inset-0 bg-black/60 backdrop-blur-sm"
                                onClick={() => setShowRetention(false)}
                            />
                            <motion.div
                                initial={{ opacity: 0, scale: 0.95, y: 20 }}
                                animate={{ opacity: 1, scale: 1, y: 0 }}
                                exit={{ opacity: 0, scale: 0.95, y: 20 }}
                                className="relative w-full max-w-md bg-white rounded-3xl p-12 text-center shadow-[0_32px_120px_rgba(0,0,0,0.5)]"
                            >
                                <h2 className="text-3xl font-black text-neutral-900 tracking-tighter mb-4">wait! before you go...</h2>
                                <p className="text-[14px] text-neutral-600 leading-relaxed mb-10">
                                    we&apos;d love to keep you on axis. accept this one-time offer: get <b>50% off</b> for the next 3 months.
                                </p>

                                <div className="space-y-4">
                                    <button
                                        onClick={handleApplyOffer}
                                        disabled={processing}
                                        className="w-full bg-emerald-600 text-white py-4 rounded-xl text-[12px] font-black tracking-[0.3em] uppercase hover:bg-emerald-700 transition-all shadow-lg"
                                    >
                                        {processing ? "applying..." : "accept offer — $2.50/mo"}
                                    </button>
                                    <button
                                        onClick={handleFinalCancel}
                                        disabled={processing}
                                        className="w-full text-[10px] text-neutral-400 hover:text-rose-500 transition-colors uppercase tracking-widest font-mono"
                                    >
                                        no thanks, cancel subscription
                                    </button>
                                </div>
                            </motion.div>
                        </div>
                    )
                }
            </AnimatePresence >
        </div >
    );
}

