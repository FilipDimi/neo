/** Calls to the engine. Every request carries the per-install token the engine put in the page. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const pageToken = (): string => document.querySelector<HTMLMetaElement>('meta[name="vs-token"]')?.content ?? '';

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method, headers: { authorization: `Bearer ${pageToken()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  } catch {
    throw new ApiError(0, 'The engine is not answering.');
  }
  const json = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) throw new ApiError(response.status, json.error ?? response.statusText);
  return json as T;
}

export type Api = { get<T>(path: string): Promise<T>; post<T>(path: string, body?: unknown): Promise<T>; patch<T>(path: string, body: unknown): Promise<T> };

export const api: Api = {
  get: (path) => call('GET', path),
  post: (path, body) => call('POST', path, body),
  patch: (path, body) => call('PATCH', path, body),
};
