'use client';

import Link from 'next/link';
import Navbar from '@/components/Navbar';

export default function PrivacyPage() {
    return (
        <div className="min-h-screen bg-[#050505] text-white selection:bg-white/10 tracking-tight lowercase">
            {/* Avalanche background */}
            <div className="bg-avalanche" />

            <Navbar />

            <main className="pt-32 pb-20 px-6 relative z-10">
                <div className="max-w-2xl mx-auto bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl p-12 text-neutral-900">
                    <div className="mb-10">
                        <h1 className="text-4xl font-medium tracking-tight mb-2">privacy policy</h1>
                        <p className="text-[11px] text-neutral-500 uppercase tracking-[0.2em]">last updated: february 2026</p>
                    </div>

                    <div className="space-y-8 text-[14px] leading-relaxed text-neutral-700">
                        <section>
                            <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-900 mb-4">1. information collection</h2>
                            <p>
                                axis collects minimal information required to provide context governance services. this includes email addresses for authentication, project structure data via our cli, and usage metadata to manage subscription tiers. we do not store your actual file contents long-term; they are processed in-memory to generate context maps for your agents.
                            </p>
                        </section>

                        <section>
                            <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-900 mb-4">2. how we use data</h2>
                            <p>
                                your data is used exclusively to:
                            </p>
                            <ul className="list-disc pl-5 mt-3 space-y-2">
                                <li>provide and maintain the axis context protocol.</li>
                                <li>stream high-fidelity context to your connected ai agents.</li>
                                <li>manage your $5/month pro subscription and api access.</li>
                                <li>improve our context-mapping algorithms and infrastructure.</li>
                            </ul>
                        </section>

                        <section>
                            <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-900 mb-4">3. data security</h2>
                            <p>
                                we implement strict spatial and logical isolation for all user data. api keys are encrypted at rest and never shared with third parties. axis uses industry-standard infrastructure providers (supabase and openai) with high-compliance security protocols.
                            </p>
                        </section>

                        <section>
                            <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-900 mb-4">4. third-party services</h2>
                            <p>
                                axis integrates with supabase for authentication and database services, and openai for context-aware chat features. their use of your information is governed by their respective privacy policies.
                            </p>
                        </section>

                        <section>
                            <h2 className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-900 mb-4">5. contact</h2>
                            <p>
                                for privacy-related inquiries, please reach out via our feedback system or directly on github.
                            </p>
                        </section>
                    </div>

                    <div className="mt-12 pt-8 border-t border-neutral-100 flex items-center justify-between">
                        <Link href="/" className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-400 hover:text-neutral-900 transition-colors">back to home</Link>
                        <Link href="/terms" className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-400 hover:text-neutral-900 transition-colors">terms of service</Link>
                    </div>
                </div>
            </main>
        </div>
    );
}
