import type { PinpointConfigOverrides } from '../config.js';
import type { Pinpoint, SessionStats } from '../pinpoint.js';
import { createProxyServer, type ProxyServerOptions } from '../proxy/server.js';
import type { Provider } from '../types.js';

export interface ProviderSdkClient {
  readonly baseURL: string;
}

export interface WithPinpointOptions {
  /** Runtime configuration. Transport ownership stays with the SDK adapter. */
  readonly config?: Omit<PinpointConfigOverrides, 'host' | 'port' | 'upstreams'>;
  /** Register custom integrations or disable Pinpoint's built-in integrations. */
  readonly runtime?: ProxyServerOptions['runtime'];
}

export interface PinpointClientHandle {
  /** The embedded runtime, including per-session savings stats. */
  readonly runtime: Pinpoint;
  /** Ephemeral loopback URL used by the wrapped provider client. */
  readonly baseURL: string;
  /** Provider base URL captured before wrapping. */
  readonly upstreamBaseURL: string;
  stats(): SessionStats;
  /** Stop Pinpoint and restore the provider client's original base URL. */
  close(): Promise<void>;
}

export type WrappedPinpointClient<T> = T & {
  readonly pinpoint: PinpointClientHandle;
};

function parseUpstream(baseURL: string): URL {
  let upstream: URL;
  try {
    upstream = new URL(baseURL);
  } catch {
    throw new TypeError(`provider client baseURL must be absolute: ${baseURL}`);
  }
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') {
    throw new TypeError(`provider client baseURL must use HTTP or HTTPS: ${baseURL}`);
  }
  return upstream;
}

/**
 * Route an existing provider SDK through an embedded Pinpoint proxy.
 *
 * Keeping transport at the SDK boundary preserves its response objects,
 * streaming iterators, retries, abort signals, and request option overloads.
 */
export async function wrapProviderClient<T extends ProviderSdkClient>(
  provider: Provider,
  client: T,
  options: WithPinpointOptions = {},
): Promise<WrappedPinpointClient<T>> {
  if (Reflect.has(client, 'pinpoint')) {
    throw new TypeError('provider client is already wrapped with Pinpoint');
  }

  const upstreamBaseURL = client.baseURL;
  const upstream = parseUpstream(upstreamBaseURL);
  const server = createProxyServer(
    {
      ...(options.config ?? {}),
      host: '127.0.0.1',
      port: 0,
      upstreams: { [provider]: upstream.origin },
    },
    { runtime: options.runtime },
  );
  const address = await server.listen();
  const pathAndQuery = `${upstream.pathname}${upstream.search}`;
  const localBaseURL = `http://${address.host}:${address.port}${pathAndQuery === '/' ? '' : pathAndQuery}`;
  const target = client as object;

  let closePromise: Promise<void> | undefined;
  let handle: PinpointClientHandle;
  handle = {
    runtime: server.pinpoint,
    baseURL: localBaseURL,
    upstreamBaseURL,
    stats: () => server.pinpoint.stats(),
    close() {
      closePromise ??= (async () => {
        try {
          await server.close();
        } finally {
          Reflect.set(target, 'baseURL', upstreamBaseURL);
          if (Reflect.get(target, 'pinpoint') === handle) Reflect.deleteProperty(target, 'pinpoint');
        }
      })();
      return closePromise;
    },
  };

  try {
    if (!Reflect.set(target, 'baseURL', localBaseURL)) {
      throw new TypeError('provider client baseURL is not writable');
    }
    Object.defineProperty(target, 'pinpoint', {
      configurable: true,
      enumerable: false,
      value: handle,
    });
  } catch (error) {
    Reflect.set(target, 'baseURL', upstreamBaseURL);
    await server.close();
    throw error;
  }

  return client as WrappedPinpointClient<T>;
}