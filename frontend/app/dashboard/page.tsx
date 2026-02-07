'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import Link from 'next/link';
import Navbar from '@/components/Navbar';
import { Activity, Shield, Cpu, Terminal } from 'lucide-react';

// Helper for classes
function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

// Types
interface ApiKey {
  id: string;
  name: string;
  created_at: string;
  last_used_at: string | null;
  is_active: boolean;
  secret?: string;
}

interface SessionRecord {
  id: string;
  title: string;
  summary: string;
  created_at: string;
}

interface SubscriptionData {
  subscription_status: string;
  stripe?: {
    status: string;
    cancel_at_period_end: boolean;
    current_period_end?: number;
  };
}

// Simple bar chart component for usage
function UsageChart({ data }: { data: { day: string; requests: number }[] }) {
  const max = Math.max(...data.map(d => d.requests), 1);

  return (
    <div className="h-24 flex items-end gap-1">
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1">
          <motion.div
            initial={{ height: 0 }}
            animate={{ height: `${(d.requests / max) * 100}%` }}
            transition={{ duration: 0.5, delay: i * 0.05 }}
            className="w-full bg-blue-400 rounded-t min-h-[2px]"
          />
          <span className="text-[8px] text-neutral-400 font-mono">{d.day}</span>
        </div>
      ))}
    </div>
  );
}

