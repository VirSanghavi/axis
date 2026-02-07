'use client';

import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import Navbar from "@/components/Navbar";
import MachineToggle from "@/components/MachineToggle";
import { useMachineMode } from "@/context/MachineModeContext";

export default function Home() {
    const { mode } = useMachineMode();
    const [mounted, setMounted] = useState(false);
    const [query, setQuery] = useState("");
    const [isSearching, setIsSearching] = useState(false);
    const [answer, setAnswer] = useState<string | null>(null);

    useEffect(() => {
        setMounted(true);
    }, []);

    const handleSearch = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!query.trim()) return;

        setIsSearching(true);
        setAnswer(null);

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ query }),
            });
            const data = await res.json() as { answer?: string; error?: string };
            if (data.answer) {
                setAnswer(data.answer);
            } else if (data.error) {
                setAnswer(data.error);
            }
        } catch {
            setAnswer("axis intelligence: internal connection bridge failed. ensure env keys are present.");
        } finally {
            setIsSearching(false);
        }
    };

    if (!mounted) return null;

    if (mode === 'machine') {
        return (
            <div className="min-h-screen bg-black text-white font-mono p-10 leading-relaxed selection:bg-white/20">
                <div className="max-w-3xl mx-auto space-y-8">
                    <div className="flex items-center gap-6 mb-12">
                        <img src="/alogo.jpg" alt="Axis" className="w-16 h-16 rounded-full border border-emerald-500/20 grayscale" />
                        <pre className="text-emerald-500 m-0">
                            {`
    ___                _     
   / _ \\__  _____  ___| |    
  / /_\\ \\ \\/ / _ \\/ __| |    
 / /_\\\\ \\  / (_| \\__ \\_|    
 \\____/  \\_\\/\\___||___(_)    
                             
`}
                        </pre>
                    </div>
                    <div className="prose prose-invert prose-emerald max-w-none">
                        <ReactMarkdown>{`
# Axis Intelligence Kernel v1.0.0-prod
## Technical Specification: Parallel Agent Orchestration

Axis is a high-performance orchestration layer designed to enable **Parallel Agent Workflows**. By providing distributed memory synchronization and an atomic job board, Axis allows multiple autonomous agents to collaborate on the same codebase simultaneously without collisions or context drift.

[Initialize System / Signup](/signup)

---

### 1. Parallel Agent Orchestration (PAO-1)
The cornerstone of Axis is the **PAO-1** protocol, which transforms a single-agent environment into a high-concurrency swarm.

- **Distributed Memory**: Real-time synchronization of the "Live Notepad" across disparate agent processes.
- **Job Orchestration**: An atomic Job Board (\`post_job\`, \`claim_next_job\`) that prevents task duplication and manages dependencies.
- **Conflict Prevention**: Granular file locking that ensures serial access to critical code paths during parallel execution.

### 2. Context Governance & Mirroring
To ensure agents have "Ground Truth" during execution, Axis maintains a high-fidelity mirror of the environment:

- **Mirror Extraction**: Zero-latency extraction of project goals and architectural constraints.
- **Dependency Injection**: Automatic identification of logic-trees to inject relevant snippets into agent pre-fills.
- **Sub-linear Scaling**: Optimized indexing for multi-million line repos with change-vector tracking.

### 3. MCP Orchestration Tools
Axis exposes a standardized toolset via the **Model Context Protocol**:
- \`propose_file_access\`: Distributed lock management for conflict-free editing.
- \`post_job\` / \`claim_next_job\`: Decentralized task coordination for agent swarms.
- \`update_shared_context\`: Real-time short-term memory synchronization.

---

### 4. Persistence & Sync Logic
- **Engine**: Supabase-backed distributed state management.
- **Concurrency**: Optimistic locking for job claims and pessimistic locking for file access.
- **Latency**: Sub-100ms synchronization across globe-spanning agent instances.

### 5. Tier Pro: Distributed Capabilities
- **Monthly Subscription**: $5 USD
- **Shared Memory Mirroring**: Real-time sync for the Live Notepad across all workers.
- **Unlimited Worker Nodes**: No cap on the number of concurrent agents managed.
- **Priority Task Queue**: Sub-second job board responsiveness.
- **Audit Trails**: FULL history of agent interactions and state transitions.

---

### 6. Roadmap: Evolution of Coordination
- **v1.1 (Q1 2026)**: Sub-second hot-reloading for vector embeddings.
- **v1.2 (Q2 2026)**: Hierarchical agent sub-swarms (Nested Orchestration).
- **v2.0 (EOD 2026)**: Autonomous task-decomposition (The "General" Model).

## Links & Connectivity
- [Technical Documentation](/docs)
- [Mirror Source (GitHub)](https://github.com/VirSanghavi/shared-context)
- [System Manifest (/about)](/about)
`}</ReactMarkdown>
                    </div>
                </div>
                <MachineToggle />
            </div>
        );
    }

    return (
        <div className="relative min-h-screen font-sans selection:bg-white/5 tracking-tight lowercase overflow-x-hidden text-white bg-black">


            <div className="bg-avalanche pointer-events-none fixed inset-0 z-[0]" />

            {/* section 1: hero (clean / clear background) */}
            <section className="relative min-h-screen flex flex-col items-center justify-center px-6 text-center z-10 transition-colors duration-1000 bg-transparent">
                {/* dark anchor for hero text transparency */}
                <div className="absolute inset-0 z-[-1] bg-[radial-gradient(circle_at_center,rgba(0,0,0,0.4)_0%,transparent_70%)] pointer-events-none" />

                {/* navigation */}
                <Navbar />

                <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 1, ease: [0.19, 1, 0.22, 1] }}
                    className="max-w-4xl relative"
                >
                    <h1 className="text-[52px] md:text-[84px] font-medium tracking-tighter mb-8 text-white leading-[1.05] drop-shadow-[0_4px_80px_rgba(0,0,0,1)] mix-blend-difference">
                        parallel coding <br />agent workflows
                    </h1>
                    <p className="text-[17px] md:text-[19px] text-white/95 max-w-xl mx-auto leading-relaxed mb-12 font-medium drop-shadow-[0_2px_40px_rgba(0,0,0,1)] mix-blend-difference">
                        distributed orchestration for multiple ai agents. solve complex engineering tasks with synchronized memory and coordinated swarms.
                    </p>
                </motion.div>

                {/* demo search - premium interaction */}
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.3, duration: 0.8 }}
                    className="w-full max-w-2xl search-container rounded-lg overflow-hidden border border-white/10 relative z-20"
                >
                    <form onSubmit={handleSearch} className="relative">
                        <input
                            type="text"
                            placeholder="ask axis anything..."
                            className="w-full bg-black/40 p-6 pr-32 outline-none text-[15px] font-mono placeholder:text-white/40 text-white mix-blend-difference drop-shadow-[0_0_10px_rgba(0,0,0,0.5)]"
                            value={query}
                            onChange={(e) => setQuery((e.target as HTMLInputElement).value)}
                        />
                        <div className="absolute right-4 top-1/2 -translate-y-1/2">
                            <button
                                type="submit"
                                disabled={isSearching}
                                className="bg-white/5 text-white/40 px-5 py-2 rounded text-[10px] font-bold tracking-widest uppercase hover:bg-white/10 transition-all border border-white/5"
                            >
                                {isSearching ? "..." : "run"}
                            </button>
                        </div>
                    </form>

                    <AnimatePresence>
                        {answer && (
                            <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: 'auto', opacity: 1 }}
                                className="border-t border-white/5 p-8 text-left font-mono text-[13px] leading-relaxed text-white bg-black/20"
                            >
                                <div className="flex gap-4 mix-blend-difference drop-shadow-[0_0_10px_rgba(0,0,0,0.5)]">
                                    <span className="text-white/60 italic shrink-0">axis:</span>
                                    <div className="max-h-52 overflow-y-auto pr-2 custom-scrollbar w-full">
                                        <div className="prose prose-invert prose-xs max-w-none">
                                            <ReactMarkdown
                                                components={{
                                                    p: ({ children }) => <p className="mb-3 last:mb-0 leading-relaxed">{children}</p>,
                                                    ol: ({ children }) => <ol className="list-decimal pl-4 mb-3 space-y-1">{children}</ol>,
                                                    ul: ({ children }) => <ul className="list-disc pl-4 mb-3 space-y-1">{children}</ul>,
                                                    li: ({ children }) => <li className="mb-0">{children}</li>,
                                                    strong: ({ children }) => <strong className="font-bold text-white/90">{children}</strong>,
                                                    code: ({ children }) => <code className="bg-white/10 px-1 rounded text-emerald-400">{children}</code>
                                                }}
                                            >
                                                {answer}
                                            </ReactMarkdown>
                                        </div>
                                    </div>
                                </div>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </motion.div>

                <div className="absolute bottom-12 left-1/2 -translate-x-1/2 opacity-20 hidden md:block">
                    <div className="w-[1px] h-12 bg-gradient-to-b from-white to-transparent" />
                </div>
            </section>

            {/* section 2: value & pricing (stealth dark) */}
            <section className="relative pt-48 pb-12 px-6 z-10 overflow-hidden text-neutral-900 border-t border-white/10 shadow-[0_-50px_100px_rgba(0,0,0,0.8)] bg-avalanche2">
                <div className="absolute inset-0 bg-white/10 pointer-events-none" />
                <div className="max-w-7xl mx-auto relative z-10">
                    <div className="grid grid-cols-1 lg:grid-cols-3 gap-10 items-center">

                        {/* protocol card */}
                        <motion.div
                            initial={{ opacity: 0, rotate: 0, x: -10 }}
                            whileInView={{ opacity: 1, rotate: -2, x: 0 }}
                            viewport={{ once: true }}
                            className="bg-white/95 backdrop-blur-xl p-10 rounded-2xl min-h-[480px] flex flex-col justify-between shadow-2xl text-neutral-900 border border-neutral-200"
                        >
                            <div className="space-y-10">
                                <h3 className="text-[12px] font-mono text-neutral-500 uppercase tracking-[0.4em] font-bold">protocol</h3>
                                <div className="space-y-8">
                                    <div>
                                        <div className="text-[13px] text-rose-600 font-mono mb-3 uppercase tracking-widest font-extrabold underline decoration-2 decoration-rose-600/30 underline-offset-4">concurrency</div>
                                        <p className="text-[15px] text-neutral-800 leading-relaxed font-bold">single-agent loops are linear. parallel agents collide and desync without a shared brain.</p>
                                    </div>
                                    <div>
                                        <div className="text-[13px] text-emerald-600 font-mono mb-3 uppercase tracking-widest font-extrabold underline decoration-2 decoration-emerald-600/30 underline-offset-4">coordination</div>
                                        <p className="text-[15px] text-black leading-relaxed font-black">axis implements a distributed job board, allowing multiple agents to partition and solve complex bugs.</p>
                                    </div>
                                    <div>
                                        <div className="text-[13px] text-amber-600 font-mono mb-3 uppercase tracking-widest font-extrabold underline decoration-2 decoration-amber-600/30 underline-offset-4">short-term memory</div>
                                        <p className="text-[15px] text-black leading-relaxed font-black">the live notepad synchronizes "thoughts" across agents, enabling collective reasoning in real-time.</p>
                                    </div>
                                    <div>
                                        <div className="text-[13px] text-blue-600 font-mono mb-3 uppercase tracking-widest font-extrabold underline decoration-2 decoration-blue-600/30 underline-offset-4">conflict avoidance</div>
                                        <p className="text-[15px] text-black leading-relaxed font-black">granular file locks prevent race conditions, ensuring only one agent writes to a logic block at a time.</p>
                                    </div>
                                </div>
                            </div>
                        </motion.div>

                        {/* pricing center */}
                        <motion.div
                            initial={{ opacity: 0, y: 30 }}
                            whileInView={{ opacity: 1, y: 0 }}
                            viewport={{ once: true }}
                            className="bg-white/98 backdrop-blur-2xl p-12 rounded-3xl text-center shadow-[0_32px_120px_rgba(0,0,0,0.15)] z-20 min-h-[540px] flex flex-col justify-between border-2 border-neutral-100"
                        >
                            <div className="flex flex-col flex-1 h-full">
                                <h2 className="text-[14px] font-mono tracking-[0.5em] text-neutral-900 mb-10 font-black uppercase">tier pro</h2>
                                <div className="flex items-baseline justify-center gap-2 mb-12">
                                    <span className="text-8xl font-black tracking-tighter text-neutral-900 leading-none">$5</span>
                                    <span className="text-neutral-400 text-sm font-mono tracking-[0.3em]">/month</span>
                                </div>
                                <div className="space-y-6 mb-10 text-left px-4">
                                    {[
                                        "distributed shared memory",
                                        "atomic task orchestration",
                                        "unlimited worker swarms",
                                        "priority agent recall",
                                        "high-fidelity context mirroring"
                                    ].map((feature, i) => (
                                        <div key={i} className="flex items-center gap-4 text-[14px] text-black font-extrabold lowercase">
                                            <div className="w-2 h-2 rounded-full bg-neutral-900" />
                                            {feature}
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <div className="mt-auto">
                                <Link href="/signup" className="block w-full bg-neutral-900 text-white py-5 rounded-xl text-[12px] font-black tracking-[0.4em] uppercase hover:bg-black transition-all shadow-xl scale-105">
                                    deploy axis
                                </Link>
                                <p className="mt-10 text-[10px] text-neutral-500 font-mono tracking-widest uppercase font-black">no trials. zero friction.</p>
                            </div>
                        </motion.div>

                        {/* engine card */}
                        <motion.div
                            initial={{ opacity: 0, rotate: 0, x: 10 }}
                            whileInView={{ opacity: 1, rotate: 2, x: 0 }}
                            viewport={{ once: true }}
                            className="bg-white/95 backdrop-blur-xl p-10 rounded-2xl min-h-[480px] flex flex-col justify-between shadow-2xl text-neutral-900 border border-neutral-200"
                        >
                            <div className="space-y-10">
                                <h3 className="text-[12px] font-mono text-neutral-500 uppercase tracking-[0.4em] font-bold">engine</h3>
                                <div className="space-y-8 text-left">
                                    {[
                                        { t: "multi-agent sync", d: "real-time synchronization of state across disparate agent processes." },
                                        { t: "task registry", d: "orchestrate complex workflows with an atomic, priority-based job board." },
                                        { t: "lock protocol", d: "prevent concurrency collisions with project-level file locks." },
                                        { t: "context governance", d: "stream high-fidelity project goals and conventions into every loop." }
                                    ].map((f, i) => (
                                        <div key={i}>
                                            <div className="text-[15px] text-black font-black mb-1.5 lowercase">{f.t}</div>
                                            <div className="text-[12px] text-neutral-800 leading-relaxed font-bold lowercase">{f.d}</div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </motion.div>

                    </div>
                </div>

                <div className="mt-28 bg-black/80 backdrop-blur-md border-t border-white/5 w-full py-10 md:py-12 px-6 md:px-10 flex flex-col md:flex-row items-center justify-between gap-8 md:gap-10 opacity-70 text-[10px] font-mono tracking-widest uppercase font-bold text-white relative z-20 mb-8 rounded-xl max-w-[calc(100%-32px)] md:max-w-[calc(100%-48px)] mx-auto shadow-2xl">
                    <div className="flex flex-col md:flex-row gap-6 md:gap-10 items-center text-center md:text-left">
                        <div className="flex items-center gap-3">
                            <img src="/alogo.jpg" alt="Axis" className="w-5 h-5 rounded-full object-cover border border-white/10" />
                            <span>© 2026 axis intelligence</span>
                        </div>
                        <div className="hidden md:block w-8 h-[1px] bg-white/10" />
                        <div className="flex flex-wrap justify-center gap-6 md:gap-10">
                            <Link href="/about" className="hover:text-white transition-colors">about</Link>
                            <Link href="/docs" className="hover:text-white transition-colors">docs</Link>
                            <Link href="https://github.com/VirSanghavi/shared-context" className="hover:text-white transition-colors">github</Link>
                        </div>
                    </div>
                    <div className="flex gap-8 md:gap-10">
                        <Link href="/privacy" className="hover:text-white transition-colors">privacy</Link>
                        <Link href="/terms" className="hover:text-white transition-colors">terms</Link>
                    </div>
                </div>
            </section>
            <MachineToggle />
        </div>
    );
}
