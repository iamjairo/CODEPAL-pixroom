import {
  wrapProviderClient,
  type ProviderSdkClient,
  type WrappedPinpointClient,
  type WithPinpointOptions,
} from './client.js';

/** Route an existing OpenAI SDK client through an embedded Pinpoint runtime. */
export function withPinpoint<T extends ProviderSdkClient>(
  client: T,
  options: WithPinpointOptions = {},
): Promise<WrappedPinpointClient<T>> {
  return wrapProviderClient('openai', client, options);
}

export type {
  PinpointClientHandle,
  ProviderSdkClient,
  WrappedPinpointClient,
  WithPinpointOptions,
} from './client.js';