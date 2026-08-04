import type { SupabaseClient } from '@supabase/supabase-js';
import { ApiError, fromDatabaseError } from './errors.ts';

export interface RpcResponse<T = unknown> {
  data: T | null;
  error: unknown | null;
}

export interface RpcClientLike {
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<RpcResponse>;
}

export function asRpcClient(client: SupabaseClient): RpcClientLike {
  return client as unknown as RpcClientLike;
}

export async function invokeRpc<T>(
  client: RpcClientLike,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw fromDatabaseError(error);
  if (data === null || data === undefined) {
    throw new ApiError(503, 'dependency_unavailable', undefined, 5);
  }
  return data as T;
}

export async function invokeVoidRpc(
  client: RpcClientLike,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const { error } = await client.rpc(name, args);
  if (error) throw fromDatabaseError(error);
}

export function firstRow<T>(value: T | T[]): T {
  if (Array.isArray(value)) {
    const first = value[0];
    if (first === undefined) throw new ApiError(503, 'dependency_unavailable', undefined, 5);
    return first;
  }
  return value;
}
