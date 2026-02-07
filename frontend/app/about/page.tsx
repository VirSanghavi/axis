'use client';

import { useMachineMode } from '@/context/MachineModeContext';
import { motion } from 'framer-motion';
import Navbar from '@/components/Navbar';
import ReactMarkdown from 'react-markdown';

const ABOUT_CONTENT = `
# AXIS: PARALLEL_WORKFLOW_ORCHESTRATOR_v1.0.1
## [STABLE_BUILD] // DISTRIBUTED_COORDINATION_PROTOCOL

[ 0.000000] axis: kernel v1.0.1-prod
[ 0.000312] loading coordination modules...
[ 0.001024] mem: 16384MB available (distributed)
[ 0.001337] cpu: neural_engine x8 online
[ 0.002048] init: mounting /dev/shared_memory

Axis is a **parallel agent orchestration layer** engineered for the next generation of *distributed autonomous swarms*. We provide the **distributed memory** and **task registry** required to coordinate multiple agents in a shared codebase without collisions.

### ### SYSTEM_TOPOLOGY ###
---------------------------------------
\`\`\`mermaid
graph TD
    A1[Agent A] --> O{Axis Orchestrator}
    A2[Agent B] --> O
    O --> B[Live Notepad]
    O --> C[Job Board]
    O --> D[File Locking]
    O --> E[High-Fidelity Context]
\`\`\`

### ### WHY_AXIS? ###
---------------------------------------
As LLMs scale, the bottleneck shifts from individual intelligence to **SWARM_COORDINATION**. 

*   **CONCURRENCY_COLLISION**: Without a shared brain, multiple agents overwrite each other's work.
*   **TASK_DUPLICATION**: Agents lack a central registry to partition and claim specific engineering tickets.
*   **SYNERGY_LOSS**: Disparate agents cannot share "thoughts" or context in real-time.

Axis solves this by creating a **distributed coordination plane** for multi-agent loops.

### ### CORE_CAPABILITIES ###
---------------------------------------
*   **[DISTRIBUTED_MEMORY]**: A real-time "Live Notepad" that synchronizes state across disparate agent processes.
*   **[JOB_ORCHESTRATION]**: An atomic, priority-based job board that manages task assignment and dependencies.
*   **[CONFLICT_AVOIDANCE]**: Pessimistic file-locking protocols to prevent race conditions during parallel edits.
*   **[CONTEXT_GOVERNANCE]**: High-fidelity mirroring of project goals and conventions to ensure collective alignment.

### ### SYSTEM_MISSION ###
---------------------------------------
> "The future of software is written by parallel agent swarms. Axis is the control plane."

Axis exists to be the **SRC_OF_COORDINATION** they can trust. Zero race conditions. Pure, parallel execution.

### ### TECHNICAL_ARTIFACTS ###
---------------------------------------
*   **ORCHESTRATION_LOGIC**: \`v1.0.1-prod\`
*   **SYNC_LAYER**: DISTRIBUTED_SUPABASE_PERSISTENCE
*   **GOVERNANCE**: SECURE_AUTH_VIA_JWT
*   **STORAGE**: HYBRID_VECTOR_RELATIONAL

\`\`\`json
{
  "system": "axis-orchestrator",
  "version": "1.0.1",
  "status": "operational",
  "active_swarms": 12,
  "sync_latency": "<100ms"
}
\`\`\`
`;

export default function AboutPage() {
    const { mode } = useMachineMode();

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
                        <ReactMarkdown>{ABOUT_CONTENT}</ReactMarkdown>
                    </div>
                    <div className="pt-10 border-t border-white/10 text-white/40 text-[10px] uppercase tracking-[0.3em]">
                        axis v1.0.0-prod // machine_mode: active
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-screen bg-[#050505] text-white selection:bg-white/10 tracking-tight lowercase overflow-x-hidden">
            <div className="bg-avalanche" />

            <Navbar />

            <main className="min-h-screen flex items-center justify-center py-24 px-6 relative z-10">
                <motion.div
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="max-w-4xl w-full bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl p-12 text-neutral-900 overflow-hidden relative"
                >
                    <div className="absolute top-0 right-0 p-8 opacity-5">
                        <div className="text-[120px] font-black tracking-tighter select-none">axis</div>
                    </div>

                    <div className="relative z-10 space-y-12">
                        <div className="space-y-4">
                            <h1 className="text-6xl font-medium tracking-tighter text-neutral-900 leading-none">
                                parallel <br /> workflows
                            </h1>
                            <p className="text-[11px] text-neutral-400 uppercase tracking-[0.4em] font-bold">
                                orchestrated ai coordination
                            </p>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 pt-8 border-t border-neutral-100">
                            <div className="space-y-6">
                                <h2 className="text-[14px] font-bold uppercase tracking-[0.2em] text-neutral-900 underline decoration-2 decoration-neutral-200 underline-offset-8">what it is</h2>
                                <p className="text-[15px] text-neutral-600 leading-relaxed font-medium">
                                    axis is a parallel agent orchestration layer designed for autonomous swarms. we provide the distributed memory and atomic task registries required for multi-agent software development.
                                </p>
                            </div>
                            <div className="space-y-6">
                                <h2 className="text-[14px] font-bold uppercase tracking-[0.2em] text-neutral-900 underline decoration-2 decoration-neutral-200 underline-offset-8">why it exists</h2>
                                <p className="text-[15px] text-neutral-600 leading-relaxed font-medium">
                                    as ai loops shift from single-agent to parallel execution, coordination becomes the new bottleneck. axis prevents collisions and context drift by serving as the collective brain for your swarm.
                                </p>
                            </div>
                        </div>

                        <div className="space-y-8 pt-8">
                            <h2 className="text-[14px] font-bold uppercase tracking-[0.2em] text-neutral-900">capabilities</h2>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                                {[
                                    { t: "distributed memory", d: "real-time state sync across disparate agent runs." },
                                    { t: "job orchestration", d: "atomic registers to partition and claim tasks." },
                                    { t: "conflict avoidance", d: "granular file locking to prevent race conditions." }
                                ].map((cap, i) => (
                                    <div key={i} className="p-6 bg-neutral-50 rounded-xl border border-neutral-100 space-y-2">
                                        <div className="text-[13px] font-bold text-neutral-900">{cap.t}</div>
                                        <p className="text-[12px] text-neutral-500 leading-relaxed lowercase">{cap.d}</p>
                                    </div>
                                ))}
                            </div>
                        </div>

                        <div className="pt-12 border-t border-neutral-100 flex justify-between items-center">
                            <p className="text-[10px] font-mono text-neutral-400 uppercase tracking-widest">
                                axis v1.0.0-prod // sf, ca
                            </p>
                            <div className="flex gap-8">
                                <a href="https://github.com/VirSanghavi/shared-context" target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold uppercase tracking-widest hover:text-neutral-900 transition-colors">github ↗</a>
                                <a href="https://twitter.com/VirSanghavi13" target="_blank" rel="noopener noreferrer" className="text-[11px] font-bold uppercase tracking-widest hover:text-neutral-900 transition-colors">twitter ↗</a>
                            </div>
                        </div>
                    </div>
                </motion.div>
            </main>
        </div>
    );
}
