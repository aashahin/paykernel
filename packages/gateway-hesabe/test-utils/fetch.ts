/** Network stubs include Bun's static fetch member without opening real connections. */
export function createFetchStub(
  implementation: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response>,
): typeof globalThis.fetch {
  return Object.assign(implementation, { preconnect: () => undefined });
}
