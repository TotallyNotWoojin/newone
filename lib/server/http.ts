import { AuthenticationError, AuthorizationError } from "./auth";
import { AiUnavailableError } from "./openrouter";

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export function apiError(error: unknown): Response {
  if (
    error instanceof AuthenticationError ||
    error instanceof AuthorizationError ||
    error instanceof AiUnavailableError ||
    error instanceof ApiRequestError
  ) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof SyntaxError) {
    return Response.json({ error: "Request body must be valid JSON" }, { status: 400 });
  }
  return Response.json({ error: "Unexpected server error" }, { status: 500 });
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiRequestError("Content-Type must be application/json", 415);
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ApiRequestError("Request body must be valid JSON", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiRequestError("Request body must be a JSON object", 400);
  }
  return value as T;
}
