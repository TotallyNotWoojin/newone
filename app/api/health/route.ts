import { aiConfiguration } from "../../../lib/server/openrouter";

export async function GET() {
  return Response.json({
    ok: true,
    service: "newone-relay",
    ai: aiConfiguration(),
    timestamp: new Date().toISOString(),
  });
}
