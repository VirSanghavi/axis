'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import Navbar from '@/components/Navbar';

export default function SignupPage() {
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const router = useRouter();

    const handleSignup = async (e: React.FormEvent) => {
        e.preventDefault();
        setLoading(true);
        setError(null);

        try {
            const res = await fetch('/api/auth/signup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password }),
            });

            if (res.ok) {
                router.push('/login?message=Check your email to confirm your account');
            } else {
                const data = await res.json() as { error?: string };
                setError(data.error || 'Failed to sign up');
            }
        } catch {
            setError('An unexpected error occurred');
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className="min-h-screen bg-[#050505] text-white selection:bg-white/10 tracking-tight lowercase">
            <div className="bg-avalanche opacity-20 fixed inset-0 pointer-events-none" />

            <Navbar />

            <main className="pt-40 flex flex-col items-center justify-center px-6 relative z-10">
                <div className="absolute inset-0 z-[-1] bg-[radial-gradient(circle_at_center,rgba(0,0,0,0.4)_0%,transparent_70%)] pointer-events-none" />
                <div className="w-full max-w-[400px]">
                    <div className="text-center mb-12 mix-blend-difference drop-shadow-[0_2px_40px_rgba(0,0,0,1)]">
                        <h1 className="text-3xl font-medium tracking-tight mb-2 lowercase">create your account</h1>
                        <p className="text-[13px] text-white/70 font-semibold uppercase tracking-[0.2em] lowercase">start building with axis</p>
                    </div>

                    <div className="bg-[#0D0D0D]/40 backdrop-blur-xl border border-white/5 p-8 rounded">
                        <form onSubmit={handleSignup} className="space-y-6">
                            <div>
                                <label className="block text-[10px] font-mono text-white/30 uppercase tracking-[0.2em] mb-2 lowercase opacity-40">email address</label>
                                <input
                                    type="email"
                                    required
                                    value={email}
                                    onChange={(e) => setEmail((e.target as HTMLInputElement).value)}
                                    className="w-full bg-white/[0.02] border border-white/5 rounded px-4 py-3 outline-none focus:border-white/10 transition-colors text-sm lowercase"
                                    placeholder="name@company.com"
                                />
                            </div>

                            <div>
                                <label className="block text-[10px] font-mono text-white/30 uppercase tracking-[0.2em] mb-2 lowercase opacity-40">password</label>
                                <input
                                    type="password"
                                    required
                                    value={password}
                                    onChange={(e) => setPassword((e.target as HTMLInputElement).value)}
                                    className="w-full bg-white/[0.02] border border-white/5 rounded px-4 py-3 outline-none focus:border-white/10 transition-colors text-sm lowercase"
                                    placeholder="••••••••"
                                />
                            </div>

                            {error && (
                                <div className="text-rose-500 text-[12px] font-mono bg-rose-500/5 border border-rose-500/10 p-3 rounded">
                                    {error}
                                </div>
                            )}

                            <button
                                type="submit"
                                disabled={loading}
                                className="w-full btn-nia-primary !tracking-[0.3em] uppercase py-4 lowercase font-bold"
                            >
                                {loading ? 'creating account...' : 'sign up'}
                            </button>
                        </form>

                        <div className="mt-8 pt-8 border-t border-white/5 text-center">
                            <p className="text-[12px] text-white/30 lowercase">
                                already have an account?{' '}
                                <Link href="/login" className="text-white hover:underline lowercase">
                                    sign in
                                </Link>
                            </p>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
