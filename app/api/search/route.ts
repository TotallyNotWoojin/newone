import { requireActor } from "../../../lib/server/auth";
import { ApiRequestError, apiError, readJson } from "../../../lib/server/http";
import { searchMessages } from "../../../lib/server/queries";

export async function POST(request: Request) {
  try {
    const actor = await requireActor(request);
    const payload = await readJson<{ query?: unknown }>(request);
    if (typeof payload.query !== "string") {
      throw new ApiRequestError("query must be a string");
    }
    const query = payload.query.trim();
    if (query.length > 120) {
      throw new ApiRequestError("Search query is too long");
    }
    const minimum = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/.test(query)
      ? 1
      : 2;
    if (query.length < minimum) return Response.json({ messages: [] });
    return Response.json({ messages: await searchMessages(actor, query) });
  } catch (error) {
    return apiError(error);
  }
}
