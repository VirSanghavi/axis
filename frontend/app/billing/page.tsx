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
        setMessage(null);
        try {
            const res = await fetch('/api/stripe/checkout', { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                if (data.url) window.location.href = data.url;
            } else {
                const d = await res.json();
                setMessage(d.error || "failed to start checkout");
            }
        } catch (e) {
            console.error(e);
            setMessage("something went wrong");
        } finally {
            setProcessing(false);
        }
    }

    async function handleApplyOffer() {
        setProcessing(true);
        setMessage(null);
        try {
            const res = await fetch('/api/stripe/retention', { method: 'POST' });
            if (res.ok) {
                await fetch('/api/stripe/status/mark-seen', { method: 'POST' });
                setMessage("offer applied. 50% off will appear on your next bill.");
                setShowRetention(false);
                fetchStatus();
            } else {
                const data = await res.json();
                setMessage(data.error || "failed to apply offer");
            }
        } catch (e) {
            console.error(e);
            setMessage("something went wrong");
        } finally {
            setProcessing(false);
        }
    }

    async function handleFinalCancel() {
        setProcessing(true);
        setMessage(null);
        try {
            const res = await fetch('/api/stripe/cancel', { method: 'POST' });
            if (res.ok) {
                setMessage("subscription will be cancelled at the end of the current period.");
                setShowRetention(false);
                fetchStatus();
            } else {
                const d = await res.json();
                setMessage(d.error || "failed to cancel");
            }
        } catch (e) {
            console.error(e);
            setMessage("something went wrong");
        } finally {
            setProcessing(false);
        }
    }

    async function handleManagePaymentMethods() {
        setProcessing(true);
        setMessage(null);
        try {
            const res = await fetch('/api/stripe/portal', { method: 'POST' });
            const data = await res.json().catch(() => ({}));
            if (res.ok && data?.url) {
                window.location.href = data.url;
                return;
            }
            if (res.status === 401) setMessage("sign in required");
            else if (res.status === 429) setMessage("too many requests — try again shortly");
            else setMessage(data?.error || "could not open billing portal");
        } catch (e) {
            console.error(e);
            setMessage("something went wrong");
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
                <div className="w-full max-w-md bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl p-6 text-neutral-900">
                    <div className="mb-6">
                        <h1 className="text-2xl font-medium tracking-tight mb-1">billing</h1>
                        <p className="text-[10px] text-neutral-500 uppercase tracking-[0.2em]">manage your axis subscription</p>
                    </div>

                    <div className="space-y-4">
                        {/* Status Card */}
                        <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-5">
                            <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-neutral-400 mb-1">current plan</div>
                            <div className="text-xl font-semibold text-neutral-900 tracking-tight mb-1">
                                {isActive ? 'axis pro' : 'axis free'}
                            </div>
                            <div className="text-[10px] text-neutral-500 font-mono">
                                {isActive
                                    ? isCancelled
                                        ? `cancelling — expires ${subData?.stripe?.current_period_end ? new Date(subData.stripe.current_period_end * 1000).toLocaleDateString() : ''}`
                                        : subData?.stripe?.current_period_end
                                            ? `active — renews ${new Date(subData.stripe.current_period_end * 1000).toLocaleDateString()}`
                                            : 'active'
                                    : 'no active subscription'}
                            </div>
                        </div>

                        {/* Plan Details */}
                        <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-5">
                            <div className="text-[9px] font-bold uppercase tracking-[0.2em] text-neutral-400 mb-3">
                                {isActive ? 'your plan includes' : 'upgrade to pro'}
                            </div>
                            <div className="space-y-2">
                                {[
                                    { feature: 'api keys', free: 'none', pro: 'unlimited' },
                                    { feature: 'mcp tool calls', free: 'none', pro: 'unlimited' },
                                    { feature: 'parallel agents', free: 'none', pro: 'unlimited' },
                                    { feature: 'file locking', free: 'none', pro: 'atomic, cross-ide' },
                                    { feature: 'job board', free: 'none', pro: 'priority + dependencies' },
                                    { feature: 'session history', free: 'none', pro: 'unlimited + rag search' },
                                ].map(row => (
                                    <div key={row.feature} className="flex justify-between items-center text-[11px]">
                                        <span className="text-neutral-600">{row.feature}</span>
                                        <span className={`font-mono text-[10px] ${isActive ? 'text-neutral-900' : 'text-neutral-400'}`}>
                                            {isActive ? row.pro : row.free}
                                        </span>
                                    </div>
                                ))}
                            </div>
                            {isActive && subData?.has_retention_offer && (
                                <div className="mt-3 pt-3 border-t border-neutral-200 text-[10px] text-neutral-500 font-mono">
                                    discount active — 50% off applied
                                </div>
                            )}
                        </div>

                        {/* Actions */}
                        <div className="space-y-2">
                            {!isActive ? (
                                <button
                                    onClick={handleSubscribe}
                                    disabled={processing}
                                    className="w-full bg-neutral-900 text-white py-2.5 rounded-lg text-[11px] font-medium uppercase tracking-wider hover:bg-black transition-colors disabled:opacity-60"
                                >
                                    {processing ? "processing..." : "subscribe — $5/mo"}
                                </button>
                            ) : (
                                <>
                                    <button
                                        onClick={handleManagePaymentMethods}
                                        disabled={processing}
                                        className="w-full bg-neutral-900 text-white py-2.5 rounded-lg text-[11px] font-medium uppercase tracking-wider hover:bg-black transition-colors disabled:opacity-60"
                                    >
                                        {processing ? "loading..." : "manage payment methods"}
                                    </button>
                                    {!isCancelled && (
                                        <button
                                            onClick={async () => {
                                                if (subData?.has_retention_offer || subData?.has_seen_retention) {
                                                    handleFinalCancel();
                                                } else {
                                                    await fetch('/api/stripe/status/mark-seen', { method: 'POST' });
                                                    setShowRetention(true);
                                                }
                                            }}
                                            className="block w-full text-[10px] text-neutral-400 hover:text-rose-600 transition-colors uppercase tracking-wider font-mono py-1"
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
                            initial={{ opacity: 0, y: 6 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="mt-4 p-3 bg-neutral-100 rounded-lg text-[11px] text-neutral-600 text-center font-mono"
                        >
                            {message}
                        </motion.div>
                    )}

                    <div className="mt-6 pt-4 border-t border-neutral-200">
                        <Link href="/dashboard" className="text-[10px] font-medium uppercase tracking-wider text-neutral-400 hover:text-neutral-900 transition-colors">
                            ← back to dashboard
                        </Link>
                    </div>
                </div>
            </main>

            {/* Retention Modal */}
            <AnimatePresence>
                {showRetention && (
                    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="absolute inset-0 bg-black/50"
                            onClick={() => setShowRetention(false)}
                        />
                        <motion.div
                            initial={{ opacity: 0, scale: 0.98, y: 10 }}
                            animate={{ opacity: 1, scale: 1, y: 0 }}
                            exit={{ opacity: 0, scale: 0.98, y: 10 }}
                            className="relative w-full max-w-sm bg-white rounded-xl p-6 shadow-xl"
                        >
                            <h2 className="text-lg font-semibold text-neutral-900 tracking-tight mb-1">before you go</h2>
                            <p className="text-[12px] text-neutral-500 mb-4">
                                cancelling means losing access to these on your next billing cycle:
                            </p>
                            <ul className="text-[11px] text-neutral-600 space-y-1.5 mb-5 list-none">
                                <li className="flex items-start gap-2"><span className="text-neutral-300 mt-0.5">—</span>unlimited api keys and mcp tool calls</li>
                                <li className="flex items-start gap-2"><span className="text-neutral-300 mt-0.5">—</span>atomic file locking across parallel agents</li>
                                <li className="flex items-start gap-2"><span className="text-neutral-300 mt-0.5">—</span>job board with dependency-aware claiming</li>
                                <li className="flex items-start gap-2"><span className="text-neutral-300 mt-0.5">—</span>semantic search over past sessions (rag)</li>
                                <li className="flex items-start gap-2"><span className="text-neutral-300 mt-0.5">—</span>priority support and early feature access</li>
                            </ul>
                            <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-3 mb-4">
                                <p className="text-[11px] text-neutral-700 font-medium">one-time offer: 50% off for the next 3 months</p>
                                <p className="text-[10px] text-neutral-400 mt-0.5">$2.50/mo instead of $5/mo. applied automatically.</p>
                            </div>
                            <div className="space-y-2">
                                <button
                                    onClick={handleApplyOffer}
                                    disabled={processing}
                                    className="w-full bg-neutral-900 text-white py-2.5 rounded-lg text-[11px] font-medium uppercase tracking-wider hover:bg-black transition-colors disabled:opacity-60"
                                >
                                    {processing ? "applying..." : "stay — $2.50/mo"}
                                </button>
                                <button
                                    onClick={handleFinalCancel}
                                    disabled={processing}
                                    className="w-full text-[10px] text-neutral-400 hover:text-rose-600 transition-colors uppercase tracking-wider font-mono py-2"
                                >
                                    cancel anyway
                                </button>
                            </div>
                        </motion.div>
                    </div>
                )}
            </AnimatePresence>
        </div >
    );
}

