'use client';

import { useMachineMode } from '@/context/MachineModeContext';
import { motion } from 'framer-motion';
import Navbar from '@/components/Navbar';
import ReactMarkdown from 'react-markdown';

const ABOUT_CONTENT = `
# AXIS: CONTEXT_GOVERNANCE_SYSTEM_v1.0.1
## [STABLE_BUILD] // GROUND_TRUTH_PROTOCOL

[ 0.000000] axis: kernel v1.0.1-prod
[ 0.000312] loading context modules...
[ 0.001024] mem: 16384MB available
[ 0.001337] cpu: neural_engine x8 online
[ 0.002048] init: mounting /dev/knowledge

Axis is a **high-fidelity context mirroring layer** engineered for the next generation of *autonomous AI agents*. We provide the **ground truth** required to eliminate hallucinations and streamline multi-agent collaboration.

### ### SYSTEM_TOPOLOGY ###
---------------------------------------
\`\`\`mermaid
graph LR
    A[Agent] --> B{Axis Layer}
    B --> C[FS Mirror]
    B --> D[MCP Server]
    B --> E[Vector Index]
\`\`\`

### ### WHY_AXIS? ###
---------------------------------------
As LLMs scale, the primary failure mode is no longer intelligence—it is **CONTEXT_DRIFT**. 

*   **RAG_FAILURE**: Current RAG pipelines are brittle, high-latency, and often lose the "soul" of a project.
*   **CONVENTION_LOSS**: Agents lose track of project-specific naming schemes, architectural patterns, and intent.
*   **HALLUCINATION_TRAP**: When context is missing, agents fill the void with plausible lies.

Axis solves this by creating a **real-time, high-fidelity mirror** of your project environment.

### ### CORE_CAPABILITIES ###
---------------------------------------
*   **[CONTEXT_MIRRORING]**: Selective, structured extraction of project trees and file contents via specialized hooks.
*   **[PROTOCOL_ENFORCED]**: Standardized MCP tools (Model Context Protocol) for agents to read, write, and search.
*   **[GOVERNANCE_LAYER]**: Granular file locking and access controls to prevent race conditions.
*   **[SESSION_SYNC]**: Persistent, vector-indexed memory across disparate agent runs.

### ### SYSTEM_MISSION ###
---------------------------------------
> "The future of software is orchestrated by fleets of agents. Axis is the control plane."

Axis exists to be the **SRC_OF_TRUTH** they can trust. Zero manual ingestion. Pure, governed recall.

### ### TECHNICAL_ARTIFACTS ###
---------------------------------------
*   **MCP_ENDPOINT**: \`/api/mcp/v1\`
*   **MIRROR_LAYER**: \`v1.0.1-prod\`
*   **GOVERNANCE**: SECURE_AUTH_VIA_JWT
*   **STORAGE**: HYBRID_VECTOR_RELATIONAL

\`\`\`json
{
  "system": "axis-core",
  "version": "1.0.1",
  "status": "operational",
  "active_contexts": 42
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
                                context <br /> governance
                            </h1>
                            <p className="text-[11px] text-neutral-400 uppercase tracking-[0.4em] font-bold">
                                the mission of axis intelligence
                            </p>
                        </div>

                        <div className="grid grid-cols-1 md:grid-cols-2 gap-12 pt-8 border-t border-neutral-100">
                            <div className="space-y-6">
                                <h2 className="text-[14px] font-bold uppercase tracking-[0.2em] text-neutral-900 underline decoration-2 decoration-neutral-200 underline-offset-8">what it is</h2>
                                <p className="text-[15px] text-neutral-600 leading-relaxed font-medium">
                                    axis is a high-fidelity context mirroring layer designed for autonomous AI agents. we provide the ground truth required to eliminate hallucinations and streamline multi-agent collaboration.
                                </p>
                            </div>
                            <div className="space-y-6">
                                <h2 className="text-[14px] font-bold uppercase tracking-[0.2em] text-neutral-900 underline decoration-2 decoration-neutral-200 underline-offset-8">why it exists</h2>
                                <p className="text-[15px] text-neutral-600 leading-relaxed font-medium">
                                    as llms become more powerful, their bottleneck is no longer intelligence, but context. current rag pipelines are brittle and lose the soul of a project. axis solves this via structured recall.
                                </p>
                            </div>
                        </div>

                        <div className="space-y-8 pt-8">
                            <h2 className="text-[14px] font-bold uppercase tracking-[0.2em] text-neutral-900">capabilities</h2>
                            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
                                {[
                                    { t: "context mirroring", d: "selective, structured extraction of project trees." },
                                    { t: "governance", d: "granular file locking and access controls." },
                                    { t: "session sync", d: "persistent memory across disparate agent runs." }
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
