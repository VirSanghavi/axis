'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase-client';
import Link from 'next/link';

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen bg-[#050505] text-white flex items-center justify-center">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin mx-auto" />
          <p className="mt-4 text-sm text-neutral-400 font-mono lowercase">verifying your email...</p>
        </div>
      </div>
    }>
      <AuthCallbackInner />
    </Suspense>
  );
}

function AuthCallbackInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [status, setStatus] = useState<'verifying' | 'success' | 'error'>('verifying');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    handleCallback();
  }, []);

  async function handleCallback() {
    try {
      // 1. Check for PKCE code param (server-side flow)
      const code = searchParams.get('code');
      if (code) {
        const { data, error } = await supabase.auth.exchangeCodeForSession(code);
        if (!error && data.session?.user) {
          await createAppSession(data.session.access_token, data.session.user.id, data.session.user.email!);
          return;
        }
      }

      // 2. Check for hash fragment tokens (implicit flow)
      const hash = window.location.hash;
      if (hash) {
        const params = new URLSearchParams(hash.substring(1));
        const accessToken = params.get('access_token');

        if (accessToken) {
          // Set the session in Supabase client from the URL tokens
          const refreshToken = params.get('refresh_token') || '';
          const { data, error } = await supabase.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken,
          });

          if (!error && data.session?.user) {
            await createAppSession(accessToken, data.session.user.id, data.session.user.email!);
            return;
          }
        }
      }

      // 3. Check if Supabase already has a session (auto-detected from URL)
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user) {
        await createAppSession(session.access_token, session.user.id, session.user.email!);
        return;
      }

      // 4. Check for token_hash + type (email verification link format)
      const tokenHash = searchParams.get('token_hash');
      const type = searchParams.get('type');
      if (tokenHash && type) {
        const { data, error } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: type as 'email' | 'signup',
        });
        if (!error && data.session?.user) {
          await createAppSession(data.session.access_token, data.session.user.id, data.session.user.email!);
          return;
        }
      }

      // None of the methods worked
      setStatus('error');
      setErrorMsg('Unable to verify your email. The link may have expired.');
    } catch (err) {
      console.error('Auth callback error:', err);
      setStatus('error');
      setErrorMsg('An unexpected error occurred during verification.');
    }
  }

  async function createAppSession(accessToken: string, userId: string, email: string) {
    try {
      const res = await fetch('/api/auth/callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: accessToken,
          user_id: userId,
          email: email,
        }),
      });

      if (res.ok) {
        setStatus('success');
        // Brief delay so the user sees the success message
        setTimeout(() => router.push('/dashboard'), 500);
      } else {
        const data = await res.json().catch(() => ({}));
        setStatus('error');
        setErrorMsg(data.error || 'Failed to create session. Please try logging in.');
      }
    } catch {
      setStatus('error');
      setErrorMsg('Network error. Please try logging in manually.');
    }
  }

  return (
    <div className="min-h-screen bg-[#050505] text-white flex items-center justify-center">
      <div className="text-center max-w-md mx-auto px-6">
        {status === 'verifying' && (
          <div className="space-y-4">
            <div className="w-8 h-8 border-2 border-white/20 border-t-white rounded-full animate-spin mx-auto" />
            <p className="text-sm text-neutral-400 font-mono lowercase">verifying your email...</p>
          </div>
        )}

        {status === 'success' && (
          <div className="space-y-4">
            <div className="w-8 h-8 mx-auto text-emerald-400">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M20 6L9 17l-5-5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <p className="text-sm text-neutral-300 font-mono lowercase">email confirmed — redirecting to dashboard...</p>
          </div>
        )}

        {status === 'error' && (
          <div className="space-y-6">
            <p className="text-sm text-red-400 font-mono lowercase">{errorMsg}</p>
            <Link
              href="/login"
              className="inline-block bg-white text-black px-6 py-2.5 rounded text-[10px] font-bold tracking-[0.2em] uppercase"
            >
              go to login
            </Link>
          </div>
        )}
      </div>
    </div>
  );
}
