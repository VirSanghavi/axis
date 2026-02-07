
import dotenv from "dotenv";
import { RagEngine } from "../src/local/rag-engine.js";
import { NerveCenter } from "../src/local/nerve-center.js";
import { ContextManager } from "../src/local/context-manager.js";
import { logger } from "../src/utils/logger.js";

dotenv.config({ path: ".env.local" });

async function verify() {
    console.log("🔍 Verifying Full Stack...");

    // 1. Env Check
    if (!process.env.NEXT_PUBLIC_SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
        console.error("❌ Env Missing");
        process.exit(1);
    }
    console.log("✅ Env Variables Present");

    // 2. Init Components
    const contextManager = new ContextManager("http://dummy", "dummy");
    const nerveCenter = new NerveCenter(contextManager, {
        supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
        supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
        projectName: "verification-test"
    });

    await nerveCenter.init();
    if (!nerveCenter.projectId) {
        console.error("❌ Failed to init Project ID");
        process.exit(1);
    }
    console.log(`✅ NerveCenter Initialized (Project: ${nerveCenter.projectId})`);

    // 3. Test Locking (Persistence)
    const lockRes = await nerveCenter.proposeFileAccess("test-agent", "test.txt", "testing persistence", "run test");
    if (lockRes.status !== "GRANTED" && lockRes.status !== "REQUIRES_ORCHESTRATION") {
        console.error("❌ Lock Failed", lockRes);
    } else {
        console.log("✅ Persistence (Locking) Working");
    }

    // 4. Test RAG
    // Correctly pass args (url, key, openai, project)
    const rag = new RagEngine(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        process.env.OPENAI_API_KEY!,
        nerveCenter.projectId
    );

    try {
        await rag.indexContent("test-doc.md", "Axis is a context governance tool for AI agents.");
        const results = await rag.search("what is axis?");
        if (results.length > 0) {
            console.log("✅ RAG Search Working:", results[0]);
        } else {
            console.warn("⚠️ RAG Search returned no results (might be indexing lag or empty)");
        }
    } catch (e) {
        console.error("❌ RAG Failed", e);
    }

    // Cleanup
    await nerveCenter.forceUnlock("test.txt", "verification done");
    console.log("✅ Cleanup Done");
}

verify();
