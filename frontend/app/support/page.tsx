'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import Navbar from '@/components/Navbar';

export default function SupportPage() {
    const [subject, setSubject] = useState('');
    const [message, setMessage] = useState('');
    const [email, setEmail] = useState('');
    const [submitted, setSubmitted] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    async function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!message.trim() || !subject.trim() || !email.trim()) return;

        const res = await fetch("/api/support", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, subject, message }),
        });

        if (res.ok) {
            setSubmitted(true);
        } else {
            const data = await res.json().catch(() => ({}));
            alert(data.error || "Failed to submit support request");
        }
        setSubmitting(false);
    }

    return (
        <div className="min-h-screen bg-[#050505] text-white selection:bg-white/10 tracking-tight lowercase">
            {/* Avalanche background */}
            <div className="bg-avalanche" />

            <Navbar />

            {/* White modal container */}
            <main className="pt-32 pb-20 px-6 relative z-10">
                <div className="max-w-lg mx-auto bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl p-10 text-neutral-900">
                    <div className="mb-8">
                        <h1 className="text-3xl font-medium tracking-tight mb-2">contact support</h1>
                        <p className="text-[11px] text-neutral-500 uppercase tracking-[0.2em]">we&apos;re here to help</p>
                    </div>

                    {submitted ? (
                        <motion.div
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="text-center py-12"
                        >
                            <div className="text-4xl mb-4">📩</div>
                            <h2 className="text-xl font-medium mb-2">message sent</h2>
                            <p className="text-[12px] text-neutral-500 mb-6">our team will get back to you shortly.</p>
                            <Link
                                href="/dashboard"
                                className="inline-block bg-neutral-900 text-white px-6 py-3 rounded text-[10px] font-bold tracking-[0.2em] uppercase hover:bg-neutral-800 transition-colors"
                            >
                                back to dashboard
                            </Link>
                        </motion.div>
                    ) : (
                        <form onSubmit={handleSubmit} className="space-y-6">
                            {/* Email */}
                            <div>
                                <label className="block text-[10px] font-bold tracking-[0.2em] uppercase text-neutral-600 mb-2">
                                    email address
                                </label>
                                <input
                                    type="email"
                                    placeholder="your@email.com"
                                    value={email}
                                    onChange={(e) => setEmail((e.target as HTMLInputElement).value)}
                                    className="w-full bg-neutral-100 border border-neutral-200 rounded px-4 py-3 outline-none focus:border-neutral-400 text-[12px] font-mono text-neutral-900"
                                    required
                                />
                            </div>

                            {/* Subject */}
                            <div>
                                <label className="block text-[10px] font-bold tracking-[0.2em] uppercase text-neutral-600 mb-2">
                                    subject
                                </label>
                                <input
                                    type="text"
                                    placeholder="how can we help?"
                                    value={subject}
                                    onChange={(e) => setSubject((e.target as HTMLInputElement).value)}
                                    className="w-full bg-neutral-100 border border-neutral-200 rounded px-4 py-3 outline-none focus:border-neutral-400 text-[12px] text-neutral-900"
                                    required
                                />
                            </div>

                            {/* Message */}
                            <div>
                                <label className="block text-[10px] font-bold tracking-[0.2em] uppercase text-neutral-600 mb-2">
                                    how can we help?
                                </label>
                                <textarea
                                    placeholder="describe your issue in detail..."
                                    value={message}
                                    onChange={(e) => setMessage((e.target as HTMLTextAreaElement).value)}
                                    rows={5}
                                    className="w-full bg-neutral-100 border border-neutral-200 rounded px-4 py-3 outline-none focus:border-neutral-400 text-[12px] text-neutral-900 resize-none"
                                    required
                                />
                            </div>

                            {/* Submit */}
                            <button
                                type="submit"
                                disabled={submitting || !message.trim() || !subject.trim() || !email.trim()}
                                className="w-full bg-neutral-900 text-white py-3 rounded text-[10px] font-bold tracking-[0.2em] uppercase hover:bg-neutral-800 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                                {submitting ? 'sending...' : 'send message'}
                            </button>
                        </form>
                    )}
                </div>
            </main>
        </div>
    );
}
