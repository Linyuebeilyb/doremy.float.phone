import { NextResponse } from "next/server";
import { proxyFetch } from "@/lib/proxy-fetch";

export const runtime = "nodejs";
export const maxDuration = 15;

const DEFAULT_ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";

function normalizeBaseUrl(value: unknown): string {
    const raw = typeof value === "string" && value.trim() ? value.trim() : DEFAULT_ELEVENLABS_BASE_URL;
    return raw.replace(/\/+$/, "");
}

function getRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

/** ElevenLabs GET /voices → { voices: [{ voice_id, name, category, labels, ... }] } */
function extractVoices(payload: unknown): { id: string; name: string }[] {
    const root = getRecord(payload);
    const source = Array.isArray(root.voices) ? root.voices : [];
    return source.flatMap(item => {
        const record = getRecord(item);
        const id = record.voice_id ?? record.voiceId ?? record.id;
        if (typeof id !== "string" || !id.trim()) return [];
        const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : id.trim();
        const category = typeof record.category === "string" && record.category.trim() ? record.category.trim() : "";
        // 音色名后面带上类别（premade / cloned / generated），一眼能分清哪些是自己的
        return [{ id: id.trim(), name: category ? `${name} · ${category}` : name }];
    });
}

export async function POST(request: Request) {
    try {
        return await handleGetVoices(request);
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return NextResponse.json({ error: "get_voices_failed", message: message.slice(0, 500) }, { status: 502 });
    }
}

async function handleGetVoices(request: Request) {
    const body = await request.json().catch(() => ({}));
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const baseUrl = normalizeBaseUrl(body.baseUrl);

    if (!apiKey) return NextResponse.json({ error: "missing_api_key" }, { status: 400 });

    const response = await proxyFetch(`${baseUrl}/voices`, {
        method: "GET",
        headers: {
            "xi-api-key": apiKey,
            Accept: "application/json",
        },
    });

    const text = await response.text();
    let data: unknown = null;
    try {
        data = JSON.parse(text);
    } catch {
        return NextResponse.json({ error: "upstream_not_json", message: text.slice(0, 500) }, { status: 502 });
    }

    if (!response.ok) {
        const detail = getRecord(getRecord(data).detail);
        const message = String(detail.message || getRecord(data).message || text || `HTTP ${response.status}`);
        return NextResponse.json({ error: "get_voices_failed", message: message.slice(0, 500) }, { status: 502 });
    }

    return NextResponse.json({ ok: true, voices: extractVoices(data) });
}
