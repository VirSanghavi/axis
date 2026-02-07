'use client';

import { useState } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import Navbar from '@/components/Navbar';

const codeStyle = vscDarkPlus;

export default function Docs() {
    const [activeTab, setActiveTab] = useState('quickstart');

    const tabs = [
        { id: 'quickstart', label: 'quickstart' },
        { id: 'mcp', label: 'mcp config' },
        { id: 'orchestration', label: 'orchestration' },
        { id: 'billing', label: 'billing' },
        { id: 'api', label: 'api reference' },
        { id: 'python', label: 'python sdk' },
    ];

    return (
        <div className="min-h-screen bg-[#050505] text-white selection:bg-white/10 tracking-tight lowercase">
            {/* Avalanche background */}
            <div className="bg-avalanche" />

            <Navbar />

            {/* White modal container */}
            <main className="min-h-screen flex items-center justify-center py-20 px-6 relative z-10">
                <div className="max-w-5xl w-full mx-auto bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl p-0 text-neutral-900 overflow-hidden flex flex-col md:flex-row min-h-[700px]">

                    {/* Sidebar */}
                    <div className="w-full md:w-64 bg-neutral-50 border-r border-neutral-200 p-8 flex flex-col">
                        <div className="mb-10">
                            <h1 className="text-2xl font-medium tracking-tight mb-1">documentation</h1>
                            <p className="text-[10px] text-neutral-400 uppercase tracking-[0.2em]">axis v1.0</p>
                        </div>

                        <div className="space-y-1">
                            {tabs.map(tab => (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    className={`w-full text-left px-4 py-3 rounded-lg text-[11px] font-bold tracking-[0.15em] uppercase transition-all ${activeTab === tab.id
                                        ? 'bg-neutral-900 text-white shadow-lg shadow-neutral-200'
                                        : 'text-neutral-400 hover:text-neutral-900 hover:bg-neutral-100'
                                        }`}
                                >
                                    {tab.label}
                                </button>
                            ))}
                        </div>

                        <div className="mt-auto pt-8 border-t border-neutral-200">
                            <Link href="/support" className="text-[10px] font-mono text-neutral-400 hover:text-neutral-900 transition-colors uppercase tracking-widest">
                                need help? support ↗
                            </Link>
                        </div>
                    </div>

                    {/* Content Area */}
                    <div className="flex-1 p-10 md:p-14 overflow-y-auto max-h-[85vh]">
                        <motion.div
                            key={activeTab}
                            initial={{ opacity: 0, x: 10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ duration: 0.3, ease: "easeOut" }}
                        >
                            {activeTab === 'quickstart' && <QuickstartSection />}
                            {activeTab === 'mcp' && <MCPSection />}
                            {activeTab === 'orchestration' && <OrchestrationSection />}
                            {activeTab === 'billing' && <BillingSection />}
                            {activeTab === 'api' && <APISection />}
                            {activeTab === 'python' && <PythonSection />}
                        </motion.div>
                    </div>
                </div>
            </main>
        </div>
    );
}

function Section({ title, subtitle, children }: { title: string, subtitle: string, children: React.ReactNode }) {
    return (
        <div className="space-y-8">
            <div className="space-y-2">
                <h2 className="text-4xl font-medium tracking-tighter text-neutral-900">{title}</h2>
                <p className="text-[11px] text-neutral-500 uppercase tracking-[0.2em] font-medium">{subtitle}</p>
            </div>
            <div className="prose prose-neutral max-w-none text-neutral-600 leading-relaxed text-[14px]">
                {children}
            </div>
        </div>
    );
}

function CodeBlock({ code, lang = 'bash' }: { code: string, lang?: string }) {
    return (
        <div className="rounded-xl overflow-hidden border border-neutral-200 shadow-sm my-6">
            <div className="bg-neutral-50 px-5 py-3 text-[10px] text-neutral-400 font-mono border-b border-neutral-200 flex justify-between items-center tracking-widest uppercase font-bold">
                <span>{lang}</span>
                <button onClick={() => navigator.clipboard.writeText(code)} className="hover:text-neutral-900 transition-colors">copy</button>
            </div>
            <SyntaxHighlighter
                language={lang}
                style={codeStyle}
                customStyle={{
                    margin: 0,
                    padding: '1.25rem',
                    background: '#0a0a0a',
                    fontSize: '13px',
                    fontFamily: 'monospace'
                }}
            >
                {code}
            </SyntaxHighlighter>
        </div>
    );
}

