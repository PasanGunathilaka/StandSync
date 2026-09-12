import type { HttpMethod, HttpRouteHandler, IHttpServerAdapter } from '@microsoft/teams.apps';
import type { StandSyncFastify } from '../dev/routes.js';

/**
 * Teams SDK HTTP adapter backed by the existing Fastify server.
 *
 * The Teams SDK ships an ExpressAdapter by default, which would mean running a
 * second HTTP server alongside Fastify. IHttpServerAdapter is the SDK's
 * supported extension point for exactly this: the adapter handles
 * framework-specific plumbing while the SDK keeps the Teams protocol logic
 * (JWT validation, activity routing).
 *
 * Lifecycle is deliberately NOT implemented. `start()`/`stop()` are optional in
 * the interface, and Fastify owns listening and shutdown — StandSync calls
 * `app.initialize()` (which registers the route) rather than `app.start()`.
 */
export class FastifyHttpServerAdapter implements IHttpServerAdapter {
  constructor(private readonly fastify: StandSyncFastify) {}

  /**
   * Bridges the SDK's pure `({body, headers}) => {status, body}` handler onto a
   * Fastify route. Fastify has already parsed the JSON body by the time this runs.
   */
  registerRoute(method: HttpMethod, path: string, handler: HttpRouteHandler): void {
    if (method !== 'POST') {
      throw new Error(`FastifyHttpServerAdapter only supports POST, received ${String(method)}`);
    }

    this.fastify.post(path, async (request, reply) => {
      const response = await handler({
        body: request.body,
        headers: normalizeHeaders(request.headers),
      });

      // The SDK returns 200 with no body for accepted activities; Fastify needs
      // an explicit empty send or it will hang waiting for a payload.
      return reply.status(response.status).send(response.body ?? '');
    });
  }
}

/**
 * Node reports headers as `string | string[] | undefined`, but the SDK's
 * interface has no undefined. Dropping unset headers keeps the contract honest
 * rather than casting a lie through the boundary.
 */
export function normalizeHeaders(
  headers: Record<string, string | string[] | undefined>,
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) result[key] = value;
  }
  return result;
}
