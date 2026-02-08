'use client';

import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import Link from 'next/link';
import Navbar from '@/components/Navbar';
import { supabase } from '@/lib/supabase-client';

// Helper for classes
function cn(...inputs: (string | undefined | null | false)[]) {
  return twMerge(clsx(inputs));
}

// Types
interface Activity {
  id: string;
  type: string;
  target: string;
  status: string;
  created_at: string;
}

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

interface Project {
  id: string;
  name: string;
  created_at: string;
}

interface Lock {
  file_path: string;
  agent_id: string;
  intent: string;
  updated_at: string;
}

interface SubscriptionData {
  subscription_status: string;
  stripe?: {
    status: string;
    cancel_at_period_end: boolean;
    current_period_end?: number;
  };
}

interface LockEventSummary {
  blocked: number;
  granted: number;
  force_unlocked: number;
  released: number;
}

interface DailyLockData {
  day: string;
  date: string;
  blocked: number;
  granted: number;
}

interface RecentBlocked {
  id: string;
  file_path: string;
  requesting_agent: string;
  blocking_agent: string;
  intent: string;
  created_at: string;
}

// Bar chart component for usage — fills available space
function UsageChart({ data }: { data: { day: string; requests: number }[] }) {
  const max = Math.max(...data.map(d => d.requests), 1);
  // Scale bar heights: use a power curve so small differences are visible
  // When max is low (e.g. <10), bars get a generous minimum so they don't look flat
  const getBarPercent = (requests: number) => {
    if (requests === 0) return 0;
    // Use sqrt scale so small values get amplified relative to large ones
    const ratio = Math.sqrt(requests / max);
    // Ensure minimum visible bar of 12% for any non-zero value
    return Math.max(12, ratio * 100);
  };

  return (
    <div className="flex-1 flex items-end gap-1.5 min-h-0">
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1.5 h-full">
          <div className="flex-1 flex items-end w-full">
            <motion.div
              initial={{ height: 0 }}
              animate={{ height: `${getBarPercent(d.requests)}%` }}
              transition={{ duration: 0.5, delay: i * 0.05 }}
              className="w-full bg-neutral-900 rounded-t"
              style={{ minHeight: d.requests > 0 ? 4 : 0 }}
            />
          </div>
          <div className="flex flex-col items-center">
            <span className="text-[9px] font-mono text-neutral-900 font-medium">{d.requests}</span>
            <span className="text-[8px] text-neutral-400 font-mono">{d.day}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// Conflicts chart — stacked blocked/granted bars
function ConflictsChart({ data }: { data: DailyLockData[] }) {
  const max = Math.max(...data.map(d => d.blocked + d.granted), 1);
  const getPercent = (val: number) => {
    if (val === 0) return 0;
    return Math.max(8, (val / max) * 100);
  };

  return (
    <div className="flex-1 flex items-end gap-1.5 min-h-0">
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center gap-1.5 h-full">
          <div className="flex-1 flex items-end w-full">
            <div className="w-full flex flex-col items-stretch justify-end h-full gap-px">
              {d.blocked > 0 && (
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: `${getPercent(d.blocked)}%` }}
                  transition={{ duration: 0.5, delay: i * 0.05 }}
                  className="w-full bg-red-400 rounded-t"
                  style={{ minHeight: 4 }}
                  title={`${d.blocked} blocked`}
                />
              )}
              {d.granted > 0 && (
                <motion.div
                  initial={{ height: 0 }}
                  animate={{ height: `${getPercent(d.granted)}%` }}
                  transition={{ duration: 0.5, delay: i * 0.05 + 0.1 }}
                  className="w-full bg-emerald-400 rounded-t"
                  style={{ minHeight: 4 }}
                  title={`${d.granted} granted`}
                />
              )}
            </div>
          </div>
          <div className="flex flex-col items-center">
            <span className="text-[9px] font-mono text-neutral-900 font-medium">{d.blocked + d.granted}</span>
            <span className="text-[8px] text-neutral-400 font-mono">{d.day}</span>
          </div>
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
  const [projects, setProjects] = useState<Project[]>([]);
  const [locks, setLocks] = useState<Lock[]>([]);
  const [conflictSummary, setConflictSummary] = useState<LockEventSummary | null>(null);
  const [conflictDaily, setConflictDaily] = useState<DailyLockData[]>([]);
  const [recentBlocked, setRecentBlocked] = useState<RecentBlocked[]>([]);
  const [activeTab, setActiveTab] = useState<'keys' | 'usage' | 'sessions' | 'projects' | 'conflicts'>('keys');
  const [session, setSession] = useState<{ email: string; id: string } | null>(null);
  const [activities, setActivities] = useState<Activity[]>([]);

  useEffect(() => {
    fetch('/api/auth/session').then(res => res.json()).then(data => {
      if (data.user) {
        setSession(data.user);
        fetchActivity(data.user.id);

        // Subscribe to realtime activity feed
        const channel = supabase
          .channel(`activity-feed-${data.user.id}`)
          .on(
            'postgres_changes',
            {
              event: 'INSERT',
              schema: 'public',
              table: 'activity_feed',
              filter: `user_id=eq.${data.user.id}`,
            },
            (payload) => {
              setActivities((prev) => [payload.new as Activity, ...prev].slice(0, 10));
            }
          )
          .on(
            'broadcast',
            { event: 'new-activity' },
            (payload) => {
              setActivities((prev) => {
                // Avoid duplicates if postgres_changes also fired
                if (prev.some(a => a.id === payload.payload.id || (a.type === payload.payload.type && a.target === payload.payload.target && Math.abs(new Date(a.created_at).getTime() - new Date(payload.payload.created_at).getTime()) < 1000))) {
                  return prev;
                }
                return [payload.payload as Activity, ...prev].slice(0, 10);
              });
            }
          )
          .subscribe();

        return () => {
          supabase.removeChannel(channel);
        };
      }
    });
    fetchKeys();
    fetchUsage();
    fetchSubStatus();
    fetchSessions();
    fetchProjects();
    fetchLocks();
    fetchConflicts();
  }, []);

  async function fetchActivity(userId: string) {
    try {
      const res = await fetch('/api/activity');
      if (res.ok) {
        const data = await res.json();
        setActivities(data.activity || []);
      }
    } catch (e) {
      console.error(e);
    }
  }

  function getRelativeTime(dateString: string) {
    const date = new Date(dateString);
    const now = new Date();
    const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffInSeconds < 60) return 'just now';
    if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
    if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
    return `${Math.floor(diffInSeconds / 86400)}d ago`;
  }

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

  async function fetchProjects() {
    try {
      const res = await fetch('/api/v1/projects');
      if (res.ok) {
        const data = await res.json();
        setProjects(data.projects || []);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function fetchLocks() {
    try {
      const res = await fetch('/api/v1/locks');
      if (res.ok) {
        const data = await res.json();
        setLocks(data.locks || []);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function fetchConflicts() {
    try {
      const res = await fetch('/api/v1/lock-events?days=7');
      if (res.ok) {
        const data = await res.json();
        setConflictSummary(data.summary || null);
        setConflictDaily(data.daily || []);
        setRecentBlocked(data.recentBlocked || []);
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function fetchSubStatus() {
    try {
      // Use no-store to ensure we get the latest status after payment
      const res = await fetch('/api/stripe/status', { cache: 'no-store' });
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
        const secret = data.key.secret as string;
        setKeys([...keys, data.key]);
        setCreatedKey(secret);
        setNewKeyName('');
        if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
          navigator.clipboard.writeText(secret);
        }

        // Local UI update for immediate feedback
        setActivities(prev => [{
          id: data.key.id,
          type: 'KEY_GENERATED',
          target: newKeyName,
          status: 'success',
          created_at: new Date().toISOString()
        }, ...prev].slice(0, 10));
      }
    } catch (e) {
      console.error(e);
    }
  }

  async function deleteKey(id: string) {
    if (!confirm('Are you sure? This action cannot be undone.')) return;
    try {
      const keyToDelete = keys.find(k => k.id === id);
      const res = await fetch(`/api/keys/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setKeys(keys.filter(k => k.id !== id));

        // Local UI update for immediate feedback
        setActivities(prev => [{
          id: `del-${id}`,
          type: 'KEY_DELETED',
          target: keyToDelete?.name || 'Unknown Key',
          status: 'success',
          created_at: new Date().toISOString()
        }, ...prev].slice(0, 10));
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
        <div className="w-full max-w-5xl bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl p-10 text-neutral-900 flex flex-col h-[75vh]">
          <div className="flex justify-between items-end mb-6">
            <div>
              <h1 className="text-3xl font-medium tracking-tight mb-2">dashboard</h1>
              <p className="text-[11px] text-neutral-500 uppercase tracking-[0.2em]">
                {session ? `logged in as ${session.email}` : 'manage your api keys'} — {subData?.subscription_status === 'pro' ? 'pro' : 'free'}
              </p>
            </div>
          </div>

          <div className="grid gap-8 md:grid-cols-12 flex-1 min-h-0">
            <div className="md:col-span-7 flex flex-col min-h-0">
              <div className="flex gap-4 mb-6 border-b border-neutral-200">
                <button onClick={() => setActiveTab('keys')} className={cn("pb-2 text-[11px] font-mono uppercase tracking-wider", activeTab === 'keys' ? "text-black border-b-2 border-black" : "text-neutral-400")}>api keys</button>
                <button onClick={() => setActiveTab('usage')} className={cn("pb-2 text-[11px] font-mono uppercase tracking-wider", activeTab === 'usage' ? "text-black border-b-2 border-black" : "text-neutral-400")}>usage</button>
                <button onClick={() => setActiveTab('sessions')} className={cn("pb-2 text-[11px] font-mono uppercase tracking-wider", activeTab === 'sessions' ? "text-black border-b-2 border-black" : "text-neutral-400")}>sessions</button>
                <button onClick={() => setActiveTab('projects')} className={cn("pb-2 text-[11px] font-mono uppercase tracking-wider", activeTab === 'projects' ? "text-black border-b-2 border-black" : "text-neutral-400")}>projects</button>
                <button onClick={() => setActiveTab('conflicts')} className={cn("pb-2 text-[11px] font-mono uppercase tracking-wider", activeTab === 'conflicts' ? "text-black border-b-2 border-black" : "text-neutral-400")}>conflicts</button>
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
                        <div className="text-[10px] font-bold text-emerald-700 uppercase mb-1">key created — copied to clipboard</div>
                        <code className="block bg-white p-2 text-[10px] font-mono border border-emerald-100 rounded mb-2 select-all overflow-x-auto">{createdKey}</code>
                        <button onClick={() => setCreatedKey(null)} className="text-[9px] uppercase font-mono text-emerald-500 hover:text-emerald-700">done</button>
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
                  <div className="flex flex-col h-full">
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

                {activeTab === 'projects' && (
                  <div className="space-y-3">
                    {projects.length === 0 ? (
                      <div className="text-center py-10 opacity-40 font-mono text-[11px]">no projects detected yet</div>
                    ) : (
                      projects.map(p => (
                        <div key={p.id} className="bg-white border border-neutral-200 rounded-lg p-4 hover:border-neutral-900 transition-all group">
                          <div className="flex justify-between items-center">
                            <div>
                              <div className="text-[14px] font-medium text-neutral-900 group-hover:text-blue-600 transition-colors">{p.name}</div>
                              <div className="text-[10px] font-mono text-neutral-400 mt-1 uppercase tracking-tighter">
                                created {new Date(p.created_at).toLocaleDateString()}
                              </div>
                            </div>
                            <div className="text-[9px] font-mono px-2 py-1 bg-neutral-100 rounded text-neutral-500 uppercase">active</div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}

                {activeTab === 'conflicts' && (
                  <div className="flex flex-col h-full">
                    {/* Summary cards */}
                    <div className="grid grid-cols-4 gap-3 mb-5">
                      <div className="bg-red-50 border border-red-100 rounded-lg p-3 text-center">
                        <div className="text-[20px] font-bold text-red-600">{conflictSummary?.blocked || 0}</div>
                        <div className="text-[9px] font-mono text-red-400 uppercase tracking-wider">blocked</div>
                      </div>
                      <div className="bg-emerald-50 border border-emerald-100 rounded-lg p-3 text-center">
                        <div className="text-[20px] font-bold text-emerald-600">{conflictSummary?.granted || 0}</div>
                        <div className="text-[9px] font-mono text-emerald-400 uppercase tracking-wider">granted</div>
                      </div>
                      <div className="bg-amber-50 border border-amber-100 rounded-lg p-3 text-center">
                        <div className="text-[20px] font-bold text-amber-600">{conflictSummary?.force_unlocked || 0}</div>
                        <div className="text-[9px] font-mono text-amber-400 uppercase tracking-wider">forced</div>
                      </div>
                      <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-3 text-center">
                        <div className="text-[20px] font-bold text-neutral-600">{conflictSummary?.released || 0}</div>
                        <div className="text-[9px] font-mono text-neutral-400 uppercase tracking-wider">released</div>
                      </div>
                    </div>

                    {/* Chart */}
                    {conflictDaily.length > 0 && (
                      <div className="mb-4">
                        <div className="flex justify-between items-center mb-2">
                          <span className="text-[11px] font-mono text-neutral-500 uppercase tracking-widest">last 7 days</span>
                          <div className="flex gap-3">
                            <span className="text-[9px] font-mono text-red-400 flex items-center gap-1"><span className="w-2 h-2 bg-red-400 rounded-sm inline-block" /> blocked</span>
                            <span className="text-[9px] font-mono text-emerald-400 flex items-center gap-1"><span className="w-2 h-2 bg-emerald-400 rounded-sm inline-block" /> granted</span>
                          </div>
                        </div>
                        <div className="h-[140px]">
                          <ConflictsChart data={conflictDaily} />
                        </div>
                      </div>
                    )}

                    {/* Recent blocked events */}
                    <div className="mt-2">
                      <h4 className="text-[10px] font-mono text-neutral-500 uppercase tracking-[0.2em] mb-3">recent conflicts</h4>
                      {recentBlocked.length === 0 ? (
                        <div className="text-center py-8 opacity-40 font-mono text-[11px]">no conflicts this week — all clear</div>
                      ) : (
                        <div className="space-y-2">
                          {recentBlocked.map(ev => {
                            const shortPath = ev.file_path.split('/').slice(-2).join('/');
                            return (
                              <div key={ev.id} className="bg-red-50/50 border border-red-100 rounded-lg p-3">
                                <div className="flex justify-between items-start mb-1">
                                  <span className="text-[11px] font-mono font-medium text-neutral-800 truncate" title={ev.file_path}>{shortPath}</span>
                                  <span className="text-[9px] font-mono text-neutral-400 whitespace-nowrap ml-2">{getRelativeTime(ev.created_at)}</span>
                                </div>
                                <div className="text-[10px] text-neutral-500">
                                  <span className="font-medium text-red-500">{ev.requesting_agent}</span> blocked by <span className="font-medium text-neutral-700">{ev.blocking_agent}</span>
                                </div>
                                {ev.intent && <div className="text-[9px] text-neutral-400 italic mt-0.5">{ev.intent}</div>}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>

              <div className="mt-4 pt-4 border-t border-neutral-100">
                <div className="flex items-center gap-2 mb-4">
                  <h3 className="text-[10px] font-mono text-neutral-500 uppercase tracking-[0.3em]">recent actions</h3>
                </div>
                <div className="space-y-2 max-h-[160px] overflow-y-auto pr-2 custom-scrollbar">
                  {activities.length === 0 ? (
                    <div className="text-center py-6 opacity-40 font-mono text-[10px]">no recent activity</div>
                  ) : (
                    activities.map((item) => (
                      <div key={item.id} className="flex items-center justify-between text-[11px] font-mono bg-neutral-50 px-4 py-2 rounded border border-neutral-100">
                        <div className="flex items-center gap-3 min-w-0">
                          <span className="text-neutral-400 flex-shrink-0">[{item.type}]</span>
                          <span className="text-neutral-700 font-medium truncate">{item.target}</span>
                        </div>
                        <span className="text-neutral-400 text-[9px] whitespace-nowrap ml-4">{getRelativeTime(item.created_at)}</span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="md:col-span-5 space-y-6">

              {/* Active Locks */}
              <div className="bg-neutral-50 border border-neutral-200 rounded-lg p-5">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-[9px] font-mono text-neutral-500 uppercase tracking-[0.3em]">active locks</h3>
                  <span className="text-[9px] font-mono text-neutral-400">{locks.length} file{locks.length !== 1 ? 's' : ''}</span>
                </div>
                {locks.length === 0 ? (
                  <div className="text-[10px] text-neutral-400 font-mono">no files locked — all clear</div>
                ) : (
                  <div className="space-y-2.5 max-h-[200px] overflow-y-auto pr-1 custom-scrollbar">
                    {locks.map(lock => {
                      const acquiredAt = new Date(lock.updated_at).getTime();
                      const expiresAt = acquiredAt + 30 * 60 * 1000;
                      const now = Date.now();
                      const remainingMs = Math.max(0, expiresAt - now);
                      const remainingMin = Math.ceil(remainingMs / 60000);
                      const shortPath = lock.file_path.split('/').slice(-2).join('/');
                      return (
                        <div key={lock.file_path} className="bg-white border border-neutral-200 rounded-lg p-3">
                          <div className="text-[11px] font-mono font-medium text-neutral-900 truncate mb-1" title={lock.file_path}>{shortPath}</div>
                          <div className="text-[10px] text-neutral-500 space-y-0.5">
                            <div>locked by <span className="font-medium text-neutral-700">{lock.agent_id}</span></div>
                            {lock.intent && <div className="italic text-neutral-400">intent: &quot;{lock.intent}&quot;</div>}
                            <div className={remainingMin <= 5 ? 'text-amber-600 font-medium' : 'text-neutral-400'}>
                              expires in {remainingMin}m
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
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
                  <h3 className="text-[10px] font-mono text-neutral-400 uppercase tracking-[0.3em]">mcp headers guide</h3>
                </div>
                <div className="bg-neutral-50 border border-dashed border-neutral-300 rounded p-4 font-mono">
                  <div className="text-[9px] text-neutral-400 mb-2">{"// use your axis-pro key"}</div>
                  <div className="text-[10px] text-neutral-600 space-y-1">
                    <div>Authorization: Bearer <span className="text-blue-600">sk_sc_...</span></div>
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