function QuickstartSection() {
    return (
        <Section title="quickstart" subtitle="orchestrate swarms in 60 seconds">
            <p className="text-lg text-neutral-500 leading-relaxed mb-8">
                axis is the control plane for parallel agent workflows. we provide the distributed shared memory and task management required for multiple agents to collaborate on a single project.
            </p>

            <div className="space-y-10">
                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">1. initialize the axis cli</h3>
                    <p className="mb-4">run the axis-init command in your project root to map your workspace.</p>
                    <CodeBlock code="npx @virsanghavi/axis-init@latest" />
                </div>

                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">2. connect your agent</h3>
                    <p className="mb-4">point your cursor, claude-desktop, or your custom agent instance to the axis server.</p>
                    <CodeBlock code={`npm install -g @virsanghavi/axis-server
export AXIS_API_KEY=sk_ax_...
axis-server`} />
                </div>
            </div>
        </Section>
    )
}

function MCPSection() {
    return (
        <Section title="mcp config" subtitle="model context protocol integration">
            <p className="mb-6">
                add this configuration to your mcp settings file (e.g., <code className="bg-neutral-100 px-1 rounded text-neutral-900">claude_desktop_config.json</code>).
            </p>

            <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">visual studio code / cursor</h3>
            <CodeBlock lang="json" code={`{
  "mcpServers": {
    "axis": {
      "command": "npx",
      "args": [
        "-y",
        "@virsanghavi/axis-server"
      ],
      "env": {
        "AXIS_API_KEY": "sk_ax_YOUR_KEY_HERE"
      }
    }
  }
}`} />

            <div className="mt-12 space-y-12">
                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">tools reference</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {[
                            { name: 'read_context', desc: 'reads a file from the shared context directory (agent-instructions/).' },
                            { name: 'update_context', desc: 'updates a shared context file (append or overwrite).' },
                            { name: 'search_docs', desc: 'semantically searches project documentation and context.' },
                            { name: 'post_job', desc: 'creates a new task on the job board with priority and dependencies.' },
                            { name: 'claim_next_job', desc: 'auto-assigns the highest priority available job to the agent.' },
                            { name: 'complete_job', desc: 'marks a job as done with an outcome summary.' },
                            { name: 'propose_file_access', desc: 'requests a lock on a file to prevent conflicts between agents.' },
                            { name: 'get_subscription_status', desc: 'checks if a user has an active pro subscription (stripe).' },
                            { name: 'get_usage_stats', desc: 'retrieves api usage metrics for the current billing period.' }
                        ].map(tool => (
                            <div key={tool.name} className="p-4 bg-neutral-50 rounded-xl border border-neutral-100 flex flex-col gap-1">
                                <code className="text-neutral-900 font-bold text-[13px]">{tool.name}</code>
                                <p className="text-neutral-500 text-[12px] lowercase">{tool.desc}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </Section>
    )
}

function APISection() {
    return (
        <Section title="api reference" subtitle="distributed control plane">
            <div className="space-y-12">
                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <div className="flex items-center gap-3 mb-6">
                        <span className="bg-neutral-900 text-white px-2.5 py-1 rounded text-[10px] font-bold tracking-widest uppercase">get</span>
                        <code className="font-mono text-xl tracking-tighter text-neutral-900">/v1/context/mirror</code>
                    </div>
                    <p className="text-neutral-500 mb-6 font-medium">high-fidelity mirror extraction across mapped project directories.</p>
                    <div className="mb-6">
                        <p className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 mb-2">query parameters</p>
                        <ul className="text-[13px] space-y-1">
                            <li><code className="text-neutral-900">path</code>: target directory or file (default: &quot;.&quot;)</li>
                            <li><code className="text-neutral-900">depth</code>: recursion limit for tree extraction</li>
                        </ul>
                    </div>
                    <CodeBlock lang="bash" code={`curl -X GET "https://api.axis.sh/v1/context/mirror?path=src/lib" \\
  -H "Authorization: Bearer sk_ax_..."`} />
                </div>

                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <div className="flex items-center gap-3 mb-6">
                        <span className="bg-neutral-900 text-white px-2.5 py-1 rounded text-[10px] font-bold tracking-widest uppercase">post</span>
                        <code className="font-mono text-xl tracking-tighter text-neutral-900">/v1/governance/check</code>
                    </div>
                    <p className="text-neutral-500 mb-6 font-medium">real-time validation of distributed agent actions against project constraints.</p>
                    <CodeBlock lang="bash" code={`curl -X POST "https://api.axis.sh/v1/governance/check" \\
  -H "Authorization: Bearer sk_ax_..." \\
  -d '{
    "agent_id": "agent-001",
    "file_path": "src/auth/secrets.ts",
    "action": "read"
  }'`} />
                </div>
            </div>
        </Section>
    )
}

function PythonSection() {
    return (
        <Section title="python sdk" subtitle="programmatic context steering">
            <p className="text-neutral-500 mb-6 font-medium">use our python sdk to integrate axis high-fidelity mirrors into your langchain, llama-index, or custom agentic loops.</p>

            <CodeBlock code="pip install virsanghavi-axis" />

            <div className="space-y-8">
                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">initialization</h3>
                    <CodeBlock lang="python" code={`from axis import Axis

# Reads AXIS_API_KEY from os.environ by default
axis = Axis() 
`} />
                </div>

                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">mirroring context</h3>
                    <CodeBlock lang="python" code={`mirror = axis.get_mirror(path="./src")

# Convert to a condensed text block for LLM prompts
prompt_context = mirror.to_prompt()
print(prompt_context)
`} />
                </div>

                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">governance validation</h3>
                    <CodeBlock lang="python" code={`is_allowed = axis.check_governance(
    agent_id="agent-001",
    file_path="src/auth/secrets.ts",
    action="read"
)

if not is_allowed:
    print("Access Denied by Axis Governance Authority")
`} />
                </div>
            </div>
        </Section>
    )
}

function OrchestrationSection() {
    return (
        <Section title="orchestration" subtitle="building parallel agent swarms">
            <p className="mb-6">
                axis enables true parallel software development by providing the synchronization primitives required for multi-agent coordination.
            </p>
            <div className="space-y-12">
                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">distributed shared memory</h3>
                    <p className="mb-4">axis provides a real-time <strong>live notepad</strong> that synchronizes state across disparate agent processes. this allows agents to share context, logic scores, and intent in sub-100ms.</p>
                    <ul className="list-disc pl-5 space-y-2 text-neutral-600">
                        <li><strong>real-time sync</strong>: agent A's thought logs are instantly visible to agent B.</li>
                        <li><strong>session persistence</strong>: automatic archiving of swarm interactions for future retrieval.</li>
                    </ul>
                </div>

                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">the job board</h3>
                    <p className="mb-4">centralized orchestration for autonomous teams. break down complex objectives into <strong>atomic jobs</strong> and let agents claim them based on priority and dependencies.</p>
                    <CodeBlock lang="bash" code={`# swarm orchestration example
post_job(title="refactor auth", priority="high")
-> job-123 created

claim_next_job(agent_id="agent-A")
-> GRANTED (agent-A assigned to job-123)`} />
                    <p className="mt-4 text-[12px] text-neutral-400 italic font-mono uppercase tracking-widest">dependencies ensure tasks are executed in the correct logical order.</p>
                </div>

                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">concurrency & locking</h3>
                    <p className="mb-4">to prevent collisions in multi-agent environments, axis implements a robust <strong>file locking protocol</strong>.</p>

                    <div className="overflow-hidden rounded-xl border border-neutral-200">
                        <table className="w-full text-left text-[12px]">
                            <thead className="bg-neutral-100 text-neutral-400 uppercase tracking-widest font-bold">
                                <tr>
                                    <th className="px-4 py-2">tool</th>
                                    <th className="px-4 py-2">intent</th>
                                    <th className="px-4 py-2">orchestration impact</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-neutral-200">
                                <tr>
                                    <td className="px-4 py-3 font-mono text-neutral-900">propose_file_access</td>
                                    <td className="px-4 py-3">acquire lock</td>
                                    <td className="px-4 py-3">blocks other agents during edit</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 font-mono text-neutral-900">update_shared_context</td>
                                    <td className="px-4 py-3">append thought</td>
                                    <td className="px-4 py-3">notifies swarm of current logic</td>
                                </tr>
                                <tr>
                                    <td className="px-4 py-3 font-mono text-neutral-900">finalize_session</td>
                                    <td className="px-4 py-3">end swarm run</td>
                                    <td className="px-4 py-3">archives memory and clears locks</td>
                                </tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </Section>
    )
}

function BillingSection() {
    return (
        <Section title="billing" subtitle="monetization primitives">
            <p className="mb-6">
                native primitives for managing subscription lifecycles and usage-based quotas within your agent loops.
            </p>
            <div className="space-y-8">
                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-2">verify subscription</h3>
                    <p className="text-[13px] text-neutral-600 mb-6 font-medium">agents should verify a user is on the pro plan before executing high-compute operations.</p>
                    <CodeBlock lang="typescript" code={`// inside an agent action
const status = await mcp.callTool('get_subscription_status', { 
  email: 'user@example.com' 
});

if (status.plan !== 'Pro') {
  return "Please upgrade to Axis Pro to use this feature.";
}`} />
                </div>

                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-2">usage tracking</h3>
                    <p className="text-[13px] text-neutral-600 mb-6 font-medium">track token usage or job counts to enforce fair-use limits across your fleet.</p>
                    <CodeBlock lang="typescript" code={`const stats = await mcp.callTool('get_usage_stats', { 
  email: 'user@example.com' 
});

console.log(\`User has consumed \${stats.total_requests} axis cycles.\`);`} />
                </div>
            </div>
        </Section>
    )
}
