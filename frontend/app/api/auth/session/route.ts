import { NextResponse } from "next/server";
import { getSessionFromCookies } from "@/lib/auth";

export async function GET() {
    try {
        const session = await getSessionFromCookies();
        return NextResponse.json({
            authenticated: !!session,
            user: session ? { email: session.email } : null
        });
    } catch {
        return NextResponse.json({ authenticated: false, user: null });
    }
}
