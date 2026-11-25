type FetchHandler = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function stubFetch(handler: FetchHandler): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect });
}
