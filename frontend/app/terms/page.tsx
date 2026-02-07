'use client';

import Link from 'next/link';
import Navbar from '@/components/Navbar';

export default function TermsPage() {
    return (
        <div className="min-h-screen bg-[#050505] text-white selection:bg-white/10 tracking-tight lowercase">
            {/* Avalanche background */}
            <div className="bg-avalanche" />

            <Navbar />

            <main className="pt-32 pb-20 px-6 relative z-10">
                <div className="max-w-2xl mx-auto bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl p-12 text-neutral-900">
                    <div className="mb-10">
                        <h1 className="text-4xl font-medium tracking-tight mb-2">terms of service</h1>
                        <p className="text-[11px] text-neutral-500 uppercase tracking-[0.2em]">last updated: february 2026</p>
                    </div>

                    <div className="space-y-8 text-[14px] leading-relaxed text-neutral-700">
                        <section>
                            <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-900 mb-4">1. acceptance of terms</h2>
                            <p>
                                by accessing or using the axis platform, you agree to be bound by these terms of service. if you do not agree, you must not use our services.
                            </p>
                        </section>

                        <section>
                            <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-900 mb-4">2. service description</h2>
                            <p>
                                axis provides a context governance protocol for ai agents. we enable you to mirror your project structure and stream filtered, relevant context into agent prompts to eliminate hallucinations and improve accuracy.
                            </p>
                        </section>

                        <section>
                            <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-900 mb-4">3. subscription and payments</h2>
                            <p>
                                axis operates on a pro subscription model of $5/month. fees are non-refundable and charged at the beginning of each billing cycle. we do not offer free trials; our approach is focused on zero friction and immediate utility for committed developers.
                            </p>
                        </section>

                        <section>
                            <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-900 mb-4">4. prohibited activities</h2>
                            <p>
                                you agree not to:
                            </p>
                            <ul className="list-disc pl-5 mt-3 space-y-2">
                                <li>attempt to circumvent our context filtering logic or rate limits.</li>
                                <li>reverse engineer the axis context-mapping protocol.</li>
                                <li>use axis for any illegal or unauthorized purpose.</li>
                                <li>interfere with the performance or integrity of our infrastructure.</li>
                            </ul>
                        </section>

                        <section>
                            <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-900 mb-4">5. limitation of liability</h2>
                            <p>
                                axis is provided &quot;as is&quot;. we are not liable for any direct or indirect damages resulting from the use or inability to use our platform, including but not limited to inaccuracies in ai-generated responses based on provided context.
                            </p>
                        </section>
                    </div>

                    <div className="mt-12 pt-8 border-t border-neutral-100 flex items-center justify-between">
                        <Link href="/" className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-400 hover:text-neutral-900 transition-colors">back to home</Link>
                        <Link href="/privacy" className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-400 hover:text-neutral-900 transition-colors">privacy policy</Link>
                    </div>
                </div>
            </main>
        </div>
    );
}