export default function Dashboard() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [newKeyName, setNewKeyName] = useState('');
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [usageData, setUsageData] = useState<{ day: string; requests: number }[]>([]);
  const [subData, setSubData] = useState<SubscriptionData | null>(null);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeTab, setActiveTab] = useState<'keys' | 'usage' | 'sessions'>('keys');

  useEffect(() => {
    fetchKeys();
    fetchUsage();
    fetchSubStatus();
    fetchSessions();
  }, []);

  async function fetchSessions() {
    try {
      const res = await fetch('/api/v1/sessions');
      if (res.ok) {
        const data = await res.json();
        setSessions(data.sessions || []);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function fetchSubStatus() {
    try {
      const res = await fetch('/api/stripe/status');
      if (res.ok) {
        const data = await res.json();
        setSubData(data);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function fetchKeys() {
    setLoading(true);
    try {
      const res = await fetch('/api/keys');
      if (res.ok) {
        const data = await res.json();
        setKeys(data.keys || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  async function fetchUsage() {
    try {
      const res = await fetch('/api/usage');
      if (res.ok) {
        const data = await res.json();
        setUsageData(data.usage || []);
      }
    } catch (e) {
      console.error(e);
    } finally {
      // Done fetching
    }
  }

  async function createKey(e: React.FormEvent) {
    e.preventDefault();
    if (!newKeyName) return;

    try {
      const res = await fetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newKeyName })
      });
      if (res.ok) {
        const data = await res.json();
        setKeys([...keys, data.key]);
        setCreatedKey(data.key.secret);
        setNewKeyName('');
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function deleteKey(id: string) {
    if (!confirm('Are you sure? This action cannot be undone.')) return;
    try {
      const res = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setKeys(keys.filter(k => k.id !== id));
      }
    } catch (e) {
      console.error(e);
    }
  }

  const totalRequests = usageData.reduce((sum, d) => sum + d.requests, 0);

  return (
    <div className="min-h-screen bg-[#050505] text-white selection:bg-white/10 tracking-tight lowercase">
      <div className="bg-avalanche" />

      <Navbar />

      <main className="pt-32 pb-20 px-6 relative z-10 flex items-center justify-center">
        <div className="w-full max-w-5xl bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl p-10 text-neutral-900 flex flex-col min-h-[80vh]">
          <div className="flex justify-between items-end mb-6">
            <div>
              <h1 className="text-3xl font-medium tracking-tight mb-2">dashboard</h1>
              <p className="text-[11px] text-neutral-500 uppercase tracking-[0.2em]">manage your api keys and context governance.</p>
            </div>
          </div>

          <div className="grid gap-8 md:grid-cols-12 flex-1 min-h-0">
            <div className="md:col-span-7 flex flex-col min-h-0">
              <div className="flex gap-4 mb-6 border-b border-neutral-200">
                <button onClick={() => setActiveTab('keys')} className={cn("pb-2 text-[11px] font-mono uppercase tracking-wider", activeTab === 'keys' ? "text-black border-b-2 border-black" : "text-neutral-400")}>api keys</button>
                <button onClick={() => setActiveTab('usage')} className={cn("pb-2 text-[11px] font-mono uppercase tracking-wider", activeTab === 'usage' ? "text-black border-b-2 border-black" : "text-neutral-400")}>usage</button>
                <button onClick={() => setActiveTab('sessions')} className={cn("pb-2 text-[11px] font-mono uppercase tracking-wider", activeTab === 'sessions' ? "text-black border-b-2 border-black" : "text-neutral-400")}>sessions</button>
              </div>

              <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                {activeTab === 'keys' && (
                  <div className="space-y-4">
                    <form onSubmit={createKey} className="flex gap-2">
                      <input
                        type="text"
                        disabled={subData?.subscription_status !== 'pro'}
                        placeholder={subData?.subscription_status === 'pro' ? "key name..." : "upgrade to pro"}
                        value={newKeyName}
                        onChange={(e) => setNewKeyName(e.target.value)}
                        className="flex-1 bg-neutral-100 border border-neutral-200 rounded px-3 py-2 text-[12px] font-mono outline-none focus:border-neutral-400"
                      />
                      <button type="submit" disabled={loading || subData?.subscription_status !== 'pro'} className="bg-black text-white px-4 py-2 rounded text-[10px] uppercase font-mono tracking-widest disabled:opacity-50">create</button>
                    </form>

                    {createdKey && (
                      <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
                        <div className="text-[10px] font-bold text-emerald-700 uppercase mb-1">key created</div>
                        <code className="block bg-white p-2 text-[10px] font-mono border border-emerald-100 rounded mb-2 select-all">{createdKey}</code>
                        <button onClick={() => setCreatedKey(null)} className="text-[9px] uppercase font-mono text-emerald-500">done</button>
                      </div>
                    )}

                    <div className="space-y-2">
                      {keys.map(k => (
                        <div key={k.id} className="bg-white border border-neutral-200 rounded-lg p-3 flex justify-between items-center group">
                          <div>
                            <div className="text-[12px] font-medium">{k.name}</div>
                            <div className="text-[10px] text-neutral-400 font-mono">{new Date(k.created_at).toLocaleDateString()}</div>
                          </div>
                          <button onClick={() => deleteKey(k.id)} className="opacity-0 group-hover:opacity-100 text-neutral-400 hover:text-red-500 transition-all">
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {activeTab === 'usage' && (
                  <div>
                    <div className="flex justify-between items-center mb-4">
                      <span className="text-[11px] font-mono text-neutral-500 uppercase tracking-widest">total requests</span>
                      <span className="text-[11px] font-mono font-bold">{totalRequests}</span>
                    </div>
                    <UsageChart data={usageData} />
                  </div>
                )}

                {activeTab === 'sessions' && (
                  <div className="space-y-3">
                    {sessions.length === 0 ? (
                      <div className="text-center py-10 opacity-40 font-mono text-[11px]">no sessions synced yet</div>
                    ) : (
                      sessions.map(s => (
                        <div key={s.id} className="bg-white border border-neutral-200 rounded-lg p-4 hover:border-neutral-400 transition-all">
                          <div className="flex justify-between mb-2">
                            <span className="text-[13px] font-medium">{s.title}</span>
                            <span className="text-[10px] font-mono text-neutral-400">{new Date(s.created_at).toLocaleDateString()}</span>
                          </div>
                          <p className="text-[11px] text-neutral-500 leading-relaxed">{s.summary}</p>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>

              {/* Context Discovery Feed - NEW */}
              <div className="mt-8 pt-8 border-t border-neutral-100">
                <div className="flex items-center gap-2 mb-4">
                  <Activity size={14} className="text-blue-500" />
                  <h3 className="text-[10px] font-mono text-neutral-500 uppercase tracking-[0.3em]">live context discovery feed</h3>
                </div>
                <div className="space-y-2">
                  {[
                    { op: 'MIRROR_SYNC', target: 'shared-context/v1', status: 'success', time: '2m ago' },
                    { op: 'LOCK_ACQUIRED', target: 'auth.ts', status: 'success', time: '5m ago' },
                    { op: 'VECTOR_UPSELL', target: 'system-kernel', status: 'queued', time: '12m ago' },
                  ].map((item, idx) => (
                    <div key={idx} className="flex items-center justify-between text-[11px] font-mono bg-neutral-50 px-4 py-2 rounded border border-neutral-100">
                      <div className="flex items-center gap-3">
                        <div className={cn("w-1.5 h-1.5 rounded-full", item.status === 'success' ? "bg-emerald-500" : "bg-amber-500 animate-pulse")} />
                        <span className="text-neutral-400">[{item.op}]</span>
                        <span className="text-neutral-700 font-medium">{item.target}</span>
                      </div>
                      <span className="text-neutral-400 text-[9px]">{item.time}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="md:col-span-5 space-y-6">
              {/* System Metadata Block - NEW */}
              <div className="bg-neutral-900 text-white rounded-lg p-6 shadow-xl relative overflow-hidden">
                <div className="absolute top-0 right-0 p-4 opacity-10">
                  <Cpu size={80} />
                </div>
                <h3 className="text-[9px] font-mono text-neutral-400 uppercase tracking-[0.3em] mb-4 flex items-center gap-2">
                  <Shield size={10} className="text-blue-400" /> axis kernel status
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <div className="text-[10px] text-neutral-500 uppercase mb-0.5">version</div>
                    <div className="text-[13px] font-mono text-blue-400">1.0.0-prod</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-neutral-500 uppercase mb-0.5">uptime</div>
                    <div className="text-[13px] font-mono text-emerald-400">99.98%</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-neutral-500 uppercase mb-0.5">latency</div>
                    <div className="text-[13px] font-mono">12ms</div>
                  </div>
                  <div>
                    <div className="text-[10px] text-neutral-500 uppercase mb-0.5">sync rate</div>
                    <div className="text-[13px] font-mono text-amber-400">sub-sec</div>
                  </div>
                </div>
              </div>

              <div className="bg-neutral-100 border border-neutral-200 rounded-lg p-5">
                <h3 className="text-[9px] font-mono text-neutral-500 uppercase tracking-[0.3em] mb-3">subscription</h3>
                <div className="mb-4">
                  <div className="text-[16px] font-medium tracking-tight mb-0.5">
                    {subData?.subscription_status === 'pro' ? 'axis pro' : 'axis legacy'}
                  </div>
                  <div className="text-[10px] font-mono text-neutral-400 tracking-wider">
                    {subData?.subscription_status === 'pro'
                      ? (subData.stripe?.cancel_at_period_end
                        ? `expires ${new Date((subData.stripe.current_period_end || 0) * 1000).toLocaleDateString()}`
                        : 'active')
                      : 'free tier'}
                  </div>
                </div>
                <Link href="/billing" className="block w-full bg-neutral-900 text-white py-2.5 rounded text-[10px] font-bold tracking-[0.2em] uppercase text-center">manage billing</Link>
              </div>

              <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-5">
                <h3 className="text-[9px] font-mono text-neutral-500 uppercase tracking-[0.3em] mb-2">support</h3>
                <p className="text-[10px] text-neutral-500 leading-relaxed lowercase mb-3">need help with mcp headers or context governance?</p>
                <Link href="/support" className="text-[9px] font-mono text-neutral-400 hover:text-neutral-900 uppercase tracking-widest">contact support ↗</Link>
              </div>

              {/* Quick Integration Guide - NEW */}
              <div className="pt-4">
                <div className="flex items-center gap-2 mb-3">
                  <Terminal size={14} className="text-neutral-400" />
                  <h3 className="text-[10px] font-mono text-neutral-400 uppercase tracking-[0.3em]">mcp headers guide</h3>
                </div>
                <div className="bg-neutral-50 border border-dashed border-neutral-300 rounded p-4 font-mono">
                  <div className="text-[9px] text-neutral-400 mb-2">{"// use your axis-pro key"}</div>
                  <div className="text-[10px] text-neutral-600 space-y-1">
                    <div>Authorization: Bearer <span className="text-blue-600">AXIS_KEY_...</span></div>
                    <div>X-Axis-Context: mirror-sync</div>
                    <div>X-Axis-Origin: cluster-7</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
