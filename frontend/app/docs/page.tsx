'use client';

import { useState, useCallback } from 'react';
import { motion } from 'framer-motion';
import Link from 'next/link';
import { PrismAsyncLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import Navbar from '@/components/Navbar';

const codeStyle = vscDarkPlus;

// ---------------------------------------------------------------------------
// Docs Page
// ---------------------------------------------------------------------------
export default function Docs() {
    const [activeTab, setActiveTab] = useState('quickstart');

    const tabs = [
        { id: 'quickstart', label: 'quickstart' },
        { id: 'mcp', label: 'mcp config' },
        { id: 'multi-ide', label: 'multi-ide setup' },
        { id: 'tools', label: 'tools' },
        { id: 'orchestration', label: 'orchestration' },
        { id: 'sessions', label: 'sessions & usage' },
        { id: 'security', label: 'security' },
        { id: 'api', label: 'api reference' },
        { id: 'python', label: 'python sdk' },
    ];

    return (
        <div className="min-h-screen bg-[#050505] text-white selection:bg-white/10 tracking-tight lowercase">
            <div className="bg-avalanche" />
            <Navbar />

            <main className="pt-32 pb-20 px-6 relative z-10 flex items-center justify-center">
                <div className="w-full max-w-5xl bg-white/95 backdrop-blur-xl rounded-2xl shadow-2xl p-0 text-neutral-900 overflow-hidden flex flex-col md:flex-row min-h-[60vh] max-h-[90vh]">

                    {/* Sidebar */}
                    <nav className="w-full md:w-64 bg-neutral-50 border-r border-neutral-200 p-8 flex flex-col" aria-label="Documentation navigation">
                        <div className="mb-10">
                            <h1 className="text-2xl font-medium tracking-tighter mb-1">documentation</h1>
                            <p className="text-[10px] text-neutral-400 uppercase tracking-[0.2em]">axis v1.0</p>
                        </div>

                        <div className="space-y-1">
                            {tabs.map(tab => (
                                <button
                                    key={tab.id}
                                    onClick={() => setActiveTab(tab.id)}
                                    aria-selected={activeTab === tab.id}
                                    role="tab"
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
                    </nav>

                    {/* Content Area */}
                    <div className="flex-1 p-10 md:p-14 overflow-y-auto max-h-[85vh]" role="tabpanel">
                        <motion.div
                            key={activeTab}
                            initial={{ opacity: 0, x: 10 }}
                            animate={{ opacity: 1, x: 0 }}
                            transition={{ duration: 0.3, ease: "easeOut" }}
                        >
                            {activeTab === 'quickstart' && <QuickstartSection />}
                            {activeTab === 'mcp' && <MCPSection />}
                            {activeTab === 'multi-ide' && <MultiIDESection />}
                            {activeTab === 'tools' && <ToolsSection />}
                            {activeTab === 'orchestration' && <OrchestrationSection />}
                            {activeTab === 'sessions' && <SessionsUsageSection />}
                            {activeTab === 'security' && <SecuritySection />}
                            {activeTab === 'api' && <APISection />}
                            {activeTab === 'python' && <PythonSection />}
                        </motion.div>
                    </div>
                </div>
            </main>
        </div>
    );
}

// ---------------------------------------------------------------------------
// Shared components
// ---------------------------------------------------------------------------

function Section({ title, subtitle, children }: { title: string; subtitle: string; children: React.ReactNode }) {
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

function CodeBlock({ code, lang = 'bash' }: { code: string; lang?: string }) {
    const [copied, setCopied] = useState(false);

    const handleCopy = useCallback(async () => {
        try {
            await navigator.clipboard.writeText(code);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        } catch {
            // Fallback for insecure contexts or denied clipboard permission
            const textarea = document.createElement('textarea');
            textarea.value = code;
            textarea.setAttribute('readonly', '');
            textarea.style.position = 'absolute';
            textarea.style.left = '-9999px';
            document.body.appendChild(textarea);
            textarea.select();
            try { document.execCommand('copy'); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* noop */ }
            document.body.removeChild(textarea);
        }
    }, [code]);

    return (
        <div className="rounded-xl overflow-hidden border border-neutral-200 shadow-sm my-6 w-full">
            <div className="bg-neutral-50 px-5 py-3 text-[10px] text-neutral-400 font-mono border-b border-neutral-200 flex justify-between items-center tracking-widest uppercase font-bold">
                <span>{lang}</span>
                <button
                    onClick={handleCopy}
                    className="hover:text-neutral-900 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400 rounded px-1"
                    aria-label={copied ? 'Copied' : 'Copy code to clipboard'}
                >
                    {copied ? '✓ copied' : 'copy'}
                </button>
            </div>
            <SyntaxHighlighter
                language={lang}
                style={codeStyle}
                customStyle={{
                    margin: 0,
                    padding: '1.25rem',
                    background: '#0a0a0a',
                    fontSize: '13px',
                    fontFamily: 'monospace',
                }}
            >
                {code}
            </SyntaxHighlighter>
        </div>
    );
}

function Callout({ children }: { type?: 'info' | 'warn' | 'danger'; children: React.ReactNode }) {
    return (
        <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-5 py-4 my-6 text-[13px] leading-relaxed text-neutral-600">
            {children}
        </div>
    );
}

function StepItem({ step, title, children }: { step?: number; title: string; children: React.ReactNode }) {
    return (
        <div className="relative pl-12 border-l-2 border-neutral-100">
            <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-neutral-900 border-4 border-white shadow-sm" />
            <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">
                {step != null ? `step ${step}: ` : ''}{title}
            </h3>
            <div className="space-y-4 text-[13px] text-neutral-600 leading-relaxed">
                {children}
            </div>
        </div>
    );
}

function ToolCard({ name, desc }: { name: string; desc: string }) {
    return (
        <div className="p-4 bg-neutral-50 rounded-xl border border-neutral-100 flex flex-col gap-1">
            <code className="text-neutral-900 font-bold text-[13px]">{name}</code>
            <p className="text-neutral-500 text-[12px] lowercase">{desc}</p>
        </div>
    );
}

function EndpointBlock({ method, path, description, params, body, response, children }: {
    method: 'GET' | 'POST' | 'DELETE';
    path: string;
    description: string;
    params?: { name: string; desc: string }[];
    body?: { name: string; desc: string }[];
    response?: string;
    children?: React.ReactNode;
}) {
    const methodColor = method === 'GET' ? 'bg-emerald-700' : method === 'POST' ? 'bg-neutral-900' : 'bg-red-700';

    return (
        <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100 space-y-4">
            <div className="flex items-center gap-3 mb-2">
                <span className={`${methodColor} text-white px-2.5 py-1 rounded text-[10px] font-bold tracking-widest uppercase`}>{method}</span>
                <code className="font-mono text-lg tracking-tighter text-neutral-900">{path}</code>
            </div>
            <p className="text-neutral-500 font-medium text-[13px]">{description}</p>

            {params && params.length > 0 && (
                <div>
                    <p className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 mb-2">query parameters</p>
                    <ul className="text-[13px] space-y-1">
                        {params.map(p => <li key={p.name}><code className="text-neutral-900">{p.name}</code>: {p.desc}</li>)}
                    </ul>
                </div>
            )}

            {body && body.length > 0 && (
                <div>
                    <p className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 mb-2">request body</p>
                    <ul className="text-[13px] space-y-1">
                        {body.map(b => <li key={b.name}><code className="text-neutral-900">{b.name}</code>: {b.desc}</li>)}
                    </ul>
                </div>
            )}

            {response && (
                <div>
                    <p className="text-[11px] font-bold uppercase tracking-widest text-neutral-400 mb-2">response</p>
                    <pre className="bg-neutral-900 text-neutral-300 rounded-lg p-4 text-[12px] font-mono overflow-x-auto whitespace-pre-wrap">{response}</pre>
                </div>
            )}

            {children}
        </div>
    );
}

// ---------------------------------------------------------------------------
// Tab: Quickstart
// ---------------------------------------------------------------------------

function QuickstartSection() {
    return (
        <Section title="quickstart" subtitle="orchestrate swarms in 60 seconds">
            <p className="text-lg text-neutral-500 leading-relaxed mb-8">
                axis is the control plane for parallel agent workflows. it provides the distributed shared memory and task management required for multiple agents to collaborate on a single project.
            </p>

            <div className="space-y-10">
                <StepItem step={1} title="install the axis cli">
                    <p>run the axis-init command in your project root to map your workspace and generate a <code>.axis/</code> identity.</p>
                    <CodeBlock code="npx @virsanghavi/axis-init@latest" />
                </StepItem>

                <StepItem step={2} title="install the axis server">
                    <p>install the global mcp server that bridges your ide to the axis control plane.</p>
                    <CodeBlock code="npm install -g @virsanghavi/axis-server" />
                </StepItem>

                <StepItem step={3} title="configure your ide">
                    <p>add axis to your ide&apos;s mcp configuration. see the <strong>mcp config</strong> tab for full details.</p>
                    <CodeBlock lang="json" code={`{
  "mcpServers": {
    "axis": {
      "command": "axis-server",
      "args": ["/path/to/your/project"],
      "env": {
        "AXIS_API_KEY": "sk_sc_YOUR_KEY_HERE",
        "SHARED_CONTEXT_API_URL": "https://aicontext.vercel.app/api/v1"
      }
    }
  }
}`} />
                </StepItem>

                <StepItem step={4} title="verify">
                    <p>ask your ai agent to call <code>read_context</code> or <code>get_project_soul</code>. if it returns your project files, you&apos;re connected.</p>
                </StepItem>
            </div>

            <Callout type="info">
                you can generate an api key from your <Link href="/dashboard" className="underline font-bold">dashboard</Link> after signing up. keys start with <code>sk_sc_</code>.
            </Callout>
        </Section>
    );
}

// ---------------------------------------------------------------------------
// Tab: MCP Config
// ---------------------------------------------------------------------------

function MCPSection() {
    return (
        <Section title="mcp config" subtitle="integrate axis with your ide">
            <p className="mb-10 text-lg text-neutral-500">
                axis works with any ide that supports the model context protocol (mcp). follow these steps to connect your agent swarm.
            </p>

            <div className="space-y-16">
                <StepItem step={1} title="install the axis server">
                    <p>install the global package that exposes axis as an mcp stdio server.</p>
                    <CodeBlock code="npm install -g @virsanghavi/axis-server" />
                </StepItem>

                <StepItem step={2} title="initialize project (optional)">
                    <p>run the init command to set up your project&apos;s memory container and identity.</p>
                    <CodeBlock code="npx @virsanghavi/axis-init@latest" />
                    <p className="text-neutral-400 italic text-[12px]">
                        if you skip this, the server will auto-create a <code>.axis</code> folder with default settings.
                    </p>
                </StepItem>

                <StepItem step={3} title="add the mcp configuration">
                    <p>copy the configuration below into your ide&apos;s mcp settings file.</p>
                    <CodeBlock lang="json" code={`{
  "mcpServers": {
    "axis": {
      "command": "axis-server",
      "args": ["/path/to/your/project"],
      "env": {
        "AXIS_API_KEY": "sk_sc_YOUR_KEY_HERE",
        "PROJECT_NAME": "my-project",
        "SHARED_CONTEXT_API_URL": "https://aicontext.vercel.app/api/v1"
      }
    }
  }
}`} />
                    <Callout type="warn">
                        replace <code>/path/to/your/project</code> with the <strong>absolute path</strong> to your project root. this sets the server&apos;s working directory.
                    </Callout>
                </StepItem>

                <div className="relative pl-12 border-l-2 border-neutral-100">
                    <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-neutral-400 border-4 border-white shadow-sm" />
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">environment variables</h3>
                    <div className="overflow-hidden rounded-xl border border-neutral-200 my-4">
                        <table className="w-full text-left text-[12px]">
                            <thead className="bg-neutral-100 text-neutral-400 uppercase tracking-widest font-bold">
                                <tr>
                                    <th className="px-4 py-2">variable</th>
                                    <th className="px-4 py-2">required</th>
                                    <th className="px-4 py-2">description</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-neutral-200">
                                <tr><td className="px-4 py-3 font-mono text-neutral-900">AXIS_API_KEY</td><td className="px-4 py-3">yes</td><td className="px-4 py-3">your api key (starts with <code>sk_sc_</code>)</td></tr>
                                <tr><td className="px-4 py-3 font-mono text-neutral-900">SHARED_CONTEXT_API_URL</td><td className="px-4 py-3">yes</td><td className="px-4 py-3">axis api endpoint (<code>https://aicontext.vercel.app/api/v1</code>)</td></tr>
                                <tr><td className="px-4 py-3 font-mono text-neutral-900">PROJECT_NAME</td><td className="px-4 py-3">no</td><td className="px-4 py-3">project identifier. defaults to <code>default</code> or auto-detects from <code>.axis/axis.json</code></td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>

                <div className="relative pl-12 border-l-2 border-neutral-100">
                    <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-neutral-400 border-4 border-white shadow-sm" />
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">switching projects</h3>
                    <div className="space-y-4 text-[13px] text-neutral-600 leading-relaxed">
                        <p>axis segregates memory by project. there are two ways to switch context:</p>
                        <ul className="list-disc pl-5 space-y-2">
                            <li><strong>environment variable</strong>: change <code>PROJECT_NAME</code> in your mcp config. the server syncs to the new project&apos;s notepad automatically.</li>
                            <li><strong>auto-detection</strong>: if <code>PROJECT_NAME</code> is omitted, axis reads <code>.axis/axis.json</code> in your project root.</li>
                        </ul>
                        <Callout type="info">
                            if a project name doesn&apos;t exist in the database, axis will automatically create it for you. no manual setup required.
                        </Callout>
                    </div>
                </div>

                <div className="relative pl-12 border-l-2 border-neutral-100">
                    <div className="absolute -left-[9px] top-0 w-4 h-4 rounded-full bg-neutral-900 border-4 border-white shadow-sm" />
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">where to find mcp settings</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        {[
                            { ide: 'cursor', loc: 'settings → features → mcp → add server' },
                            { ide: 'vs code', loc: '~/.vscode/mcp.json or workspace .vscode/mcp.json' },
                            { ide: 'windsurf', loc: 'preferences → ai path → mcp configuration' },
                            { ide: 'claude desktop', loc: '~/Library/Application Support/Claude/claude_desktop_config.json' },
                        ].map(i => (
                            <div key={i.ide} className="p-4 bg-neutral-50 rounded-xl border border-neutral-100">
                                <div className="font-bold text-[11px] uppercase tracking-widest mb-1">{i.ide}</div>
                                <p className="text-[11px] text-neutral-500">{i.loc}</p>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </Section>
    );
}

// ---------------------------------------------------------------------------
// Tab: Tools
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tab: Multi-IDE Setup
// ---------------------------------------------------------------------------

function MultiIDESection() {
    return (
        <Section title="multi-ide setup" subtitle="run cursor, claude code & windsurf together">
            <p className="text-lg text-neutral-500 leading-relaxed mb-8">
                axis lets multiple ai coding agents work on the same project at the same time without stepping on each other.
                here&apos;s how to set it up. it&apos;s the same 3 steps for every ide.
            </p>

            <Callout type="info">
                every ide gets the <strong>exact same config</strong>. same api key, same project name, same url. axis handles the rest.
            </Callout>

            {/* What you need */}
            <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100 my-8">
                <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">before you start</h3>
                <p className="text-[13px] text-neutral-600 mb-4">you need exactly two things:</p>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="p-4 bg-white rounded-xl border border-neutral-200">
                        <div className="font-bold text-[13px] mb-1">1. an api key</div>
                        <p className="text-[12px] text-neutral-500">get one from your <Link href="/dashboard" className="underline">dashboard</Link>. it starts with <code>sk_sc_</code>.</p>
                    </div>
                    <div className="p-4 bg-white rounded-xl border border-neutral-200">
                        <div className="font-bold text-[13px] mb-1">2. axis-server installed</div>
                        <p className="text-[12px] text-neutral-500">run <code>npm install -g @virsanghavi/axis-server</code> once. done.</p>
                    </div>
                </div>
            </div>

            {/* The universal config */}
            <div className="space-y-6 mb-10">
                <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-2">the config (same for every ide)</h3>
                <p className="text-[13px] text-neutral-600">
                    copy this json. paste it into your ide&apos;s mcp settings. replace the two placeholders. that&apos;s it.
                </p>
                <CodeBlock lang="json" code={`{
  "mcpServers": {
    "axis": {
      "command": "axis-server",
      "args": ["/path/to/your/project"],
      "env": {
        "AXIS_API_KEY": "sk_sc_YOUR_KEY_HERE",
        "SHARED_CONTEXT_API_URL": "https://aicontext.vercel.app/api/v1"
      }
    }
  }
}`} />
                <p className="text-[12px] text-neutral-400 italic">
                    replace <code>/path/to/your/project</code> with your actual project folder. replace <code>sk_sc_YOUR_KEY_HERE</code> with your real key. everything else stays exactly as-is.
                </p>
            </div>

            {/* Per-IDE instructions */}
            <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-6">where to paste it in each ide</h3>

            <div className="space-y-4 mb-10">
                {[
                    {
                        ide: 'cursor',
                        where: 'settings → features → mcp → add new server',
                        note: 'or edit ~/.cursor/mcp.json directly',
                    },
                    {
                        ide: 'claude code',
                        where: '~/.claude/claude_desktop_config.json',
                        note: 'add axis inside the mcpServers object',
                    },
                    {
                        ide: 'windsurf',
                        where: 'preferences → ai path → mcp configuration',
                        note: 'same json format',
                    },
                    {
                        ide: 'vs code',
                        where: '~/.vscode/mcp.json or .vscode/mcp.json in your project',
                        note: 'requires an mcp-compatible extension',
                    },
                ].map(item => (
                    <div key={item.ide} className="p-5 bg-neutral-50 rounded-xl border border-neutral-100">
                        <div className="flex items-center gap-3 mb-2">
                            <span className="bg-neutral-900 text-white px-2.5 py-1 rounded text-[10px] font-bold tracking-widest uppercase">{item.ide}</span>
                        </div>
                        <p className="text-[13px] text-neutral-700 font-medium">{item.where}</p>
                        <p className="text-[12px] text-neutral-400 mt-1">{item.note}</p>
                    </div>
                ))}
            </div>

            {/* Claude Code CLI deep-dive */}
            <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100 mb-8">
                <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-6">claude code cli — full walkthrough</h3>
                <p className="text-[13px] text-neutral-600 mb-6">
                    claude code runs entirely in your terminal. no gui, no electron app. here&apos;s how to wire axis into it from scratch.
                </p>

                {/* Step 1 */}
                <div className="mb-6">
                    <div className="flex items-center gap-2 mb-2">
                        <span className="bg-neutral-900 text-white w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0">1</span>
                        <span className="font-bold text-[13px]">install claude code</span>
                    </div>
                    <p className="text-[12px] text-neutral-500 mb-2">if you don&apos;t have it yet:</p>
                    <CodeBlock lang="bash" code={`npm install -g @anthropic-ai/claude-code`} />
                </div>

                {/* Step 2 */}
                <div className="mb-6">
                    <div className="flex items-center gap-2 mb-2">
                        <span className="bg-neutral-900 text-white w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0">2</span>
                        <span className="font-bold text-[13px]">install axis-server</span>
                    </div>
                    <CodeBlock lang="bash" code={`npm install -g @virsanghavi/axis-server`} />
                </div>

                {/* Step 3 */}
                <div className="mb-6">
                    <div className="flex items-center gap-2 mb-2">
                        <span className="bg-neutral-900 text-white w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0">3</span>
                        <span className="font-bold text-[13px]">create the config file</span>
                    </div>
                    <p className="text-[12px] text-neutral-500 mb-2">
                        claude code reads mcp config from <code className="bg-neutral-200 px-1.5 py-0.5 rounded text-[11px]">~/.claude/claude_desktop_config.json</code>. create it if it doesn&apos;t exist:
                    </p>
                    <CodeBlock lang="bash" code={`mkdir -p ~/.claude && touch ~/.claude/claude_desktop_config.json`} />
                </div>

                {/* Step 4 */}
                <div className="mb-6">
                    <div className="flex items-center gap-2 mb-2">
                        <span className="bg-neutral-900 text-white w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0">4</span>
                        <span className="font-bold text-[13px]">paste this into the file</span>
                    </div>
                    <p className="text-[12px] text-neutral-500 mb-2">
                        open the file in any editor and paste:
                    </p>
                    <CodeBlock lang="json" code={`{
  "mcpServers": {
    "axis": {
      "command": "axis-server",
      "args": ["/path/to/your/project"],
      "env": {
        "AXIS_API_KEY": "sk_sc_YOUR_KEY_HERE",
        "SHARED_CONTEXT_API_URL": "https://aicontext.vercel.app/api/v1"
      }
    }
  }
}`} />
                    <p className="text-[12px] text-neutral-400 italic mt-2">
                        replace the two placeholders. everything else stays exactly as-is.
                    </p>
                </div>

                {/* Step 5 */}
                <div className="mb-6">
                    <div className="flex items-center gap-2 mb-2">
                        <span className="bg-neutral-900 text-white w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0">5</span>
                        <span className="font-bold text-[13px]">start claude code</span>
                    </div>
                    <p className="text-[12px] text-neutral-500 mb-2">
                        cd into your project folder and run:
                    </p>
                    <CodeBlock lang="bash" code={`cd /path/to/your/project
claude`} />
                    <p className="text-[12px] text-neutral-500 mt-2">
                        that&apos;s it. claude code starts, picks up the mcp config, and axis tools appear automatically. you can verify by asking claude: <em>&quot;what mcp tools do you have?&quot;</em>
                    </p>
                </div>

                {/* Step 6 */}
                <div className="mb-2">
                    <div className="flex items-center gap-2 mb-2">
                        <span className="bg-neutral-900 text-white w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0">6</span>
                        <span className="font-bold text-[13px]">run it alongside cursor</span>
                    </div>
                    <p className="text-[12px] text-neutral-500">
                        open the same project in cursor. both agents now share locks, jobs, and the live notepad. no extra config needed — the api key ties them together.
                    </p>
                </div>
            </div>

            <Callout type="warn">
                if claude code doesn&apos;t pick up the tools, quit with <code>/exit</code> and re-run <code>claude</code>. mcp config is only read at startup.
            </Callout>

            {/* How it works */}
            <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100 mb-8">
                <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-6">what happens when you run them together</h3>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                    <div className="text-center">
                        <div className="font-bold text-[12px] uppercase tracking-widest mb-2">file locks</div>
                        <p className="text-[12px] text-neutral-500">if cursor is editing a file, claude code sees it&apos;s locked and works on something else. no merge conflicts.</p>
                    </div>
                    <div className="text-center">
                        <div className="font-bold text-[12px] uppercase tracking-widest mb-2">job board</div>
                        <p className="text-[12px] text-neutral-500">post tasks and agents auto-claim them. two agents can&apos;t grab the same task — it&apos;s atomic.</p>
                    </div>
                    <div className="text-center">
                        <div className="font-bold text-[12px] uppercase tracking-widest mb-2">shared notepad</div>
                        <p className="text-[12px] text-neutral-500">every agent writes to the same live notepad. they can see what the other agents are doing in real time.</p>
                    </div>
                </div>
            </div>

            {/* Example: two agents working together */}
            <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">example: cursor + claude code on the same project</h3>
            <div className="space-y-3 mb-8">
                {[
                    { agent: 'cursor', action: 'posts a job: "refactor auth module"' },
                    { agent: 'claude code', action: 'calls claim_next_job → gets assigned "refactor auth module"' },
                    { agent: 'claude code', action: 'calls propose_file_access on auth.ts → GRANTED' },
                    { agent: 'cursor', action: 'tries to edit auth.ts → sees it\'s locked by claude code → works on tests instead' },
                    { agent: 'claude code', action: 'finishes, calls complete_job → lock released' },
                    { agent: 'cursor', action: 'sees the job is done in the shared notepad → moves on' },
                ].map((step, i) => (
                    <div key={i} className="flex items-start gap-3">
                        <span className="text-[11px] font-mono text-neutral-300 mt-1 w-4 text-right shrink-0">{i + 1}.</span>
                        <span className="text-[10px] font-bold uppercase tracking-widest px-2 py-0.5 rounded shrink-0 bg-neutral-100 text-neutral-700 border border-neutral-200">{step.agent}</span>
                        <span className="text-[13px] text-neutral-600">{step.action}</span>
                    </div>
                ))}
            </div>

            <Callout type="info">
                you don&apos;t need to configure anything special for multi-agent mode. if two ides have the same api key and project name, they&apos;re already coordinating. axis handles locks, jobs, and shared memory automatically.
            </Callout>

            {/* FAQ */}
            <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mt-10 mb-4">common questions</h3>
            <div className="space-y-4">
                {[
                    { q: 'do all ides need the same api key?', a: 'yes. same key = same user = same project access. axis knows they\'re on the same team because they share a key.' },
                    { q: 'do i need to set PROJECT_NAME?', a: 'only if you have multiple projects. if you leave it out, axis auto-detects from .axis/axis.json or defaults to "default".' },
                    { q: 'what if an agent crashes while holding a lock?', a: 'locks expire after 30 minutes. another agent can also call force_unlock to clear it immediately.' },
                    { q: 'can i use different api keys per ide?', a: 'only if they belong to the same user account. different users = different projects = no shared state.' },
                    { q: 'does github copilot work?', a: 'copilot\'s chat agent does not call mcp tools today. it will work independently but won\'t participate in axis coordination.' },
                ].map((faq, i) => (
                    <div key={i} className="p-4 bg-neutral-50 rounded-xl border border-neutral-100">
                        <p className="font-bold text-[13px] text-neutral-900 mb-1">{faq.q}</p>
                        <p className="text-[12px] text-neutral-500">{faq.a}</p>
                    </div>
                ))}
            </div>
        </Section>
    );
}

// ---------------------------------------------------------------------------
// Tab: Tools
// ---------------------------------------------------------------------------

function ToolsSection() {
    const categories = [
        {
            label: 'context & memory',
            tools: [
                { name: 'read_context', desc: 'read a file from the shared context directory (.axis/instructions/). use for context.md, conventions.md, activity.md.' },
                { name: 'update_context', desc: 'overwrite or append to a shared context file. supports append: true to add incrementally.' },
                { name: 'get_project_soul', desc: 'returns the combined "soul" of the project — context.md + conventions.md in one payload.' },
                { name: 'update_shared_context', desc: 'append a short-term note to the live notepad. visible to all agents immediately.' },
            ],
        },
        {
            label: 'search & indexing',
            tools: [
                { name: 'search_codebase', desc: 'semantic vector search across indexed project content. returns ranked results by similarity.' },
                { name: 'search_docs', desc: 'search indexed documentation. falls back to local rag if remote api is unavailable.' },
                { name: 'index_file', desc: 'add or update a file in the vector database. call after creating or significantly changing a file.' },
            ],
        },
        {
            label: 'orchestration & jobs',
            tools: [
                { name: 'post_job', desc: 'create a task on the job board with title, description, priority (low/medium/high/critical), and optional dependencies.' },
                { name: 'claim_next_job', desc: 'auto-assign the highest-priority available job to the calling agent. respects dependency order.' },
                { name: 'complete_job', desc: 'mark a job as done with an outcome summary. requires ownership or a completion key.' },
                { name: 'cancel_job', desc: 'cancel a job with a reason. removes it from the active queue.' },
            ],
        },
        {
            label: 'concurrency & locking',
            tools: [
                { name: 'propose_file_access', desc: 'request a lock on a file before editing. returns GRANTED or REQUIRES_ORCHESTRATION if another agent holds it.' },
                { name: 'force_unlock', desc: 'admin override to break a stale lock. use only when a locking agent has crashed or timed out.' },
            ],
        },
        {
            label: 'billing & usage',
            tools: [
                { name: 'get_subscription_status', desc: 'check if a user has an active pro subscription. returns plan, status, and period end.' },
                { name: 'get_usage_stats', desc: 'retrieve api request counts for the current billing period.' },
            ],
        },
        {
            label: 'session lifecycle',
            tools: [
                { name: 'finalize_session', desc: 'archive the current live notepad to permanent storage, clear locks and completed jobs, and reset for a new session.' },
            ],
        },
    ];

    return (
        <Section title="tools" subtitle="all 16 mcp tools">
            <p className="mb-8 text-lg text-neutral-500">
                axis exposes 16 tools via the model context protocol. agents call these automatically based on their descriptions.
            </p>

            <div className="space-y-10">
                {categories.map(cat => (
                    <div key={cat.label}>
                        <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">{cat.label}</h3>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                            {cat.tools.map(t => <ToolCard key={t.name} name={t.name} desc={t.desc} />)}
                        </div>
                    </div>
                ))}
            </div>
        </Section>
    );
}

// ---------------------------------------------------------------------------
// Tab: Orchestration
// ---------------------------------------------------------------------------

function OrchestrationSection() {
    return (
        <Section title="orchestration" subtitle="building parallel agent swarms">
            <p className="mb-6">
                axis enables true parallel software development by providing the synchronization primitives required for multi-agent coordination.
            </p>

            <div className="space-y-12">
                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">distributed shared memory</h3>
                    <p className="mb-4">
                        axis provides a real-time <strong>live notepad</strong> that synchronizes state across agent processes.
                        agents share context, decisions, and intent in near real-time.
                    </p>
                    <ul className="list-disc pl-5 space-y-2 text-neutral-600">
                        <li><strong>real-time sync</strong>: agent A&apos;s thought logs are instantly visible to agent B.</li>
                        <li><strong>session persistence</strong>: automatic archiving of swarm interactions for future retrieval via rag.</li>
                        <li><strong>project isolation</strong>: each project has its own notepad. no cross-project data leakage.</li>
                    </ul>
                </div>

                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">the job board</h3>
                    <p className="mb-4">
                        centralized orchestration for autonomous teams. break down complex objectives into <strong>atomic jobs</strong> and let agents claim them based on priority and dependencies.
                    </p>
                    <div className="overflow-hidden rounded-xl border border-neutral-200">
                        <div className="bg-neutral-100 px-5 py-3 text-[10px] text-neutral-400 font-mono border-b border-neutral-200 tracking-widest uppercase font-bold">bash</div>
                        <pre className="bg-[#0a0a0a] text-neutral-300 p-5 text-[13px] font-mono overflow-x-auto whitespace-pre-wrap">{`# swarm orchestration lifecycle
post_job(title="refactor auth", priority="high")
-> { jobId: "486b47b2-...", completionKey: "GFA8H7DJ" }

claim_next_job(agent_id="agent-A")
-> { status: "CLAIMED", job: { title: "refactor auth", ... } }

complete_job(agent_id="agent-A", job_id="486b47b2-...", outcome="done")
-> { status: "COMPLETED" }`}</pre>
                    </div>

                    <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-5 py-4 my-6 text-[13px] leading-relaxed text-neutral-600">
                        jobs with <code>dependencies</code> are only claimable after all prerequisite jobs reach &quot;done&quot; status. this ensures correct execution order.
                    </div>
                </div>

                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">concurrency & locking</h3>
                    <p className="mb-4">to prevent collisions in multi-agent environments, axis implements a <strong>file locking protocol</strong>.</p>

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
                                <tr><td className="px-4 py-3 font-mono text-neutral-900">propose_file_access</td><td className="px-4 py-3">acquire lock</td><td className="px-4 py-3">blocks other agents from editing the same file</td></tr>
                                <tr><td className="px-4 py-3 font-mono text-neutral-900">force_unlock</td><td className="px-4 py-3">break lock</td><td className="px-4 py-3">admin override for stale/crashed agent locks</td></tr>
                                <tr><td className="px-4 py-3 font-mono text-neutral-900">update_shared_context</td><td className="px-4 py-3">append thought</td><td className="px-4 py-3">broadcasts current logic to the entire swarm</td></tr>
                                <tr><td className="px-4 py-3 font-mono text-neutral-900">finalize_session</td><td className="px-4 py-3">end swarm run</td><td className="px-4 py-3">archives memory, clears all locks and done jobs</td></tr>
                            </tbody>
                        </table>
                    </div>

                    <div className="rounded-xl border border-neutral-200 bg-neutral-50 px-5 py-4 my-6 text-[13px] leading-relaxed text-neutral-600">
                        locks expire automatically after <strong>30 minutes</strong>. if an agent crashes, another agent can safely call <code>force_unlock</code> after the timeout.
                    </div>
                </div>
            </div>
        </Section>
    );
}

// ---------------------------------------------------------------------------
// Tab: Sessions & Usage
// ---------------------------------------------------------------------------

function SessionsUsageSection() {
    return (
        <Section title="sessions & usage" subtitle="lifecycle tracking and quotas">
            <div className="space-y-12">
                {/* Sessions */}
                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">session lifecycle</h3>
                    <p className="mb-4">
                        every axis interaction is tracked as a <strong>session</strong>. sessions capture the live notepad, agent decisions, and job outcomes for permanent retrieval.
                    </p>

                    <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100 space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div className="text-center p-4">
                                <div className="text-2xl mb-2">1</div>
                                <div className="font-bold text-[11px] uppercase tracking-widest mb-1">start</div>
                                <p className="text-[12px] text-neutral-500">session begins on mcp server init. live notepad is active.</p>
                            </div>
                            <div className="text-center p-4">
                                <div className="text-2xl mb-2">2</div>
                                <div className="font-bold text-[11px] uppercase tracking-widest mb-1">sync</div>
                                <p className="text-[12px] text-neutral-500">every <code>update_shared_context</code> call syncs the notepad to the cloud with an embedding for rag.</p>
                            </div>
                            <div className="text-center p-4">
                                <div className="text-2xl mb-2">3</div>
                                <div className="font-bold text-[11px] uppercase tracking-widest mb-1">finalize</div>
                                <p className="text-[12px] text-neutral-500">call <code>finalize_session</code> to archive, clear locks, and reset.</p>
                            </div>
                        </div>
                    </div>

                    <Callout type="info">
                        finalized sessions are permanently stored and searchable via <code>search_codebase</code>. this is how agents recall decisions from previous runs.
                    </Callout>

                    <h4 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mt-8 mb-4">viewing sessions</h4>
                    <p className="mb-4">
                        sessions are visible in your <Link href="/dashboard" className="underline font-bold">dashboard</Link> under the &quot;sessions&quot; tab. each session shows:
                    </p>
                    <ul className="list-disc pl-5 space-y-2 text-neutral-600 mb-4">
                        <li><strong>title</strong>: auto-generated from the sync context (e.g., &quot;Current Session: my-project&quot;)</li>
                        <li><strong>summary</strong>: first 500 characters of the notepad content</li>
                        <li><strong>timestamp</strong>: when the session was created or last synced</li>
                        <li><strong>project</strong>: which project the session belongs to</li>
                    </ul>

                    <h4 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mt-8 mb-4">api: fetch sessions</h4>
                    <CodeBlock lang="bash" code={`curl -X GET "https://aicontext.vercel.app/api/v1/sessions" \\
  -H "Authorization: Bearer sk_sc_YOUR_KEY"`} />
                    <p className="text-[12px] text-neutral-500">returns an array of session objects ordered by most recent first.</p>
                </div>

                {/* Usage */}
                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">usage tracking</h3>
                    <p className="mb-4">
                        every api call through axis is logged for billing and analytics. usage data includes endpoint, method, status code, response time, and tokens consumed.
                    </p>

                    <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                            <div>
                                <div className="font-bold text-[11px] uppercase tracking-widest mb-2">what&apos;s tracked</div>
                                <ul className="list-disc pl-5 space-y-1 text-[13px] text-neutral-600">
                                    <li>api endpoint called</li>
                                    <li>http method and status code</li>
                                    <li>response time (ms)</li>
                                    <li>tokens consumed (for embedding operations)</li>
                                    <li>which api key was used</li>
                                </ul>
                            </div>
                            <div>
                                <div className="font-bold text-[11px] uppercase tracking-widest mb-2">quotas</div>
                                <ul className="list-disc pl-5 space-y-1 text-[13px] text-neutral-600">
                                    <li><strong>pro plan required</strong>: api access requires an active pro subscription. free accounts can sign in but cannot generate api keys.</li>
                                    <li>rate limit: 50 requests / minute per ip</li>
                                    <li>embedding rate limit: 30 requests / minute</li>
                                </ul>
                            </div>
                        </div>
                    </div>

                    <h4 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mt-8 mb-4">checking usage via mcp</h4>
                    <CodeBlock lang="typescript" code={`// check subscription + usage in one call
const status = await mcp.callTool('get_subscription_status', {
  email: 'user@example.com'
});
// → { plan: "Pro", status: "pro", usageCount: 142 }

const usage = await mcp.callTool('get_usage_stats', {
  email: 'user@example.com'
});
// → { email: "user@example.com", usageCount: 142 }

// free accounts cannot generate api keys, so this
// will only ever be callable by pro subscribers.`} />

                    <h4 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mt-8 mb-4">api: fetch usage</h4>
                    <CodeBlock lang="bash" code={`curl -X GET "https://aicontext.vercel.app/api/v1/usage" \\
  -H "Authorization: Bearer sk_sc_YOUR_KEY"`} />
                    <p className="text-[12px] text-neutral-500">returns plan, status, usage count, and billing period end date.</p>

                    <Callout type="warn">
                        usage stats query by <code>email</code> requires the email to exist in the profiles table. if the user has never signed in, the endpoint returns <code>404 User not found</code>. only pro subscribers can generate api keys, so free accounts will never reach this endpoint.
                    </Callout>
                </div>

                {/* Error Responses */}
                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">common error responses</h3>
                    <div className="overflow-hidden rounded-xl border border-neutral-200">
                        <table className="w-full text-left text-[12px]">
                            <thead className="bg-neutral-100 text-neutral-400 uppercase tracking-widest font-bold">
                                <tr>
                                    <th className="px-4 py-2">status</th>
                                    <th className="px-4 py-2">meaning</th>
                                    <th className="px-4 py-2">action</th>
                                </tr>
                            </thead>
                            <tbody className="divide-y divide-neutral-200">
                                <tr><td className="px-4 py-3 font-mono">401</td><td className="px-4 py-3">invalid or missing api key</td><td className="px-4 py-3">check your <code>AXIS_API_KEY</code> in mcp.json</td></tr>
                                <tr><td className="px-4 py-3 font-mono">404</td><td className="px-4 py-3">user or resource not found</td><td className="px-4 py-3">verify the email exists or the project has been created</td></tr>
                                <tr><td className="px-4 py-3 font-mono">429</td><td className="px-4 py-3">rate limit exceeded</td><td className="px-4 py-3">wait 60 seconds, then retry.</td></tr>
                                <tr><td className="px-4 py-3 font-mono">500</td><td className="px-4 py-3">internal server error</td><td className="px-4 py-3">check vercel deployment logs or contact support</td></tr>
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>
        </Section>
    );
}

// ---------------------------------------------------------------------------
// Tab: Security
// ---------------------------------------------------------------------------

function SecuritySection() {
    return (
        <Section title="security" subtitle="best practices for production deployments">
            <div className="space-y-12">
                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">api key management</h3>
                    <ul className="list-disc pl-5 space-y-3 text-neutral-600">
                        <li>keys are <strong>sha-256 hashed</strong> before storage. axis never stores your raw key — the plaintext is shown exactly once at creation time.</li>
                        <li><strong>never commit keys</strong> to version control. use <code>mcp.json</code> environment variables, not <code>.env</code> files checked into git.</li>
                        <li>rotate keys periodically from the <Link href="/dashboard" className="underline">dashboard</Link>. deactivated keys are rejected immediately.</li>
                        <li>each key is scoped to a single user account. cross-user access is not possible.</li>
                    </ul>

                    <Callout type="danger">
                        if you suspect a key has been compromised, delete it immediately from the dashboard and generate a new one. all requests using the old key will fail instantly.
                    </Callout>
                </div>

                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">data isolation</h3>
                    <ul className="list-disc pl-5 space-y-3 text-neutral-600">
                        <li><strong>project-level isolation</strong>: every project has a unique id. locks, jobs, sessions, and embeddings are scoped to a single project. agents cannot read another project&apos;s data.</li>
                        <li><strong>user-level isolation</strong>: projects are owned by users (<code>owner_id</code>). the same project name can exist for different users without conflict.</li>
                        <li><strong>no cross-tenant access</strong>: api keys resolve to a <code>user_id</code>. all queries are filtered by this id server-side. there is no way to access another user&apos;s data via the api.</li>
                    </ul>
                </div>

                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">rate limiting & abuse prevention</h3>
                    <ul className="list-disc pl-5 space-y-3 text-neutral-600">
                        <li><strong>per-ip rate limits</strong>: 50 requests/minute for most endpoints. embedding and sync endpoints have lower limits (30/min) due to compute cost.</li>
                        <li><strong>redis-backed</strong>: rate limits are enforced via upstash redis, shared across all vercel edge instances. cannot be bypassed by hitting different regions.</li>
                        <li>exceeding the limit returns <code>429 Too Many Requests</code> with a <code>reset</code> timestamp.</li>
                    </ul>
                </div>

                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">lock security</h3>
                    <ul className="list-disc pl-5 space-y-3 text-neutral-600">
                        <li>locks expire after <strong>30 minutes</strong> to prevent deadlocks from crashed agents.</li>
                        <li>only the lock owner can release a lock normally. <code>force_unlock</code> requires providing a reason, which is logged in the notepad for audit.</li>
                        <li>lock state is persisted in supabase, not in-memory. server restarts do not lose lock state.</li>
                    </ul>
                </div>

                <div className="p-8 bg-neutral-50 rounded-2xl border border-neutral-100">
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">transport & storage</h3>
                    <ul className="list-disc pl-5 space-y-3 text-neutral-600">
                        <li>all api traffic is encrypted via <strong>tls 1.3</strong> (https only).</li>
                        <li>the axis server communicates with your ide over <strong>stdio</strong> (local process pipe). no network exposure on your machine.</li>
                        <li>supabase enforces <strong>row-level security</strong> (rls) for direct database access. the api uses a service role key server-side only — it is never sent to clients or exposed in mcp configs.</li>
                        <li>embeddings are stored with project-scoped metadata. vector search results are filtered by project id before being returned.</li>
                    </ul>
                </div>

                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">checklist for production</h3>
                    <div className="space-y-2">
                        {[
                            'generate a unique AXIS_API_KEY per project or environment',
                            'never hardcode keys in source files — use mcp.json env vars',
                            'add .axis/ to your .gitignore to avoid leaking local state',
                            'call finalize_session at the end of each agent run to clear locks',
                            'monitor usage in the dashboard to detect anomalous patterns',
                            'rotate api keys quarterly or after team member departures',
                            'set PROJECT_NAME explicitly to avoid default project collisions',
                        ].map((item, i) => (
                            <div key={i} className="flex items-start gap-3 p-3 bg-neutral-50 rounded-lg border border-neutral-100">
                                <span className="text-neutral-300 font-mono text-[12px] mt-0.5">☐</span>
                                <span className="text-[13px] text-neutral-600">{item}</span>
                            </div>
                        ))}
                    </div>
                </div>
            </div>
        </Section>
    );
}

// ---------------------------------------------------------------------------
// Tab: API Reference
// ---------------------------------------------------------------------------

function APISection() {
    return (
        <Section title="api reference" subtitle="all rest endpoints">
            <p className="mb-6 text-neutral-500">
                base url: <code className="text-neutral-900">https://aicontext.vercel.app/api/v1</code>. all endpoints require a <code>Bearer sk_sc_...</code> authorization header.
            </p>

            <div className="space-y-8">
                <EndpointBlock
                    method="POST"
                    path="/v1/search"
                    description="semantic vector search across indexed project content."
                    body={[
                        { name: 'query', desc: '(string, required) natural language search query' },
                        { name: 'projectName', desc: '(string) project to search within. defaults to "default"' },
                    ]}
                    response={`{
  "results": [
    { "content": "...", "similarity": 0.87, "metadata": {...} }
  ]
}`}
                />

                <EndpointBlock
                    method="POST"
                    path="/v1/embed"
                    description="generate and store vector embeddings for content."
                    body={[
                        { name: 'items', desc: '(array) objects with { content, metadata }' },
                        { name: 'projectName', desc: '(string) target project name' },
                    ]}
                    response={`{ "success": true, "count": 1 }`}
                />

                <EndpointBlock
                    method="GET"
                    path="/v1/locks"
                    description="list all active file locks for a project."
                    params={[{ name: 'projectName', desc: 'project to query. defaults to "default"' }]}
                    response={`{ "locks": [{ "file_path": "...", "agent_id": "...", "intent": "..." }] }`}
                />

                <EndpointBlock
                    method="POST"
                    path="/v1/locks"
                    description="acquire or release a file lock."
                    body={[
                        { name: 'action', desc: '"lock" or "unlock"' },
                        { name: 'filePath', desc: '(string) absolute path to the file' },
                        { name: 'agentId', desc: '(string) identifier of the requesting agent' },
                        { name: 'intent', desc: '(string) what the agent intends to do' },
                        { name: 'projectName', desc: '(string) target project' },
                    ]}
                />

                <EndpointBlock
                    method="GET"
                    path="/v1/jobs"
                    description="list jobs for a project."
                    params={[{ name: 'projectName', desc: 'project to query' }]}
                    response={`{ "jobs": [{ "id": "...", "title": "...", "priority": "high", "status": "todo" }] }`}
                />

                <EndpointBlock
                    method="POST"
                    path="/v1/jobs"
                    description="create, update, or claim a job."
                    body={[
                        { name: 'action', desc: '"post" | "update"' },
                        { name: 'title', desc: '(string) job title (for post)' },
                        { name: 'description', desc: '(string) job description (for post)' },
                        { name: 'priority', desc: '"low" | "medium" | "high" | "critical"' },
                        { name: 'dependencies', desc: '(string[]) ids of prerequisite jobs' },
                        { name: 'projectName', desc: '(string) target project' },
                    ]}
                />

                <EndpointBlock
                    method="GET"
                    path="/v1/usage"
                    description="get subscription status and usage count."
                    params={[{ name: 'email', desc: '(optional) user email to look up. defaults to authenticated user.' }]}
                    response={`{
  "email": "user@example.com",
  "plan": "Pro",
  "status": "pro",
  "validUntil": "2026-03-01T00:00:00Z",
  "usageCount": 142,
  "limit": 1000
}`}
                />

                <EndpointBlock
                    method="GET"
                    path="/v1/sessions"
                    description="list all sessions for the authenticated user."
                    response={`[{ "id": "...", "title": "...", "summary": "...", "created_at": "..." }]`}
                />

                <EndpointBlock
                    method="GET"
                    path="/v1/sessions/sync"
                    description="retrieve live notepad and project id for a project."
                    params={[{ name: 'projectName', desc: 'project to sync with' }]}
                    response={`{ "liveNotepad": "...", "projectId": "uuid-..." }`}
                />

                <EndpointBlock
                    method="POST"
                    path="/v1/sessions/sync"
                    description="sync a session context to cloud storage with automatic embedding."
                    body={[
                        { name: 'title', desc: '(string, required) session title' },
                        { name: 'context', desc: '(string, required) full notepad content to sync and embed' },
                        { name: 'projectName', desc: '(string) target project' },
                    ]}
                />

                <EndpointBlock
                    method="POST"
                    path="/v1/sessions/finalize"
                    description="archive current session, clear locks, and reset notepad."
                    body={[
                        { name: 'content', desc: '(string) final session content to archive' },
                        { name: 'projectName', desc: '(string) target project' },
                    ]}
                />

                <EndpointBlock
                    method="GET"
                    path="/v1/context/mirror"
                    description="high-fidelity mirror extraction across mapped project directories."
                    params={[
                        { name: 'path', desc: 'target directory or file (default: ".")' },
                        { name: 'depth', desc: 'recursion limit for tree extraction' },
                    ]}
                />
            </div>
        </Section>
    );
}

// ---------------------------------------------------------------------------
// Tab: Python SDK
// ---------------------------------------------------------------------------

function PythonSection() {
    return (
        <Section title="python sdk" subtitle="programmatic context steering">
            <p className="text-neutral-500 mb-6 font-medium">
                use the python sdk to integrate axis into your langchain, llama-index, or custom agentic loops.
            </p>

            <CodeBlock code="pip install virsanghavi-axis" />

            <div className="space-y-8">
                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">initialization</h3>
                    <CodeBlock lang="python" code={`from axis import Axis

# reads AXIS_API_KEY from os.environ by default
axis = Axis()

# or pass explicitly (not recommended for production)
axis = Axis(api_key="sk_sc_...")`} />
                    <Callout type="warn">
                        never hardcode api keys in source files. use environment variables or a secrets manager.
                    </Callout>
                </div>

                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">mirroring context</h3>
                    <CodeBlock lang="python" code={`mirror = axis.get_mirror(path="./src")

# convert to a condensed text block for llm prompts
prompt_context = mirror.to_prompt()
print(prompt_context)`} />
                </div>

                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">governance validation</h3>
                    <CodeBlock lang="python" code={`is_allowed = axis.check_governance(
    agent_id="agent-001",
    file_path="src/auth/secrets.ts",
    action="read"
)

if not is_allowed:
    print("access denied by axis governance authority")`} />
                </div>

                <div>
                    <h3 className="text-[11px] font-bold uppercase tracking-[0.3em] text-neutral-900 mb-4">error handling</h3>
                    <CodeBlock lang="python" code={`from axis import Axis, AxisError, RateLimitError

axis = Axis()

try:
    result = axis.search("authentication flow")
except RateLimitError as e:
    print(f"rate limited. retry after {e.retry_after}s")
except AxisError as e:
    print(f"axis error ({e.status_code}): {e.message}")`} />
                </div>
            </div>
        </Section>
    );
}
